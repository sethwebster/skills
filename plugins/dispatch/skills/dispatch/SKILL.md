---
name: dispatch
description: >-
  Use this skill when the user asks to dispatch, delegate, farm out, or send a
  scoped task to a remote agent, or to hand off, pass, or continue a task,
  session, repository, or workspace on another machine. Default dispatch keeps
  the sender as orchestrator and returns verified work. `send --pass` transfers
  full ownership after file parity and receiver acknowledgment. It also handles
  worker setup, status, steering, collection, recall, and session history.
---

# Dispatch

One transport, two ownership modes:

- `/dispatch send [worker]` delegates a scoped task. The sender supervises, verifies the result, and integrates it.
- `/dispatch send [worker] --pass` hands over the task and workspace. The receiver owns the live session after the sender accepts its signed acknowledgment.

The invariant is:

> Authenticate first. Verify file parity second. Launch third. Acknowledge fourth. Release or collect last.

`scripts/dispatch.mjs` next to this file owns the mechanical work on both machines. It creates signed envelopes, transfers context, checks manifests, launches tmux, records heartbeats, and resolves state from a ledger. Use it instead of hand-assembling SSH, SCP, tmux, HMAC, or manifest commands.

```bash
DISPATCH="<directory containing this SKILL.md>/scripts/dispatch.mjs"
node "$DISPATCH"
```

Every command prints JSON with a `next` field when another mechanical step exists. Exit code 0 means the command's invariant passed.

## Trust model

- SSH bootstraps trust. `transfer` writes a 32-byte HMAC key to the receiver inside that channel with mode 0600.
- The key signs the envelope, acknowledgment, heartbeat, and result. A receiver acknowledgment proves possession of the key and confirms the context manifest.
- Default delegation treats returned work as an external contribution until its signature, manifest, local gate, and diff all pass.
- Pass mode transfers ownership only after `release` re-verifies the latest acknowledgment and confirms the tmux session is alive.
- Prompt files and workspace files transfer. Process memory, hidden model state, shell state, credentials, and unrecorded decisions do not.

## Commands

Dispatch on the first token. With no command, run `init` when no config exists, infer `send` only when the conversation clearly requests remote work, otherwise run `list`.

| command | action |
| --- | --- |
| `init` | Import `ssh` and agent commands from legacy `~/.config/baton/config.json` when present, or run `add`. Never import secrets. Check each worker and offer fleet mode, which defaults off. |
| `add [name]` | Collect `ssh`, `dispatchDir` defaulting to `~/dispatch-inbox`, heartbeat and deadline settings. Run `discover`; let the user choose an agent command. Add without replacing unknown config fields, then run `check`. |
| `list`, `remove`, `default` | Read or edit `~/.config/dispatch/config.json`. Confirm removal and preserve unknown fields. |
| `check [name]` | Run `node "$DISPATCH" check [name]`. Report reachability, Node, tmux, agent binary, and auth. Give the printed login fix to the user when auth fails. Do not perform OAuth or device login for them. |
| `send [name]` | Run the shared send flow below and retain sender ownership. |
| `send [name] --pass` | Run the shared flow, then the pass-mode release in [references/pass-mode.md](references/pass-mode.md). |
| `status`, `follow`, `steer`, `collect`, `recall`, `sessions`, `history` | Run the matching CLI command by dispatch ID. |
| `enable`, `disable`, `mode` | Manage fleet reminders with `set-mode` and `mode`. |

Config shape: `{ "defaultWorker": "w", "workers": { "w": { "ssh": "user@host", "dispatchDir": "~/dispatch-inbox", "agentCommand": "codex", "heartbeatSeconds": 300, "maxStaleSeconds": 900, "deadlineMinutes": 60, "lastAuthOkAt": null } } }`. Never invent a worker.

## Shared send flow

### 0. Worker and auth

Pick the explicit worker, then `defaultWorker`. Run `check` first unless `lastAuthOkAt` is from today. A signed-out agent discovered after transfer wastes the run.

### 1. Context and prompt

Choose the ownership mode before packaging context.

- Default delegation gets only the files and instructions needed for the scoped task.
- Pass mode gets the complete useful workspace and a written session packet. Read [references/pass-mode.md](references/pass-mode.md) before preparing it.

For a git repository, prefer a pushed `dispatch/<slug>` branch when the worker can reach its remote. Otherwise create a git bundle from a committed ref. Ask before committing uncommitted work. If a pass must include uncommitted state and the user declines a commit, use full-tree files mode and state that the receiver will not get git history.

Use curated files mode for non-repository work. `.env*` files never ship. Report excluded sensitive paths and arrange credentials through the user.

Write the task or handoff packet to a prompt file. Include the goal, exact next step, definition of done, verification gate, and explicit constraints.

### 2. Prepare

```bash
node "$DISPATCH" prepare --worker <name> --root <context-root> \
  [--paths-file <file>] --prompt-file <file> \
  --gate "<observable verification>" \
  --constraints "do not force-push;do not touch main" \
  [--ref dispatch/<slug>] [--pass] --out-dir /tmp/dispatch/<slug>
```

`--pass` is a bare boolean flag. It records receiver ownership in the signed envelope and ledger. Keep explicit constraints in both modes.

### 3. Transfer

Run `node "$DISPATCH" transfer <id> [--bundle <file> | --branch <ref> --repo-url <url>]`. With neither option it transfers the prepared file set. Stop on `manifestMatch:false`; launch is forbidden until the receiver recomputes the expected manifest.

### 4. Launch

Run `node "$DISPATCH" launch <id> --agent "<command>" --mode interactive|headless`.

- Interactive is the default for steerable work and is mandatory for `--pass`.
- Headless is only for a short, complete, fire-and-forget delegation.
- Autonomous or permission-bypass agent flags require the user's opt-in.

The command launches an `agent` tmux window and a `pulse` window, clears known startup interstitials, injects `receiver.md`, and returns an attach command. Give that command to the user.

### 5. Verify acknowledgment

Run `node "$DISPATCH" await-ack <id>`. It polls for up to 120 seconds by default. An unverified or incomplete acknowledgment is not a started dispatch.

- Default delegation: inspect `understanding`, `plan`, and `willNotDo`, correct them with `steer` when needed, then supervise with `follow`.
- Pass mode: inspect the stronger acknowledgment and continue with [references/pass-mode.md](references/pass-mode.md). Do not release automatically.

## Default delegation lifecycle

Run `follow <id>` in the background or poll `status <id>` through a monitor. Stay responsible until a terminal verdict unless the user asked for detached work.

Verdicts are `alive`, `idle`, `blocked`, `done`, `failed`, `dark`, `expired`, `no-signal`, and `unverified`. Nudge a persistently idle agent. Answer a blocked agent through `steer`. Treat unsigned or stale state as unknown, not success.

`collect <id> --into <fresh-empty-dir>` pulls returned work and verifies its signature and manifest. Run the printed gate locally, review the diff, then integrate only with the user's approval for hard-to-reverse changes. Mark the dispatch collected after integration.

## Triage

Use at most two diagnostic actions or about two minutes before escalating with the pane excerpt and exact fix.

| pane state | response |
| --- | --- |
| login prompt, device code, 401, or invalid key | Give the user the `check` command's login fix. Wait for them to finish login. |
| safe menu or confirmation prompt | Use `steer --keys` with the safe selection. Ask when the answer changes scope or permissions. |
| agent missing or exited | Re-run discovery and attempt one launch. Do not re-transfer intact context. |
| agent working without acknowledgment | Steer a short instruction to run `worker init` and `worker ack`. |
| anything else | Escalate with evidence. |

## Status, steering, recall, and history

- `steer <id> --file <instruction.md>` transfers a file and sends a quote-safe pointer. `--keys` sends literal tmux keys. Headless runs cannot be steered.
- `recall <id> [--purge true]` stops the sessions. Purge only after warning about discarded work. A released pass also requires explicit `--force`, because the receiver owns its files.
- `sessions` cross-references remote `dsp-*` tmux sessions with the ledger.
- `history` merges the append-only `~/.config/dispatch/history.jsonl` without printing its stored HMAC keys.

## Fleet mode and live observation

Fleet mode is an optional reminder hook. It proposes dispatch for work that ties up a local GUI, consumes heavy resources, runs long, or parallelizes cleanly. It never forces offloading.

For pane streaming and public progress tunnels, read [references/live-mode.md](references/live-mode.md) only when the user asks to observe the run live. Streams are observational. Trust decisions still use signed files.

## Non-negotiables

- File parity precedes launch. Verified acknowledgment precedes delegation or release.
- Default delegation requires a verified return and local gate before integration.
- Pass mode requires an interactive receiver, an exact next step, the same gate, readiness `ready`, and an explicit `release` command.
- After release, the sender stops following, steering, and collecting. A return is a new passed dispatch in the opposite direction.
- Never ship secrets, forward an SSH agent, print the HMAC key, fabricate status, merge unverified work, or overwrite a dirty workspace.
- Dispatch IDs are independent, so scoped delegations may run concurrently. Each passed dispatch has exactly one owner.
