import type { ProviderName } from "../types/agent.ts";
import type { ProviderAdapter } from "./adapter.ts";
import { AnthropicAdapter } from "./anthropic_adapter.ts";
import { GitHubAdapter } from "./github_adapter.ts";
import { OpenAIAdapter } from "./openai_adapter.ts";

export class ProviderFactory {
  private readonly adapters: Map<ProviderName, ProviderAdapter>;

  constructor(adapters?: ProviderAdapter[]) {
    const instances = adapters ?? [
      new OpenAIAdapter(),
      new AnthropicAdapter(),
      new GitHubAdapter(),
    ];
    this.adapters = new Map(instances.map((adapter) => [adapter.provider, adapter]));
  }

  get(provider: ProviderName): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider: ${provider}`);
    }
    return adapter;
  }

  async prewarm(providers: Iterable<ProviderName>): Promise<void> {
    await Promise.all(
      [...providers].map(async (provider) => {
        const adapter = this.get(provider);
        if (adapter.prewarm) {
          await adapter.prewarm();
        }
      }),
    );
  }
}
