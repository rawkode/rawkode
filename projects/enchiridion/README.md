# Enchiridion

Enchiridion is a greenfield, Cloudflare-native personal product with native
iOS and macOS clients. It is developed independently of `apps/enchiridion`:
there is no legacy feature-parity, data-migration, or compatibility
requirement.

> **v2 target versus imported baseline.** This directory currently contains
> an imported, transitional, non-production baseline. Its hand-authored
> protocol, public GraphQL, Cloudflare Access service-token clients and
> enrollment, Wrangler configuration, and direct deployment scripts are
> **forbidden from every deployment**. They are test/reference material only;
> they do not authorize a preview or production environment.

## Product and architecture boundary

- Native clients are Swift/XcodeGen projects in `apps/swift`; their local
  persistence and sync layers are product code, not a port of the legacy app.
- The backend runs on Cloudflare Workers, Durable Objects, and R2 under
  `workers/`; shared domain contracts live in `packages/`.
- The production TypeScript standard is Effect end to end: `Schema` at
  boundaries, typed errors in public interfaces, `Layer` for dependencies,
  and structured observability. Platform APIs are allowed only behind narrow,
  audited adapters.
- E2-01 has introduced `packages/protocol` as the source of truth for
  versioned Effect `Schema`-derived HTTP and WebSocket JSON contracts,
  OpenAPI, constrained Swift `Codable` models, and typed native client
  primitives. Its package gate runs artifact drift, schema, TypeScript, direct
  Biome, and externally compiled Swift-consumer checks. This milestone does
  not migrate Worker routes or authorize deployment: the imported hand-authored
  protocol and public GraphQL/Pothos/Yoga/`graphql-composer` remain transitional
  and undeployable until their owning replacement work proves coverage.
- E2-07 will make Alchemy.run v2 the sole infrastructure and deployment source
  of truth. Before any preview or production deployment, it must remove or
  disable every imported direct-deploy path: `workers/{vault,gatekeeper-google,
  gadget-host}/wrangler.jsonc`, `workers/vault/wrangler.vault-do-test.jsonc`,
  Worker package `dev`/`deploy` scripts, `workers/vault/scripts/p0-exit-drill.ts`,
  and `workers/gadget-host/scripts/{deploy-morning-brief,facet-isolation-drill,
  capability-transport-drill,morning-brief-live-drill}.ts`. No `wrangler`
  command may deploy a preview or production stage.
- Production changes require a reviewed declarative plan, explicit approval,
  post-deploy verification, and a rollback path. This repository does not
  authorize a production deployment by itself.

## Mandatory v2 identity and device contract

E2-03 must implement Cloudflare Access Managed OAuth Authorization Code with
S256 PKCE through `ASWebAuthenticationSession`. The production redirect is an
exact HTTPS URL and associated-domain entry generated from the machine-readable
deployment manifest; the repository must not invent or hard-code an owned
host. The deployment plan must machine-validate OAuth discovery, redirect
registration, and all token/session bounds against the provider-supported
ranges before it can apply them. Access tokens are memory-only; any bounded
refresh token is `ThisDeviceOnly`.

The device creates a non-exportable Secure Enclave P-256 key. Registration
signs a server-issued, single-use, expiry-bound challenge; the Worker verifies
the proof, challenge audience, expiry, and replay state before binding the
public key to an application-owned `OwnerId` credential. Email and a raw
Access `sub` are never application identity. The versioned protocol provides
`POST /v2/devices/register` and `POST /v2/devices/{deviceId}/revoke`; the
former requires the proof and the latter durably increments the owner/device
auth epoch.

Every Worker request validates `Cf-Access-Jwt-Assertion` (signature, issuer,
audience, and expiry) and then the app-owned `OwnerId`, device membership,
revocation state, and auth epoch. Revocation terminates active sockets; the
server checks the durable epoch at hello and before every received WebSocket
frame. A v2 `hello` declares supported protocol versions: HTTP returns `426`
when no version overlaps, and WebSocket closes with private code `4426` when
negotiation fails. Native clients and app Workers never mint runtime service
tokens, send `CF-Access-Client-*` headers, or hold Cloudflare API tokens.

The following imported mechanisms are specifically prohibited from deploy
until E2-03 replaces them: `EnchiridionAPI/EmailSearchClient.swift`,
`EnchiridionSync/VaultSyncClient.swift`,
`EnchiridionGadgets/GadgetBridgeTransport.swift`,
`EnchiridionBlobs/BlobCache.swift`,
`EnchiridionUI/{AppBackendConfiguration,AssistantSceneAssembly,
DeviceEnrollmentViews,DeviceSettingsView,PageCanvasEmbedding}.swift`,
`EnchiridionCore/{DeviceAccessCredentialResolution,
DeviceAccessCredentialStore,DeviceEnrollmentPairing}.swift`,
and `workers/vault/src/{access-auth,cloudflare-access-api,enroll-routes}.ts`.

## Deployment safety

E2-07 must give Alchemy.run v2 a separately human-approved `Cloudflare.state`
bootstrap/profile. New resources are stage-qualified and fresh by default;
existing resources require a reviewed per-resource adoption manifest. Durable
Object first adoption, class changes, and transfers use the required two-deploy
rules. Every change is rehearsed in a fully isolated `pr` stage; destroy is
guarded and never targets production. Stage deployments are serialized, and
production additionally requires approval of the exact plan.

Create an expand/contract path and restore point before an irreversible state
change. Production R2 object-lock configuration is an explicitly approved,
irreversible action: do not destroy a locked resource or shorten retention.
The first production deployment is manual.

## Layout

```
projects/enchiridion/
├── apps/swift/  # native iOS and macOS clients
├── workers/     # Cloudflare application services
├── packages/    # typed TypeScript domain and contract packages
└── supertags/   # schema-as-code modules
```

## Local verification

```sh
cd projects/enchiridion
bun run typecheck
bun test
bun run lint
```

Lint is tracked separately while the existing Biome configuration is brought
to the production standard. It is not evidence that a deployment is safe.

## Local synced prototype (macOS)

Run `./scripts/run-local-prototype.sh` to start the real local Vault Worker,
build the macOS app, and launch it with sync enabled. The Worker keeps its
local durable state under `/private/tmp/enchiridion-vault-prototype-state`; it
is never a production deployment. The unsigned development app keeps its
SQLite store at `/private/tmp/enchiridion-local-prototype.sqlite`. Quit the app
to stop the Worker.
