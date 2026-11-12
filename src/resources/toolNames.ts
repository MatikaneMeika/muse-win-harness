/**
 * Exposed tool-name sanitization for third-party MCP tools.
 *
 * MCP transports accept arbitrary tool names (slashes, dots, CJK ...), but the
 * aggregated `/mcp` surface must only ever emit legal identifiers and must
 * never shadow a built-in MUSE tool. Format: `{serverId}_{originalName}` with
 * every non `[A-Za-z0-9_-]` character replaced by `_`; over-long results are
 * truncated with a short stable suffix, and collisions get a numeric suffix.
 */

const ILLEGAL_CHARS = /[^A-Za-z0-9_-]/g;
export const MAX_EXPOSED_TOOL_NAME_LENGTH = 64;

/** Collapses illegal characters, trims separators, and guarantees a non-empty segment. */
export function sanitizeToolNameSegment(raw: string, fallback = 'tool'): string {
  const replaced = String(raw ?? '')
    .replace(ILLEGAL_CHARS, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '');
  return replaced.length > 0 ? replaced : fallback;
}

/** Stable short suffix so truncated names stay distinct. */
function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).slice(-4).padStart(4, '0');
}

/**
 * Builds the visible name for one remote tool. `reserved` carries every name
 * already taken (built-ins first, then previously exposed third-party tools);
 * the chosen name is NOT added to it — the caller owns that bookkeeping.
 */
export function makeExposedToolName(
  serverId: string,
  originalName: string,
  reserved: Set<string>
): string {
  const prefix = sanitizeToolNameSegment(serverId, 'mcp');
  const original = sanitizeToolNameSegment(originalName, 'tool');
  const separator = '_';
  const budget = MAX_EXPOSED_TOOL_NAME_LENGTH - prefix.length - separator.length;

  let base =
    original.length <= budget
      ? original
      : `${original.slice(0, Math.max(1, budget - 5))}_${shortHash(originalName)}`;

  let candidate = `${prefix}${separator}${base}`;
  if (!reserved.has(candidate)) return candidate;

  let counter = 2;
  while (reserved.has(`${candidate}_${counter}`)) {
    counter += 1;
  }
  return `${candidate}_${counter}`;
}

/** True when a name is already a legal protocol-level identifier. */
export function isLegalToolName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}
