// GadgetBridgeJavaScriptShim.swift
// EnchiridionGadgets
//
// The tiny JS runtime injected into every gadget WebView (as a
// `WKUserScript`, by `GadgetWebViewHost.swift`) — this is what turns the
// raw `window.webkit.messageHandlers.<name>.postMessage(...)` primitive
// into the `window.enchiridionGadget.graphQuery(view, params)` promise-
// based API a gadget's own HTML/JS actually calls (see
// `Gadgets/TodayTasksGadget.swift`). Kept in Swift as a plain string
// constant (not a bundled `.js` resource file) — this is deliberately the
// ONLY JS this module ships; a gadget's own content is data the host
// renders, not code this module authors, so there's no build step / asset
// pipeline worth introducing for one script.
//
// Deliberately NOT exposing `fetch`/`XMLHttpRequest`/`WebSocket` removal
// as this script's real security boundary — that's CSP's job
// (`GadgetDocumentBuilder`'s `connect-src 'none'`, enforced by WebKit
// itself, not by JS that a sufficiently creative script could route
// around). Overwriting those globals here is real but secondary: it
// removes the *temptation/API surface* for a gadget author before CSP
// would reject the call anyway, and fails a same-document accidental use
// immediately/synchronously rather than via an async rejected promise.

import Foundation

public enum GadgetBridgeJavaScriptShim {
  /// The message-handler name `GadgetWebViewHost` registers with
  /// `WKUserContentController.add(_:name:)` and this script's
  /// `postMessage` calls target — kept in one place
  /// (`GadgetBridgeMessageHandler.messageHandlerName` is the same
  /// constant) so the JS and Swift sides can't drift to different names.
  public static let messageHandlerName = "enchiridionGadgetBridge"

  /// How long (in milliseconds) `request()` waits for a matching
  /// `__resolve` call before rejecting its `Promise` on its own. This is
  /// cheap defensive insurance, independent of *why* a response might
  /// never arrive — e.g. `GadgetBridgeMessageHandler.deliver(_:)` silently
  /// drops a response if `GadgetBridgeJavaScriptShim.injectionScript(for:)`
  /// ever fails to encode it (a `guard let ... else { return }` with no
  /// fallback), which today would otherwise leave the gadget's `Promise`
  /// hanging forever with no rejection at all. 10 seconds: long enough
  /// that it should never fire for a real round-trip (the local
  /// capability-authorization check in `GadgetBridge.handle(request:)` is
  /// effectively instant, and even a real `HTTPGadgetBridgeTransport`
  /// network call over a slow connection normally completes in a few
  /// seconds, not ten), while still being short enough that a gadget's UI
  /// doesn't sit silently frozen for anywhere near as long as, say,
  /// `URLSession`'s own default 60-second request timeout would allow.
  public static let requestTimeoutMilliseconds = 10_000

  /// Injected at `.atDocumentStart`, main-frame only, before any of the
  /// gadget's own `<script>` runs (`GadgetWebViewHost.swift` sets this up)
  /// — so `window.enchiridionGadget` is always defined by the time gadget
  /// code executes.
  public static var source: String {
    """
    (function () {
      'use strict';
      var pending = Object.create(null);
      var counter = 0;
      var REQUEST_TIMEOUT_MS = \(requestTimeoutMilliseconds);

      function request(type, view, params) {
        return new Promise(function (resolve, reject) {
          var id = 'gadget-req-' + (++counter) + '-' + Date.now();

          // Defensive client-side timeout — independent of whatever might
          // cause a response to never arrive (dropped on the native side,
          // lost message, ...). See `requestTimeoutMilliseconds`'s doc
          // comment (GadgetBridgeJavaScriptShim.swift) for why this exists
          // and why 10s. Cleared by both the resolve and reject wrappers
          // below the moment a real response (or a synchronous
          // `postMessage` failure) arrives, so it never fires for a
          // request that actually completed in time.
          var timeoutID = setTimeout(function () {
            if (!pending[id]) return;
            delete pending[id];
            reject(new Error('gadget bridge request timed out after ' + REQUEST_TIMEOUT_MS + 'ms'));
          }, REQUEST_TIMEOUT_MS);

          pending[id] = {
            resolve: function (value) {
              clearTimeout(timeoutID);
              resolve(value);
            },
            reject: function (err) {
              clearTimeout(timeoutID);
              reject(err);
            }
          };
          try {
            window.webkit.messageHandlers.\(messageHandlerName).postMessage({
              id: id,
              type: type,
              view: view,
              params: params === undefined ? null : params
            });
          } catch (err) {
            clearTimeout(timeoutID);
            delete pending[id];
            reject(err);
          }
        });
      }

      window.enchiridionGadget = Object.freeze({
        /** Calls a pre-defined, parameterized read-only view (e.g.
         *  "nodesByTag") — the ONLY read path a gadget has; there is no
         *  free-form query capability from JS, ever. */
        graphQuery: function (view, params) {
          return request('graph.query', view, params);
        },
        /** Proposes a write to a specific, capability-scoped page. Writes
         *  are always proposals — nothing reachable from this bridge can
         *  confirm/approve its own proposal. */
        graphPropose: function (params) {
          return request('graph.propose', undefined, params);
        },
        /** Internal — resolves/rejects the Promise `request()` created,
         *  called only by the native side via evaluateJavaScript. Not
         *  documented as public API for gadget authors. */
        __resolve: function (response) {
          var entry = pending[response && response.id];
          if (!entry) return;
          delete pending[response.id];
          if (response.ok) {
            entry.resolve(response.result === undefined ? null : response.result);
          } else {
            var message = (response.error && response.error.message) || 'gadget bridge error';
            entry.reject(new Error(message));
          }
        }
      });

      // Defense-in-depth only — see this file's header. The enforced
      // boundary is CSP's connect-src 'none' (GadgetDocumentBuilder.swift),
      // not this.
      try { window.fetch = undefined; } catch (err) {}
      try { window.XMLHttpRequest = undefined; } catch (err) {}
      try { window.WebSocket = undefined; } catch (err) {}
      try { window.EventSource = undefined; } catch (err) {}
    })();
    """
  }

  /// The `evaluateJavaScript` call `GadgetBridgeMessageHandler` runs to
  /// deliver a response back into the WebView — a single call into
  /// `window.enchiridionGadget.__resolve(response)`. `response`'s JSON
  /// encoding is produced by `GadgetJSONValue.jsonString()`
  /// (JSONSerialization-backed), which is the same escaping WebKit's own
  /// `postMessage` JS bridging relies on, so arbitrary characters in an
  /// `id`/error `message` (quotes, backslashes, newlines, unicode) round-
  /// trip safely — this is exercised directly in
  /// `GadgetBridgeResponseEncodingTests.swift`.
  public static func injectionScript(for response: GadgetBridgeResponse) throws -> String {
    let json = try response.jsonValue.jsonString()
    return "window.enchiridionGadget && window.enchiridionGadget.__resolve(\(json));"
  }
}
