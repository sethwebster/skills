# Create or recover a pull request

Use this workflow for `/upstream PR [title or flags]`.

1. Run the shared preflight. Refuse to target the upstream base branch itself or to include an unrelated dirty worktree.
2. Resolve the head branch and its writable fork owner. Confirm it has at least one commit not already in the upstream base and that every intended commit is pushed.
3. Search all PR states in the upstream repository for the exact head owner and branch. If an open or draft PR exists, return it and make no duplicate. If a closed or merged PR exists for the same head, show it and ask before opening a replacement.
4. Read the upstream PR template and repository instructions. Derive the title and body from the branch commits, diff, tests, and linked issue. Ask only for information that cannot be recovered. Never claim a test ran when it did not.
5. Include a checklist for remaining work and verification. Link issues with `Refs` by default. Use a closing keyword only when this PR fulfills the complete issue.
6. Create a draft PR by default. Create it ready only when the user explicitly supplies `--ready` and the implementation, required checks, adversarial review, and security review are already green.
7. Verify the resulting head, base, draft state, title, and URL with a fresh read. Return the exact URL.

Treat a supplied `--draft`, `--ready`, `--base`, title, or issue number as intent, then reconcile it with repository rules and discovered state. A force-push, merge, or branch deletion is outside this command.
