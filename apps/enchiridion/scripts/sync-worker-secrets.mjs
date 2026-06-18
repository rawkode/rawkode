import { spawn } from "node:child_process";
import { buildWorkerSecretPayload } from "./worker-secrets.mjs";

let secrets;
try {
	secrets = buildWorkerSecretPayload(process.env);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}

const wrangler = spawn("wrangler", ["secret", "bulk", "--config", "wrangler.jsonc"], {
	stdio: ["pipe", "inherit", "inherit"],
});

wrangler.stdin.end(JSON.stringify(secrets));

wrangler.on("error", (error) => {
	console.error(error);
	process.exit(1);
});

wrangler.on("exit", (code) => {
	process.exit(code ?? 1);
});
