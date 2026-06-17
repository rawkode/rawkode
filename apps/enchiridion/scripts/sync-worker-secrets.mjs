import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
const appPassword = process.env.ENCHIRIDION_PASSWORD;
const hostSigningSeed = process.env.HOST_SIGNING_SECRET ?? appPassword;
const missing = [];

if (!cloudflareToken) {
	missing.push("CLOUDFLARE_API_TOKEN");
}
if (!appPassword) {
	missing.push("ENCHIRIDION_PASSWORD");
}
if (!hostSigningSeed) {
	missing.push("HOST_SIGNING_SECRET");
}
if (missing.length > 0) {
	console.error(`${missing.join(", ")} required to sync Enchiridion Worker secrets.`);
	process.exit(1);
}

const hostSigningSecret = createHash("sha256")
	.update(`enchiridion-host-context-v1:${hostSigningSeed}`)
	.digest("hex");

const wrangler = spawn("wrangler", ["secret", "bulk", "--config", "wrangler.jsonc"], {
	stdio: ["pipe", "inherit", "inherit"],
});

wrangler.stdin.end(JSON.stringify({
	CLOUDFLARE_API_TOKEN: cloudflareToken,
	ENCHIRIDION_PASSWORD: appPassword,
	HOST_SIGNING_SECRET: hostSigningSecret,
}));

wrangler.on("error", (error) => {
	console.error(error);
	process.exit(1);
});

wrangler.on("exit", (code) => {
	process.exit(code ?? 1);
});
