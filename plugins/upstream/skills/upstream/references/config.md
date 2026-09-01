# Project configuration

`/upstream` keeps per-repository state in `.claude/upstream.json` at the root of the checkout the command was invoked from. It never lives in a contribution worktree and must never appear in a contribution commit.

The file has two top-level objects with different authority:

- `cache`: facts a previous run resolved. They seed preflight so the run skips re-deriving or re-asking, but each is verified cheaply before use and corrected in place when the repository has changed.
- `rules`: the user's standing choices for how this skill behaves in this repository. They override the skill's workflow defaults.

## Precedence

For any decision, apply in order:

1. an explicit user instruction in this run
2. upstream repository requirements: contributing guide, templates, documented conventions
3. `rules` from this file
4. this skill's defaults

`cache` never wins an argument; it only makes resolution faster.

## Keys

All keys are optional. Preserve keys you do not recognize.

```json
{
  "cache": {
    "upstreamRepo": "owner/name",
    "baseBranch": "main",
    "pushRemote": "origin",
    "pushOwner": "login",
    "contributingGuide": "path or URL, or \"none\" when a prior run confirmed no guide exists"
  },
  "rules": {
    "monitor": {
      "pollMinutes": 5,
      "settleCycles": 6
    },
    "branchPrefix": "upstream/",
    "worktreePattern": "<repo>-<slug>"
  }
}
```

- `monitor.pollMinutes`: minutes between monitoring polls after a PR is marked ready. Default 5.
- `monitor.settleCycles`: consecutive no-feedback polls before monitoring stops. Default 6. `0` means do not poll at all: capture the baseline, report, and stop as soon as the PR is ready.
- `branchPrefix`: prefix for generated contribution branch names. Default `upstream/`.
- `worktreePattern`: sibling-directory naming for new worktrees, with `<repo>` and `<slug>` placeholders. Default `<repo>-<slug>`.

## Writing the file

Every route may write it, with read-modify-write edits that preserve unrecognized keys:

- At the end of preflight, persist newly resolved `cache` identities, especially answers the user gave to a disambiguation question, so later runs do not re-ask.
- When the user states a durable preference during any run — "don't wait five cycles here", "always push to my fork" — persist it under `rules` immediately and confirm the saved key and value. A preference scoped to "this time" is not durable; follow it without saving.
- When a cached fact proves wrong, correct or remove it in the same run.

Create `.claude/` and the file on first write. If `.claude/upstream.json` is not ignored and not tracked, leave it untracked; never stage it into contribution work.

## The `config` subcommand

`/upstream config [set <key> <value> | unset <key>]`

- No arguments: print the file path, the effective configuration with defaults merged, and which values come from the file versus defaults.
- `set <key> <value>`: dotted path under `cache` or `rules`, for example `rules.monitor.settleCycles 0`. Coerce obvious numbers and booleans; store everything else as a string. Report the resulting value.
- `unset <key>`: remove the key; empty parents may be pruned.
- Anything else: show these forms and stop. Do not guess a mutation.
