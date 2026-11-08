/**
 * Send queues. One key must never sign two transactions at once (nonces would collide), so every
 * write goes through a lane that runs one job at a time. Without a gas key there is one lane; with
 * a gas key there is one lane per nonce slot, so several transactions go out in parallel.
 */

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;

  /** Jobs waiting or running. */
  get length(): number {
    return this.count;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.count++;
    const result = this.tail.then(job);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.count--;
    });
  }
}

export class LanePool {
  private readonly lanes: SerialQueue[];
  private next = 0;

  constructor(lanes: number) {
    this.lanes = Array.from({ length: Math.max(1, Math.floor(lanes)) }, () => new SerialQueue());
  }

  get size(): number {
    return this.lanes.length;
  }

  /** Jobs waiting or running across every lane. */
  get length(): number {
    return this.lanes.reduce((n, l) => n + l.length, 0);
  }

  /** Runs `job` on the least busy lane (round robin among equals); `job` gets the lane index. */
  run<T>(job: (lane: number) => Promise<T>): Promise<T> {
    let best = this.next % this.lanes.length;
    for (let i = 0; i < this.lanes.length; i++) {
      const idx = (this.next + i) % this.lanes.length;
      if (this.lanes[idx].length < this.lanes[best].length) best = idx;
    }
    this.next = (best + 1) % this.lanes.length;
    return this.lanes[best].run(() => job(best));
  }
}
