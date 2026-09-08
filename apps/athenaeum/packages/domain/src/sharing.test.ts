import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Email } from "./auth.js"
import { EntityId, IsoDateTimeString } from "./node.js"
import {
  AffectedCollaborator,
  Collaborator,
  CollaboratorInfo,
  PermissionEdge,
  Role,
  ShareKeyHash,
  ShareKeyRecord,
  ShareLink,
  ShareLinkEdge,
  UserEdge,
  WorkspaceCatalogEntry
} from "./sharing.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const otherUuid = "4fa85f64-5717-4562-b3fc-2c963f66afa7"
const email = (value: string) => Schema.decodeUnknownSync(Email)(value)
const iso = (value: number) => Schema.decodeUnknownSync(IsoDateTimeString)(new Date(value).toISOString())
const validHash = "a".repeat(64)
const otherHash = "b".repeat(64)

describe("Role", () => {
  it("accepts build and use", () => {
    expect(Schema.decodeUnknownSync(Role)("build")).toBe("build")
    expect(Schema.decodeUnknownSync(Role)("use")).toBe("use")
  })

  it("rejects any other value (roles are totally ordered build > use, docs/sharing.md)", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(Role)("admin"))).toBe(true)
  })
})

describe("ShareKeyHash", () => {
  it("accepts a 64-character lowercase hex digest", () => {
    expect(Schema.decodeUnknownSync(ShareKeyHash)(validHash)).toBe(validHash)
  })

  it("rejects an uppercase digest", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(ShareKeyHash)(validHash.toUpperCase()))).toBe(true)
  })

  it("rejects a short or non-hex string", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(ShareKeyHash)("deadbeef"))).toBe(true)
    expect(Either.isLeft(Schema.decodeUnknownEither(ShareKeyHash)("z".repeat(64)))).toBe(true)
  })
})

describe("PermissionEdge", () => {
  it("round-trips a UserEdge (docs/sharing.md: 'a specific sharer directly added this collaborator')", () => {
    const edge = new UserEdge({
      type: "user",
      sharerId: email("alice@example.com"),
      role: "build",
      timestamp: iso(0),
      note: "trusted collaborator"
    })
    const encoded = Schema.encodeSync(PermissionEdge)(edge)
    expect(encoded).toEqual({
      type: "user",
      sharerId: "alice@example.com",
      role: "build",
      timestamp: iso(0),
      note: "trusted collaborator"
    })
    expect(Schema.decodeUnknownSync(PermissionEdge)(encoded)).toEqual(edge)
  })

  it("round-trips a UserEdge with no note (optional field)", () => {
    const edge = new UserEdge({
      type: "user",
      sharerId: email("alice@example.com"),
      role: "use",
      timestamp: iso(0)
    })
    const encoded = Schema.encodeSync(PermissionEdge)(edge)
    expect("note" in encoded).toBe(false)
    expect(Schema.decodeUnknownSync(PermissionEdge)(encoded)).toEqual(edge)
  })

  it("round-trips a ShareLinkEdge, whose linkId is a ShareKeyHash not an EntityId", () => {
    const edge = new ShareLinkEdge({
      type: "shareLink",
      linkId: Schema.decodeUnknownSync(ShareKeyHash)(validHash),
      timestamp: iso(0)
    })
    const encoded = Schema.encodeSync(PermissionEdge)(edge)
    expect(encoded).toEqual({ type: "shareLink", linkId: validHash, timestamp: iso(0) })
    expect(Schema.decodeUnknownSync(PermissionEdge)(encoded)).toEqual(edge)
  })

  it("rejects an edge type outside user/shareLink", () => {
    const result = Schema.decodeUnknownEither(PermissionEdge)({
      type: "somethingElse",
      timestamp: iso(0)
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("Collaborator", () => {
  it("round-trips with a mix of user and shareLink edges (docs/sharing.md: 'a collaborator can accumulate multiple edges')", () => {
    const collaborator = new Collaborator({
      profileId: email("bob@example.com"),
      workspaceId: EntityId.make(validUuid),
      edges: [
        new UserEdge({
          type: "user",
          sharerId: email("alice@example.com"),
          role: "build",
          timestamp: iso(0)
        }),
        new ShareLinkEdge({
          type: "shareLink",
          linkId: Schema.decodeUnknownSync(ShareKeyHash)(validHash),
          timestamp: iso(1)
        })
      ]
    })
    const encoded = Schema.encodeSync(Collaborator)(collaborator)
    expect(Schema.decodeUnknownSync(Collaborator)(encoded)).toEqual(collaborator)
  })

  it("carries no role field — effective role is computed live, never persisted", () => {
    const collaborator = new Collaborator({
      profileId: email("bob@example.com"),
      workspaceId: EntityId.make(validUuid),
      edges: []
    })
    expect("role" in collaborator).toBe(false)
  })
})

describe("CollaboratorInfo", () => {
  it("round-trips including the live-computed role", () => {
    const info = new CollaboratorInfo({
      profileId: email("bob@example.com"),
      workspaceId: EntityId.make(validUuid),
      edges: [],
      role: "use"
    })
    const encoded = Schema.encodeSync(CollaboratorInfo)(info)
    expect(encoded.role).toBe("use")
    expect(Schema.decodeUnknownSync(CollaboratorInfo)(encoded)).toEqual(info)
  })
})

describe("ShareLink", () => {
  it("round-trips, with id equal to the first key's hash (docs/sharing.md: 'a link is its first key')", () => {
    const link = new ShareLink({
      id: Schema.decodeUnknownSync(ShareKeyHash)(validHash),
      workspaceId: EntityId.make(validUuid),
      creatorId: email("alice@example.com"),
      role: "build",
      revoked: false,
      createdAt: iso(0)
    })
    const encoded = Schema.encodeSync(ShareLink)(link)
    expect(encoded.id).toBe(validHash)
    expect(Schema.decodeUnknownSync(ShareLink)(encoded)).toEqual(link)
  })

  it("round-trips a revoked link (docs/sharing.md §Lazy revocation: soft-revoked, not deleted)", () => {
    const link = new ShareLink({
      id: Schema.decodeUnknownSync(ShareKeyHash)(validHash),
      workspaceId: EntityId.make(validUuid),
      creatorId: email("alice@example.com"),
      role: "use",
      revoked: true,
      createdAt: iso(0)
    })
    expect(Schema.decodeUnknownSync(ShareLink)(Schema.encodeSync(ShareLink)(link)).revoked).toBe(true)
  })
})

describe("ShareKeyRecord", () => {
  it("round-trips a link's own first key (alias: false, hash === linkId)", () => {
    const hash = Schema.decodeUnknownSync(ShareKeyHash)(validHash)
    const record = new ShareKeyRecord({ hash, linkId: hash, alias: false })
    const encoded = Schema.encodeSync(ShareKeyRecord)(record)
    expect(encoded).toEqual({ hash: validHash, linkId: validHash, alias: false })
    expect(Schema.decodeUnknownSync(ShareKeyRecord)(encoded)).toEqual(record)
  })

  it("round-trips a copy/alias key pointing back at the link's hash", () => {
    const record = new ShareKeyRecord({
      hash: Schema.decodeUnknownSync(ShareKeyHash)(otherHash),
      linkId: Schema.decodeUnknownSync(ShareKeyHash)(validHash),
      alias: true
    })
    const encoded = Schema.encodeSync(ShareKeyRecord)(record)
    expect(encoded).toEqual({ hash: otherHash, linkId: validHash, alias: true })
    expect(Schema.decodeUnknownSync(ShareKeyRecord)(encoded)).toEqual(record)
  })
})

describe("AffectedCollaborator", () => {
  it("round-trips a downgrade (newRole lower than oldRole, not null)", () => {
    const affected = new AffectedCollaborator({
      profileId: email("carol@example.com"),
      workspaceId: EntityId.make(validUuid),
      edges: [],
      oldRole: "build",
      newRole: "use"
    })
    expect(Schema.decodeUnknownSync(AffectedCollaborator)(Schema.encodeSync(AffectedCollaborator)(affected)))
      .toEqual(affected)
  })

  it("round-trips full removal (newRole === null, docs/sharing.md's exact convention)", () => {
    const affected = new AffectedCollaborator({
      profileId: email("carol@example.com"),
      workspaceId: EntityId.make(validUuid),
      edges: [],
      oldRole: "build",
      newRole: null
    })
    const encoded = Schema.encodeSync(AffectedCollaborator)(affected)
    expect(encoded.newRole).toBeNull()
    expect(Schema.decodeUnknownSync(AffectedCollaborator)(encoded)).toEqual(affected)
  })
})

describe("WorkspaceCatalogEntry", () => {
  it("round-trips an owned, default (Personal) workspace", () => {
    const entry = new WorkspaceCatalogEntry({
      workspaceId: EntityId.make(validUuid),
      title: "Personal",
      ownerId: email("alice@example.com"),
      role: "build",
      isDefault: true
    })
    expect(Schema.decodeUnknownSync(WorkspaceCatalogEntry)(Schema.encodeSync(WorkspaceCatalogEntry)(entry)))
      .toEqual(entry)
  })

  it("round-trips a shared, non-default workspace at use role", () => {
    const entry = new WorkspaceCatalogEntry({
      workspaceId: EntityId.make(otherUuid),
      title: "Bob's Workspace",
      ownerId: email("bob@example.com"),
      role: "use",
      isDefault: false
    })
    expect(Schema.decodeUnknownSync(WorkspaceCatalogEntry)(Schema.encodeSync(WorkspaceCatalogEntry)(entry)))
      .toEqual(entry)
  })

  it("rejects an empty title", () => {
    const result = Schema.decodeUnknownEither(WorkspaceCatalogEntry)({
      workspaceId: validUuid,
      title: "",
      ownerId: "alice@example.com",
      role: "build",
      isDefault: true
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})
