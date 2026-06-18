import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);

export async function copyWorkerBuildAssets({
	sourceMigrationsDir = resolve(root, "migrations"),
	targetMigrationsDir = resolve(root, "dist/enchiridion/migrations"),
} = {}) {
	await rm(targetMigrationsDir, { force: true, recursive: true });
	await mkdir(targetMigrationsDir, { recursive: true });
	await cp(sourceMigrationsDir, targetMigrationsDir, { force: true, recursive: true });
}

if (isMainModule()) {
	await copyWorkerBuildAssets();
	console.log("Copied migrations to dist/enchiridion/migrations");
}

function isMainModule() {
	return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}
