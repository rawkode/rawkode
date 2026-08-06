// @enchiridion/worker-vault — whole-registry projection: the loaded
// `SupertagRegistry`'s schema DAG -> `graph_tags`/`graph_tag_parents`/
// `graph_tag_closure`/`graph_relation_definitions`.
//
// Plan §Backend architecture: "VaultDO reconciles module projection views
// on boot" (port of `reconcileModuleProjections`). This is the P1 slice of
// that: install the CURRENT loaded registry's tag/relation catalog
// wholesale — matching Swift's `rebuildTagClosure`/`saveRelation` running
// once at database install, not per page (see
// `packages/projection/src/index.ts`'s header, "WHOLE-PAGE vs.
// WHOLE-REGISTRY vs. WHOLE-VAULT"). Called once per VaultDO boot
// (`vault-do.ts`'s constructor) — idempotent (DELETE-all + INSERT-fresh),
// so calling it again after a hot-reload/redeploy with a different loaded
// module set (once `supertag-registry.ts`'s TODO for real module loading
// is addressed) just re-syncs these four tables to whatever the new
// registry declares.

import { supertagRegistry, tagCatalog, relationDefinitions } from "./supertag-registry";
import type { SqlExecutor } from "./schema";

/** Replaces `graph_tags`/`graph_tag_parents`/`graph_tag_closure`/
 *  `graph_relation_definitions` wholesale with the current loaded
 *  registry's projection — safe to call on every DO boot (idempotent: the
 *  registry is a source-level constant for this pass, so re-running this
 *  produces byte-identical rows every time). Callers run this inside the
 *  same transaction as anything else DO-boot does (matches every other
 *  reprojection path's "runs in a DO SQLite transaction" convention). */
export function installSupertagRegistryProjection(sql: SqlExecutor): void {
  sql.exec("DELETE FROM graph_tags");
  for (const tag of tagCatalog.tags) {
    sql.exec(
      `INSERT INTO graph_tags (tag_id, name, sort_order, deleted, is_base) VALUES (?, ?, ?, ?, ?)`,
      tag.tagID,
      tag.name,
      tag.sortOrder,
      tag.deleted ? 1 : 0,
      tag.isBase ? 1 : 0,
    );
  }

  sql.exec("DELETE FROM graph_tag_parents");
  for (const row of tagCatalog.tagParents) {
    sql.exec(
      `INSERT INTO graph_tag_parents (tag_id, parent_tag_id) VALUES (?, ?)`,
      row.tagID,
      row.parentTagID,
    );
  }

  sql.exec("DELETE FROM graph_tag_closure");
  for (const row of tagCatalog.tagClosure) {
    sql.exec(
      `INSERT INTO graph_tag_closure (descendant_tag_id, ancestor_tag_id, depth) VALUES (?, ?, ?)`,
      row.descendantTagID,
      row.ancestorTagID,
      row.depth,
    );
  }

  sql.exec("DELETE FROM graph_relation_definitions");
  for (const row of relationDefinitions) {
    sql.exec(
      `INSERT INTO graph_relation_definitions
         (relation_id, forward_name, inverse_name, targets_per_source, sources_per_target, is_system)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.relationID,
      row.forwardName,
      row.inverseName,
      row.targetsPerSource,
      row.sourcesPerTarget,
      row.isSystem ? 1 : 0,
    );
  }
}

export { supertagRegistry };
