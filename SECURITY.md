# Security Policy

## 1. Honest Security Boundary Disclosure

> **无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流**  
> *(No OS-level kernel sandbox; relies on application-layer path confinement, Win32 Job Object process tree control, and approval workflows.)*

Muse-Win-Harness (MWH) is designed to run locally on Windows systems. Users must be explicitly aware of the following security model boundaries:
- **No Virtualized / Hypervisor Isolation**: MWH does not run processes inside a Hyper-V container, microVM, or AppContainer by default.
- **Path Confinement (Path Guard)**: Filesystem isolation is enforced at the application layer via realpath resolution (`fs.realpathSync.native`), NTFS Junction traversal checks, and sensitive directory blacklisting (`~/.ssh`, `~/.aws`, `%APPDATA%`, browser credentials, `.env` files).
- **Process Tree Control (Win32 Job Object)**: Child processes spawned by tool execution are bound to Windows Job Objects configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When a tool execution times out or is aborted, the entire child process tree is terminated.
- **Human-in-the-Loop & Mobile Approvals**: Sensitive and destructive operations trigger `CONFIRMATION_REQUIRED` state and require cryptographic HMAC approval, prohibiting unauthorized autonomous AI self-approval.

## 2. Secrets and Credentials Handling
- **Zero Hardcoded Secrets**: Under no circumstances should API keys, access tokens, webhook secrets, or tunnel credentials be committed to the repository or hardcoded in source files.
- **Environment and Config Injection**: All secrets must be injected dynamically via environment variables (e.g. `MWH_CF_TUNNEL_TOKEN`, `TUNNEL_RUNTIME_TOKEN`, `MWH_HMAC_SECRET`) or local untracked configuration (`config.yaml`).

## 3. Outbound SSRF Guard Rules
- All server-initiated outbound HTTP/HTTPS requests are strictly validated against Server-Side Request Forgery (SSRF) rules.
- Only `http:` and `https:` protocols are accepted.
- Requests targeting private, link-local, loopback, or unspecified IP ranges (e.g., `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `0.0.0.0`, `::1`, `fe80::/10`, `fc00::/7`, `localhost`) are denied unconditionally.

## 4. Reporting a Vulnerability
If you discover a security vulnerability within MWH, please report it responsibly:
- Open a [private GitHub security advisory](https://github.com/MatikaneMeika/muse-win-harness/security/advisories/new). Do not file a public issue for vulnerabilities.
- Please include reproduction steps, environment details, and proof-of-concept scripts.
- We aim to acknowledge reports within 48 hours and release fixes promptly.
