/**
 * Tool filtering logic for agent-specific tool access
 */

import type { AgentConfig, BashFilter } from "../config/types.ts";
import type { ToolDefinition, ToolResult } from "./types.ts";

/**
 * Filter tools based on agent configuration.
 */
export function filterToolsForAgent(
  agent: AgentConfig,
  allTools: Map<string, ToolDefinition>,
): ToolDefinition[] {
  const { allowed, blocked, bashFilter } = agent.tools ?? {};

  let tools = [...allTools.values()];

  // If allowed is specified, filter to only allowed
  if (allowed?.length) {
    tools = tools.filter((t) => allowed.includes(t.name));
  }

  // Remove blocked tools
  if (blocked?.length) {
    tools = tools.filter((t) => !blocked.includes(t.name));
  }

  // Apply bash filtering if present
  if (bashFilter) {
    tools = tools.map((t) => {
      if (t.name === "Bash") {
        return wrapBashTool(t, bashFilter);
      }
      return t;
    });
  }

  return tools;
}

/**
 * Built-in dangerous patterns that are always blocked for security.
 * These patterns catch output redirection which could bypass file write restrictions.
 */
const BUILTIN_BLOCKED_PATTERNS: RegExp[] = [
  // Output redirection (>, >>, 1>, 2>, &>)
  // Matches: >file, > file, >>file, >> file, 1>file, 2>&1, etc.
  /(?:^|[^\\])[12]?>>?(?:\s*[^&\s]|\s+\S)/,
  // Here-doc/here-string (<<, <<<)
  /<<<?/,
  // Pipe to write commands (tee, dd)
  /\|\s*(?:tee|dd)\b/,
];

/**
 * Check if command contains dangerous output redirection patterns.
 */
function containsDangerousRedirection(command: string): string | null {
  for (const pattern of BUILTIN_BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return pattern.toString();
    }
  }
  return null;
}

/**
 * Wrap Bash tool with filtering logic.
 */
function wrapBashTool(
  tool: ToolDefinition,
  filter: BashFilter,
): ToolDefinition {
  const originalHandler = tool.handler;

  if (!originalHandler) {
    return tool;
  }

  return {
    ...tool,
    handler: async (input: unknown): Promise<ToolResult> => {
      const { command } = input as { command: string };

      // FIRST: Check for dangerous output redirection patterns
      // This runs BEFORE allowedCommands check to prevent bypasses like:
      // echo "content" > file  (echo might be "allowed" but redirection isn't)
      const dangerousPattern = containsDangerousRedirection(command);
      if (dangerousPattern) {
        return {
          output: `Command blocked: contains output redirection which is not allowed. Use the Write tool instead. Pattern: ${dangerousPattern}`,
          isError: true,
        };
      }

      // Check allowed commands
      if (filter.allowedCommands?.length) {
        const cmd = command.trim().split(/\s+/)[0];
        if (!filter.allowedCommands.includes(cmd)) {
          return {
            output: `Command '${cmd}' is not allowed in this mode. Allowed commands: ${filter.allowedCommands.join(", ")}`,
            isError: true,
          };
        }
      }

      // Check blocked patterns
      if (filter.blockedPatterns?.length) {
        for (const pattern of filter.blockedPatterns) {
          try {
            if (new RegExp(pattern).test(command)) {
              return {
                output: `Command blocked by security pattern: ${pattern}`,
                isError: true,
              };
            }
          } catch {
            // If pattern is not a valid regex, treat as literal match
            if (command.includes(pattern)) {
              return {
                output: `Command blocked by security pattern: ${pattern}`,
                isError: true,
              };
            }
          }
        }
      }

      return originalHandler(input);
    },
  };
}

/**
 * Apply global blocked patterns to bash tool.
 */
export function applyGlobalBashFilter(
  tool: ToolDefinition,
  globalBlockedPatterns: string[],
): ToolDefinition {
  if (tool.name !== "Bash" || !globalBlockedPatterns.length) {
    return tool;
  }

  return wrapBashTool(tool, { blockedPatterns: globalBlockedPatterns });
}
