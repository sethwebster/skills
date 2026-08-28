---
name: consensus
description: >-
  Get a cross-model consensus answer to a single question. Fans one prompt out to
  every AI model CLI installed on the machine (claude, codex, gemini, cursor-agent,
  opencode, ollama, and more) in parallel, then synthesizes their answers into one
  canonical response with any dissent surfaced. Use when the user asks for a second
  opinion, a multi-model cross-check, to reconcile conflicting answers, or wants
  higher confidence on a high-stakes, contested, or easy-to-get-subtly-wrong
  question — or when you want to verify a risky claim against other models before
  relying on it. Drives the `consensus` CLI over the shell; requires `consensus` on
  PATH.
license: MIT
---

# consensus

`consensus` asks one prompt to many independent AI model CLIs at once and merges
their answers into a single response. Different models are wrong in different
places, so reconciling several surfaces the claims they all support and exposes
the ones only one model makes. This skill tells you how to invoke it and read
the result.

## When to use it

Reach for consensus when a single model's answer isn't trustworthy enough on its own:

- The user explicitly asks for a consensus, a second opinion, "what do other
  models think", or to cross-check an answer across models.
- A decision is high-stakes, contested, or easy to get subtly wrong (architecture
  calls, security reasoning, tricky algorithms, legal/medical-adjacent framing).
- You have a claim you're unsure about and want to verify it against other models
  before stating it as fact.
- Two sources disagree and you want the disagreement reconciled rather than picked.

**When NOT to use it:** trivial or purely factual lookups, anything latency- or
cost-sensitive, or tasks that need tool use / file edits rather than an answer.
Each run spins up several real model CLIs, so it is slower and more expensive than
answering directly — spend it where cross-checking actually changes the outcome.

## Preconditions

`consensus` is a separate CLI; this skill does not bundle it. Before the first use:

```bash
command -v consensus || echo "consensus not installed"   # must resolve
consensus detect                                          # shows which model CLIs are found
```

- If `consensus` is missing, tell the user to install it (`npm install -g @sethwebster/consensus`, or `npm install && npm run build && npm install -g .` from the repo) rather than trying to work around it.
- `consensus` finds model CLIs already on PATH and reuses each one's existing auth — it never needs API keys. If `detect` shows fewer than two usable CLIs, say so: with only one responder there is nothing to reconcile.

## Running it

Always run it non-interactively (never the `tui` REPL). The synthesized answer
goes to **stdout**; progress goes to **stderr**, so capturing stdout gives you a
clean answer.

For anything you will parse yourself, use `--json`:

```bash
consensus --json "when should I choose a monorepo over a polyrepo?"
```

For a human-readable answer, drop `--json`:

```bash
consensus "review this rate-limiter design for race conditions"
```

Useful flags (all optional):

| Flag | Use |
| --- | --- |
| `-m, --model <spec>` | Pick the panel for this run; repeatable. `provider` or `provider:model` (e.g. `-m claude -m codex -m ollama:qwen3:8b`). Omit to use the configured/all-detected panel. |
| `-s, --synth <spec>` | Choose which model merges the answers (e.g. `-s codex`). |
| `-a, --all` | Also include every member's raw answer, not just the merge. |
| `--no-synth` | Skip synthesis; return the raw answers only (good for a spread of independent takes). |
| `-t, --timeout <sec>` | Per-member time limit (default 300). Lower it for quick checks. |
| `--cwd <path>` | Directory the member CLIs run in. Members pick up project context from here — set it to a repo to ask about that code, or to an empty/temp dir to keep them out of the current one. |
| `-f, --file <path>` | Read the prompt from a file instead of an argument. |
| `-o, --out <path>` | Also write a full markdown transcript. |

Piping works too: `cat spec.md | consensus` sends the piped text as the whole
prompt; `cat spec.md | consensus - "critique this"` adds an instruction.

Note: members run in the working directory and may write their own state there
(`.codegraph`, `.omo`, …). If that matters, pass `--cwd` to redirect them.

## Reading the `--json` result

```json
{
  "prompt": "…",
  "members": [
    { "member": "claude", "label": "claude", "ok": true,  "ms": 9500, "response": "…", "error": null },
    { "member": "gemini", "label": "gemini", "ok": false, "ms": 3900, "response": "",  "error": "auth error" }
  ],
  "synthesis": { "by": "claude", "ok": true, "text": "…the merged answer…", "error": null }
}
```

- **`synthesis.text`** is the canonical answer — lead with it.
- If `synthesis` is `null` (only one member succeeded), there was nothing to
  reconcile; use that member's `response` directly.
- The merged text may end with a **`Dissent:`** section (a specifically-argued
  minority view) or **`Unresolved:`** (the panel split with no majority). Always
  surface these — do not silently drop them; they are the main way a merged
  answer beats its sources.
- Report coverage honestly: mention how many members responded and name any that
  failed and why (`error`). A failed member is reported, not hidden.

## Exit codes

`consensus` exits non-zero only when **every** member fails or synthesis fails.
A partial panel (some members errored/timed out) still exits 0 with a valid
answer — so check the JSON, not just the exit code, to see who dropped out.
