/**
 * Glob tool - Find files by pattern
 */

import type { ToolDefinition, ToolResult } from "../types.ts";

/**
 * Simple glob pattern matching
 */
function matchGlob(pattern: string, path: string): boolean {
  const regexPattern = pattern
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/{{GLOBSTAR}}/g, ".*");

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(path);
}

/**
 * Recursively walk a directory
 */
async function* walkDir(
  dir: string,
  basePath: string = "",
): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = basePath ? `${basePath}/${entry.name}` : entry.name;
    const fullPath = `${dir}/${entry.name}`;

    if (entry.isDirectory) {
      // Skip common directories that should be ignored
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "target" ||
        entry.name === "dist" ||
        entry.name === ".deno"
      ) {
        continue;
      }
      yield* walkDir(fullPath, path);
    } else {
      yield path;
    }
  }
}

export const globTool: ToolDefinition = {
  name: "Glob",
  description:
    "Find files matching a glob pattern. Supports ** for recursive matching and * for single directory level. Returns matching file paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          'The glob pattern to match files against (e.g., "**/*.ts", "src/**/*.tsx")',
      },
      path: {
        type: "string",
        description:
          "The directory to search in. Defaults to current working directory.",
      },
    },
    required: ["pattern"],
  },
  handler: async (input: unknown): Promise<ToolResult> => {
    const { pattern, path = Deno.cwd() } = input as {
      pattern: string;
      path?: string;
    };

    try {
      const matches: string[] = [];

      for await (const filePath of walkDir(path)) {
        if (matchGlob(pattern, filePath)) {
          matches.push(filePath);
        }
      }

      matches.sort();

      if (matches.length === 0) {
        return { output: `No files found matching pattern: ${pattern}` };
      }

      return { output: matches.join("\n") };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { output: `Directory not found: ${path}`, isError: true };
      }
      return {
        output: `Error searching files: ${(error as Error).message}`,
        isError: true,
      };
    }
  },
};
