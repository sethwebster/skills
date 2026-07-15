# skills

Claude Code plugin marketplace for my agent skills.

## Use

```
/plugin marketplace add sethwebster/skills
/plugin install baton@skills
```

## Plugins

| Plugin | Description |
| --- | --- |
| [baton](./plugins/baton) | Verified session/workspace handoff between agents across machines — file parity first, agent launch second, receiver ack third, sender release last. |
| [dispatch](./plugins/dispatch) | Delegate a scoped task to a remote agent over SSH and get the verified result back — authenticated handshake, right-sized context, HMAC-signed heartbeats, verified-before-integration. You stay the orchestrator. |

## Maintenance

Plugins are vendored under `plugins/<name>/`. Each plugin's source of truth lives in its own project (baton: `ai-projects/handoff`); copy updated `SKILL.md`/`scripts` here and bump the version in both `plugin.json` and `marketplace.json` when releasing. `evals/` stays in the source project — never ship it.
