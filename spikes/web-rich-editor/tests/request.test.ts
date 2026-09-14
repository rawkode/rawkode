import assert from "node:assert/strict";
import test from "node:test";
import { readJSON } from "../src/server/request";

const origin = "http://127.0.0.1:4327";
const request = (body: string, headers: Record<string, string> = {}) =>
	new Request(`${origin}/api/metadata`, {
		method: "POST",
		headers: { origin, "content-type": "application/json", ...headers },
		body,
	});

test("JSON endpoints accept only same-origin JSON", async () => {
	assert.deepEqual(await readJSON(request('{"ok":true}'), origin), {
		ok: true,
	});
	await assert.rejects(
		readJSON(request("{}", { origin: "https://attacker.example" }), origin),
		/same-origin/,
	);
	await assert.rejects(
		readJSON(request("{}", { origin: "" }), origin),
		/same-origin/,
	);
	await assert.rejects(
		readJSON(request("{}", { "content-type": "text/plain" }), origin),
		/JSON/,
	);
});

test("body limits hold without Content-Length and count UTF-8 bytes", async () => {
	await assert.rejects(readJSON(request('"ééé"'), origin, 7), /too large/);
	await assert.rejects(
		readJSON(request("{}", { "content-length": "999" }), origin, 8),
		/too large/,
	);
	await assert.rejects(readJSON(request("not JSON"), origin), SyntaxError);
});
