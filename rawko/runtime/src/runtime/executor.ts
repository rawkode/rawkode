import type { AgentDefinition, ProviderName } from "../types/agent.ts";
import { ProviderFactory } from "../providers/factory.ts";
import { warn } from "../util/logger.ts";
import type { OffSickAgent } from "../types/runtime.ts";

export class AgentOffSickError extends Error {
  constructor(agentName: string) {
    super(`Agent \"${agentName}\" is currently off sick`);
  }
}

interface OffSickRecord {
  at: string;
  error: string;
}

export interface ExecutorOptions {
  immediateRetries?: number;
  onOffSick?: (agentId: string, agentName: string, reason: string) => void;
  onRecovered?: (agentId: string, agentName: string) => void;
  onInvokeAttempt?: (meta: InvokeMeta) => void;
  onInvokeFailure?: (meta: InvokeFailureMeta) => void;
}

export interface InvokeMeta {
  agentId: string;
  agentName: string;
  provider: ProviderName;
  model: string;
  attempt: number;
  maxAttempts: number;
  probe: boolean;
}

export interface InvokeFailureMeta extends InvokeMeta {
  reason: string;
}

export interface StructuredOutputSpec<T> {
  schema: Record<string, unknown>;
  parse: (value: unknown) => T;
}

export class AgentExecutor {
  private readonly providerFactory: ProviderFactory;
  private readonly cwd: string;
  private readonly immediateRetries: number;
  private readonly onOffSick?: (agentId: string, agentName: string, reason: string) => void;
  private readonly onRecovered?: (agentId: string, agentName: string) => void;
  private readonly onInvokeAttempt?: (meta: InvokeMeta) => void;
  private readonly onInvokeFailure?: (meta: InvokeFailureMeta) => void;
  private readonly offSick = new Map<string, OffSickRecord>();

  constructor(providerFactory: ProviderFactory, cwd: string, options: ExecutorOptions = {}) {
    this.providerFactory = providerFactory;
    this.cwd = cwd;
    this.immediateRetries = options.immediateRetries ?? 4;
    this.onOffSick = options.onOffSick;
    this.onRecovered = options.onRecovered;
    this.onInvokeAttempt = options.onInvokeAttempt;
    this.onInvokeFailure = options.onInvokeFailure;
  }

  isOffSick(agent: AgentDefinition): boolean {
    return this.offSick.has(agent.id);
  }

  isOffSickById(agentId: string): boolean {
    return this.offSick.has(agentId);
  }

  getOffSickIds(): string[] {
    return [...this.offSick.keys()];
  }

  getOffSickReason(agent: AgentDefinition): string | undefined {
    return this.offSick.get(agent.id)?.error;
  }

  listOffSick(byId: Map<string, AgentDefinition>): OffSickAgent[] {
    return [...this.offSick.entries()].map(([agentId, record]) => ({
      agentId,
      agentName: byId.get(agentId)?.name ?? agentId,
      reason: record.error,
      at: record.at,
    }));
  }

  async invoke(agent: AgentDefinition, prompt: string): Promise<string> {
    if (this.offSick.has(agent.id)) {
      throw new AgentOffSickError(agent.name);
    }
    return await this.invokeTextWithRetries(agent, prompt, false);
  }

  async invokeStructured<T>(
    agent: AgentDefinition,
    prompt: string,
    spec: StructuredOutputSpec<T>,
  ): Promise<T> {
    if (this.offSick.has(agent.id)) {
      throw new AgentOffSickError(agent.name);
    }
    return await this.invokeStructuredWithRetries(agent, prompt, spec, false);
  }

  async probe(agent: AgentDefinition): Promise<boolean> {
    try {
      await this.invokeTextWithRetries(agent, "Are you alive?", true);
      if (this.offSick.delete(agent.id)) {
        this.onRecovered?.(agent.id, agent.name);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async invokeTextWithRetries(
    agent: AgentDefinition,
    prompt: string,
    isProbe: boolean,
  ): Promise<string> {
    const attempts = this.immediateRetries + 1;
    let lastError: unknown = undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const route = agent.models[attempt % agent.models.length];
      const adapter = this.providerFactory.get(route.provider);

      const meta: InvokeMeta = {
        agentId: agent.id,
        agentName: agent.name,
        provider: route.provider,
        model: route.model,
        attempt: attempt + 1,
        maxAttempts: attempts,
        probe: isProbe,
      };
      this.onInvokeAttempt?.(meta);

      try {
        const output = await adapter.invoke({
          agentId: agent.id,
          agentName: agent.name,
          cwd: this.cwd,
          systemPrompt: agent.systemPrompt,
          prompt,
          route,
        });

        if (this.offSick.delete(agent.id)) {
          this.onRecovered?.(agent.id, agent.name);
        }
        return output;
      } catch (error) {
        lastError = error;
        this.onInvokeFailure?.({
          ...meta,
          reason: stringifyError(error),
        });

        const waitMs = Math.min(2000, 200 * (attempt + 1));
        await sleep(waitMs);
      }
    }

    if (!isProbe) {
      const reason = stringifyError(lastError);
      this.offSick.set(agent.id, { at: new Date().toISOString(), error: reason });
      this.onOffSick?.(agent.id, agent.name, reason);
      warn(`Marked off sick: ${agent.name} (${reason})`);
    }

    throw new Error(`Failed invoking agent \"${agent.name}\" after ${attempts} attempts`);
  }

  private async invokeStructuredWithRetries<T>(
    agent: AgentDefinition,
    prompt: string,
    spec: StructuredOutputSpec<T>,
    isProbe: boolean,
  ): Promise<T> {
    const attempts = this.immediateRetries + 1;
    let lastError: unknown = undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const route = agent.models[attempt % agent.models.length];
      const adapter = this.providerFactory.get(route.provider);

      const meta: InvokeMeta = {
        agentId: agent.id,
        agentName: agent.name,
        provider: route.provider,
        model: route.model,
        attempt: attempt + 1,
        maxAttempts: attempts,
        probe: isProbe,
      };
      this.onInvokeAttempt?.(meta);

      try {
        const structured = await adapter.invokeStructured({
          agentId: agent.id,
          agentName: agent.name,
          cwd: this.cwd,
          systemPrompt: agent.systemPrompt,
          prompt,
          route,
          outputSchema: spec.schema,
        });
        const parsed = spec.parse(structured);

        if (this.offSick.delete(agent.id)) {
          this.onRecovered?.(agent.id, agent.name);
        }
        return parsed;
      } catch (error) {
        lastError = error;
        this.onInvokeFailure?.({
          ...meta,
          reason: stringifyError(error),
        });

        const waitMs = Math.min(2000, 200 * (attempt + 1));
        await sleep(waitMs);
      }
    }

    if (!isProbe) {
      const reason = stringifyError(lastError);
      this.offSick.set(agent.id, { at: new Date().toISOString(), error: reason });
      this.onOffSick?.(agent.id, agent.name, reason);
      warn(`Marked off sick: ${agent.name} (${reason})`);
    }

    throw new Error(`Failed invoking agent \"${agent.name}\" after ${attempts} attempts`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
