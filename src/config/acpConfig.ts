/**
 * Global ACP (Agent Client Protocol) Configuration Manager
 * Persists and probes custom ACP profiles globally in %USERPROFILE%/.mwh/acp-profiles.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AcpConfig, AcpProfile } from '../types.js';

export class AcpConfigManager {
  private static instance: AcpConfigManager | null = null;
  /**
   * Probe command whitelist (fail-closed): letters, digits, space and the
   * path/punctuation set - _ . : \ / ( ). Blocks shell metacharacters,
   * control characters (not in the class), quotes and traversal dots ('..'
   * is rejected separately below). Length is capped at 2048.
   */
  private static readonly PROBE_COMMAND_REGEX = /^[A-Za-z0-9 \-_.:\\/()]+$/;
  private static readonly PROBE_COMMAND_MAX_LENGTH = 2048;
  private readonly configPath: string;
  private readonly probeCache = new Map<
    string,
    { available: boolean; path?: string; error?: string; expiresAt: number }
  >();

  private constructor(customPath?: string) {
    if (customPath) {
      this.configPath = customPath;
    } else {
      const homeDir = os.homedir() || process.env.USERPROFILE || process.env.HOME || '.';
      this.configPath = path.join(homeDir, '.mwh', 'acp-profiles.json');
    }
  }

  public static getInstance(customPath?: string): AcpConfigManager {
    if (!AcpConfigManager.instance || customPath) {
      AcpConfigManager.instance = new AcpConfigManager(customPath);
    }
    return AcpConfigManager.instance;
  }

  /**
   * For tests: reset singleton
   */
  public static resetInstance(): void {
    AcpConfigManager.instance = null;
  }

  public getConfigPath(): string {
    return this.configPath;
  }

  public getDefaultConfig(): AcpConfig {
    return {
      acp_enabled: true,
      acp_default_profile: '',
      acp_profiles: []
    };
  }

  /**
   * Loads the raw configuration from disk, creating empty default if not present.
   */
  public loadConfig(): AcpConfig {
    const fileExisted = fs.existsSync(this.configPath);
    try {
      if (fileExisted) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const config: AcpConfig = {
            acp_enabled: parsed.acp_enabled !== false,
            acp_default_profile: typeof parsed.acp_default_profile === 'string' ? parsed.acp_default_profile : '',
            acp_profiles: Array.isArray(parsed.acp_profiles) ? parsed.acp_profiles : []
          };

          return config;
        }
        // R2-m1: Valid JSON but wrong root shape (null/array/primitive) — backup before reset
        try {
          fs.copyFileSync(this.configPath, `${this.configPath}.corrupt-${Date.now()}`);
        } catch {}
      }
    } catch (err: any) {
      console.warn(`[WARN] Failed to read ACP config from ${this.configPath}: ${err.message}`);
      // R1-M10 & R3-m1: Back up the corrupt file once, then persist clean defaults so
      // subsequent loadConfig() calls self-heal instead of creating endless .corrupt-* copies.
      if (fileExisted) {
        try {
          fs.copyFileSync(this.configPath, `${this.configPath}.corrupt-${Date.now()}`);
        } catch {}
        const resetConfig = this.getDefaultConfig();
        try {
          this.saveConfig(resetConfig);
        } catch {}
        return resetConfig;
      }
    }

    const initial = this.getDefaultConfig();
    this.saveConfig(initial);
    return initial;
  }

  /**
   * Saves the configuration to disk atomically (write temp + rename, with direct write fallback on Windows lock).
   */
  public saveConfig(config: AcpConfig): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const serialized = JSON.stringify(config, null, 2);
      const tmpPath = `${this.configPath}.tmp.${process.pid}.${Date.now()}`;
      try {
        fs.writeFileSync(tmpPath, serialized, 'utf-8');
        fs.renameSync(tmpPath, this.configPath);
      } catch {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {}
        fs.writeFileSync(this.configPath, serialized, 'utf-8');
      }
    } catch (err: any) {
      console.error(`[ERROR] Failed to write ACP config to ${this.configPath}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Probes whether a command / executable exists.
   *
   * Fail-closed input validation: only whitelist characters are accepted
   * (alnum, space, - _ . : \ / ( )), length <= 2048, no '..' traversal
   * segments and no control/shell metacharacters. Path-like inputs must be
   * drive-letter paths (UNC or rooted-without-drive forms are rejected).
   * Downstream execution stays shell-free (execFileSync + where.exe + fs stat).
   */
  public probeCommand(cmd: string): { available: boolean; path?: string; error?: string } {
    const trimmed = typeof cmd === 'string' ? cmd.trim() : '';
    if (
      !trimmed ||
      trimmed.length > AcpConfigManager.PROBE_COMMAND_MAX_LENGTH ||
      trimmed.includes('..') ||
      !AcpConfigManager.PROBE_COMMAND_REGEX.test(trimmed)
    ) {
      return { available: false, error: 'INVALID_COMMAND' };
    }
    if ((trimmed.includes('\\') || trimmed.includes('/')) && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
      return { available: false, error: 'INVALID_COMMAND' };
    }

    const cached = this.probeCache.get(trimmed);
    if (cached && cached.expiresAt > Date.now()) {
      return { available: cached.available, path: cached.path, error: cached.error };
    }

    // 1. Direct path check (if it looks like a path with \ or /)
    if (trimmed.includes('\\') || trimmed.includes('/')) {
      try {
        if (fs.existsSync(trimmed)) {
          const stat = fs.statSync(trimmed);
          if (stat.isFile()) {
            // No path-module sink on untrusted input: the whitelist above already
            // forces trimmed to be a drive-letter absolute path, so it is returned
            // as-is (no intermediate path.resolve layer).
            this.probeCache.set(trimmed, {
              available: true,
              path: trimmed,
              expiresAt: Date.now() + 30000
            });
            return { available: true, path: trimmed };
          }
        }
      } catch {
        // Fall through
      }
    }

    // 2. PATH probe via where.exe on Windows
    try {
      const out = execFileSync('where.exe', [trimmed], {
        windowsHide: true,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      });

      // where.exe can return several lines (e.g. a .cmd shim next to a .exe).
      // Mirror cliAdapters.ts: prefer .exe, then .cmd/.bat, then the first line.
      const candidates = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const exePath = candidates.find((p) => p.toLowerCase().endsWith('.exe'));
      const scriptPath = candidates.find((p) => /\.(cmd|bat)$/i.test(p));
      const chosenPath = exePath || scriptPath || candidates[0];
      if (chosenPath && fs.existsSync(chosenPath)) {
        this.probeCache.set(trimmed, {
          available: true,
          path: chosenPath,
          expiresAt: Date.now() + 30000
        });
        return { available: true, path: chosenPath };
      }
    } catch {
      // not in PATH
    }

    const errMsg = 'Command not found in PATH or filesystem';
    this.probeCache.set(trimmed, {
      available: false,
      error: errMsg,
      expiresAt: Date.now() + 10000
    });
    return { available: false, error: errMsg };
  }

  /**
   * Probes a single profile and returns a decorated copy.
   */
  public probeProfile(profile: AcpProfile): AcpProfile {
    const probeRes = this.probeCommand(profile.command);
    return {
      ...profile,
      detected: probeRes.available,
      binaryPath: probeRes.path || profile.command,
      error: probeRes.error
    };
  }

  /**
   * Returns all profiles with real-time detection status.
   */
  public getProbedProfiles(): AcpProfile[] {
    const config = this.loadConfig();
    return config.acp_profiles.map((p: AcpProfile) => this.probeProfile(p));
  }

  /**
   * Retrieves a specific profile by ID (probed).
   */
  public getProfile(id: string): AcpProfile | undefined {
    const profiles = this.getProbedProfiles();
    return profiles.find((p: AcpProfile) => p.id.toLowerCase() === id.toLowerCase());
  }

  /**
   * Resolves a profile by id or the 'acp' default alias.
   * Returns a probed copy, or undefined when nothing matches.
   */
  public resolveProfile(idOrAlias?: string): AcpProfile | undefined {
    const config = this.loadConfig();
    const profiles = config.acp_profiles.filter((p: AcpProfile) => p && typeof p === 'object');
    const findById = (id: string): AcpProfile | undefined =>
      profiles.find((p: AcpProfile) => String(p.id || '').toLowerCase() === id.trim().toLowerCase());
    const isEnabled = (p: AcpProfile): boolean => p.enabled !== false;
    const firstEnabled = (): AcpProfile | undefined => profiles.find((p: AcpProfile) => isEnabled(p));
    const firstEnabledProbed = (): AcpProfile | undefined =>
      profiles.filter((p: AcpProfile) => isEnabled(p)).find((p: AcpProfile) => this.probeProfile(p).detected === true);
    const defaultProfile = (): AcpProfile | undefined => {
      const wanted = String(config.acp_default_profile || '').trim();
      if (!wanted) return undefined;
      const found = findById(wanted);
      return found && isEnabled(found) ? found : undefined;
    };
    const pick = (p?: AcpProfile): AcpProfile | undefined => (p ? this.probeProfile(p) : undefined);

    const alias = String(idOrAlias || '').trim();
    const lower = alias.toLowerCase();

    if (!alias || lower === 'acp') {
      return pick(defaultProfile() || firstEnabledProbed() || firstEnabled());
    }

    return pick(findById(alias));
  }

  /**
   * Upserts (adds or edits) an ACP profile.
   * If exists, updates fields; if not, appends.
   */
  public upsertProfile(profile: Partial<AcpProfile> & { id: string; command: string }): {
    success: boolean;
    profile?: AcpProfile;
    error?: string;
  } {
    const id = (profile.id || '').trim();
    if (!id) {
      return { success: false, error: 'Profile ID cannot be empty' };
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(id)) {
      return { success: false, error: 'Profile ID must only contain letters, numbers, hyphens, and underscores' };
    }

    const command = (profile.command || '').trim();
    if (!command) {
      return { success: false, error: 'Command cannot be empty' };
    }

    const config = this.loadConfig();
    const existingIndex = config.acp_profiles.findIndex((p: AcpProfile) => p.id.toLowerCase() === id.toLowerCase());

    const cleanProfile: AcpProfile = {
      id,
      display_name: (profile.display_name || '').trim() || id,
      kind: profile.kind || 'custom',
      command,
      args: Array.isArray(profile.args) ? profile.args.map((a: string) => String(a).trim()).filter(Boolean) : [],
      env: profile.env && typeof profile.env === 'object' ? profile.env : {},
      enabled: profile.enabled !== false,
      envAllowlist: Array.isArray(profile.envAllowlist)
        ? profile.envAllowlist.map((s: string) => String(s).trim()).filter(Boolean)
        : undefined,
      permissionPolicy: profile.permissionPolicy,
      disposeEofGraceMs: profile.disposeEofGraceMs,
      disposeGraceMs: profile.disposeGraceMs
    };

    if (existingIndex >= 0) {
      config.acp_profiles[existingIndex] = cleanProfile;
    } else {
      config.acp_profiles.push(cleanProfile);
    }

    // If default profile is empty, set it to the first enabled one
    if (!config.acp_default_profile && cleanProfile.enabled) {
      config.acp_default_profile = cleanProfile.id;
    }

    this.saveConfig(config);
    return { success: true, profile: this.probeProfile(cleanProfile) };
  }

  /**
   * Deletes an ACP profile by ID.
   */
  public deleteProfile(id: string): { success: boolean; error?: string } {
    const trimmedId = (id || '').trim().toLowerCase();
    if (!trimmedId) {
      return { success: false, error: 'Invalid profile ID' };
    }

    const config = this.loadConfig();
    const initialLen = config.acp_profiles.length;
    config.acp_profiles = config.acp_profiles.filter((p: AcpProfile) => p.id.toLowerCase() !== trimmedId);

    if (config.acp_profiles.length === initialLen) {
      return { success: false, error: `Profile '${id}' not found` };
    }

    if ((config.acp_default_profile || '').toLowerCase() === trimmedId) {
      config.acp_default_profile = config.acp_profiles.find((p: AcpProfile) => p.enabled)?.id || '';
    }

    this.saveConfig(config);
    return { success: true };
  }

  /**
   * Toggles the enabled state of a profile.
   */
  public toggleProfile(id: string, enabled?: boolean): {
    success: boolean;
    profile?: AcpProfile;
    error?: string;
  } {
    const trimmedId = (id || '').trim().toLowerCase();
    const config = this.loadConfig();
    const target = config.acp_profiles.find((p: AcpProfile) => p.id.toLowerCase() === trimmedId);

    if (!target) {
      return { success: false, error: 'UNKNOWN_PROFILE' };
    }

    target.enabled = enabled !== undefined ? enabled : !target.enabled;
    this.saveConfig(config);
    return { success: true, profile: this.probeProfile(target) };
  }

  /**
   * Sets the default ACP profile.
   */
  public setDefaultProfile(id: string): { success: boolean; error?: string } {
    const config = this.loadConfig();
    if (id) {
      const exists = config.acp_profiles.some((p: AcpProfile) => p.id.toLowerCase() === id.trim().toLowerCase());
      if (!exists) {
        return { success: false, error: `Profile '${id}' does not exist` };
      }
    }
    config.acp_default_profile = id.trim();
    this.saveConfig(config);
    return { success: true };
  }

  /**
   * Toggles global ACP capability switch.
   */
  public setAcpEnabled(enabled: boolean): void {
    const config = this.loadConfig();
    config.acp_enabled = enabled;
    this.saveConfig(config);
  }
}
