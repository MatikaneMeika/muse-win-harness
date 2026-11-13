/**
 * Dual-Protocol Gateway & HTTP Server
 * Exposes Streamable HTTP MCP (/mcp), REST Skill API (/api/v1/*),
 * and Mobile One-Time HMAC Approval Pages (/approve/:approvalId).
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PipelineKernel } from '../pipeline/pipeline.js';
import { getExposedMuseTools, type ToolDefinition } from '../tools/definitions.js';
import { getResourcesManager } from '../resources/manager.js';
import { BearerAuthGuard } from './authGuard.js';
import { MwhControlPlane } from './stateManager.js';
import { QuickTunnelDriver, NamedTunnelDriver, assertTokenEntropy, validateServerBindSecurity } from './tunnels.js';
import { UiStaticHost, boundedMcpSessionId, mintUiSessionCookie, readCookie, uiSessionMatches } from './uiStatic.js';

export interface ServerOptions {
  host?: string;
  port?: number;
  runtimeToken: string;
  /** Optional epoch timestamp (ms) when `runtimeToken` expires. */
  tokenExpiresAt?: number;
  kernel?: PipelineKernel;
  /** config.yaml `tunnel.cloudflaredPath`, forwarded to the control plane. */
  cloudflaredPath?: string;
}

export class MwhServer {
  private server: http.Server | null = null;
  private kernel: PipelineKernel;
  private authGuard: BearerAuthGuard;
  private runtimeToken: string;
  private host: string;
  private port: number;
  private controlPlane: MwhControlPlane;
  private uiHost: UiStaticHost;
  // In-memory rate limiting for the /approve/ endpoint: POST attempt timestamps
  // per approvalId (attempts older than 60s are pruned on access).
  private approvalPostAttempts: Map<string, number[]> = new Map();
  private shutdownHandler: (() => void) | null = null;
  /** Long-lived /mcp GET streams that can receive tools/list_changed. */
  private mcpEventStreams: Set<http.ServerResponse> = new Set();
  private unsubResourceChanges: (() => void) | null = null;

  constructor(options: ServerOptions) {
    this.runtimeToken = options.runtimeToken;
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 19820;
    this.kernel = options.kernel || new PipelineKernel();
    this.authGuard = new BearerAuthGuard(this.runtimeToken, options.tokenExpiresAt);
    this.uiHost = new UiStaticHost();
    this.controlPlane = new MwhControlPlane({
      kernel: this.kernel,
      authGuard: this.authGuard,
      getRuntimeToken: () => this.runtimeToken,
      setRuntimeToken: (token) => {
        this.runtimeToken = token;
      },
      port: this.port,
      host: this.host,
      cloudflaredPath: options.cloudflaredPath
    });
    // Switching a resource on/off must reach already-connected Muse sessions when
    // the transport allows a notification; the tools/list content is authoritative.
    try {
      this.unsubResourceChanges = getResourcesManager().onChange(() => this.notifyMcpToolsChanged());
    } catch {
      this.unsubResourceChanges = null;
    }
  }

  /**
   * Tools exposed on /mcp and /api/v1/tools: the built-in set plus every tool of
   * an enabled, healthy local MCP server and `skill_read` when a Skill is enabled.
   */
  private exposedTools(): ToolDefinition[] {
    let extras: ToolDefinition[] = [];
    try {
      extras = getResourcesManager().getExposedToolDefinitions();
    } catch {
      extras = [];
    }
    return getExposedMuseTools(!!this.kernel.getContext().desktopHandsEnabled, extras);
  }

  /** Best-effort `notifications/tools/list_changed` over open MCP SSE streams. */
  private notifyMcpToolsChanged(): void {
    if (this.mcpEventStreams.size === 0) return;
    const frame = `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed'
    })}\n\n`;
    for (const stream of [...this.mcpEventStreams]) {
      try {
        stream.write(frame);
      } catch {
        this.mcpEventStreams.delete(stream);
      }
    }
  }

  /** Registers tunnel drivers this process spawned. stop() only kills those children. */
  public attachOwnedTunnels(drivers: { quick?: QuickTunnelDriver | null; named?: NamedTunnelDriver | null }): void {
    this.controlPlane.attachOwnedTunnels(drivers);
  }

  public getKernel(): PipelineKernel {
    return this.kernel;
  }

  public getAuthGuard(): BearerAuthGuard {
    return this.authGuard;
  }

  /**
   * Wires the process-level graceful shutdown callback used by
   * POST /api/v1/daemon/shutdown (Bearer-protected, same trust level as emergency-kill).
   */
  public setShutdownHandler(handler: () => void): void {
    this.shutdownHandler = handler;
  }

  /**
   * Starts the HTTP server enforcing public bind security.
   *
   * P3-R2 (authorized server.ts change #2): the bind-security call site now
   * (a) enforces the token entropy gate on non-loopback binds and
   * (b) accepts the optional measured-Tailscale-IP allowlist, forwarding it to
   * validateServerBindSecurity so a live `tailscale ip -4` address can bind
   * without being treated as a public address.
   */
  public async start(allowedTailscaleIps?: string[]): Promise<{ server: http.Server; url: string }> {
    const loopbackBind = ['127.0.0.1', 'localhost', '::1'].includes(this.host.trim().toLowerCase());
    if (!loopbackBind && this.runtimeToken) {
      assertTokenEntropy(this.runtimeToken);
    }
    validateServerBindSecurity(this.host, this.runtimeToken, allowedTailscaleIps);

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'INTERNAL_SERVER_ERROR', message: err.message }));
          }
        });
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        const url = `http://${this.host}:${this.port}`;
        this.kernel.updateContext({ tunnelUrl: url });
        resolve({ server: this.server!, url });
      });
    });
  }

  public async stop(): Promise<void> {
    this.unsubResourceChanges?.();
    this.unsubResourceChanges = null;
    for (const stream of this.mcpEventStreams) {
      try {
        stream.end();
      } catch {
        // Already closed.
      }
    }
    this.mcpEventStreams.clear();
    try {
      this.controlPlane.dispose();
    } catch {
      // Disposal is best-effort during shutdown.
    }
    if (this.server) {
      const listening = this.server;
      this.server = null;
      return new Promise((resolve) => {
        listening.close(() => {
          resolve();
        });
      });
    }
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // P3-R2 (authorized server.ts change #1): pass the RAW remote address to the
    // auth guard — BearerAuthGuard.normalizeClientIpKey performs the canonical
    // normalization (full IPv6 preserved; IPv4-mapped collapsed to IPv4). The
    // previous `.replace(/^.*:/, '')` pre-truncation destroyed IPv6 distinctions
    // and collapsed unrelated clients into a single ban bucket.
    const rawSocketIp = req.socket.remoteAddress || '127.0.0.1';
    // Only honor CF-Connecting-IP on loopback connections when a Cloudflare tunnel
    // is genuinely active in the control plane AND a syntactically valid CF-Ray
    // header + IP literal are present. This blocks local brute-force processes on
    // 127.0.0.1 from spoofing CF-Connecting-IP to evade the 5-attempt IP ban bucket.
    const isLoopbackConn =
      rawSocketIp === '127.0.0.1' ||
      rawSocketIp === '::1' ||
      rawSocketIp === '::ffff:127.0.0.1' ||
      rawSocketIp === 'localhost';
    const cfIp = typeof req.headers['cf-connecting-ip'] === 'string' ? req.headers['cf-connecting-ip'].trim() : '';
    const cfRay = typeof req.headers['cf-ray'] === 'string' ? req.headers['cf-ray'].trim() : '';
    const trustedCfProxy =
      isLoopbackConn &&
      cfIp.length > 0 &&
      /^[0-9a-f]{16}-[a-z]{3}$/i.test(cfRay) &&
      net.isIP(cfIp) !== 0 &&
      this.controlPlane.isCloudflareTunnelActive();
    const clientIp = trustedCfProxy ? cfIp : rawSocketIp;
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;
    const method = req.method || 'GET';

    // CORS Headers: never emit wildcard Access-Control-Allow-Origin on loopback
    // token discovery, authenticated desktop UI, or human approval routes.
    const isSensitiveLocalRoute =
      pathname === '/api/v1/tunnel/token' ||
      pathname === '/ui' ||
      pathname.startsWith('/ui/') ||
      pathname.startsWith('/approve/');
    if (!isSensitiveLocalRoute) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, Mcp-Session-Id');
    }

    if (method === 'OPTIONS') {
      if (pathname === '/api/v1/tunnel/token') {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'CROSS_ORIGIN_TOKEN_DISCOVERY_FORBIDDEN' }));
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // ------------------------------------------------------------------------
    // 1. Mobile One-Time HMAC Approval Page (/approve/:approvalId)
    // ------------------------------------------------------------------------
    if (pathname.startsWith('/approve/')) {
      const approvalId = pathname.slice('/approve/'.length);
      const sig = urlObj.searchParams.get('sig') || '';
      return this.handleApprovalRoute(req, res, approvalId, sig, method);
    }

    // ------------------------------------------------------------------------
    // 2. Authenticated desktop shell (/ui and /ui/*).
    //    Bearer/X-API-Key header, or an HttpOnly session cookie minted from a prior
    //    successful header load. Query-string tokens are never accepted.
    // ------------------------------------------------------------------------
    if (pathname === '/ui' || pathname.startsWith('/ui/')) {
      const headerAuth = this.resolveInboundAuthHeader(req);
      const viaHeader = typeof headerAuth === 'string' && headerAuth.trim().length > 0;
      let effective: string | undefined = viaHeader ? headerAuth : undefined;
      if (!viaHeader) {
        const cookie = readCookie(req.headers.cookie, 'mwh_ui_session');
        if (cookie && uiSessionMatches(cookie, this.runtimeToken)) {
          effective = `Bearer ${this.runtimeToken}`;
        }
      }
      const uiAuth = this.authGuard.checkAuth(effective, clientIp);
      if (!uiAuth.authenticated) {
        this.appendAuthProbeLog(req, pathname, clientIp, uiAuth.statusCode, uiAuth.message);
        if (uiAuth.statusCode === 429) {
          res.setHeader('Retry-After', '900');
          res.setHeader('X-MWH-Ban-Reason', 'IP_BANNED_TOO_MANY_FAILURES');
        }
        res.writeHead(uiAuth.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: uiAuth.message }));
        return;
      }
      if (viaHeader) {
        res.setHeader(
          'Set-Cookie',
          `mwh_ui_session=${mintUiSessionCookie(this.runtimeToken)}; Max-Age=86400; HttpOnly; SameSite=Strict; Path=/ui`
        );
      }
      this.uiHost.respondToUi(req, res);
      return;
    }

    // ------------------------------------------------------------------------
    // 3. Local Loopback Token Discovery (/api/v1/tunnel/token)
    //    Enforces strict physical loopback + zero proxy headers + same-origin
    //    Sec-Fetch-Site/Origin validation inside controlPlane.handle().
    // ------------------------------------------------------------------------
    if (pathname === '/api/v1/tunnel/token' && method === 'GET') {
      const handled = await this.controlPlane.handle(req, res, pathname, method);
      if (handled) return;
    }

    // ------------------------------------------------------------------------
    // 4. Authentication Enforcement for /mcp and /api/v1/* (including SSE)
    //    Header only (Authorization prioritized, X-API-Key fallback).
    //    Never honor ?token= and never honor the UI cookie here.
    // ------------------------------------------------------------------------
    const authHeader = this.resolveInboundAuthHeader(req);
    const authCheck = this.authGuard.checkAuth(authHeader, clientIp);

    if (!authCheck.authenticated) {
      this.appendAuthProbeLog(req, pathname, clientIp, authCheck.statusCode, authCheck.message);
      if (authCheck.statusCode === 429) {
        res.setHeader('Retry-After', '900');
        res.setHeader('X-MWH-Ban-Reason', 'IP_BANNED_TOO_MANY_FAILURES');
      }
      res.writeHead(authCheck.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: authCheck.message }));
      return;
    }

    // ------------------------------------------------------------------------
    // 3. Streamable HTTP MCP (/mcp)
    // ------------------------------------------------------------------------
    if (pathname === '/mcp') {
      this.controlPlane.recordMcpActivity();
      const sessionId = boundedMcpSessionId(req.headers['mcp-session-id']);
      res.setHeader('Mcp-Session-Id', sessionId);

      if (method === 'GET') {
        // SSE Connection
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        const endpointEvent = JSON.stringify({ endpoint: '/mcp', sessionId });
        res.write('event: endpoint\ndata: ');
        res.write(endpointEvent);
        res.write('\n\n');
        this.mcpEventStreams.add(res);
        req.on('close', () => {
          this.mcpEventStreams.delete(res);
        });
        return;
      }

      if (method === 'POST') {
        const bodyText = await this.readRequestBody(req);
        let rpcReq: any;
        try {
          rpcReq = JSON.parse(bodyText);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
          return;
        }

        const rpcRes = await this.handleMcpJsonRpc(rpcReq);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpcRes));
        return;
      }
    }

    // ------------------------------------------------------------------------
    // 4. REST Skill API (/api/v1/*)
    // ------------------------------------------------------------------------
    if (pathname === '/api/v1/status' && method === 'GET') {
      const result = await this.kernel.handleRequest({
        id: `rest_status_${Date.now()}`,
        toolName: 'pc_status',
        category: 'read',
        params: {}
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/v1/tools' && method === 'GET') {
      this.controlPlane.recordMcpActivity();
      const exposedTools = this.exposedTools();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tools: exposedTools }));
      return;
    }

    // Bearer-protected, same trust level as emergency-kill.
    // Respond first, then fire the handler asynchronously so the JSON body is not
    // truncated by process.exit.
    if (pathname === '/api/v1/daemon/shutdown' && method === 'POST') {
      if (!this.shutdownHandler) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'SHUTDOWN_HANDLER_NOT_WIRED' }));
        return;
      }
      const handler = this.shutdownHandler;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reason: 'http_shutdown', trigger: 'http_api' }), () => {
        setTimeout(() => handler(), 25);
      });
      return;
    }

    if (await this.controlPlane.handle(req, res, pathname, method)) {
      return;
    }

    // Not Found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND', path: pathname }));
  }

  /**
   * MCP JSON-RPC 2.0 Handler
   */
  private async handleMcpJsonRpc(rpcReq: any): Promise<any> {
    const { id, method, params } = rpcReq;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'muse-win-harness', version: '0.1.0' }
        }
      };
    }

    if (method === 'notifications/initialized') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    const exposedTools = this.exposedTools();

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: exposedTools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }))
        }
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const toolDef = exposedTools.find((t) => t.name === toolName);

      if (!toolDef) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Tool not found: ${toolName}` }
        };
      }

      const pipeRes = await this.controlPlane.invokeTool(
        toolName,
        toolDef.category,
        toolArgs
      );

      if (pipeRes.status === 'SUCCESS') {
        const dataObj = pipeRes.data && typeof pipeRes.data === 'object' ? { ...pipeRes.data } : pipeRes.data;
        const mcpImage =
          dataObj && typeof dataObj === 'object' && dataObj.__mcpImage && typeof dataObj.__mcpImage.data === 'string'
            ? dataObj.__mcpImage
            : null;
        if (mcpImage) {
          delete dataObj.__mcpImage;
        }
        const content: any[] = [{ type: 'text', text: JSON.stringify(dataObj, null, 2) }];
        if (mcpImage) {
          content.push({
            type: 'image',
            data: mcpImage.data,
            mimeType: mcpImage.mimeType || 'image/png'
          });
        }
        return {
          jsonrpc: '2.0',
          id,
          result: { content }
        };
      } else if (pipeRes.status === 'CONFIRMATION_REQUIRED') {
        const isCriticalHmac = Boolean(pipeRes.requiresMobileHmac);
        const message = isCriticalHmac
          ? 'Critical action requires one-time human confirmation via the mobile/browser HMAC approval link (approvalUrl) or the local desktop floating island. Share the approvalUrl with the user if they are away from the PC, and poll job_control(action="poll", approvalId) or job_control(action="status", approvalId) to observe CONSUMED status and retrieve the execution output.'
          : 'Local confirmation is pending on the desktop floating island (or via approvalUrl). Do NOT ask the user to type "approved" in chat; immediately poll job_control(action="poll", approvalId) or job_control(action="status", approvalId) to observe CONSUMED status and retrieve the execution output.';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'CONFIRMATION_REQUIRED',
                    approvalId: pipeRes.approvalId,
                    approvalUrl: pipeRes.approvalUrl,
                    requiresMobileHmac: isCriticalHmac,
                    summary: pipeRes.summary,
                    riskLevel: pipeRes.riskLevel,
                    message
                  },
                  null,
                  2
                )
              }
            ]
          }
        };
      } else {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: pipeRes.reason || pipeRes.error || 'Execution denied' }],
            isError: true
          }
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  }

  /**
   * Mobile One-Time HMAC Approval Route Handler
   */
  /**
   * HTML-escapes untrusted interpolations to prevent stored/reflected XSS on the
   * approval page (e.g. a model-controlled summary injecting an auto-submit script).
   */
  private escapeHtml(value: string): string {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Normalizes an IP address and reports whether it originates from this machine:
   * the entire 127.0.0.0/8 range (not just 127.0.0.1), ::1, IPv4-mapped
   * ::ffff:127.x forms, and any address assigned to a local interface — so a
   * local model process cannot dodge the self-approval guard via 127.0.0.2 or
   * a LAN address. External devices arriving through a tunnel keep real IPs.
   */
  private isLoopbackAddress(address: string | undefined | null): boolean {
    const normalized = (address || '').replace(/^::ffff:/, '').toLowerCase();
    if (normalized === '::1' || normalized === 'localhost') return true;
    if (/^127(\.\d{1,3}){3}$/.test(normalized)) return true;
    for (const infos of Object.values(os.networkInterfaces())) {
      for (const info of infos || []) {
        if (info && info.address.toLowerCase() === normalized) return true;
      }
    }
    return false;
  }

  private async handleApprovalRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    approvalId: string,
    sig: string,
    method: string
  ): Promise<void> {
    const approvalEngine = this.kernel.getApprovalEngine();
    const record = approvalEngine.getApproval(approvalId);
    const safeApprovalId = this.escapeHtml(approvalId);
    const safeSig = this.escapeHtml(sig);

    if (!record) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.renderHtmlPage('Approval Not Found', '<p>Approval ID is invalid or does not exist.</p>'));
      return;
    }

    if (record.status !== 'PENDING') {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        this.renderHtmlPage(
          'Approval Already Resolved',
          `<p>This action has already been <strong>${this.escapeHtml(record.status)}</strong> by ${this.escapeHtml(record.approvedBy || 'user')}.</p>`
        )
      );
      return;
    }

    if (method === 'GET') {
      const riskUpper = String(record.riskLevel || 'medium').toUpperCase();
      const riskColor =
        record.riskLevel === 'critical'
          ? '#F87171'
          : record.riskLevel === 'high'
            ? '#FBBF24'
            : '#60A5FA';
      const riskBg =
        record.riskLevel === 'critical'
          ? 'rgba(248,113,113,0.14)'
          : record.riskLevel === 'high'
            ? 'rgba(251,191,36,0.14)'
            : 'rgba(96,165,250,0.14)';
      const paramsDetail = this.escapeHtml(JSON.stringify(record.params || {}, null, 2));
      const remainingSec = Math.max(0, Math.floor((record.expiresAt - Date.now()) / 1000));

      // Render approval UI (all model-controlled interpolations are escaped)
      const body = `
      <div class="card">
        <div class="header">
          <div class="badge" style="background:${riskBg}; color:${riskColor}; border:1px solid ${riskColor}44;">
            风险等级 / Risk Level: <strong>${this.escapeHtml(riskUpper)}</strong>
          </div>
          <span class="countdown" id="mwh-countdown" data-expires="${record.expiresAt}">剩余 ${Math.floor(remainingSec / 60)}m ${remainingSec % 60}s</span>
        </div>
        <h2 style="margin:12px 0 6px; font-size:20px;">安全确认 · Security Confirmation</h2>
        <p class="muted" style="margin:0 0 16px; font-size:13px;">一次性参数绑定签名链接 · 执行前自动创建影子快照</p>

        <div class="section">
          <div class="label">操作摘要 / Action Summary</div>
          <div class="value">${this.escapeHtml(record.summary)}</div>
        </div>

        <div class="section">
          <div class="label">工具与参数明细 / Tool & Parameters</div>
          <div style="margin-bottom:6px;"><code>${this.escapeHtml(record.toolName)}</code></div>
          <pre class="codeblock">${paramsDetail}</pre>
        </div>

        <div class="notice">
          <strong>Security Notice:</strong> 无 OS 级真沙箱，依赖路径围栏+进程树管控+审批流
        </div>

        <form method="POST" action="/approve/${safeApprovalId}?sig=${safeSig}" style="margin-top:20px;">
          <input type="hidden" name="action" value="approve" />
          <button type="submit" class="btn btn-approve">
            批准执行 / Approve Action
          </button>
        </form>
        <form method="POST" action="/approve/${safeApprovalId}?sig=${safeSig}" style="margin-top:10px;">
          <input type="hidden" name="action" value="reject" />
          <button type="submit" class="btn btn-reject">
            拒绝 / Reject
          </button>
        </form>
      </div>
      <script>
        (function() {
          var el = document.getElementById('mwh-countdown');
          if (!el) return;
          var exp = Number(el.getAttribute('data-expires') || 0);
          function tick() {
            var sec = Math.max(0, Math.floor((exp - Date.now()) / 1000));
            if (sec <= 0) { el.textContent = '已过期 / Expired'; return; }
            el.textContent = '剩余 ' + Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
          }
          setInterval(tick, 1000);
        })();
      </script>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.renderHtmlPage('Action Confirmation', body));
      return;
    }

    if (method === 'POST') {
      // Rate limit: >=5 POST attempts on the same approvalId within 60s -> 429
      // (pure in-memory, hinders scripted abuse of the approval endpoint).
      const nowMs = Date.now();
      const attempts = (this.approvalPostAttempts.get(approvalId) || []).filter(
        (t) => nowMs - t < 60000
      );
      attempts.push(nowMs);
      this.approvalPostAttempts.set(approvalId, attempts);
      if (attempts.length >= 5) {
        res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          this.renderHtmlPage(
            'Too Many Requests',
            '<p style="color:red;">Too many approval attempts for this action. Please wait a minute and retry from the session link.</p>'
          )
        );
        return;
      }

      const bodyText = await this.readRequestBody(req);
      const params = new URLSearchParams(bodyText);

      // Action whitelist: anything other than approve/reject is rejected with 400.
      const rawAction = params.get('action') || 'approve';
      if (rawAction !== 'approve' && rawAction !== 'reject') {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          this.renderHtmlPage(
            'Invalid Action',
            `<p style="color:red;">Error: ${this.escapeHtml('INVALID_ACTION: action must be approve or reject')}</p>`
          )
        );
        return;
      }
      const action = rawAction as 'approve' | 'reject';

      // ------------------------------------------------------------------
      // RESIDUAL RISK (to be recorded in SECURITY_DISCLOSURE):
      // The approval link is forwarded to the human through the Muse session;
      // whoever holds the full URL (including the HMAC sig) is able to approve.
      // This design raises the abuse cost via one-time consumption + params
      // binding + 15-minute expiry + loopback self-approval rejection + full
      // audit logging, but complete protection requires an out-of-band
      // approval channel.
      // ------------------------------------------------------------------
      // Loopback self-approval guard: when the server is exposed beyond the
      // loopback interface (non-loopback bind), a locally running model could
      // otherwise reach the approval page directly from 127.0.0.1. Critical
      // (requiresMobileHmac) approvals arriving from loopback in that setup are
      // rejected with 403; reject is not restricted, and non-critical records
      // are not affected. When the server is bound to loopback only, the
      // approval URL is reachable from this machine alone and humans/models
      // cannot be distinguished at the network layer — interception is disabled
      // there and the residual risk above applies.
      if (
        !this.isLoopbackAddress(this.host) &&
        action === 'approve' &&
        record.requiresMobileHmac &&
        this.isLoopbackAddress(req.socket.remoteAddress)
      ) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          this.renderHtmlPage(
            'Forbidden',
            `<p style="color:red;">Error: ${this.escapeHtml('LOOPBACK_SELF_APPROVAL_FORBIDDEN: Critical approvals cannot be granted from the loopback interface')}</p>`
          )
        );
        return;
      }

      try {
        // Human mobile-link channel: resolves, creates pre-approved snapshot, executes, and syncs desktop SSE.
        const outcome = await this.controlPlane.resolveFromMobileLink(approvalId, action, sig);
        const resultText = action === 'approve' ? 'Action Approved Successfully' : 'Action Rejected';
        const resultTitleZh = action === 'approve' ? '已批准并触发执行' : '已拒绝该操作';
        const color = action === 'approve' ? '#34D399' : '#F87171';
        const extraLines: string[] = [];
        if (outcome.executionStatus) {
          extraLines.push(`<div>执行状态 / Status: <code>${this.escapeHtml(outcome.executionStatus)}</code></div>`);
        }
        if (outcome.checkpointId) {
          extraLines.push(`<div>写前影子快照 / Snapshot: <code>${this.escapeHtml(outcome.checkpointId)}</code></div>`);
        }
        if (outcome.jobId) {
          extraLines.push(`<div>后台任务 / Job ID: <code>${this.escapeHtml(outcome.jobId)}</code></div>`);
        }
        const body = `
        <div class="card" style="text-align:center;">
          <h2 style="color:${color}; margin:0 0 6px;">${resultTitleZh}</h2>
          <div class="muted" style="font-size:13px; margin-bottom:14px;">${resultText}</div>
          <p style="font-size:14px;">Approval <code>${safeApprovalId}</code> has been marked as <strong>${this.escapeHtml(outcome.status)}</strong>.</p>
          ${extraLines.length > 0 ? `<div class="section" style="text-align:left; font-size:13px; line-height:1.8;">${extraLines.join('')}</div>` : ''}
          <p class="muted" style="font-size:13px; margin-top:16px;">桌面端已同步更新，你可以返回 Muse 会话继续查看结果。</p>
        </div>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.renderHtmlPage(resultText, body));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          this.renderHtmlPage(
            'Resolution Failed',
            `<div class="card"><p style="color:#F87171;">Error: ${this.escapeHtml(err?.message || String(err))}</p></div>`
          )
        );
      }
    }
  }

  private renderHtmlPage(title: string, bodyContent: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} - Muse-Win-Harness</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #111216; margin: 0; padding: 20px 14px; color: #ECECEE; }
    .card { background: #1C1D22; border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 20px; box-shadow: 0 16px 40px rgba(0,0,0,0.45); max-width: 500px; margin: 0 auto; }
    .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .badge { padding: 5px 10px; border-radius: 999px; font-size: 12px; }
    .countdown { font-size: 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: #9E9FA6; }
    .muted { color: #9E9FA6; }
    .section { background: #141519; border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 12px; margin-bottom: 12px; }
    .label { font-size: 11px; color: #9E9FA6; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
    .value { font-size: 14px; line-height: 1.5; word-break: break-word; }
    .codeblock { margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.5; color: #C7D2FE; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow: auto; }
    .notice { font-size: 12px; color: #D4D5DC; background: rgba(99,102,241,0.1); border: 1px solid rgba(99,102,241,0.25); border-radius: 10px; padding: 10px 12px; line-height: 1.5; }
    code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 5px; font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .btn { width: 100%; border: none; border-radius: 999px; font-size: 15px; font-weight: 600; cursor: pointer; padding: 12px 16px; transition: opacity 0.15s; }
    .btn:active { opacity: 0.85; }
    .btn-approve { background: linear-gradient(135deg, #8B5CF6 0%, #6366F1 50%, #3B82F6 100%); color: #fff; }
    .btn-reject { background: rgba(248,113,113,0.14); border: 1px solid rgba(248,113,113,0.35); color: #FCA5A5; font-size: 14px; padding: 10px 16px; }
  </style>
</head>
<body>
  ${bodyContent}
</body>
</html>`;
  }

  /**
   * M2: Minimal header compatibility for Muse Connector.
   * Prioritizes `Authorization` header; falls back to `X-API-Key` normalized as
   * `Bearer <token>` so `BearerAuthGuard.checkAuth` enforces the exact same
   * constant-time comparison, failure counter, and IP ban without modifying authGuard.ts.
   */
  private resolveInboundAuthHeader(req: http.IncomingMessage): string | undefined {
    const rawAuth = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization;
    if (typeof rawAuth === 'string' && rawAuth.trim().length > 0) {
      return rawAuth;
    }
    const rawApiKey = Array.isArray(req.headers['x-api-key'])
      ? req.headers['x-api-key'][0]
      : req.headers['x-api-key'];
    if (typeof rawApiKey === 'string' && rawApiKey.trim().length > 0) {
      const trimmed = rawApiKey.trim();
      return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
    }
    return undefined;
  }

  /**
   * M1: Desensitized diagnostic probe for 401/403 authentication failures.
   * Appends header names, 8-char prefix, Bearer flag, path, IP, and timestamp to
   * `.mwh/logs/auth-probe.log`. Never writes full credentials.
   */
  private appendAuthProbeLog(
    req: http.IncomingMessage,
    pathname: string,
    clientIp: string,
    statusCode: number,
    reason?: string
  ): void {
    try {
      const candidateHeaderNames = [
        'authorization',
        'x-api-key',
        'api-key',
        'x-auth-token',
        'x-access-token'
      ];
      const receivedAuthHeaders = Object.keys(req.headers).filter(
        (h) =>
          candidateHeaderNames.includes(h.toLowerCase()) ||
          h.toLowerCase().includes('auth') ||
          h.toLowerCase().includes('key') ||
          h.toLowerCase().includes('token')
      );
      const rawAuth = Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization;
      const rawApiKey = Array.isArray(req.headers['x-api-key'])
        ? req.headers['x-api-key'][0]
        : req.headers['x-api-key'];
      const chosenRaw =
        typeof rawAuth === 'string' && rawAuth.trim().length > 0
          ? rawAuth.trim()
          : typeof rawApiKey === 'string' && rawApiKey.trim().length > 0
            ? rawApiKey.trim()
            : '';
      const hasBearerPrefix = /^Bearer\s+/i.test(chosenRaw);
      const bareValue = hasBearerPrefix ? chosenRaw.replace(/^Bearer\s+/i, '').trim() : chosenRaw;
      const valuePrefix8 = bareValue ? `${bareValue.slice(0, 8)}...` : '(empty)';

      const entry = {
        timestamp: new Date().toISOString(),
        statusCode,
        path: pathname,
        clientIp,
        receivedAuthHeaders,
        hasBearerPrefix,
        valuePrefix8,
        reason
      };
      const workspaceRoot = this.kernel.getContext().workspaceRoot || process.cwd();
      const logPath = path.join(workspaceRoot, '.mwh', 'logs', 'auth-probe.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch {
      // Diagnostic logging must never crash request handling.
    }
  }

  private readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk.toString();
      });
      req.on('end', () => resolve(data));
      req.on('error', (err) => reject(err));
    });
  }
}
