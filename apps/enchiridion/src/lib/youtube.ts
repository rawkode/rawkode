export type YouTubeEmbedAttrs = {
	videoId: string;
	url: string;
	title: string;
};

const youTubeVideoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const youTubeHosts = new Set([
	"youtube.com",
	"m.youtube.com",
	"music.youtube.com",
	"youtube-nocookie.com",
]);

export function parseYouTubeUrl(input: string): YouTubeEmbedAttrs | null {
	const value = normalizeSingleUrlText(input);
	if (!value) {
		return null;
	}

	const parsed = parseUrl(value);
	if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
		return null;
	}

	const videoId = extractYouTubeVideoId(parsed);
	if (!videoId) {
		return null;
	}

	return {
		videoId,
		url: youtubeWatchUrl(videoId),
		title: "YouTube video",
	};
}

export function isYouTubeVideoId(value: string): boolean {
	return youTubeVideoIdPattern.test(value);
}

export function youtubeEmbedUrl(videoId: string): string {
	return `https://www.youtube-nocookie.com/embed/${videoId}`;
}

export function youtubeWatchUrl(videoId: string): string {
	return `https://www.youtube.com/watch?v=${videoId}`;
}

function normalizeSingleUrlText(input: string): string {
	let value = input.trim();
	const angleBracketMatch = /^<([^<>\s]+)>$/.exec(value);
	if (angleBracketMatch) {
		value = angleBracketMatch[1];
	}
	return /\s/.test(value) ? "" : value;
}

function parseUrl(input: string): URL | null {
	try {
		return new URL(input);
	} catch {
		if (/^(?:(?:www|m|music)\.)?(?:youtube\.com|youtube-nocookie\.com)\/|^(?:www\.)?youtu\.be\//i.test(input)) {
			return new URL(`https://${input}`);
		}
		return null;
	}
}

function extractYouTubeVideoId(url: URL): string | null {
	const host = normalizedHost(url.hostname);
	let videoId: string | null = null;

	if (host === "youtu.be") {
		videoId = pathPart(url, 0);
	} else if (youTubeHosts.has(host)) {
		const firstPart = pathPart(url, 0);
		if (firstPart === "watch") {
			videoId = url.searchParams.get("v");
		} else if (firstPart === "embed" || firstPart === "shorts" || firstPart === "live") {
			videoId = pathPart(url, 1);
		}
	}

	return videoId && isYouTubeVideoId(videoId) ? videoId : null;
}

function normalizedHost(hostname: string): string {
	return hostname.toLowerCase().replace(/^www\./, "");
}

function pathPart(url: URL, index: number): string | null {
	return url.pathname.split("/").filter(Boolean)[index] ?? null;
}
