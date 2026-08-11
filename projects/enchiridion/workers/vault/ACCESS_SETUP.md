# Vault access setup

This imported access path is non-production and forbidden from deployment.
`src/access-auth.ts`, `src/cloudflare-access-api.ts`, and
`src/enroll-routes.ts` are service-token/enrollment transition code, not the
v2 security boundary.

E2-03 must implement Cloudflare Access Managed OAuth Authorization Code with
S256 PKCE through `ASWebAuthenticationSession`. A machine-readable deployment
manifest must generate the exact HTTPS callback and associated-domain entry,
then validate OAuth discovery, redirect registration, and selected token and
session bounds against provider-supported ranges. No host is invented here.
Access tokens remain memory-only; bounded refresh tokens are `ThisDeviceOnly`.

E2-03 must require a non-exportable Secure Enclave P-256 key to sign a
server-issued, single-use, expiry-bound registration challenge. The Worker
must verify the proof and durable replay record, then bind the public key to
an app-owned `OwnerId` credential—never an email or raw Access `sub`. Its
versioned protocol exposes `POST /v2/devices/register` and
`POST /v2/devices/{deviceId}/revoke`.

Every request must validate `Cf-Access-Jwt-Assertion` signature, issuer,
audience, and expiry before enforcing `OwnerId`, device membership, revocation
state, and durable auth epoch. Revocation terminates sockets; the Worker checks
the epoch at protocol hello and before each received WebSocket frame. A
non-overlapping version receives HTTP `426` or WebSocket close `4426`.
Runtime service-token minting, `CF-Access-Client-*` headers, and Cloudflare
API tokens in native clients or app Workers are prohibited.

E2-07 must remove or disable the imported Wrangler configuration and direct
scripts, enforcing Alchemy.run v2 as the only deployment path before any
preview or production stage. Production access changes need reviewed
declarative infrastructure, explicit approval, least-privilege credentials,
verification, and rollback.
