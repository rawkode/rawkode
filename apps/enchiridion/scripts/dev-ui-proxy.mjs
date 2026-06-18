import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const clientDir = resolve(root, "dist/client");
const workerOrigin = process.env.ENCHIRIDION_WORKER_ORIGIN ?? "http://127.0.0.1:3583";
const workerOriginUrl = new URL(workerOrigin);
const port = Number(process.env.PORT ?? "4321");

const contentTypes = new Map([
	[".css", "text/css; charset=utf-8"],
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".map", "application/json; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".webp", "image/webp"],
]);

const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

		if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/apps/")) {
			await proxyToWorker(request, response, url);
			return;
		}

		serveStatic(response, request.method ?? "GET", url.pathname);
	} catch (error) {
		console.error(error);
		response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
		response.end("Internal dev proxy error");
	}
});

if (isMainModule()) {
	server.listen(port, "127.0.0.1", () => {
		console.log(`Enchiridion UI proxy: http://127.0.0.1:${port}`);
		console.log(`Forwarding API and mini-app routes to ${workerOrigin}`);
	});
}

async function proxyToWorker(incoming, outgoing, url) {
	const target = new URL(url.pathname + url.search, workerOrigin);
	const incomingOrigin = `${url.protocol}//${url.host}`;
	const headers = new Headers();

	for (const [key, value] of Object.entries(incoming.headers)) {
		const lowerKey = key.toLowerCase();
		if (value === undefined || lowerKey === "host" || lowerKey === "content-length" || lowerKey === "transfer-encoding") {
			continue;
		}
		if (Array.isArray(value)) {
			for (const entry of value) {
				headers.append(key, rewriteSameOriginHeader(lowerKey, entry, incomingOrigin));
			}
		} else {
			headers.set(key, rewriteSameOriginHeader(lowerKey, value, incomingOrigin));
		}
	}

	const method = incoming.method ?? "GET";
	const init = {
		method,
		headers,
		body: method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(incoming),
		duplex: "half",
	};
	const proxied = await fetch(target, init);

	outgoing.writeHead(proxied.status, responseHeadersForBrowser(proxied.headers));
	if (method === "HEAD" || !proxied.body) {
		outgoing.end();
		return;
	}
	Readable.fromWeb(proxied.body).pipe(outgoing);
}

export function rewriteSameOriginHeader(key, value, incomingOrigin) {
	if (key === "origin") {
		return value === incomingOrigin ? workerOriginUrl.origin : value;
	}

	if (key === "referer") {
		try {
			const referer = new URL(value);
			if (referer.origin === incomingOrigin) {
				referer.protocol = workerOriginUrl.protocol;
				referer.host = workerOriginUrl.host;
				return referer.toString();
			}
		} catch {
			return value;
		}
	}

	return value;
}

export function responseHeadersForBrowser(headers) {
	const nextHeaders = new Headers(headers);
	nextHeaders.delete("content-encoding");
	nextHeaders.delete("content-length");
	return Object.fromEntries(nextHeaders);
}

function serveStatic(response, method, urlPath) {
	const relativePath = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
	const requestedPath = relativePath === "/" || relativePath === "." ? "index.html" : relativePath.replace(/^[/\\]/, "");
	let filePath = resolve(join(clientDir, requestedPath));

	if (!filePath.startsWith(clientDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
		filePath = resolve(clientDir, "index.html");
	}

	if (!existsSync(filePath)) {
		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		response.end("Build the client first with npm run build:client");
		return;
	}

	response.writeHead(200, {
		"content-type": contentTypes.get(extname(filePath)) ?? "application/octet-stream",
	});

	if (method === "HEAD") {
		response.end();
		return;
	}
	createReadStream(filePath).pipe(response);
}

function isMainModule() {
	return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}
