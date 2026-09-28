---
description: Test project-local slash command — report task/inbox/routine counts for npi-deck itself
---
You are running in the npi-deck workspace. Hit:

1. `curl -s http://127.0.0.1:1701/api/tasks` — report counts per state.
2. `curl -s http://127.0.0.1:1701/api/inbox?includeProcessed=0` — count unprocessed by kind.
3. `curl -s http://127.0.0.1:1701/api/routines` — report enabled count.

End with: "All systems nominal." or the first problem you spot.
