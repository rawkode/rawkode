// @enchiridion/worker-vault — per-page reprojection debounce.
//
// Plan §Backend architecture: "Reprojection is debounced per doc
// (commit-boundary, not per update frame) ... debounce (per doc, short
// delay — e.g. a DO alarm or a simple in-memory timer keyed by pageID)".
// This module is the in-memory-timer option, deliberately factored out of
// `vault-do.ts` so it's unit-testable with real timers and no
// `DurableObjectState` in the loop at all.
//
// SAFETY NOTE — why an in-memory timer is an acceptable P0 choice despite
// the DO potentially evicting before the timer fires (a real risk the
// plan's phrasing "e.g. a DO alarm OR a simple in-memory timer" implicitly
// acknowledges by offering the weaker option at all): doc-storage writes
// (`doc-store.ts`'s `appendPendingUpdate`) are NEVER debounced — every
// single update is durably persisted immediately, synchronously, in its
// own SQL write, regardless of what this scheduler is doing. Only the
// *projection-table* refresh (turning the durable doc state into
// `graph_nodes` rows) is debounced. If the DO evicts mid-debounce-window,
// nothing is lost except a projection-table refresh that hasn't happened
// yet — and `vault-do.ts`'s boot-time drift heal (comparing
// `projection.ts`'s stored `lastProjectedVersion` against the doc's actual
// current version vector) always catches this on the DO's next wake,
// whether that's milliseconds or days later. Debounce buys responsiveness
// during an active burst of edits; boot-time heal is the correctness
// backstop, not this timer.

export class ReprojectionScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly reproject: (pageID: string) => void,
    private readonly debounceMs: number,
  ) {}

  /** (Re)starts the debounce window for `pageID`. Called on every doc
   *  update; a page edited three times in quick succession only
   *  reprojects once, `debounceMs` after the LAST edit — a fresh call
   *  cancels and replaces any timer already running for that page. */
  schedule(pageID: string): void {
    const existing = this.timers.get(pageID);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(pageID);
      this.reproject(pageID);
    }, this.debounceMs);
    this.timers.set(pageID, timer);
  }

  /** Fires a still-pending reprojection immediately rather than waiting
   *  out the rest of its debounce window, and clears its timer. A no-op if
   *  nothing is pending for `pageID`. Used both for explicit "flush before
   *  responding to a query so the caller sees fresh data" call sites and
   *  for tests that don't want to wait out a real debounce delay. */
  flush(pageID: string): void {
    const existing = this.timers.get(pageID);
    if (!existing) return;
    clearTimeout(existing);
    this.timers.delete(pageID);
    this.reproject(pageID);
  }

  flushAll(): void {
    for (const pageID of [...this.timers.keys()]) {
      this.flush(pageID);
    }
  }

  pendingCount(): number {
    return this.timers.size;
  }

  isPending(pageID: string): boolean {
    return this.timers.has(pageID);
  }
}
