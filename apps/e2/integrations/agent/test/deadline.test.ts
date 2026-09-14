import { strict as assert } from "node:assert";
import { withinVoiceDeadline } from "../src/deadline.ts";
Deno.test("voice preflight deadline bounds adapters that ignore cancellation", async () => {
	await assert.rejects(
		withinVoiceDeadline(() => new Promise(() => {}), 5),
		/deadline/,
	);
	assert.equal(
		await withinVoiceDeadline(() => Promise.resolve("ready"), 5),
		"ready",
	);
});
