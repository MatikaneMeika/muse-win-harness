/**
 * DPAPI-backed Secret Store for Muse-Win-Harness (.mwh/secrets.json)
 *
 * Encrypts persisted credentials (`token`, `signingKey`, `cookieSecret`, and
 * token lifecycle metadata) at rest using Win32 `crypt32.dll`
 * `CryptProtectData` / `CryptUnprotectData` bound to the current Windows user
 * SID (`CRYPTPROTECT_UI_FORBIDDEN = 0x1`). Zero external npm dependencies
 * beyond `koffi`.
 *
 * Compatibility & Migration:
 * - Reads both v2 DPAPI envelopes (`schema: "mwh-secrets/v2-dpapi"`) and
 *   legacy v1 plaintext `.mwh/secrets.json` files (`{ token, signingKey }`).
 * - Writes exclusively in `mwh-secrets/v2-dpapi` format on Windows using an
 *   atomic temp-file + rename pattern so legacy plaintext files are
 *   transparently upgraded on first save.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import koffi from 'koffi';

export const SECRETS_SCHEMA_V2 = 'mwh-secrets/v2-dpapi';
export const DEFAULT_TOKEN_TTL_DAYS = 30;
export const DEFAULT_TOKEN_TTL_MS = DEFAULT_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export interface PersistedSecrets {
  token: string;
  signingKey: string;
  cookieSecret: string;
  createdAt: string;
  updatedAt: string;
  tokenExpiresAt: number;
  /** True if loaded from legacy plaintext format that should be upgraded on disk. */
  legacyPlaintext?: boolean;
}

interface DpapiFunctions {
  CryptProtectData: (...args: any[]) => number;
  CryptUnprotectData: (...args: any[]) => number;
  LocalFree: (ptr: unknown) => unknown;
}

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
let cachedDpapi: DpapiFunctions | null | undefined;

function getDpapi(): DpapiFunctions | null {
  if (cachedDpapi !== undefined) return cachedDpapi;
  if (process.platform !== 'win32') {
    cachedDpapi = null;
    return null;
  }
  try {
    try {
      koffi.struct('MWH_DATA_BLOB', {
        cbData: 'uint32',
        pbData: 'void *'
      });
    } catch {
      // Struct already registered in this process
    }
    const crypt32 = koffi.load('crypt32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const CryptProtectData = crypt32.func(
      'int __stdcall CryptProtectData(MWH_DATA_BLOB *pDataIn, const char16_t *szDataDescr, void *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ MWH_DATA_BLOB *pDataOut)'
    );
    const CryptUnprotectData = crypt32.func(
      'int __stdcall CryptUnprotectData(MWH_DATA_BLOB *pDataIn, void *ppszDataDescr, void *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ MWH_DATA_BLOB *pDataOut)'
    );
    const LocalFree = kernel32.func('void * __stdcall LocalFree(void *hMem)');
    cachedDpapi = { CryptProtectData, CryptUnprotectData, LocalFree };
    return cachedDpapi;
  } catch {
    cachedDpapi = null;
    return null;
  }
}

/**
 * Encrypts a UTF-8 string with Win32 DPAPI (current user scope) and returns Base64.
 */
export function dpapiProtectString(plaintext: string): string {
  const api = getDpapi();
  if (!api) {
    throw new Error('DPAPI_UNAVAILABLE: CryptProtectData is only available on Windows');
  }
  const inBuf = Buffer.from(plaintext, 'utf-8');
  const outBlob: { cbData?: number; pbData?: unknown } = {};
  const ok = api.CryptProtectData(
    { cbData: inBuf.length, pbData: inBuf },
    'MWH Secrets v2',
    null,
    null,
    null,
    CRYPTPROTECT_UI_FORBIDDEN,
    outBlob
  );
  if (!ok || !outBlob.pbData || !outBlob.cbData) {
    throw new Error('DPAPI_PROTECT_FAILED: CryptProtectData returned failure');
  }
  try {
    const raw = Buffer.from(koffi.decode(outBlob.pbData, 'uint8_t', outBlob.cbData));
    return raw.toString('base64');
  } finally {
    api.LocalFree(outBlob.pbData);
  }
}

/**
 * Decrypts a Base64 Win32 DPAPI blob back into a UTF-8 string.
 */
export function dpapiUnprotectString(cipherBase64: string): string {
  const api = getDpapi();
  if (!api) {
    throw new Error('DPAPI_UNAVAILABLE: CryptUnprotectData is only available on Windows');
  }
  const cipherBuf = Buffer.from(cipherBase64, 'base64');
  if (cipherBuf.length === 0) {
    throw new Error('DPAPI_UNPROTECT_EMPTY: Empty cipher payload');
  }
  const outBlob: { cbData?: number; pbData?: unknown } = {};
  const ok = api.CryptUnprotectData(
    { cbData: cipherBuf.length, pbData: cipherBuf },
    null,
    null,
    null,
    null,
    CRYPTPROTECT_UI_FORBIDDEN,
    outBlob
  );
  if (!ok || !outBlob.pbData || typeof outBlob.cbData !== 'number') {
    throw new Error('DPAPI_UNPROTECT_FAILED: CryptUnprotectData returned failure');
  }
  try {
    const plain = Buffer.from(koffi.decode(outBlob.pbData, 'uint8_t', outBlob.cbData));
    return plain.toString('utf-8');
  } finally {
    api.LocalFree(outBlob.pbData);
  }
}

/**
 * Resolves the configured token TTL in milliseconds from environment or default (30 days).
 */
export function resolveConfiguredTokenTtlMs(): number {
  const rawMs = Number(process.env.MWH_TOKEN_TTL_MS);
  if (Number.isFinite(rawMs) && rawMs > 0) {
    return Math.floor(rawMs);
  }
  const rawDays = Number(process.env.MWH_TOKEN_TTL_DAYS);
  if (Number.isFinite(rawDays) && rawDays > 0) {
    return Math.floor(rawDays * 24 * 60 * 60 * 1000);
  }
  return DEFAULT_TOKEN_TTL_MS;
}

export function resolveSecretsFilePath(workspaceRoot: string): string {
  return resolvePath(workspaceRoot, '.mwh', 'secrets.json');
}

/**
 * Loads `.mwh/secrets.json` from `workspaceRoot`.
 * Supports both `mwh-secrets/v2-dpapi` encrypted blobs and legacy v1 plaintext JSON.
 */
export function loadPersistedSecrets(workspaceRoot: string): PersistedSecrets | null {
  const filePath = resolveSecretsFilePath(workspaceRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    const rawText = fs.readFileSync(filePath, 'utf-8');
    const outer = JSON.parse(rawText);
    if (!outer || typeof outer !== 'object') return null;

    let payload: any = outer;
    let legacyPlaintext = true;

    if (typeof outer.dpapi === 'string' && outer.dpapi.trim().length > 0) {
      const decryptedJson = dpapiUnprotectString(outer.dpapi.trim());
      payload = JSON.parse(decryptedJson);
      legacyPlaintext = false;
    }

    const token =
      typeof payload?.token === 'string' && payload.token.trim().length >= 16
        ? payload.token.trim()
        : typeof payload?.runtimeToken === 'string' && payload.runtimeToken.trim().length >= 16
          ? payload.runtimeToken.trim()
          : '';
    const signingKey =
      typeof payload?.signingKey === 'string' && payload.signingKey.trim().length >= 32
        ? payload.signingKey.trim()
        : '';
    if (!token && !signingKey) return null;

    const cookieSecret =
      typeof payload?.cookieSecret === 'string' && payload.cookieSecret.trim().length >= 32
        ? payload.cookieSecret.trim()
        : crypto.randomBytes(32).toString('hex');

    const nowIso = new Date().toISOString();
    const createdAt = typeof payload?.createdAt === 'string' ? payload.createdAt : nowIso;
    const updatedAt =
      typeof payload?.updatedAt === 'string'
        ? payload.updatedAt
        : typeof outer?.updatedAt === 'string'
          ? outer.updatedAt
          : nowIso;
    const tokenExpiresAt =
      typeof payload?.tokenExpiresAt === 'number' && Number.isFinite(payload.tokenExpiresAt)
        ? payload.tokenExpiresAt
        : Date.now() + resolveConfiguredTokenTtlMs();

    return {
      token,
      signingKey,
      cookieSecret,
      createdAt,
      updatedAt,
      tokenExpiresAt,
      legacyPlaintext: legacyPlaintext || typeof payload?.cookieSecret !== 'string' || typeof payload?.tokenExpiresAt !== 'number'
    };
  } catch {
    return null;
  }
}

/**
 * Persists credentials into `.mwh/secrets.json` encrypted with Win32 DPAPI.
 * Merges with any existing secrets so partial updates (such as token rotation)
 * preserve `signingKey` and `createdAt`.
 */
export function savePersistedSecrets(
  workspaceRoot: string,
  patch: Partial<Omit<PersistedSecrets, 'legacyPlaintext'>>
): PersistedSecrets {
  const existing = loadPersistedSecrets(workspaceRoot);
  const nowIso = new Date().toISOString();
  const ttlMs = resolveConfiguredTokenTtlMs();

  const merged: PersistedSecrets = {
    token: patch.token ?? existing?.token ?? '',
    signingKey: patch.signingKey ?? existing?.signingKey ?? '',
    cookieSecret:
      patch.cookieSecret ??
      existing?.cookieSecret ??
      crypto.randomBytes(32).toString('hex'),
    createdAt: existing?.createdAt ?? patch.createdAt ?? nowIso,
    updatedAt: nowIso,
    tokenExpiresAt:
      typeof patch.tokenExpiresAt === 'number' && Number.isFinite(patch.tokenExpiresAt)
        ? patch.tokenExpiresAt
        : existing?.tokenExpiresAt && patch.token === undefined
          ? existing.tokenExpiresAt
          : Date.now() + ttlMs
  };

  const filePath = resolveSecretsFilePath(workspaceRoot);
  const dirPath = dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const innerJson = JSON.stringify({
    token: merged.token,
    signingKey: merged.signingKey,
    cookieSecret: merged.cookieSecret,
    createdAt: merged.createdAt,
    updatedAt: merged.updatedAt,
    tokenExpiresAt: merged.tokenExpiresAt
  });

  const dpapiBlob = dpapiProtectString(innerJson);
  const outerJson = JSON.stringify(
    {
      schema: SECRETS_SCHEMA_V2,
      dpapi: dpapiBlob,
      updatedAt: merged.updatedAt
    },
    null,
    2
  );

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, outerJson, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    fs.writeFileSync(filePath, outerJson, 'utf-8');
  }

  return merged;
}
