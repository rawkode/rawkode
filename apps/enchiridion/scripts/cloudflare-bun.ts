import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// Miniflare needs Undici's real Dispatcher/Pool. Bun's built-in compatibility
// module has incomplete implementations, so load the installed package by path.
const undici = require(join(dirname(require.resolve("undici/package.json")), "index.js"));
Object.assign(require("undici"), undici);

// Miniflare's CommonJS WebSocket transport also waits for ws's upgrade event.
const wsPath = require.resolve(join(dirname(require.resolve("ws/package.json")), "index.js"));
require(wsPath);
require.cache.ws = require.cache[wsPath];
