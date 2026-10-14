import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopExistingIde, watchExistingIdeShutdown, waitForExistingIdeShutdownWithConfirm } from '../src/antigravity/ide-existing-lifecycle.js';

describe('existing IDE lifecycle', () => {
  afterEach(() => vi.useRealTimers());
  it('waits for graceful exit before returning', async () => {
    const control = { isRunning: () => true, quit: vi.fn(), waitForQuit: vi.fn().mockResolvedValue(true), forceQuit: vi.fn() };
    await stopExistingIde(control);
    expect(control.quit).toHaveBeenCalledOnce();
    expect(control.forceQuit).not.toHaveBeenCalled();
  });
  it('escalates and refuses restoration while the target stays alive', async () => {
    const control = { isRunning: () => true, quit: vi.fn(), waitForQuit: vi.fn().mockResolvedValue(false), forceQuit: vi.fn() };
    await expect(stopExistingIde(control)).rejects.toThrow('Recovery files were retained');
    expect(control.forceQuit).toHaveBeenCalledOnce();
    expect(control.waitForQuit).toHaveBeenCalledTimes(2);
  });
  it('does not quit an absent target', async () => {
    const control = { isRunning: () => false, quit: vi.fn(), waitForQuit: vi.fn(), forceQuit: vi.fn() };
    await stopExistingIde(control);
    expect(control.quit).not.toHaveBeenCalled();
  });
  it('observes normal app closure only after launch and cleans up signal listeners', async () => {
    vi.useFakeTimers();
    const count = process.listenerCount('SIGTERM');
    const watcher = watchExistingIdeShutdown(() => false);
    const done = vi.fn();
    watcher.promise.then(done);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).not.toHaveBeenCalled();
    watcher.launched();
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toHaveBeenCalledOnce();
    watcher.dispose();
    expect(process.listenerCount('SIGTERM')).toBe(count);
  });
  it('captures termination during startup', async () => {
    const watcher = watchExistingIdeShutdown(() => true);
    try {
      process.emit('SIGHUP');
      await watcher.promise;
      expect(watcher.interrupted).toBe(true);
    } finally { watcher.dispose(); }
  });
});

describe('waitForExistingIdeShutdownWithConfirm', () => {
  it('does not prompt when the IDE exits on its own', async () => {
    vi.useFakeTimers();
    const watcher = watchExistingIdeShutdown(() => false);
    watcher.launched();
    const confirmClose = vi.fn().mockResolvedValue(true);
    try {
      const wait = waitForExistingIdeShutdownWithConfirm(watcher, confirmClose);
      await vi.advanceTimersByTimeAsync(1000);
      await wait;
      expect(confirmClose).not.toHaveBeenCalled();
    } finally { watcher.dispose(); }
  });
  it('asks before closing on Ctrl+C and returns when confirmed', async () => {
    const watcher = watchExistingIdeShutdown(() => true);
    const confirmClose = vi.fn().mockResolvedValue(true);
    try {
      const wait = waitForExistingIdeShutdownWithConfirm(watcher, confirmClose);
      process.emit('SIGINT');
      await wait;
      expect(confirmClose).toHaveBeenCalledOnce();
    } finally { watcher.dispose(); }
  });
  it('keeps the session running when the close request is declined', async () => {
    vi.useFakeTimers();
    let running = true;
    const watcher = watchExistingIdeShutdown(() => running);
    watcher.launched();
    const confirmClose = vi.fn().mockResolvedValue(false);
    try {
      const wait = waitForExistingIdeShutdownWithConfirm(watcher, confirmClose);
      process.emit('SIGINT');
      await vi.advanceTimersByTimeAsync(0);
      expect(confirmClose).toHaveBeenCalledTimes(1);
      running = false; // the IDE closes later, without another prompt
      await vi.advanceTimersByTimeAsync(1000);
      await wait;
      expect(confirmClose).toHaveBeenCalledTimes(1);
    } finally { watcher.dispose(); }
  });
  it('closes without a prompt for SIGTERM and SIGHUP', async () => {
    for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
      const watcher = watchExistingIdeShutdown(() => true);
      const confirmClose = vi.fn().mockResolvedValue(true);
      try {
        const wait = waitForExistingIdeShutdownWithConfirm(watcher, confirmClose);
        process.emit(signal);
        await wait;
        expect(confirmClose).not.toHaveBeenCalled();
      } finally { watcher.dispose(); }
    }
  });
});
