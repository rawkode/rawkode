import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"

// Plan §"Storage & domain model": "tags — supertags, multi-parent DAG: {id, name, parentIds[],
// builtin}. Fixed Base Tags (Person, Organization, Company, Event, Place, Area, Project, Task)
// seeded once at workspace creation as immutable `builtin: true` rows — mirrors GraphDataModel.md's
// 'Fixed Base Tags... ship with the application and are not uploaded.'"

export class Tag extends Schema.Class<Tag>("Tag")({
  id: EntityId,
  name: Schema.String.pipe(Schema.minLength(1)),
  parentIds: Schema.Array(EntityId),
  builtin: Schema.Boolean
}) {}

// --- Base Tags ---------------------------------------------------------------------------
//
// Tag-ID scheme decision (plan task item 2 — "decide and document whether IDs are literal
// well-known constants like 'tag-person' or generated, and be consistent"):
//
// `Tag.id` is typed as `EntityId`, which (per node.ts) only accepts a ULID or a UUID — a
// literal slug like `"tag-person"` fails that schema's own validation, so "literal slug
// constants" isn't actually available without weakening `EntityId` for every other entity in
// this package. Fully-random UUIDs would be deterministic-*able* (a UUIDv5 derived from a fixed
// namespace + slug) but that requires a hashing/UUID-library dependency this zero-dependency
// package (see package.json: only `effect`) doesn't have, just to compute eight fixed strings
// once.
//
// The chosen scheme: literal **nil-pattern UUIDs**, `00000000-0000-0000-0000-00000000000N` for
// N = 1..8 in the plan's own listed order (Person, Organization, Company, Event, Place, Area,
// Project, Task). This is deterministic (no computation, no library, identical across every
// workspace by construction), valid against the existing `EntityId` UUID pattern with no schema
// changes, and immediately recognizable as a reserved/builtin value in logs, DB dumps, and test
// fixtures — a real random-looking UUID could not be distinguished from an ordinary row's ID at
// a glance, which matters for a "ship with the application, not uploaded" fixed set. The backend
// seeds these same literal IDs at workspace-creation time (plan: "seeded once at workspace creation");
// nothing is assigned or generated at runtime.
export const BaseTagIds = {
  Person: EntityId.make("00000000-0000-0000-0000-000000000001"),
  Organization: EntityId.make("00000000-0000-0000-0000-000000000002"),
  Company: EntityId.make("00000000-0000-0000-0000-000000000003"),
  Event: EntityId.make("00000000-0000-0000-0000-000000000004"),
  Place: EntityId.make("00000000-0000-0000-0000-000000000005"),
  Area: EntityId.make("00000000-0000-0000-0000-000000000006"),
  Project: EntityId.make("00000000-0000-0000-0000-000000000007"),
  Task: EntityId.make("00000000-0000-0000-0000-000000000008")
} as const

/**
 * The 8 Base Tags, seeded once at workspace creation as immutable `builtin: true` rows (plan
 * §"Storage & domain model"). None have parents — the Base Tags are the roots of the supertag
 * DAG; user-created tags may later declare one or more of these (or each other) as `parentIds`.
 */
export const BASE_TAGS: ReadonlyArray<Tag> = [
  new Tag({ id: BaseTagIds.Person, name: "Person", parentIds: [], builtin: true }),
  new Tag({ id: BaseTagIds.Organization, name: "Organization", parentIds: [], builtin: true }),
  new Tag({ id: BaseTagIds.Company, name: "Company", parentIds: [], builtin: true }),
  new Tag({ id: BaseTagIds.Event, name: "Event", parentIds: [], builtin: true }),
  new Tag({ id: BaseTagIds.Place, name: "Place", parentIds: [], builtin: true }),
  new Tag({ id: BaseTagIds.Area, name: "Area", parentIds: [], builtin: true }),
  new Tag({ id: BaseTagIds.Project, name: "Project", parentIds: [], builtin: true }),
  new Tag({ id: BaseTagIds.Task, name: "Task", parentIds: [], builtin: true })
]
