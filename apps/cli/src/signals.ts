export interface ProcessSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface ProcessSignalController {
  readonly signal: AbortSignal;
  /** POSIX-compatible status for the signal that initiated cancellation. */
  readonly exitCode: number | undefined;
  dispose(): void;
}

/**
 * Converts terminal interruption signals into cooperative cancellation.  The
 * caller owns the controller lifetime so test harnesses and completed commands
 * do not retain signal listeners.
 */
export function createProcessSignalController(source: ProcessSignalSource): ProcessSignalController {
  const controller = new AbortController();
  let exitCode: number | undefined;
  const cancel = (status: number): void => {
    exitCode ??= status;
    controller.abort();
  };
  const interrupt = (): void => {
    cancel(130);
  };
  const terminate = (): void => {
    cancel(143);
  };
  source.on('SIGINT', interrupt);
  source.on('SIGTERM', terminate);

  return {
    signal: controller.signal,
    get exitCode(): number | undefined {
      return exitCode;
    },
    dispose(): void {
      source.off('SIGINT', interrupt);
      source.off('SIGTERM', terminate);
    }
  };
}
