import { describe, expect, it } from "vitest";
import { admitMiniAppBuild } from "../src/lib/mini-app-builds";
import type { Env } from "../src/lib/types";

describe("mini app build admission", () => {
	it("creates a build and dispatches the durable mini-app builder", async () => {
		const { env, rows, audits } = miniAppBuildEnv();
		const dispatches: unknown[] = [];

		const build = await admitMiniAppBuild(env, {
			prompt: "rss reader with scheduled updates",
			operation: "create",
			slugHint: "rss-reader",
			autonomousDeploy: true,
		}, {
			dispatchBuild: async (request) => {
				dispatches.push(request);
				return {
					dispatchId: "dispatch_1",
					acceptedAt: "2026-06-18T12:00:00.000Z",
				};
			},
		});

		expect(build).toMatchObject({
			prompt: "rss reader with scheduled updates",
			status: "running",
			attemptCount: 1,
			currentRunId: "dispatch_1",
			slugHint: "rss-reader",
		});
		expect(dispatches).toEqual([{
			agent: "mini-app-builder",
			id: build.id,
			input: {
				buildId: build.id,
				prompt: "rss reader with scheduled updates",
				operation: "create",
				slugHint: "rss-reader",
				autonomousDeploy: true,
				buildAttempt: 1,
				buildDeadlineAt: build.deadlineAt,
			},
		}]);
		expect(audits.map((audit) => audit.status)).toEqual(["build_queued", "build_dispatched"]);
		expect(rows.get(build.id)?.current_run_id).toBe("dispatch_1");
	});
});

type MiniAppBuildRow = Record<string, unknown> & {
	id: string;
	current_run_id: string | null;
	status: string;
};

function miniAppBuildEnv(): {
	env: Env;
	rows: Map<string, MiniAppBuildRow>;
	audits: Array<{ status: string; details_json: string }>;
} {
	const rows = new Map<string, MiniAppBuildRow>();
	const audits: Array<{ status: string; details_json: string }> = [];
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
							const row: MiniAppBuildRow = {
								id: String(bindings[0]),
								prompt: bindings[1],
								operation: bindings[2],
								target_slug: bindings[3],
								slug_hint: bindings[4],
								autonomous_deploy: bindings[5],
								status: String(bindings[6]),
								attempt_count: bindings[7],
								max_attempts: bindings[8],
								current_run_id: bindings[9] as string | null,
								result_json: bindings[10],
								error_json: bindings[11],
								deadline_at: bindings[12],
								completed_at: bindings[13],
								created_at: bindings[14],
								updated_at: bindings[15],
							};
							rows.set(row.id, row);
						}
						if (sql.includes("INSERT INTO mini_app_audit")) {
							audits.push({
								status: String(bindings[3]),
								details_json: String(bindings[4]),
							});
						}
						if (sql.includes("UPDATE mini_app_builds") && sql.includes("current_run_id")) {
							const id = String(bindings[3]);
							const row = rows.get(id);
							if (row) {
								row.status = "running";
								row.current_run_id = String(bindings[0]);
								row.attempt_count = bindings[1];
								row.error_json = null;
								row.updated_at = bindings[2];
							}
						}
						if (sql.includes("UPDATE mini_app_builds") && sql.includes("status = ?")) {
							const id = String(bindings[5]);
							const row = rows.get(id);
							if (row) {
								row.status = String(bindings[0]);
								row.result_json = bindings[1];
								row.error_json = bindings[2];
								row.completed_at = bindings[3];
								row.updated_at = bindings[4];
							}
						}
						return {};
					},
					async first() {
						if (sql.includes("SELECT * FROM mini_app_builds WHERE id = ?")) {
							return rows.get(String(bindings[0])) ?? null;
						}
						return null;
					},
				};
				return statement;
			},
		},
	} as unknown as Env;

	return { env, rows, audits };
}
