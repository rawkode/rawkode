# EnchiridionAPI

This imported target is transitional and must not be deployed. In particular,
`EmailSearchClient.swift` uses Cloudflare Access service-token headers and is
prohibited until E2-03 replaces it.

E2-03 will add `packages/protocol` as the versioned Effect `Schema`-derived
HTTP and WebSocket JSON contract, OpenAPI description, Swift `Codable` models,
and native client. Its `hello` negotiates a version; non-overlap is HTTP `426`
or WebSocket close `4426`. Public GraphQL/Pothos/Yoga/`graphql-composer` and
the hand-authored protocol are transitional, undeployable, and removable only
after replacement coverage proves the new contract.

The eventual client will serve data unavailable in local projections; it must
not become a second persistence or authorization layer.
