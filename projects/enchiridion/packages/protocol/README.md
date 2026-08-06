# Enchiridion protocol

This package is the versioned, language-neutral public native boundary. It
uses Effect `Schema` to validate JSON HTTP and WebSocket messages; it is not
an Effect RPC contract and it contains no Worker route implementation.

`src/contracts.ts` is authoritative. Its Effect Schema registry is consumed
mechanically by the OpenAPI/manifest and Swift generators; those outputs do
not maintain a second error-code or model list. It declares v2 device registration and
revocation requests plus the mandatory WebSocket hello, acknowledgement, sync
change, and stable error envelope. Every `syncChange` carries the accepted
`deviceID` and `authEpoch`, an immutable 128-bit base64url `frameID` replay nonce, and a
base64 DER P-256 ECDSA SHA-256 `deviceSignature`. The signature covers the
binary length-prefixed fields from `syncChangeSigningPayload`; this exact byte rule is
in the manifest and source, not inferred from JSON. Servers must claim the
`deviceID:frameID` replay key and re-check the durable auth epoch before
applying the payload. An HTTP route with no overlapping version
returns the envelope at `426`; a WebSocket negotiation failure closes at
`4426` with the same semantic error before application frames are accepted.
Every public object decoder rejects unknown members, matching the emitted
OpenAPI `additionalProperties: false` projection.

Every non-bootstrap HTTP request carries `SignedDeviceRequestEnvelope`. Its
P-256 proof covers v2 method, canonical absolute path, an explicitly empty or
sorted RFC 3986 query, raw/canonical JSON body SHA-256, request and idempotency
IDs, owner/vault/generation, actor and optional target device, auth and
credential epochs, bounded epoch-millisecond issue/expiry values, and a
canonical 128-bit nonce. `POST /v2/devices/challenge` and initial registration
are the bootstrap exceptions; revoke is actor/target signed, mutations use
`POST /v2/mutations`, and blobs use `PUT` or `DELETE /v2/blobs/{sha256}`. A
blob PUT signs the exact octets: `bodySHA256` must equal the path digest, never
a JSON metadata command. `canonicalJSONStringify`, `canonicalJSONBytes`,
`canonicalJSONSHA256`, `canonicalizePath`, `canonicalizeQuery`, and
`signedDeviceRequestSigningPayload` are the reference public helpers. The
Swift output contains matching canonical JSON, SHA-256, and signing-byte
helpers. WebSocket hello and sync frames carry signed/session-bound
`credentialEpoch`, `generationEpoch`, `sessionNonce`, and
`assertionExpiresAt`; all four are included in sync signing bytes.

Initial registration contains a full `DeviceChallengeProof` rather than a
standalone signature; its versioned `ENCHCHAL` bytes bind challenge ID,
audience, challenge bytes, expiry, nonce, and device SPKI. Signed revoke and
mutation envelopes hash the canonical command only, never their enclosing
envelope. Raw blob PUT uses exactly one case-insensitive
`Enchiridion-Signed-Request` header (canonical base64url, maximum 8 KiB) and
signs the raw bytes/path. Blob DELETE uses that same required header but sends
no HTTP body: its envelope hashes the canonical `BlobDeleteCommand`, binding
the `DELETE` method and `/v2/blobs/{sha256}` path without turning the command
into wire bytes. Signed JSON entry points use a structural parser
that rejects duplicate member names before Effect Schema validation.
Every Base64 (and the 128-bit base64url `frameID`) value is decoded and then
canonical re-encoded before acceptance. This rejects nonzero unused padding
bits and alternate text that would otherwise decode to the same replay key or
signed bytes; replay keys are constructed only after that validation.

All P-256 ECDSA signatures use the explicit `p256-ecdsa-der-low-s` profile:
canonical base64 DER, minimal positive `R`/`S` scalars in `[1,n-1]`, and
`S <= floor(n/2)` for secp256r1. High-S twins are rejected, never normalized,
so a valid signature has one accepted wire representation across TypeScript,
Swift, OpenAPI, and the manifest.

`artifacts/openapi.v2.json`, `artifacts/protocol.v2.json`, and
`generated/swift/EnchiridionProtocol.swift` are deterministic derivatives of
that contract. The generated Swift file uses Foundation and CryptoKit and provides
`Codable` wire types, typed HTTP transport/client primitives, and WebSocket
frame types/protocols. It intentionally lives here until a later integration

The generated revoke client encodes each `deviceID` path segment exactly once
using RFC 3986 ASCII-unreserved characters only (`A-Z`, `a-z`, `0-9`, `-._~`);
all other UTF-8 bytes are percent encoded. Swift public values validate exact
v2 versions, opaque ID/frame formats, bounded Base64 payloads, P-256 SPKI and
signature encoding, and HTTPS-only HTTP endpoints before use.
package owns copying it into an Xcode target.

```sh
bun run --cwd packages/protocol generate
bun run --cwd packages/protocol generate:check
bun run --cwd packages/protocol typecheck
bun run --cwd packages/protocol test
swiftc -typecheck generated/swift/EnchiridionProtocol.swift
swiftc generated/swift/EnchiridionProtocol.swift tests/ProtocolGolden.swift -o /tmp/enchiridion-protocol-golden
/tmp/enchiridion-protocol-golden
bun run --cwd packages/protocol test:swift-consumer
```

The golden vectors are wire compatibility fixtures, not server behavior
tests. Workers must independently bind these schemas when the route migration
is authorized.
