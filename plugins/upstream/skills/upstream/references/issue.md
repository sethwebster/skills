# Work with upstream issues

Use this workflow for `/upstream issue <command> [arguments]`. Always operate on the resolved upstream repository, not the user's fork.

## Read routes

- `list`: list issues using any supplied state, label, assignee, or search filters.
- `view <number-or-url>`: show the issue and relevant linked pull requests.
- `search <query>`: search open and closed issues. Use title, body, synonym, and component variants when the query describes a possible duplicate.
- `status <number-or-url>`: summarize state, assignees, labels, milestone, linked pull requests, and recent discussion.

## Mutation routes

- `create <description>`: read repository issue templates and contribution rules. Fuzzy-search open and closed issues first. Show plausible duplicates and use `AskUserQuestion` to attach to one or continue creating. Build the title and body from the matching template, collect missing required fields, then create through a body file. Apply only labels, assignees, projects, or milestones that exist and were requested or required.
- `update|edit <number-or-url> <changes>`: fetch the current issue first. Apply only the requested fields. For body edits, use read-modify-write and preserve content outside the requested section.
- `comment <number-or-url> <text>`: fetch enough context to ensure the comment is going to the intended issue, then post it through a body file.
- `close <number-or-url> [reason]`: the explicit `close` token authorizes closing that issue. Confirm its identity and current state first. Add the supplied reason without inventing one.
- `reopen <number-or-url> [reason]`: confirm the issue is closed, reopen it, and add the supplied reason when present.

For another `gh issue` operation, inspect the installed CLI help and classify it as read-only or mutating. Explain an unknown mutating operation before running it. Never treat arbitrary trailing text as shell syntax or pass it through `eval`.

After a mutation, read the issue back and report its number, title, state, and exact URL. Creating an issue does not start the full worktree and PR lifecycle unless the user also invokes `/upstream start`.
