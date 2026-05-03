---
trigger: always_on
---

DO NOT COMMIT BY YOURSELF WITHOUT MY APPROVAL!!!

# Commits on main branch

For all commits on the main branch, use conventional commits in the following format:
<TYPE>(<CONTEXT>): <SUMMARY> [JIRAKEY]
e.g.: feature(trucks): The dispatcher needs to know about trucks and driver-truck assignments. [TOWD-5]

# Commits on feature branches

For all commits on feature branches, just write a one-liner summary and don't write a whole novel. Nobody needs that because we squash-merge our PRs and therefore, those commit messages will never make it to the main branch.

# Pre-commit hooks

Before committing, you don't need to format, lint, build or test because we have pre-commit hooks that do that automatically.
