import { test, expect, describe, beforeEach } from "bun:test";
import {
  ExecutorConfigSchema,
  DirectExecutorConfigSchema,
  ACPExecutorConfigSchema,
} from "./types.ts";
import {
  registerExecutor,
  createExecutor,
  loadBuiltinExecutors,
  executors,
} from "./registry.ts";
import type { ExecutorConfig } from "./types.ts";

describe("ExecutorConfigSchema", () => {
  describe("DirectExecutorConfigSchema", () => {
    test("accepts valid direct config", () => {
      const config = { type: "direct" as const };
      const result = DirectExecutorConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    test("rejects invalid type", () => {
      const config = { type: "invalid" };
      const result = DirectExecutorConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe("ACPExecutorConfigSchema", () => {
    test("accepts minimal acp config", () => {
      const config = { type: "acp" as const };
      const result = ACPExecutorConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    test("accepts full acp config with stdio transport", () => {
      const config = {
        type: "acp" as const,
        transport: "stdio" as const,
        command: "claude-code-acp",
        args: [],
      };
      const result = ACPExecutorConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    test("accepts acp config for gemini", () => {
      const config = {
        type: "acp" as const,
        transport: "stdio" as const,
        command: "gemini",
        args: [],
      };
      const result = ACPExecutorConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    test("accepts acp config for codex", () => {
      const config = {
        type: "acp" as const,
        transport: "stdio" as const,
        command: "codex",
        args: [],
      };
      const result = ACPExecutorConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    test("accepts acp config with http transport", () => {
      const config = {
        type: "acp" as const,
        transport: "http" as const,
        url: "http://localhost:8080",
      };
      const result = ACPExecutorConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    test("defaults transport to stdio", () => {
      const config = { type: "acp" as const };
      const result = ACPExecutorConfigSchema.parse(config);
      expect(result.transport).toBe("stdio");
    });
  });

  describe("discriminated union", () => {
    test("correctly identifies direct type", () => {
      const config = { type: "direct" };
      const result = ExecutorConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("direct");
      }
    });

    test("correctly identifies acp type", () => {
      const config = { type: "acp", command: "claude-code-acp" };
      const result = ExecutorConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("acp");
      }
    });

    test("rejects unknown type", () => {
      const config = { type: "unknown" };
      const result = ExecutorConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });
});

describe("executor registry", () => {
  beforeEach(() => {
    // Clear registry before each test
    executors.clear();
  });

  test("registerExecutor adds factory to registry", () => {
    const mockFactory = async () => ({
      name: "test",
      type: "direct" as const,
      initialize: async () => {},
      execute: async () => ({ content: "test" }),
      cleanup: async () => {},
    });

    registerExecutor("test", mockFactory);
    expect(executors.has("test")).toBe(true);
  });

  test("createExecutor throws for unknown type", async () => {
    const config = { type: "unknown" } as unknown as ExecutorConfig;
    await expect(createExecutor(config)).rejects.toThrow("Unknown executor type: unknown");
  });

  test("createExecutor creates and initializes executor", async () => {
    let initialized = false;

    const mockFactory = async () => ({
      name: "test",
      type: "direct" as const,
      initialize: async () => {
        initialized = true;
      },
      execute: async () => ({ content: "test" }),
      cleanup: async () => {},
    });

    registerExecutor("direct", mockFactory);

    const executor = await createExecutor({ type: "direct" });
    expect(executor.name).toBe("test");
    expect(initialized).toBe(true);
  });

  test("loadBuiltinExecutors registers all executor types", async () => {
    await loadBuiltinExecutors();

    expect(executors.has("direct")).toBe(true);
    expect(executors.has("acp")).toBe(true);
  });
});

describe("executor interface", () => {
  beforeEach(async () => {
    executors.clear();
    await loadBuiltinExecutors();
  });

  test("direct executor has correct interface", async () => {
    const executor = await createExecutor({ type: "direct" });

    expect(executor.name).toBe("direct");
    expect(executor.type).toBe("direct");
    expect(typeof executor.initialize).toBe("function");
    expect(typeof executor.execute).toBe("function");
    expect(typeof executor.cleanup).toBe("function");
  });

  test("acp executor has correct interface", async () => {
    const config = ACPExecutorConfigSchema.parse({ type: "acp" });
    const executor = await createExecutor(config);

    expect(executor.name).toBe("acp");
    expect(executor.type).toBe("acp");
    expect(typeof executor.initialize).toBe("function");
    expect(typeof executor.execute).toBe("function");
    expect(typeof executor.cleanup).toBe("function");
  });

  test("executor cleanup can be called without error", async () => {
    const executor = await createExecutor({ type: "direct" });
    await expect(executor.cleanup()).resolves.toBeUndefined();
  });
});
