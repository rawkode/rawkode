/**
 * Provider factory for rawko-sdk
 */

import type { Provider, ProviderSession, SessionConfig } from "./types.ts";
import { ClaudeProvider } from "./claude.ts";
import { CopilotProvider } from "./copilot.ts";
import { MockProvider } from "./mock.ts";

export interface SessionWithFallbackOptions {
  primaryProvider: string;
  fallbackProvider: string;
  config: SessionConfig;
  onFallback?: (error: Error, fallbackName: string) => void;
}

export class ProviderFactory {
  private static providers = new Map<string, Provider>();

  static {
    // Register built-in providers
    this.register(new ClaudeProvider());
    this.register(new CopilotProvider());
    this.register(new MockProvider());
  }

  /**
   * Register a provider implementation.
   */
  static register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Get a registered provider by name.
   */
  static get(name: string): Provider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(
        `Provider not found: ${name}. Available: ${[...this.providers.keys()].join(", ")}`,
      );
    }
    return provider;
  }

  /**
   * Check if a provider is registered.
   */
  static has(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * List all registered provider names.
   */
  static list(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Unregister a provider.
   */
  static unregister(name: string): void {
    this.providers.delete(name);
  }

  /**
   * Create a new Claude provider instance.
   * Auth is handled automatically by the Claude Agent SDK.
   */
  static createClaude(): ClaudeProvider {
    return new ClaudeProvider();
  }

  /**
   * Create a mock provider for testing.
   */
  static createMock(responses?: import("./mock.ts").MockResponse[]): MockProvider {
    return new MockProvider(responses);
  }

  /**
   * Create a session with fallback support.
   * If the primary provider fails, attempts to use the fallback provider.
   */
  static async createSessionWithFallback(
    options: SessionWithFallbackOptions,
  ): Promise<{ session: ProviderSession; usedFallback: boolean; providerName: string }> {
    const { primaryProvider, fallbackProvider, config, onFallback } = options;

    // Try primary provider first
    try {
      const provider = this.get(primaryProvider);
      const session = await provider.createSession(config);
      return { session, usedFallback: false, providerName: primaryProvider };
    } catch (primaryError) {
      // Log and try fallback
      const error = primaryError instanceof Error ? primaryError : new Error(String(primaryError));

      if (onFallback) {
        onFallback(error, fallbackProvider);
      }

      try {
        const fallback = this.get(fallbackProvider);
        const session = await fallback.createSession(config);
        return { session, usedFallback: true, providerName: fallbackProvider };
      } catch (fallbackError) {
        // Both failed - throw the original error with context
        throw new Error(
          `Primary provider '${primaryProvider}' failed: ${error.message}. ` +
          `Fallback provider '${fallbackProvider}' also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
      }
    }
  }
}
