// Serial queue that enforces a minimum cooldown between releases.
// At most one fn runs at a time; the next acquirer only resumes once
// `cooldownMs` has elapsed after the previous release.
//
// On Vercel each Lambda instance has its own copy, so this caps throughput
// per-instance, not strictly globally — good enough to soften AWS Route 53
// Domains throttling without external coordination.
export class SerialQueue {
  private busy = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly cooldownMs: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.scheduleNext();
    }
  }

  private async acquire(): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  // After the configured cooldown, hand the slot to the next waiter, or
  // mark the queue idle if none.
  private scheduleNext(): void {
    setTimeout(() => {
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.busy = false;
      }
    }, this.cooldownMs);
  }
}
