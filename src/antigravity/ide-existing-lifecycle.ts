/** Stop the target IDE before applying or restoring its configuration. */
export interface ExistingIdeProcessControl {
  isRunning(): boolean;
  quit(): void;
  waitForQuit(): Promise<boolean>;
  forceQuit(): void;
}

export async function stopExistingIde(control: ExistingIdeProcessControl): Promise<void> {
  if (!control.isRunning()) return;
  control.quit();
  if (await control.waitForQuit()) return;
  control.forceQuit();
  if (await control.waitForQuit()) return;
  throw new Error('Antigravity IDE is still running. Close it, then run relay-ai antigravity-ide --restore. Recovery files were retained.');
}

export interface ExistingIdeShutdownWatcher {
  readonly promise: Promise<void>;
  readonly interrupted: boolean;
  /** True when the trigger was Ctrl+C, where someone is there to ask. */
  readonly askBeforeClose: boolean;
  launched(): void;
  /** Re-arm after a declined close request; the next signal or exit resolves a fresh wait. */
  rearm(): void;
  dispose(): void;
}

/**
 * Listen before launch so shutdown during startup also runs recovery. Resolves
 * when a termination signal arrives or the launched IDE exits on its own.
 */
export function watchExistingIdeShutdown(isRunning: () => boolean): ExistingIdeShutdownWatcher {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  let interrupted = false;
  let askBeforeClose = false;
  let launched = false;
  let promise!: Promise<void>;

  const arm = (): void => {
    promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  };
  arm();

  const onSignal = (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'ctrl-c' = 'ctrl-c'): void => {
    interrupted = true;
    askBeforeClose = signal === 'SIGINT' || signal === 'ctrl-c';
    resolve();
  };
  const input = process.stdin;
  const captureCtrlC = process.platform === 'win32' && input.isTTY;
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  const onInput = (chunk: Buffer | string): void => {
    if (typeof chunk === 'string' ? chunk.includes('\u0003') : chunk.includes(0x03)) onSignal();
  };
  if (captureCtrlC) {
    input.on('data', onInput);
    input.setRawMode(true);
    input.resume();
  }
  const signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const handler = (): void => onSignal(signal);
    signalHandlers.push({ signal, handler });
    process.on(signal, handler);
  }
  const timer = setInterval(() => {
    try {
      if (launched && !isRunning()) resolve();
    } catch (error) {
      reject(error);
    }
  }, 1000);
  return {
    get promise() { return promise; },
    get interrupted() { return interrupted; },
    get askBeforeClose() { return askBeforeClose; },
    launched() { launched = true; },
    rearm() { interrupted = false; askBeforeClose = false; arm(); },
    dispose() {
      clearInterval(timer);
      if (captureCtrlC) {
        input.removeListener('data', onInput);
        input.setRawMode(wasRaw);
        if (wasPaused) input.pause();
      }
      for (const { signal, handler } of signalHandlers) process.removeListener(signal, handler);
    },
  };
}

/**
 * Wait for the IDE to exit, asking before closing when the user interrupted
 * with Ctrl+C. Declining keeps the session running, mirroring the desktop-app
 * flow; SIGTERM and SIGHUP close without a prompt so nothing blocks automation.
 */
export async function waitForExistingIdeShutdownWithConfirm(
  watcher: ExistingIdeShutdownWatcher,
  confirmClose: () => Promise<boolean>,
): Promise<void> {
  for (;;) {
    await watcher.promise;
    if (!watcher.interrupted || !watcher.askBeforeClose) return;
    console.log('');
    if (await confirmClose()) return;
    watcher.rearm();
  }
}
