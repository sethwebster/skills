# skills

Claude Code plugin marketplace for my agent skills.

## Use

```
/plugin marketplace add sethwebster/skills
/plugin install consensus@skills
```

Or install the skill with the open skills CLI:

```bash
npx skills add sethwebster/skills --skill consensus
```

## Plugins

| Plugin | Description |
| --- | --- |
| [dispatch](./plugins/dispatch) | Delegate remote work and collect a verified result, or use `--pass` to hand over the full task and workspace after a signed receiver acknowledgment. |
| [upstream](./plugins/upstream) | Run issue-linked upstream work in an isolated worktree, from specification and draft PR through small commits, independent reviews, and bot-feedback monitoring. |
| [consensus](./plugins/consensus) | Ask multiple AI model CLIs one question in parallel, then synthesize a canonical answer with dissent surfaced. |

## Maintenance

Plugins are vendored under `plugins/<name>/`. Copy updated skills and scripts here, then bump the version in both `plugin.json` and `marketplace.json` when releasing. Keep evaluation fixtures in the source project rather than shipping them.
