---
name: dispatch
description: >-
  Use this skill whenever the user asks to dispatch, delegate, farm out, or send
  a task to a remote agent on another server and get the result back — not a
  full session handoff (that is baton), but a scoped request/response where you
  stay the orchestrator. It negotiates SSH, discovers which agent CLIs exist on
  the worker (claude, opencode, codex, hermes, gemini, aider, goose, ...),
  packages a right-sized prompt + context, mints a per-dispatch shared key so
  every message is HMAC-signed and tamper-evident, launches the remote agent in
  tmux under an agreed envelope protocol, then monitors it — picking up and
  integrating the verified result when done, and following up if it goes dark.
  Trigger on phrases like dispatch this to <host>, send this task to the build
  box, delegate to the remote agent, farm this out, run this on the worker and
  bring back the result, remote agent job, offload to <server>. Also handles
  worker management: dispatch add, list, remove, default, and check.
---

# Dispatch

Dispatch is delegation, not handoff. You keep ownership of the work: you send a scoped task to a remote agent, it does the work, and **you** pick the result back up and integrate it. Baton gives the session away and releases; dispatch keeps you in the loop as orchestrator.

The invariant is:

> Authenticated handshake first. Right-sized context second. Signed heartbeats throughout. Verified result before integration. Never integrate unverified or untested remote output.

## Trust model (read once)

- **SSH is the trust bootstrap.** The SSH connection is already authenticated and confidential, so the per-dispatch key travels safely inside the envelope on the way out.
- **The shared key secures every leg after that.** Once minted, the key (`HMAC-SHA256`, 32 random bytes) signs the dispatch envelope, the receiver's ack, every heartbeat, and the final result. This is what makes the *return address a two-way handshake*: the receiver proves it holds the key by signing its ack; you prove it by verifying. Any middlebox tamper — or any party without the key — fails the HMAC check. The return leg may be asynchronous (a later SSH pull, a git branch, a shared inbox dir) and not ride the original session, which is exactly why signing, not transport alone, is the guarantee.
- **Integrity is content-addressed.** Context and returned work are fingerprinted with a canonical manifest hash; the hash is carried *inside* the signed envelope, so it cannot be swapped without breaking the signature.
- **Remote output is untrusted until verified.** Signature valid + manifest matches + your local verification gate passes — only then integrate. Treat returned code as you would a PR from a stranger.

## Commands

The invocation may carry a command word (`/dispatch add worker2`, `/dispatch status dsp-...`). Dispatch on the first token. With no command: if the conversation is asking to delegate a task, run `send`; otherwise run `list` and show the commands.

- `add [name]` — register a worker server
- `list` — show configured workers
- `remove <name>` — remove a worker
- `default <name>` — set the default worker
- `check [name]` — verify a worker is dispatch-ready (reachable, node, tmux, agent CLI)
- `send [name]` — dispatch a task to a worker (the full flow below)
- `status [dispatch-id]` — pull + verify the heartbeat/result; report alive / blocked / done / failed / dark
- `collect <dispatch-id>` — pull the signed result, verify it, run the gate, integrate
- `follow [dispatch-id]` — watch heartbeats; on dark, attach the tmux pane and diagnose
- `recall <dispatch-id>` — abort a dispatch and clean up its remote workspace
- `history` — show past dispatches from the ledger

Worker commands edit `~/.config/dispatch/config.json` (shape in Step 0). Read-modify-write: preserve fields you don't recognize; create the file and directory on first `add`.

### add [name]

1. Collect: worker name (default `worker`), `ssh` destination, `dispatchDir` (default `~/dispatch-inbox`), and defaults `heartbeatSeconds` (300), `maxStaleSeconds` (900), `deadlineMinutes` (60). Take values from the user's message; ask only for what's missing — the minimum is the ssh destination.
2. Discover agents on the worker (see Agent Discovery) and offer the found CLIs so the user picks `agentCommand`. Propose it if exactly one; ask if none, saying none of the known CLIs were found.
3. Merge into config without touching other workers. The first worker becomes `defaultWorker`.
4. Run the `check` probes. Save regardless, but report any failure explicitly.

### list / remove / default

Mirror the obvious semantics. `remove` confirms first; if it was `defaultWorker`, a single remaining worker becomes default, else ask which. `default` errors if the name is unknown.

### check [name]

Probe the worker (default if unnamed) in one call, then Agent Discovery:

```bash
ssh <ssh> 'node --version && tmux -V && command -v <first word of agentCommand>'
```

Report each pass/fail: reachable, node >= 20, tmux present, agent command found. All must pass before `send` relies on it. If the configured `agentCommand` is missing but others were found, offer them — never silently substitute.

### send [name]

The dispatch flow, Step 0 onward. An explicit name overrides `defaultWorker`.

### status / collect / follow / recall / history

See the sections of the same name below.

## Agent Discovery

Probe the worker for known agent CLIs in one login-shell ssh call (so profile PATH additions apply):

```bash
ssh <ssh> 'bash -lc "for c in claude opencode codex gemini hermes aider goose amp openclaw; do command -v \"\$c\" >/dev/null 2>&1 && echo \"\$c\"; done; true"'
```

Extend the list with any agent CLI the user names. Map found binaries to launch commands:

| CLI | agentCommand (non-interactive worker) |
| --- | --- |
| `claude` | `claude -p` (headless print mode) or interactive in tmux — prefer whichever the worker supports; `--dangerously-skip-permissions` only if the user opts in for an autonomous run |
| `codex` | `codex exec` (non-interactive) or interactive in tmux |
| `opencode` | `opencode run` or interactive in tmux |
| anything else (`gemini`, `hermes`, `aider`, `goose`, ...) | the bare binary, run interactively inside tmux |

Present the found options and let the user choose the worker's agent — never pick a different agent than the configured one without asking. Capability-match when it matters (e.g. a task needing a specific toolchain → the worker that has it).

## The Dispatch Envelope Protocol (DEP)

DEP is the floor both sides agree to speak (this is the "agreement on ACP usage" — a minimal, agent-agnostic contract, since claude / codex / opencode / hermes do **not** share a formal wire protocol). If a worker natively speaks a richer protocol (MCP, A2A), it may layer that on top, but DEP is always available: JSON files + tmux injection + HMAC, exactly the least-common-denominator that every CLI supports.

Every message both directions is a JSON object signed with the shared key. Never hand-compute the HMAC — always use the script so canonicalization is byte-identical on both machines.

**Dispatch envelope** (sender → worker):

```json
{
  "dispatchId": "dsp-...",
  "type": "dispatch",
  "protocol": "dep/1",
  "sender": "<who + return contact>",
  "return": { "method": "ssh-pull|git-branch", "dir": "<remote result dir>", "ref": "<branch, git mode>" },
  "context": { "manifestHash": "sha256:...", "root": "<remote context dir>" },
  "prompt": "<the task>",
  "constraints": ["do not force-push", "do not touch main", "no network exfil", "..."],
  "gate": "<how the sender will verify the result, e.g. 'pnpm test' passes>",
  "heartbeatSeconds": 300,
  "deadline": "<ISO8601>",
  "hmac": "..."
}
```

**Ack** (worker → sender, completes the handshake): `{ dispatchId, type:"ack", agent, workspace, contextManifestVerified:true, understanding, plan, willNotDo, gate, hmac }`.

**Heartbeat** (worker → sender, every `heartbeatSeconds`): `{ dispatchId, type:"heartbeat", status:"working|blocked", updatedAt, progress, hmac }`.

**Result** (worker → sender, on completion): `{ dispatchId, type:"result", status:"done|failed", summary, manifestHash, ref, notes, hmac }`.

## Script Resolution

The script lives next to this SKILL.md at `scripts/dispatch.mjs`. Resolve it relative to wherever the skill is installed — never assume the user's workspace.

```bash
SKILL_DIR="<directory containing this SKILL.md>"
DISPATCH="$SKILL_DIR/scripts/dispatch.mjs"
```

Script commands (`node "$DISPATCH" <cmd>`, node stdlib only, exit code reflects pass/fail for `verify`/`check-heartbeat`/`verify-result`):

- `keygen` → `{ dispatchId, key, algo }`
- `manifest --root <dir> [--paths-file <f>] [--out <f>]` → content-addressed fingerprint of the curated context (walks the dir, or hashes an exact relative-path list; excludes `.env*` except examples, `.git`, `node_modules`, `dist`, `build`)
- `sign --key <hex> --in <body.json> [--out <f>]` → adds `hmac`
- `verify --key <hex> --in <signed.json>` → `{ verified, ... }`, exit 0/1
- `check-heartbeat --key <hex> --in <hb.json> [--max-stale-seconds N] [--deadline <iso>]` → `{ verdict: alive|dark|blocked|expired|done|failed, ageSeconds, ... }`, exit 0 only for alive/done
- `verify-result --key <hex> --result <result.json> [--root <extracted-dir>]` → verifies signature AND re-hashes the returned tree against the signed `manifestHash`

## Send flow

### Step 0: Config

Read `~/.config/dispatch/config.json`:

```json
{
  "defaultWorker": "worker",
  "workers": {
    "worker": {
      "ssh": "user@host.example.ts.net",
      "dispatchDir": "~/dispatch-inbox",
      "agentCommand": "claude -p",
      "heartbeatSeconds": 300,
      "maxStaleSeconds": 900,
      "deadlineMinutes": 60
    }
  }
}
```

Missing or no usable worker → run `add`. Never invent or hard-code a worker.

### Step 1: Right-size the context

Send **no more or less than necessary**. Decide the task boundary first, then include only what it needs:

- Prefer a **curated file list** over the whole workspace. Write the relative paths to a paths-file and let the manifest hash exactly those.
- If the task is a repo change and the needed state is committed (or the user approves a commit), the cleanest transfer is a **git branch** the worker checks out — no bundle, and integration is a merge.
- Never include secrets. The manifest excludes `.env*`; if the task genuinely needs a credential, the user supplies it out-of-band, deliberately.
- Write the task **prompt** as a file: goal, the exact next step, the definition of done, and the verification gate. Reference the context by path, don't restate files.

Fingerprint the curated context:

```bash
node "$DISPATCH" manifest --root "$CONTEXT_ROOT" --paths-file "$PATHS" --out /tmp/dispatch/context.manifest.json
```

Report `excludedSensitive` and `skippedSymlinks` to the user before transfer.

### Step 2: Mint the key and build the signed envelope

```bash
node "$DISPATCH" keygen   # -> dispatchId, key
```

Compose the envelope body (Step 1 manifest hash, prompt, return address, constraints, gate, deadline, heartbeat interval), then sign it:

```bash
node "$DISPATCH" sign --key "$KEY" --in /tmp/dispatch/envelope.body.json --out /tmp/dispatch/envelope.json
```

The worker needs the key to verify the envelope and to sign its replies, so the key ships **inside the envelope over SSH** (SSH is the confidential bootstrap). Keep a copy in the local ledger for later `status`/`collect`. Do not print or send the key on any channel other than the SSH transfer.

### Step 3: Transfer

Create a fresh remote dispatch dir and copy the script, the signed envelope, and the curated context there:

```bash
RDIR="<dispatchDir>/<dispatchId>"
ssh <ssh> "mkdir -p $RDIR/context $RDIR/return"
scp "$DISPATCH" /tmp/dispatch/envelope.json <ssh>:$RDIR/
# curated context: git branch checkout on the worker, OR scp the listed files into $RDIR/context
```

The worker recomputes `manifest --root $RDIR/context` and it MUST equal the envelope's `context.manifestHash`. A mismatch means the context did not arrive intact — stop, do not launch the agent.

### Step 4: Launch the worker agent in tmux

Always run the agent inside `tmux` so the human can SSH in, attach, and intervene. Start detached, `cd` into the dispatch dir:

```bash
ssh <ssh> "cd $RDIR && tmux new-session -d -s $dispatchId '<agentCommand>'"
```

Inject the DEP receiver prompt (Receiver Contract below) via `tmux send-keys`; for interactive CLIs confirm the UI is ready before sending Enter. For headless modes (`claude -p`, `codex exec`) pass the prompt as the argument/stdin instead.

### Step 5: Handshake

The worker must reply with a signed **ack** written to `$RDIR/return/ack.json`. Pull and verify it:

```bash
ssh <ssh> "cat $RDIR/return/ack.json" > /tmp/dispatch/ack.json
node "$DISPATCH" verify --key "$KEY" --in /tmp/dispatch/ack.json
```

Verified ack = two-way handshake complete (the worker proved it holds the key). Confirm the ack states: correct task understanding, verified workspace + context manifest, plan, what it will not do, and the gate. An unverified or context-unconfirmed ack is **not** a started dispatch — stop and diagnose.

### Step 6: Record and detach

Append the ledger record (Ledger section), report the attach command to the user, then set up monitoring (`follow`). You do **not** block the session waiting; the dispatch is durable and identified by `dispatchId`.

## Receiver Contract (injected prompt)

The prompt tells the remote agent to:

1. Read `envelope.json`; verify its `hmac` with the provided key (`node dispatch.mjs verify`). If it fails, refuse — the task is not authentic.
2. Recompute `manifest --root context` and confirm it equals `context.manifestHash`. Mismatch → refuse.
3. Write a signed `ack.json` (understanding, plan, willNotDo, verified workspace + manifest, gate) to `return/`.
4. Do the task within the stated `constraints`. Honor the gate as the definition of done.
5. Every `heartbeatSeconds`, write a signed `heartbeat.json` to `return/` (`status`, `updatedAt` = current ISO time, `progress`).
6. On completion, write the returned work (git branch push, or files under `return/work/`), then a signed `result.json` with the work's `manifestHash` and `status: done|failed`. `failed` is legitimate — return partial work + the reason, never fabricate success.
7. Sign every reply with the same key using `node dispatch.mjs sign`.

## status [dispatch-id]

Pull the latest signal and verify it:

```bash
ssh <ssh> "cat $RDIR/return/result.json 2>/dev/null || cat $RDIR/return/heartbeat.json 2>/dev/null" > /tmp/dispatch/signal.json
node "$DISPATCH" check-heartbeat --key "$KEY" --in /tmp/dispatch/signal.json --max-stale-seconds <maxStaleSeconds> --deadline <deadline>
```

Report one verdict: `alive` (working, fresh), `blocked` (worker needs input), `done`, `failed`, `expired` (past deadline), or `dark` (heartbeat stale beyond `maxStaleSeconds`). Never trust an unsigned signal.

## follow [dispatch-id]

Watch without busy-polling. Poll `status` on the heartbeat interval (use the harness Monitor / scheduled wake-up rather than a tight loop). Two things end the watch:

- **done/failed** → proceed to `collect`.
- **dark or expired** → the "followed up if it goes dark" path. SSH in and capture the pane to diagnose:

```bash
ssh <ssh> "tmux capture-pane -pt $dispatchId -S -200"
```

Common dark causes: a trust/permission prompt blocking the agent, a crash, or it is genuinely blocked waiting on input the constraints forbid. Report the pane evidence to the user and offer: nudge (send-keys), extend the deadline, `recall`, or attach (`ssh -t <ssh> 'tmux attach -t <dispatchId>'`). Never silently assume failure.

## collect <dispatch-id>

Pick up and integrate — the part that makes dispatch delegation, not fire-and-forget.

1. Pull the returned work into a **fresh local directory** (never overlay a dirty tree): `git fetch` + checkout the returned branch (git mode), or scp `return/work/` down (files mode).
2. Verify signature + integrity:

```bash
node "$DISPATCH" verify-result --key "$KEY" --result /tmp/dispatch/result.json --root <fresh-local-dir>
```

Both must hold: `verified: true` (authentic) and `manifestMatch: true` (the tree is exactly what was signed).
3. Run the **verification gate** from the envelope locally (build / tests / typecheck). Remote output is untrusted until the gate passes — report gate output honestly; a failed gate blocks integration.
4. Integrate as appropriate, with the user's approval for anything hard to reverse: merge the branch, or apply the files into the right place. Review the diff as you would an external PR before merging to a protected branch.
5. Append a `collected` ledger record with the final status.

## recall <dispatch-id>

Abort and clean up. Signal the worker (send-keys an interrupt / write a `cancel` marker), confirm the tmux session is stopped, and remove **only** the verified `<dispatchDir>/<dispatchId>` directory after confirming with the user — never a path outside `dispatchDir`. If the worker already did work, warn that recall discards it; require explicit confirmation. Append a `recalled` ledger record.

## Ledger

`~/.config/dispatch/history.jsonl` — append-only, one JSON object per line, written after every dispatch that reaches a terminal state:

```json
{"at":"<ISO8601 UTC>","dispatchId":"dsp-...","worker":"<name>","ssh":"<dest>","mode":"git-branch|files","remoteDir":"<verified dir>","contextManifest":"sha256:...","agent":"<cmd>","tmuxSession":"<id>","deadline":"<iso>","status":"dispatched|done|failed|collected|dark|recalled","gate":"<gate>"}
```

The key is recorded here (local, 0600 dir) so `status`/`collect` can verify later. `status` and `follow` read this to locate the dispatch. Skipping the append breaks later retrieval by id.

## Non-negotiables

- Do not launch the worker agent until the context manifest is verified on the worker side.
- Do not proceed past the handshake without a signature-verified ack that confirms the task and the context manifest.
- Do not integrate a result until signature verifies, the manifest matches, AND the local verification gate passes.
- Treat returned code as untrusted external contribution — review before merging to any protected branch.
- Never ship secrets in the context; the manifest excludes `.env*` by design.
- Never use SSH agent forwarding.
- Never overlay returned work onto a dirty tree — always a fresh directory.
- Scope the worker with explicit `constraints`; only enable an autonomous/skip-permissions agent mode with the user's opt-in.
- Never fabricate a status — an unsigned or stale signal is `dark`, not `done`.

## Concurrency

`dispatchId` makes many dispatches independent — fan out the same task to several workers, or different tasks across a fleet, and track each by id via the ledger. `status`/`follow`/`collect` all take an explicit id. Nothing about the flow assumes a single outstanding dispatch.

## Interop with baton

Same author, same marketplace, complementary primitives: **baton** = give the whole session away and release (parity-verified handoff); **dispatch** = keep ownership, delegate a scoped task, get the verified result back. If a dispatch grows into "just take this over," escalate to `/baton send`. If a worker's config already exists for baton, reuse the `ssh`/discovery values — but dispatch keeps its own config because it adds return, heartbeat, deadline, and per-dispatch keying.
