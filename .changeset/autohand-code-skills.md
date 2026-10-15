---
"wrangler": patch
---

Include Autohand Code CLI in Cloudflare skills installation and updates

Update the Rosie agent registry so Wrangler detects Autohand Code CLI and installs Cloudflare skills into `~/.autohand/skills`. If Wrangler already installed skills for other agents, run `wrangler --install-skills` to discover Autohand. Once registered, Autohand is included in the usual skills update flow.
