import { Codex } from "@openai/codex-sdk";
import type { AdapterRequest, ProviderAdapter, StructuredAdapterRequest } from "./adapter.ts";

const DEFAULT_TIMEOUT_MS = parseTimeoutEnv("RAWKO_OPENAI_TIMEOUT_MS", 2_147_483_647);

interface InvocationResult {
  ok: boolean;
  text: string;
  error: string;
}

interface StructuredInvocationResult {
  ok: boolean;
  value: unknown;
  error: string;
}

interface CodexTurnLike {
  finalResponse?: string;
  items?: Array<Record<string, unknown>>;
}

export class OpenAIAdapter implements ProviderAdapter {
  provider = "openai" as const;
  private client: Codex | null = null;

  prewarm(): Promise<void> {
    this.getClient();
    return Promise.resolve();
  }

  async invoke(request: AdapterRequest): Promise<string> {
    const first = await this.invokeWithCodex(request, true);
    if (first.ok) {
      return first.text;
    }

    if (shouldRetryWithoutModel(first.error, request.route.model)) {
      const retry = await this.invokeWithCodex(request, false);
      if (retry.ok) {
        return retry.text;
      }
      throw new Error(retry.error);
    }

    throw new Error(first.error);
  }

  async invokeStructured(request: StructuredAdapterRequest): Promise<unknown> {
    const first = await this.invokeStructuredWithCodex(request, true);
    if (first.ok) {
      return first.value;
    }

    if (shouldRetryWithoutModel(first.error, request.route.model)) {
      const retry = await this.invokeStructuredWithCodex(request, false);
      if (retry.ok) {
        return retry.value;
      }
      throw new Error(retry.error);
    }

    throw new Error(first.error);
  }

  private getClient(): Codex {
    if (this.client) {
      return this.client;
    }

    // Codex SDK uses local Codex auth/session configuration when available.
    this.client = new Codex();
    return this.client;
  }

  private async invokeWithCodex(request: AdapterRequest, includeModel: boolean): Promise<InvocationResult> {
    const codex = this.getClient();
    const reasoning = mapReasoning(request.route.thinking);

    const thread = codex.startThread({
      workingDirectory: request.cwd,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      ...(includeModel && request.route.model?.trim() ? { model: request.route.model.trim() } : {}),
      ...(reasoning ? { modelReasoningEffort: reasoning } : {}),
    });

    const prompt = [
      `SYSTEM PROMPT (${request.agentName}):`,
      request.systemPrompt,
      "",
      "TASK:",
      request.prompt,
    ].join("\n");

    try {
      const turn = await withTimeout(thread.run(prompt), DEFAULT_TIMEOUT_MS, "codex turn");
      const text = extractTurnText(turn as CodexTurnLike);
      if (!text) {
        return {
          ok: false,
          text: "",
          error: "Codex SDK returned empty output",
        };
      }

      return {
        ok: true,
        text,
        error: "",
      };
    } catch (error) {
      return {
        ok: false,
        text: "",
        error: stringifyError(error),
      };
    }
  }

  private async invokeStructuredWithCodex(
    request: StructuredAdapterRequest,
    includeModel: boolean,
  ): Promise<StructuredInvocationResult> {
    const codex = this.getClient();
    const reasoning = mapReasoning(request.route.thinking);

    const thread = codex.startThread({
      workingDirectory: request.cwd,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      ...(includeModel && request.route.model?.trim() ? { model: request.route.model.trim() } : {}),
      ...(reasoning ? { modelReasoningEffort: reasoning } : {}),
    });

    const prompt = [
      `SYSTEM PROMPT (${request.agentName}):`,
      request.systemPrompt,
      "",
      "TASK:",
      request.prompt,
    ].join("\n");

    try {
      const turn = await withTimeout(
        thread.run(prompt, { outputSchema: request.outputSchema }),
        DEFAULT_TIMEOUT_MS,
        "codex structured turn",
      );
      const text = extractTurnText(turn as CodexTurnLike);
      if (!text) {
        return {
          ok: false,
          value: null,
          error: "Codex SDK returned empty structured output",
        };
      }

      const parsed = parseJsonFromText(text);
      if (parsed === null || parsed === undefined) {
        return {
          ok: false,
          value: null,
          error: "Codex SDK returned non-JSON structured output",
        };
      }

      return {
        ok: true,
        value: parsed,
        error: "",
      };
    } catch (error) {
      return {
        ok: false,
        value: null,
        error: stringifyError(error),
      };
    }
  }
}

function extractTurnText(turn: CodexTurnLike): string {
  const direct = typeof turn.finalResponse === "string" ? turn.finalResponse.trim() : "";
  if (direct) {
    return direct;
  }

  if (!Array.isArray(turn.items)) {
    return "";
  }

  const chunks: string[] = [];
  for (const item of turn.items) {
    const type = typeof item.type === "string" ? item.type : "";
    if (type !== "agent_message") {
      continue;
    }
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text) {
      chunks.push(text);
    }
  }

  return chunks.join("\n").trim();
}

function mapReasoning(
  thinking?: string,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const value = (thinking ?? "").trim().toLowerCase();
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return undefined;
}

function shouldRetryWithoutModel(message: string, model?: string): boolean {
  if (!model?.trim()) {
    return false;
  }

  const normalized = message.toLowerCase();
  return normalized.includes("model is not supported") ||
    normalized.includes("unsupported model") ||
    normalized.includes("model is unavailable") ||
    normalized.includes("unknown model") ||
    normalized.includes("invalid model");
}

function parseJsonFromText(text: string): unknown | null {
  const direct = tryParseJson(text);
  if (direct !== null) {
    return direct;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = tryParseJson(fenced[1]);
    if (parsed !== null) {
      return parsed;
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = tryParseJson(text.slice(start, end + 1));
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

function parseTimeoutEnv(name: string, fallbackMs: number): number {
  const raw = Deno.env.get(name);
  if (!raw) {
    return fallbackMs;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }
  return Math.floor(parsed);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    return await promise;
  }

  let timer: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
