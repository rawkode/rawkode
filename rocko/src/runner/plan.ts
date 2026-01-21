import { queryRaw, extractJSON } from "../claude/index.ts";
import type { AdapterContext, Task } from "../adapter/types.ts";
import type { PlanOutput } from "../machine/types.ts";
import { PlanOutputSchema } from "../machine/schemas.ts";
import type { AIConfig } from "../config/schema.ts";

const PLAN_SYSTEM_PROMPT = `You are Rocko, an autonomous coding agent. Your job is to:
1. Analyze the available tasks and select the most appropriate one to work on
2. Create a detailed implementation plan for the selected task

When selecting a task, consider:
- Task priority (critical > high > medium > low)
- Task complexity and dependencies
- How well-defined the task requirements are

Your response MUST include a JSON block with this exact structure:
\`\`\`json
{
  "task": {
    "id": "task-id",
    "title": "Task title",
    "description": "Task description",
    "source": "source-identifier"
  },
  "approach": "High-level description of how you'll implement this",
  "steps": [
    {
      "description": "Step description",
      "files": ["file1.ts", "file2.ts"]
    }
  ],
  "estimatedComplexity": "low" | "medium" | "high"
}
\`\`\`

Be thorough in your planning. Consider:
- What files need to be created or modified
- What dependencies or imports are needed
- Edge cases and error handling
- Testing requirements`;

function buildPlanPrompt(context: AdapterContext): string {
  const taskList = context.tasks
    .map(
      (t, i) =>
        `${i + 1}. [${t.id}] ${t.title}${t.priority ? ` (Priority: ${t.priority})` : ""}
   Description: ${t.description || "No description provided"}
   Source: ${t.source}
   ${t.labels?.length ? `Labels: ${t.labels.join(", ")}` : ""}`
    )
    .join("\n\n");

  return `## Available Tasks

${taskList}

${context.additionalContext ? `\n## Additional Context\n${context.additionalContext}` : ""}

Please analyze these tasks and select the most appropriate one to work on. Then create a detailed implementation plan.

Remember to output your plan as a JSON block with the exact structure specified in your instructions.`;
}

export async function runPlanPhase(
  context: AdapterContext,
  aiConfig: AIConfig,
  verbose = false
): Promise<{ type: "plan"; plan: PlanOutput } | { type: "nothing_to_do" }> {
  if (context.tasks.length === 0) {
    return { type: "nothing_to_do" };
  }

  const prompt = buildPlanPrompt(context);

  const response = await queryRaw({
    prompt,
    systemPrompt: PLAN_SYSTEM_PROMPT,
    model: aiConfig.model,
    maxTurns: 5,
    onMessage: (msg) => {
      if (verbose && msg.type === "assistant") {
        console.log("[PLAN] Claude response received");
      }
    },
  });

  const rawPlan = extractJSON<unknown>(response.content);

  if (!rawPlan) {
    throw new Error("Failed to extract plan from Claude response");
  }

  const plan = PlanOutputSchema.parse(rawPlan);

  const matchingTask = context.tasks.find((t) => t.id === plan.task.id);
  if (matchingTask) {
    plan.task = {
      ...plan.task,
      ...matchingTask,
    };
  }

  return { type: "plan", plan };
}

export function selectTaskForPlan(tasks: Task[]): Task | null {
  if (tasks.length === 0) return null;

  const priorityOrder: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  const sorted = [...tasks].sort((a, b) => {
    const aPriority = a.priority ? priorityOrder[a.priority] ?? 0 : 0;
    const bPriority = b.priority ? priorityOrder[b.priority] ?? 0 : 0;
    return bPriority - aPriority;
  });

  return sorted[0] ?? null;
}
