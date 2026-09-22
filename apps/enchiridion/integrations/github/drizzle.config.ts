import { defineConfig } from "drizzle-kit";
import { fileURLToPath } from "node:url";

export default defineConfig({
	dialect: "sqlite",
	driver: "d1-http",
	schema: fileURLToPath(new URL("./schema.ts", import.meta.url)),
	out: fileURLToPath(new URL("./migrations", import.meta.url)),
});
