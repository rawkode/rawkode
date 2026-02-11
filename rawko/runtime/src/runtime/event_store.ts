import type { RuntimeEvent, RuntimeEventEnvelope } from "../types/runtime.ts";

type Listener = (event: RuntimeEventEnvelope) => void;

export class EventStore {
  private seq = 0;
  private readonly maxEvents: number;
  private readonly events: RuntimeEventEnvelope[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(maxEvents = 5_000) {
    this.maxEvents = maxEvents;
  }

  append(event: RuntimeEvent): RuntimeEventEnvelope {
    const envelope: RuntimeEventEnvelope = {
      seq: ++this.seq,
      time: new Date().toISOString(),
      event,
    };

    this.events.push(envelope);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    for (const listener of this.listeners) {
      listener(envelope);
    }

    return envelope;
  }

  listSince(offset = 0, limit = 1_000): RuntimeEventEnvelope[] {
    if (limit < 1) {
      return [];
    }
    const out: RuntimeEventEnvelope[] = [];
    for (const event of this.events) {
      if (event.seq > offset) {
        out.push(event);
      }
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  }

  latestSeq(): number {
    return this.seq;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
