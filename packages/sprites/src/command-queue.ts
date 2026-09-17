export class CommandBusy extends Error {}
/** Transient subprocess pressure; no relationship to the number of allocated Sprites. */
export class CommandQueue {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private slots: number,
    private waitMs = 10000,
  ) {}
  async acquire(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.active < this.slots) this.active++;
    else {
      if (this.waiting.length >= 120)
        throw new CommandBusy("Workspace operations are busy. Retry shortly.");
      await new Promise<void>((resolve, reject) => {
        const remove = () => {
          const index = this.waiting.indexOf(resume);
          if (index >= 0) this.waiting.splice(index, 1);
        };
        const abort = () => {
          remove();
          clearTimeout(timer);
          reject(new Error("Workspace operation cancelled"));
        };
        const resume = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(() => {
          remove();
          signal?.removeEventListener("abort", abort);
          reject(new CommandBusy("Workspace operations are busy. Retry shortly."));
        }, this.waitMs);
        this.waiting.push(resume);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}
