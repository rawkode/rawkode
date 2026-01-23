/**
 * Read tool - Read file contents
 */

import type { ToolDefinition, ToolResult } from "../types.ts";

export const readTool: ToolDefinition = {
  name: "Read",
  description:
    "Read the contents of a file. Returns the file content as text. Supports reading any text-based file.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to read",
      },
      offset: {
        type: "number",
        description:
          "Line number to start reading from (1-indexed). Only provide if the file is too large to read at once.",
      },
      limit: {
        type: "number",
        description:
          "Maximum number of lines to read. Only provide if the file is too large to read at once.",
      },
    },
    required: ["file_path"],
  },
  handler: async (input: unknown): Promise<ToolResult> => {
    const { file_path, offset, limit } = input as {
      file_path: string;
      offset?: number;
      limit?: number;
    };

    try {
      const content = await Deno.readTextFile(file_path);
      const lines = content.split("\n");

      let result = lines;
      if (offset !== undefined || limit !== undefined) {
        const start = (offset ?? 1) - 1;
        const end = limit !== undefined ? start + limit : undefined;
        result = lines.slice(start, end);
      }

      // Add line numbers
      const startLine = (offset ?? 1);
      const numbered = result.map(
        (line, i) => `${String(startLine + i).padStart(6, " ")}\t${line}`,
      );

      return { output: numbered.join("\n") };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { output: `File not found: ${file_path}`, isError: true };
      }
      return {
        output: `Error reading file: ${(error as Error).message}`,
        isError: true,
      };
    }
  },
};
