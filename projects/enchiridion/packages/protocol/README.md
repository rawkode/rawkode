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
Every Base64 (and the 128-bit base64url `frameID`) value is decoded and then
canonical re-encoded before acceptance. This rejects nonzero unused padding
bits and alternate text that would otherwise decode to the same replay key or
signed bytes; replay keys are constructed only after that validation.

`artifacts/openapi.v2.json`, `artifacts/protocol.v2.json`, and
`generated/swift/EnchiridionProtocol.swift` are deterministic derivatives of
that contract. The generated Swift file is Foundation-only and provides
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
