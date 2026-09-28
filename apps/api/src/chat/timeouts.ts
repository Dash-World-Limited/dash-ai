const TIMEOUT = Symbol("timeout");

export class IdleTimeoutError extends Error {
  constructor() {
    super("Provider stream was idle for too long");
    this.name = "IdleTimeoutError";
  }
}

async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-yields `source`, calling `onIdle` when no item arrives within `idleMs`. `onIdle` should abort
 * the underlying request; if the source still does not settle within `graceMs`, an
 * IdleTimeoutError is thrown so a misbehaving source can never hang a stream forever.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onIdle: () => void,
  graceMs = 2_000,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let pending = false;
  try {
    while (true) {
      const next = iterator.next();
      next.catch(() => undefined); // handled below; prevents unhandled rejections if we give up waiting
      pending = true;
      let result = await raceTimeout(next, idleMs);
      if (result === TIMEOUT) {
        onIdle();
        result = await raceTimeout(next, graceMs);
        if (result === TIMEOUT) throw new IdleTimeoutError();
      }
      pending = false;
      if (result.done) return;
      yield result.value;
    }
  } finally {
    if (!pending) await iterator.return?.();
    else void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}
