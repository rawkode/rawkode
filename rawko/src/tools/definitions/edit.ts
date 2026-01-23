/**
 * Edit tool - Edit file with search/replace
 */

import type { ToolDefinition, ToolResult } from "../types.ts";

export const editTool: ToolDefinition = {
  name: "Edit",
  description:
    "Edit a file by replacing a specific string with new content. The old_string must be unique in the file to avoid ambiguity.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to edit",
      },
      old_string: {
        type: "string",
        description: "The exact text to find and replace (must be unique in the file)",
      },
      new_string: {
        type: "string",
        description: "The text to replace it with",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences instead of requiring uniqueness (default: false)",
        default: false,
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  handler: async (input: unknown): Promise<ToolResult> => {
    const { file_path, old_string, new_string, replace_all = false } = input as {
      file_path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    };

    try {
      const content = await Deno.readTextFile(file_path);

      // Count occurrences
      const occurrences = content.split(old_string).length - 1;

      if (occurrences === 0) {
        return {
          output: `Error: old_string not found in file. Make sure to match the exact text including whitespace.`,
          isError: true,
        };
      }

      if (occurrences > 1 && !replace_all) {
        return {
          output: `Error: old_string appears ${occurrences} times in the file. Either provide more context to make it unique, or set replace_all=true.`,
          isError: true,
        };
      }

      const newContent = replace_all
        ? content.replaceAll(old_string, new_string)
        : content.replace(old_string, new_string);

      await Deno.writeTextFile(file_path, newContent);

      const replacements = replace_all ? occurrences : 1;
      return {
        output: `Successfully replaced ${replacements} occurrence(s) in ${file_path}`,
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { output: `File not found: ${file_path}`, isError: true };
      }
      return {
        output: `Error editing file: ${(error as Error).message}`,
        isError: true,
      };
    }
  },
};
