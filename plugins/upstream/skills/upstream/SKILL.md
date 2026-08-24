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

With no command or an unknown command, show the three forms above and stop. Do not guess a mutation.

## Shared preflight

Before any route:

1. Find the repository root and inspect `git status`, existing worktrees, remotes, current branch, and the GitHub CLI authentication state. Preserve unrelated changes.
2. Resolve the upstream repository and its base branch. Prefer a configured `upstream` remote, then the parent of an `origin` fork, then `origin` when it is not a fork. The base is `main` unless the user or repository rules specify another branch. If `main` does not exist, use the upstream default branch and state why.
3. Resolve a writable push remote separately from the upstream repository. Prefer the user's fork at `origin`. Ask before creating a fork or changing a remote whose purpose is ambiguous.
4. Read every applicable `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*`, pull request template, issue template, and documented branch, worktree, test, commit, or review rule before making changes. Repository rules win over this skill's defaults.
5. Use `gh` with an explicit upstream repository for searches and mutations. Report a missing login, permissions failure, or ambiguous repository instead of operating on a guessed target.

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
