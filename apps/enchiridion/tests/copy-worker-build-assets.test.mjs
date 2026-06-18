import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { copyWorkerBuildAssets } from "../scripts/copy-worker-build-assets.mjs";

describe("copyWorkerBuildAssets", () => {
	it("copies migrations into the generated Worker directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "enchiridion-build-assets-"));
		const source = join(root, "migrations");
		const target = join(root, "dist", "enchiridion", "migrations");

		await mkdir(source, { recursive: true });
		await writeFile(join(source, "0001_initial.sql"), "select 1;");

		await copyWorkerBuildAssets({
			sourceMigrationsDir: source,
			targetMigrationsDir: target,
		});

		await expect(readFile(join(target, "0001_initial.sql"), "utf8")).resolves.toBe("select 1;");
	});
});
