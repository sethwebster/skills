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
  Also handles partner management commands: baton add, list, remove, default,
  and check.
---

# Baton

Handoff is not "send a prompt." A receiver that only gets context can be confidently wrong if its files differ from the sender's files.

The invariant is:

> File parity first. Agent launch second. Receiver acknowledgment third. Sender release last.

## Commands

The invocation may carry a command word (`/baton add`, `/baton send partner2`). Dispatch on the first token. With no command: if the conversation is asking for a handoff, run `send`; otherwise run `list` and show the available commands.

- `add [name]` — add a session partner
- `list` — show configured partners
- `remove <name>` — remove a partner
- `default <name>` — set the default partner
- `check [name]` — verify a partner is handoff-ready
- `send [name]` — hand off to a partner (the full flow below)
- `return` — return handoff to the original sender
- `status [name]` — compare local and remote against the last recorded handoff
- `history [name]` — show past handoffs from the ledger

Partner commands edit `~/.config/baton/config.json` (shape in Step 0). Read-modify-write: preserve fields you don't recognize; create the file and directory on first `add`.

### add [name]

1. Collect: partner name (default `partner`), `ssh` destination, `handoffDir` (default `~/baton-inbox`). Take values from the user's message when present; ask only for what's missing — the minimum is the ssh destination.
2. Discover agents on the partner (see Agent Discovery) and offer the found CLIs back to the user to pick `receiverCommand`. If exactly one is found, propose it; if none, ask the user what to use and say none of the known CLIs were found.
3. Merge into config without touching other hosts. The first partner becomes `defaultHost`.
4. Run the remaining `check` probes. Save regardless, but report any failure explicitly — an unreachable partner is saved config, not a working handoff target.

### list

Show each partner (name, ssh, handoffDir, receiverCommand) and mark the default. No config → say so and offer `add`.

### remove <name>

Confirm with the user, then delete the host. If it was `defaultHost`: a single remaining host becomes default; otherwise ask which.

### default <name>

Set `defaultHost`. Error if the name doesn't exist.

### check [name]

Probe the partner (the default host if no name):

```bash
ssh <ssh> 'node --version && tmux -V && command -v <first word of receiverCommand>'
```

Report each item pass/fail: reachable, node >= 22, tmux present, receiver command found. All must pass before `send` relies on this partner. Also run Agent Discovery and report which agent CLIs the partner has — if the configured `receiverCommand` is missing but others were found, offer them; update config only with the user's choice, never by silent substitution.

### send [name]

The handoff flow below, Step 0 onward. An explicit name overrides `defaultHost`.

### return

The Return Handoff section below, applied from the receiver side.

### status [name]

Answer two questions against the last ledger record for the partner (see Handoff Ledger): has the remote moved ahead, and is local still what was sent?

1. Read the newest ledger record for the partner (newest overall if no name). No record → say so and stop.
2. **Local**: `node "$BATON" workspace-hash --workspace <recorded workspace>` — compare `manifestHash` and `git.head` to the record. Mismatch means local changed since the handoff.
3. **Remote**: run the same hash on the receiver without any remote install by piping the script over ssh:

```bash
ssh <ssh> 'node --input-type=module - workspace-hash --workspace <recorded remoteDir>' < "$BATON"
```

Compare to the record: remote `manifestHash`/`git.head` differ → the remote is ahead (the receiver did work).

4. For `github-branch` mode also `git fetch` locally and compare the recorded branch tip to the recorded SHA.
5. Report one verdict — `in-sync` (both match the record), `remote-ahead`, `local-ahead`, or `diverged` (both changed) — plus the evidence hashes. `diverged` means a return handoff needs explicit reconciliation; never merge silently.

### history [name]

Read `~/.config/baton/history.jsonl` and show the records (filtered by partner when named), newest first: timestamp, direction, partner, mode, short `manifestHash`, short `git.head`, status. Missing file → no handoffs yet.

## Handoff Ledger

`~/.config/baton/history.jsonl` — append-only, one JSON object per line, written by the sender after every handoff attempt that reaches a terminal state (released, failed, or abandoned). Before transfer, capture the workspace fingerprint with `workspace-hash` (both modes — not just bundles) and record:

```json
{"at":"<ISO8601 UTC>","direction":"sent","partner":"<name>","ssh":"<dest>","mode":"github-branch|scp-bundle","workspace":"/abs/local/path","remoteDir":"<verified receiver dir>","manifestHash":"sha256:<from workspace-hash>","git":{"head":"<sha>","branch":"<branch>","dirty":false},"tmuxSession":"<name>","receiverCommand":"<cmd>","status":"released|failed|incomplete"}
```

`git` is `null` for non-repo workspaces. A `return` handoff appends its own record with `direction: "returned"`. This ledger is what `status` compares against — skipping the append breaks later drift detection.

## Agent Discovery

Probe a partner for known agent CLIs in one ssh call (login shell, so PATH additions from the user's profile apply):

```bash
ssh <ssh> 'bash -lc "for c in claude opencode codex gemini hermes openclaw amp aider goose; do command -v \"\$c\" >/dev/null 2>&1 && echo \"\$c\"; done; true"'
```

Extend the probe list with any other agent CLI the user mentions. Map found binaries to receiver commands:

| CLI | receiverCommand |
| --- | --- |
| `claude` | `claude --remote-control` (remote-control receiver — preferred) |
| anything else (`opencode`, `codex`, `gemini`, `hermes`, `openclaw`, ...) | the bare binary, run interactively inside tmux |

Only Claude supports `--remote-control`; for every other CLI the receiver is a plain interactive session in tmux and the handoff prompt is injected with `tmux send-keys` (confirm the UI is ready before sending Enter). Present the found options to the user and let them choose — never pick a different agent than the configured one without asking.

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
- If the config is missing or has no usable host, run the `add` command flow (ask for the SSH destination and write the config). Never invent a host. Never hard-code one.

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

After writing `HANDOFF.md`, capture the workspace fingerprint for the ledger (see Handoff Ledger):

```bash
node "$BATON" workspace-hash --workspace "$WORKSPACE"
```

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

### `workspace-hash --workspace <path>`

Fingerprints a workspace without writing anything: the same exclusion rules and content-addressed `manifestHash` as `bundle-create` (identical tree → identical hash), plus git state when the workspace is a repo.

Output JSON: `{ mode: 'hash', manifestHash, fileCount, git: { head, branch, dirty } | null, skippedSymlinks, excludedSensitive, excludedIgnored }`

Runs remotely with no install by piping the script over ssh:

```bash
ssh <ssh> 'node --input-type=module - workspace-hash --workspace <dir>' < "$BATON"
```

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
- Sender appends the ledger record to `~/.config/baton/history.jsonl`.
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

Then append the ledger record (Handoff Ledger section) — the evidence file is the human artifact, the ledger line is what `status` reads.

## Failure Handling

- If Git push/fetch fails, do not silently fall back unless the user accepts bundle mode.
- If `bundle-create` reports the 256 MiB ceiling, switch to branch handoff — do not split or truncate the bundle.
- If bundle verification fails, stop and preserve evidence.
- If the output directory is non-empty, pick a fresh directory — never delete receiver files to make room.
- If `tmux` is missing, install it only with user approval; otherwise stop.
- If the receiver command is unavailable on the remote (e.g. `--remote-control` unsupported), stop.
- If the receiver prompt is pasted but not submitted, inspect the tmux pane and send Enter only after confirming the UI is ready.
- If the receiver acknowledges context but not file parity, the handoff is incomplete.
