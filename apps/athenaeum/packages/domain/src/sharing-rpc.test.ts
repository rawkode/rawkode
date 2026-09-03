import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Email } from "./auth.js"
import { EntityId, IsoDateTimeString } from "./node.js"
import {
  AddCollaboratorInput,
  AddCollaboratorOutput,
  CreateShareLinkInput,
  CreateShareLinkOutput,
  CreateWorkspaceInput,
  CreateWorkspaceOutput,
  ListCollaboratorsInput,
  ListCollaboratorsOutput,
  ListShareLinksInput,
  ListShareLinksOutput,
  ListWorkspacesInput,
  ListWorkspacesOutput,
  PreviewRemoveCollaboratorInput,
  PreviewRemoveCollaboratorOutput,
  PreviewRevokeShareLinkInput,
  PreviewRevokeShareLinkOutput,
  RedeemShareLinkInput,
  RedeemShareLinkOutput,
  RemoveCollaboratorInput,
  RemoveCollaboratorOutput,
  RevokeShareLinkInput,
  RevokeShareLinkOutput
} from "./sharing-rpc.js"
import {
  AffectedCollaborator,
  CollaboratorInfo,
  ShareKeyHash,
  ShareLink,
  WorkspaceCatalogEntry
} from "./sharing.js"

const roundTrip = <A, I>(schema: Schema.Schema<A, I>, value: A) => {
  const encoded = Schema.encodeSync(schema)(value)
  expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(value)
}

const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const email = (value: string) => Schema.decodeUnknownSync(Email)(value)
const iso = (value: number) => Schema.decodeUnknownSync(IsoDateTimeString)(new Date(value).toISOString())
const hash = Schema.decodeUnknownSync(ShareKeyHash)("a".repeat(64))

describe("multi-workspace catalog RPC schemas", () => {
  it("round-trips CreateWorkspaceInput/Output", () => {
    roundTrip(CreateWorkspaceInput, new CreateWorkspaceInput({ title: "Work" }))
    roundTrip(
      CreateWorkspaceOutput,
      new CreateWorkspaceOutput({
        workspace: new WorkspaceCatalogEntry({
          workspaceId,
          title: "Work",
          ownerId: email("alice@example.com"),
          role: "build",
          isDefault: false
        })
      })
    )
  })

  it("round-trips ListWorkspacesInput/Output (empty input, no callerId — identity comes from CurrentUser)", () => {
    roundTrip(ListWorkspacesInput, new ListWorkspacesInput({}))
    roundTrip(
      ListWorkspacesOutput,
      new ListWorkspacesOutput({
        workspaces: [
          new WorkspaceCatalogEntry({
            workspaceId,
            title: "Personal",
            ownerId: email("alice@example.com"),
            role: "build",
            isDefault: true
          })
        ]
      })
    )
  })
})

describe("collaborator management RPC schemas", () => {
  it("round-trips AddCollaboratorInput/Output", () => {
    roundTrip(
      AddCollaboratorInput,
      new AddCollaboratorInput({
        workspaceId,
        profileId: email("bob@example.com"),
        role: "use",
        note: "for the shared roadmap"
      })
    )
    roundTrip(
      AddCollaboratorOutput,
      new AddCollaboratorOutput({
        collaborator: new CollaboratorInfo({
          profileId: email("bob@example.com"),
          workspaceId,
          edges: [],
          role: "use"
        })
      })
    )
  })

  it("round-trips RemoveCollaboratorInput/Output with keepUsers", () => {
    roundTrip(
      RemoveCollaboratorInput,
      new RemoveCollaboratorInput({
        workspaceId,
        profileId: email("bob@example.com"),
        keepUsers: [email("carol@example.com")]
      })
    )
    roundTrip(
      RemoveCollaboratorOutput,
      new RemoveCollaboratorOutput({
        affected: [
          new AffectedCollaborator({
            profileId: email("bob@example.com"),
            workspaceId,
            edges: [],
            oldRole: "build",
            newRole: null
          })
        ]
      })
    )
  })

  it("round-trips RemoveCollaboratorInput without keepUsers (optional field)", () => {
    const encoded = Schema.encodeSync(RemoveCollaboratorInput)(
      new RemoveCollaboratorInput({ workspaceId, profileId: email("bob@example.com") })
    )
    expect("keepUsers" in encoded).toBe(false)
  })

  it("round-trips PreviewRemoveCollaboratorInput/Output", () => {
    roundTrip(
      PreviewRemoveCollaboratorInput,
      new PreviewRemoveCollaboratorInput({ workspaceId, profileId: email("bob@example.com") })
    )
    roundTrip(PreviewRemoveCollaboratorOutput, new PreviewRemoveCollaboratorOutput({ affected: [] }))
  })

  it("round-trips ListCollaboratorsInput/Output", () => {
    roundTrip(ListCollaboratorsInput, new ListCollaboratorsInput({ workspaceId }))
    roundTrip(
      ListCollaboratorsOutput,
      new ListCollaboratorsOutput({
        collaborators: [
          new CollaboratorInfo({
            profileId: email("bob@example.com"),
            workspaceId,
            edges: [],
            role: "build"
          })
        ]
      })
    )
  })
})

describe("share link RPC schemas", () => {
  it("round-trips CreateShareLinkInput/Output — the raw key is a plain string, never a domain type", () => {
    roundTrip(CreateShareLinkInput, new CreateShareLinkInput({ workspaceId, role: "use" }))
    const output = new CreateShareLinkOutput({
      key: "deadbeefdeadbeefdeadbeefdeadbeef",
      link: new ShareLink({
        id: hash,
        workspaceId,
        creatorId: email("alice@example.com"),
        role: "use",
        revoked: false,
        createdAt: iso(0)
      })
    })
    roundTrip(CreateShareLinkOutput, output)
    expect(Schema.encodeSync(CreateShareLinkOutput)(output).key).toBe("deadbeefdeadbeefdeadbeefdeadbeef")
  })

  it("round-trips RedeemShareLinkInput/Output", () => {
    roundTrip(RedeemShareLinkInput, new RedeemShareLinkInput({ workspaceId, key: "somerawkey" }))
    roundTrip(
      RedeemShareLinkOutput,
      new RedeemShareLinkOutput({
        collaborator: new CollaboratorInfo({
          profileId: email("carol@example.com"),
          workspaceId,
          edges: [],
          role: "use"
        })
      })
    )
  })

  it("round-trips RevokeShareLinkInput/Output and its preview counterpart", () => {
    roundTrip(RevokeShareLinkInput, new RevokeShareLinkInput({ workspaceId, linkId: hash }))
    roundTrip(RevokeShareLinkOutput, new RevokeShareLinkOutput({ affected: [] }))
    roundTrip(PreviewRevokeShareLinkInput, new PreviewRevokeShareLinkInput({ workspaceId, linkId: hash }))
    roundTrip(PreviewRevokeShareLinkOutput, new PreviewRevokeShareLinkOutput({ affected: [] }))
  })

  it("round-trips ListShareLinksInput/Output", () => {
    roundTrip(ListShareLinksInput, new ListShareLinksInput({ workspaceId }))
    roundTrip(
      ListShareLinksOutput,
      new ListShareLinksOutput({
        shareLinks: [
          new ShareLink({
            id: hash,
            workspaceId,
            creatorId: email("alice@example.com"),
            role: "build",
            revoked: false,
            createdAt: iso(0)
          })
        ]
      })
    )
  })
})
