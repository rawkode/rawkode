import { join } from "path";
import type { Adapter, AdapterConfig, AdapterContext, Task, TaskUpdate } from "../adapter/types.ts";
import type { MarkdownAdapterConfig } from "../config/schema.ts";

interface MarkdownTask {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  priority?: "low" | "medium" | "high" | "critical";
  labels?: string[];
}

function parseMarkdownTasks(content: string): MarkdownTask[] {
  const tasks: MarkdownTask[] = [];
  const lines = content.split("\n");
  let currentTask: Partial<MarkdownTask> | null = null;
  let descriptionLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const taskMatch = line.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
    if (taskMatch) {
      if (currentTask && currentTask.title) {
        tasks.push({
          id: `task-${tasks.length + 1}`,
          title: currentTask.title,
          description: descriptionLines.join("\n").trim(),
          completed: currentTask.completed ?? false,
          priority: currentTask.priority,
          labels: currentTask.labels,
        });
      }

      const completed = taskMatch[1]!.toLowerCase() === "x";
      const title = taskMatch[2]!.trim();

      const priorityMatch = title.match(/\[priority:\s*(low|medium|high|critical)\]/i);
      const labelsMatch = title.match(/\[labels:\s*([^\]]+)\]/i);

      currentTask = {
        title: title
          .replace(/\[priority:\s*[^\]]+\]/gi, "")
          .replace(/\[labels:\s*[^\]]+\]/gi, "")
          .trim(),
        completed,
        priority: priorityMatch ? (priorityMatch[1]!.toLowerCase() as MarkdownTask["priority"]) : undefined,
        labels: labelsMatch ? labelsMatch[1]!.split(",").map((l) => l.trim()) : undefined,
      };
      descriptionLines = [];
    } else if (currentTask && line.startsWith("  ")) {
      descriptionLines.push(line.slice(2));
    }
  }

  if (currentTask && currentTask.title) {
    tasks.push({
      id: `task-${tasks.length + 1}`,
      title: currentTask.title,
      description: descriptionLines.join("\n").trim(),
      completed: currentTask.completed ?? false,
      priority: currentTask.priority,
      labels: currentTask.labels,
    });
  }

  return tasks;
}

function tasksToMarkdown(tasks: MarkdownTask[]): string {
  return tasks
    .map((task) => {
      const checkbox = task.completed ? "[x]" : "[ ]";
      let line = `- ${checkbox} ${task.title}`;

      if (task.priority) {
        line += ` [priority: ${task.priority}]`;
      }
      if (task.labels && task.labels.length > 0) {
        line += ` [labels: ${task.labels.join(", ")}]`;
      }

      if (task.description) {
        const descLines = task.description
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n");
        line += `\n${descLines}`;
      }

      return line;
    })
    .join("\n\n");
}

class MarkdownAdapter implements Adapter {
  name = "markdown";
  private config!: MarkdownAdapterConfig;
  private filePath!: string;
  private tasks: MarkdownTask[] = [];

  async initialize(config: AdapterConfig): Promise<void> {
    this.config = config as MarkdownAdapterConfig;
    this.filePath = join(process.cwd(), this.config.path);
  }

  async getContext(): Promise<AdapterContext> {
    const file = Bun.file(this.filePath);

    if (!(await file.exists())) {
      return { tasks: [] };
    }

    const content = await file.text();
    this.tasks = parseMarkdownTasks(content);

    const openTasks = this.tasks.filter((t) => !t.completed);

    return {
      tasks: openTasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        source: `markdown:${this.config.path}`,
        priority: t.priority,
        labels: t.labels,
      })),
      additionalContext: `Tasks loaded from ${this.config.path}`,
    };
  }

  async updateTask(taskId: string, update: TaskUpdate): Promise<void> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return;

    if (update.status === "completed") {
      task.completed = true;
    }
    if (update.labels) {
      task.labels = update.labels;
    }

    const markdown = tasksToMarkdown(this.tasks);
    await Bun.write(this.filePath, markdown);
  }

  async completeTask(taskId: string): Promise<void> {
    await this.updateTask(taskId, { status: "completed" });
  }
}

export async function createMarkdownAdapter(_config: AdapterConfig): Promise<Adapter> {
  return new MarkdownAdapter();
}
