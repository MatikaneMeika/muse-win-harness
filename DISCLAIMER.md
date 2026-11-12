# Disclaimer, Interoperability & Vibe Coding Statement

**Muse-Win-Harness (MWH)** is an independent, community-driven, open-source local agent runtime and desktop companion shell for Windows 10/11.

## 1. Unofficial Interoperability
- **No Affiliation**: MWH is **not** affiliated with, sponsored by, or endorsed by `muse.ai` or Meta Platforms, Inc.
- **Architectural Separation**: MWH acts exclusively as a local companion harness on your PC, providing standard agent host capabilities (workspace path fencing, process tree management, pre-write snapshots, and human-in-the-loop desktop approvals).

## 2. Standard Protocol Boundary
- **Forward MCP & REST Only**: MWH strictly interacts via standard Model Context Protocol (`/mcp`) endpoints and documented REST Skill APIs (`/api/v1/*`).
- **No Cookie / Session Theft**: MWH never reads, accesses, modifies, stores, or transmits `muse.ai` browser cookies, session tokens, web credentials, or private internal endpoints.
- **No Reverse-Proxy `muse2api`**: MWH explicitly rejects and does not implement any reverse-proxy scraping or unofficial API emulation wrappers (such as `muse2api`). All communications flow through open, user-configured client/server connectors.

## 3. Vibe Coding & AI-Assisted Development Disclosure (AI 辅助开发声明)
- **Origin & Engineering Process**: This project originated from **vibe coding and AI-assisted iterative development**—architected, implemented, debugged, and refined through human-AI collaboration with coding agents and large language models.
- **Use at Your Own Risk ("AS IS")**: Although core safety paths (path confinement, Win32 Job Object termination, pre-write Git Shadow snapshots, and HMAC approval gates) are checked by automated verification suites (`gate1`–`gate5` and negative security tests), **AI-assisted code and application-layer guardrails are not a substitute for an OS-kernel sandbox and may still contain unforeseen bugs or edge cases**.
- **User Responsibility**: Always review commands before approving them on the floating island, keep independent backups of critical data, and read [`docs/SECURITY_DISCLOSURE.md`](./docs/SECURITY_DISCLOSURE.md) before enabling `autonomous` or `full-access` modes.

---
*For legal or licensing terms, please refer to [LICENSE](./LICENSE).*
