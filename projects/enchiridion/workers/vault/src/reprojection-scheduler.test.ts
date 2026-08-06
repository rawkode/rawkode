import { describe, expect, test } from "bun:test";
import { ReprojectionScheduler } from "./reprojection-scheduler";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ReprojectionScheduler — debounce behavior", () => {
  test("a single schedule() call reprojects once after the debounce window", async () => {
    const calls: string[] = [];
    const scheduler = new ReprojectionScheduler((id) => calls.push(id), 10);

    scheduler.schedule("p1");
    expect(calls).toEqual([]);
    await sleep(30);
    expect(calls).toEqual(["p1"]);
  });

  test("multiple rapid schedule() calls for the same page collapse into one reprojection", async () => {
    const calls: string[] = [];
    const scheduler = new ReprojectionScheduler((id) => calls.push(id), 20);

    scheduler.schedule("p1");
    await sleep(5);
    scheduler.schedule("p1");
    await sleep(5);
    scheduler.schedule("p1");
    // Total elapsed so far: 10ms, well under the 20ms window each
    // schedule() call restarts.
    expect(calls).toEqual([]);

    await sleep(40);
    expect(calls).toEqual(["p1"]);
  });

  test("different pages debounce independently", async () => {
    const calls: string[] = [];
    const scheduler = new ReprojectionScheduler((id) => calls.push(id), 10);

    scheduler.schedule("p1");
    scheduler.schedule("p2");
    await sleep(30);

    expect(calls.sort()).toEqual(["p1", "p2"]);
  });

  test("flush() fires immediately without waiting out the debounce window", () => {
    const calls: string[] = [];
    const scheduler = new ReprojectionScheduler((id) => calls.push(id), 10_000);

    scheduler.schedule("p1");
    expect(calls).toEqual([]);
    scheduler.flush("p1");
    expect(calls).toEqual(["p1"]);
    expect(scheduler.isPending("p1")).toBe(false);
  });

  test("flush() on a page with nothing pending is a safe no-op", () => {
    const calls: string[] = [];
    const scheduler = new ReprojectionScheduler((id) => calls.push(id), 10);
    expect(() => scheduler.flush("nope")).not.toThrow();
    expect(calls).toEqual([]);
  });

  test("flushAll() fires every pending page immediately", () => {
    const calls: string[] = [];
    const scheduler = new ReprojectionScheduler((id) => calls.push(id), 10_000);

    scheduler.schedule("p1");
    scheduler.schedule("p2");
    scheduler.schedule("p3");
    scheduler.flushAll();

    expect(calls.sort()).toEqual(["p1", "p2", "p3"]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("pendingCount reflects in-flight debounce timers", async () => {
    const scheduler = new ReprojectionScheduler(() => {}, 10);
    expect(scheduler.pendingCount()).toBe(0);
    scheduler.schedule("p1");
    scheduler.schedule("p2");
    expect(scheduler.pendingCount()).toBe(2);
    await sleep(30);
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("re-scheduling after a reprojection already fired starts a fresh debounce window", async () => {
    const calls: string[] = [];
    const scheduler = new ReprojectionScheduler((id) => calls.push(id), 10);

    scheduler.schedule("p1");
    await sleep(30);
    expect(calls).toEqual(["p1"]);

    scheduler.schedule("p1");
    await sleep(30);
    expect(calls).toEqual(["p1", "p1"]);
  });
});
