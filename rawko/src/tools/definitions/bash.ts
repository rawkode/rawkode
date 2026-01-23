/**
 * Bash tool - Execute shell commands
 */

import type { ToolDefinition, ToolResult } from "../types.ts";

export const bashTool: ToolDefinition = {
  name: "Bash",
  description:
    "Execute a bash command. Use for running build tools, git commands, package managers, and other CLI operations. Commands run in the current working directory.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute",
      },
      timeout: {
        type: "number",
        description:
          "Optional timeout in milliseconds (default: 120000, max: 600000)",
      },
    },
    required: ["command"],
  },
  handler: async (input: unknown): Promise<ToolResult> => {
    const { command, timeout = 120000 } = input as {
      command: string;
      timeout?: number;
    };

    const effectiveTimeout = Math.min(timeout, 600000);

    try {
      const process = new Deno.Command("bash", {
        args: ["-c", command],
        stdout: "piped",
        stderr: "piped",
        cwd: Deno.cwd(),
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Command timed out")), effectiveTimeout);
      });

      const outputPromise = process.output();

      const result = await Promise.race([outputPromise, timeoutPromise]);

      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);

      if (result.code !== 0) {
        const output = stderr || stdout || `Command exited with code ${result.code}`;
        return { output, isError: true };
      }

      const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
      return { output: output || "(no output)" };
    } catch (error) {
      return {
        output: `Error executing command: ${(error as Error).message}`,
        isError: true,
      };
    }
  },
};
