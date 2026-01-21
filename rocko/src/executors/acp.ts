import Handlebars from "handlebars";
import { spawn, type Subprocess } from "bun";
import { join } from "node:path";
import { extractJSON } from "../claude/index.ts";

/**
 * Resolve a command, checking node_modules/.bin/ first, then falling back to PATH
 */
async function resolveCommand(command: string): Promise<string> {
  // Check local node_modules/.bin/ first
  const localBin = join(process.cwd(), "node_modules", ".bin", command);
  const localBinFile = Bun.file(localBin);
  if (await localBinFile.exists()) {
    return localBin;
  }

  // Fall back to PATH (command as-is)
  return command;
}
import type {
  Executor,
  ExecutorConfig,
  ExecutorContext,
  ExecutorResponse,
  ACPExecutorConfig,
  ToolCallRecord,
} from "./types.ts";
import type { PhaseExecutionContext } from "../phases/schema.ts";

// Register Handlebars helpers (shared with other executors)
Handlebars.registerHelper("json", function (context) {
  return JSON.stringify(context, null, 2);
});

Handlebars.registerHelper("eq", function (a, b) {
  return a === b;
});

Handlebars.registerHelper("ne", function (a, b) {
  return a !== b;
});

Handlebars.registerHelper("gt", function (a, b) {
  return a > b;
});

Handlebars.registerHelper("lt", function (a, b) {
  return a < b;
});

Handlebars.registerHelper("and", function (...args) {
  args.pop(); // Remove Handlebars options object
  return args.every(Boolean);
});

Handlebars.registerHelper("or", function (...args) {
  args.pop(); // Remove Handlebars options object
  return args.some(Boolean);
});

/**
 * Render a Handlebars template with the given context
 */
function renderTemplate(template: string, context: PhaseExecutionContext): string {
  const compiled = Handlebars.compile(template, { noEscape: true });
  return compiled(context);
}

// JSON-RPC types for ACP protocol
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface ACPSessionUpdate {
  content?: string;
  done?: boolean;
  error?: string;
  tool_calls?: Array<{
    name: string;
    input: unknown;
    output?: unknown;
  }>;
}

/**
 * ACP executor - uses Agent Client Protocol to communicate with external agents
 */
class ACPExecutor implements Executor {
  name = "acp";
  type = "acp" as const;
  private config: ACPExecutorConfig | null = null;
  private process: Subprocess | null = null;
  private sessionId: string | null = null;
  private requestId = 0;
  private initialized = false;
  private pendingResponses = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
  }>();
  private updateCallbacks: ((update: ACPSessionUpdate) => void)[] = [];
  private outputBuffer = "";

  async initialize(config: ExecutorConfig): Promise<void> {
    this.config = config as ACPExecutorConfig;
  }

  private async startProcess(): Promise<void> {
    if (!this.config) {
      throw new Error("ACP executor not initialized");
    }

    if (this.config.transport !== "stdio") {
      throw new Error(`ACP transport '${this.config.transport}' not yet implemented`);
    }

    if (!this.config.command) {
      throw new Error("ACP stdio transport requires 'command' to be specified");
    }

    // Resolve command from node_modules/.bin/ or PATH
    const resolvedCommand = await resolveCommand(this.config.command);

    // Spawn the subprocess
    console.error(`[ACP] Starting: ${resolvedCommand} ${(this.config.args || []).join(" ")}`);
    this.process = spawn({
      cmd: [resolvedCommand, ...(this.config.args || [])],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    // Start reading stdout
    this.startReadingOutput();

    // Send initialize request (ACP protocol version 1)
    const initResponse = await this.sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        streaming: true,
      },
      clientInfo: {
        name: "rocko",
        version: "0.1.0",
      },
    });

    if (initResponse.error) {
      const errorDetails = initResponse.error.data
        ? ` (${JSON.stringify(initResponse.error.data)})`
        : "";
      throw new Error(`ACP initialization failed: ${initResponse.error.message}${errorDetails}`);
    }

    this.initialized = true;
  }

  private startReadingOutput(): void {
    const stdout = this.process?.stdout;
    if (!stdout || typeof stdout === "number") return;

    const reader = (stdout as ReadableStream<Uint8Array>).getReader();

    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          this.outputBuffer += new TextDecoder().decode(value);
          this.processOutputBuffer();
        }
      } catch {
        // Process ended
      }
    };

    readLoop();
  }

  private processOutputBuffer(): void {
    // Process newline-delimited JSON
    const lines = this.outputBuffer.split("\n");
    this.outputBuffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        console.error(`[ACP] <<< ${line}`);
        const message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;

        if ("id" in message) {
          // Response to our request
          const pending = this.pendingResponses.get(message.id);
          if (pending) {
            this.pendingResponses.delete(message.id);
            pending.resolve(message);
          }
        } else if ("method" in message) {
          // Notification
          this.handleNotification(message);
        }
      } catch (error) {
        console.warn("Failed to parse ACP message:", line);
      }
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "session/update") {
      const update = notification.params as ACPSessionUpdate;
      for (const callback of this.updateCallbacks) {
        callback(update);
      }
    }
  }

  private async sendRequest(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const stdin = this.process?.stdin;
    if (!stdin || typeof stdin === "number") {
      throw new Error("ACP process not started or stdin not available");
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingResponses.set(id, { resolve, reject });

      const data = JSON.stringify(request) + "\n";
      console.error(`[ACP] >>> ${data.trim()}`);
      (stdin as { write: (data: string) => void }).write(data);

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.pendingResponses.has(id)) {
          this.pendingResponses.delete(id);
          reject(new Error(`ACP request timed out: ${method}`));
        }
      }, 5 * 60 * 1000);
    });
  }

  async execute(context: ExecutorContext): Promise<ExecutorResponse> {
    const { phase, executionContext, aiConfig, verbose, onStream } = context;

    if (!this.config) {
      throw new Error("ACP executor not initialized");
    }

    // Start process if not already running
    if (!this.process) {
      await this.startProcess();
    }

    // Render user prompt template
    const userPrompt = phase.userPromptTemplate
      ? renderTemplate(phase.userPromptTemplate, executionContext)
      : "";

    // Build full prompt with system prompt
    const fullPrompt = phase.systemPrompt
      ? `${phase.systemPrompt}\n\n---\n\n${userPrompt}`
      : userPrompt;

    if (verbose) {
      console.log(`[${phase.id.toUpperCase()}] Querying external agent (acp)...`);
    }

    // Track tool calls and content
    const toolCalls: ToolCallRecord[] = [];
    let content = "";

    // Set up update callback to track progress
    const updatePromise = new Promise<void>((resolve) => {
      const callback = (update: ACPSessionUpdate) => {
        if (update.content) {
          // Stream delta to caller if callback provided
          if (onStream) {
            const delta = update.content.slice(content.length);
            if (delta) {
              onStream(delta);
            }
          }
          content = update.content;
        }

        if (update.tool_calls) {
          for (const tc of update.tool_calls) {
            toolCalls.push({
              name: tc.name,
              input: tc.input,
              output: tc.output,
            });
            if (verbose) {
              console.log(`[${phase.id.toUpperCase()}] Tool call: ${tc.name}`);
            }
          }
        }

        if (update.done || update.error) {
          // Remove callback
          const idx = this.updateCallbacks.indexOf(callback);
          if (idx >= 0) {
            this.updateCallbacks.splice(idx, 1);
          }
          resolve();
        }
      };

      this.updateCallbacks.push(callback);
    });

    // Create a new session if needed
    if (!this.sessionId) {
      const sessionResponse = await this.sendRequest("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      });
      if (sessionResponse.error) {
        throw new Error(`Failed to create ACP session: ${sessionResponse.error.message}`);
      }
      this.sessionId = (sessionResponse.result as { sessionId: string }).sessionId;
    }

    // Send prompt
    const promptResponse = await this.sendRequest("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: fullPrompt }],
    });

    if (promptResponse.error) {
      throw new Error(`ACP prompt failed: ${promptResponse.error.message}`);
    }

    // Wait for completion via updates, or use immediate result
    const result = promptResponse.result as { content?: string; done?: boolean } | undefined;
    if (result?.done) {
      content = result.content || "";
    } else {
      // Wait for streaming updates to complete
      await updatePromise;
    }

    if (verbose) {
      console.log(`[${phase.id.toUpperCase()}] External agent response received`);
    }

    // Parse JSON response if output schema is defined
    let parsedResponse: unknown = undefined;
    if (phase.output) {
      const parsed = extractJSON<unknown>(content);
      if (parsed) {
        parsedResponse = parsed;
      } else if (verbose) {
        console.warn(`[${phase.id.toUpperCase()}] Could not parse JSON from response`);
      }
    }

    return {
      content,
      parsedResponse,
      toolCalls,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  }

  async cleanup(): Promise<void> {
    // Close session if open
    if (this.sessionId && this.process) {
      try {
        await this.sendRequest("session/close", {
          sessionId: this.sessionId,
        });
      } catch {
        // Ignore errors during cleanup
      }
      this.sessionId = null;
    }

    // Kill process if running
    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    this.initialized = false;
    this.pendingResponses.clear();
    this.updateCallbacks = [];
  }
}

export async function createACPExecutor(_config: ExecutorConfig): Promise<Executor> {
  return new ACPExecutor();
}
