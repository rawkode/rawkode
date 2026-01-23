/**
 * Tool types for rawko-sdk
 */

export const BUILTIN_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
] as const;

export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

export interface JSONSchemaProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: (string | number)[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  default?: unknown;
}

export interface JSONSchema {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export type ToolHandler = (input: unknown) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
  handler?: ToolHandler;
}
