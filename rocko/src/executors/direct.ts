import Handlebars from "handlebars";
import { queryRaw, extractJSON } from "../claude/index.ts";
import type {
  Executor,
  ExecutorConfig,
  ExecutorContext,
  ExecutorResponse,
  DirectExecutorConfig,
} from "./types.ts";
import type { PhaseExecutionContext } from "../phases/schema.ts";

// Register Handlebars helpers
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

/**
 * Direct executor - uses simple prompt/response via queryRaw()
 * This is the default executor and maintains backward compatibility.
 */
class DirectExecutor implements Executor {
  name = "direct";
  type = "direct" as const;
  private config: DirectExecutorConfig | null = null;

  async initialize(config: ExecutorConfig): Promise<void> {
    this.config = config as DirectExecutorConfig;
  }

  async execute(context: ExecutorContext): Promise<ExecutorResponse> {
    const { phase, executionContext, aiConfig, verbose, onStream } = context;

    // Render user prompt template
    const userPrompt = phase.userPromptTemplate
      ? renderTemplate(phase.userPromptTemplate, executionContext)
      : "";

    // Get AI config for this phase (phase-specific overrides global)
    const maxTurns = phase.ai?.maxTurns ?? aiConfig.maxTurns ?? 5;
    const model = phase.ai?.model ?? aiConfig.model;

    if (verbose) {
      console.log(`[${phase.id.toUpperCase()}] Querying Claude (direct)...`);
    }

    // Query Claude
    const claudeResponse = await queryRaw({
      prompt: userPrompt,
      systemPrompt: phase.systemPrompt,
      maxTurns,
      model,
      onStream,
      onMessage: (msg) => {
        if (verbose && msg.type === "assistant") {
          console.log(`[${phase.id.toUpperCase()}] Claude response received`);
        }
      },
    });

    // Parse JSON response if output schema is defined
    let parsedResponse: unknown = undefined;
    if (phase.output) {
      const parsed = extractJSON<unknown>(claudeResponse.content);
      if (parsed) {
        parsedResponse = parsed;
      } else if (verbose) {
        console.warn(`[${phase.id.toUpperCase()}] Could not parse JSON from response`);
      }
    }

    return {
      content: claudeResponse.content,
      parsedResponse,
      usage: {
        inputTokens: claudeResponse.inputTokens,
        outputTokens: claudeResponse.outputTokens,
      },
    };
  }

  async cleanup(): Promise<void> {
    // No cleanup needed for direct executor
  }
}

export async function createDirectExecutor(_config: ExecutorConfig): Promise<Executor> {
  return new DirectExecutor();
}
