import { assertEquals, assertThrows } from "@std/assert";
import {
  buildManagerDirectiveOutputSpec,
  MANAGER_DIRECTIVE_OUTPUT_SPEC,
  parseCouncilDecisionStructured,
  parseManagerDirectiveStructured,
} from "../src/runtime/structured.ts";

Deno.test("parseManagerDirectiveStructured parses delegate output", () => {
  const directive = parseManagerDirectiveStructured({
    mode: "delegate",
    delegations: [
      {
        agent: "Implementation Engineer",
        task: "Implement API endpoint and tests",
        brief: "Only touch the API handler and related tests.",
        config: {
          runAfterSeconds: 0,
          maxRuntimeSeconds: 120,
          requiresDifferentAgent: false,
        },
      },
    ],
    notes: "Focused on the oldest user request",
  });

  assertEquals(directive.mode, "delegate");
  assertEquals(directive.delegations?.length, 1);
  assertEquals(directive.delegations?.[0].agent, "Implementation Engineer");
  assertEquals(directive.delegations?.[0].task, "Implement API endpoint and tests");
  assertEquals(directive.delegations?.[0].brief, "Only touch the API handler and related tests.");
  assertEquals(directive.delegations?.[0].config?.maxRuntimeSeconds, 120);
  assertEquals(directive.notes, "Focused on the oldest user request");
});

Deno.test("parseManagerDirectiveStructured rejects invalid mode", () => {
  assertThrows(() =>
    parseManagerDirectiveStructured({
      mode: "execute_directly",
    })
  );
});

Deno.test("MANAGER_DIRECTIVE_OUTPUT_SPEC requires all top-level properties", () => {
  const schema = MANAGER_DIRECTIVE_OUTPUT_SPEC.schema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const propertyKeys = Object.keys(schema.properties ?? {});
  const required = schema.required ?? [];
  assertEquals(required.sort(), propertyKeys.sort());
});

Deno.test("buildManagerDirectiveOutputSpec applies dynamic minimum delegations", () => {
  const spec = buildManagerDirectiveOutputSpec({ minDelegations: 3 });
  const schema = spec.schema as {
    properties?: Record<string, unknown>;
  };
  const delegations = (schema.properties?.delegations ?? {}) as {
    minItems?: number;
  };
  assertEquals(delegations.minItems, 3);
});

Deno.test("parseManagerDirectiveStructured accepts nullable optional fields", () => {
  const directive = parseManagerDirectiveStructured({
    mode: "wait",
    delegations: null,
    reply: null,
    notes: null,
  });

  assertEquals(directive.mode, "wait");
  assertEquals(directive.delegations, undefined);
  assertEquals(directive.reply, undefined);
  assertEquals(directive.notes, undefined);
});

Deno.test("parseCouncilDecisionStructured parses complete verdict", () => {
  const decision = parseCouncilDecisionStructured({
    verdict: "complete",
    feedback: "Acceptance criteria and tests are satisfied.",
  });

  assertEquals(decision.verdict, "complete");
  assertEquals(decision.feedback, "Acceptance criteria and tests are satisfied.");
});

Deno.test("parseCouncilDecisionStructured requires feedback", () => {
  assertThrows(() =>
    parseCouncilDecisionStructured({
      verdict: "incomplete",
      feedback: "",
    })
  );
});
