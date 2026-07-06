---
name: baton
description: >-
  Use this skill whenever the user asks to hand off a task, session, repo,
  workspace, or agent run to another machine or another agent instance. It sets
  up a real handoff, not just a prompt: GitHub branch sync first when possible,
  SCP bundle fallback when needed, workspace parity verification before launch,
  receiver agent inside tmux, and sender-side verification before release.
  Trigger on phrases like pass the baton, baton this session, handoff this
  session, send this work to another machine, continue on the partner server,
  remote Claude, tmux handoff, transfer this repo, or agent-to-agent handoff.
---

# Baton

Handoff is not "send a prompt." A receiver that only gets context can be confidently wrong if its files differ from the sender's files.

The invariant is:

> File parity first. Agent launch second. Receiver acknowledgment third. Sender release last.

## Script Resolution

The script lives next to this SKILL.md at `scripts/baton-workspace.mjs` inside the skill directory (e.g. `~/.claude/skills/baton/scripts/baton-workspace.mjs`). Resolve it relative to wherever this skill is installed — never assume it exists in the user's workspace.

```bash
SKILL_DIR="<directory containing this SKILL.md>"
BATON="$SKILL_DIR/scripts/baton-workspace.mjs"
WORKSPACE="<absolute path to the workspace root being handed off>"
```

## Non-negotiables

- Do not launch the receiver agent until workspace parity is verified.
- Prefer GitHub branch handoff when the workspace is a repo and the required state is committed or can be committed with explicit user approval.
- Use the SCP bundle fallback when the workspace is not a repo, GitHub is unavailable, or uncommitted files must transfer without changing remote history.
- Extract or clone into a fresh receiver directory. Never overlay onto a dirty remote workspace.
- Run the receiver inside `tmux` so the human can SSH in, attach, inspect, and intervene.
- Start the receiver with the configured `receiverCommand` (default `claude --remote-control <name>`).
- Do not use SSH agent forwarding.
- Do not treat process memory, hidden model state, shell state, or tool internals as transferable.
- Do not release sender responsibility until the receiver acknowledges the verified workspace, task, next step, and verification gate.

## Step 0: Config

Read `~/.config/baton/config.json` first:

```json
{
  "defaultHost": "partner",
  "hosts": {
    "partner": {
      "ssh": "user@host.example.ts.net",
      "handoffDir": "~/baton-inbox",
      "receiverCommand": "claude --remote-control"
    }
  }
}
```

- `ssh`: SSH destination. `handoffDir`: where bundles land on the receiver. `receiverCommand`: command that starts the receiver agent (default `claude --remote-control`; overridable for other agents, e.g. opencode).
- If the config is missing or has no usable host, ask the user for the SSH destination and offer to write the config for next time. Never invent a host. Never hard-code one.

## Step 1: Context Packet (`HANDOFF.md`)

BEFORE creating the branch or bundle, write `HANDOFF.md` at the workspace root containing:

- sender identity
- task goal
- current status
- key decisions
- evidence paths
- next exact step
- verification gate
- constraints and must-not rules

Because it is written before transfer, `HANDOFF.md` rides the branch or bundle and is covered by the same parity verification. The injected receiver prompt references it instead of restating everything.

## Script CLI

`node "$BATON" <command> ...` — self-contained, node stdlib only.

### `git-preflight --workspace <path>`

Reports repo status and recommended handoff branch commands (branch name `handoff/<sha12>`). For a non-repo workspace it returns `{ mode: 'git', available: false, reason: 'NotGitRepository' }` (exit 0) — use that to pivot to SCP bundle mode.

### `bundle-create --workspace <path> --bundle <path> --manifest <path>`

Creates a deterministic bundle + manifest. Manifest is content-addressed: `manifestHash` = sha256 of the canonical manifest JSON, so identical content always yields the identical hash. Rules:

- Always excludes files named `.env` or `.env.*` at any depth, except `.env.example`, `.env.sample`, `.env.template` → reported in `excludedSensitive`.
- If the workspace is a git repo, gitignored paths are excluded → reported in `excludedIgnored`. Hard-coded exclusions (`.git`, `node_modules`, `dist`, `build`, `.DS_Store`) apply either way.
- Symlinks are never followed or bundled → reported in `skippedSymlinks`.
- Throws if cumulative raw file bytes exceed 256 MiB: `Workspace too large for JSON bundle (>256MiB): use GitHub branch handoff instead`.

Output JSON: `{ mode: 'bundle', fileCount, manifestHash, skippedSymlinks, excludedSensitive, excludedIgnored }`

### `bundle-verify --bundle <path> --manifest <path> --output <path>`

Verifies manifest hash binding and every file's path, size, and sha256, then extracts into `<output>`. Refuses a non-empty output directory (`Output directory not empty: <path>`) — it never deletes anything. Path traversal is rejected.

Output JSON: `{ verified: true, fileCount, manifestHash }`

## Decision Tree

1. Check if the sender workspace is a Git repo.
2. If it is a repo and the transfer state can be represented by a pushed handoff branch, use **GitHub Branch Handoff**.
3. If the repo has uncommitted work and the user has not explicitly approved a commit, use **SCP Bundle Handoff**.
4. If the workspace is not a repo or GitHub is unavailable, use **SCP Bundle Handoff**.
5. If the workspace exceeds 256 MiB of raw file bytes, the JSON bundle path is unavailable — use GitHub branch handoff.
6. If neither path can verify file parity, stop. Do not launch the receiver.

## GitHub Branch Handoff

Use this path when a branch can represent the intended workspace.

### Sender Steps

Write `HANDOFF.md` (Step 1), then run:

```bash
node "$BATON" git-preflight --workspace "$WORKSPACE"
```

If there are uncommitted changes, do not commit unless the user explicitly approves. If commits are not approved, switch to the SCP bundle fallback.

Create and push the handoff branch (name `handoff/<sha12>`, per the preflight output):

```bash
git switch -c handoff/<sha12>
git push -u origin handoff/<sha12>
```

Record these values in the handoff packet:

- repo remote URL
- branch name
- expected commit SHA
- dirty status
- pointer to `HANDOFF.md` in the branch

### Receiver Steps

On the partner machine, clone or fetch into a fresh directory:

```bash
git clone <repo-url> <fresh-dir>
cd <fresh-dir>
git fetch origin <branch>
git checkout <expected-sha>
test "$(git rev-parse HEAD)" = "<expected-sha>"
```

If the SHA check fails, stop and report the mismatch. Do not launch the receiver.

## SCP Bundle Handoff

Use this path for non-repo workspaces, unavailable GitHub, or uncommitted work that must transfer as-is. Ceiling: 256 MiB of raw file bytes — above that, prefer the branch handoff.

### Sender Steps

Write `HANDOFF.md` (Step 1), then create the deterministic bundle and manifest:

```bash
node "$BATON" bundle-create \
  --workspace "$WORKSPACE" \
  --bundle /tmp/baton/workspace.bundle.json \
  --manifest /tmp/baton/workspace.manifest.json
```

Report `skippedSymlinks`, `excludedSensitive`, and `excludedIgnored` from the output to the user BEFORE transferring. If sensitive files were excluded that the task needs, the user must transfer them out-of-band deliberately — never re-include them in the bundle.

Transfer three files — bundle, manifest, and the script itself — so the receiver verifies with the exact same code (receiver needs only node + ssh, no skill install):

```bash
scp /tmp/baton/workspace.bundle.json \
    /tmp/baton/workspace.manifest.json \
    "$BATON" \
    <ssh>:<handoffDir>/
```

### Receiver Steps

Extract into a fresh (missing or empty) directory and verify every file hash:

```bash
node <handoffDir>/baton-workspace.mjs bundle-verify \
  --bundle <handoffDir>/workspace.bundle.json \
  --manifest <handoffDir>/workspace.manifest.json \
  --output <fresh-dir>
```

If Node is unavailable on the receiver, use an equivalent verifier that checks the manifest hash and every file path, size, and SHA-256 before extraction is trusted. Do not treat a copied archive as verified merely because `scp` succeeded.

## Receiver Runtime

After workspace parity is verified, start the receiver in `tmux` using `receiverCommand` from config (default `claude --remote-control <name>`).

Detached start:

```bash
ssh <ssh> 'cd <verified-dir> && tmux new-session -d -s <session-name> "<receiverCommand> <remote-control-name>"'
```

Attach:

```bash
ssh -t <ssh> 'tmux attach -t <session-name>'
```

Verify the session exists:

```bash
ssh <ssh> 'tmux ls | grep <session-name>'
```

If the first launch shows a trust-folder prompt, resolve it before injecting the handoff prompt. A session stuck at a trust prompt is not a completed handoff.

## Handoff Prompt

Inject a prompt containing:

- sender identity
- receiver role
- verified workspace path
- transfer mode: `github-branch` or `scp-bundle`
- expected commit SHA or bundle manifest hash
- instruction to read `HANDOFF.md` at the workspace root for goal, status, decisions, evidence, next step, gate, and constraints

The receiver must answer with:

- "I am the receiver"
- verified workspace path
- verified commit SHA or bundle manifest hash
- task understanding (from `HANDOFF.md`)
- next step
- what it will not do
- verification gate
- readiness status

## Completion Criteria

The handoff is complete only when all checks pass:

- Workspace parity verified.
- Receiver agent is running in `tmux`.
- Receiver was started with the configured `receiverCommand` (remote control active when using Claude).
- Receiver acknowledges the correct task.
- Receiver confirms the verified workspace path.
- Receiver confirms commit SHA or bundle manifest hash.
- Receiver states the next step.
- Receiver states the verification gate.
- Sender records evidence.
- Sender returns the attach command to the user.

## Return Handoff

Do not confuse local pullback with receiver-initiated return handoff.

- **Pullback test:** sender retrieves a returned bundle from receiver. This proves roundtrip parity but not receiver-initiated return.
- **Return handoff:** receiver packages its current verified workspace, transfers or pushes it back, and signals the original sender with evidence.

For a true return handoff, apply the same parity rules in reverse: branch/SHA first, bundle fallback second, fresh directory, manifest verification, receiver acknowledgment.

## Evidence To Record

Write an evidence file containing:

- timestamp
- host
- transfer mode
- verified receiver directory
- branch and commit SHA, or bundle/manifest paths and manifest hash
- skipped/excluded lists reported at bundle time
- tmux session name
- remote-control name (when applicable)
- receiver acknowledgment
- attach command
- pass/fail status

## Failure Handling

- If Git push/fetch fails, do not silently fall back unless the user accepts bundle mode.
- If `bundle-create` reports the 256 MiB ceiling, switch to branch handoff — do not split or truncate the bundle.
- If bundle verification fails, stop and preserve evidence.
- If the output directory is non-empty, pick a fresh directory — never delete receiver files to make room.
- If `tmux` is missing, install it only with user approval; otherwise stop.
- If the receiver command is unavailable on the remote (e.g. `--remote-control` unsupported), stop.
- If the receiver prompt is pasted but not submitted, inspect the tmux pane and send Enter only after confirming the UI is ready.
- If the receiver acknowledges context but not file parity, the handoff is incomplete.
