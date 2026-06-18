import { describe, expect, it } from "vitest";
import { responseHeadersForBrowser, rewriteSameOriginHeader } from "../scripts/dev-ui-proxy.mjs";

describe("dev UI proxy header rewriting", () => {
	it("rewrites same-origin browser write headers to the worker origin", () => {
		expect(rewriteSameOriginHeader("origin", "http://localhost:8787", "http://localhost:8787")).toBe("http://127.0.0.1:3583");
		expect(rewriteSameOriginHeader("referer", "http://localhost:8787/", "http://localhost:8787")).toBe("http://127.0.0.1:3583/");
	});

	it("leaves cross-origin headers untouched so the worker can reject them", () => {
		expect(rewriteSameOriginHeader("origin", "https://attacker.example", "http://localhost:8787")).toBe("https://attacker.example");
		expect(rewriteSameOriginHeader("referer", "https://attacker.example/form", "http://localhost:8787")).toBe("https://attacker.example/form");
	});

	it("removes decoded body headers before returning worker responses to the browser", () => {
		const headers = responseHeadersForBrowser(new Headers({
			"content-encoding": "gzip",
			"content-length": "42",
			"content-type": "application/json",
		}));

		expect(headers).toEqual({ "content-type": "application/json" });
	});
});
