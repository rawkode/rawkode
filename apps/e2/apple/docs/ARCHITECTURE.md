# Apple architecture and connection boundary

The first useful workflow is durable capture: write on the Mac or phone, capture
a thought on the Watch, and retain it until the receiving device acknowledges
saving it. Device interfaces share value models and persistence contracts, not
layouts. Full rich-document editing is a separate portability milestone.

## Existing service contracts

`website/src/lib/auth.ts` validates Cloudflare Access's signed assertion,
audience, issuer, expiration and allowed email. Only the service derives
`ownerId`. Website mutation requests additionally require the exact configured
Origin. Native clients must pass through Cloudflare Access; they must never
supply an owner ID, service credential, or unsigned assertion.

- `GET /api/documents/:id` returns `{document: StoredDocument | null}`. A stored
  document has `id`, canonical Tiptap `note`, integer `revision`, `createdAt`,
  and `updatedAt`.
- `POST /api/documents/:id` accepts `{note, expectedRevision}`. A new document
  requires **null**, not zero. A stale revision returns 409 with the current
  document. There is no automatic merge.
- `POST /api/graphql` accepts the existing Today query. Supply the selected
  local date plus explicit UTC start/end instants derived using the user's
  calendar; never assume every day lasts 24 hours. Events, people and GitHub
  activity belong to the authenticated owner. `googleEventsPartial` must remain
  visible to the UI; GraphQL errors must not look like an empty day.
- IDs may contain letters, digits, colon, underscore and hyphen and must start
  alphanumeric, at most128 characters. The capture adapter uses
  `capture:<UUID>`.

## Native session implemented here

`Sources/Platform/NativeSession.swift` is an iOS/macOS framework boundary. A
narrow WKWebView is used only for the existing website sign-in. The workspace
remains native. The adapter reads **only** an unexpired `CF_Authorization`
application cookie whose domain equals the configured website host and whose
path matches the API endpoint. It never substitutes the Cloudflare team-domain
token.

API requests use a new ephemeral URLSession, explicit application cookie and
exact Origin, no shared cookie storage or cache, and a redirect delegate that
refuses every redirect. HTTPS is required; debug builds alone permit HTTP
loopback origins. Credentials and paths in configured origins are rejected.
Responses must be bounded JSON from the same origin. No cookie/JWT is logged or
written to app model files. WebKit owns its app-local website session storage.
Sign-out deletes that store and fences in-flight responses.

Connection is established by a successful authenticated `me { id email }` query,
not a cookie's presence or successful page navigation. `accountID` and `email`
contain only server-verified identity and are cleared on sign-out or rejected
authentication. Cache and upload ownership must use both website origin and
accountID. A detected account change fences requests already in flight. Session
expiry requires signing in again; native background token refresh is not
implemented.

Public interface:

```swift
try NativeSession(origin: websiteURL)
session.makeSignInWebView()
try await session.verifyConnection()
try await session.today(date: localDate, from: startOfDay, to: nextDay)
try await session.document(id: documentID)
try await session.entities(query: searchText)
try await session.supertags()
try await session.captureFeed()
try await session.createCapture(id: captureID, text: text, date: capturedAt)
await session.signOut()
```

Read methods return raw API envelopes. The UI decodes models and distinguishes
loading, unavailable, partial and empty. `isConnected`, `isVerifying`,
`errorMessage` and `status` expose session state. The adapter is main-actor
isolated.

Entity search returns at most50 matches across types; the UI should invite
refining the query rather than claiming a complete directory. The Supertags
response includes archived state so the interface can filter deliberately.

### Provider limitation and future authentication

The cookie path is legitimate for an Access login provider that supports
embedded sign-in, such as a configured email PIN flow. It is **not universal
native OAuth**. Google explicitly rejects OAuth inside WKWebView. The checked-in
Access deployment leaves existing account identity providers available; it does
not prove which provider is enabled in production. A real configured-provider
login is a release gate, not a claim established by compilation.

For unrestricted native sign-in, add an explicitly reviewed server
authorization-code exchange behind Access and use ASWebAuthenticationSession.
Bind a one-time, short-lived code to PKCE S256, state, fixed callback and owner;
exchange it through a dedicated native session API, issue scoped revocable
tokens, store them in Keychain, and retain existing browser CSRF enforcement. Do
not try to extract cookies from ASWebAuthenticationSession or weaken the current
origin check.

Sources:
[Cloudflare authorization cookies](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/),
[Cloudflare JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[Google native OAuth restrictions](https://developers.google.com/identity/protocols/oauth2/native-app),
[ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession).

## Capture and document safety

Captures have stable UUIDs, capture time, source device and text. Save locally
before displaying success. A durable outbox keeps the original payload until
acknowledgement; account connection is not local-save acknowledgement. Failed
writes retain editable content and show an actionable error. Atomic replacement,
a serialized writer, schema versioning and explicit decode failures protect
local storage. Do not replace unreadable data with an empty store.

Cloud upload only creates a unique capture document. The adapter serializes
supported canonical heading/paragraph nodes and uses `expectedRevision: null`.
It reads before creation; an existing ID is acknowledged only when its canonical
content matches exactly. A concurrent409 is checked the same way. Different
content is a conflict and is never overwritten. The capture UUID, timestamp and
original text must remain unchanged during retry. This supports lost-response
retries without duplicate creation. The caller marks uploaded only after this
acknowledgement and must persist that state.

The web note schema includes entity references, component UUIDs, drawings,
diagrams, marks, lists and links. Plain TextEditor is suitable for new
plain-text captures, **not** a lossy projection that can write existing rich
notes. The macOS editor spike imports AppKit and targets macOS14; its document
bridge offers reference behavior but is not a universal package. A future shared
decoder must preserve unknown supported content or reject editing; round-trip
the current TypeScript schema before enabling writes.

The document feed now permits the exact `capture:` prefix alongside its existing
event-feed prefixes. Both GraphQL and document storage enforce that restriction,
and the service still selects storage exclusively by the authenticated owner.
`captureFeed()` returns up to100 summaries; callers fetch and validate each
missing capture document before import. This is a bounded recent feed, not
paginated full-history sync. It does not append captures to today's web note.
The native inbox consumes this feed; a web inbox surface is a separate UI
enhancement.

## Watch and CarPlay

WatchConnectivity is a transport, not a database. Persist on Watch first; use
`transferUserInfo` for queued capture messages and an application
acknowledgement after phone persistence. Deduplicate by capture UUID. Do not use
`updateApplicationContext` as the capture queue because it replaces pending
state. Use context only for the latest small glanceable snapshot. Keep
Watch-local data until acknowledgement, retry after reactivation, and handle
background task completion. Apple requires physical paired-device testing for
queued transfer; simulator evidence cannot qualify delivery.
[Apple WatchConnectivity guidance](https://developer.apple.com/documentation/watchconnectivity/transferring-data-with-watch-connectivity).

CarPlay is an iPhone extension surface with Apple-controlled templates and
eligibility, not another SwiftUI window. A compile-gated template adapter does
not establish an approved app category or entitlement. Small suitable widgets
and Live Activities offer a documented CarPlay surface without inventing a
productivity category. Keep the driving experience glanceable and
purpose-specific; do not show a document editor or GitHub feed while driving.
[Apple CarPlay guidance](https://developer.apple.com/carplay/).

## Release gates

Required before calling this connected daily-use software: authenticate using
the deployed provider on iOS and macOS; prove unauthorized/expired-cookie and
redirect rejection; verify owner separation and sign-out during a request; test
capture upload/duplicate/conflict/timeout with real service responses; verify
local disk failure and corrupt-file recovery; test Watch delivery on paired
hardware after process termination; run VoiceOver, Dynamic Type and keyboard
flows; obtain any required CarPlay entitlement and test the approved surface. No
backend security or deployment configuration is changed by this module.
