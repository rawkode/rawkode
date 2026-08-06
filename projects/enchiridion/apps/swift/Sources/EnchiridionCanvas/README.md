# EnchiridionCanvas

The native SwiftUI canvas module for drawing documents and page attachments.
The imported implementation is transitional and non-production. Canvas
content does not live in schema properties.

E2-03 will route remote operations through `packages/protocol`, a versioned
Effect `Schema`-derived HTTP and WebSocket JSON contract with Swift `Codable`
models/client. Canvas will expose no public GraphQL surface. The imported
hand-authored protocol and public GraphQL/Pothos/Yoga/`graphql-composer` are
undeployable and may be removed only after replacement coverage proves the
contract.

The module is native SwiftUI for iOS and macOS. Runtime accessibility,
interaction, and sync-convergence evidence are required before production
enablement.
