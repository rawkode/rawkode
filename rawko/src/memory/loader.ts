/**
 * Memory file loading functions
 * See SPEC-0005, SPEC-0007 for details
 */

import { parse as parseYaml } from "yaml";
import type { MemoryFrontmatter, MemoryMetadata, MemoryFile } from "./types.ts";

const MEMORIES_DIR = ".rawko/memories";

/**
 * Extract YAML frontmatter from markdown content.
 * Returns the frontmatter object and the remaining content.
 */
export function extractFrontmatter(content: string): {
  attrs: Record<string, unknown>;
  body: string;
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { attrs: {}, body: content };
  }

  try {
    const attrs = parseYaml(match[1]) as Record<string, unknown>;
    return { attrs, body: match[2].trim() };
  } catch {
    return { attrs: {}, body: content };
  }
}

/**
 * Load frontmatter from all memory files in the memories directory.
 * Only loads frontmatter for efficiency (not full content).
 */
export async function loadMemoryFrontmatter(): Promise<MemoryMetadata[]> {
  const memories: MemoryMetadata[] = [];

  try {
    for await (const entry of Deno.readDir(MEMORIES_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;

      const path = `${MEMORIES_DIR}/${entry.name}`;

      try {
        const content = await Deno.readTextFile(path);
        const { attrs } = extractFrontmatter(content);

        // Validate required fields
        if (!isValidFrontmatter(attrs)) {
          console.warn(`Invalid frontmatter in ${path}, skipping`);
          continue;
        }

        memories.push({
          path,
          filename: entry.name,
          frontmatter: attrs as unknown as MemoryFrontmatter,
        });
      } catch (error) {
        console.warn(`Failed to read memory file ${path}:`, error);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // memories directory doesn't exist yet, that's fine
      return [];
    }
    throw error;
  }

  return memories;
}

/**
 * Load all memory files with full content.
 */
export async function loadAllMemories(): Promise<MemoryFile[]> {
  const memories: MemoryFile[] = [];

  try {
    for await (const entry of Deno.readDir(MEMORIES_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;

      const path = `${MEMORIES_DIR}/${entry.name}`;

      try {
        const content = await Deno.readTextFile(path);
        const { attrs, body } = extractFrontmatter(content);

        // Validate required fields
        if (!isValidFrontmatter(attrs)) {
          console.warn(`Invalid frontmatter in ${path}, skipping`);
          continue;
        }

        memories.push({
          path,
          filename: entry.name,
          frontmatter: attrs as unknown as MemoryFrontmatter,
          content: body,
        });
      } catch (error) {
        console.warn(`Failed to read memory file ${path}:`, error);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // memories directory doesn't exist yet, that's fine
      return [];
    }
    throw error;
  }

  return memories;
}

/**
 * Load full content for selected memories.
 */
export async function loadMemoryContent(
  metadataList: MemoryMetadata[]
): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];

  for (const metadata of metadataList) {
    try {
      const content = await Deno.readTextFile(metadata.path);
      const { body } = extractFrontmatter(content);

      files.push({
        ...metadata,
        content: body,
      });
    } catch (error) {
      console.warn(`Failed to read memory file ${metadata.path}:`, error);
    }
  }

  return files;
}

/**
 * Validate that frontmatter has required fields.
 */
function isValidFrontmatter(
  attrs: Record<string, unknown>
): boolean {
  return (
    typeof attrs.title === "string" &&
    (typeof attrs.whenToUse === "string" || Array.isArray(attrs.whenToUse)) &&
    Array.isArray(attrs.tags) &&
    typeof attrs.importance === "string" &&
    ["low", "medium", "high", "critical"].includes(attrs.importance) &&
    typeof attrs.discoveredAt === "string" &&
    typeof attrs.discoveredBy === "string"
  );
}

/**
 * Get the memories directory path.
 */
export function getMemoriesDir(): string {
  return MEMORIES_DIR;
}
