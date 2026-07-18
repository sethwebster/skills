# Design note: live monitoring / bidirectional comms for dispatch

Status: implemented in dispatch 0.5.0 (SKILL.md "Live mode (SSH-native, optional)")
Decision: **Do not build a standalone secure socket protocol.** Add an optional
`live` mode built on the SSH channel dispatch already holds.

## Question

Should dispatch add a secure socket protocol that stands up easily to allow
"unfettered" bidirectional communication while a dispatch runs and needs
monitoring?

## Decision

No new socket protocol. It fights the two design decisions that make dispatch
good, and its real benefits are reachable by better using the SSH channel we
already hold.

## Why a new socket protocol is the wrong shape

1. **"Unfettered" contradicts the premise.** The trust model is scoped, signed,
   verified — remote output is untrusted until the local gate passes. The value
   is the discipline on the channel, not the channel. The HMAC envelope is
   deliberately transport-independent for this reason. An always-open
   bidirectional socket dissolves the invariant rather than extending it.
2. **It reverses the "no daemon, no port" win.** DEP's headline is JSON files +
   tmux injection + HMAC, with no daemon or HTTP server to stand up. A socket
   means a listening process on the worker, a reachable port (NAT / firewall /
   tunnel story we now own), and re-solving auth + confidentiality that SSH
   gives for free. A listening port is attack surface; SSH-only is a smaller
   target.
3. **It breaks agent-agnosticism.** claude / codex / opencode / hermes share no
   wire protocol — that is why DEP exists. They all speak "read a file, write a
   file, receive keystrokes." A custom socket needs a shim wrapping every agent
   to bridge socket <-> stdin/stdout — exactly the complexity tmux+files avoids.

## The real need underneath

Latency + push, not transport:
- Heartbeats are 300s; `status` is pull-based.
- The "agent is blocked and needs an answer now" case round-trips through a
  stale heartbeat -> human notices -> `send-keys`.

That is worth fixing. SSH is already the secure socket — we just use it in
one-shot bursts.

## Recommended approach: optional `live` mode over the existing SSH channel

Zero new protocol / port / daemon / crypto:

- **`tmux pipe-pane`** — tee the agent's live output to a file, `tail -f` it over
  a persistent SSH channel = real-time streaming monitor.
- **`ControlMaster` / `ControlPersist`** — one long-lived SSH connection so
  live-follow and steering don't pay a handshake per poll.
- **`ssh -R` reverse tunnel** — if the worker genuinely needs to push to us,
  still no public port.
- **cloudflared live-progress tunnel** — already covers "human watches from a
  browser anywhere" (see the Live progress tunnel section of SKILL.md).

Steering via `send-keys` is already effectively live. Every real socket benefit
(live stream, low-latency steer, push-on-blocked) lands this way while staying
inside the existing trust model.

Scope: extend `follow` and `steer` with a `live` variant. Keep DEP as the signed
floor unchanged.

## When a real protocol WOULD be justified

If dispatch grows from "scoped request/response, you stay orchestrator" into a
**persistent worker fleet with a standing control plane** — sub-second
bidirectional RPC, presence, backpressure, multiplexed cancellable streams.
At that point don't roll your own: layer **MCP / ACP / A2A** on top, which the
SKILL already anticipates ("If a worker natively speaks a richer protocol… it
may layer that on top; DEP is always available as the fallback"). That is a
different product than dispatch is today.

## Unresolved questions

- Actual pain: monitoring latency (watch live) or blocked-agent round-trip
  (agent reaches us fast)? Different fixes.
- Persistent standing fleet on the roadmap, or does dispatch stay scoped
  request/response? Only the former argues for a real protocol.
