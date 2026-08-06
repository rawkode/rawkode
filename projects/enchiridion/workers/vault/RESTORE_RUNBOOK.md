# Vault recovery target procedure

This is the required production procedure, not a runnable runbook today.
E2-03 must implement the protocol and recovery data model; E2-07 must provide
the Alchemy.run v2 deployment controls. Until both are complete, no imported
backup function, Wrangler configuration, or direct script may restore or
deploy a stage.

## Preconditions

1. Select a signed backup manifest from the trusted manifest store by vault,
   generation, creation time, signer identity, and explicit recovery approval.
   Reject unsigned, unknown-signer, duplicate, expired, or rollback-ineligible
   manifests.
2. Verify the manifest signature, schema/protocol compatibility, object list,
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
3. Atomically promote the validated generation through the routing interface.
   Terminate or drain connections that still address the previous generation,
   then require clients to re-hello and negotiate the current auth epoch and
   protocol version.

## Failure handling and recovery

- Before promotion, discard only the failed inactive generation according to
  approved retention policy; keep the active generation untouched.
- After promotion, roll back routing to the prior validated generation if its
  restore point remains eligible. If rollback is unsafe, perform forward
  recovery into another fresh generation from a newly selected verified
  manifest—never patch the active generation in place.
- Preserve manifests, validation evidence, deployment plan, operator approval,
  and audit events for both success and failure. Escalate any signature,
  integrity, schema, authorization, or Bucket Lock discrepancy as a failed
  recovery, not a warning.
