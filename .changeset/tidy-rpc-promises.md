---
"miniflare": patch
---

Fix Workflow creation deadlocking when called through a synchronous Node.js RPC proxy

Workflow storage bookkeeping uses workerd's disk service instead of making a request back to Node.js. This fixes Workflow creation through Wrangler's `createTestHarness().getWorker().getExport()` API without changing RPC return values, factories, or errors exposed by Miniflare and `getPlatformProxy()`. Workflow deletion continues to serialize pending deletions and wait for SQLite cleanup before reusing an instance ID.
