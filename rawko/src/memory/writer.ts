/**
 * Memory file writing functions
 * See SPEC-0005 for details
 *
 * Memory files are append-only: never delete, never overwrite.
 */

import { stringify as stringifyYaml } from "yaml";
import type { MemoryFrontmatter, MemoryExtractionOutput } from "./types.ts";
import { getMemoriesDir } from "./loader.ts";

/**
 * Convert a title to a valid filename slug.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
    .replace(/\s+/g, "-") // Spaces to hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, "") // Trim leading/trailing hyphens
    .substring(0, 64); // Limit length
}

/**
 * Format a memory extraction output into a markdown file content.
 */
export function formatMemoryFile(
  memory: MemoryExtractionOutput
): string {
  if (!memory.frontmatter || !memory.content) {
    throw new Error("Memory must have frontmatter and content to format");
  }

  const frontmatter = stringifyYaml(memory.frontmatter);
  return `---\n${frontmatter}---\n\n${memory.content}`;
}

/**
 * Format frontmatter for a new memory.
 */
export function createFrontmatter(
  title: string,
  options: {
    whenToUse: string | string[];
    tags: string[];
    importance: "low" | "medium" | "high" | "critical";
    discoveredBy: string;
    discoveredIn?: string;
  }
): MemoryFrontmatter {
  return {
    title,
    whenToUse: options.whenToUse,
    tags: options.tags,
    importance: options.importance,
    discoveredAt: new Date().toISOString(),
    discoveredBy: options.discoveredBy,
    discoveredIn: options.discoveredIn,
  };
}

/**
 * Append a memory to the memories directory.
 * If a file with the same slug exists, the new content is appended
 * with a separator (memories are append-only, never overwritten).
 */
export async function appendMemory(
  memory: MemoryExtractionOutput
): Promise<string | null> {
  if (!memory.shouldCreateMemory || !memory.memoryTitle) {
    return null;
  }

  const memoriesDir = getMemoriesDir();

  // Ensure memories directory exists
  try {
    await Deno.mkdir(memoriesDir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      throw error;
    }
  }

  const filename = slugify(memory.memoryTitle);
  const filepath = `${memoriesDir}/${filename}.md`;

  // Format the new memory content
  const formatted = formatMemoryFile(memory);

  // Check if file exists and append (never overwrite)
  let content = formatted;
  try {
    const existing = await Deno.readTextFile(filepath);
    // Append with separator
    content = existing + "\n\n---\n\n" + formatted;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
    // File doesn't exist, use just the new content
  }

  // Write the file
  await Deno.writeTextFile(filepath, content);

  return filepath;
}

/**
 * Write a standalone memory file (for testing or manual creation).
 */
export async function writeMemory(
  frontmatter: MemoryFrontmatter,
  content: string,
  filename?: string
): Promise<string> {
  const memoriesDir = getMemoriesDir();

  // Ensure memories directory exists
  try {
    await Deno.mkdir(memoriesDir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      throw error;
    }
  }

  const slug = filename ?? slugify(frontmatter.title);
  const filepath = `${memoriesDir}/${slug}.md`;

  const yaml = stringifyYaml(frontmatter);
  const fileContent = `---\n${yaml}---\n\n${content}`;

  await Deno.writeTextFile(filepath, fileContent);

  return filepath;
}
