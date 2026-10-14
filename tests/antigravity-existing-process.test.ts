import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ binary: '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide', productName: 'Antigravity IDE', exec: vi.fn() }));
vi.mock('../src/config.js', () => ({ getAppPathOverride: () => mocks.binary }));
vi.mock('node:fs', () => ({ existsSync: () => true, readFileSync: () => JSON.stringify({ nameShort: mocks.productName, dataFolderName: '.wrong-for-user-data' }) }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec, execSync: vi.fn(), spawn: vi.fn() }));
import { getDefaultAntigravityIdeProfileDir, getExistingAntigravityIdePids, isExistingAntigravityIdeRunning } from '../src/antigravity/launch-ide.js';

describe('existing IDE process boundaries', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    mocks.binary = '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide';
    mocks.productName = 'Antigravity IDE';
    mocks.exec.mockReset();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const executable = '/Applications/Antigravity IDE.app/Contents/MacOS/Electron';
  it('distinguishes quoted, spaced, and sibling profile paths', () => {
    const profile = '/tmp/Normal Profile';
    const list = () => [
      `101 ${executable} --user-data-dir="${profile}" /tmp/project`,
      `102 ${executable} --user-data-dir ${profile} --flag`,
      `103 ${executable} --user-data-dir=${profile}-other`,
      `104 ${executable} --user-data-dir=/tmp/isolated`,
      `105 node /tmp/script.js ${executable}`,
    ].join('\n');
    expect(getExistingAntigravityIdePids(profile, list)).toEqual([101, 102]);
  });
  it('includes target helpers for exit checks, but only main processes for graceful quit', () => {
    const profile = '/tmp/normal';
    const list = () => [
      `101 ${executable}`,
      `102 /Applications/Antigravity IDE.app/Contents/Frameworks/Antigravity IDE Helper.app/Contents/MacOS/Antigravity IDE Helper --type=utility --user-data-dir=${profile}`,
      `103 /Applications/Antigravity IDE.app/Contents/Frameworks/Antigravity IDE Helper.app/Contents/MacOS/Antigravity IDE Helper --type=utility --user-data-dir=/tmp/isolated`,
    ].join('\n');
    expect(getExistingAntigravityIdePids(profile, list)).toEqual([101, 102]);
    expect(getExistingAntigravityIdePids(profile, list, true)).toEqual([101]);
  });
  it('fails closed when process inspection fails', () => {
    mocks.exec.mockImplementation(() => { throw new Error('ps failed'); });
    expect(() => isExistingAntigravityIdeRunning('/tmp/normal')).toThrow('ps failed');
  });
  it('uses the installed product identity and XDG config location on Linux', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('XDG_CONFIG_HOME', '/tmp/custom-config');
    mocks.binary = '/opt/antigravity/antigravity';
    mocks.productName = 'Antigravity';
    expect(getDefaultAntigravityIdeProfileDir()).toBe('/tmp/custom-config/Antigravity');
    expect(getExistingAntigravityIdePids('/tmp/normal', () => [
      '101 /opt/antigravity/antigravity',
      '102 node /tmp/antigravity/project.js',
      '103 /opt/antigravity/antigravity --user-data-dir=/tmp/normal-other',
    ].join('\n'))).toEqual([101]);
  });
  it('uses APPDATA and filters Windows profiles without interpolating paths into PowerShell', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('APPDATA', '/tmp/roaming');
    mocks.binary = 'C:\\Programs\\Antigravity IDE\\Antigravity IDE.exe';
    const profile = 'C:\\Users\\A[B]$\\Profile';
    mocks.exec.mockReturnValue(JSON.stringify([
      { ProcessId: 101, ExecutablePath: mocks.binary, CommandLine: `"${mocks.binary}" --user-data-dir="${profile}"` },
      { ProcessId: 102, ExecutablePath: mocks.binary, CommandLine: `"${mocks.binary}" --user-data-dir="${profile}-other"` },
    ]));
    expect(getDefaultAntigravityIdeProfileDir()).toBe('/tmp/roaming/Antigravity IDE');
    expect(getExistingAntigravityIdePids(profile)).toEqual([101]);
    expect(String(mocks.exec.mock.calls[0])).not.toContain(profile);
  });
});
