---
name: upstream
description: Run an upstream issue, pull request, or complete contribution workflow.
argument-hint: "<start|PR|issue> [arguments]"
disable-model-invocation: true
---

# Upstream

Work against the repository's upstream project without mixing contribution work into the current checkout. `$ARGUMENTS` contains the command. Dispatch on its first token, case-insensitively:

- `start <description>`: read [references/start.md](references/start.md), then own the contribution through its terminal monitoring condition.
- `PR [title or flags]`: read [references/pr.md](references/pr.md) and create or recover the pull request for the current branch.
- `issue <command> [arguments]`: read [references/issue.md](references/issue.md) and run that issue operation against the upstream repository.
- `config [set <key> <value> | unset <key>]`: read [references/config.md](references/config.md) and show or edit this repository's saved configuration.

With no command or an unknown command, show the four forms above and stop. Do not guess a mutation.

## Shared preflight

Before any route:

1. Find the repository root and inspect `git status`, existing worktrees, remotes, current branch, and the GitHub CLI authentication state. Preserve unrelated changes.
2. Load `.claude/upstream.json` from the repository root when it exists, per [references/config.md](references/config.md). Its `cache` seeds the resolution steps below after a cheap verification against current remotes, and its `rules` override this skill's workflow defaults. Precedence: an explicit user instruction, then upstream repository requirements, then `rules`, then skill defaults.
3. Resolve the upstream repository and its base branch. Prefer a configured `upstream` remote, then the parent of an `origin` fork, then `origin` when it is not a fork. The base is `main` unless the user or repository rules specify another branch. If `main` does not exist, use the upstream default branch and state why.
4. Resolve a writable push remote separately from the upstream repository. Prefer the user's fork at `origin`. Ask before creating a fork or changing a remote whose purpose is ambiguous.
5. Locate the upstream contributing guide before making changes. Check the repository root, `.github/`, and `docs/` for `CONTRIBUTING`, `CONTRIB`, and `CONTRIBUTE` under any extension, and follow a stub that points elsewhere. Read it from the resolved upstream repository at its base branch, not only from the local checkout, because a fork or stale branch may lack the current guide.
6. Read every other applicable `AGENTS.md`, `CLAUDE.md`, code of conduct, pull request template, issue template, and documented branch, worktree, test, commit, or review rule. Repository rules win over this skill's defaults.
7. Extract the contributing guide's operative requirements and carry them into the run: issue-first or discussion-first policy, CLA or DCO sign-off, branch naming, commit message and changelog conventions, required tests, lint and formatting gates, review expectations, and how to submit. Follow them over this skill's defaults, and say which requirement you are following when the two disagree. State the absence explicitly when no guide exists, and fall back to observed repository convention.
8. Use `gh` with an explicit upstream repository for searches and mutations. Report a missing login, permissions failure, or ambiguous repository instead of operating on a guessed target.
9. Persist what preflight resolved — upstream repository, base branch, push remote and owner, contributing guide location — to the config's `cache` per [references/config.md](references/config.md), and persist any durable preference the user states during the run to its `rules`.

Keep these identities distinct throughout the run:

- upstream repository and base branch
- writable fork and push remote
- local worktree path and branch
- linked issue, if any
- pull request number and URL

## Mutation rules

- The explicit subcommand authorizes the mutations inherent in that route. It does not authorize force-pushes, rewriting shared history, merging, deleting branches or worktrees, creating a fork, or closing unrelated issues.
- Create command bodies through files or safely quoted API input. Never put untrusted issue or PR text into an executable shell string.
- Query before creating. An existing open PR for the same head branch is the result, not a reason to create another one. A plausible duplicate issue must be shown before issue creation.
- Preserve repository templates and sections you do not own. Update a PR body with read-modify-write edits rather than replacing later human or bot additions.
- Return the exact issue or PR URL after an external mutation.
- `.claude/upstream.json` is local project state. Edit it read-modify-write, preserve unrecognized keys, and never stage or commit it into contribution work.
