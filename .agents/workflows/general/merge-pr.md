---
description: Get a PR to merge, merge it and make sure the production deployment succeeds
---

# **Merge a Pull Request**

# **Input**

**PR Number:** `$ARGUMENTS`

---

# **Steps**

### **1. Determine the PR to Merge**

**If on a feature branch** (not `main`):

1. List open PRs for the current branch using `gh pr list --head <current-branch>`
2. **No PRs found** → Notify the user that no PR exists for this branch and ask if they want to create one.
3. **One PR found** → Use that PR. Proceed.
4. **Multiple PRs found** → Present the list and ask the user to pick one.

**If on `main`** (or not on a feature branch):

1. If a PR number was passed as `$ARGUMENTS`, use it. Proceed.
2. If no PR number was provided, ask the user which PR they want to merge.

Once the PR is identified, fetch its details (`gh pr view <PR> --json number,title,headRefName,baseRefName,state,statusCheckRollup`). Store the **head branch name** for subsequent steps.

### **2. Ensure the Branch Is Up-to-Date with Main**

Bring the latest `main` changes into the PR's head branch:

```bash
git fetch origin
git checkout <head-branch>
git rebase origin/main
```

- If there are **no new commits from main**, skip the push and proceed to Step 3.
- If there **are new commits** from main (rebase applied changes), push the updated branch:

```bash
git push --force-with-lease origin <head-branch>
```

- If the rebase has **conflicts**, resolve them. After resolving each conflicted file, `git add` the file and `git rebase --continue`. Once fully resolved, push with `--force-with-lease`.

### **3. Wait for the PR Build to Pass**

After pushing (or if a build is already running on the PR):

1. Poll the PR's check status using `gh pr checks <PR> --watch`
2. If all checks **pass** → Proceed to Step 4.
3. If any check **fails**:
   - Investigate the failure (view logs, reproduce locally)
   - Fix the issues on the head branch
   - Commit and push the fix (pre-commit hooks will run formatting, linting, building, and testing)
   - Also run integration tests if they are defined (`yarn test:integration`)
   - Return to the top of this step and wait for the new build

### **4. Code Review**

Review the diff of the PR compared to `main`:

```bash
gh pr diff <PR>
```

Look for:

- Bugs, logic errors, or edge cases
- Missing error handling
- Code style or readability issues
- Security concerns
- Performance issues
- Missing or incorrect types

**If issues are found:**

1. If already on the head branch → Make the fixes directly.
2. If NOT on the head branch → Ask the user to confirm switching to it, then check it out and make the fixes.
3. Commit the changes (pre-commit hooks will handle formatting, linting, building, and testing).
4. Run integration tests if defined (`yarn test:integration`).
5. Push the changes and return to **Step 3** to wait for the build again.

**If no issues are found** → Proceed to Step 5.

### **5. Wait for Final Build (If Changes Were Made)**

If any commits were pushed during Steps 2–4:

1. Wait for the PR build to pass using `gh pr checks <PR> --watch`
2. If the build **fails**, fix the issues and repeat from Step 3.
3. If the build **passes** → Proceed to Step 6.

If no additional commits were made since the last passing build, skip this step.

### **6. Get Final Approval and Merge**

1. Present a summary to the user:
   - PR title and number
   - Branch being merged
   - Build status
   - Any changes made during the process (rebases, fixes)
2. **Ask for the user's explicit approval to merge.**
3. Once approved, merge the PR:

```bash
gh pr merge <PR> --squash --delete-branch
```

### **7. Observe the Production Deployment**

After the merge:

1. Identify the production GitHub Actions workflow (e.g., `deploy`, `release`, `production`, or similar).
2. Watch the workflow run:

```bash
gh run list --branch main --limit 1
gh run watch <run-id>
```

3. If the production workflow **succeeds** → Proceed to Step 8.
4. If the production workflow **fails**:
   - Investigate the failure
   - Fix the issue (this will likely require a new branch, commit, and PR — coordinate with the user)
   - Ensure the fix is deployed successfully

### **8. Update Jira**

After a successful production deployment:

1. Extract the Jira ticket key from the PR title (e.g., `[TOWD-116]` → `TOWD-116`).
2. **Transition** the ticket to **Pending Acceptance** (NOT "Done" — the client needs to accept/verify the work first).

Do not add a Jira comment with the PR link. Jira auto-detects the PR from the ticket key in the PR title.

---

# **Checklist**

- [ ] PR identified
- [ ] Head branch rebased onto latest `main`
- [ ] PR build passing
- [ ] Code review completed
- [ ] All fixes committed and pushed (if any)
- [ ] Final build passing
- [ ] User approved the merge
- [ ] PR merged (squash + delete branch)
- [ ] Production deployment succeeded
- [ ] Jira ticket transitioned to Pending Acceptance

---

# **Summary Format**

```
## ✅ PR Merged

**PR:** #{number} — {title}
**Branch:** {head-branch} → main
**Merge Strategy:** Squash merge, branch deleted

## 🔨 Changes During Merge Process
- Rebased onto main: {Yes / No}
- Code review fixes: {Yes / No — brief description if yes}

## 🚀 Production Deployment
- **Status:** {Succeeded / Failed — details if failed}
- **Workflow Run:** {link}

## 🎫 Jira Updated
- **Ticket:** {TICKET-KEY}
- **Status:** Pending Acceptance ✅
```

---

# **Notes**

- Never merge without the user's explicit approval.
- Always use `--force-with-lease` instead of `--force` when pushing rebased branches.
- If any GitHub CLI commands fail, communicate the error clearly and suggest alternatives.
- Pre-commit hooks handle formatting, linting, building, and testing on every commit — do not skip them.
- After merging, always transition the Jira ticket to **Pending Acceptance**, never to "Done".
