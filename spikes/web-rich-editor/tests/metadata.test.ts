import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isPublicAddress,
	parsePage,
	mergeOEmbed,
	webURL,
} from "../src/server/metadata.ts";

test("rejects local, private, mapped, multicast, and documentation networks", () => {
	for (const address of [
		"127.0.0.1",
		"10.1.2.3",
		"192.168.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"::1",
		"::ffff:127.0.0.1",
		"fc00::1",
		"fe80::1",
		"224.0.0.1",
		"192.0.2.1",
		"2001:db8::1",
	])
		assert.equal(isPublicAddress(address), false, address);
	assert.equal(isPublicAddress("1.1.1.1"), true);
	assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});
test("URL guard rejects credentials and nonweb schemes and ports", () => {
	for (const value of [
		"file:///etc/passwd",
		"javascript:alert(1)",
		"https://user:secret@example.org/",
		"http://example.org:8080",
	])
		assert.throws(() => webURL(value));
});
test("generic Open Graph discovers direct media and oEmbed", () => {
	const parsed = parsePage(
		'<title>Fallback</title><meta property="og:title" content="A &amp; B"><meta property="og:video" content="/film.m3u8"><meta property="og:video:type" content="application/vnd.apple.mpegurl"><link rel="alternate" type="application/json+oembed" href="/oembed">',
		"https://example.org/watch",
	);
	assert.equal(parsed.metadata.title, "A & B");
	assert.deepEqual(parsed.metadata.playback, {
		type: "directVideo",
		url: "https://example.org/film.m3u8",
	});
	assert.equal(parsed.endpoint, "https://example.org/oembed");
});
test("only iframe URL is extracted; arbitrary scripts are never returned", () => {
	const metadata = mergeOEmbed(
		{ title: "Page" },
		{
			type: "video",
			title: "Clip",
			html: '<script>alert(1)</script><iframe src="https://player.example.org/clip"></iframe>',
		},
		"https://example.org/oembed",
	);
	assert.deepEqual(metadata, {
		title: "Clip",
		playback: { type: "embedURL", url: "https://player.example.org/clip" },
	});
	assert.equal(
		mergeOEmbed(
			{ title: "Page" },
			{ type: "rich", html: '<iframe src="javascript:alert(1)">' },
			"https://example.org",
		).playback,
		undefined,
	);
});
