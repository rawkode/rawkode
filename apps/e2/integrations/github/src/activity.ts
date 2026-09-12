import type { GitHubRecord } from "@e2/oauth-client/github";

const object = (value: unknown): GitHubRecord =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? value as GitHubRecord
		: {};
const text = (value: unknown): string =>
	typeof value === "string" ? value.trim() : "";
const number = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: null;
const excerpt = (value: unknown): string =>
	text(value).replace(/\s+/g, " ").slice(0, 500);

export const normalizeGitHubActivity = (row: GitHubRecord) => {
	const payload = object(row.payload);
	const eventType = text(row.type);
	const issue = object(payload.issue);
	const pr = object(payload.pull_request);
	const discussion = object(payload.discussion);
	const comment = object(payload.comment);
	const review = object(payload.review);
	const kind = Object.keys(pr).length || issue.pull_request ||
			eventType.includes("PullRequest")
		? "pullRequest"
		: Object.keys(discussion).length || eventType.includes("Discussion")
		? "discussion"
		: Object.keys(issue).length || eventType.includes("Issue")
		? "issue"
		: eventType === "PushEvent" || eventType === "CommitCommentEvent"
		? "commit"
		: null;
	if (!kind) return null;
	const resource = kind === "pullRequest"
		? (Object.keys(pr).length ? pr : issue)
		: kind === "discussion"
		? discussion
		: issue;
	const repository = text(object(row.repo).name);
	const repositoryURL = /^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository)
		? `https://github.com/${repository}`
		: "";
	const resourceNumber = number(resource.number) ?? number(payload.number);
	const resourcePath = kind === "pullRequest"
		? "pull"
		: kind === "discussion"
		? "discussions"
		: "issues";
	const resourceURL = text(resource.html_url) ||
		(repositoryURL && resourceNumber
			? `${repositoryURL}/${resourcePath}/${resourceNumber}`
			: "");
	const commits = Array.isArray(payload.commits)
		? payload.commits.map(object)
		: [];
	const head = text(payload.head) || text(comment.commit_id) ||
		text(commits.at(-1)?.sha);
	const branch = text(payload.ref).replace(/^refs\/heads\//, "");
	const action = eventType.includes("Comment")
		? "commented"
		: eventType === "PullRequestReviewEvent"
		? (text(review.state) || "reviewed")
		: kind === "pullRequest" && payload.action === "closed" &&
				resource.merged === true
		? "merged"
		: kind === "commit"
		? "pushed"
		: text(payload.action) || "updated";
	const label = kind === "pullRequest"
		? "Pull request"
		: kind === "discussion"
		? "Discussion"
		: "Issue";
	const commitTitle = text(commits.at(-1)?.message).split("\n")[0];
	const title = kind === "commit"
		? commitTitle ||
			(branch
				? `Pushed to ${branch}`
				: `Commit ${head.slice(0, 7) || "activity"}`)
		: text(resource.title) ||
			`${label}${resourceNumber ? ` #${resourceNumber}` : ""}`;
	const summary = excerpt(comment.body) || excerpt(review.body) ||
		(kind === "commit"
			? commits.map((commit) => text(commit.message).split("\n")[0]).filter(
				Boolean,
			).join(" · ").slice(0, 500)
			: excerpt(resource.body));
	return {
		id: String(row.id ?? ""),
		resourceId: String(
			resource.node_id ?? resource.id ?? resourceNumber ??
				(head || row.id || ""),
		),
		kind,
		title,
		summary,
		number: resourceNumber,
		eventType,
		url: text(comment.html_url) || text(review.html_url) || resourceURL ||
			(repositoryURL && /^[a-f0-9]{7,40}$/i.test(head)
				? `${repositoryURL}/commit/${head}`
				: repositoryURL),
		repository,
		actor: text(object(row.actor).login),
		createdAt: text(row.created_at),
		action,
	};
};

/** Events can contain only a resource number. Hydrate a small, deduplicated set
 * of missing titles; failures preserve the event and its direct resource link. */
export const createActivityEnricher = (
	fetchResource: (path: string) => Promise<unknown>,
	limit = 8,
) => {
	const requests = new Map<string, Promise<GitHubRecord>>();
	return async (rows: GitHubRecord[]): Promise<GitHubRecord[]> => {
		const enrichRow = async (row: GitHubRecord): Promise<GitHubRecord> => {
			const payload = object(row.payload);
			const type = text(row.type);
			const key = type.includes("PullRequest")
				? "pull_request"
				: type.includes("Issue")
				? "issue"
				: null;
			const resource = object(key ? payload[key] : null);
			const resourceNumber = number(resource.number) ?? number(payload.number);
			const repository = text(object(row.repo).name);
			if (
				!key || text(resource.title) || !resourceNumber ||
				!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository)
			) {
				return row;
			}
			const path = `/repos/${repository}/${
				key === "pull_request" ? "pulls" : "issues"
			}/${resourceNumber}`;
			if (!requests.has(path) && requests.size < limit) {
				requests.set(path, fetchResource(path).then(object).catch(() => ({})));
			}
			const detail = await requests.get(path);
			return detail
				? {
					...row,
					payload: {
						...payload,
						[key]: {
							...detail,
							...resource,
							title: text(resource.title) || text(detail.title),
						},
					},
				}
				: row;
		};
		const result: GitHubRecord[] = [];
		for (let index = 0; index < rows.length; index += 2) {
			result.push(
				...await Promise.all(rows.slice(index, index + 2).map(enrichRow)),
			);
		}
		return result;
	};
};
