import { chmod } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const realGoogle = Bun.argv.includes("--google");
const path = (name: string) => new URL(name, root);
const existing = Bun.file(path("services/oauth/.dev.vars"));
const text = await existing.exists() ? await existing.text() : "";
const read = (name: string) => text.split("\n").find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
const key = read("TOKEN_ENCRYPTION_KEYS") || JSON.stringify({ local: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") });
const calendarFile = Bun.file(path("services/google-calendar/.dev.vars"));
const calendarText = await calendarFile.exists() ? await calendarFile.text() : "";
const credential = calendarText.split("\n").find((line) => line.startsWith("OAUTH_SERVICE_CREDENTIAL="))?.split("=")[1] || crypto.randomUUID() + crypto.randomUUID();
const hash = new Bun.CryptoHasher("sha256").update(credential).digest("hex");
const local = realGoogle ? "" : "LOCAL_PROVIDER_ORIGIN=http://127.0.0.1:8790\n";
const files = {
  "services/oauth/.dev.vars": `TOKEN_ENCRYPTION_KEYS=${key}\nTOKEN_ENCRYPTION_KEY_ID=local\nSERVICE_CREDENTIALS=${JSON.stringify({ "google-calendar": hash })}\n${local}`,
  "services/google-calendar/.dev.vars": `OAUTH_SERVICE_CREDENTIAL=${credential}\n${local}`,
  "website/.dev.vars": "LOCAL_ADMIN_EMAIL=admin@enchiridion.local\n",
};
for (const [file, contents] of Object.entries(files)) {
  await Bun.write(path(file), contents);
  await chmod(path(file), 0o600);
}
console.log(`Local configuration ready (${realGoogle ? "real Google" : "test provider"}). Existing encryption key and service credential preserved.`);
console.log("Run bun dev. No Cloudflare account or Google credentials are needed in test-provider mode.");
