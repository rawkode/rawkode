import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const testFiles = (root) =>
	readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`)
		.sort();

const files = [
	...testFiles("test"),
	...testFiles("website/test"),
	"api/src/schema.test.ts",
	"core/documents/src/storage.test.ts",
];
const args = [
	"test",
	"--allow-env",
	"--allow-read",
	"--allow-net=127.0.0.1,localhost",
];

files.forEach((file) => {
	const result = spawnSync("deno", [...args, file], { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
});
