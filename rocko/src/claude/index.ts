import { query } from "@anthropic-ai/claude-agent-sdk";
import { getGitRoot } from "../git/index.ts";
import type { AIConfig } from "../config/schema.ts";

export interface ClaudeMessage {
  type: string;
  content?: string;
}

export interface ClaudeResponse {
  content: string;
  messages: ClaudeMessage[];
  inputTokens: number;
  outputTokens: number;
}

export interface ClaudeQueryOptions {
  prompt: string;
  systemPrompt?: string;
  maxTurns?: number;
  model?: string;
  onMessage?: (message: ClaudeMessage) => void;
  onStream?: (delta: string) => void;
}

export async function queryWithParsing<T>(
  options: ClaudeQueryOptions,
  parser: (content: string) => T
): Promise<T> {
  const response = await queryRaw(options);
  return parser(response.content);
}

export async function queryRaw(options: ClaudeQueryOptions): Promise<ClaudeResponse> {
  const cwd = await getGitRoot().catch(() => process.cwd());

  const fullPrompt = options.systemPrompt
    ? `${options.systemPrompt}\n\n---\n\n${options.prompt}`
    : options.prompt;

  const q = query({
    prompt: fullPrompt,
    options: {
      maxTurns: options.maxTurns ?? 5,
      model: options.model as any,
      cwd,
      allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    },
  });

  let content = "";

  for await (const message of q) {
    if (message.type === "assistant" && message.message) {
      const textContent = message.message.content.find((c: any) => c.type === "text");
      if (textContent && "text" in textContent) {
        const newContent = textContent.text;
        // Stream delta if callback provided
        if (options.onStream && newContent.length > content.length) {
          const delta = newContent.slice(content.length);
          options.onStream(delta);
        }
        content = newContent;
        if (options.onMessage) {
          options.onMessage({ type: "assistant", content });
        }
      }
    }
  }

  return {
    content,
    messages: [{ type: "assistant", content }],
    inputTokens: 0,
    outputTokens: 0,
  };
}

export function extractJSON<T>(content: string): T | null {
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]!.trim()) as T;
    } catch {
      return null;
    }
  }

  try {
    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      return JSON.parse(content.slice(firstBrace, lastBrace + 1)) as T;
    }
  } catch {
    return null;
  }

  return null;
}

export function createClaudeConfig(aiConfig: AIConfig): Partial<ClaudeQueryOptions> {
  return {
    model: aiConfig.model,
    maxTurns: aiConfig.maxTurns,
  };
}
