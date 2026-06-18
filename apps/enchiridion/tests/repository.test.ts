import { describe, expect, it } from "vitest";
import {
	createExtensionBindingRequest,
	createMiniAppBuild,
	listExtensionBindingRequests,
	listRecoverableMiniAppBuilds,
	saveExtension,
	scheduledWorkflowsForExtension,
	searchReferenceTargets,
	setScheduledWorkflowEnabled,
} from "../src/lib/repository";
import type { Env, ExtensionManifest } from "../src/lib/types";

const scheduledManifest: ExtensionManifest = {
	slug: "rss-reader",
	name: "RSS Reader",
	version: "0.1.0",
	description: "Read RSS feeds.",
	status: "dynamic",
	routes: [
		{ path: "/apps/rss-reader", mode: "worker-page", label: "RSS Reader" },
		{ path: "/apps/rss-reader/_workflows/refresh-feeds", mode: "worker-fragment", label: "Refresh feeds" },
	],
	commands: [],
	editorBlocks: [],
	workflows: [
		{
			id: "refresh-feeds",
			label: "Refresh feeds",
			trigger: "scheduled",
			workflowName: "run-mini-app-workflow",
			cron: "*/15 * * * *",
			inputSchema: { type: "object" },
			requiredHostApis: ["resource-index:write"],
		},
		{
			id: "manual-import",
			label: "Manual import",
			trigger: "manual",
			workflowName: "rss-import",
			requiredHostApis: [],
		},
	],
	bindings: [],
	hostApis: ["resource-index:write"],
	indexProjections: [],
};

describe("extension repository scheduling", () => {
	it("projects scheduled manifest workflows into disabled host workflow records", () => {
		expect(scheduledWorkflowsForExtension(scheduledManifest, "2026-06-18T12:00:00.000Z")).toEqual([
			{
				id: "rss-reader:refresh-feeds",
				extensionSlug: "rss-reader",
				name: "RSS Reader: Refresh feeds",
				cron: "*/15 * * * *",
				workflowName: "run-mini-app-workflow",
				payload: {
					app: "rss-reader",
					callbackPath: "/apps/rss-reader/_workflows/refresh-feeds",
					extensionSlug: "rss-reader",
					inputSchema: { type: "object" },
					manifestVersion: "0.1.0",
					requiredHostApis: ["resource-index:write"],
					workflowId: "refresh-feeds",
					workflowName: "run-mini-app-workflow",
				},
				enabled: false,
				lastRunAt: null,
				createdAt: "2026-06-18T12:00:00.000Z",
				updatedAt: "2026-06-18T12:00:00.000Z",
			},
		]);
	});

	it("aggregates reference targets from indexed resources and enabled app routes", async () => {
		const env = referenceSearchEnv({
			resources: [
				resourceRow({
					id: "note:daily-1",
					source_app: "notes",
					source_type: "daily-note",
					source_id: "daily-1",
					title: "Kubernetes review",
					summary: "Daily note text.",
					url: "/daily/2026-06-18",
				}),
				resourceRow({
					id: "bookmark:bookmark-1",
					source_app: "bookmarks",
					source_type: "bookmark",
					source_id: "bookmark-1",
					title: "Topology bookmark",
					summary: "Reference material.",
					url: "https://example.com/topology",
				}),
			],
			extensions: [
				referenceExtension("kube-tools", "Kubernetes tools", "/apps/kube-tools"),
				{ ...referenceExtension("disabled-tools", "Disabled tools", "/apps/disabled-tools"), status: "disabled" },
			],
		});

		const results = await searchReferenceTargets(env, "kube", 10);

		expect(results).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: "app-route:/apps/kube-tools",
				label: "Kubernetes tools",
				referenceKind: "app-route",
				href: "/apps/kube-tools",
			}),
			expect.objectContaining({
				id: "note:daily-1",
				label: "Kubernetes review",
				referenceKind: "daily-note",
				href: "/daily/2026-06-18",
			}),
		]));
		expect(results.some((entry) => entry.id === "app-route:/apps/disabled-tools")).toBe(false);
	});

	it("ranks exact and prefix reference matches before stale route defaults", async () => {
		const env = referenceSearchEnv({
			resources: [
				resourceRow({
					id: "project:project-1",
					source_app: "projects",
					source_type: "project",
					source_id: "project-1",
					title: "Atlas",
					summary: "Exact project.",
					url: "/apps/projects",
					updated_at: "2026-06-18T12:00:00.000Z",
				}),
				resourceRow({
					id: "project:project-2",
					source_app: "projects",
					source_type: "project",
					source_id: "project-2",
					title: "Atlas follow-up",
					summary: "Prefix project.",
					url: "/apps/projects",
					updated_at: "2026-06-18T13:00:00.000Z",
				}),
			],
			extensions: [referenceExtension("atlas", "Atlas app", "/apps/atlas")],
		});

		const results = await searchReferenceTargets(env, "atlas", 10);

		expect(results.map((entry) => entry.id).slice(0, 3)).toEqual([
			"project:project-1",
			"project:project-2",
			"app-route:/apps/atlas",
		]);
	});

	it("persists and lists extension binding requests", async () => {
		const rows: unknown[] = [];
		const calls: Array<{ sql: string; bindings: unknown[]; method: "all" | "run" }> = [];
		const env = {
			DB: {
				prepare(sql: string) {
					let bindings: unknown[] = [];
					const statement = {
						bind(...values: unknown[]) {
							bindings = values;
							return statement;
						},
						async run() {
							calls.push({ sql, bindings, method: "run" });
							if (sql.includes("INSERT INTO extension_binding_requests")) {
								rows.push({
									id: bindings[0],
									extension_slug: bindings[1],
									extension_name: bindings[2],
									operation: bindings[3],
									manifest_json: bindings[4],
									worker_source: bindings[5],
									deployment_notes: bindings[6],
									bindings_json: bindings[7],
									issues_json: bindings[8],
									status: bindings[9],
									created_at: bindings[10],
									updated_at: bindings[11],
								});
							}
							return {};
						},
						async all() {
							calls.push({ sql, bindings, method: "all" });
							return { results: rows };
						},
					};
					return statement;
				},
			},
		} as unknown as Env;
		const manifest: ExtensionManifest = {
			...scheduledManifest,
			bindings: [{ type: "d1_database", name: "RSS_DB", purpose: "Store feed subscriptions and entries." }],
		};

		const request = await createExtensionBindingRequest(env, {
			operation: "create",
			manifest,
			workerSource: "export default { fetch(request, env) { return env.RSS_DB.prepare('SELECT 1').first() } }",
			deploymentNotes: "Needs D1.",
			issues: ["bindings: autonomous deploy requires isolated binding provisioning first (RSS_DB:d1_database)"],
		});
		const listed = await listExtensionBindingRequests(env, { status: "pending" });

		expect(request).toMatchObject({
			extensionSlug: "rss-reader",
			operation: "create",
			status: "pending",
			bindings: [{ type: "d1_database", name: "RSS_DB", purpose: "Store feed subscriptions and entries." }],
		});
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			id: request.id,
			extensionSlug: "rss-reader",
			deploymentNotes: "Needs D1.",
			issues: ["bindings: autonomous deploy requires isolated binding provisioning first (RSS_DB:d1_database)"],
		});
		expect(calls.some((call) => call.method === "all" && call.bindings[0] === "pending")).toBe(true);
	});

	it("syncs extension scheduled workflows when saving a manifest", async () => {
		const calls: Array<{ sql: string; bindings: unknown[]; method: "all" | "run" }> = [];
		const env = {
			DB: {
				prepare(sql: string) {
					return {
						bind(...bindings: unknown[]) {
							return {
								all: async () => {
									calls.push({ sql, bindings, method: "all" });
									return { results: [{ id: "rss-reader:stale" }] };
								},
								run: async () => {
									calls.push({ sql, bindings, method: "run" });
									return {};
								},
							};
						},
					};
				},
			},
		} as unknown as Env;

		await saveExtension(env, scheduledManifest, "enchiridion-rss-reader", "dynamic");

		expect(calls.some((call) => call.method === "run" && call.sql.includes("INSERT INTO extension_manifests"))).toBe(true);
		expect(calls).toContainEqual(expect.objectContaining({
			method: "all",
			bindings: ["rss-reader"],
			sql: "SELECT id FROM scheduled_workflows WHERE extension_slug = ?",
		}));
		expect(calls).toContainEqual(expect.objectContaining({
			method: "run",
			bindings: ["rss-reader", "rss-reader:stale"],
			sql: "DELETE FROM scheduled_workflows WHERE extension_slug = ? AND id = ?",
		}));
		expect(calls.some((call) =>
			call.method === "run"
			&& call.sql.includes("INSERT INTO scheduled_workflows")
			&& call.bindings[0] === "rss-reader:refresh-feeds"
			&& call.bindings[1] === "rss-reader"
			&& call.bindings[6] === 0
		)).toBe(true);
	});

	it("updates scheduled workflow enabled state", async () => {
		const calls: Array<{ sql: string; bindings: unknown[]; method: "first" | "run" }> = [];
		let enabled = 0;
		const env = {
			DB: {
				prepare(sql: string) {
					let bindings: unknown[] = [];
					const statement = {
						bind(...values: unknown[]) {
							bindings = values;
							return statement;
						},
						async run() {
							calls.push({ sql, bindings, method: "run" });
							if (sql.includes("UPDATE scheduled_workflows")) {
								enabled = Number(bindings[0]);
							}
							return {};
						},
						async first() {
							calls.push({ sql, bindings, method: "first" });
							return {
								id: "rss-reader:refresh-feeds",
								extension_slug: "rss-reader",
								name: "RSS Reader: Refresh feeds",
								cron: "*/15 * * * *",
								workflow_name: "run-mini-app-workflow",
								payload_json: "{}",
								enabled,
								last_run_at: null,
								created_at: "2026-06-18T12:00:00.000Z",
								updated_at: "2026-06-18T12:05:00.000Z",
							};
						},
					};
					return statement;
				},
			},
		} as unknown as Env;

		await expect(setScheduledWorkflowEnabled(env, "rss-reader:refresh-feeds", true)).resolves.toMatchObject({
			id: "rss-reader:refresh-feeds",
			enabled: true,
		});
		expect(calls[0]).toMatchObject({
			method: "run",
			bindings: [1, expect.any(String), "rss-reader:refresh-feeds"],
		});
		expect(calls[1]).toMatchObject({
			method: "first",
			bindings: ["rss-reader:refresh-feeds"],
		});
	});

	it("recovers pending and interrupted mini app builds before their deadline", async () => {
		const rows: unknown[] = [];
		let eventSequence = 0;
		const env = {
			DB: {
				prepare(sql: string) {
					let bindings: unknown[] = [];
					const statement = {
						bind(...values: unknown[]) {
							bindings = values;
							return statement;
						},
						async run() {
								if (sql.includes("INSERT INTO mini_app_builds")) {
									rows.push({
									id: bindings[0],
									prompt: bindings[1],
									operation: bindings[2],
									target_slug: bindings[3],
									slug_hint: bindings[4],
									autonomous_deploy: bindings[5],
									status: bindings[6],
									attempt_count: bindings[7],
									max_attempts: bindings[8],
									current_run_id: bindings[9],
									result_json: bindings[10],
									error_json: bindings[11],
									deadline_at: bindings[12],
									completed_at: bindings[13],
									created_at: bindings[14],
										updated_at: bindings[15],
									});
								}
								return {};
							},
							async first() {
								if (sql.includes("FROM mini_app_build_events")) {
									return { next_sequence: eventSequence++ };
								}
								return null;
							},
							async all() {
							const deadline = String(bindings[0]);
							return {
								results: rows.filter((row) => {
									const build = row as {
										attempt_count: number;
										deadline_at: string;
										max_attempts: number;
										status: string;
									};
									return (build.status === "pending" || build.status === "interrupted")
										&& build.attempt_count < build.max_attempts
										&& build.deadline_at > deadline;
								}),
							};
						},
					};
					return statement;
				},
			},
		} as unknown as Env;

		const now = "2026-06-18T12:00:00.000Z";
		await createMiniAppBuild(env, {
			prompt: "create rss reader",
			operation: "create",
			deadlineAt: "2026-06-18T12:30:00.000Z",
		});
		rows.push({
			id: "interrupted-build",
			prompt: "retry rss reader",
			operation: "create",
			target_slug: null,
			slug_hint: "rss-reader",
			autonomous_deploy: 1,
			status: "interrupted",
			attempt_count: 1,
			max_attempts: 3,
			current_run_id: "run_1",
			result_json: null,
			error_json: JSON.stringify({ message: "workflow execution was interrupted" }),
			deadline_at: "2026-06-18T12:30:00.000Z",
			completed_at: null,
			created_at: now,
			updated_at: now,
		}, {
			id: "running-build",
			prompt: "still running",
			operation: "create",
			target_slug: null,
			slug_hint: null,
			autonomous_deploy: 1,
			status: "running",
			attempt_count: 1,
			max_attempts: 3,
			current_run_id: "run_2",
			result_json: null,
			error_json: null,
			deadline_at: "2026-06-18T12:30:00.000Z",
			completed_at: null,
			created_at: now,
			updated_at: now,
		}, {
			id: "expired-build",
			prompt: "too late",
			operation: "create",
			target_slug: null,
			slug_hint: null,
			autonomous_deploy: 1,
			status: "pending",
			attempt_count: 0,
			max_attempts: 3,
			current_run_id: null,
			result_json: null,
			error_json: null,
			deadline_at: "2026-06-18T11:59:00.000Z",
			completed_at: null,
			created_at: now,
			updated_at: now,
		}, {
			id: "maxed-build",
			prompt: "too many tries",
			operation: "create",
			target_slug: null,
			slug_hint: null,
			autonomous_deploy: 1,
			status: "interrupted",
			attempt_count: 3,
			max_attempts: 3,
			current_run_id: "run_3",
			result_json: null,
			error_json: null,
			deadline_at: "2026-06-18T12:30:00.000Z",
			completed_at: null,
			created_at: now,
			updated_at: now,
		});

		const recoverable = await listRecoverableMiniAppBuilds(env, now);

		expect(recoverable.map((build) => build.id)).toEqual([
			expect.any(String),
			"interrupted-build",
		]);
		expect(recoverable[0]).toMatchObject({
			prompt: "create rss reader",
			status: "pending",
			deadlineAt: "2026-06-18T12:30:00.000Z",
		});
	});
});

function referenceSearchEnv(input: { resources: unknown[]; extensions: ExtensionManifest[] }): Env {
	return {
		DB: {
			prepare(sql: string) {
				let bindings: unknown[] = [];
				const statement = {
					bind(...values: unknown[]) {
						bindings = values;
						return statement;
					},
					async all() {
						if (sql.includes("FROM resource_index")) {
							const query = typeof bindings[0] === "string" ? bindings[0].replaceAll("%", "").toLowerCase() : "";
							return {
								results: input.resources.filter((row) => {
									const record = row as { title: string; summary: string; tags_json: string };
									return !query
										|| record.title.toLowerCase().includes(query)
										|| record.summary.toLowerCase().includes(query)
										|| record.tags_json.toLowerCase().includes(query);
								}),
							};
						}
						if (sql.includes("FROM extension_manifests")) {
							return {
								results: input.extensions.map((extension) => ({
									slug: extension.slug,
									manifest_json: JSON.stringify(extension),
									status: extension.status ?? "dynamic",
									deployed_script_name: null,
									created_at: "2026-06-18T00:00:00.000Z",
									updated_at: "2026-06-18T00:00:00.000Z",
								})),
							};
						}
						return { results: [] };
					},
				};
				return statement;
			},
		},
	} as unknown as Env;
}

function resourceRow(input: Partial<{
	id: string;
	source_app: string;
	source_type: string;
	source_id: string;
	title: string;
	summary: string;
	url: string | null;
	tags_json: string;
	relationships_json: string;
	occurred_at: string | null;
	created_at: string;
	updated_at: string;
}>): Record<string, unknown> {
	return {
		id: input.id ?? "resource:1",
		source_app: input.source_app ?? "notes",
		source_type: input.source_type ?? "daily-note",
		source_id: input.source_id ?? "1",
		title: input.title ?? "Resource",
		summary: input.summary ?? "",
		url: input.url ?? null,
		tags_json: input.tags_json ?? "[]",
		relationships_json: input.relationships_json ?? "[]",
		occurred_at: input.occurred_at ?? null,
		created_at: input.created_at ?? "2026-06-18T00:00:00.000Z",
		updated_at: input.updated_at ?? "2026-06-18T00:00:00.000Z",
	};
}

function referenceExtension(slug: string, label: string, path: string): ExtensionManifest {
	return {
		slug,
		name: label,
		version: "0.1.0",
		description: `${label} description.`,
		status: "dynamic",
		routes: [{ path, mode: "worker-page", label }],
		commands: [],
		editorBlocks: [],
		workflows: [],
		bindings: [],
		hostApis: [],
		indexProjections: [],
	};
}
