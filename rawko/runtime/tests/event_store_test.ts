import { assertEquals } from "@std/assert";
import { EventStore } from "../src/runtime/event_store.ts";

Deno.test("EventStore appends and lists events", () => {
  const store = new EventStore(10);

  const first = store.append({ type: "chat", role: "system", text: "hello" });
  const second = store.append({ type: "chat", role: "system", text: "world" });

  assertEquals(first.seq, 1);
  assertEquals(second.seq, 2);

  const events = store.listSince(1);
  assertEquals(events.length, 1);
  assertEquals(events[0].seq, 2);
});

Deno.test("EventStore enforces max size", () => {
  const store = new EventStore(2);
  store.append({ type: "chat", role: "system", text: "1" });
  store.append({ type: "chat", role: "system", text: "2" });
  store.append({ type: "chat", role: "system", text: "3" });

  const events = store.listSince(0);
  assertEquals(events.length, 2);
  assertEquals(events[0].seq, 2);
  assertEquals(events[1].seq, 3);
});
