# OwnerVaultDO v2 sync seam

`makeOwnerVaultDO` intentionally has no ambient fallback. P03-06 must inject one
durable `OwnerVaultSyncDependencies` implementation backed by the owner-vault
Durable Object transaction boundary:

- `capabilities` verifies a request-bound OwnerVault capability before upgrade;
- `jti` writes operation-scoped immutable receipts;
- `devices` verifies canonical low-S device signatures and atomically checks
  binding, revocation, auth/credential/generation floors, and the frame nonce;
- `atomicChanges` performs device/floor revalidation, nonce/JTI receipt claim,
  mutation apply, and immutable ACK receipt in one transaction (`devices`,
  `jti`, and `mutations` are the constituent ports it owns); and
- `sessionNonce` and `resumeTokens` use independent CSPRNG output while
  `limits` comes from validated config.

The P03-04 adapter persists the immutable identity plus strict, bounded
session records and per-frame `{frameID, requestHash, result}` receipts through
the runtime DO transaction boundary. A raw continuation token is never stored:
only its SHA-256 digest indexes the current session. Every reconnect receives a
fresh server challenge and must present a fresh capability and device proof; a
successful resume rotates the token atomically. Exact post-restart frame
replays return the stored ACK without invoking the mutation provider, while a
same-frame/different-hash replay conflicts.

The adapter never derives routing authority from a WebSocket frame. Rebind,
revoke, promotion, and their live/hibernating socket fences remain P03-06
operations in the durable provider.
