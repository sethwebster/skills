# Pass mode

Use this branch for `/dispatch send [worker] --pass`. It gives the receiver full ownership of the task, workspace, and live agent session. The sender remains responsible until `release` succeeds.

## Build the handoff packet

Write the prompt file before `prepare`. It is the durable replacement for conversational context and must contain:

- sender identity and the task goal
- current status, including completed and incomplete work
- decisions already made and choices still open
- relevant evidence and paths inside the transferred workspace
- the exact next step
- the verification gate
- scope constraints and actions that still require human approval

Include an existing `HANDOFF.md` in the context when one already carries this information. The signed envelope prompt remains authoritative for this dispatch. State explicitly that hidden model state, terminal state, and credentials are absent.

Completion criterion: a receiver with no prior conversation can identify the task, current state, next action, gate, and limits from transferred files alone.

## Transfer and launch

Run the shared prepare command with the bare `--pass` flag. Transfer and verify the manifest through the normal dispatch transport. Launch in interactive mode. The CLI rejects headless pass mode because the receiver must retain a live session that the user can attach to.

The receiver writes this stronger acknowledgment:

```bash
node dispatch.mjs worker ack \
  --understanding "<task and current state>" \
  --plan "<remaining plan>" \
  --next-step "<first concrete action>" \
  --will-not-do "<limits>" \
  --readiness ready
```

`await-ack` verifies the signature and context parity. In pass mode it also requires the exact workspace path, manifest hash, non-empty task understanding and next step, the original verification gate, and readiness `ready`.

## Release ownership

Read the acknowledgment. Compare its understanding, plan, next step, limits, and gate with the handoff packet. If any meaning is wrong, use `steer` to correct it and have the receiver write a new acknowledgment.

When the acknowledgment is both mechanically verified and semantically correct, run:

```bash
node "$DISPATCH" release <id>
```

`release` re-reads and verifies the latest acknowledgment, confirms the tmux session is alive, records `status: released`, and returns the attach command. Until it succeeds, the sender owns recovery.

After it succeeds:

- report the dispatch ID, receiver, verified workspace, manifest, exact next step, gate, and attach command
- stop monitoring and do not collect or steer the task
- leave the local workspace untouched
- treat receiver files as receiver-owned; `recall --force` requires a new explicit request that acknowledges possible data loss

The receiver may keep writing signed heartbeats and a terminal result for history. Those records do not restore sender ownership.

## Return or continuation

A return handoff is another `/dispatch send --pass` from the current owner to a configured worker on the original machine. Apply the same manifest, acknowledgment, and release gates in reverse. Do not use `collect` as a substitute for returning ownership.

Completion criterion: `release` reports `released: true`, the user has the attach command, and the sender has stopped acting as orchestrator.
