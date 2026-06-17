import { spawn } from "node:child_process";

const token = process.env.CLOUDFLARE_API_TOKEN;

if (!token) {
	console.error("CLOUDFLARE_API_TOKEN is required to sync Enchiridion Worker secrets.");
	process.exit(1);
}

const wrangler = spawn("wrangler", ["secret", "bulk", "--config", "wrangler.jsonc"], {
	stdio: ["pipe", "inherit", "inherit"],
});

wrangler.stdin.end(JSON.stringify({
	CLOUDFLARE_API_TOKEN: token,
}));

wrangler.on("error", (error) => {
	console.error(error);
	process.exit(1);
});

wrangler.on("exit", (code) => {
	process.exit(code ?? 1);
});
