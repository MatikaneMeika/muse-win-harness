/**
 * Outbound SSRF Guard
 * Restricts server-initiated outbound HTTP/HTTPS requests to public endpoints only.
 *
 * NOTE (P3 honest disclosure): the MWH codebase currently performs NO in-process
 * outbound HTTP requests. The functions below are DEFENSIVE GUARDS: any future
 * outbound HTTP(S) call added to this codebase MUST be validated through
 * validateOutboundHostSync/validateOutboundUrl before connecting.
 *
 * P3 hardening: the prohibited-range check is backed by net.BlockList (equivalent
 * behavior to the previous hand-rolled octet math, with broader coverage):
 * - IPv4 and IPv6 ranges are kept in SEPARATE BlockList instances because Node's
 *   BlockList treats any IPv4 address as matching an IPv6 ::ffff:0:0/96 subnet.
 * - IPv4: loopback 127/8, unspecified 0/8, private 10/8 + 172.16/12 + 192.168/16,
 *   link-local 169.254/16, CGNAT 100.64/10, multicast 224/4, reserved 240/4,
 *   documentation 192.0.2.0/24 + 198.51.100.0/24 + 203.0.113.0/24, benchmark
 *   198.18.0.0/15.
 * - IPv6: unspecified ::/128, loopback ::1/128, IPv4-mapped ::ffff:0:0/96,
 *   NAT64 64:ff9b::/96, unique-local fc00::/7, link-local fe80::/10, multicast
 *   ff00::/8, documentation 2001:db8::/32.
 * - IPv4-mapped IPv6 literals are resolved to the embedded IPv4 and evaluated
 *   against the IPv4 table (P3-R2):
 *     1. Dotted form '::ffff:a.b.c.d' and hex-embedded form '::ffff:a:b' (where
 *        a/b are two 16-bit groups, e.g. '::ffff:7f00:1' == 127.0.0.1) BOTH
 *        decode to the same 32-bit IPv4 address and inherit IPv4 semantics.
 *        Rationale: these are textual variants of ONE socket address — and the
 *        WHATWG URL parser canonicalizes dotted mapped hosts into the hex form
 *        anyway ('[::ffff:8.8.8.8]' -> hostname '::ffff:808:808'), so deciding
 *        by textual form would be unobservable through URLs. Public targets
 *        like '::ffff:8.8.8.8' pass; loopback/private like '::ffff:192.168.1.1'
 *        or '::ffff:127.0.0.1' are denied.
 *     2. Malformed / non-canonical variants (e.g. '::ffff:1.2.3', which is not
 *        valid IPv6 at all) fall through to the fail-closed "unknown address
 *        format is blocked" path. Note: every VALID IPv6 address inside
 *        ::ffff:0:0/96 has exactly two trailing groups and is therefore always
 *        decodable — the /96 entry is retained in the IPv6 table as defense for
 *        the range itself.
 * Only http:/https: protocols are allowed (unchanged).
 */

import dns from 'node:dns';
import net from 'node:net';

const ipv4BlockList = new net.BlockList();
const ipv6BlockList = new net.BlockList();

// --- IPv4 prohibited ranges ---
ipv4BlockList.addSubnet('0.0.0.0', 8, 'ipv4'); // current-network / unspecified
ipv4BlockList.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
ipv4BlockList.addSubnet('10.0.0.0', 8, 'ipv4'); // private
ipv4BlockList.addSubnet('172.16.0.0', 12, 'ipv4'); // private
ipv4BlockList.addSubnet('192.168.0.0', 16, 'ipv4'); // private
ipv4BlockList.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local
ipv4BlockList.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT / shared address space
ipv4BlockList.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
ipv4BlockList.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved / broadcast
ipv4BlockList.addSubnet('192.0.2.0', 24, 'ipv4'); // TEST-NET-1 (documentation)
ipv4BlockList.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2 (documentation)
ipv4BlockList.addSubnet('203.0.113.0', 24, 'ipv4'); // TEST-NET-3 (documentation)
ipv4BlockList.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking

// --- IPv6 prohibited ranges (kept in a separate BlockList; see header note) ---
ipv6BlockList.addAddress('::', 'ipv6'); // unspecified
ipv6BlockList.addAddress('::1', 'ipv6'); // loopback
ipv6BlockList.addSubnet('::ffff:0:0', 96, 'ipv6'); // IPv4-mapped
ipv6BlockList.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64
ipv6BlockList.addSubnet('fc00::', 7, 'ipv6'); // unique local
ipv6BlockList.addSubnet('fe80::', 10, 'ipv6'); // link-local
ipv6BlockList.addSubnet('ff00::', 8, 'ipv6'); // multicast
ipv6BlockList.addSubnet('2001:db8::', 32, 'ipv6'); // documentation

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Checks if any IP address (v4 or v6) is in a prohibited range.
 * Unknown/malformed address formats are always blocked (fail-closed).
 */
export function isDisallowedIp(ip: string): boolean {
  const normalized = stripBrackets(String(ip || '').toLowerCase().trim());

  if (net.isIPv4(normalized)) {
    return ipv4BlockList.check(normalized, 'ipv4');
  }
  if (net.isIPv6(normalized)) {
    // IPv4-mapped literal: resolve to the embedded IPv4 and apply IPv4 rules
    // (dotted '::ffff:127.0.0.1' and hex-embedded '::ffff:7f00:1' both decode
    // to 127.0.0.1 — one socket address, one set of semantics; see header).
    const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/.exec(normalized);
    if (mapped) {
      const rest = mapped[1];
      if (net.isIPv4(rest)) {
        return ipv4BlockList.check(rest, 'ipv4');
      }
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
      if (hex) {
        const hi = parseInt(hex[1], 16);
        const lo = parseInt(hex[2], 16);
        const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return ipv4BlockList.check(dotted, 'ipv4');
      }
    }
    return ipv6BlockList.check(normalized, 'ipv6');
  }
  return true; // Unknown address format is blocked
}

/**
 * Synchronous validation of outbound host and protocol.
 */
export function validateOutboundHostSync(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err: any) {
    throw new Error(`OUTBOUND_GUARD_BLOCKED: Invalid URL format: ${err.message}`);
  }

  // Only allow http: and https:
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`OUTBOUND_GUARD_BLOCKED: Protocol not allowed: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Reject explicit localhost or mDNS
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new Error(`OUTBOUND_GUARD_BLOCKED: Localhost / local domain prohibited: ${hostname}`);
  }

  // If hostname is an IP literal, validate immediately
  if (net.isIP(stripBrackets(hostname))) {
    if (isDisallowedIp(stripBrackets(hostname))) {
      throw new Error(`OUTBOUND_GUARD_BLOCKED: IP in prohibited private/loopback range: ${hostname}`);
    }
  }

  return parsed;
}

/**
 * Asynchronous validation of outbound URL including DNS resolution checks.
 */
export async function validateOutboundUrl(rawUrl: string): Promise<URL> {
  const parsed = validateOutboundHostSync(rawUrl);

  const hostname = stripBrackets(parsed.hostname.toLowerCase());

  // If already validated as IP literal, no DNS lookup needed
  if (net.isIP(hostname)) {
    return parsed;
  }

  // Resolve hostname and check all returned records against private/loopback ranges
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true });
    for (const record of addresses) {
      if (isDisallowedIp(record.address)) {
        throw new Error(
          `OUTBOUND_GUARD_BLOCKED: Domain ${hostname} resolved to prohibited IP: ${record.address}`
        );
      }
    }
  } catch (err: any) {
    if (err.message.startsWith('OUTBOUND_GUARD_BLOCKED')) {
      throw err;
    }
    throw new Error(`OUTBOUND_GUARD_BLOCKED: DNS resolution failed for ${hostname}: ${err.message}`);
  }

  return parsed;
}
