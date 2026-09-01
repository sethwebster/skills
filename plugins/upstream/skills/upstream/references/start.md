# Start a contribution

Use this workflow for `/upstream start <description>`. The command is a terminal request: continue from discovery through the review-ready PR and bot-monitoring stop condition unless the user interrupts or a real permission or product-choice boundary blocks progress.

## 1. Find related upstream work

Require a useful description. If it is too thin to search or name the work, use `AskUserQuestion` for the missing outcome.

Search the upstream repository's open issues, then closed issues that may reveal a duplicate or prior decision. Use several compact searches based on exact phrases, important nouns, likely component names, and synonyms from the description. Rank candidates by title and body overlap, state, labels, recency, and whether the requested outcome matches.

For the strongest candidates, also check linked pull requests and open pull requests that mention the issue. Present the best few with number, title, state, URL, and a one-line reason. Use `AskUserQuestion` to choose one of these paths when a plausible match exists:

- attach the new work to an existing issue
- continue an existing writable pull request
- start anew

Recommend one choice based on the evidence. An open pull request owned by somebody else is not writable by default. Ask before building a competing PR or changing their branch.

If no candidate is credible, state that the search found no match and start anew. Starting anew does not create an issue unless the user asks or upstream rules require one. When the contributing guide requires an issue or discussion before a pull request, satisfy that requirement first and link what it produces.

When attaching to an issue, carry its acceptance criteria and constraints into the specification. Use `Refs #N` in the draft PR unless the agreed scope resolves the whole issue, in which case use the repository's closing convention.

Completion criterion: the run has one agreed work item and no known duplicate PR.

## 2. Specify the work

Call the Skill tool with `grilling`. Give it the user's description, the selected issue and discussion, repository rules, relevant code or architecture evidence, and any linked pull request context. Tell it to use `AskUserQuestion` where available.

The interview must settle:

- intended user-visible outcome and definition of done
- scope and explicit non-goals
- compatibility, migration, and failure behavior
- design choices that affect the public interface or maintainers
- verification evidence and security implications
- phases small enough to commit independently

Continue until the user agrees to a concrete plan. Record unresolved facts as investigation tasks, not invented decisions.

Completion criterion: the user has agreed to a plan whose checklist items each have an observable completion condition.

## 3. Create the worktree and branch

Fetch the upstream base and create a new worktree at that fetched commit. Follow repository naming and worktree-location rules. Otherwise:

- derive a short lowercase hyphenated slug from the agreed title
- name the branch with the configured `rules.branchPrefix` (default `upstream/`) plus the slug
- put the worktree in a non-conflicting sibling path from the configured `rules.worktreePattern` (default `<repo>-<slug>`)

Check local branches, remote branches, and registered worktrees for collisions before creation. Never reuse a dirty worktree. Set the branch to push to the writable fork while the pull request targets the upstream base.

Completion criterion: the new worktree is clean, its `HEAD` descends from the fetched upstream base, and its branch and push target are explicit.

## 4. Open the draft pull request

Build the PR body from the upstream template, adding these sections when the template does not already cover them:

- goal and linked issue
- scope and non-goals
- decisions made during specification
- phased implementation checklist
- verification checklist
- security and compatibility notes
- deviations log, initially `None`

The checklist is the plan of record. Each item should name a deliverable and its evidence. Keep it current after every unit of work. Preserve new sections added by people or bots.

A pull request needs a head commit. Prefer an empty kickoff commit with a repository-compliant subject and body that points to the first plan item, then push it. If the Git host refuses a tree-identical kickoff commit, complete the smallest first checklist item, commit and push it, and open the draft immediately before doing more work.

Before creation, search all PR states for the exact head owner and branch. Reuse an open or draft PR. If the same head already has a closed or merged PR, ask before creating a replacement. Create the PR as a draft against the upstream base. Do not put `Draft` in its title.

Completion criterion: one draft PR exists, its body contains the agreed checklist, and the returned URL targets the resolved upstream repository and base.

## 5. Execute the plan

Work from the draft PR checklist. For each smallest coherent unit:

1. Implement only the current item and its necessary tests.
2. Run the narrowest meaningful verification, then any repository-required gate.
3. Review the diff for accidental files, unrelated formatting, generated output, and secrets.
4. Commit with a focused subject, following the contributing guide's message convention and adding any required sign-off or changelog entry. In the commit body, name the checklist item, summarize the change, and record any difference from the plan.
5. Push the commit to the writable fork.
6. Read-modify-write the PR body to check completed items and append material deviations or newly agreed work.

Do not combine unrelated checklist items to reduce commit count. If evidence invalidates the plan, pause implementation, update the specification with the user, then update the PR before continuing.

Completion criterion: every implementation and verification item is checked, every commit is pushed, and the worktree is clean.

## 6. Run fresh reviews until green

Run two fresh-context subagents in parallel. Do not fork the implementation conversation into them.

- The adversarial reviewer gets the upstream issue or agreed specification, repository rules, PR body, base and head SHAs, and the diff. Ask it to find correctness errors, missing scope, regressions, weak tests, and repository-rule violations. Require file and line evidence for every finding.
- The security reviewer gets repository security guidance, threat-relevant architecture, dependency changes, base and head SHAs, and the diff. Ask it to inspect trust boundaries, input handling, authentication and authorization, secret exposure, injection, unsafe defaults, dependency risk, and abuse cases relevant to the change. Require file and line evidence or a concrete exploit path.

Keep their context independent and do not provide the implementation author's reasoning or conclusions. Triage every finding. Fix actionable findings as new checklist-linked commits, push them, update the PR, and rerun the affected verification. Repeat fresh reviews after material fixes until both reviewers report no actionable findings and all required checks pass.

Completion criterion: both fresh reviews are green, required tests and checks pass, no checklist item is open, and no unresolved finding remains.

## 7. Mark ready and monitor automation

Mark the PR ready for review only after the prior completion criterion passes. Capture a baseline of reviews, review comments, issue comments on the PR, and status checks.

Monitoring cadence comes from the project config's `rules.monitor` (see [config.md](config.md)): poll every `pollMinutes` (default five) and settle after `settleCycles` consecutive quiet polls (default six). When `settleCycles` is `0`, skip polling entirely: report the baseline and stop here. If the user asks for a different cadence for this repository, persist it to the config before continuing.

Use the environment's recurring monitor or scheduled wake-up when available. Otherwise run a background polling loop. Poll exactly at the configured interval. At each cycle, compare stable IDs, timestamps, authors, and check conclusions with the last snapshot. New automated feedback includes:

- a new review or comment from a GitHub App or an author whose login ends in `[bot]`
- a status check that newly becomes failed, cancelled, timed out, or action required

When new feedback arrives, reset the no-feedback counter to zero. Read the full feedback, decide whether it applies, and address actionable items with the same test, commit, push, and PR-checklist discipline. Explain a rejected suggestion with evidence in the relevant thread when possible. Rerun affected review and security gates after a material change.

Increment the counter only when a scheduled poll finds no new automated feedback. Stop after the configured number of consecutive no-feedback cycles. Also stop for a permission block or a user interruption. Do not merge the PR.

At the end, report the PR URL, linked issue, branch and worktree, checks run, review result, bot feedback handled, and why monitoring stopped. Report pending checks honestly if the settle limit expires first.
