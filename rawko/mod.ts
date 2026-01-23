/**
 * rawko-sdk - LLM-based agent orchestration framework
 *
 * @module
 */

import { createActor } from "xstate";
import { loadConfig, getAgentsFromConfig, validateAgentSet } from "./src/config/mod.ts";
import type { RawkoTSConfig, AgentDefinition } from "./src/config/mod.ts";
import { ProviderFactory } from "./src/providers/mod.ts";
import type { Provider } from "./src/providers/mod.ts";
import { ToolRegistry, defaultToolRegistry } from "./src/tools/mod.ts";
import { createRawkoMachine } from "./src/machine/mod.ts";
import type { RawkoContext } from "./src/machine/mod.ts";
import { Arbiter } from "./src/arbiter/mod.ts";
import type { GeneratePlanOutput } from "./src/arbiter/mod.ts";
import { loadMemoryFrontmatter } from "./src/memory/mod.ts";

export interface RawkoOptions {
  /** Base path for config file (default: current directory, loads .rawko.ts) */
  basePath?: string;
  /** Override provider */
  provider?: Provider;
  /** Override tool registry */
  toolRegistry?: ToolRegistry;
  /** Verbose logging */
  verbose?: boolean;
}

export interface RawkoResult {
  success: boolean;
  output: string;
  iterations: number;
  context: RawkoContext;
}

/**
 * Main Rawko class for running agent workflows.
 */
export class Rawko {
  private config: RawkoTSConfig | null = null;
  private agents: Map<string, AgentDefinition> = new Map();
  private provider: Provider | null = null;
  private arbiter: Arbiter | null = null;
  private toolRegistry: ToolRegistry;
  private options: RawkoOptions;

  constructor(options: RawkoOptions = {}) {
    this.options = options;
    this.toolRegistry = options.toolRegistry ?? defaultToolRegistry;
  }

  /**
   * Initialize rawko by loading configuration.
   */
  async init(): Promise<void> {
    const basePath = this.options.basePath ?? ".";

    this.config = await loadConfig(basePath);
    this.agents = getAgentsFromConfig(this.config);

    // Validate agents
    const validation = validateAgentSet(this.agents);
    if (!validation.valid) {
      throw new Error(`Agent validation failed: ${validation.errors.join(", ")}`);
    }
    for (const warning of validation.warnings) {
      console.warn(`[rawko] Warning: ${warning}`);
    }

    // Set up provider
    this.provider = this.options.provider ?? ProviderFactory.get(this.config.provider.default);

    // Set up arbiter
    this.arbiter = new Arbiter({
      config: this.config.arbiter,
    });

    // Apply global tool configuration
    if (this.config.tools?.bash?.globalBlockedPatterns) {
      this.toolRegistry.setGlobalBashBlockedPatterns(
        this.config.tools.bash.globalBlockedPatterns,
      );
    }
  }

  /**
   * Run a task through the agent workflow.
   */
  async run(task: string): Promise<RawkoResult> {
    if (!this.config || !this.provider) {
      await this.init();
    }

    // Create the state machine with provider config for per-agent sessions
    const machine = createRawkoMachine({
      arbiterConfig: this.config!.arbiter,
      toolRegistry: this.toolRegistry,
      providerConfig: this.config!.provider,
    });

    // Create the actor - sessions are now created per-agent
    const actor = createActor(machine, {
      input: {
        agents: this.agents,
        providerConfig: this.config!.provider,
        maxIterations: this.config!.constraints.maxIterations,
        maxFailures: this.config!.constraints.maxFailures,
        defaultAgent: this.config!.agents.default,
      },
    });

    return new Promise((resolve) => {
      actor.subscribe((snapshot) => {
        if (snapshot.status === "done") {
          const context = snapshot.context;
          resolve({
            success: snapshot.value === "complete",
            output: context.lastArbiterDecision?.type === "COMPLETE"
              ? (context.lastArbiterDecision as { summary: string }).summary
              : "Task did not complete successfully",
            iterations: context.iterationCount,
            context,
          });
        }
      });

      actor.start();
      actor.send({ type: "START_TASK", task });
    });
  }

  /**
   * Generate an execution plan for a task without executing it.
   * This is the first step of the arbiter flow - analyzing the task
   * and producing a structured plan.
   */
  async generatePlan(task: string): Promise<GeneratePlanOutput> {
    if (!this.config || !this.arbiter) {
      await this.init();
    }

    // Load memory frontmatter for context
    const memories = await loadMemoryFrontmatter();

    return this.arbiter!.generatePlan({
      task,
      memories,
      agents: this.agents,
      arbiterConfig: this.config!.arbiter,
    });
  }

  /**
   * Get the loaded configuration.
   */
  getConfig(): RawkoTSConfig | null {
    return this.config;
  }

  /**
   * Get the loaded agents.
   */
  getAgents(): Map<string, AgentDefinition> {
    return this.agents;
  }

  /**
   * Get the tool registry.
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }
}

// Re-export key types and utilities
export type { RawkoTSConfig, RawkoTSConfig as RawkoConfig, AgentDefinition, AgentDefinition as AgentConfig } from "./src/config/mod.ts";
export type { Provider, ProviderSession, Message, StreamEvent } from "./src/providers/mod.ts";
export type { ToolDefinition, ToolResult, ToolRegistry } from "./src/tools/mod.ts";
export type {
  ArbiterDecision,
  ExecutionEntry,
  ExecutionPlan,
  ExecutionPlanStep,
  GeneratePlanInput,
  GeneratePlanOutput,
} from "./src/arbiter/mod.ts";
export { ExecutionPlanSchema, ExecutionPlanStepSchema } from "./src/arbiter/mod.ts";
export type { RawkoContext, RawkoEvent } from "./src/machine/mod.ts";

// Plan types and utilities
export type {
  Plan,
  PlanStep,
  PlanStatus,
  StepStatus,
  PlanMetadata,
  CreatePlanInput,
  CreatePlanOutput,
  ReplanInput,
  ReplanOutput,
} from "./src/plan/mod.ts";
export {
  createPlan,
  startStep,
  completeStep,
  failStep,
  skipStep,
  replan,
  addSteps,
  findNextPendingStep,
  isPlanComplete,
  countCompletedSteps,
  getCurrentStep,
  getRemainingSteps,
  getPlanSummary,
  savePlan,
  loadPlan,
  deletePlan,
  listPlans,
  findPlansByStatus,
  getMostRecentPlan,
  archivePlan,
} from "./src/plan/mod.ts";

// Memory types and utilities
export type {
  MemoryImportance,
  MemoryFrontmatter,
  MemoryMetadata,
  MemoryFile,
  MemoryExtractionInput,
  MemoryExtractionOutput,
  MemoryMatchContext,
  FindMemoriesOptions,
} from "./src/memory/mod.ts";
export {
  loadMemoryFrontmatter,
  loadAllMemories,
  loadMemoryContent,
  appendMemory,
  writeMemory,
  extractMemory,
  extractAndSaveMemory,
  findRelevantMemories,
  formatMemoriesForPrompt,
  buildAgentPromptWithMemories,
  getRelevantMemoriesForTask,
} from "./src/memory/mod.ts";

export { ProviderFactory, MockProvider, ClaudeProvider, CopilotProvider } from "./src/providers/mod.ts";
export { defaultToolRegistry } from "./src/tools/mod.ts";
export { Arbiter } from "./src/arbiter/mod.ts";
export { createRawkoMachine } from "./src/machine/mod.ts";
export { loadConfig, getAgentsFromConfig, validateAgentSet } from "./src/config/mod.ts";
