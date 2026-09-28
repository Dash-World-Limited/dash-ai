interface ActiveStream {
  userId: string;
  controller: AbortController;
}

/** Tracks in-flight chat streams so they can be cancelled and so each user has a concurrency cap. */
export class StreamRegistry {
  private readonly streams = new Map<string, ActiveStream>();

  register(streamId: string, userId: string, controller: AbortController): void {
    this.streams.set(streamId, { userId, controller });
  }

  unregister(streamId: string): void {
    this.streams.delete(streamId);
  }

  countForUser(userId: string): number {
    let n = 0;
    for (const s of this.streams.values()) if (s.userId === userId) n++;
    return n;
  }

  /** Cancels a stream owned by userId. Returns false if no such stream exists for that user. */
  cancel(userId: string, streamId: string): boolean {
    const s = this.streams.get(streamId);
    if (!s || s.userId !== userId) return false;
    s.controller.abort("cancelled");
    return true;
  }

  cancelAllForUser(userId: string): void {
    for (const s of this.streams.values()) if (s.userId === userId) s.controller.abort("cancelled");
  }

  cancelAll(): void {
    for (const s of this.streams.values()) s.controller.abort("cancelled");
  }

  get size(): number {
    return this.streams.size;
  }
}
