import {
  closeSync,
  linkSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { getAppHome } from '../paths.js';
import { isProcessAlive, atomicWriteFile } from '../codex/session.js';

const require = createRequire(import.meta.url);

export const MODEL_PREFERENCES_KEY = 'antigravityUnifiedStateSync.modelPreferences';
export const JETSKI_CLOUD_CODE_URL_KEY = 'jetski.cloudCodeUrl';

export interface ExistingIdeLock {
  pid: number;
  profileDir: string;
  startedAt: string;
}

export interface ExistingIdeRecoveryRecord {
  pid: number;
  profileDir: string;
  startedAt: string;
  gatewayUrl: string;
  settingsPath: string;
  backupSettingsPath?: string;
  originalSettingsSha256?: string;
  patchedSettingsSha256?: string;
  originalGatewayUrl?: string | null;
  /** Whether jetski.cloudCodeUrl existed originally */
  hadGatewayUrl: boolean;
  /** Saved SQLite modelPreferences row, if ItemTable existed */
  savedModelPreferencesRow?: {
    existed: boolean;
    valueType?: 'string' | 'blob' | 'null' | 'number';
    value?: string; // hex string if blob
  };
  sqliteDbPath?: string;
}

export interface RestoreExistingIdeSessionResult {
  restored: boolean;
  message?: string;
  warnings?: string[];
  liveSession?: boolean;
}

export function getAntigravityHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAppHome(env), 'antigravity');
}

export function getExistingIdeLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAntigravityHome(env), 'existing-ide-session.json');
}

export function getExistingIdeRecoveryRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAntigravityHome(env), 'existing-ide-recovery.json');
}

export function fileSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function readExistingIdeLock(env: NodeJS.ProcessEnv = process.env): ExistingIdeLock | null {
  const lockPath = getExistingIdeLockPath(env);
  if (!existsSync(lockPath)) return null;
  const rawText = readFileSync(lockPath, 'utf8');
  if (rawText.trim().length === 0) {
    throw new Error(`Lock file at ${lockPath} is currently empty or in the process of being created.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Malformed Antigravity IDE session lock at ${lockPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lock = parsed as ExistingIdeLock;
  if (!lock || typeof lock.pid !== 'number' || typeof lock.profileDir !== 'string') {
    throw new Error(`Malformed Antigravity IDE session lock at ${lockPath}: missing required fields (pid, profileDir)`);
  }
  return lock;
}

export function writeExistingIdeLock(lock: ExistingIdeLock, env: NodeJS.ProcessEnv = process.env): void {
  atomicWriteFile(getExistingIdeLockPath(env), `${JSON.stringify(lock, null, 2)}\n`);
}

export function clearExistingIdeLock(env: NodeJS.ProcessEnv = process.env): void {
  const p = getExistingIdeLockPath(env);
  if (existsSync(p)) rmSync(p, { force: true });
}

export function readExistingIdeRecoveryRecord(env: NodeJS.ProcessEnv = process.env): ExistingIdeRecoveryRecord | null {
  const recordPath = getExistingIdeRecoveryRecordPath(env);
  if (!existsSync(recordPath)) return null;
  const rawText = readFileSync(recordPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Malformed Antigravity IDE recovery record at ${recordPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const record = parsed as ExistingIdeRecoveryRecord;
  if (!record || typeof record.pid !== 'number' || typeof record.profileDir !== 'string') {
    throw new Error(`Malformed Antigravity IDE recovery record at ${recordPath}: missing required fields (pid, profileDir)`);
  }
  return record;
}

export function writeExistingIdeRecoveryRecord(record: ExistingIdeRecoveryRecord, env: NodeJS.ProcessEnv = process.env): void {
  atomicWriteFile(getExistingIdeRecoveryRecordPath(env), `${JSON.stringify(record, null, 2)}\n`);
}

export function clearExistingIdeRecoveryRecord(env: NodeJS.ProcessEnv = process.env): void {
  const p = getExistingIdeRecoveryRecordPath(env);
  if (existsSync(p)) rmSync(p, { force: true });
}

export function assertNoActiveExistingIdeSession(env: NodeJS.ProcessEnv = process.env): void {
  const lock = readExistingIdeLock(env);
  if (lock && lock.pid !== process.pid && isProcessAlive(lock.pid)) {
    throw new Error(`Another relay-ai antigravity-ide session is running (pid ${lock.pid}). Close it first.`);
  }
}

/** Publish a complete lock atomically; serialize stale-lock reclamation. */
export function acquireExistingIdeSession(
  profileDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { recovery?: boolean } = {},
): { lock: ExistingIdeLock; release: () => void } {
  const lockPath = getExistingIdeLockPath(env);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock: ExistingIdeLock = { pid: process.pid, profileDir, startedAt: new Date().toISOString() };
  const tempPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(lock), { mode: 0o600, flag: 'wx' });
  const publish = () => linkSync(tempPath, lockPath);
  try {
    try { publish(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const guardPath = `${lockPath}.reclaim`;
      let guard: number;
      try { guard = openSync(guardPath, 'wx', 0o600); } catch (error) {
        throw new Error(`Cannot acquire the recovery guard at ${guardPath}. Another recovery may be running. If that process has exited, remove this guard file and retry --restore.`, { cause: error });
      }
      try {
        const existing = readExistingIdeLock(env);
        if (existing?.pid === process.pid) {
          if (existing.profileDir !== profileDir) throw new Error('This Relay process already owns another IDE profile.');
        } else {
          if (existing && isProcessAlive(existing.pid)) throw new Error(`Another relay-ai antigravity-ide session is running (pid ${existing.pid}). Close it first.`);
          if (readExistingIdeRecoveryRecord(env) && !options.recovery) throw new Error('An interrupted IDE session needs recovery. Run relay-ai antigravity-ide --restore.');
          if (existing) unlinkSync(lockPath);
          publish();
        }
      } finally {
        closeSync(guard);
        rmSync(guardPath, { force: true });
      }
    }
  } finally { rmSync(tempPath, { force: true }); }
  return { lock, release: () => releaseEmptyExistingIdeSession(env) };
}

export function releaseEmptyExistingIdeSession(env: NodeJS.ProcessEnv = process.env): void {
  if (existsSync(getExistingIdeRecoveryRecordPath(env))) return;
  try {
    const lock = readExistingIdeLock(env);
    if (lock && lock.pid === process.pid) {
      clearExistingIdeLock(env);
    }
  } catch {
    // ignore
  }
}

export function checkNodeSqliteAvailable(): void {
  const originalEmitWarning = process.emitWarning;
  try {
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === 'string' ? warning : warning.message;
      if (text.includes('SQLite')) return;
      (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    const sqlite = require('node:sqlite') as typeof import('node:sqlite');
    if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
      throw new Error('node:sqlite is unavailable or does not export DatabaseSync');
    }
  } catch (err) {
    throw new Error(`Node.js SQLite support (node:sqlite) is required for --use-existing-profile, but is unavailable: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function readSqliteModelPreferences(dbPath: string): {
  existed: boolean;
  valueType?: 'string' | 'blob' | 'null' | 'number';
  value?: string;
} | undefined {
  if (!existsSync(dbPath)) return undefined;
  const originalEmitWarning = process.emitWarning;
  try {
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === 'string' ? warning : warning.message;
      if (text.includes('SQLite')) return;
      (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(MODEL_PREFERENCES_KEY) as { value?: unknown } | undefined;
      if (row === undefined) return { existed: false };
      const val = row.value;
      if (typeof val === 'string') {
        return { existed: true, valueType: 'string', value: val };
      }
      if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
        return { existed: true, valueType: 'blob', value: Buffer.from(val).toString('hex') };
      }
      if (typeof val === 'number') {
        return { existed: true, valueType: 'number', value: String(val) };
      }
      if (val === null) {
        return { existed: true, valueType: 'null' };
      }
      return { existed: true, valueType: 'string', value: String(val) };
    } finally {
      db.close();
    }
  } catch (err) {
    throw new Error(`Failed to inspect state.vscdb: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function clearSqliteModelPreferencesRow(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const originalEmitWarning = process.emitWarning;
  try {
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === 'string' ? warning : warning.message;
      if (text.includes('SQLite')) return;
      (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('DELETE FROM ItemTable WHERE key = ?').run(MODEL_PREFERENCES_KEY);
    } finally {
      db.close();
    }
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function restoreSqliteModelPreferences(
  dbPath: string,
  saved: { existed: boolean; valueType?: 'string' | 'blob' | 'null' | 'number'; value?: string },
): void {
  if (!existsSync(dbPath)) return;
  const originalEmitWarning = process.emitWarning;
  try {
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === 'string' ? warning : warning.message;
      if (text.includes('SQLite')) return;
      (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      if (!saved.existed) {
        db.prepare('DELETE FROM ItemTable WHERE key = ?').run(MODEL_PREFERENCES_KEY);
        return;
      }
      type SQLParam = string | number | bigint | null | Uint8Array;
      let insertVal: SQLParam = null;
      if (saved.valueType === 'blob' && saved.value !== undefined) {
        insertVal = Buffer.from(saved.value, 'hex');
      } else if (saved.valueType === 'number' && saved.value !== undefined) {
        insertVal = Number(saved.value);
      } else if (saved.valueType === 'string' && saved.value !== undefined) {
        insertVal = String(saved.value);
      }
      (db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)') as any).run(MODEL_PREFERENCES_KEY, insertVal);
    } finally {
      db.close();
    }
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

export function beginExistingIdeSession(
  profileDir: string,
  gatewayUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): ExistingIdeRecoveryRecord {
  if (readExistingIdeRecoveryRecord(env)) throw new Error('An IDE session needs restoration before another overlay can be applied.');
  // 1. Preflight check: Node SQLite must be supported before anything is touched
  checkNodeSqliteAvailable();

  // 2. Lock check/acquire (exclusive)
  acquireExistingIdeSession(profileDir, env);

  const userDir = join(profileDir, 'User');
  mkdirSync(userDir, { recursive: true });
  const settingsPath = join(userDir, 'settings.json');

  let originalSettingsSha256: string | undefined;
  let backupSettingsPath: string | undefined;
  let originalContent = '';
  let hadSettingsFile = false;
  let originalGatewayUrl: string | null = null;
  let hadGatewayUrl = false;

  if (existsSync(settingsPath)) {
    hadSettingsFile = true;
    originalContent = readFileSync(settingsPath, 'utf8');
    const errors: ParseError[] = [];
    const parsedObj = parse(originalContent, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
    if (errors.length > 0 || (originalContent.trim().length > 0 && (!parsedObj || typeof parsedObj !== 'object' || Array.isArray(parsedObj)))) {
      throw new Error(`Cannot patch malformed settings.json at ${settingsPath}. Please fix JSON syntax errors.`);
    }
    if (parsedObj && typeof parsedObj === 'object' && JETSKI_CLOUD_CODE_URL_KEY in parsedObj) {
      hadGatewayUrl = true;
      originalGatewayUrl = (parsedObj[JETSKI_CLOUD_CODE_URL_KEY] as string) ?? null;
    }

    originalSettingsSha256 = fileSha256(settingsPath);
    const backupsDir = join(getAntigravityHome(env), 'backups');
    mkdirSync(backupsDir, { recursive: true });
    backupSettingsPath = join(backupsDir, `settings.${Date.now()}.bak`);
    atomicWriteFile(backupSettingsPath, originalContent);
  }

  // 3. SQLite model preferences read (without clearing yet)
  const dbPath = join(userDir, 'globalStorage', 'state.vscdb');
  let savedModelPref: { existed: boolean; valueType?: 'string' | 'blob' | 'null' | 'number'; value?: string } | undefined;
  if (existsSync(dbPath)) {
    savedModelPref = readSqliteModelPreferences(dbPath);
  }

  // 4. Record state BEFORE mutating DB or settings file
  const record: ExistingIdeRecoveryRecord = {
    pid: process.pid,
    profileDir,
    startedAt: new Date().toISOString(),
    gatewayUrl,
    settingsPath,
    backupSettingsPath,
    originalSettingsSha256,
    originalGatewayUrl,
    hadGatewayUrl,
    savedModelPreferencesRow: savedModelPref,
    sqliteDbPath: existsSync(dbPath) ? dbPath : undefined,
  };
  writeExistingIdeRecoveryRecord(record, env);

  // 5. Now safely clear DB row
  if (existsSync(dbPath) && savedModelPref?.existed) {
    clearSqliteModelPreferencesRow(dbPath);
  }

  // 6. Apply surgical JSONC edit
  let newContent = '';
  if (!hadSettingsFile || originalContent.trim().length === 0) {
    newContent = JSON.stringify({ [JETSKI_CLOUD_CODE_URL_KEY]: gatewayUrl }, null, 2) + '\n';
  } else {
    const edits = modify(originalContent, [JETSKI_CLOUD_CODE_URL_KEY], gatewayUrl, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    newContent = applyEdits(originalContent, edits);
  }

  atomicWriteFile(settingsPath, newContent);
  record.patchedSettingsSha256 = fileSha256(settingsPath);
  writeExistingIdeRecoveryRecord(record, env);

  return record;
}

export function restoreExistingIdeSession(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowOwnPid?: boolean } = {},
): RestoreExistingIdeSessionResult {
  const warnings: string[] = [];
  const allowOwn = options.allowOwnPid ?? false;

  let lock: ExistingIdeLock | null = null;
  try {
    lock = readExistingIdeLock(env);
  } catch (err) {
    return {
      restored: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (lock && (!allowOwn || lock.pid !== process.pid) && isProcessAlive(lock.pid)) {
    return {
      restored: false,
      liveSession: true,
      message: `Another relay-ai antigravity-ide session is running (pid ${lock.pid}). Close it first, then run --restore.`,
    };
  }

  let record: ExistingIdeRecoveryRecord | null = null;
  try {
    record = readExistingIdeRecoveryRecord(env);
  } catch (err) {
    return {
      restored: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!record && !lock) {
    return { restored: false, message: 'Nothing to restore.' };
  }

  if (record) {
    const { settingsPath, backupSettingsPath, originalSettingsSha256, patchedSettingsSha256, hadGatewayUrl, originalGatewayUrl, gatewayUrl } = record;

    if (existsSync(settingsPath)) {
      const currentSha = fileSha256(settingsPath);
      // Case A: exact match with what Relay patched, and backup file hash verified
      const backupValid = Boolean(
        backupSettingsPath
        && existsSync(backupSettingsPath)
        && originalSettingsSha256
        && fileSha256(backupSettingsPath) === originalSettingsSha256
      );

      if (patchedSettingsSha256 && currentSha === patchedSettingsSha256 && backupValid) {
        const backupContent = readFileSync(backupSettingsPath!, 'utf8');
        atomicWriteFile(settingsPath, backupContent);
      } else if (!record.originalSettingsSha256 && currentSha === patchedSettingsSha256) {
        // File was created by Relay from scratch and untouched
        rmSync(settingsPath, { force: true });
      } else {
        // Case B: settings were edited or modified by user/IDE during the session,
        // or a crash happened before patchedSettingsSha256 was computed.
        try {
          const currentContent = readFileSync(settingsPath, 'utf8');
          const errors: ParseError[] = [];
          const parsed = parse(currentContent, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
          if (errors.length > 0 || (currentContent.trim().length > 0 && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)))) {
            return {
              restored: false,
              message: `Cannot restore settings.json at ${settingsPath} because it contains syntax errors. Fix them, then run --restore. Recovery files were retained.`,
            };
          }

          if (parsed && typeof parsed === 'object') {
            const currentGw = parsed[JETSKI_CLOUD_CODE_URL_KEY];
            // If the file was originally created by Relay, but has no other settings now, remove it
            if (!record.originalSettingsSha256 && Object.keys(parsed).length === 1 && currentGw === gatewayUrl) {
              rmSync(settingsPath, { force: true });
            } else if (currentGw !== undefined && currentGw !== gatewayUrl) {
              // User deliberately modified the gateway setting during the session
              warnings.push(`jetski.cloudCodeUrl was modified to "${currentGw}" during the session; preserved user change.`);
            } else if (currentGw !== undefined) {
              const edits = hadGatewayUrl
                ? modify(currentContent, [JETSKI_CLOUD_CODE_URL_KEY], originalGatewayUrl, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
                : modify(currentContent, [JETSKI_CLOUD_CODE_URL_KEY], undefined, {});
              const restoredContent = applyEdits(currentContent, edits);
              atomicWriteFile(settingsPath, restoredContent);
            }
          }
        } catch (err) {
          return {
            restored: false,
            message: `Failed to revert settings.json: ${err instanceof Error ? err.message : String(err)}. Recovery files were retained.`,
          };
        }
      }
    }

    // Restore SQLite modelPreferences row
    if (record.sqliteDbPath && record.savedModelPreferencesRow && existsSync(record.sqliteDbPath)) {
      try {
        restoreSqliteModelPreferences(record.sqliteDbPath, record.savedModelPreferencesRow);
      } catch (err) {
        return {
          restored: false,
          message: `Failed to restore SQLite modelPreferences: ${err instanceof Error ? err.message : String(err)}. Recovery files were retained.`,
        };
      }
    }
  }

  clearExistingIdeRecoveryRecord(env);
  clearExistingIdeLock(env);

  return {
    restored: true,
    message: 'Restored Antigravity IDE configuration.',
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

