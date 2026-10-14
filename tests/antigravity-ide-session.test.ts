import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  beginExistingIdeSession,
  restoreExistingIdeSession,
  acquireExistingIdeSession,
  releaseEmptyExistingIdeSession,
  readExistingIdeLock,
  readExistingIdeRecoveryRecord,
  assertNoActiveExistingIdeSession,
  JETSKI_CLOUD_CODE_URL_KEY,
  writeExistingIdeLock,
  MODEL_PREFERENCES_KEY,
  writeExistingIdeRecoveryRecord,
} from '../src/antigravity/ide-session.js';

const require = createRequire(import.meta.url);

describe('ide-session', () => {
  let tempDir: string;
  let testEnv: NodeJS.ProcessEnv;
  let profileDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'relay-ai-test-ide-session-'));
    testEnv = { RELAY_AI_HOME: join(tempDir, '.relay-ai') };
    profileDir = join(tempDir, 'profile');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('acquires and releases empty session lock', () => {
    const handle = acquireExistingIdeSession(profileDir, testEnv);
    expect(readExistingIdeLock(testEnv)?.pid).toBe(process.pid);
    handle.release();
    expect(readExistingIdeLock(testEnv)).toBeNull();
  });

  it('rejects begin when another process owns the lock', () => {
    // Write fake lock for another process (pid 1 usually exists / is init/launchd)
    
    writeExistingIdeLock({ pid: process.ppid, profileDir, startedAt: new Date().toISOString() }, testEnv);

    expect(() => beginExistingIdeSession(profileDir, 'http://127.0.0.1:9999', testEnv))
      .toThrow(/Another relay-ai antigravity-ide session is running/);
  });

  it('patches settings.json surgically and restores exact backup if untouched', () => {
    const userDir = join(profileDir, 'User');
    mkdirSync(userDir, { recursive: true });
    const settingsPath = join(userDir, 'settings.json');
    const initialSettings = '// User comments\n{\n  // My theme\n  "workbench.colorTheme": "Default Dark+",\n  "editor.fontSize": 14,\n}';
    writeFileSync(settingsPath, initialSettings, 'utf8');

    const record = beginExistingIdeSession(profileDir, 'http://127.0.0.1:54321', testEnv);
    expect(record.pid).toBe(process.pid);

    const patched = readFileSync(settingsPath, 'utf8');
    expect(patched).toContain('jetski.cloudCodeUrl');
    expect(patched).toContain('54321');
    expect(patched).toContain('// User comments');
    expect(patched).toContain('// My theme');

    const restoreRes = restoreExistingIdeSession(testEnv, { allowOwnPid: true });
    expect(restoreRes.restored).toBe(true);

    const restored = readFileSync(settingsPath, 'utf8');
    expect(restored).toBe(initialSettings);
  });

  it('preserves unrelated settings changes made during the session', () => {
    const userDir = join(profileDir, 'User');
    mkdirSync(userDir, { recursive: true });
    const settingsPath = join(userDir, 'settings.json');
    writeFileSync(settingsPath, '{\n  "editor.tabSize": 2\n}', 'utf8');

    beginExistingIdeSession(profileDir, 'http://127.0.0.1:54321', testEnv);

    // User modifies an unrelated setting while relay is running
    const current = readFileSync(settingsPath, 'utf8');
    const modified = current.replace('"editor.tabSize": 2', '"editor.tabSize": 4');
    writeFileSync(settingsPath, modified, 'utf8');

    const restoreRes = restoreExistingIdeSession(testEnv, { allowOwnPid: true });
    expect(restoreRes.restored).toBe(true);

    const restored = readFileSync(settingsPath, 'utf8');
    expect(restored).toContain('"editor.tabSize": 4');
    expect(restored).not.toContain('jetski.cloudCodeUrl');
  });

  it('warns and preserves user edit to jetski.cloudCodeUrl', () => {
    const userDir = join(profileDir, 'User');
    mkdirSync(userDir, { recursive: true });
    const settingsPath = join(userDir, 'settings.json');
    writeFileSync(settingsPath, '{\n  "editor.tabSize": 2\n}', 'utf8');

    beginExistingIdeSession(profileDir, 'http://127.0.0.1:54321', testEnv);

    // User modified the gateway URL themselves
    const current = readFileSync(settingsPath, 'utf8');
    const modified = current.replace('http://127.0.0.1:54321', 'https://custom-gateway.local');
    writeFileSync(settingsPath, modified, 'utf8');

    const restoreRes = restoreExistingIdeSession(testEnv, { allowOwnPid: true });
    expect(restoreRes.restored).toBe(true);
    expect(restoreRes.warnings).toBeDefined();
    expect(restoreRes.warnings![0]).toContain('preserved user change');

    const restored = readFileSync(settingsPath, 'utf8');
    expect(restored).toContain('https://custom-gateway.local');
  });

  it('saves, clears, and restores SQLite modelPreferences row', () => {
    const userDir = join(profileDir, 'User');
    const dbDir = join(userDir, 'globalStorage');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, 'state.vscdb');

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(MODEL_PREFERENCES_KEY, '{"model":"original-model"}');
    db.close();

    beginExistingIdeSession(profileDir, 'http://127.0.0.1:54321', testEnv);

    // Verify row was cleared
    const dbCheck = new DatabaseSync(dbPath);
    const row = dbCheck.prepare('SELECT value FROM ItemTable WHERE key = ?').get(MODEL_PREFERENCES_KEY);
    expect(row).toBeUndefined();
    dbCheck.close();

    // Restore
    restoreExistingIdeSession(testEnv, { allowOwnPid: true });

    // Verify row was restored
    const dbRestored = new DatabaseSync(dbPath);
    const restoredRow = dbRestored.prepare('SELECT value FROM ItemTable WHERE key = ?').get(MODEL_PREFERENCES_KEY) as any;
    expect(restoredRow.value).toBe('{"model":"original-model"}');
    dbRestored.close();
  });

  it('retains recovery state when user settings become malformed', () => {
    const record = beginExistingIdeSession(profileDir, 'http://127.0.0.1:54321', testEnv);
    writeFileSync(record.settingsPath, '{ invalid');
    expect(restoreExistingIdeSession(testEnv, { allowOwnPid: true }).restored).toBe(false);
    expect(readExistingIdeRecoveryRecord(testEnv)).not.toBeNull();
    expect(readExistingIdeLock(testEnv)).not.toBeNull();
  });

  it('recovers a crash between settings write and saving its hash', () => {
    const record = beginExistingIdeSession(profileDir, 'http://127.0.0.1:54321', testEnv);
    delete record.patchedSettingsSha256;
    writeExistingIdeRecoveryRecord(record, testEnv);
    expect(restoreExistingIdeSession(testEnv, { allowOwnPid: true }).restored).toBe(true);
    expect(existsSync(record.settingsPath)).toBe(false);
  });

  it('reclaims a dead owner for recovery without losing its record', () => {
    const record = beginExistingIdeSession(profileDir, 'http://127.0.0.1:54321', testEnv);
    writeExistingIdeLock({ pid: 2147483647, profileDir, startedAt: record.startedAt }, testEnv);
    expect(() => acquireExistingIdeSession(profileDir, testEnv)).toThrow('recovery');
    acquireExistingIdeSession(profileDir, testEnv, { recovery: true });
    expect(readExistingIdeRecoveryRecord(testEnv)).not.toBeNull();
    expect(restoreExistingIdeSession(testEnv, { allowOwnPid: true }).restored).toBe(true);
  });

  it('restores an original null gateway value while preserving other edits', () => {
    mkdirSync(join(profileDir, 'User'), { recursive: true });
    const settings = join(profileDir, 'User', 'settings.json');
    writeFileSync(settings, '{"jetski.cloudCodeUrl":null,"editor.tabSize":2}');
    beginExistingIdeSession(profileDir, 'http://127.0.0.1:54321', testEnv);
    writeFileSync(settings, readFileSync(settings, 'utf8').replace('"editor.tabSize":2', '"editor.tabSize":4'));
    expect(restoreExistingIdeSession(testEnv, { allowOwnPid: true }).restored).toBe(true);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ 'jetski.cloudCodeUrl': null, 'editor.tabSize': 4 });
  });
});

