import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assert: vi.fn(), read: vi.fn(), acquire: vi.fn(), release: vi.fn(), restore: vi.fn(),
  running: vi.fn(), quit: vi.fn(), wait: vi.fn(), force: vi.fn(), catalog: vi.fn(),
}));
vi.mock('../src/antigravity/ide-session.js', () => ({
  assertNoActiveExistingIdeSession: mocks.assert,
  readExistingIdeRecoveryRecord: mocks.read,
  readExistingIdeLock: vi.fn().mockReturnValue(null),
  acquireExistingIdeSession: mocks.acquire,
  releaseEmptyExistingIdeSession: mocks.release,
  restoreExistingIdeSession: mocks.restore,
  beginExistingIdeSession: vi.fn(),
}));
vi.mock('../src/antigravity/launch-ide.js', () => ({
  isExistingAntigravityIdeRunning: mocks.running,
  quitExistingAntigravityIde: mocks.quit,
  waitForExistingAntigravityIdeQuit: mocks.wait,
  forceQuitExistingAntigravityIde: mocks.force,
}));
vi.mock('../src/provider-catalog.js', () => ({ fetchProviderCatalog: mocks.catalog, providersForPicker: vi.fn() }));
vi.mock('@clack/prompts', () => ({ log: { info: vi.fn(), step: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { runAntigravityIdeCommand } from '../src/antigravity.js';

describe('existing IDE recovery preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assert.mockImplementation(() => {});
    mocks.read.mockReturnValue(null);
    mocks.running.mockReturnValue(false);
    mocks.wait.mockResolvedValue(true);
    mocks.restore.mockReturnValue({ restored: true, warnings: [] });
  });
  it('does not fetch providers or credentials for --restore with nothing pending', async () => {
    expect(await runAntigravityIdeCommand([], false, { restore: true })).toBe(0);
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });
  it('reserves the profile and stops the target before restoring', async () => {
    mocks.read.mockReturnValue({ profileDir: '/tmp/main-profile' });
    mocks.running.mockReturnValue(true);
    expect(await runAntigravityIdeCommand([], false, { restore: true })).toBe(0);
    expect(mocks.acquire.mock.invocationCallOrder[0]).toBeLessThan(mocks.quit.mock.invocationCallOrder[0]);
    expect(mocks.wait.mock.invocationCallOrder[0]).toBeLessThan(mocks.restore.mock.invocationCallOrder[0]);
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it('never restores if the IDE refuses to exit', async () => {
    mocks.read.mockReturnValue({ profileDir: '/tmp/main-profile' });
    mocks.running.mockReturnValue(true);
    mocks.wait.mockResolvedValue(false);
    expect(await runAntigravityIdeCommand([], false, { restore: true })).toBe(1);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('never stops a target owned by another active Relay session', async () => {
    mocks.assert.mockImplementation(() => { throw new Error('Another Relay session is running'); });
    expect(await runAntigravityIdeCommand([], false, { restore: true })).toBe(1);
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it('reports unsuccessful restoration without claiming success', async () => {
    mocks.read.mockReturnValue({ profileDir: '/tmp/main-profile' });
    mocks.restore.mockReturnValue({ restored: false, message: 'Recovery failed' });
    expect(await runAntigravityIdeCommand([], false, { restore: true })).toBe(1);
  });
});
