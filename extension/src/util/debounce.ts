/**
 * Per-key debouncing with cancellation.
 *
 * Every keystroke in a Python file is a potential re-scan, and a scan means
 * network requests. Debouncing per *document* rather than globally matters:
 * typing in one file must not postpone the pending scan of another, which a
 * single shared timer would do.
 *
 * Cancellation is the other half. When a new edit supersedes a scan that is
 * already running, the old scan's results describe text that no longer exists
 * and would paint stale squiggles at the wrong offsets. Each scheduled run
 * gets an `AbortSignal` that fires the moment it is superseded.
 */

export type DebouncedRun = (signal: AbortSignal) => void | Promise<void>;

interface PendingRun {
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly controller: AbortController;
}

export class KeyedDebouncer {
  private readonly pending = new Map<string, PendingRun>();

  constructor(private readonly delayMs: number) {}

  /**
   * Schedule `run` for `key`, replacing and aborting any previous run.
   *
   * The entry stays registered for the whole lifetime of the run, not just
   * until its timer fires — otherwise a superseding edit could only cancel a
   * run that had not started yet, and the case that actually produces stale
   * squiggles is the one that is already waiting on the network.
   *
   * @param key Identity of the thing being debounced (a document URI).
   * @param run Called with a signal that aborts if this run is superseded.
   * @param delayMs Overrides the constructor delay for this call.
   */
  schedule(key: string, run: DebouncedRun, delayMs: number = this.delayMs): void {
    this.cancel(key);

    const entry: PendingRun = { timer: undefined, controller: new AbortController() };

    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void Promise.resolve(run(entry.controller.signal)).finally(() => {
        // Only clear if this run is still the current one; a supersede has
        // already replaced the entry and must not have it deleted underneath.
        if (this.pending.get(key) === entry) {
          this.pending.delete(key);
        }
      });
    }, delayMs);

    this.pending.set(key, entry);
  }

  /** Cancel the pending run for `key`, aborting it if it already started. */
  cancel(key: string): void {
    const existing = this.pending.get(key);
    if (!existing) {
      return;
    }
    if (existing.timer !== undefined) {
      clearTimeout(existing.timer);
    }
    existing.controller.abort();
    this.pending.delete(key);
  }

  /** Cancel everything — used on deactivate. */
  cancelAll(): void {
    for (const key of [...this.pending.keys()]) {
      this.cancel(key);
    }
  }

  /** Number of runs currently scheduled. */
  get size(): number {
    return this.pending.size;
  }
}
