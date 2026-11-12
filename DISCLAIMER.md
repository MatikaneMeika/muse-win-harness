# Disclaimer & Interoperability Statement

**Muse-Win-Harness (MWH)** is an independent, community-driven, open-source local agent runtime and bridge.

## 1. Unofficial Interoperability
- **No Affiliation**: MWH is **not** affiliated with, sponsored by, or endorsed by `muse.ai` or its parent company/affiliates.
- **Architectural Separation**: MWH acts exclusively as a local harness providing standard agent host capabilities (process confinement, path fencing, approval workflows, and standard protocols).

## 2. Standard Protocol Boundary
- **Forward MCP & REST Only**: MWH strictly interacts via forward Model Context Protocol (`/mcp`) endpoints and standard REST Skill APIs (`/api/v1/*`).
- **No Cookie / Session Theft**: MWH never reads, accesses, modifies, stores, or transmits `muse.ai` browser cookies, session tokens, web credentials, or private internal endpoints.
- **No Reverse-Proxy `muse2api`**: MWH explicitly rejects and does not implement any reverse-proxy scraping or emulation wrappers (such as `muse2api`). All communications are routed through open and documented client/server interfaces.

---
*For legal or licensing inquiries, please refer to [LICENSE](LICENSE).*
