import { LoroList, LoroMap, LoroText } from "loro-crdt/bundler"
import * as Effect from "effect/Effect"
import { ValidationError } from "@athenaeum/domain"

/**
 * Backend-owned contract for the Loro v1 representation consumed by the web editor.
 *
 * The official loro-prosemirror binding represents each non-text ProseMirror node as a LoroMap
 * with `nodeName`, `attributes`, and `children`; text and marks live in LoroText deltas. This
 * contract mirrors the web editor's supported ProseMirror schema without importing its React
 * bundle. `unknownBlock`, `unknownLeaf`, and `unknownMark` are deliberately retained because the
 * vendored SchemaAdapter installs those forward-compatibility entries in the actual editor schema.
 */

type BlockNodeName =
  | "paragraph"
  | "unknownBlock"
  | "heading"
  | "blockquote"
  | "horizontal_rule"
  | "code_block"
  | "ordered_list"
  | "bullet_list"
  | "task_list"

type NodeName = "doc" | BlockNodeName | "list_item" | "task_item" | "unknownLeaf"

const blockNodeNames = new Set<BlockNodeName>([
  "paragraph", "unknownBlock", "heading", "blockquote", "horizontal_rule", "code_block",
  "ordered_list", "bullet_list", "task_list"
])

const allNodeNames = new Set<NodeName>([
  "doc", ...blockNodeNames, "list_item", "task_item", "unknownLeaf"
])

const fail = (path: string, message: string): Effect.Effect<never, ValidationError> =>
  Effect.fail(new ValidationError({ message: `Loro ProseMirror v1 ${path} ${message}` }))

const childrenOf = (node: LoroMap, path: string): Effect.Effect<LoroList, ValidationError> => {
  const children = node.get("children")
  return children instanceof LoroList
    ? Effect.succeed(children)
    : fail(path, "has no children list")
}

const attributesOf = (node: LoroMap, path: string): Effect.Effect<LoroMap, ValidationError> => {
  const attributes = node.get("attributes")
  return attributes instanceof LoroMap
    ? Effect.succeed(attributes)
    : fail(path, "has no attributes map")
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)

/** The official binding writes ordinary attrs as scalar Loro values. Its compatibility attrs can
 * contain nested JSON objects, which Loro materializes as maps/lists, so unwrap only those values
 * before applying their deliberately narrow schemas. */
const materializeAttributeValue = (value: unknown): unknown => {
  if (value instanceof LoroMap) {
    return Object.fromEntries([...value.keys()].map((key) => [key, materializeAttributeValue(value.get(key))]))
  }
  if (value instanceof LoroList) {
    return Array.from({ length: value.length }, (_, index) => materializeAttributeValue(value.get(index)))
  }
  return value
}

const attributeValue = (attributes: LoroMap, key: string): unknown =>
  materializeAttributeValue(attributes.get(key))

const isJsonValue = (value: unknown): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}

/** `unknownBlock` is the SchemaAdapter's stored Automerge block-marker payload. ImmutableString
 * instances arrive as either a string-like scalar or their `{ val: string }` materialization. */
const isCompatibilityBlockType = (value: unknown): boolean =>
  typeof value === "string" ||
  (isRecord(value) && Object.keys(value).every((key) => key === "val") && typeof value.val === "string")

const isCompatibilityBlockMarker = (value: unknown): boolean => {
  if (!isRecord(value) || !Object.keys(value).every((key) => ["type", "parents", "attrs", "isEmbed"].includes(key))) {
    return false
  }
  return isCompatibilityBlockType(value.type) &&
    Array.isArray(value.parents) && value.parents.every(isCompatibilityBlockType) &&
    isRecord(value.attrs) && Object.values(value.attrs).every(isJsonValue) &&
    (value.isEmbed === undefined || typeof value.isEmbed === "boolean")
}

const validateKnownAttributeKeys = (
  attributes: LoroMap,
  allowed: ReadonlySet<string>,
  path: string
): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    for (const key of Object.keys(attributes.getShallowValue())) {
      if (!allowed.has(key)) return yield* fail(path, `has unsupported attribute ${key}`)
      if (attributes.get(key) instanceof LoroText) return yield* fail(path, `attribute ${key} must not be text`)
    }
  })

const validateNodeAttributes = (
  nodeName: NodeName,
  attributes: LoroMap,
  path: string
): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    const allowed = new Set(["isAmgBlock", "unknownAttrs"])
    if (nodeName === "heading") allowed.add("level")
    if (nodeName === "ordered_list") allowed.add("order")
    if (nodeName === "task_item") allowed.add("checked")
    if (nodeName === "unknownBlock") {
      allowed.add("unknownParentBlock")
      allowed.add("unknownBlock")
    }
    if (nodeName === "unknownLeaf") allowed.add("unknownBlock")
    yield* validateKnownAttributeKeys(attributes, allowed, path)

    const isAmgBlock = attributeValue(attributes, "isAmgBlock")
    if (isAmgBlock !== undefined && typeof isAmgBlock !== "boolean") {
      return yield* fail(path, "isAmgBlock must be a boolean")
    }
    const unknownAttrs = attributeValue(attributes, "unknownAttrs")
    if (unknownAttrs !== undefined && unknownAttrs !== null &&
      (!isRecord(unknownAttrs) || !Object.values(unknownAttrs).every(isJsonValue))) {
      return yield* fail(path, "unknownAttrs must be a JSON-compatible record or null")
    }

    if (nodeName === "heading") {
      const level = attributeValue(attributes, "level")
      if (level !== undefined && (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 3)) {
        return yield* fail(path, "heading level must be an integer from 1 through 3")
      }
    }
    if (nodeName === "ordered_list") {
      const order = attributeValue(attributes, "order")
      if (order !== undefined && (typeof order !== "number" || !Number.isInteger(order) || order < 1)) {
        return yield* fail(path, "ordered-list order must be a positive integer")
      }
    }
    if (nodeName === "task_item") {
      const checked = attributeValue(attributes, "checked")
      if (checked !== undefined && typeof checked !== "boolean") {
        return yield* fail(path, "task-item checked must be a boolean")
      }
    }
    if (nodeName === "unknownBlock") {
      const unknownParentBlock = attributeValue(attributes, "unknownParentBlock")
      if (unknownParentBlock !== undefined && unknownParentBlock !== null && typeof unknownParentBlock !== "string") {
        return yield* fail(path, "unknownParentBlock must be a string or null")
      }
    }
    if (nodeName === "unknownBlock" || nodeName === "unknownLeaf") {
      const unknownBlock = attributeValue(attributes, "unknownBlock")
      if (unknownBlock !== undefined && unknownBlock !== null &&
        !isCompatibilityBlockMarker(unknownBlock)) {
        return yield* fail(path, "unknownBlock must be a compatible block marker or null")
      }
    }
  })

const validateMarkAttributes = (
  markName: string,
  value: unknown,
  path: string
): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    if (!isRecord(value)) return yield* fail(path, `mark ${markName} attributes must be an object`)
    const keys = Object.keys(value)
    const allowOnly = (...allowed: string[]): boolean => keys.every((key) => allowed.includes(key))
    switch (markName) {
      case "em":
      case "strong":
      case "code":
      case "strike":
        if (keys.length !== 0) return yield* fail(path, `mark ${markName} has unsupported attributes`)
        return
      case "link":
        if (!allowOnly("href", "title") || typeof value.href !== "string" ||
          (value.title !== undefined && value.title !== null && typeof value.title !== "string")) {
          return yield* fail(path, "link mark requires string href and optional string-or-null title")
        }
        return
      case "entityRef":
        if (!allowOnly("nodeId", "label") || typeof value.nodeId !== "string" ||
          (value.label !== undefined && typeof value.label !== "string")) {
          return yield* fail(path, "entityRef mark requires string nodeId and optional string label")
        }
        return
      case "supertagRef":
        if (!allowOnly("tagId", "label") || typeof value.tagId !== "string" ||
          (value.label !== undefined && typeof value.label !== "string")) {
          return yield* fail(path, "supertagRef mark requires string tagId and optional string label")
        }
        return
      case "unknownMark":
        if (!allowOnly("unknownMarks") ||
          (value.unknownMarks !== undefined && value.unknownMarks !== null && !isRecord(value.unknownMarks)) ||
          (isRecord(value.unknownMarks) && !Object.values(value.unknownMarks).every(isJsonValue))) {
          return yield* fail(path, "unknownMark requires an optional JSON-compatible unknownMarks record")
        }
        return
      default:
        return yield* fail(path, `uses unsupported mark ${markName}`)
    }
  })

const validateText = (text: LoroText, path: string): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    for (const [index, delta] of text.toDelta().entries()) {
      if (typeof delta.insert !== "string") return yield* fail(`${path}[${index}]`, "does not insert text")
      for (const [markName, value] of Object.entries(delta.attributes ?? {})) {
        yield* validateMarkAttributes(markName, value, `${path}[${index}]`)
      }
    }
  })

const nodeNameOf = (node: LoroMap, path: string): Effect.Effect<NodeName, ValidationError> => {
  const nodeName = node.get("nodeName")
  return typeof nodeName === "string" && allNodeNames.has(nodeName as NodeName)
    ? Effect.succeed(nodeName as NodeName)
    : fail(path, `uses unsupported node ${String(nodeName)}`)
}

const validateUnmarkedTextChildren = (children: LoroList, path: string): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    for (let index = 0; index < children.length; index += 1) {
      const child = children.get(index)
      if (!(child instanceof LoroText)) return yield* fail(`${path}.children[${index}]`, "must be text")
      for (const [deltaIndex, delta] of child.toDelta().entries()) {
        if (typeof delta.insert !== "string") {
          return yield* fail(`${path}.children[${index}][${deltaIndex}]`, "does not insert text")
        }
        if (Object.keys(delta.attributes ?? {}).length > 0) {
          return yield* fail(`${path}.children[${index}][${deltaIndex}]`, "code_block text must not have marks")
        }
      }
    }
  })

const validateInlineChildren = (children: LoroList, path: string): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    for (let index = 0; index < children.length; index += 1) {
      const child = children.get(index)
      if (child instanceof LoroText) {
        yield* validateText(child, `${path}.children[${index}]`)
        continue
      }
      if (!(child instanceof LoroMap)) return yield* fail(`${path}.children[${index}]`, "must be inline text")
      const childName = yield* nodeNameOf(child, `${path}.children[${index}]`)
      if (childName !== "unknownLeaf") return yield* fail(`${path}.children[${index}]`, "must be inline text")
      const childAttributes = yield* attributesOf(child, `${path}.children[${index}]`)
      const childChildren = yield* childrenOf(child, `${path}.children[${index}]`)
      yield* validateNodeAttributes(childName, childAttributes, `${path}.children[${index}]`)
      if (childChildren.length !== 0) return yield* fail(`${path}.children[${index}]`, "unknownLeaf must be a leaf")
    }
  })

const validateBlockChildren = (children: LoroList, path: string, required: boolean): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    if (required && children.length === 0) return yield* fail(path, "must contain at least one block")
    for (let index = 0; index < children.length; index += 1) {
      const child = children.get(index)
      if (!(child instanceof LoroMap)) return yield* fail(`${path}.children[${index}]`, "must be a block node")
      const childName = yield* nodeNameOf(child, `${path}.children[${index}]`)
      if (!blockNodeNames.has(childName as BlockNodeName)) {
        return yield* fail(`${path}.children[${index}]`, "must be a block node")
      }
      yield* validateNode(child, `${path}.children[${index}]`)
    }
  })

const validateListChildren = (
  children: LoroList,
  path: string,
  itemName: "list_item" | "task_item"
): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    if (children.length === 0) return yield* fail(path, `must contain at least one ${itemName}`)
    for (let index = 0; index < children.length; index += 1) {
      const child = children.get(index)
      if (!(child instanceof LoroMap) || child.get("nodeName") !== itemName) {
        return yield* fail(`${path}.children[${index}]`, `must be a ${itemName}`)
      }
      yield* validateNode(child, `${path}.children[${index}]`)
    }
  })

const validateListItemChildren = (children: LoroList, path: string): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    const first = children.get(0)
    if (!(first instanceof LoroMap) || first.get("nodeName") !== "paragraph") {
      return yield* fail(path, "must begin with a paragraph")
    }
    yield* validateNode(first, `${path}.children[0]`)
    for (let index = 1; index < children.length; index += 1) {
      const child = children.get(index)
      if (!(child instanceof LoroMap)) return yield* fail(`${path}.children[${index}]`, "must be a block node")
      const childName = yield* nodeNameOf(child, `${path}.children[${index}]`)
      if (!blockNodeNames.has(childName as BlockNodeName)) {
        return yield* fail(`${path}.children[${index}]`, "must be a block node")
      }
      yield* validateNode(child, `${path}.children[${index}]`)
    }
  })

const validateNode = (node: LoroMap, path: string): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    const nodeName = yield* nodeNameOf(node, path)
    const attributes = yield* attributesOf(node, path)
    const children = yield* childrenOf(node, path)
    yield* validateNodeAttributes(nodeName, attributes, path)
    switch (nodeName) {
      case "doc":
      case "blockquote":
      case "unknownBlock":
        return yield* validateBlockChildren(children, path, true)
      case "paragraph":
      case "heading":
        return yield* validateInlineChildren(children, path)
      case "horizontal_rule":
      case "unknownLeaf":
        return children.length === 0 ? undefined : yield* fail(path, `${nodeName} must be a leaf`)
      case "code_block":
        return yield* validateUnmarkedTextChildren(children, path)
      case "ordered_list":
      case "bullet_list":
        return yield* validateListChildren(children, path, "list_item")
      case "task_list":
        return yield* validateListChildren(children, path, "task_item")
      case "list_item":
      case "task_item":
        return yield* validateListItemChildren(children, path)
    }
  })

export const validateLoroProseMirrorV1Tree = (root: LoroMap): Effect.Effect<void, ValidationError> =>
  Effect.gen(function* () {
    if (root.get("nodeName") !== "doc") return yield* fail("root", "must be a doc node")
    yield* validateNode(root, "root")
  })
