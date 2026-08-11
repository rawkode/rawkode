// @enchiridion/worker-vault — the loaded supertag registry.
//
// Plan §Supertag module contract / §Backend architecture, "GraphQL API":
// vault composes its schema (and, per this task, its projection tables)
// from every LOADED supertag module. As of the Gmail message-bodies/
// attachments follow-up task ("EmailThread.messages"/"emailSearch"
// server-only GraphQL fields), the loaded module set is TWO hardcoded
// modules: `supertags/core` (person/organization/company/event/area/
// project/task/place) and `supertags/email` (`emailThread`) — the latter
// added specifically so `EmailThread` exists as a real Pothos type at all
// for `graphql/composed-schema.ts` to attach `.messages` onto (mirrors
// `workers/gatekeeper-google/src/supertag-registry.ts`, which already
// loads both modules for its own entityReference-relation-resolution
// needs — see that file's header).
//
// TODO(P1+, real module-loading mechanism): once more modules exist
// (`supertags/workouts`, ...), this file's hardcoded
// `LOADED_SUPERTAG_MODULES` array needs to become a real registry-loading
// step — reading which modules a deployed vault has actually loaded
// (plan §Supertag module contract: "Deploy: merge to main -> CI validates
// -> regenerates vault's Pothos schema + Swift -> deploy vault -> VaultDO
// reconciles module projection views on boot"), not a source-level
// constant. Every call site in this worker that needs "the registry"
// imports the singleton below rather than constructing its own, so that
// future change is a one-file edit, not a search-and-replace.
//
// WHOLE-REGISTRY PROJECTIONS, COMPUTED ONCE: `tagCatalog`/
// `relationDefinitions` below are `@enchiridion/projection`'s
// `projectTagCatalog()`/`projectRelationDefinitions()` outputs — see that
// package's `index.ts` header: "call once per registry load (module
// deploy/VaultDO boot) ... these describe the schema DAG, not any one
// page's content." Computed eagerly at module-evaluation time (this
// module has no I/O — `SupertagRegistry.build()` and the two projector
// calls are pure, synchronous functions over the statically-imported
// `supertags/core` module), so every VaultDO instance in this isolate
// shares the identical, already-computed registry/catalog rather than
// recomputing it per request or per DO boot.

import { SupertagRegistry } from "@enchiridion/schema";
import {
  projectRelationDefinitions,
  projectTagCatalog,
  type GraphRelationDefinitionRow,
  type TagCatalogProjection,
} from "@enchiridion/projection";
import coreSupertagsModule from "@enchiridion/supertags-core";
import emailSupertagsModule from "@enchiridion/supertags-email";

/** Every supertag module this worker instance has loaded — see this file's
 *  header TODO for why this is a hardcoded array, not a real loader, as of
 *  this pass. */
export const LOADED_SUPERTAG_MODULES = [coreSupertagsModule, emailSupertagsModule] as const;

/** The one shared, validated registry over every loaded module — built
 *  once per isolate. `SupertagRegistry.build()` throws
 *  `SupertagRegistryError` on a namespace violation/collision/cyclic
 *  inheritance; since `LOADED_SUPERTAG_MODULES` is a fixed, already-tested
 *  module (`supertags/core`'s own `index.test.ts` exercises it directly),
 *  that only fires on a genuine authoring bug in this repo, which should
 *  fail loudly at worker-startup time rather than be caught and hidden. */
export const supertagRegistry: SupertagRegistry = SupertagRegistry.build(LOADED_SUPERTAG_MODULES);

/** Precomputed whole-registry tag catalog (`graph_tags`/
 *  `graph_tag_parents`/`graph_tag_closure`) — passed to
 *  `@enchiridion/projection`'s `projectPage()` per page so the tag-closure
 *  DAG isn't recomputed on every write (see that package's `ProjectPageInput
 *  .tagCatalog` doc comment). */
export const tagCatalog: TagCatalogProjection = projectTagCatalog(supertagRegistry);

/** Precomputed `graph_relation_definitions` rows for the loaded registry. */
export const relationDefinitions: readonly GraphRelationDefinitionRow[] =
  projectRelationDefinitions(supertagRegistry);
