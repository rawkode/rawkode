// Shared backend-address resolution, extracted from `runtime.ts` (which owned this logic alone
// until this stage) now that a second module needs it: `user-rpc-client.ts`'s `/api/user`
// WebSocket connection has the exact same "direct-to-backend, bypass the Vite dev-server proxy"
// requirement `runtime.ts`'s `/api/workspace/:workspaceId` connection already had (see that file's own
// historical comment) — Vite's `server.proxy` entry only forwards plain HTTP, not WebSocket
// upgrades (it isn't configured with `ws: true`), so every WebSocket URL in this package is built
// against the backend's own origin directly, never a same-origin relative path.
//
// Plain HTTP calls (`dev-session.ts`'s `POST /api/dev/sign-in`) deliberately do NOT use this
// module — they use a relative `fetch("/api/dev/sign-in")`, which Vite's proxy DOES forward
// (`vite.config.ts`'s `server.proxy["/api"]`), keeping that request same-origin from the browser's
// point of view and sidestepping CORS entirely (the backend's dev sign-in route sets no CORS
// headers of its own, unlike the workspace/user WebSocket routes' POST-batch fallback, which do).

const backendHost = (import.meta.env.VITE_BACKEND_HOST as string | undefined)?.trim() || "localhost:8787"
const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:"

/** e.g. `ws://localhost:8787` (or `wss://` on an https-served page) — append a `/api/...` path. */
export const backendWsBase = `${wsProtocol}//${backendHost}`
