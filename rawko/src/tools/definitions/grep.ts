/**
 * Grep tool - Search file contents
 */

import type { ToolDefinition, ToolResult } from "../types.ts";

/**
 * Recursively walk a directory
 */
async function* walkDir(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = `${dir}/${entry.name}`;

    if (entry.isDirectory) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "target" ||
        entry.name === "dist" ||
        entry.name === ".deno"
      ) {
        continue;
      }
      yield* walkDir(fullPath);
    } else {
      yield fullPath;
    }
  }
}

/**
 * Check if a file should be searched (text files only)
 */
function isTextFile(path: string): boolean {
  const textExtensions = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".yaml",
    ".yml",
    ".toml",
    ".txt",
    ".html",
    ".css",
    ".scss",
    ".less",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".sql",
    ".graphql",
    ".xml",
    ".svg",
    ".vue",
    ".svelte",
  ];

  return textExtensions.some((ext) => path.endsWith(ext));
}

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export const grepTool: ToolDefinition = {
  name: "Grep",
  description:
    "Search for a pattern in file contents. Supports regular expressions. Returns matching lines with file paths and line numbers.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The regex pattern to search for in file contents",
      },
      path: {
        type: "string",
        description:
          "File or directory to search in. Defaults to current working directory.",
      },
      glob: {
        type: "string",
        description:
          'Optional glob pattern to filter files (e.g., "*.ts", "*.{ts,tsx}")',
      },
      case_insensitive: {
        type: "boolean",
        description: "Case insensitive search (default: false)",
      },
      context_lines: {
        type: "number",
        description: "Number of context lines to show before and after matches",
      },
    },
    required: ["pattern"],
  },
  handler: async (input: unknown): Promise<ToolResult> => {
    const {
      pattern,
      path = Deno.cwd(),
      glob,
      case_insensitive = false,
      context_lines = 0,
    } = input as {
      pattern: string;
      path?: string;
      glob?: string;
      case_insensitive?: boolean;
      context_lines?: number;
    };

    try {
      const regex = new RegExp(pattern, case_insensitive ? "gi" : "g");
      const matches: GrepMatch[] = [];

      const stat = await Deno.stat(path);

      if (stat.isFile) {
        // Search single file
        const content = await Deno.readTextFile(path);
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({
              file: path,
              line: i + 1,
              content: lines[i],
            });
          }
          regex.lastIndex = 0; // Reset regex state
        }
      } else {
        // Search directory
        for await (const filePath of walkDir(path)) {
          if (!isTextFile(filePath)) continue;

          if (glob) {
            const fileName = filePath.split("/").pop() ?? "";
            const globRegex = new RegExp(
              glob
                .replace(/\./g, "\\.")
                .replace(/\*/g, ".*")
                .replace(/\{([^}]+)\}/g, (_match, group) => `(${group.replace(/,/g, "|")})`),
            );
            if (!globRegex.test(fileName)) continue;
          }

          try {
            const content = await Deno.readTextFile(filePath);
            const lines = content.split("\n");

            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                matches.push({
                  file: filePath,
                  line: i + 1,
                  content: lines[i],
                });
              }
              regex.lastIndex = 0;
            }
          } catch {
            // Skip files that can't be read
          }
        }
      }

      if (matches.length === 0) {
        return { output: `No matches found for pattern: ${pattern}` };
      }

      // Format output
      const output = matches
        .slice(0, 100) // Limit results
        .map((m) => `${m.file}:${m.line}: ${m.content}`)
        .join("\n");

      const suffix =
        matches.length > 100 ? `\n\n... and ${matches.length - 100} more matches` : "";

      return { output: output + suffix };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { output: `Invalid regex pattern: ${pattern}`, isError: true };
      }
      return {
        output: `Error searching: ${(error as Error).message}`,
        isError: true,
      };
    }
  },
};
