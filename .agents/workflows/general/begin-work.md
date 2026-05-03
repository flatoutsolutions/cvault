---
description: Start work on a Jira work item
---

# **Start Work on Jira Ticket**

# **Input**

**Jira Ticket Key:** `$ARGUMENTS`

If a ticket key is provided, use it and proceed to Step 1.

If no ticket key is provided:

1. Infer the Jira project key from the repository name
2. Search for unassigned, incomplete tickets ordered by priority
3. Present the top 3–5 options and ask the user to select one

---

# **Steps**

### **Get Current User Info**

Fetch the current user's account ID, name, and email from Atlassian. Store these for later steps.

### **Fetch and Review Ticket**

Retrieve the full ticket details including comments. Review:

- Summary, description, and acceptance criteria
- Current status, priority, and linked issues or parent epic
- Comments for additional context, requirements, or open questions

If comments raise questions or are unclear, ask for clarification before proceeding.

### **Create Feature Branch**

Create a local feature branch following the pattern `{TICKET-KEY}-{brief-description}`.

- **Default:** branch from `origin/main`, however the new feature branch MUST BY ALL MEANS track its own branch in origin, and ABSOLUTELY MUST NOT track the main branch!!!
- **Exception:** if this ticket depends on work from a previous branch in this conversation, offer to branch from that branch instead

**bash**Copy

```bash
git fetch origin
git checkout -b {TICKET-KEY}-{description} origin/main
```

### **Analyze Requirements and Plan**

Based on the ticket:

1. **List core requirements** from the description and acceptance criteria
2. **Right-sizing check** — Is this more than ~1 day of work? If yes, recommend promoting to an epic and splitting into smaller tickets
3. **Architecture check** — Does this affect architecture? If yes, remind the user to plan an architecture update and review
4. **Complexity/risk check** — Is this complex or high-risk? If yes, remind the user to align with the team lead or architect first
5. **Implementation plan** — Create a checklist of granular implementation steps and suggest a technical approach

Present this analysis to the user before continuing.

### **Create LaunchDarkly Feature Flag (If Needed)**

Only create a feature flag for **user-facing functionality changes**. Skip this step for infrastructure, config, CI/CD, documentation, refactoring, or other non-user-facing work.

If a flag is needed:

1. Determine the LaunchDarkly project key from existing flags or config files
2. Create a boolean feature flag:
   - **Flag name:** `{TICKET-KEY} {Ticket Summary}` (replace hyphens with underscores in the key portion)
   - **Flag key:** lowercase, underscore-separated version of the name
   - **Temporary:** yes
   - **Default state:** off
3. Configure environments:
   - **Production:** flag off for everyone
   - **Development:** flag off by default, but individually targeted **on** for the current user's email
4. Verify the flag was created correctly

If no flag is needed, note it in the summary and move on.

### **Update Jira**

Do exactly two things:

1. **Transition** the ticket to **In Progress**
2. **Assign** the ticket to the current user

### **8. Start the Application**

- Assume that the application is already running.
- Logs are in /logs.

---

# **Checklist**

After completing all steps, present this:

- [ ] Current user info fetched
- [ ] Workload checked (one-in-progress norm)
- [ ] Ticket fetched and reviewed
- [ ] Feature branch created locally
- [ ] Right-sizing, architecture, and risk assessed
- [ ] Implementation plan created
- [ ] Feature flag created (if user-facing change)
- [ ] Ticket moved to In Progress and assigned

---

# **Summary Format**

**plaintext**Copy

```
## 🎫 Ticket: {TICKET-KEY}
**Summary:** {ticket summary}
**Status:** In Progress ✅
**Assigned to:** {current user} ✅

## 📋 Analysis
- **Size:** {Small / Large — split needed?}
- **Architecture:** {Affected / Not affected}
- **Risk:** {Low / High — alignment needed?}

## 🚩 Feature Flag
- **Created:** {Yes / No — reason if skipped}
- **Flag key:** {flag-key}
- **Flag name:** {TICKET-KEY} {Ticket Summary}
- **Environments:** Off in production, on for current user in development

## 📝 Implementation Checklist
{granular steps}

## 🔧 Technical Approach
{suggested approach}

## 🌿 Branch
`{TICKET-KEY}-{description}` (local only)

## 🖥️ Application
- Backend: {status and port}
- Frontend: {status and port}

## ❓ Questions / Blockers
{any open items}
```

---

# **Notes**

- If any Jira API calls fail, communicate the issue clearly and suggest alternatives
- If the ticket description is vague, suggest what clarifications are needed before starting work
- Check for related tickets or dependencies worth reviewing
