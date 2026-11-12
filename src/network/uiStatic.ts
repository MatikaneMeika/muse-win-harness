/**
 * Authenticated static host for the desktop shell under /ui and /ui/*.
 * Paths are resolved against frontend/dist and fenced with realpath + isSubPathOf.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isSubPathOf } from '../pipeline/pathGuard.js';

const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Muse-Win-Harness (Desktop Shell & Engine Center)</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #121315; color: #ececee; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .card { max-width: 480px; padding: 24px; border-radius: 16px; background: #1e1f24; border: 1px solid rgba(255,255,255,0.08); text-align: center; font-size: 13px; line-height: 1.6; }
    code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div id="root">
    <div class="card">
      <strong>Muse-Win-Harness · Browser Preview</strong>
      <p>Frontend bundle (<code>frontend/dist</code>) is not built yet. Run <code>npm run build:ui</code> in the repository root to build the browser debug preview, or use the Electron desktop shell directly.</p>
    </div>
  </div>
</body>
</html>`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

let uiSessionSecret = crypto.randomBytes(32).toString('hex');

export function getUiSessionSecret(): string {
  return uiSessionSecret;
}

export function setUiSessionSecret(secret: string): void {
  if (typeof secret === 'string' && secret.trim().length >= 16) {
    uiSessionSecret = secret.trim();
  }
}

export function rotateUiSessionSecret(): string {
  uiSessionSecret = crypto.randomBytes(32).toString('hex');
  return uiSessionSecret;
}

export function mintUiSessionCookie(runtimeToken: string, secret: string = uiSessionSecret): string {
  return crypto.createHmac('sha256', secret).update(runtimeToken).digest('hex');
}

export function uiSessionMatches(presented: string, runtimeToken: string, secret: string = uiSessionSecret): boolean {
  if (!presented || !runtimeToken) return false;
  const expected = mintUiSessionCookie(runtimeToken, secret);
  if (presented.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function hasStaticExtension(rel: string): boolean {
  const ext = path.extname(rel).toLowerCase();
  return ext.length > 0 && ext !== '.';
}

/** Accept only `/ui` or `/ui/` plus 1–4 safe segments. */
export function safeUiRequestPath(pathname: string): string | null {
  if (pathname === '/ui' || pathname === '/ui/') return '/ui';
  const matched = pathname.match(/^(\/ui(?:\/[A-Za-z0-9._~-]{1,120}){1,4})$/);
  return matched ? matched[1] : null;
}

/** Keep a client session id only when it is already a UUID. Otherwise mint one. */
export function boundedMcpSessionId(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const matched = typeof raw === 'string' ? raw.trim().match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) : null;
  return matched ? matched[0].toLowerCase() : crypto.randomUUID();
}

export class UiStaticHost {
  private distRoot: string;

  constructor(distRoot?: string) {
    this.distRoot = path.resolve(distRoot || path.resolve(process.cwd(), 'frontend', 'dist'));
  }

  public getDistRoot(): string {
    return this.distRoot;
  }

  /** Authenticated UI request. The path allowlist stays in this method, next to the file read. */
  public respondToUi(req: http.IncomingMessage, res: http.ServerResponse): void {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }
    const uiPath = safeUiRequestPath(pathname);
    if (!uiPath || !(uiPath === '/ui' || uiPath.startsWith('/ui/'))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    this.respondWithUiFile(uiPath, res);
  }

  /**
   * Serves a /ui or /ui/* request. Caller has already authenticated.
   * Directory escape and realpath breakout return 403.
   */
  public respondWithUiFile(urlPath: string, res: http.ServerResponse): void {
    let decoded = urlPath;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    let rel = decoded === '/ui' || decoded === '/ui/' ? 'index.html' : decoded.replace(/^\/ui\/?/, '');
    rel = rel.replace(/^[/\\]+/, '');
    if (!rel || rel.endsWith('/') || rel.endsWith('\\')) {
      rel = path.posix.join(rel.replace(/[/\\]+$/, ''), 'index.html');
    }

    const segments = rel.split(/[/\\]+/).filter((s) => s.length > 0);
    if (segments.some((s) => s === '..' || s === '.')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    rel = segments.join('/');

    const lexicalRoot = path.resolve(this.distRoot);
    const lexicalTarget = path.resolve(lexicalRoot, rel);
    if (!(lexicalTarget === lexicalRoot || lexicalTarget.startsWith(lexicalRoot + path.sep)) || !isSubPathOf(lexicalTarget, lexicalRoot)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    let target = lexicalTarget;
    if (!fs.existsSync(target) || (fs.existsSync(target) && fs.statSync(target).isDirectory())) {
      if (!hasStaticExtension(rel) || fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        target = path.resolve(lexicalRoot, 'index.html');
        if (!fs.existsSync(target)) {
          this.sendFallback(res);
          return;
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    if (!fs.existsSync(target)) {
      if (!hasStaticExtension(rel)) {
        this.sendFallback(res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = fs.realpathSync.native(lexicalRoot);
      realTarget = fs.realpathSync.native(target);
    } catch {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    if (!isSubPathOf(realTarget, realRoot) || !(realTarget === realRoot || realTarget.startsWith(realRoot + path.sep))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(realTarget);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    if (!stat.isFile()) {
      this.sendFallback(res);
      return;
    }

    const body = fs.readFileSync(realTarget);
    const isHtml = contentTypeFor(realTarget).startsWith('text/html');
    // Hashed assets are immutable and safely cacheable forever; HTML is the
    // entry point that references hashed bundles and must never be cached
    // (a stale index.html makes browsers/Electron reuse a previous bundle).
    const cacheControl = isHtml ? 'no-store' : 'public, max-age=31536000, immutable';
    res.writeHead(200, {
      'Content-Type': contentTypeFor(realTarget),
      'Content-Length': body.length,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  }

  private sendFallback(res: http.ServerResponse): void {
    const body = Buffer.from(FALLBACK_HTML, 'utf-8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  }
}
