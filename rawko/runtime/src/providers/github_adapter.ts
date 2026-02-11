import type { AdapterRequest, ProviderAdapter, StructuredAdapterRequest } from "./adapter.ts";
import { extractText } from "../util/text.ts";

type CopilotSdk = Record<string, unknown>;

let copilotSdkPromise: Promise<CopilotSdk> | null = null;
const DEFAULT_TIMEOUT_MS = parseTimeoutEnv("RAWKO_GITHUB_TIMEOUT_MS", 2_147_483_647);

export class GitHubAdapter implements ProviderAdapter {
  provider = "github" as const;

  async prewarm(): Promise<void> {
    await loadCopilotSdk();
  }

  async invoke(request: AdapterRequest): Promise<string> {
    const sdk = await withTimeout(loadCopilotSdk(), DEFAULT_TIMEOUT_MS, "github sdk init");
    const CopilotClient = sdk.CopilotClient as
      | (new (...args: unknown[]) => Record<string, unknown>)
      | undefined;

    if (!CopilotClient) {
      throw new Error("GitHub Copilot SDK is not available");
    }

    const client = new CopilotClient();
    const start = client.start as (() => Promise<void>) | undefined;
    const stop = client.stop as (() => Promise<void>) | undefined;
    const createSession = client.createSession as
      | ((...args: unknown[]) => Promise<Record<string, unknown>>)
      | undefined;

    if (!start || !stop || !createSession) {
      throw new Error("GitHub Copilot SDK client is missing required methods");
    }

    await withTimeout(start(), DEFAULT_TIMEOUT_MS, "github client start");
    try {
      const session = await withTimeout(
        createSession({ model: request.route.model }),
        DEFAULT_TIMEOUT_MS,
        "github session create",
      );

      const parts: string[] = [];
      const on = session.on as ((...args: unknown[]) => unknown) | undefined;
      if (on) {
        on((event: unknown) => {
          const text = extractCopilotEventText(event);
          if (text) {
            parts.push(text);
          }
        });
      }

      const send = session.send as ((...args: unknown[]) => Promise<unknown>) | undefined;
      if (!send) {
        throw new Error("GitHub Copilot SDK session.send is unavailable");
      }

      const result = await withTimeout(
        send({
          prompt: `${request.systemPrompt}\n\n${request.prompt}`,
        }),
        DEFAULT_TIMEOUT_MS,
        "github session send",
      );

      let output = parts.join("\n").trim();
      if (!output) {
        output = extractText(result).trim();
      }

      const destroy = session.destroy as (() => Promise<void>) | undefined;
      if (destroy) {
        await withTimeout(destroy(), DEFAULT_TIMEOUT_MS, "github session destroy");
      }

      if (!output) {
        throw new Error("GitHub adapter returned empty output");
      }
      return output;
    } finally {
      await withTimeout(stop(), DEFAULT_TIMEOUT_MS, "github client stop");
    }
  }

  invokeStructured(_request: StructuredAdapterRequest): Promise<unknown> {
    return Promise.reject(
      new Error("GitHub provider does not support structured outputs in this runtime"),
    );
  }
}

function loadCopilotSdk(): Promise<CopilotSdk> {
  if (copilotSdkPromise) {
    return copilotSdkPromise;
  }
  copilotSdkPromise = import("@github/copilot-sdk") as Promise<CopilotSdk>;
  return copilotSdkPromise;
}

function extractCopilotEventText(event: unknown): string {
  if (typeof event !== "object" || event === null) {
    return "";
  }
  const record = event as Record<string, unknown>;
  return extractText(record.data ?? record.message ?? record.content ?? record.text);
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
