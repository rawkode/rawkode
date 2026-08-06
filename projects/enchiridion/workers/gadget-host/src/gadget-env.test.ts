// Capability-transport fix — this file's shape changed entirely (see
// `gadget-env.ts`'s and `gadget-capabilities-entrypoint.ts`'s headers for
// the full writeup). `buildGadgetEnv` no longer performs any capability
// dispatch or enforcement itself — it just constructs the ONE loopback
// Service Binding (`env.CAPABILITIES`) a gadget's dynamic-worker code
// receives, delegating identity binding (`props.gadgetId`) to
// `GadgetCapabilities` (`gadget-capabilities-entrypoint.ts`, not
// unit-testable here — it imports `cloudflare:workers`, see that file's
// header). What THIS file still proves, at the level `bun test` actually
// can reach:
//   (a) the env object's own key set is exactly `{CAPABILITIES}` — nothing
//       else, so a gadget has no OTHER surface to reach beyond its own
//       isolated SQLite (mirrors the old test's "exactly the four
//       gadget-facing capabilities, nothing extra snuck in" assertion, one
//       level up now that there's one binding instead of four functions).
//   (b) `buildGadgetEnv` calls `exports.GadgetCapabilities` with EXACTLY
//       `{ props: { gadgetId } }` — the caller-supplied gadgetId, not some
//       other value — since that's the one thing standing between "this
//       binding acts as gadget A" and "this binding acts as gadget B".
//   (c) the BLOCKER FIX from the previous pass (`graphConfirmProposal`
//       unreachable from gadget code) still holds, now expressed against
//       `GadgetCapabilitiesStub` (the type gadget code actually sees on
//       `env.CAPABILITIES`) instead of the old flat `GadgetCapabilityEnv`.
//
// The actual capability enforcement behind each `GadgetCapabilities`
// method (`requireCapability`, view/page-scope allowlists, the
// re-check-after-cross-worker-await fix) is UNCHANGED and still exercised
// by its own dedicated test files (`graph-query-capability.test.ts`,
// `graph-propose-capability.test.ts`, `calendar-read-capability.test.ts`,
// `schedule-capability.test.ts`) — this file was never the place that
// tested that logic, only the env-construction wrapper around it, and
// stays that way.

import { describe, expect, test } from "bun:test";
import { buildGadgetEnv, type GadgetCapabilitiesExports, type GadgetCapabilitiesStub, type GadgetCapabilityEnv } from "./gadget-env";

// --- Type-level check --------------------------------------------------
//
// Same technique the previous version of this file used (see git history /
// the task report), now applied to `GadgetCapabilitiesStub` — the type
// gadget code actually observes on `env.CAPABILITIES` — instead of the old
// flat `GadgetCapabilityEnv`.
type AssertKeyAbsent<Key extends string, T> = Key extends keyof T ? "FAIL: key is present on the type" : "OK: key is absent";
const _typeLevelAssertion: AssertKeyAbsent<"graphConfirmProposal", GadgetCapabilitiesStub> = "OK: key is absent";
void _typeLevelAssertion;

/** Records every call made to the fake `exports.GadgetCapabilities(...)`
 *  loopback constructor, and returns a distinguishable fake stub so tests
 *  can assert `buildGadgetEnv` wired it straight through onto
 *  `env.CAPABILITIES` without transformation. */
function fakeExports(): { exports: GadgetCapabilitiesExports; calls: Array<{ props: { gadgetId: string } }> } {
  const calls: Array<{ props: { gadgetId: string } }> = [];
  const stub: GadgetCapabilitiesStub = {
    graphQuery: async () => "fake-graph-query-result",
    graphPropose: async () => "fake-graph-propose-result",
    calendarListUpcomingEvents: async () => "fake-calendar-result",
    scheduleRegister: async () => "fake-schedule-result",
  };
  return {
    exports: {
      GadgetCapabilities(opts) {
        calls.push(opts);
        return stub;
      },
    },
    calls,
  };
}

describe("buildGadgetEnv — the real, structured-clone-safe capability transport", () => {
  test("the returned env's own key set is exactly {CAPABILITIES} — nothing else", () => {
    const { exports } = fakeExports();
    const env: GadgetCapabilityEnv = buildGadgetEnv(exports, "gadget-1");
    expect(new Set(Object.keys(env))).toEqual(new Set(["CAPABILITIES"]));
  });

  test("constructs the loopback binding with exactly {props: {gadgetId}} — the caller-supplied id, not something else", () => {
    const { exports, calls } = fakeExports();
    buildGadgetEnv(exports, "gadget-42");
    expect(calls).toEqual([{ props: { gadgetId: "gadget-42" } }]);
  });

  test("two different gadgetIds produce two independently-bound loopback constructions", () => {
    const { exports, calls } = fakeExports();
    buildGadgetEnv(exports, "gadget-a");
    buildGadgetEnv(exports, "gadget-b");
    expect(calls).toEqual([{ props: { gadgetId: "gadget-a" } }, { props: { gadgetId: "gadget-b" } }]);
  });

  test("env.CAPABILITIES is exactly what the loopback constructor returned — no wrapping/mutation", async () => {
    const { exports } = fakeExports();
    const env = buildGadgetEnv(exports, "gadget-1");
    await expect(env.CAPABILITIES.graphQuery("page", {})).resolves.toBe("fake-graph-query-result");
    await expect(env.CAPABILITIES.graphPropose({})).resolves.toBe("fake-graph-propose-result");
    await expect(env.CAPABILITIES.calendarListUpcomingEvents()).resolves.toBe("fake-calendar-result");
    await expect(env.CAPABILITIES.scheduleRegister(60)).resolves.toBe("fake-schedule-result");
  });

  test("CAPABILITIES has no graphConfirmProposal — gadgets still cannot confirm their own proposals (BLOCKER fix preserved)", () => {
    const { exports } = fakeExports();
    const env = buildGadgetEnv(exports, "gadget-1");
    expect("graphConfirmProposal" in env.CAPABILITIES).toBe(false);
    expect((env.CAPABILITIES as unknown as Record<string, unknown>).graphConfirmProposal).toBeUndefined();
  });
});
