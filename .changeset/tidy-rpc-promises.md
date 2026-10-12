---
"miniflare": patch
---

Fix Workflow creation on the first call through the platform proxy or test harness

Workflow storage cleanup no longer blocks the first Workflow creation through the platform proxy or test harness. RPC return values, factories, and errors remain unchanged, and deletion still waits for SQLite cleanup before reusing an instance ID.
