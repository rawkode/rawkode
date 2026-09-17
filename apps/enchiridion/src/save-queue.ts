import type {LoadedDay, SaveReceipt} from './native';

type Request = {day:string;token:string;sequence:number;baseRevision:number;snapshot:number[]};
type Writer = (request: Request) => Promise<SaveReceipt>;
/** Keep the exact unacknowledged request so retries remain idempotent after lost receipts. */
export class SaveQueue {
  private pending: Uint8Array | null = null;
  private inFlight: Request | null = null;
  private running: Promise<void> | null = null;
  private nextSequence = 0;
  private revision: number;
  acknowledgedSequence = 0;
  error: string | null = null;
  constructor(readonly day: LoadedDay, private write: Writer, private changed: () => void) {
    this.revision = day.revision;
    this.nextSequence = day.sequence ?? 0;
    this.acknowledgedSequence = day.dirty ? 0 : day.sequence ?? 0;
    if (day.dirty && day.snapshot) this.inFlight = {day:day.day,token:day.token,
      sequence:day.sequence!,baseRevision:day.revision,snapshot:day.snapshot};
  }
  get dirty() { return this.pending !== null || this.inFlight !== null || this.running !== null; }
  enqueue(snapshot: Uint8Array) {
    this.pending = snapshot.slice();
    this.changed();
    void this.drain();
  }
  private drain(): Promise<void> {
    if (this.running) return this.running;
    if (!this.pending && !this.inFlight) return Promise.resolve();
    const work = async () => {
      while (this.pending || this.inFlight) {
        if (!this.inFlight) {
          this.inFlight = {day:this.day.day,token:this.day.token,sequence:++this.nextSequence,
            baseRevision:this.revision,snapshot:Array.from(this.pending!)};
          this.pending = null;
        }
        const request = this.inFlight;
        try {
          const receipt = await this.write(request);
          if (receipt.sequence !== request.sequence) throw new Error('The save acknowledgement did not match this edit.');
          this.revision = receipt.revision;
          this.acknowledgedSequence = receipt.sequence;
          this.inFlight = null;
          this.error = null;
        } catch (error) {
          this.error = String(error);
          break;
        }
      }
    };
    this.running = work().finally(() => {
      this.running = null;
      this.changed();
      if (this.pending && !this.error) void this.drain();
    });
    return this.running;
  }
  async flush() {
    if (this.running) await this.running;
    if (this.pending || this.inFlight) await this.drain();
    if (this.error || this.dirty) throw new Error(this.error ?? 'Changes are still saving.');
  }
}
