import { spawn } from "node:child_process";

const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
const appPassword = process.env.ENCHIRIDION_PASSWORD;
const missing = [];

if (!cloudflareToken) {
	missing.push("CLOUDFLARE_API_TOKEN");
}
if (!appPassword) {
	missing.push("ENCHIRIDION_PASSWORD");
}
if (missing.length > 0) {
	console.error(`${missing.join(", ")} required to sync Enchiridion Worker secrets.`);
	process.exit(1);
}

const wrangler = spawn("wrangler", ["secret", "bulk", "--config", "wrangler.jsonc"], {
	stdio: ["pipe", "inherit", "inherit"],
});

wrangler.stdin.end(JSON.stringify({
	CLOUDFLARE_API_TOKEN: cloudflareToken,
	ENCHIRIDION_PASSWORD: appPassword,
}));

wrangler.on("error", (error) => {
	console.error(error);
	process.exit(1);
});

wrangler.on("exit", (code) => {
	process.exit(code ?? 1);
});
