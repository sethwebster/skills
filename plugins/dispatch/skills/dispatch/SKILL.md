---
name: dispatch
description: >-
  Use this skill whenever the user asks to dispatch, delegate, farm out, or send
  a task to a remote agent on another server and get the result back — not a
  full session handoff (that is baton), but a scoped request/response where you
  stay the orchestrator. It negotiates SSH, discovers which agent CLIs exist on
  the worker (claude, opencode, codex, gemini, aider, goose, ...), packages a
  right-sized prompt + context, mints a per-dispatch key so every message is
  HMAC-signed, launches the remote agent in tmux under an envelope protocol,
  then monitors it and integrates the verified result. Trigger on phrases like
  dispatch this to <host>, send this task to the build box, delegate to the
  remote agent, farm this out, offload to <server>, remote agent job. Also
  handles worker management, live steering of a running dispatch, and session
  listing: dispatch init, add, list, remove, default, check, enable, disable,
  steer, and sessions.
---

# Dispatch

Delegation, not handoff. You send a scoped task to a remote agent, monitor it, and **you** pick the verified result back up and integrate it. Baton gives the session away; dispatch keeps you as orchestrator.

> Authenticated handshake first. Right-sized context second. Signed heartbeats throughout. Verified result before integration. Never integrate unverified or untested remote output.

**Everything mechanical is the CLI.** `scripts/dispatch.mjs` (next to this file; node stdlib, zero deps) runs on both sides: sender commands own the ssh calls and resolve everything from the ledger by `dispatchId`; the worker runs `worker <sub>` inside its dispatch dir. Your judgment belongs in exactly four places — **which context, the prompt, constraints + gate, and run mode**. Do not re-derive, hand-assemble, or "design" keys, envelopes, signatures, hashes, ssh/tmux/scp incantations, or heartbeat JSON — call the command. Every command prints JSON with a `next` hint; exit code 0/1 = pass/fail.

```bash
DISPATCH="<directory containing this SKILL.md>/scripts/dispatch.mjs"   # never assume the user's cwd
node "$DISPATCH"            # usage
```

## Trust model

- **SSH is the trust bootstrap.** The per-dispatch key (HMAC-SHA256, 32 random bytes) travels only inside the SSH channel (`transfer` writes it to `<remoteDir>/key`, mode 0600).
- **The key signs every leg after that**: envelope, ack, heartbeats, result. The receiver proves it holds the key by signing its ack (two-way handshake). Any tamper or keyless party fails verification.
- **Integrity is content-addressed.** Context and returned work are fingerprinted (canonical manifest hash) inside signed messages.
- **Remote output is untrusted until**: signature valid + manifest matches + your local gate passes. Treat returned code like a stranger's PR.

## Commands (`/dispatch <cmd>`)

Dispatch on the first token. No command: no config → `init`; the conversation is delegating a task → `send`; else `list`.

| command | what you do |
| --- | --- |
| `init` | first-run: import workers from `~/.config/baton/config.json` (ssh + agentCommand only, never secrets) or run `add`; `check` each; set default if exactly one; offer fleet mode (default off); report |
| `add [name]` | collect `ssh` (only required input), `dispatchDir` (`~/dispatch-inbox`), `heartbeatSeconds` 300, `maxStaleSeconds` 900, `deadlineMinutes` 60; `node "$DISPATCH" discover <name>` → user picks `agentCommand` (propose if exactly one; never silently substitute); merge into config (first worker = default); run `check` |
| `list` / `remove <name>` / `default <name>` | edit `~/.config/dispatch/config.json` read-modify-write, preserve unknown fields; `remove` confirms; unknown name errors |
| `check [name]` | `node "$DISPATCH" check [name]` — reachable, node ≥ 20, tmux, agent binary, **auth probe**. If `auth` ≠ `ok`: give the user the printed `fix` command verbatim, wait for "done", re-run once. Never attempt an OAuth/device-code login yourself |
| `send [name]` | the Send flow below |
| `status` / `follow` / `steer` / `collect` / `recall` / `sessions` / `history` | `node "$DISPATCH" <cmd> <id> ...` — see below |
| `enable` / `disable` / `mode` | `set-mode --available true|false [--interval-minutes N]` / `mode` (Fleet mode) |

Config shape: `{ "defaultWorker": "w", "workers": { "w": { "ssh": "user@host", "dispatchDir": "~/dispatch-inbox", "agentCommand": "codex", "heartbeatSeconds": 300, "maxStaleSeconds": 900, "deadlineMinutes": 60, "lastAuthOkAt": null } } }`. Never invent a worker.

## Fleet mode

`enable`/`disable` set whether you should *proactively* offer to offload work. It is a `UserPromptSubmit` hook (`hooks/hooks.json` → `reminder-check`) because a standing disposition must fire on future turns regardless of what the user typed. The nudge prints only when `mode.json` has `available: true` AND `reminderIntervalMinutes` (30) has elapsed; otherwise nothing. It asks you to propose `/dispatch send` when a task would tie up the local screen/simulator, eat heavy CPU/RAM/IO, run long, or parallelize across machines — never forces it. Separate from the plugin's own enabled state (`/plugin` menu, a harness operation).

## Send flow

**0. Worker + auth.** Pick the worker (explicit name > `defaultWorker`). If `lastAuthOkAt` is not today, run `check` first — a signed-out CLI discovered after transfer+launch wastes the whole budget.

**1. Right-size the context (judgment).** No more or less than the task needs.
- In a git repo, **a branch/bundle is the default, not an archive** — the return leg becomes a merge with provenance. Uncommitted state → ask the user to commit for dispatch (ask; don't fall back to files). Worker can reach the remote (`ssh <ssh> git ls-remote <url> HEAD`)? push `dispatch/<slug>` and use `transfer --branch --repo-url`; else `git bundle create ctx.bundle <ref>` and `transfer --bundle`. In both cases `prepare --root` is the checkout and `--ref` is the branch.
- Non-repo or standalone tasks: curated `--paths-file` (files mode).
- Secrets never ship (`.env*` excluded by the manifest; report `excludedSensitive`). Needed credentials go out-of-band via the user.
- Write the **prompt as a file**: goal, exact next step, definition of done, the gate. Reference context by path.

**2. Prepare.**
```bash
node "$DISPATCH" prepare --worker <name> --root <ctx-root> [--paths-file <f>] --prompt-file <f> \
  --gate "<how you will verify>" --constraints "do not force-push;do not touch main" [--ref dispatch/<slug>] --out-dir /tmp/dispatch/<slug>
```
Worker defaults come from config; `--heartbeat-seconds/--max-stale-seconds/--deadline-minutes` override. Prints `dispatchId`; from here every command takes that id.

**3. Transfer.** `node "$DISPATCH" transfer <id> [--bundle <f> | --branch <ref> --repo-url <url>]` — ships script + envelope + key, places the context, and has the worker recompute the manifest. `manifestMatch:false` → **do not launch**; fix and re-run.

**4. Launch (judgment: run mode).** `node "$DISPATCH" launch <id> --agent "<cmd>" --mode interactive|headless`
- **interactive** (default; long-running or steerable work): the TUI in tmux; the only mode you can re-steer mid-run with full context kept.
- **headless** (fire-and-forget only, fully specified short tasks): `claude -p`, `codex exec -s workspace-write --skip-git-repo-check` — no live input channel.
- Proven agent commands: codex interactive+autonomous `codex -s workspace-write -a never` (add `-c sandbox_workspace_write.network_access=true --search` if the task needs network); claude `claude` / `claude -p`; `--dangerously-skip-permissions` or codex `-a never` only with the user's opt-in for an autonomous run.
- `launch` starts an `agent` window and a `pulse` window (re-signs heartbeats every `heartbeatSeconds` so liveness costs the agent no tokens; `--pulse false` to disable), auto-dismisses known interstitials (codex self-update → Skip, trust-this-directory → Yes), then injects the receiver prompt via file+pointer. It returns the `attach` command — give it to the user.

**5. Handshake.** `node "$DISPATCH" await-ack <id>` (timebox 120s, polls every 20s). `ack:"verified"` = the worker proved it holds the key and confirmed the context; read its `understanding`/`plan`/`willNotDo` — if they are wrong, `steer` a correction. `ack:"none"` → the output includes the pane; go to Triage. An unverified ack is **not** a started dispatch.

**6. Follow.** `node "$DISPATCH" follow <id>` (run in the background with a Bash `run_in_background`, or poll `status <id>` on a Monitor/scheduled wake-up — never a tight loop). Report the attach command, then **stay on it**: unless the user explicitly asked for fire-and-forget, you keep supervising until a terminal verdict, nudge blocked agents, and collect. Durability by id is not permission to stop.

## Verdicts (`status` / `follow`)

`alive` (fresh, progressing) · `idle` (pulse fresh but no progress report in `maxStaleSeconds` — nudge with `steer` if it persists) · `blocked` (agent asked a question: read `progress`, answer via `steer`) · `done` / `failed` → `collect` · `dark` (no signed signal in `maxStaleSeconds`) / `expired` (deadline) / `no-signal` (nothing yet) / `unverified` (bad signature — treat as dark, never as done). Any non-alive verdict includes the pane (or `agent.log` tail for headless) so triage is one call. `follow` exits on the first verdict that needs you.

## Triage (fast-fail, hard budget)

**2 diagnostic actions or ~2 minutes, then escalate to the human.** A whole successful dispatch takes ~5 minutes; ten minutes of solo debugging has already failed. Read the pane from `await-ack`/`status`/`node "$DISPATCH" pane <id>` and act:

| pane shows | action |
| --- | --- |
| login URL, device code, "not logged in", 401, invalid API key | **escalate now**: one message — what's wrong, the exact fix (`node "$DISPATCH" check` prints it), what you'll do when they say done. Never run the login flow yourself |
| a y/n or menu prompt the launcher didn't catch | `steer <id> --keys "<tmux keys>"` with the safe answer if constraints allow (e.g. `--keys "2 Enter"`); else ask the user one question |
| shell prompt / "command not found" / `[dispatch] agent exited with status N` | agent crashed or never started: re-check `--agent` (`discover`), one relaunch (`launch <id>` again — dir, envelope, context all survive; never re-transfer to recover) |
| agent visibly working, no ack | `steer <id> --file` a one-line pointer to re-run `node dispatch.mjs worker init` then `worker ack` |
| anything else | escalate with the pane excerpt |

Offer extend deadline / `recall` / attach only when nudging is unsafe or insufficient. Never silently assume failure.

## steer <id>

`node "$DISPATCH" steer <id> --file <instruction.md>` — scp's the file in and sends a short quote-safe pointer (raw text through `send-keys` breaks on quotes; the CLI never does that). Interactive agents keep their context, so follow-ups build on completed work. Tell the instruction to end with `worker heartbeat`/`worker done` so the result is re-signed. `--keys "<tmux keys>"` sends literal keys (`C-c`, `2 Enter`). Headless runs cannot be steered — recall + relaunch.

## collect <id>

`node "$DISPATCH" collect <id> --into <fresh-empty-dir>` — pulls the work (bundle → `git clone`, or files), verifies **signature AND manifest** (`verified:true`, `manifestMatch:true`; anything else blocks integration). Then **you** run the gate from the output locally, report its result honestly, review the diff as an external PR, integrate with the user's approval for anything hard to reverse (never overlay a dirty tree), and `node "$DISPATCH" mark <id> --status collected`.

## recall / sessions / history

- `recall <id> [--purge true]` — interrupts the agent, kills `<id>`, `<id>-web`, `<id>-tun`; `--purge` removes only the verified dispatch dir. If work exists, warn it is discarded and require explicit confirmation before purging.
- `sessions` — per worker: live `dsp-*` tmux sessions cross-referenced with the ledger (`unknown` = not in your ledger; stale `dispatched` past deadline = candidates for `recall`).
- `history` — merged ledger (`~/.config/dispatch/history.jsonl`, append-only; the key lives there so status/collect work later — never print it).

## What the worker runs (for reference)

`launch` injects `receiver.md`, which tells the agent to run, in order: `worker init` (verifies envelope HMAC + context manifest; prints the task or `refuse`), `worker ack --understanding --plan --will-not-do`, then do the task with `worker heartbeat --status working|blocked --progress` at milestones, returned work under `return/work/` (files) or `git -C context bundle create return/work.bundle <ref>` (git), then `worker done|failed --summary`. `failed` with partial work is legitimate; fabricated success is not. Message shapes (`dep/1`): envelope `{dispatchId,type,protocol,sender,return,context,prompt,constraints,gate,heartbeatSeconds,deadline,hmac}`; ack/heartbeat/result as the CLI writes them. DEP is deliberately files+tmux+HMAC over SSH — no daemon, not ACP-compatible; a richer protocol may layer on top.

## Optional: live mode & progress tunnel

Real-time pane streaming over SSH (`ControlMaster` + `tmux pipe-pane` + `tail -f`), push-on-blocked, and the public progress-tunnel pattern (`<id>-web`/`<id>-tun` + cloudflared) are in `references/live-mode.md` — read it only when the user wants to watch live or from anywhere. Observation only; trust decisions always run off signed messages.

## Non-negotiables

- No launch until `transfer` reports `manifestMatch:true`; no proceeding without `ack:"verified"`; no integration until `verified` + `manifestMatch` + local gate pass.
- Returned code is an untrusted external contribution — review before merging to a protected branch; never overlay a dirty tree.
- Never ship secrets; never use SSH agent forwarding; never print the key.
- Explicit `constraints` always; autonomous/skip-permissions modes only on user opt-in.
- Never fabricate status — unsigned or stale is `dark`, not `done`.
- Never `send` without today's auth probe; triage gets 2 actions / ~2 minutes then one crisp escalation with the exact fix command.

## Concurrency & baton

Dispatches are independent by id — fan out across workers, `follow`/`collect` each. **baton** = give the whole session away (partners); **dispatch** = keep ownership, delegate a scoped task (workers). Same boxes: `init`/`add` import ssh + agentCommand from baton's config. If a dispatch grows into "just take this over," escalate to `/baton send`.
