---
"knocoph": minor
---

Codebase Overview Tool

## What

Expose a single `codebase_overview` tool that returns a structural summary of the
entire indexed codebase from the DB. Replaces the need for an AI to call `query_architecture`
on every file just to orient itself in an unfamiliar project.
