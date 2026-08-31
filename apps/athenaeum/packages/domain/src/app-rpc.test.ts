import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { App, AppCodeVersion, AppIcon } from "./app.js"
import {
  CreateAppInput,
  CreateAppOutput,
  DeleteAppInput,
  DeleteAppOutput,
  GetAppCodeInput,
  GetAppCodeOutput,
  GetAppInput,
  GetAppOutput,
  ListAppsInput,
  ListAppsOutput,
  MintAppRunCredentialInput,
  MintAppRunCredentialOutput,
  UpdateAppCodeInput,
  UpdateAppCodeOutput
} from "./app-rpc.js"
import { EntityId, IsoDateTimeString } from "./node.js"

const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const appId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const createdAt = IsoDateTimeString.make("2026-08-20T12:00:00.000Z")

const roundTrip = <A, I>(schema: Schema.Schema<A, I>, value: A) => {
  const encoded = Schema.encodeSync(schema)(value)
  expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(value)
}

const app = new App({
  id: appId,
  workspaceId,
  title: "Counter",
  icon: AppIcon.make("🧮"),
  clientCodeVersion: 1,
  serverCodeVersion: 1,
  revision: 1,
  acceptedRevision: 1,
  createdAt,
  updatedAt: createdAt
})

const codeVersion = new AppCodeVersion({
  id: EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa8"),
  appId,
  kind: "server",
  version: 1,
  code: "export default { async fetch() { return new Response('ok') } }",
  createdAt
})

describe("app-rpc wire schemas", () => {
  it("round-trips CreateAppInput without a caller-supplied id", () => {
    roundTrip(CreateAppInput, new CreateAppInput({ workspaceId, title: "Counter", icon: AppIcon.make("🧮") }))
  })

  it("round-trips CreateAppInput with a caller-supplied id", () => {
    roundTrip(
      CreateAppInput,
      new CreateAppInput({ workspaceId, title: "Counter", icon: AppIcon.make("🧮"), id: appId })
    )
  })

  it("rejects CreateAppInput with an empty title", () => {
    const result = Schema.decodeUnknownEither(CreateAppInput)({
      workspaceId,
      title: "",
      icon: "🧮"
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("round-trips CreateAppOutput", () => {
    roundTrip(CreateAppOutput, new CreateAppOutput({ app }))
  })

  it("round-trips UpdateAppCodeInput", () => {
    roundTrip(
      UpdateAppCodeInput,
      new UpdateAppCodeInput({ workspaceId, appId, kind: "server", code: "export default {}" })
    )
  })

  it("round-trips UpdateAppCodeOutput", () => {
    roundTrip(UpdateAppCodeOutput, new UpdateAppCodeOutput({ app, codeVersion }))
  })

  it("round-trips ListAppsInput/Output", () => {
    roundTrip(ListAppsInput, new ListAppsInput({ workspaceId }))
    roundTrip(ListAppsOutput, new ListAppsOutput({ apps: [app] }))
  })

  it("round-trips GetAppInput/Output", () => {
    roundTrip(GetAppInput, new GetAppInput({ workspaceId, appId }))
    roundTrip(GetAppOutput, new GetAppOutput({ app }))
  })

  it("round-trips DeleteAppInput/Output", () => {
    roundTrip(DeleteAppInput, new DeleteAppInput({ workspaceId, appId }))
    roundTrip(DeleteAppOutput, new DeleteAppOutput({ deleted: true }))
  })

  it("round-trips GetAppCodeInput without an explicit version (defaults to current pointer)", () => {
    const input = new GetAppCodeInput({ workspaceId, appId, kind: "server" })
    const encoded = Schema.encodeSync(GetAppCodeInput)(input)
    expect("version" in encoded).toBe(false)
    expect(Schema.decodeUnknownSync(GetAppCodeInput)(encoded)).toEqual(input)
  })

  it("round-trips GetAppCodeInput with an explicit version", () => {
    roundTrip(GetAppCodeInput, new GetAppCodeInput({ workspaceId, appId, kind: "client", version: 3 }))
  })

  it("rejects GetAppCodeInput with a version of 0", () => {
    const result = Schema.decodeUnknownEither(GetAppCodeInput)({
      workspaceId,
      appId,
      kind: "client",
      version: 0
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("round-trips GetAppCodeOutput", () => {
    roundTrip(GetAppCodeOutput, new GetAppCodeOutput({ codeVersion }))
  })

  it("round-trips MintAppRunCredentialInput/Output", () => {
    roundTrip(MintAppRunCredentialInput, new MintAppRunCredentialInput({ workspaceId, appId }))
    roundTrip(
      MintAppRunCredentialOutput,
      new MintAppRunCredentialOutput({ credential: "abc.def", expiresAt: createdAt })
    )
  })
})
