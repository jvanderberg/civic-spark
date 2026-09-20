# Backend summary since 2026-09-20T01:06:08.172Z
- records: 11996
- http non-2xx: {'/api/workspaces/:id/sprite 429': 1, '/api/workspaces/:id/agent-git 423': 1, '/api/workspaces/:id/changes 423': 1, '/api/workspaces/:id/files 423': 1, '/api/workspaces/:id/team-status 423': 1, '/api/workspaces/:id/agent/prepare 502': 1}
- sprite command outcomes: {'ok': 2232, 'process_failed': 1}
- sprite operation non-ok: []
- command queueMs: {'max': 145, 'p95': 4, 'median': 2}; executionMs: {'max': 30042, 'p95': 227}; slowest http: 30054ms

## concurrent-20260919-p01
- result: {}
- requests: 532, non-2xx/3xx: 0
- sprite command queue ms max/p95: {'max': 76, 'p95': 4}; execution ms max/p95: {'max': 17225, 'p95': 212}
## concurrent-20260919-p02
- result: {}
- requests: 801, non-2xx/3xx: 0
- sprite command queue ms max/p95: {'max': 145, 'p95': 4}; execution ms max/p95: {'max': 18092, 'p95': 223}
## concurrent-20260919-p03
- result: {}
- requests: 1454, non-2xx/3xx: 5
  - 1 x POST /api/workspaces/14ca1093-dc60-4b8c-81c9-29eecd29c682/sprite -> 429
  - 1 x GET /api/workspaces/14ca1093-dc60-4b8c-81c9-29eecd29c682/agent-git -> 423
  - 1 x GET /api/workspaces/14ca1093-dc60-4b8c-81c9-29eecd29c682/changes -> 423
  - 1 x GET /api/workspaces/14ca1093-dc60-4b8c-81c9-29eecd29c682/files -> 423
  - 1 x GET /api/workspaces/14ca1093-dc60-4b8c-81c9-29eecd29c682/team-status -> 423
  - 2026-09-20T01:06:11.086Z 02-project-workspace POST /api/workspaces/14ca1093-dc60-4b8c-81c9-29eecd29c682/sprite 429 requestId=df9451d3-5445-4acd-a3d1-45889c832ba3: backend route /api/workspaces/:id/sprite status 429 in 10ms; commands=0 ops=[]
  - 2026-09-20T01:20:05.864Z 06-completion-loop GET /api/workspaces/14ca1093-dc60-4b8c-81c9-29eecd29c682/agent-git 423 requestId=0c1a3770-7fe0-4f8a-b1ae-760ee1ce9b81: backend route /api/workspaces/:id/agent-git status 423 in 6ms; commands=0 ops=[]
  - 2026-09-20T01:20:07.656Z 06-completion-loop GET /api/workspaces/14ca1093-dc60-4b8c-81c9-29eecd29c682/changes 423 requestId=5275e592-e4ab-433a-b9cc-6f21e67b18be: backend route /api/workspaces/:id/changes status 423 in 5ms; commands=0 ops=[]
  - 2026-09-20T01:20:07.699Z 06-completion-loop GET /api/workspaces/14ca1093-dc60-4b8c-81c9-29eecd29c682/files 423 requestId=29c69585-448a-4064-b420-cb97095b1b3d: backend route /api/workspaces/:id/files status 423 in 8ms; commands=0 ops=[]
  - 2026-09-20T01:20:08.292Z 06-completion-loop GET /api/workspaces/14ca1093-dc60-4b8c-81c9-29eecd29c682/team-status 423 requestId=1d94a6cc-924a-4f74-ba2f-86d147d7e1cd: backend route /api/workspaces/:id/team-status status 423 in 5ms; commands=0 ops=[]
- sprite command queue ms max/p95: {'max': 9, 'p95': 5}; execution ms max/p95: {'max': 19874, 'p95': 221}
## concurrent-20260919-p04
- result: {}
- requests: 728, non-2xx/3xx: 0
- sprite command queue ms max/p95: {'max': 9, 'p95': 4}; execution ms max/p95: {'max': 14761, 'p95': 197}
## concurrent-20260919-p05
- result: {}
- requests: 534, non-2xx/3xx: 0
- sprite command queue ms max/p95: {'max': 9, 'p95': 4}; execution ms max/p95: {'max': 19869, 'p95': 243}
