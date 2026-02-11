import { assertEquals, assertRejects } from "@std/assert";
import type { ProviderAdapter } from "../src/providers/adapter.ts";
import { ProviderFactory } from "../src/providers/factory.ts";
import { AgentExecutor, type StructuredOutputSpec } from "../src/runtime/executor.ts";
import type { AgentDefinition } from "../src/types/agent.ts";

class MockAdapter implements ProviderAdapter {
  provider = "openai" as const;
  private readonly failuresBeforeSuccess: number;
  private calls = 0;
  private structuredCalls = 0;

  constructor(failuresBeforeSuccess: number) {
    this.failuresBeforeSuccess = failuresBeforeSuccess;
  }

  invoke(): Promise<string> {
    this.calls += 1;
    if (this.calls <= this.failuresBeforeSuccess) {
      throw new Error(`failed-${this.calls}`);
    }
    return Promise.resolve(`ok-${this.calls}`);
  }

  invokeStructured(): Promise<unknown> {
    this.structuredCalls += 1;
    if (this.structuredCalls <= this.failuresBeforeSuccess) {
      throw new Error(`failed-structured-${this.structuredCalls}`);
    }
    return Promise.resolve({ mode: "wait" });
  }
}

const agent: AgentDefinition = {
  id: "a1",
  filePath: "/tmp/a1.mdx",
  name: "Agent One",
  useMe: "Test",
  manager: false,
  council: false,
  models: [{ provider: "openai", model: "gpt-5" }],
  systemPrompt: "You are a test agent",
};

Deno.test("AgentExecutor retries and succeeds", async () => {
  const adapter = new MockAdapter(2);
  const factory = new ProviderFactory([adapter]);
  const executor = new AgentExecutor(factory, Deno.cwd(), { immediateRetries: 4 });

  const output = await executor.invoke(agent, "hello");
  assertEquals(output, "ok-3");
  assertEquals(executor.isOffSick(agent), false);
});

Deno.test("AgentExecutor marks off-sick after retry exhaustion", async () => {
  const adapter = new MockAdapter(100);
  const factory = new ProviderFactory([adapter]);
  const executor = new AgentExecutor(factory, Deno.cwd(), { immediateRetries: 2 });

  await assertRejects(() => executor.invoke(agent, "hello"));
  assertEquals(executor.isOffSick(agent), true);
});

Deno.test("AgentExecutor retries structured invocation and parses output", async () => {
  const adapter = new MockAdapter(1);
  const factory = new ProviderFactory([adapter]);
  const executor = new AgentExecutor(factory, Deno.cwd(), { immediateRetries: 3 });

  const spec: StructuredOutputSpec<{ mode: string }> = {
    schema: {
      type: "object",
      properties: {
        mode: { type: "string" },
      },
      required: ["mode"],
    },
    parse(value: unknown): { mode: string } {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("invalid object");
      }
      const mode = (value as Record<string, unknown>).mode;
      if (typeof mode !== "string") {
        throw new Error("missing mode");
      }
      return { mode };
    },
  };

  const output = await executor.invokeStructured(agent, "hello", spec);
  assertEquals(output.mode, "wait");
  assertEquals(executor.isOffSick(agent), false);
});
