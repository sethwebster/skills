# Live mode (SSH-native, optional)

`follow` and `steer` default to poll-based signals — heartbeats on the interval, `status` pulls. Live mode adds real-time streaming over the SSH channel you already hold: no new port, daemon, or protocol. SSH is already an authenticated, confidential socket — multiplex it instead of building a second one. DEP (signed files) stays the floor; live mode is observation glue that never touches the trust decision.

**Reuse one connection.** Open a persistent master so live-follow and repeated `steer`/`status` calls skip the TCP+auth handshake:

```bash
# ~/.ssh/config (or pass the -o flags inline)
Host <worker-host>
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

**Stream the pane (`follow --live`).** Tee the agent's tmux pane to a file on the worker, then `tail -f` it down the master connection:

```bash
ssh <ssh> "tmux pipe-pane -t <dispatchId> -o 'cat >> <RDIR>/return/pane.log'"
ssh <ssh> "tail -n +1 -f <RDIR>/return/pane.log"
```

`-o` makes the pipe persist across commands; a bare `pipe-pane` (no `-o`) toggles it off. Reading `pane.log` is observation only — `status`, `collect`, and every integration decision still run off the **signed** heartbeat/result, never the stream.

**Push-on-blocked.** Have the receiver prompt, on block, write a `blocked` heartbeat **immediately** (not on the interval) and append a one-line `NEEDINPUT: <question>` marker to `pane.log`. Your live `tail -f` surfaces it at once; answer with `steer`. Closes the blocked-agent round-trip without any inbound channel.

**Teardown.** Live mode adds no tmux sessions, so `recall` is unchanged:

```bash
ssh <ssh> "tmux pipe-pane -t <dispatchId>"   # no -o = stop teeing
ssh -O exit <ssh>                             # close the master connection
```

A real socket protocol only wins if dispatch grows into a persistent worker fleet with a standing control plane (sub-second bidirectional RPC, presence, backpressure). At that point layer MCP / ACP / A2A on top; DEP remains the fallback. Full rationale: `design/live-monitoring.md` at the plugin root.

# Live progress tunnel (optional)

When the user wants to watch a long dispatch "from anywhere," stand up the viewer as **sender-managed infrastructure in its own tmux sessions**, not inside the agent's sandbox — a sandboxed child process dies when the agent exits:

```bash
ssh <ssh> "tmux new-session -d -s <id>-web  'python3 -m http.server <port> --directory <RDIR>/return/work/site'"
ssh <ssh> "tmux new-session -d -s <id>-tun  'cloudflared tunnel --url http://localhost:<port> > <RDIR>/cloudflared.log 2>&1'"
# parse the public URL from cloudflared.log (https://<name>.trycloudflare.com)
```

Tell the agent (in its prompt) to rewrite `return/work/site/index.html` each phase with a `<meta http-equiv="refresh">` so the viewer auto-updates. `cloudflared` quick tunnels need no account; `ngrok`/`tailscale funnel` are alternatives. `recall` must also kill `<id>-web` and `<id>-tun`.
