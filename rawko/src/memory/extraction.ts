/**
 * Memory extraction functions
 * See SPEC-0005 for details
 *
 * The Memory Extraction Agent runs after each agent completes to decide
 * if anything from the execution should be remembered long-term.
 */

import type { ArbiterConfig } from "../config/types.ts";
import type { Provider, ProviderSession } from "../providers/types.ts";
import { ProviderFactory } from "../providers/factory.ts";
import type {
  MemoryExtractionInput,
  MemoryExtractionOutput,
  MemoryMetadata,
  MemoryFrontmatter,
} from "./types.ts";
import { appendMemory } from "./writer.ts";
import { loadMemoryFrontmatter } from "./loader.ts";

/**
 * Build the extraction prompt for the LLM.
 */
export function buildExtractionPrompt(input: MemoryExtractionInput): string {
  const existingMemoriesSummary = input.existingMemories.length > 0
    ? input.existingMemories
        .map((m) => `- ${m.frontmatter.title} (${m.frontmatter.importance})`)
        .join("\n")
    : "No existing memories.";

  return `You are extracting long-term memories from an agent's execution.

## Agent Output
${truncateForPrompt(input.agentOutput, 4000)}

## Task
${input.task}

## Execution Result
${input.result}${input.error ? `\nError: ${input.error}` : ""}

## Agent
${input.agent}

## Existing Memories
${existingMemoriesSummary}

## Instructions

Evaluate: Is there something in this output worth remembering long-term?

**Examples of worth remembering:**
- Discovered codebase structure or file locations
- Found code patterns or conventions used in this project
- Identified dependencies or their versions
- Learned about constraints or limitations
- Identified what doesn't work (negative learning)
- Found architectural decisions or trade-offs
- Discovered important configuration details

**Examples NOT worth remembering:**
- Intermediate debugging steps
- Temporary files or commands
- Verbose explanations already in code
- Things obvious from reading the code
- Duplicates of existing memories

If YES, respond with JSON:
\`\`\`json
{
  "shouldCreateMemory": true,
  "memoryTitle": "Clear, specific title",
  "frontmatter": {
    "title": "Same as memoryTitle",
    "whenToUse": ["pattern1|pattern2", "when doing X"],
    "tags": ["tag1", "tag2"],
    "importance": "low|medium|high|critical",
    "discoveredBy": "${input.agent}",
    "discoveredIn": "${truncateForPrompt(input.task, 100)}"
  },
  "content": "# Title\\n\\nMarkdown content describing the learning...",
  "reasoning": "Why this is worth remembering"
}
\`\`\`

If NO, respond with JSON:
\`\`\`json
{
  "shouldCreateMemory": false,
  "reasoning": "Why this doesn't need to be remembered"
}
\`\`\`

Important:
- Keep content concise (200-500 words ideal)
- Use clear headings and code examples where relevant
- For whenToUse, include regex patterns that would match relevant tasks
- Don't duplicate existing memories
- Choose appropriate importance level:
  - critical: Essential project-wide knowledge
  - high: Important patterns or constraints
  - medium: Useful but not essential
  - low: Nice to have, may help occasionally`;
}

/**
 * Parse the LLM response into a MemoryExtractionOutput.
 */
export function parseExtractionResponse(response: string): MemoryExtractionOutput {
  // Extract JSON from response
  const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : response;

  try {
    const parsed = JSON.parse(jsonStr.trim());

    if (parsed.shouldCreateMemory === false) {
      return {
        shouldCreateMemory: false,
        reasoning: parsed.reasoning ?? "No reason provided",
      };
    }

    // Validate required fields for memory creation
    if (!parsed.memoryTitle || !parsed.frontmatter || !parsed.content) {
      return {
        shouldCreateMemory: false,
        reasoning: "Invalid extraction response: missing required fields",
      };
    }

    // Ensure discoveredAt is set
    const frontmatter: MemoryFrontmatter = {
      ...parsed.frontmatter,
      discoveredAt: parsed.frontmatter.discoveredAt ?? new Date().toISOString(),
    };

    return {
      shouldCreateMemory: true,
      memoryTitle: parsed.memoryTitle,
      frontmatter,
      content: parsed.content,
      reasoning: parsed.reasoning ?? "Worth remembering",
    };
  } catch (error) {
    console.warn("Failed to parse extraction response:", (error as Error).message);
    return {
      shouldCreateMemory: false,
      reasoning: `Failed to parse response: ${(error as Error).message}`,
    };
  }
}

/**
 * Extract memories from an agent execution using LLM.
 */
export async function extractMemory(
  input: MemoryExtractionInput,
  options: {
    provider?: Provider;
    config?: ArbiterConfig;
  } = {}
): Promise<MemoryExtractionOutput> {
  // Get provider (use arbiter config's provider by default)
  const provider = options.provider ??
    ProviderFactory.get(options.config?.provider ?? "claude");

  // Create session
  const session = await provider.createSession({
    model: options.config?.model ?? "claude-haiku-4",
    maxTokens: options.config?.maxTokens ?? 2048,
    temperature: 0.3,
    systemPrompt: "You are a memory extraction agent that identifies valuable learnings from agent executions. Always respond with valid JSON.",
  });

  try {
    const prompt = buildExtractionPrompt(input);
    let response = "";

    for await (const event of session.sendMessage({
      role: "user",
      content: prompt,
    })) {
      if (event.type === "text_delta") {
        response += event.delta;
      }
      if (event.type === "message_done") {
        response = event.message.content;
      }
    }

    return parseExtractionResponse(response);
  } finally {
    await session.close();
  }
}

/**
 * Run memory extraction and save if valuable.
 * This is the main entry point for the extraction flow.
 */
export async function extractAndSaveMemory(
  input: Omit<MemoryExtractionInput, "existingMemories">,
  options: {
    provider?: Provider;
    config?: ArbiterConfig;
  } = {}
): Promise<{ extracted: boolean; path?: string; reasoning: string }> {
  // Load existing memories for context
  const existingMemories = await loadMemoryFrontmatter();

  // Run extraction
  const extractionInput: MemoryExtractionInput = {
    ...input,
    existingMemories,
  };

  const result = await extractMemory(extractionInput, options);

  // Save if should create
  if (result.shouldCreateMemory) {
    const path = await appendMemory(result);
    return {
      extracted: true,
      path: path ?? undefined,
      reasoning: result.reasoning,
    };
  }

  return {
    extracted: false,
    reasoning: result.reasoning,
  };
}

/**
 * Truncate text for prompt inclusion.
 */
function truncateForPrompt(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "... [truncated]";
}
