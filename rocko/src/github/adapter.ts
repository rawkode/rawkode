import type { Adapter, AdapterConfig, AdapterContext, Task, TaskUpdate, AdapterHooks } from "../adapter/types.ts";
import type { GitHubAdapterConfig, GitHubConfig } from "../config/schema.ts";
import type { Phase } from "../machine/types.ts";
import { GitHubClient, type GitHubIssue } from "./client.ts";

class GitHubAdapter implements Adapter {
  name = "github-issues";
  private config!: GitHubAdapterConfig;
  private githubConfig!: GitHubConfig;
  private client!: GitHubClient;
  private issueMap = new Map<string, GitHubIssue>();
  hooks: AdapterHooks;

  constructor() {
    this.hooks = {
      onTaskSelected: async (task: Task) => {
        const issue = this.issueMap.get(task.id);
        if (!issue) return;

        if (this.githubConfig.updateLabels) {
          await this.client.addLabels(issue.number, [this.githubConfig.inProgressLabel]);
        }

        if (this.githubConfig.addComments) {
          await this.client.addComment(
            issue.number,
            `🤖 **Rocko** is now working on this issue.\n\n` +
            `Starting automated implementation...`
          );
        }
      },

      onPhaseTransition: async (from: Phase, to: Phase, reason: string) => {
        const currentIssue = Array.from(this.issueMap.values())[0];
        if (!currentIssue || !this.githubConfig.addComments) return;

        const phaseEmojis: Record<Phase, string> = {
          plan: "📋",
          build: "🔨",
          review: "🔍",
          commit: "💾",
          end: "✅",
        };

        await this.client.addComment(
          currentIssue.number,
          `${phaseEmojis[to]} Transitioning from **${from}** to **${to}**\n\n${reason}`
        );
      },

      onTaskComplete: async (task: Task, summary: string) => {
        const issue = this.issueMap.get(task.id);
        if (!issue) return;

        if (this.githubConfig.updateLabels) {
          await this.client.removeLabel(issue.number, this.githubConfig.inProgressLabel);
          await this.client.addLabels(issue.number, [this.githubConfig.completedLabel]);
        }

        if (this.githubConfig.addComments) {
          await this.client.addComment(
            issue.number,
            `✅ **Rocko** has completed this issue!\n\n**Summary:**\n${summary}`
          );
        }

        if (this.githubConfig.closeOnComplete) {
          await this.client.closeIssue(issue.number);
        }
      },
    };
  }

  async initialize(config: AdapterConfig): Promise<void> {
    this.config = config as GitHubAdapterConfig;
    this.githubConfig = {
      addComments: true,
      updateLabels: true,
      closeOnComplete: true,
      inProgressLabel: "in-progress",
      completedLabel: "completed",
    };

    this.client = new GitHubClient({
      owner: this.config.owner,
      repo: this.config.repo,
    });
  }

  setGitHubConfig(config: GitHubConfig): void {
    this.githubConfig = config;
  }

  async getContext(): Promise<AdapterContext> {
    const issues = await this.client.listIssues({
      labels: this.config.labels,
      state: "open",
      sort: "created",
      direction: "asc",
    });

    const filteredIssues = this.config.excludeLabels
      ? issues.filter(
          (issue) =>
            !issue.labels.some((label) =>
              this.config.excludeLabels!.includes(label.name)
            )
        )
      : issues;

    this.issueMap.clear();
    const tasks: Task[] = filteredIssues.map((issue) => {
      const taskId = `github-${issue.number}`;
      this.issueMap.set(taskId, issue);

      return {
        id: taskId,
        title: issue.title,
        description: issue.body ?? "",
        source: `github:${this.config.owner}/${this.config.repo}#${issue.number}`,
        labels: issue.labels.map((l) => l.name),
        metadata: {
          number: issue.number,
          url: issue.html_url,
          author: issue.user?.login,
          createdAt: issue.created_at,
        },
      };
    });

    return {
      tasks,
      additionalContext: `Issues from ${this.config.owner}/${this.config.repo} with labels: ${this.config.labels.join(", ")}`,
      metadata: {
        owner: this.config.owner,
        repo: this.config.repo,
        totalIssues: tasks.length,
      },
    };
  }

  async updateTask(taskId: string, update: TaskUpdate): Promise<void> {
    const issue = this.issueMap.get(taskId);
    if (!issue) return;

    if (update.status === "in_progress" && this.githubConfig.updateLabels) {
      await this.client.addLabels(issue.number, [this.githubConfig.inProgressLabel]);
    }

    if (update.labels && this.githubConfig.updateLabels) {
      await this.client.updateIssue(issue.number, { labels: update.labels });
    }

    if (update.comment && this.githubConfig.addComments) {
      await this.client.addComment(issue.number, update.comment);
    }
  }

  async completeTask(taskId: string): Promise<void> {
    const issue = this.issueMap.get(taskId);
    if (!issue) return;

    if (this.githubConfig.updateLabels) {
      await this.client.removeLabel(issue.number, this.githubConfig.inProgressLabel);
      await this.client.addLabels(issue.number, [this.githubConfig.completedLabel]);
    }

    if (this.githubConfig.closeOnComplete) {
      await this.client.closeIssue(issue.number);
    }
  }
}

export async function createGitHubAdapter(_config: AdapterConfig): Promise<Adapter> {
  return new GitHubAdapter();
}
