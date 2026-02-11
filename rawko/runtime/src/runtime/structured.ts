import type { StructuredOutputSpec } from "./executor.ts";
import type {
  CouncilDecision,
  DelegationInstruction,
  ManagerDirective,
  ManagerMode,
} from "../types/runtime.ts";

const MANAGER_MODES: readonly ManagerMode[] = [
  "delegate",
  "council_vote",
  "reply_user",
  "await_user",
  "wait",
];

export interface ManagerDirectiveSpecOptions {
  minDelegations?: number;
}

export function buildManagerDirectiveOutputSpec(
  options: ManagerDirectiveSpecOptions = {},
): StructuredOutputSpec<ManagerDirective> {
  const minDelegations = Math.max(0, Math.floor(options.minDelegations ?? 0));
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: {
          type: "string",
          enum: MANAGER_MODES,
        },
        delegations: {
          type: ["array", "null"],
          minItems: minDelegations,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            agent: { type: "string" },
            task: { type: "string" },
            brief: { type: ["string", "null"] },
            config: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                runAfterSeconds: { type: ["number", "null"], minimum: 0 },
                maxRuntimeSeconds: { type: ["number", "null"], minimum: 1 },
                requiresDifferentAgent: { type: ["boolean", "null"] },
              },
              required: [
                "runAfterSeconds",
                "maxRuntimeSeconds",
                "requiresDifferentAgent",
              ],
            },
          },
          required: ["agent", "task", "brief", "config"],
        },
      },
        reply: { type: ["string", "null"] },
        notes: { type: ["string", "null"] },
      },
      required: ["mode", "delegations", "reply", "notes"],
    },
    parse: parseManagerDirectiveStructured,
  };
}

export const MANAGER_DIRECTIVE_OUTPUT_SPEC = buildManagerDirectiveOutputSpec();

export const COUNCIL_DECISION_OUTPUT_SPEC: StructuredOutputSpec<CouncilDecision> = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: {
        type: "string",
        enum: ["complete", "incomplete"],
      },
      feedback: { type: "string" },
    },
    required: ["verdict", "feedback"],
  },
  parse: parseCouncilDecisionStructured,
};

export function parseManagerDirectiveStructured(value: unknown): ManagerDirective {
  const record = asRecord(value, "Manager structured output must be an object");
  const mode = record.mode;
  if (!isManagerMode(mode)) {
    throw new Error(`Manager structured output has invalid mode: ${String(mode)}`);
  }

  const rawDelegations = record.delegations;
  const delegations = Array.isArray(rawDelegations)
    ? rawDelegations
      .map((entry) => asRecord(entry, "Manager delegation entry must be an object"))
      .map((entry) => ({
        agent: readString(entry, "agent"),
        task: readString(entry, "task"),
        brief: readOptionalString(entry, "brief"),
        config: parseDelegationConfig(entry.config),
      }))
      .filter((entry) => entry.agent.length > 0 && entry.task.length > 0)
    : undefined;

  const reply = typeof record.reply === "string" ? record.reply : undefined;
  const notes = typeof record.notes === "string" ? record.notes : undefined;

  return {
    mode,
    delegations,
    reply,
    notes,
  };
}

export function parseCouncilDecisionStructured(value: unknown): CouncilDecision {
  const record = asRecord(value, "Council structured output must be an object");
  const verdict = record.verdict;
  if (verdict !== "complete" && verdict !== "incomplete") {
    throw new Error(`Council structured output has invalid verdict: ${String(verdict)}`);
  }

  const feedback = readString(record, "feedback");
  if (!feedback.trim()) {
    throw new Error("Council structured output feedback must not be empty");
  }

  return {
    verdict,
    feedback,
  };
}

function asRecord(value: unknown, errorMessage: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string field "${key}" in structured output`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected string field "${key}" in structured output`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseDelegationConfig(value: unknown): DelegationInstruction["config"] {
  if (value === null || value === undefined) {
    return undefined;
  }
  const record = asRecord(value, "Delegation config must be an object");

  const runAfterRaw = record.runAfterSeconds;
  const maxRuntimeRaw = record.maxRuntimeSeconds;
  const requiresDifferentRaw = record.requiresDifferentAgent;

  const runAfterSeconds = asOptionalNumber(runAfterRaw, "runAfterSeconds", 0);
  const maxRuntimeSeconds = asOptionalNumber(maxRuntimeRaw, "maxRuntimeSeconds", 1);
  const requiresDifferentAgent = asOptionalBoolean(requiresDifferentRaw, "requiresDifferentAgent");

  if (
    runAfterSeconds === undefined &&
    maxRuntimeSeconds === undefined &&
    requiresDifferentAgent === undefined
  ) {
    return undefined;
  }

  return {
    runAfterSeconds,
    maxRuntimeSeconds,
    requiresDifferentAgent,
  };
}

function asOptionalNumber(
  value: unknown,
  key: string,
  minInclusive: number,
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minInclusive) {
    throw new Error(`Expected number field "${key}" >= ${minInclusive} in structured output`);
  }
  return value;
}

function asOptionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean field "${key}" in structured output`);
  }
  return value;
}

function isManagerMode(value: unknown): value is ManagerMode {
  return typeof value === "string" && (MANAGER_MODES as readonly string[]).includes(value);
}
