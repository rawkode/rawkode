# Vault recovery target procedure

This is the required production procedure, not a runnable production command.
P03-05 supplies immutable, signed v2 archive/recovery contracts and the
restartable promotion state machine. P03-06 supplies only the concrete durable
source/target callbacks and routing storage. Until those providers are
composed, no direct script may restore or deploy a stage.

## Required v2 recovery artifacts

- Archive objects use immutable `putIfAbsent` records only at
  `v1/vaults/<owner>/<vault>/<generation>/backups/<backupID>/objects/<kind>/<sourceID>`.
  A collision is accepted only when its exact bytes match; it is never an
  overwrite.
- The final `manifest.json` is written only after every listed object exists
  and has an exact bounded SHA-256/size. Its canonical bytes are signed by the
  current P-256 backup-manifest key; verification accepts only configured
  current/prior keys and rejects revoked, tampered, or high-S signatures.
- Record the canonical backup ID, source generation, manifest key ID,
  signature verification result, object count/digests, operator approval, and
  target inactive generation in the recovery audit record. Do not use R2
  prefix listing as backup authority.
- The atomic snapshot records one high-water mark plus routing, control,
  credential, and generation epochs. Its signed catalog digest must contain
  blob, device, document, receipt, session, and tombstone classes; an omitted
  or duplicate inventory member invalidates the backup.

## Preconditions

1. Select one immutable signed backup manifest by its exact owner/vault/source
   generation/backup ID, then verify it by vault,
   generation, creation time, signer identity, and explicit recovery approval.
   Reject unsigned, unknown-signer, duplicate, expired, or rollback-ineligible
   manifests.
2. Verify the byte-for-byte canonical manifest serialization, signature,
   schema/protocol compatibility, high-water/epoch bindings, object list,
   object sizes, content hashes, and every R2 object's existence and hash.
   Record the verification result immutably; any mismatch stops recovery.
3. Confirm an approved restore point and expand/contract-compatible schema.
   Do not apply destructive schema contraction before the promoted generation
   is validated and the rollback window closes.
4. Before a Bucket Lock change, confirm the resource, prefix, scope, and
   retention policy match the approved Alchemy plan. Bucket Lock prevents
   deletion and overwrite for its retention period; an irreversible retention
   change requires explicit approval before apply. Never destroy a locked
   bucket or shorten retention as part of recovery.

## Restore and validate

1. Allocate a fresh, inactive generation; never overwrite the active
   generation. Restore documents, tombstones, schema state, blobs, catalog,
   membership/revocation/auth-epoch state, and manifest metadata into it.
2. Run read-only validation against the fresh generation: recheck hashes and
   object count, CRDT/projection integrity, schema expansion compatibility,
   authorization isolation, and protocol-visible semantic digests. Any failed
   check leaves it inactive and preserves diagnostics.
3. Persist one promotion run and resume its CAS-fenced states:
   `FREEZE_REQUESTED` (source write fence) → `FROZEN` (snapshot high-water) →
   `RESTORING` → `READY_PRIVATE` (validation digest) → `PROMOTING` →
   `PROMOTED` (or `FAILED` before routing CAS). Source fencing, private-target restore/validation, and routing
   activation are idempotent by run ID. The final callback atomically compares
   the expected active source/routing epoch before activating the target.
4. Terminate or drain connections that still address the previous generation,
   then require clients to re-hello and negotiate the current auth epoch and
   protocol version.

## Failure handling and recovery

- Before routing CAS, a failed run records `FAILED`; discard only the failed
  inactive generation according to approved retention policy and keep the
  active generation untouched.
- After `PROMOTING`, never reverse the source/target pointer in that run. A
  routing callback failure remains forward-only for idempotent retry or
  operator repair. Any later recovery starts a new, fenced run and a fresh
  inactive generation—never patch or reactivate a generation in place.
- Preserve manifests, validation evidence, deployment plan, operator approval,
  and audit events for both success and failure. Escalate any signature,
  integrity, schema, authorization, or Bucket Lock discrepancy as a failed
  recovery, not a warning.
