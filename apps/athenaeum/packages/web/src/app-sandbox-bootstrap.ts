// **Adversarial-review fix** — the counterpart, on the `web` side, to `packages/backend/src
// /app-run-credential.ts`'s mint/verify mechanism. `AppLibraryPanel.tsx`'s preview `<iframe>` runs
// an App's agent-authored `client` code with `sandbox="allow-scripts"` ONLY (no
// `allow-same-origin`, no access to this parent page's DOM/`localStorage`/cookies/RPC session —
// see that file's own header comment) — which means the sandboxed document has no way to attach
// ANY credential to its own HTTP requests unless something inside that SAME sandboxed document
// does it for it. This module builds that "something": a small bootstrap script, inlined into the
// iframe's `srcDoc` BEFORE the App's own `client.js` loads, that:
//
//   1. Rewrites the `client.js` `<script src>` itself to carry the App-run credential as
//      `?token=...` (`AppLibraryPanel.tsx` does this directly, not via this module — the script
//      tag is simple enough not to need a helper).
//   2. Monkey-patches `window.fetch` so that any relative-URL call the App's OWN client code
//      makes (e.g. the shipped counter example's `fetch("/increment")`, `app-library.test.ts`'s
//      `COUNTER_CLIENT_CODE`) is transparently rewritten to target this App's own
//      `.../apps/:appId/run` route, WITH the same credential attached, before actually fetching.
//      An agent-authored App's client code never needs to know its own workspaceId/appId, the
//      `/run` URL shape, or that a credential exists at all — it just calls `fetch("/some/path")`
//      the way `COUNTER_CLIENT_CODE`'s hand-written example already does, and this bootstrap makes
//      that reach the right, authenticated place.
//
// **`rewriteFetchTarget` below is the real routing/credential logic, kept as a plain, directly
// unit-testable function** (`app-sandbox-bootstrap.test.ts` calls it directly — no `eval`/`new
// Function` anywhere in this codebase's own test suite, deliberately: executing dynamically
// generated code strings to test yourself is exactly the kind of pattern this whole App Library
// feature exists to run SAFELY inside a real sandbox, not something this repo's own tooling should
// casually do to itself). `buildAppSandboxBootstrapScript` renders that same logic as an inline JS
// source string for the ONE place it actually needs to run as text: inside the sandboxed iframe's
// own `srcDoc`, executed by the browser's real JS engine in that genuinely isolated realm — not by
// this package's own process.
//
// **Never rewrites absolute URLs** (anything with a scheme, e.g. `https://example.com/...`, or a
// protocol-relative `//host/...`) — an App's client code retains its ordinary ability to fetch
// third-party origins directly from the user's real browser (a genuinely different, pre-existing,
// out-of-scope-for-this-fix concern from the sandboxed SERVER code's `globalOutbound: null`, which
// this rewrite has no relationship to at all). Only same-document-relative requests — the only
// shape that could plausibly mean "call this App's own backend" — are ever redirected and
// credentialed.
//
// **Known, accepted limitation** (stated explicitly rather than glossed over, per this codebase's
// own documentation discipline): a `fetch(new Request(...))` call — passing an already-constructed
// `Request` object rather than a URL string — is passed through UNREWRITTEN. Safely rewriting a
// `Request`'s URL while preserving its body/headers/method requires cloning a (possibly
// already-consumed, possibly streaming) body, which this small bootstrap deliberately does not
// attempt. `COUNTER_CLIENT_CODE` (`app-library.test.ts`) and every other hand-written example in
// this codebase call `fetch(urlString)`, never `fetch(new Request(...))` — this is real,
// documented future work if an agent-authored App's client code ever needs that shape, not a
// silent gap.

const ABSOLUTE_URL_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//

/**
 * The real routing/credential-attachment decision: given the base `.../apps/:appId/run` URL, the
 * App-run credential, and whatever URL string the App's client code asked to `fetch`, returns the
 * fully-qualified, credentialed target to fetch INSTEAD — or `undefined` when `urlStr` is
 * absolute/protocol-relative, meaning "don't rewrite this one at all" (this module's own header
 * comment, "Never rewrites absolute URLs").
 */
export const rewriteFetchTarget = (runBaseUrl: string, token: string, urlStr: string): string | undefined => {
  if (ABSOLUTE_URL_PATTERN.test(urlStr)) return undefined
  const path = urlStr.startsWith("/") ? urlStr : `/${urlStr}`
  const separator = path.includes("?") ? "&" : "?"
  return `${runBaseUrl}${path}${separator}token=${encodeURIComponent(token)}`
}

/**
 * A defense-in-depth escape applied to every string this module embeds inside a literal HTML
 * `<script>` element (`AppLibraryPanel.tsx`'s `srcDoc`) — breaks up any `</script` sequence so it
 * can never prematurely close that tag, regardless of content. Structurally unreachable today
 * (`runBaseUrl` is always built from validated `EntityId`s, `token` is always a
 * `base64url(payload).base64url(sig)` credential — neither alphabet contains `<` or `/`), but
 * cheap insurance against exactly this kind of HTML-in-JS-string injection, the same "cheap
 * insurance, not because it's expected to occur" discipline `app-run-credential.ts`'s own
 * `CREDENTIAL_VERSION` tagging comment uses.
 */
const escapeScriptClose = (value: string): string => value.replaceAll(/<\/script/gi, "<\\/script")

/**
 * Renders `rewriteFetchTarget`'s logic as an inline JS source string for the iframe's `srcDoc` —
 * see this module's own header comment for why this is the one place the logic needs to exist as
 * text rather than a called function. `runBaseUrl`/`token` are embedded via `JSON.stringify` (not
 * raw string interpolation) so neither value's exact characters can ever break out of the JS
 * string literal they're embedded in, and the WHOLE rendered script is passed through
 * `escapeScriptClose` before `AppLibraryPanel.tsx` ever splices it into an HTML `<script>` element.
 */
export const buildAppSandboxBootstrapScript = (runBaseUrl: string, token: string): string =>
  escapeScriptClose(`
(function () {
  var RUN_BASE = ${JSON.stringify(runBaseUrl)};
  var TOKEN = ${JSON.stringify(token)};
  var ABSOLUTE_URL_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?\\/\\//;
  var originalFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : undefined;
  if (!originalFetch) return;

  window.fetch = function (input, init) {
    try {
      // Request objects are passed through unrewritten — see this module's own header comment
      // ("Known, accepted limitation") for why.
      if (typeof Request !== "undefined" && input instanceof Request) {
        return originalFetch(input, init);
      }
      var urlStr = input instanceof URL ? input.href : String(input);
      if (ABSOLUTE_URL_PATTERN.test(urlStr)) {
        return originalFetch(input, init);
      }
      var path = urlStr.charAt(0) === "/" ? urlStr : "/" + urlStr;
      var separator = path.indexOf("?") === -1 ? "?" : "&";
      var target = RUN_BASE + path + separator + "token=" + encodeURIComponent(TOKEN);
      return originalFetch(target, init);
    } catch (error) {
      // Never let a bug in this rewrite itself break the App's own fetch entirely — fall back to
      // the original, unrewritten call (which will simply 401 on a governed workspace, the same
      // fail-closed outcome as if this bootstrap didn't run at all).
      return originalFetch(input, init);
    }
  };
})();
`)
