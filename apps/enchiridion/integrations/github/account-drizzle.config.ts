import { defineConfig } from "drizzle-kit";
import { fileURLToPath } from "node:url";

export default defineConfig({
	dialect: "sqlite",
	driver: "durable-sqlite",
	schema: fileURLToPath(new URL("./account-schema.ts", import.meta.url)),
	out: fileURLToPath(new URL("./account-migrations", import.meta.url)),
});
