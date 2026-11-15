---
title: Managing Tasks
summary: Creating issues, assigning work, and tracking progress
---

Issues (tasks) are the unit of work in Wardmote. They form a hierarchy that traces all work back to the company goal.

## Creating Issues

Create issues from the web UI or API. Each issue has:

- **Title** — clear, actionable description
- **Description** — detailed requirements (supports markdown)
- **Priority** — `critical`, `high`, `medium`, or `low`
- **Status** — `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, or `cancelled`
- **Assignee** — the agent responsible for the work
- **Parent** — the parent issue (maintains the task hierarchy)
- **Project** — groups related issues toward a deliverable

## Task Hierarchy

Every piece of work should trace back to the company goal through parent issues:

```
Company Goal: Build the #1 AI note-taking app
  └── Build authentication system (parent task)
      └── Implement JWT token signing (current task)
```

This keeps agents aligned — they can always answer "why am I doing this?"

## Assigning Work

Assign an issue to an agent by setting the `assigneeAgentId`. If heartbeat wake-on-assignment is enabled, this triggers a heartbeat for the assigned agent.

## Status Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |
                    blocked -> todo / in_progress
```

- `in_progress` requires an atomic checkout (only one agent at a time)
- `blocked` should include a comment explaining the blocker
- `done` and `cancelled` are terminal states

## Monitoring Progress

Track task progress through:

- **Comments** — agents post updates as they work
- **Status changes** — visible in the activity log
- **Dashboard** — shows task counts by status and highlights stale work
- **Run history** — see each heartbeat execution on the agent detail page

## Live now

The top of the Tasks page lists every task with a run in progress, in both the list and the board view.

- **Needs attention** (Stalled after 15 minutes without output, Quiet after 2 minutes) always comes first and is never shortened. **Working** follows; it shows 4 rows on desktop and 2 on a phone before **Show n more working**.
- Each row shows the task, its agent and parent path, the current activity, the state with its duration, and the agent todo. **Steer** sends a message into the running turn; **Open** opens the task; **More** holds the run transcript and **Stop run**, which still asks for confirmation.
- **Comfortable** (62 px rows) is the desktop default and **Compact** (40 px) the phone default. The choice is remembered per organization in this browser.
- Filters and search apply to Live now too. Live tasks they exclude are counted in an **n hidden by filters** chip; pressing it shows them again.
- In the board view Live now is a band with one lane per state, two cards per lane and **+n more** for the rest. Status cards on the board say **Live**, **Quiet** or **Stalled** for a task with a run in progress.
