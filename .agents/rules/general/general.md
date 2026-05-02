---
trigger: always_on
---

# Roles and Responsibilities

You are here to do the work, all of it. Do not tell me what to do unless it is something you can absolutely not do by yourself. As an example, do not tell me to run commands in the command line that you can run by yourself.

# Persistence and perseverance

If something doesn't work right away, don't give up and definitely don't remove features if they don't work. If something doesn't work that I asked you to do, then you're going to take every action possible to make it work and you're not going to just give up and go the lazy route. If you need my input, I'm happy to help. If I need to authenticate with something or provide more information, ask me. But we do not give up or abort or even remove functionality just because it doesn't work at the first attempt. We persevere and we get done what we initially set out to do.

# Git

- NEVER EVER push to the Git main branch without my approval!!!
- When creating a feature branch, make sure that that feature branch absolutely does not track the origin main branch, because that is outrageously dangerous. A feature branch ALWAYS needs to have its own tracking branch!
- DO NOT use "git commit --no-verify" as that defeats the purpose of pre-commit hooks!!!

# CLI Credentials

Use the credentials in .vscode/settings.json.

# Browser

DO NOT attempt to use your browser to do something that you can do using a CLI tool. E.g. do not access github.com in the browser when you have the GitHub CLI (gh) available!!!
Also do not attempt to use thw browser to do something that you could do using an MCP Server!!!

# MCP vs. CLI

Whenever you have the choice between an MCP server and a CLI, always use the MCP server unless it does not provide a tool that does what the CLI does. In that case, you are allowed to use the CLI but always prefer the MCP server.

# REST API Design

Follow proper REST API design. Examples:
BAD DESIGN: GET /events/list --> GOOD DESIGN: GET /events
BAD DESIGN: POST /events/delete --> GOOD DESIGN: DELETE /events/{eventId}

# Package Manager

Use yarn as the package manager, not npm.

# Pulumi

NEVER EVER run `pulumi up --yes`!!!

# AWS

- We use AWS SSO via `aws configure sso`. Use the AWS_PROFILE defined in .vscode/settings.json.
- If the AWS session is expired, don't give up or find workarounds but simply run `aws sso login`.

# Deployment

NEVER EVER deploy to production from local!!!

# Security

Do not put any passwords or API tokens or any credentials of any form in any plain text files and definitely don't commit and push them to Git.

# Markdown files

Do not create Markdown files when you are done, unless you are specifically asked to do so.
