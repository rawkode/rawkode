import { assertEquals, assertThrows } from "@std/assert";
import { parseAgentDefinition } from "../src/config/frontmatter.ts";

Deno.test("parseAgentDefinition parses required fields", () => {
  const raw = `---
name: "Manager"
useMe: "Coordinate work"
manager: true
council: false
models:
  - provider: openai
    model: gpt-5
---
You are the manager.
`;

  const agent = parseAgentDefinition("/tmp/manager.mdx", raw);
  assertEquals(agent.id, "manager");
  assertEquals(agent.name, "Manager");
  assertEquals(agent.manager, true);
  assertEquals(agent.models[0].provider, "openai");
  assertEquals(agent.models[0].model, "gpt-5");
});

Deno.test("parseAgentDefinition supports provider/model compatibility mode", () => {
  const raw = `---
name: Worker
useMe: Build code
manager: false
council: true
provider: anthropic
model: claude-sonnet
---
Do work.
`;

  const agent = parseAgentDefinition("/tmp/worker.mdx", raw);
  assertEquals(agent.models.length, 1);
  assertEquals(agent.models[0].provider, "anthropic");
  assertEquals(agent.models[0].model, "claude-sonnet");
});

Deno.test("parseAgentDefinition fails when manager flag missing", () => {
  const raw = `---
name: Worker
useMe: Build code
council: true
provider: openai
model: gpt-5
---
Do work.
`;

  assertThrows(() => parseAgentDefinition("/tmp/worker.mdx", raw));
});

Deno.test("parseAgentDefinition rejects github provider for manager", () => {
  const raw = `---
name: "Manager"
useMe: "Coordinate work"
manager: true
council: false
models:
  - provider: github
    model: gemini-3-flash-preview
---
You are the manager.
`;

  assertThrows(() => parseAgentDefinition("/tmp/manager.mdx", raw));
});

Deno.test("parseAgentDefinition keeps hash characters in quoted strings", () => {
  const raw = `---
name: Worker
useMe: "Build #1 feature"
manager: false
council: true
provider: openai
model: gpt-5
---
Do work.
`;

  const agent = parseAgentDefinition("/tmp/worker.mdx", raw);
  assertEquals(agent.useMe, "Build #1 feature");
});
