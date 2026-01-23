/**
 * Write tool - Write file contents
 */

import type { ToolDefinition, ToolResult } from "../types.ts";

export const writeTool: ToolDefinition = {
  name: "Write",
  description:
    "Write content to a file. Creates the file if it doesn't exist, or overwrites if it does. Creates parent directories as needed.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to write",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },
  handler: async (input: unknown): Promise<ToolResult> => {
    const { file_path, content } = input as {
      file_path: string;
      content: string;
    };

    try {
      // Ensure parent directory exists
      const dir = file_path.substring(0, file_path.lastIndexOf("/"));
      if (dir) {
        await Deno.mkdir(dir, { recursive: true });
      }

      await Deno.writeTextFile(file_path, content);
      return { output: `Successfully wrote ${content.length} bytes to ${file_path}` };
    } catch (error) {
      return {
        output: `Error writing file: ${(error as Error).message}`,
        isError: true,
      };
    }
  },
};
