import Anthropic from "anthropic";
import type { AdapterRequest, ProviderAdapter, StructuredAdapterRequest } from "./adapter.ts";

const DEFAULT_TIMEOUT_MS = parseTimeoutEnv("RAWKO_ANTHROPIC_TIMEOUT_MS", 2_147_483_647);

export class AnthropicAdapter implements ProviderAdapter {
  provider = "anthropic" as const;
  private client: Anthropic | null = null;

  prewarm(): Promise<void> {
    this.getClient();
    return Promise.resolve();
  }

  async invoke(request: AdapterRequest): Promise<string> {
    const client = this.getClient();

    const response = await client.messages.create({
      model: request.route.model,
      max_tokens: 4096,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.prompt }],
    }, {
      timeout: DEFAULT_TIMEOUT_MS,
    });

    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Anthropic SDK returned empty output");
    }

    return text;
  }

  async invokeStructured(request: StructuredAdapterRequest): Promise<unknown> {
    const client = this.getClient();

    const response = await client.messages.parse({
      model: request.route.model,
      max_tokens: 4096,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: request.outputSchema,
        },
      },
    }, {
      timeout: DEFAULT_TIMEOUT_MS,
    });

    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new Error("Anthropic SDK returned empty structured output");
    }

    return response.parsed_output;
  }

  private getClient(): Anthropic {
    if (this.client) {
      return this.client;
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for anthropic provider");
    }

    this.client = new Anthropic({ apiKey });
    return this.client;
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
