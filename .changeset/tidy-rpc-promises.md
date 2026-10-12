---
"miniflare": patch
---

Fix Workflow creation hanging on the first call through the platform proxy or test harness

Workflow storage cleanup no longer needs a request back to Node.js, which could hang the first Workflow creation through `getPlatformProxy()` or `createTestHarness()`. RPC return values, factories, and errors remain unchanged, and deletion still finishes SQLite cleanup before reusing an instance ID.
