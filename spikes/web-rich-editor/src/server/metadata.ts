import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";
import type { LinkMetadata as Metadata } from "../lib/note";

export function webURL(value: string, base?: string): URL {
	const url = new URL(value, base);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		(url.port && !["80", "443"].includes(url.port))
	) {
		throw new Error(
			"Use a public HTTP or HTTPS URL on a standard web port, without credentials.",
		);
	}
	return url;
}

export function isPublicAddress(address: string): boolean {
	try {
		return ipaddr.process(address).range() === "unicast";
	} catch {
		return false;
	}
}

const videoMIME = (mime: string) =>
	mime.startsWith("video/") ||
	["application/vnd.apple.mpegurl", "application/x-mpegurl"].includes(mime);
interface Page {
	url: string;
	mime: string;
	body: string;
}

/** Resolve and pin an approved public address for every request and redirect. */
async function fetchPage(source: string, redirects = 0): Promise<Page> {
	if (redirects > 4) throw new Error("The link redirects too many times.");
	const url = webURL(source);
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
	const addresses = await Promise.race([
		lookup(hostname, { all: true }),
		new Promise<never>((_, reject) => {
			dnsTimeout = setTimeout(
				() => reject(new Error("Host lookup timed out.")),
				5000,
			);
		}),
	]).finally(() => clearTimeout(dnsTimeout));
	if (
		!addresses.length ||
		addresses.some((item) => !isPublicAddress(item.address))
	)
		throw new Error("Private and reserved network addresses are not allowed.");
	const chosen = addresses[0]!;
	return new Promise<Page>((resolve, reject) => {
		const request = (url.protocol === "https:" ? https : http).request(
			url,
			{
				agent: false,
				headers: {
					Accept: "text/html,application/json,video/*;q=0.8,*/*;q=0.5",
					"User-Agent": "Fieldnotes-Spike/0.1",
				},
				lookup: ((
					_host: string,
					options: { all?: boolean },
					callback: Function,
				) => {
					if (options.all) callback(null, [chosen]);
					else callback(null, chosen.address, chosen.family);
				}) as any,
			},
			(response) => {
				const status = response.statusCode ?? 500;
				if (status >= 300 && status < 400 && response.headers.location) {
					response.destroy();
					try {
						resolve(
							fetchPage(
								webURL(response.headers.location, url.href).href,
								redirects + 1,
							),
						);
					} catch (error) {
						reject(error);
					}
					return;
				}
				if (status < 200 || status >= 300) {
					response.destroy();
					reject(new Error(`The website returned HTTP ${status}.`));
					return;
				}
				const mime = (response.headers["content-type"] ?? "")
					.split(";")[0]!
					.trim()
					.toLowerCase();
				if (videoMIME(mime)) {
					response.destroy();
					resolve({ url: url.href, mime, body: "" });
					return;
				}
				const limit = 2 * 1024 * 1024;
				if (Number(response.headers["content-length"]) > limit) {
					response.destroy();
					reject(new Error("Metadata exceeds the 2 MB limit."));
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > limit) {
						request.destroy(new Error("Metadata exceeds the 2 MB limit."));
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () =>
					resolve({
						url: url.href,
						mime,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
				response.on("error", reject);
			},
		);
		const timeout = setTimeout(
			() => request.destroy(new Error("Metadata request timed out.")),
			12_000,
		);
		request.on("close", () => clearTimeout(timeout));
		request.on("error", reject);
		request.end();
	});
}

function resolved(value: string | undefined, base: string): string | undefined {
	if (!value) return;
	try {
		return webURL(value, base).href;
	} catch {
		return;
	}
}

export function parsePage(
	html: string,
	base: string,
): { metadata: Metadata; endpoint?: string } {
	const $ = load(html);
	const meta = (...names: string[]) =>
		names
			.map((name) =>
				$(`meta[property="${name}"],meta[name="${name}"]`)
					.first()
					.attr("content"),
			)
			.find(Boolean);
	const metadata: Metadata = {
		title:
			meta("og:title", "twitter:title") ??
			$("title").first().text() ??
			new URL(base).hostname,
		summary: meta("og:description", "description", "twitter:description"),
		imageURL: resolved(
			meta("og:image:secure_url", "og:image", "twitter:image"),
			base,
		),
	};
	if (!metadata.title.trim()) metadata.title = new URL(base).hostname;
	const video = resolved(
		meta("og:video:secure_url", "og:video:url", "og:video"),
		base,
	);
	if (video) {
		const mime = meta("og:video:type")?.toLowerCase() ?? "";
		if (videoMIME(mime))
			metadata.playback = { type: "directVideo", url: video };
		else if (!mime || mime === "text/html")
			metadata.playback = { type: "embedURL", url: video };
	}
	const endpoint = $("link")
		.toArray()
		.find(
			(element) =>
				($(element).attr("rel") ?? "")
					.toLowerCase()
					.split(/\s+/)
					.includes("alternate") &&
				$(element).attr("type")?.toLowerCase() === "application/json+oembed",
		);
	return {
		metadata,
		endpoint: resolved(endpoint ? $(endpoint).attr("href") : undefined, base),
	};
}

export function mergeOEmbed(
	metadata: Metadata,
	input: unknown,
	base: string,
): Metadata {
	if (!input || typeof input !== "object")
		throw new Error("Invalid oEmbed metadata.");
	const value = input as Record<string, unknown>;
	const result = { ...metadata };
	if (typeof value.title === "string" && value.title.trim())
		result.title = value.title;
	if (typeof value.thumbnail_url === "string")
		result.imageURL = resolved(value.thumbnail_url, base) ?? result.imageURL;
	if (
		["video", "rich"].includes(String(value.type)) &&
		typeof value.html === "string"
	) {
		const src = load(value.html)("iframe").first().attr("src");
		const frame = resolved(src, base);
		if (frame) result.playback = { type: "embedURL", url: frame };
		else if (!result.playback)
			result.discoveryNote =
				"This provider did not advertise an iframe player. Open the link to view it.";
	}
	return result;
}

let active = 0;
export async function resolveMetadata(source: string): Promise<Metadata> {
	if (active >= 4)
		throw new Error("Several previews are loading. Try again in a moment.");
	active++;
	try {
		const page = await fetchPage(source);
		if (videoMIME(page.mime))
			return {
				title: new URL(page.url).pathname.split("/").pop() || "Video",
				playback: { type: "directVideo", url: page.url },
			};
		if (page.mime && !page.mime.includes("html"))
			throw new Error(
				"The link does not provide a web page or supported video.",
			);
		const { metadata, endpoint } = parsePage(page.body, page.url);
		if (!endpoint) return metadata;
		try {
			const response = await fetchPage(endpoint);
			return mergeOEmbed(metadata, JSON.parse(response.body), response.url);
		} catch (error) {
			return {
				...metadata,
				discoveryNote: `Player metadata could not be loaded: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
		}
	} finally {
		active--;
	}
}
