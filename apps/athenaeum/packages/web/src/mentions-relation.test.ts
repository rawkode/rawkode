/** @vitest-environment happy-dom */

import * as Effect from "effect/Effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CreateRelationDefinitionOutput,
  EntityId,
  RelationDefinition,
  type CreateRelationDefinitionInput
} from "@athenaeum/domain"
import { ensureMentionsRelationDefinition } from "./mentions-relation.js"
import type { WorkspaceRpcClientService } from "./rpc-client.js"

const workspaceId = EntityId.make("00000000-0000-4000-8000-000000000001")
const pendingKey = `athenaeum:pendingMentionsRelationDefinition:${workspaceId}`
const cachedKey = `athenaeum:mentionsRelationDefinitionId:${workspaceId}`

const relationOutput = () => new CreateRelationDefinitionOutput({
  relationDefinition: new RelationDefinition({
    id: EntityId.make("00000000-0000-0000-0000-000000000099"),
    forwardName: "mentions",
    inverseName: "mentioned by",
    sourceTagId: EntityId.make("00000000-0000-0000-0000-000000000007"),
    targetTagId: EntityId.make("00000000-0000-0000-0000-000000000007"),
    cardinality: "many-to-many"
  })
})

describe("ensureMentionsRelationDefinition", () => {
  const values = new Map<string, string>()
  const localStorageMock = {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, value) }
  }

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: localStorageMock })
    localStorageMock.clear()
  })

  afterEach(() => localStorageMock.clear())

  it("persists and reuses the immutable request after an uncertain first response", async () => {
    window.localStorage.clear()
    const requestIds: string[] = []
    let attempts = 0
    const client = {
      createRelationDefinition: (input: CreateRelationDefinitionInput) => {
        requestIds.push(input.requestId)
        attempts += 1
        return attempts === 1
          ? Effect.fail(new Error("response lost") as never)
          : Effect.succeed(relationOutput())
      }
    } as unknown as WorkspaceRpcClientService

    await expect(Effect.runPromise(ensureMentionsRelationDefinition(client, workspaceId))).rejects.toThrow("response lost")
    expect(window.localStorage.getItem(pendingKey)).not.toBeNull()
    const result = await Effect.runPromise(ensureMentionsRelationDefinition(client, workspaceId))

    expect(result).toBe(relationOutput().relationDefinition.id)
    expect(requestIds).toHaveLength(2)
    expect(requestIds[1]).toBe(requestIds[0])
    expect(window.localStorage.getItem(cachedKey)).toBe(result)
    expect(window.localStorage.getItem(pendingKey)).toBeNull()
  })

  it("discards malformed persisted request ids instead of retrying them forever", async () => {
    window.localStorage.clear()
    window.localStorage.setItem(pendingKey, JSON.stringify({
      forwardName: "mentions",
      inverseName: "mentioned by",
      sourceTagId: "00000000-0000-0000-0000-000000000007",
      targetTagId: "00000000-0000-0000-0000-000000000007",
      cardinality: "many-to-many",
      requestId: ""
    }))
    let requestId = ""
    const client = {
      createRelationDefinition: (input: CreateRelationDefinitionInput) => {
        requestId = input.requestId
        return Effect.succeed(relationOutput())
      }
    } as unknown as WorkspaceRpcClientService

    await Effect.runPromise(ensureMentionsRelationDefinition(client, workspaceId))
    expect(requestId).not.toBe("")
  })
})
