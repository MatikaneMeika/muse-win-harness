/**
 * Bearer Authentication Guard with Brute-Force IP Banning
 * Uses constant-time comparison (crypto.timingSafeEqual) and enforces a 15-minute ban
 * after 5 consecutive failed attempts from the same IP.
 *
 * P3 hardening:
 * - Ban-bucket key uses the FULL normalized client address (the '::ffff:' mapped
 *   prefix is stripped and mapped addresses are canonicalized to plain IPv4;
 *   native IPv6 is kept intact, never truncated to its last segment).
 * - Sliding window: only failures within the last 15 minutes count towards the
 *   ban threshold, so 5 failures spread over a night do not trigger a ban.
 * - Memory governance: entries carry lastSeen and are lazily purged after 30
 *   minutes of inactivity; the Map is capped at 10000 entries with oldest-lastSeen
 *   eviction on overflow.
 * - Timing side channel: the provided token is SHA-256 hashed before the
 *   constant-time comparison, so the comparison length is fixed (32-byte digest)
 *   and no token-length information leaks via timing.
 */

import crypto from 'node:crypto';
import net from 'node:net';

export interface AuthResult {
  authenticated: boolean;
  banned: boolean;
  statusCode: number;
  message?: string;
}

interface IpTracking {
  /** Timestamps of failed attempts (sliding 15-minute window). */
  failures: number[];
  bannedUntil?: number;
  lastSeen: number;
}

const FAILURE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const ENTRY_TTL_MS = 30 * 60 * 1000; // 30 minutes lazy purge
const MAX_TRACKED_IPS = 10000;

/**
 * Normalizes a client address into a stable ban-bucket key:
 * - IPv4-mapped IPv6 (::ffff:1.2.3.4 / 0:0:0:0:0:ffff:1.2.3.4) -> plain IPv4
 * - native IPv6 -> kept complete (never truncated to the last segment)
 */
export function normalizeClientIpKey(clientIp: string | undefined | null): string {
  let key = (clientIp || '').trim().toLowerCase();
  if (key.startsWith('[') && key.endsWith(']')) {
    key = key.slice(1, -1);
  }
  const ipv4Candidate = key.startsWith('::ffff:')
    ? key.slice('::ffff:'.length)
    : key.startsWith('0:0:0:0:0:ffff:')
      ? key.slice('0:0:0:0:0:ffff:'.length)
      : '';
  if (ipv4Candidate && net.isIPv4(ipv4Candidate)) {
    return ipv4Candidate;
  }
  return key || 'unknown';
}

export class BearerAuthGuard {
  private runtimeToken: string;
  private tokenExpiresAt?: number;
  private failedAttempts: Map<string, IpTracking> = new Map();
  private banDurationMs = 15 * 60 * 1000; // 15 minutes
  private maxConsecutiveFailures = 5;

  constructor(runtimeToken: string, tokenExpiresAt?: number) {
    this.runtimeToken = runtimeToken;
    this.tokenExpiresAt = tokenExpiresAt;
  }

  public updateRuntimeToken(token: string, tokenExpiresAt?: number): void {
    this.runtimeToken = token;
    if (tokenExpiresAt !== undefined) {
      this.tokenExpiresAt = tokenExpiresAt;
    }
  }

  public setTokenExpiresAt(tokenExpiresAt?: number): void {
    this.tokenExpiresAt = tokenExpiresAt;
  }

  public getTokenExpiresAt(): number | undefined {
    return this.tokenExpiresAt;
  }

  /**
   * Lazily purges expired entries: entries untouched for >30 minutes are
   * dropped; entries with an expired ban and an empty sliding window are
   * dropped too. Runs on every check (amortized O(n) over stale entries only).
   */
  private pruneStaleEntries(now: number): void {
    for (const [key, record] of this.failedAttempts) {
      if (now - record.lastSeen > ENTRY_TTL_MS) {
        this.failedAttempts.delete(key);
        continue;
      }
      const recentFailures = record.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
      if (
        recentFailures.length === 0 &&
        (!record.bannedUntil || now >= record.bannedUntil)
      ) {
        this.failedAttempts.delete(key);
      }
    }
  }

  /**
   * Inserts a new tracking entry, evicting the oldest (smallest lastSeen) entry
   * when the Map is at capacity.
   */
  private insertTracked(key: string, now: number): IpTracking {
    if (!this.failedAttempts.has(key) && this.failedAttempts.size >= MAX_TRACKED_IPS) {
      let oldestKey: string | null = null;
      let oldestSeen = Infinity;
      for (const [k, v] of this.failedAttempts) {
        if (v.lastSeen < oldestSeen) {
          oldestSeen = v.lastSeen;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) {
        this.failedAttempts.delete(oldestKey);
      }
    }
    const record: IpTracking = { failures: [], lastSeen: now };
    this.failedAttempts.set(key, record);
    return record;
  }

  /**
   * Constant-time token comparison with the length side-channel removed:
   * both the provided and the expected token are hashed to fixed-length
   * SHA-256 digests before timingSafeEqual, so differing input lengths
   * (or early length inequality) no longer leak through timing.
   */
  private tokenMatches(provided: string): boolean {
    if (!provided || !this.runtimeToken) return false;
    const providedDigest = crypto.createHash('sha256').update(provided, 'utf-8').digest();
    const expectedDigest = crypto.createHash('sha256').update(this.runtimeToken, 'utf-8').digest();
    return crypto.timingSafeEqual(providedDigest, expectedDigest);
  }

  /**
   * Validates incoming request Authorization header against the runtime token.
   */
  public checkAuth(authHeader: string | undefined, clientIp: string): AuthResult {
    const ip = normalizeClientIpKey(clientIp);
    const now = Date.now();

    this.pruneStaleEntries(now);

    let record = this.failedAttempts.get(ip);
    if (!record) {
      record = this.insertTracked(ip, now);
    }
    record.lastSeen = now;

    // Check existing ban
    if (record.bannedUntil) {
      if (now < record.bannedUntil) {
        const remainingMinutes = Math.ceil((record.bannedUntil - now) / 60000);
        return {
          authenticated: false,
          banned: true,
          statusCode: 429,
          message: `IP_BANNED_TOO_MANY_FAILURES: IP ${ip} is banned for another ${remainingMinutes} minute(s) due to excessive authentication failures.`
        };
      } else {
        // Ban expired: reset ban and sliding window
        record.bannedUntil = undefined;
        record.failures = [];
      }
    }

    // Extract Bearer token
    const match = (authHeader || '').match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1].trim() : '';

    const isValid = this.tokenMatches(token);

    if (isValid) {
      if (typeof this.tokenExpiresAt === 'number' && now > this.tokenExpiresAt) {
        return {
          authenticated: false,
          banned: false,
          statusCode: 401,
          message: 'TOKEN_EXPIRED: Runtime Bearer token has expired. Rotate the token or restart the daemon.'
        };
      }
      // Successful authentication resets failure counter
      this.failedAttempts.delete(ip);
      return {
        authenticated: true,
        banned: false,
        statusCode: 200
      };
    }

    // Authentication failed: sliding-window bookkeeping (only failures within
    // the last 15 minutes count, so stale/overnight failures never accumulate).
    record.failures = record.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    record.failures.push(now);

    if (record.failures.length >= this.maxConsecutiveFailures) {
      record.bannedUntil = now + this.banDurationMs;
      return {
        authenticated: false,
        banned: true,
        statusCode: 429,
        message: `IP_BANNED_TOO_MANY_FAILURES: 5 failed attempts within 15 minutes. IP ${ip} has been banned for 15 minutes.`
      };
    }

    return {
      authenticated: false,
      banned: false,
      statusCode: 401,
      message: 'UNAUTHORIZED: Invalid or missing Bearer token'
    };
  }

  public resetIp(clientIp: string): void {
    this.failedAttempts.delete(normalizeClientIpKey(clientIp));
  }
}
