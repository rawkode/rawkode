# Device enrollment

The imported pairing and service-token enrollment flow is transitional,
non-production, and forbidden from deployment. This includes
`EnchiridionCore/DeviceAccessCredentialStore.swift`,
`EnchiridionCore/DeviceEnrollmentPairing.swift`,
`EnchiridionUI/DeviceEnrollmentViews.swift`,
`EnchiridionUI/DeviceSettingsView.swift`, and `src/enroll-routes.ts`.

E2-03 must replace it with a versioned protocol. After Access Managed OAuth
Authorization Code with S256 PKCE, the device signs a server-issued,
single-use, expiry-bound challenge using a non-exportable Secure Enclave
P-256 key. `POST /v2/devices/register` verifies that proof and a durable replay
record, then binds the public key to an app-owned `OwnerId` and device record;
email and raw Access `sub` are never application identity.

`POST /v2/devices/{deviceId}/revoke` must durably advance the auth epoch and
terminate that device's active sockets. Workers validate
`Cf-Access-Jwt-Assertion`, membership, revocation, and epoch at hello and
before every received WebSocket frame. Native clients may not mint service
tokens, send `CF-Access-Client-*` headers, or hold Cloudflare API tokens;
access tokens are memory-only and bounded refresh tokens are `ThisDeviceOnly`.

The deployment manifest generates the exact HTTPS callback and
associated-domain entry and validates provider-supported token/session bounds.
E2-07 enforces Alchemy.run v2-only deployment after removing or disabling all
Wrangler/direct-deploy paths.
