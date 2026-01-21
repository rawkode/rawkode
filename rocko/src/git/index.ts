export interface GitStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  hasChanges: boolean;
}

export interface GitCommitResult {
  hash: string;
  message: string;
}

export interface GitDiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

export async function getGitRoot(): Promise<string> {
  const result = await Bun.$`git rev-parse --show-toplevel`.quiet();
  if (result.exitCode !== 0) {
    throw new Error("Not a git repository");
  }
  return result.text().trim();
}

export async function isGitRepo(): Promise<boolean> {
  const result = await Bun.$`git rev-parse --is-inside-work-tree`.quiet();
  return result.exitCode === 0;
}

export async function getCurrentBranch(): Promise<string> {
  const result = await Bun.$`git branch --show-current`.quiet();
  if (result.exitCode !== 0) {
    throw new Error("Failed to get current branch");
  }
  return result.text().trim();
}

export async function getStatus(): Promise<GitStatus> {
  const result = await Bun.$`git status --porcelain`.quiet();
  if (result.exitCode !== 0) {
    throw new Error("Failed to get git status");
  }

  const lines = result.text().trim().split("\n").filter(Boolean);

  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    const filePath = line.slice(3);

    if (indexStatus === "?" && worktreeStatus === "?") {
      untracked.push(filePath);
    } else if (indexStatus !== " " && indexStatus !== "?") {
      staged.push(filePath);
    } else if (worktreeStatus !== " " && worktreeStatus !== "?") {
      unstaged.push(filePath);
    }
  }

  return {
    staged,
    unstaged,
    untracked,
    hasChanges: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
  };
}

export async function getDiff(staged = false): Promise<string> {
  const args = staged ? ["--staged"] : [];
  const result = await Bun.$`git diff ${args}`.quiet();
  return result.text();
}

export async function getDiffFiles(staged = false): Promise<GitDiffFile[]> {
  const args = staged
    ? ["--staged", "--numstat"]
    : ["--numstat"];

  const result = await Bun.$`git diff ${args}`.quiet();
  const lines = result.text().trim().split("\n").filter(Boolean);

  return lines.map((line) => {
    const [additions, deletions, path] = line.split("\t");
    return {
      path: path!,
      additions: additions === "-" ? 0 : parseInt(additions!, 10),
      deletions: deletions === "-" ? 0 : parseInt(deletions!, 10),
      status: "modified" as const,
    };
  });
}

export async function stageAll(): Promise<void> {
  const result = await Bun.$`git add -A`.quiet();
  if (result.exitCode !== 0) {
    throw new Error("Failed to stage changes");
  }
}

export async function stageFiles(files: string[]): Promise<void> {
  if (files.length === 0) return;
  const result = await Bun.$`git add ${files}`.quiet();
  if (result.exitCode !== 0) {
    throw new Error("Failed to stage files");
  }
}

export async function commit(message: string): Promise<GitCommitResult> {
  const result = await Bun.$`git commit -m ${message}`.quiet();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to commit: ${result.stderr}`);
  }

  const hashResult = await Bun.$`git rev-parse HEAD`.quiet();
  const hash = hashResult.text().trim();

  return { hash, message };
}

export async function getRecentCommits(count = 5): Promise<Array<{ hash: string; message: string }>> {
  const result = await Bun.$`git log --oneline -n ${count}`.quiet();
  if (result.exitCode !== 0) {
    return [];
  }

  const lines = result.text().trim().split("\n").filter(Boolean);
  return lines.map((line) => {
    const [hash, ...messageParts] = line.split(" ");
    return {
      hash: hash!,
      message: messageParts.join(" "),
    };
  });
}

export async function getChangedFilesSinceCommit(commitHash: string): Promise<string[]> {
  const result = await Bun.$`git diff --name-only ${commitHash} HEAD`.quiet();
  if (result.exitCode !== 0) {
    return [];
  }
  return result.text().trim().split("\n").filter(Boolean);
}

export function formatConventionalCommit(
  type: string,
  scope: string | undefined,
  description: string,
  body?: string,
  breaking?: boolean
): string {
  let message = type;
  if (scope) {
    message += `(${scope})`;
  }
  if (breaking) {
    message += "!";
  }
  message += `: ${description}`;

  if (body) {
    message += `\n\n${body}`;
  }

  return message;
}
