---
description: Complete work on a Jira work item
---

# **Complete Work and Create PR**

# **Input**

**Reviewer Name:** `$ARGUMENTS`

If no reviewer name is provided, ask the user which team member should review this.

---

# **Steps**

### **1. Identify Context**

- **Reviewer:** Use the provided name or ask the user.
- **Jira Ticket (required):** Extract the ticket key from the current branch name (e.g., `PROJ-123-desc` → `PROJ-123`). If not found, ask the user. Do not proceed without a ticket key.
- **Current User:** Fetch your Atlassian account details.
- **Reviewer Account:** Look up the reviewer's Jira account ID by name. If multiple results are found, ask the user to confirm.

### **2. Clean Up Temporary Files**

Before committing, check for temporary files created during development (one-off scripts, test data generators, debug logs).

- List untracked or modified files that look temporary
- Ask the user if any should be deleted
- Ensure no temporary files are staged for commit

### **3. Format, Lint, and Build**

Only run these for **components that actually changed**.

1. Run `git status --short` and map changed file paths to their components
2. For each affected component, run its format, lint, and build commands
3. Skip components with no changes
4. Verify all commands succeed before continuing

### **4. Commit Changes**

Only commit files that were changed by the AI in the current session.

1. Review the conversation to identify which files the AI edited
2. Stage only those files using explicit paths — never use `git add -A` or `git add .`
3. Verify staged files with `git diff --cached --name-only` and unstage anything unexpected
4. Auto-generate a commit message (e.g., `feat: implement {feature}`)
5. If **no actual code files** changed (only docs, config, `.cursor/`), append `[skip ci]` to the commit message
6. Commit

If unsure which files to stage, ask the user to confirm before committing.

### **5. Push to Remote**

**bash**Copy

```bash
git push -u origin HEAD
```

If the push fails due to remote changes, fetch and rebase first, then push normally.

### **6. Create Pull Request**

### **PR Title**

The PR title becomes the **squash merge commit message**. Format it as:

**plaintext**Copy

```
{type}({domain}): {Story Title} [{TICKET-KEY}]
```

- **Type:** Determine from the changes (`feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`). If unclear, ask the user.
- **Domain:** Infer from changed file paths (e.g., `convex/towbook/` → `towbook`, `convex/sms/` → `sms`, `frontend/` → `ui`, `.github/` → `ci`). If unclear, ask the user.
- **Story Title:** The Jira ticket summary.
- **Ticket Key:** In square brackets — this is how Jira auto-detects the PR.

Example: `feat(goals): I want to create a goal. [PROJ-255]`

### **PR Body**

1. Read the PR template from `.github/PULL_REQUEST_TEMPLATE.md`
2. Fill in the `Jira:` line with `{TICKET-KEY} - {Ticket Summary}`
3. Keep all other sections of the template intact

### **Create the PR**

- Use the formatted title and filled template body
- Assign to yourself
- Request the reviewer
- Base branch: `main`

You may need to ask for the reviewer's GitHub username if it differs from their name.

### **7. Update Jira**

Do exactly two things:

1. **Transition** the ticket to **Internal Review**
2. **Assign** the ticket to the reviewer

Do not add a Jira comment with the PR link. Jira auto-detects the PR from the ticket key in the PR title.

### **8. Handle Stacked PRs (If Applicable)**

If this PR is based on another PR branch rather than `main`:

1. Identify the base PR and branch
2. Construct a GitHub compare URL between the base branch and this branch
3. Append a "Stacked PR Diff" section to the PR body with the compare link
4. Update the PR description while preserving the template structure

---

# **Checklist**

- [ ] Context identified (reviewer, ticket, current user)
- [ ] Temporary files cleaned up or excluded
- [ ] Changed components formatted, linted, and built
- [ ] Only AI-session-changed files staged and committed
- [ ] `[skip ci]` included if no code changes
- [ ] Pushed to remote
- [ ] PR title follows `{type}({domain}): {Story Title} [{TICKET-KEY}]`
- [ ] PR body uses template from `.github/PULL_REQUEST_TEMPLATE.md`
- [ ] PR created, assigned, and reviewer requested
- [ ] Jira ticket moved to Internal Review
- [ ] Jira ticket assigned to reviewer
- [ ] Stacked PR diff added (if applicable)

---

# **Summary Format**

**plaintext**Copy

```
## 🚀 Work Completed

**PR:** {PR link}
**Title:** {type}({domain}): {Story Title} [{TICKET-KEY}]
**Reviewer:** {Reviewer Name} requested

## 🎫 Jira Updated
**Ticket:** {TICKET-KEY}
**Status:** Internal Review ✅
**Assigned to:** {Reviewer Name} ✅
**PR Linking:** Automatic via ticket key in PR title
```

---

# **Notes**

- Never merge the PR — it must remain open for review
- If any API calls fail, communicate the issue and suggest alternatives
- If the reviewer's GitHub username can't be determined, ask the user
