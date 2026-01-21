export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: { name: string }[];
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
}

export interface GitHubClientConfig {
  owner: string;
  repo: string;
  token?: string;
}

export class GitHubClient {
  private baseUrl = "https://api.github.com";
  private owner: string;
  private repo: string;
  private token: string;

  constructor(config: GitHubClientConfig) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.token = config.token ?? process.env.GITHUB_TOKEN ?? "";

    if (!this.token) {
      throw new Error("GitHub token is required. Set GITHUB_TOKEN environment variable.");
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async listIssues(options: {
    labels?: string[];
    state?: "open" | "closed" | "all";
    sort?: "created" | "updated" | "comments";
    direction?: "asc" | "desc";
    per_page?: number;
  } = {}): Promise<GitHubIssue[]> {
    const params = new URLSearchParams();
    if (options.labels?.length) {
      params.set("labels", options.labels.join(","));
    }
    if (options.state) {
      params.set("state", options.state);
    }
    if (options.sort) {
      params.set("sort", options.sort);
    }
    if (options.direction) {
      params.set("direction", options.direction);
    }
    if (options.per_page) {
      params.set("per_page", options.per_page.toString());
    }

    const query = params.toString();
    const path = `/repos/${this.owner}/${this.repo}/issues${query ? `?${query}` : ""}`;
    return this.request<GitHubIssue[]>("GET", path);
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      "GET",
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}`
    );
  }

  async addComment(issueNumber: number, body: string): Promise<GitHubComment> {
    return this.request<GitHubComment>(
      "POST",
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`,
      { body }
    );
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.request(
      "POST",
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels`,
      { labels }
    );
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`
      );
    } catch {
      // Label might not exist, ignore
    }
  }

  async closeIssue(issueNumber: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      "PATCH",
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
      { state: "closed" }
    );
  }

  async updateIssue(
    issueNumber: number,
    update: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] }
  ): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      "PATCH",
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
      update
    );
  }
}
