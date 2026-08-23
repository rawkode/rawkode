import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  AddEdgeToolInput,
  AddEdgeToolOutput,
  AddFactToolInput,
  AddFactToolOutput,
  ApplySupertagToolFieldValue,
  ApplySupertagToolInput,
  ApplySupertagToolOutput,
  CreateAppToolInput,
  CreateAppToolOutput,
  CreateNodeToolInput,
  CreateNodeToolOutput,
  DefineSupertagToolInput,
  DefineSupertagToolOutput,
  EditNoteToolInput,
  EditNoteToolOutput,
  LinkCalendarEventToolInput,
  LinkCalendarEventToolOutput,
  ReadNoteToolInput,
  ReadNoteToolOutput,
  UpdateAppCodeToolInput,
  UpdateAppCodeToolOutput
} from "./agent-tools.js"
import { AppIcon } from "./app.js"
import { ChatBindingName } from "./chat-binding.js"
import { EntityId } from "./node.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const validUuid2 = "3fa85f64-5717-4562-b3fc-2c963f66afa7"
const validUuid3 = "3fa85f64-5717-4562-b3fc-2c963f66afa8"

const roundTrip = <A, I>(schema: Schema.Schema<A, I>, value: A) => {
  const encoded = Schema.encodeSync(schema)(value)
  expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(value)
}

describe("agent tool schemas", () => {
  it("round-trips ReadNoteToolInput/Output", () => {
    roundTrip(
      ReadNoteToolInput,
      new ReadNoteToolInput({ chatId: EntityId.make(validUuid), binding: ChatBindingName.make("MY_NOTE") })
    )
    roundTrip(ReadNoteToolOutput, new ReadNoteToolOutput({ text: "hello" }))
  })

  it("round-trips EditNoteToolInput/Output", () => {
    roundTrip(
      EditNoteToolInput,
      new EditNoteToolInput({
        chatId: EntityId.make(validUuid),
        binding: ChatBindingName.make("MY_NOTE"),
        index: 0,
        deleteCount: 0,
        insertText: "hi"
      })
    )
    roundTrip(EditNoteToolOutput, new EditNoteToolOutput({ text: "hi", nodeId: EntityId.make(validUuid2) }))
  })

  it("round-trips CreateNodeToolInput/Output", () => {
    roundTrip(
      CreateNodeToolInput,
      new CreateNodeToolInput({
        chatId: EntityId.make(validUuid),
        title: "Roadmap",
        binding: ChatBindingName.make("ROADMAP")
      })
    )
    roundTrip(
      CreateNodeToolOutput,
      new CreateNodeToolOutput({ binding: ChatBindingName.make("ROADMAP"), nodeId: EntityId.make(validUuid2) })
    )
  })

  it("round-trips AddFactToolInput/Output", () => {
    roundTrip(
      AddFactToolInput,
      new AddFactToolInput({
        chatId: EntityId.make(validUuid),
        binding: ChatBindingName.make("ROADMAP"),
        predicateId: "status",
        value: "in-progress"
      })
    )
    roundTrip(AddFactToolOutput, new AddFactToolOutput({ factId: EntityId.make(validUuid2) }))
  })

  it("round-trips AddEdgeToolInput/Output", () => {
    roundTrip(
      AddEdgeToolInput,
      new AddEdgeToolInput({
        chatId: EntityId.make(validUuid),
        relationDefinitionId: EntityId.make(validUuid2),
        sourceBinding: ChatBindingName.make("ROADMAP"),
        targetBinding: ChatBindingName.make("OWNER")
      })
    )
    roundTrip(AddEdgeToolOutput, new AddEdgeToolOutput({ edgeId: EntityId.make(validUuid3) }))
  })

  it("round-trips LinkCalendarEventToolInput/Output (schema-only — see agent-tools.ts doc comment: always ToolNotImplemented)", () => {
    roundTrip(
      LinkCalendarEventToolInput,
      new LinkCalendarEventToolInput({
        chatId: EntityId.make(validUuid),
        binding: ChatBindingName.make("KICKOFF"),
        calendarEventId: "evt_123"
      })
    )
    roundTrip(LinkCalendarEventToolOutput, new LinkCalendarEventToolOutput({ linked: false }))
  })

  it("round-trips CreateAppToolInput/Output", () => {
    roundTrip(
      CreateAppToolInput,
      new CreateAppToolInput({
        chatId: EntityId.make(validUuid),
        title: "Counter",
        icon: AppIcon.make("🧮"),
        binding: ChatBindingName.make("COUNTER_APP")
      })
    )
    roundTrip(
      CreateAppToolOutput,
      new CreateAppToolOutput({ binding: ChatBindingName.make("COUNTER_APP"), appId: EntityId.make(validUuid2) })
    )
  })

  it("rejects CreateAppToolInput with an empty title", () => {
    const result = Schema.decodeUnknownEither(CreateAppToolInput)({
      chatId: validUuid,
      title: "",
      icon: "🧮",
      binding: "COUNTER_APP"
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("round-trips UpdateAppCodeToolInput/Output for server code", () => {
    roundTrip(
      UpdateAppCodeToolInput,
      new UpdateAppCodeToolInput({
        chatId: EntityId.make(validUuid),
        binding: ChatBindingName.make("COUNTER_APP"),
        kind: "server",
        code: "export default { async fetch() { return new Response('ok') } }"
      })
    )
    roundTrip(
      UpdateAppCodeToolOutput,
      new UpdateAppCodeToolOutput({ binding: ChatBindingName.make("COUNTER_APP"), version: 1 })
    )
  })

  it("round-trips UpdateAppCodeToolInput/Output for client code", () => {
    roundTrip(
      UpdateAppCodeToolInput,
      new UpdateAppCodeToolInput({
        chatId: EntityId.make(validUuid),
        binding: ChatBindingName.make("COUNTER_APP"),
        kind: "client",
        code: "export default function App() { return null }"
      })
    )
  })

  it("rejects UpdateAppCodeToolOutput with a version of 0", () => {
    const result = Schema.decodeUnknownEither(UpdateAppCodeToolOutput)({
      binding: "COUNTER_APP",
      version: 0
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("round-trips DefineSupertagToolInput/Output", () => {
    roundTrip(
      DefineSupertagToolInput,
      new DefineSupertagToolInput({
        chatId: EntityId.make(validUuid),
        tagId: EntityId.make(validUuid2),
        name: "birthday",
        valueKind: "date",
        sortOrder: 3
      })
    )
    roundTrip(DefineSupertagToolOutput, new DefineSupertagToolOutput({ fieldId: EntityId.make(validUuid3) }))
  })

  it("rejects DefineSupertagToolInput with an empty name", () => {
    const result = Schema.decodeUnknownEither(DefineSupertagToolInput)({
      chatId: validUuid,
      tagId: validUuid2,
      name: "",
      valueKind: "text",
      sortOrder: 0
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("round-trips ApplySupertagToolInput/Output with field values", () => {
    roundTrip(
      ApplySupertagToolInput,
      new ApplySupertagToolInput({
        chatId: EntityId.make(validUuid),
        binding: ChatBindingName.make("NEW_PERSON"),
        tagId: EntityId.make(validUuid2),
        fieldValues: [
          new ApplySupertagToolFieldValue({ fieldId: EntityId.make(validUuid3), value: "Engineer" })
        ]
      })
    )
    roundTrip(
      ApplySupertagToolOutput,
      new ApplySupertagToolOutput({
        tagId: EntityId.make(validUuid2),
        factIds: [EntityId.make(validUuid3)]
      })
    )
  })

  it("round-trips ApplySupertagToolInput without fieldValues", () => {
    roundTrip(
      ApplySupertagToolInput,
      new ApplySupertagToolInput({
        chatId: EntityId.make(validUuid),
        binding: ChatBindingName.make("NEW_PERSON"),
        tagId: EntityId.make(validUuid2)
      })
    )
  })

  it("round-trips ApplySupertagToolOutput with an empty factIds array", () => {
    roundTrip(ApplySupertagToolOutput, new ApplySupertagToolOutput({ tagId: EntityId.make(validUuid2), factIds: [] }))
  })
})
