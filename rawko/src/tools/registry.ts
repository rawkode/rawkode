/**
 * Tool registry for rawko-sdk
 */

import type { AgentConfig } from "../config/types.ts";
import type { ToolDefinition, ToolResult } from "./types.ts";
import { filterToolsForAgent, applyGlobalBashFilter } from "./filter.ts";
import {
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
} from "./definitions/mod.ts";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private globalBashBlockedPatterns: string[] = [];

  constructor() {
    // Register built-in tools
    this.register(readTool);
    this.register(writeTool);
    this.register(editTool);
    this.register(globTool);
    this.register(grepTool);
    this.register(bashTool);
  }

  /**
   * All registered tools.
   */
  get allTools(): Map<string, ToolDefinition> {
    return new Map(this.tools);
  }

  /**
   * Register a tool.
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Unregister a tool.
   */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Get a tool by name.
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Set global bash blocked patterns.
   */
  setGlobalBashBlockedPatterns(patterns: string[]): void {
    this.globalBashBlockedPatterns = patterns;
  }

  /**
   * Get filtered tools for a specific agent.
   */
  getToolsForAgent(agent: AgentConfig): ToolDefinition[] {
    // Apply global bash filtering first
    const toolsWithGlobalFilter = new Map<string, ToolDefinition>();
    for (const [name, tool] of this.tools) {
      toolsWithGlobalFilter.set(
        name,
        applyGlobalBashFilter(tool, this.globalBashBlockedPatterns),
      );
    }

    // Then apply agent-specific filtering
    return filterToolsForAgent(agent, toolsWithGlobalFilter);
  }

  /**
   * Execute a tool by name.
   */
  async executeTool(name: string, input: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        output: `Unknown tool: ${name}. Available tools: ${[...this.tools.keys()].join(", ")}`,
        isError: true,
      };
    }

    if (!tool.handler) {
      return {
        output: `Tool '${name}' has no handler defined`,
        isError: true,
      };
    }

    try {
      return await tool.handler(input);
    } catch (error) {
      return {
        output: `Tool '${name}' failed: ${(error as Error).message}`,
        isError: true,
      };
    }
  }

  /**
   * List all registered tool names.
   */
  list(): string[] {
    return [...this.tools.keys()];
  }
}

/**
 * Default tool registry instance.
 */
export const defaultToolRegistry = new ToolRegistry();
