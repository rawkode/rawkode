/**
 * Memory injection functions
 * See SPEC-0007, SPEC-0009 for details
 *
 * These functions find relevant memories and format them for injection
 * into agent prompts.
 */

import type {
  MemoryMetadata,
  MemoryFile,
  MemoryMatchContext,
  FindMemoriesOptions,
  MemoryImportance,
} from "./types.ts";
import { loadMemoryFrontmatter, loadMemoryContent } from "./loader.ts";

/**
 * Score relevance of a memory to a context (0-100).
 */
export function scoreMemoryRelevance(
  memory: MemoryMetadata,
  context: MemoryMatchContext
): number {
  let score = 0;
  const frontmatter = memory.frontmatter;

  // Base importance score (0-30 points)
  const importanceMap: Record<MemoryImportance, number> = {
    low: 5,
    medium: 15,
    high: 25,
    critical: 30,
  };
  score += importanceMap[frontmatter.importance] || 0;

  // Recency bonus (0-10 points)
  const ageHours =
    (Date.now() - new Date(frontmatter.discoveredAt).getTime()) / 3600000;
  if (ageHours < 24) score += 10;
  else if (ageHours < 72) score += 5;

  // Keyword match bonus (0-20 points)
  const taskWords = context.task.toLowerCase().split(/\s+/);
  const memoryTitle = frontmatter.title.toLowerCase();
  const matchedWords = taskWords.filter((w) =>
    w.length > 3 && memoryTitle.includes(w)
  );
  score += Math.min(20, matchedWords.length * 5);

  // Agent specialty match (0-15 points)
  if (frontmatter.tags) {
    const agentTags = getAgentTags(context.agentName);
    const commonTags = frontmatter.tags.filter((t) =>
      agentTags.includes(t.toLowerCase())
    );
    score += Math.min(15, commonTags.length * 5);
  }

  // Discovered by same agent (0-10 points)
  if (frontmatter.discoveredBy === context.agentName) {
    score += 10;
  }

  return Math.min(100, score);
}

/**
 * Check if memory matches whenToUse patterns.
 */
export function matchWhenToUse(
  whenToUse: string | string[],
  context: MemoryMatchContext
): boolean {
  const patterns = Array.isArray(whenToUse) ? whenToUse : [whenToUse];

  // Build searchable text from context
  const searchText = `${context.task} ${context.agentName}`.toLowerCase();

  for (const pattern of patterns) {
    if (matchPattern(pattern, searchText)) {
      return true;
    }
  }

  return false;
}

/**
 * Match a single pattern against text.
 */
export function matchPattern(pattern: string, text: string): boolean {
  const normalized = pattern.toLowerCase().trim();

  // 1. Pipe-separated alternatives (e.g., "auth|login|security")
  if (normalized.includes("|")) {
    const alternatives = normalized.split("|").map((s) => s.trim());
    return alternatives.some((alt) => text.includes(alt));
  }

  // 2. Regex with wildcards (e.g., "implement.*auth")
  if (normalized.includes("*") || normalized.includes("?")) {
    try {
      const regex = new RegExp(
        normalized.replace(/\*/g, ".*").replace(/\?/g, "."),
        "i"
      );
      return regex.test(text);
    } catch {
      // Invalid regex, fall through
    }
  }

  // 3. Regex syntax (e.g., "implement.{0,5}auth")
  if (normalized.includes(".") && normalized.includes("{")) {
    try {
      const regex = new RegExp(normalized, "i");
      return regex.test(text);
    } catch {
      // Invalid regex, fall through
    }
  }

  // 4. Simple substring match
  return text.includes(normalized);
}

/**
 * Check if memory meets importance threshold.
 */
export function meetsImportanceThreshold(
  memory: MemoryMetadata,
  minImportance: MemoryImportance
): boolean {
  const order: Record<MemoryImportance, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return order[memory.frontmatter.importance] >= order[minImportance];
}

/**
 * Get tags associated with an agent type.
 */
function getAgentTags(agentName: string): string[] {
  const tagMap: Record<string, string[]> = {
    planner: ["planning", "structure", "analysis", "architecture"],
    developer: ["implementation", "code", "patterns", "development"],
    tester: ["testing", "validation", "quality", "tests"],
    reviewer: ["review", "quality", "standards", "code-review"],
  };

  return tagMap[agentName] || [];
}

/**
 * Find memories relevant to an upcoming agent execution.
 */
export function findRelevantMemories(
  memories: MemoryMetadata[],
  context: MemoryMatchContext,
  options: FindMemoriesOptions = {}
): MemoryMetadata[] {
  const maxMemories = options.maxMemories ?? 5;
  const minImportance = options.minImportance ?? "low";

  // Score each memory
  const scored = memories
    .map((memory) => ({
      memory,
      score: scoreMemoryRelevance(memory, context),
      matches: matchWhenToUse(memory.frontmatter.whenToUse, context),
    }))
    .filter((item) => item.matches) // Only include if matches
    .filter((item) => meetsImportanceThreshold(item.memory, minImportance))
    .sort((a, b) => b.score - a.score);

  // Return top N
  return scored.slice(0, maxMemories).map((item) => item.memory);
}

/**
 * Format memories for agent system prompt.
 */
export function formatMemoriesForPrompt(memories: MemoryFile[]): string {
  if (memories.length === 0) {
    return "";
  }

  let formatted = "## Background Knowledge from Previous Runs\n\n";
  formatted +=
    "The following information was learned from prior runs and may be relevant:\n\n";

  for (const memory of memories) {
    formatted += `### ${memory.frontmatter.title}\n`;
    formatted += `*Importance: ${memory.frontmatter.importance.toUpperCase()}*\n`;
    formatted += `*Discovered by: ${memory.frontmatter.discoveredBy}*\n\n`;

    // Include content up to 500 chars or first heading
    let contentPreview = memory.content;
    const nextHeading = contentPreview.indexOf("\n# ");
    if (nextHeading > 0 && nextHeading < 500) {
      contentPreview = contentPreview.substring(0, nextHeading);
    } else if (contentPreview.length > 500) {
      contentPreview = contentPreview.substring(0, 500) + "...";
    }

    formatted += contentPreview + "\n\n";
  }

  return formatted;
}

/**
 * Build an agent system prompt with memory injection.
 */
export async function buildAgentPromptWithMemories(
  basePrompt: string,
  context: MemoryMatchContext,
  options: FindMemoriesOptions = {}
): Promise<string> {
  // Load available memories (just frontmatter)
  const allMemories = await loadMemoryFrontmatter();

  // Find relevant memories
  const relevantMetadata = findRelevantMemories(allMemories, context, options);

  if (relevantMetadata.length === 0) {
    return basePrompt;
  }

  // Load full content for selected memories
  const memoryFiles = await loadMemoryContent(relevantMetadata);

  // Format and add to prompt
  const memoryContext = formatMemoriesForPrompt(memoryFiles);

  return basePrompt + "\n\n" + memoryContext;
}

/**
 * Get relevant memories for a task (convenience function).
 */
export async function getRelevantMemoriesForTask(
  task: string,
  agentName: string,
  options: FindMemoriesOptions = {}
): Promise<MemoryFile[]> {
  const allMemories = await loadMemoryFrontmatter();

  const relevantMetadata = findRelevantMemories(
    allMemories,
    { task, agentName },
    options
  );

  return loadMemoryContent(relevantMetadata);
}
