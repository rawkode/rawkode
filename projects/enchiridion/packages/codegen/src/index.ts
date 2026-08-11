// @enchiridion/codegen — supertag manifests -> Swift (EnchiridionSchema).
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md,
// plan §Monorepo layout: "codegen/ — manifests -> EnchiridionSchema
// (Swift) + client types", and plan §Supertag module contract: "The
// generated EnchiridionSchema (tag/field constants, typed accessors,
// response types) is a compile-time convenience layered on top [of the
// runtime /schema/manifest.json], not a prerequisite."
//
// REVISED TWICE before this: an earlier pass gave this package a second
// job (rawkode.academy-style federation SDL composition), reverted after
// adversarial review (plan §"Deferred: real federation") — there is no
// gateway and no supergraph build step for P0-P3. This package's scope is
// ONE job: Swift codegen from supertag manifests.
//
// ARCHITECTURAL NOTE — why generated accessors wrap `PageObjectMetadata`,
// not `PageDocument` directly: `apps/swift/Package.swift` declares
// `EnchiridionSchema` as depending on `EnchiridionCore` ONLY —
// `PageDocument` (the type that actually knows how to read/write a page's
// Loro CRDT doc, per `PageDocument.setProperty`) lives in
// `EnchiridionSync`, which `EnchiridionSchema` does not (and, per that
// target's own header comment on the reverse dependency being circular,
// structurally cannot) depend on. `PageObjectMetadata`/`SupertagPropertyKey`/
// `SupertagValue` (what `PageDocument.projection(of:)` actually produces
// and `PageDocument.setProperty` actually consumes) DO live in
// `EnchiridionCore` (`PageModels.swift`), so every generated `<Tag>Fields`
// accessor struct below wraps `PageObjectMetadata` instead: reads are real
// Swift-native `get`s over live data, writes stage into an in-memory
// `PageObjectMetadata.properties` dictionary that a caller in a module
// that CAN see both `EnchiridionSchema` and `EnchiridionSync` (i.e.
// `EnchiridionUI`, which depends on both) then persists via
// `PageDocument.setProperty`/`setProperties`. This is a reasonable
// architectural fit, not a workaround — see each generated `<Tag>Fields`
// struct's doc comment. Flagging here per this task's brief ("if the
// generated code needs something these don't expose, report it rather
// than modifying completed sibling work"): if a future task wants
// `EnchiridionSchema` extensions directly on `PageDocument` itself, that
// requires either moving `PageDocument` into `EnchiridionCore` or adding
// an `EnchiridionSchema -> EnchiridionSync` package dependency edge —
// both are `Package.swift`/sibling-module changes out of this task's
// scope, not something `packages/codegen`'s output can route around.

import { SupertagRegistry } from "@enchiridion/schema";
import type {
  QualifiedSupertagDefinition,
  SupertagFieldDefinition,
  SupertagFieldType,
  SupertagModule,
} from "@enchiridion/schema";

export interface GeneratedSwiftSchema {
  /** Relative path under apps/swift/Sources/EnchiridionSchema this file
   *  should be written to, e.g. "Generated/CoreSupertags.swift". */
  path: string;
  contents: string;
}

// ---------------------------------------------------------------------------
// Swift identifier helpers
// ---------------------------------------------------------------------------

/** Non-exhaustive but covers every keyword that could plausibly collide
 *  with a field/option identifier or PascalCase type name derived from
 *  supertag/field/option ids. Escaped with backticks when hit. */
const SWIFT_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "associatedtype", "class", "deinit", "enum", "extension", "fileprivate",
  "func", "import", "init", "inout", "internal", "let", "open", "operator",
  "private", "protocol", "public", "rethrows", "static", "struct",
  "subscript", "typealias", "var", "break", "case", "continue", "default",
  "defer", "do", "else", "fallthrough", "for", "guard", "if", "in",
  "repeat", "return", "switch", "where", "while", "as", "Any", "catch",
  "false", "is", "nil", "super", "self", "Self", "throw", "throws", "true",
  "try", "associativity", "convenience", "dynamic", "didSet", "final",
  "get", "infix", "indirect", "lazy", "left", "mutating", "none",
  "nonmutating", "optional", "override", "postfix", "precedence", "prefix",
  "Protocol", "required", "right", "set", "Type", "unowned", "weak",
  "willSet",
]);

function words(raw: string): string[] {
  return raw.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0);
}

function pascalCase(raw: string): string {
  return words(raw)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function camelCase(raw: string): string {
  const pascal = pascalCase(raw);
  return pascal.length === 0 ? pascal : pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function swiftIdentifier(raw: string): string {
  return SWIFT_RESERVED_WORDS.has(raw) ? `\`${raw}\`` : raw;
}

function lastSegment(id: string): string {
  const parts = id.split(".");
  return parts[parts.length - 1] ?? id;
}

// ---------------------------------------------------------------------------
// Field-type -> Swift-shape mapping
// ---------------------------------------------------------------------------

/** Suffix used in generated `SupertagFieldStorage.read<Cap>`/`write<Cap>`
 *  function names, and (for `select`) as part of the generated enum's own
 *  type name (`<TagPrefix><FieldPascal>`). */
const FIELD_TYPE_CAP: Record<SupertagFieldType, string> = {
  text: "Text",
  number: "Number",
  boolean: "Boolean",
  date: "Date",
  dateTime: "DateTime",
  select: "Select",
  url: "URL",
  email: "Email",
  phone: "Phone",
  entityReference: "Page",
};

function scalarSwiftType(definition: SupertagFieldDefinition, selectEnumName: string | undefined): string {
  switch (definition.type) {
    case "text":
    case "url":
    case "email":
    case "phone":
      return "String";
    case "number":
      return "Double";
    case "boolean":
      return "Bool";
    case "date":
    case "dateTime":
      return "Date";
    case "entityReference":
      return "PageID";
    case "select": {
      if (!selectEnumName) {
        throw new Error("generateSwiftSchema: select field is missing its generated enum name");
      }
      return selectEnumName;
    }
    default: {
      const exhaustive: never = definition.type;
      throw new Error(`generateSwiftSchema: unhandled SupertagFieldType ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 1: collect per-supertag Swift naming/type metadata
// ---------------------------------------------------------------------------

interface OwnFieldInfo {
  fieldKey: string;
  definition: SupertagFieldDefinition;
  /** Escaped Swift identifier used both as the `SupertagFieldID` constant
   *  name in `<Tag>FieldIDs` and as the generated accessor/response
   *  struct's property name. */
  swiftConstName: string;
  propertyName: string;
  /** Only set for `type: "select"` fields — `<TagPrefix><FieldPascal>`. */
  selectEnumName?: string;
}

interface TagInfo {
  tagID: string;
  moduleID: string;
  modulePrefix: string;
  tagPascal: string;
  swiftTypePrefix: string;
  fieldIDsTypeName: string;
  fieldsTypeName: string;
  responseTypeName: string;
  ownFieldsOrder: string[];
  ownFields: Map<string, OwnFieldInfo>;
  name: string;
  symbol: string;
}

function buildTagInfoByID(registry: SupertagRegistry): Map<string, TagInfo> {
  const tagInfoByID = new Map<string, TagInfo>();
  const usedTypePrefixes = new Set<string>();

  for (const qm of registry.qualifiedModules) {
    const modulePrefix = pascalCase(lastSegment(qm.id));

    for (const supertag of qm.supertags) {
      const tagPascal = pascalCase(lastSegment(supertag.id));
      const swiftTypePrefix = `${modulePrefix}${tagPascal}`;

      if (usedTypePrefixes.has(swiftTypePrefix)) {
        throw new Error(
          `generateSwiftSchema: Swift type name collision "${swiftTypePrefix}" for supertag ` +
            `"${supertag.id}" — rename the supertag or its module to disambiguate.`,
        );
      }
      usedTypePrefixes.add(swiftTypePrefix);

      const ownFields = new Map<string, OwnFieldInfo>();
      const ownFieldsOrder: string[] = [];
      const usedConstNames = new Set<string>();

      for (const [fieldKey, definition] of Object.entries(supertag.fields)) {
        const constName = swiftIdentifier(camelCase(fieldKey));
        if (usedConstNames.has(constName)) {
          throw new Error(
            `generateSwiftSchema: field name collision "${constName}" on supertag "${supertag.id}" — ` +
              `two field ids produce the same Swift identifier.`,
          );
        }
        usedConstNames.add(constName);

        const selectEnumName =
          definition.type === "select" ? `${swiftTypePrefix}${pascalCase(fieldKey)}` : undefined;

        ownFields.set(fieldKey, {
          fieldKey,
          definition,
          swiftConstName: constName,
          propertyName: constName,
          selectEnumName,
        });
        ownFieldsOrder.push(fieldKey);
      }

      tagInfoByID.set(supertag.id, {
        tagID: supertag.id,
        moduleID: qm.id,
        modulePrefix,
        tagPascal,
        swiftTypePrefix,
        fieldIDsTypeName: `${swiftTypePrefix}FieldIDs`,
        fieldsTypeName: `${swiftTypePrefix}Fields`,
        responseTypeName: swiftTypePrefix,
        ownFieldsOrder,
        ownFields,
        name: supertag.name,
        symbol: supertag.symbol,
      });
    }
  }

  return tagInfoByID;
}

interface EffectiveFieldMeta {
  owningTag: TagInfo;
  field: OwnFieldInfo;
}

/** Every effectively-visible field for `tag` (its own fields plus every
 *  ancestor's, per `SupertagRegistry.effectiveFields` — item 5 of this
 *  task: "Company's generated accessors should include both its own
 *  fields and effectively-inherited Organization fields"), each paired
 *  with the `TagInfo` that actually declares it (needed so an inherited
 *  field's accessor references its true owning tag's `FieldIDs` type, not
 *  the inheriting tag's). */
function collectEffectiveFieldMeta(
  tag: TagInfo,
  registry: SupertagRegistry,
  tagInfoByID: Map<string, TagInfo>,
): EffectiveFieldMeta[] {
  const metas: EffectiveFieldMeta[] = [];
  for (const effectiveField of registry.effectiveFields(tag.tagID)) {
    const owningTag = tagInfoByID.get(effectiveField.propertyKey.supertagID);
    if (!owningTag) continue; // Defensive: every declared field's tag was registered in pass 1.
    const field = owningTag.ownFields.get(effectiveField.propertyKey.fieldID);
    if (!field) continue;
    metas.push({ owningTag, field });
  }
  return metas;
}

function fieldSwiftType(field: OwnFieldInfo): { scalarType: string; isArray: boolean; cap: string } {
  const cap = FIELD_TYPE_CAP[field.definition.type];
  const scalarType = scalarSwiftType(field.definition, field.selectEnumName);
  const isArray = Boolean(field.definition.allowsMultiple);
  return { scalarType, isArray, cap };
}

// ---------------------------------------------------------------------------
// Pass 2: Swift source generation
// ---------------------------------------------------------------------------

function generateFieldIDsEnum(tag: TagInfo): string {
  const lines: string[] = [
    `/// Field ID constants \`${tag.tagID}\` (\`${tag.name}\`) declares itself — does NOT include`,
    `/// inherited fields (see \`${tag.fieldsTypeName}\` below for those, which references each`,
    `/// inherited field's own owning-tag \`FieldIDs\` type directly).`,
    `public enum ${tag.fieldIDsTypeName} {`,
    `  public static let supertagID = SupertagID(rawValue: "${tag.tagID}")`,
    ``,
  ];
  for (const fieldKey of tag.ownFieldsOrder) {
    const field = tag.ownFields.get(fieldKey);
    if (!field) continue;
    lines.push(`  public static let ${field.swiftConstName} = SupertagFieldID(rawValue: "${fieldKey}")`);
  }
  lines.push(`}`);
  return lines.join("\n");
}

function generateSelectEnum(tag: TagInfo, field: OwnFieldInfo): string {
  const options = field.definition.options ?? [];
  const enumName = field.selectEnumName;
  if (!enumName) {
    throw new Error(`generateSwiftSchema: select field "${tag.tagID}.${field.fieldKey}" has no enum name`);
  }
  const lines: string[] = [
    `/// Select options for \`${tag.tagID}\`'s \`${field.fieldKey}\` field ` +
      `(\`${field.definition.name ?? field.fieldKey}\`). Case raw values are the field's stored`,
    `/// option ids exactly (slugified: lowercase, spaces -> hyphens — see`,
    `/// packages/schema/src/index.ts's \`f.select()\`), so this round-trips real stored data`,
    `/// unchanged.`,
    `public enum ${enumName}: String, Codable, Hashable, Sendable, CaseIterable {`,
  ];
  const usedCaseNames = new Set<string>();
  for (const option of options) {
    const caseName = swiftIdentifier(camelCase(option.id));
    if (usedCaseNames.has(caseName)) {
      throw new Error(
        `generateSwiftSchema: option id collision "${caseName}" on "${tag.tagID}.${field.fieldKey}" — ` +
          `two option ids produce the same Swift case name.`,
      );
    }
    usedCaseNames.add(caseName);
    lines.push(`  case ${caseName} = "${option.id}"`);
  }
  lines.push(`}`);
  return lines.join("\n");
}

function generateAccessorProperty(owningTag: TagInfo, field: OwnFieldInfo): string[] {
  const { scalarType, isArray, cap } = fieldSwiftType(field);
  const swiftType = isArray ? `[${scalarType}]` : `${scalarType}?`;
  const readFn = `read${cap}${isArray ? "Array" : ""}`;
  const writeFn = `write${cap}${isArray ? "Array" : ""}`;
  const idsType = owningTag.fieldIDsTypeName;

  return [
    `  public var ${field.propertyName}: ${swiftType} {`,
    `    get { SupertagFieldStorage.${readFn}(metadata, ${idsType}.supertagID, ${idsType}.${field.swiftConstName}) }`,
    `    set { SupertagFieldStorage.${writeFn}(&metadata, ${idsType}.supertagID, ${idsType}.${field.swiftConstName}, newValue) }`,
    `  }`,
  ];
}

function generateFieldsStruct(
  tag: TagInfo,
  registry: SupertagRegistry,
  tagInfoByID: Map<string, TagInfo>,
): string {
  const metas = collectEffectiveFieldMeta(tag, registry, tagInfoByID);
  const lines: string[] = [
    `/// Typed get/set accessor over a page's \`PageObjectMetadata\` for \`${tag.tagID}\``,
    `/// (\`${tag.name}\`) — includes ${tag.name}'s own fields plus every effectively-inherited`,
    `/// ancestor field (\`SupertagRegistry.effectiveFields\`).`,
    `///`,
    `/// Wraps \`PageObjectMetadata\`, NOT \`PageDocument\`: \`EnchiridionSchema\` depends only on`,
    `/// \`EnchiridionCore\`, not \`EnchiridionSync\` (where \`PageDocument\`/the CRDT doc actually`,
    `/// lives) — see this file's header for why. Reads here are real, live get accessors;`,
    `/// writes stage into \`metadata.properties\` in memory. A caller that can see both`,
    `/// \`EnchiridionSchema\` and \`EnchiridionSync\` (e.g. \`EnchiridionUI\`) persists a change by`,
    `/// passing \`metadata.properties\` (or the specific keys touched) to`,
    `/// \`PageDocument.setProperty\`/\`setProperties\`.`,
    `public struct ${tag.fieldsTypeName}: Hashable, Sendable {`,
    `  public static let supertagID = ${tag.fieldIDsTypeName}.supertagID`,
    ``,
    `  public var metadata: PageObjectMetadata`,
    ``,
    `  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {`,
    `    self.metadata = metadata`,
    `  }`,
  ];
  for (const { owningTag, field } of metas) {
    lines.push(``, ...generateAccessorProperty(owningTag, field));
  }
  lines.push(`}`);
  return lines.join("\n");
}

function generateDecodeLine(field: OwnFieldInfo): string {
  const { cap, isArray } = fieldSwiftType(field);
  const p = field.propertyName;
  switch (cap) {
    case "Text":
    case "URL":
    case "Email":
    case "Phone":
      return isArray
        ? `    self.${p} = try container.decodeIfPresent([String].self, forKey: .${p}) ?? []`
        : `    self.${p} = try container.decodeIfPresent(String.self, forKey: .${p})`;
    case "Number":
      return isArray
        ? `    self.${p} = try container.decodeIfPresent([Double].self, forKey: .${p}) ?? []`
        : `    self.${p} = try container.decodeIfPresent(Double.self, forKey: .${p})`;
    case "Boolean":
      return isArray
        ? `    self.${p} = try container.decodeIfPresent([Bool].self, forKey: .${p}) ?? []`
        : `    self.${p} = try container.decodeIfPresent(Bool.self, forKey: .${p})`;
    case "Date":
    case "DateTime":
      return isArray
        ? `    self.${p} = (try container.decodeIfPresent([Double].self, forKey: .${p}) ?? []).map { Date(timeIntervalSince1970: $0 / 1000) }`
        : `    self.${p} = (try container.decodeIfPresent(Double.self, forKey: .${p})).map { Date(timeIntervalSince1970: $0 / 1000) }`;
    case "Select": {
      const enumType = scalarSwiftType(field.definition, field.selectEnumName);
      return isArray
        ? `    self.${p} = (try container.decodeIfPresent([String].self, forKey: .${p}) ?? []).compactMap { ${enumType}(rawValue: $0) }`
        : `    self.${p} = (try container.decodeIfPresent(String.self, forKey: .${p})).flatMap { ${enumType}(rawValue: $0) }`;
    }
    case "Page":
      return isArray
        ? `    self.${p} = (try container.decodeIfPresent([String].self, forKey: .${p}) ?? []).map { PageID(rawValue: $0) }`
        : `    self.${p} = (try container.decodeIfPresent(String.self, forKey: .${p})).map { PageID(rawValue: $0) }`;
    default:
      throw new Error(`generateSwiftSchema: unhandled field cap "${cap}" for decode`);
  }
}

function generateEncodeLine(field: OwnFieldInfo): string {
  const { cap, isArray } = fieldSwiftType(field);
  const p = field.propertyName;
  switch (cap) {
    case "Text":
    case "URL":
    case "Email":
    case "Phone":
    case "Number":
    case "Boolean":
      return isArray
        ? `    try container.encode(${p}, forKey: .${p})`
        : `    try container.encodeIfPresent(${p}, forKey: .${p})`;
    case "Date":
    case "DateTime":
      return isArray
        ? `    try container.encode(${p}.map { $0.timeIntervalSince1970 * 1000 }, forKey: .${p})`
        : `    try container.encodeIfPresent(${p}.map { $0.timeIntervalSince1970 * 1000 }, forKey: .${p})`;
    case "Select":
      return isArray
        ? `    try container.encode(${p}.map { $0.rawValue }, forKey: .${p})`
        : `    try container.encodeIfPresent(${p}?.rawValue, forKey: .${p})`;
    case "Page":
      return isArray
        ? `    try container.encode(${p}.map { $0.rawValue }, forKey: .${p})`
        : `    try container.encodeIfPresent(${p}?.rawValue, forKey: .${p})`;
    default:
      throw new Error(`generateSwiftSchema: unhandled field cap "${cap}" for encode`);
  }
}

function generateResponseStruct(
  tag: TagInfo,
  registry: SupertagRegistry,
  tagInfoByID: Map<string, TagInfo>,
): string {
  const metas = collectEffectiveFieldMeta(tag, registry, tagInfoByID);
  const lines: string[] = [
    `/// Typed GraphQL response shape for \`${tag.tagID}\` (\`${tag.name}\`) — \`Codable\`, matching`,
    `/// \`workers/vault/src/graphql/schema.ts\`'s epoch-millisecond \`Float\` timestamp convention:`,
    `/// date/dateTime fields decode from a \`Double\` milliseconds-since-epoch value by hand`,
    `/// below (never via \`JSONDecoder.dateDecodingStrategy\`, which only handles a whole`,
    `/// decoder's uniform strategy, not a per-field wire convention).`,
    `///`,
    `/// Anticipatory: \`graphql-composer\`/vault's real Pothos schema for this supertag is a`,
    `/// concurrently-running P1 task and may not exist yet — field names here are this`,
    `/// generator's own convention (camelCase of each effective field id) and should be`,
    `/// reconciled with the real schema once vault's Pothos types for supertags land.`,
    `public struct ${tag.responseTypeName}: Codable, Hashable, Sendable {`,
    `  public var id: PageID`,
  ];
  for (const { field } of metas) {
    const { scalarType, isArray } = fieldSwiftType(field);
    lines.push(`  public var ${field.propertyName}: ${isArray ? `[${scalarType}]` : `${scalarType}?`}`);
  }

  lines.push(``, `  public init(`, `    id: PageID,`);
  metas.forEach(({ field }, index) => {
    const { scalarType, isArray } = fieldSwiftType(field);
    const defaultValue = isArray ? "[]" : "nil";
    const suffix = index < metas.length - 1 ? "," : "";
    lines.push(`    ${field.propertyName}: ${isArray ? `[${scalarType}]` : `${scalarType}?`} = ${defaultValue}${suffix}`);
  });
  lines.push(`  ) {`, `    self.id = id`);
  for (const { field } of metas) {
    lines.push(`    self.${field.propertyName} = ${field.propertyName}`);
  }
  lines.push(`  }`);

  lines.push(``, `  private enum CodingKeys: String, CodingKey {`, `    case id = "id"`);
  for (const { field } of metas) {
    lines.push(`    case ${field.propertyName} = "${field.propertyName}"`);
  }
  lines.push(`  }`);

  lines.push(
    ``,
    `  public init(from decoder: Decoder) throws {`,
    `    let container = try decoder.container(keyedBy: CodingKeys.self)`,
    `    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))`,
  );
  for (const { field } of metas) {
    lines.push(generateDecodeLine(field));
  }
  lines.push(`  }`);

  lines.push(
    ``,
    `  public func encode(to encoder: Encoder) throws {`,
    `    var container = encoder.container(keyedBy: CodingKeys.self)`,
    `    try container.encode(id.rawValue, forKey: .id)`,
  );
  for (const { field } of metas) {
    lines.push(generateEncodeLine(field));
  }
  lines.push(`  }`);

  lines.push(`}`);
  return lines.join("\n");
}

const REGENERATE_COMMAND = "bun run --cwd packages/codegen generate";

function fileHeader(moduleID: string): string {
  return [
    `// GENERATED — DO NOT EDIT BY HAND.`,
    `//`,
    `// Produced by \`packages/codegen\`'s \`generateSwiftSchema()\` (packages/codegen/src/index.ts)`,
    `// from the \`${moduleID}\` supertag module (see \`supertags/*\`). Regenerate with:`,
    `//`,
    `//   ${REGENERATE_COMMAND}`,
    `//`,
    `// which writes every registered module's output into`,
    `// apps/swift/Sources/EnchiridionSchema/Generated/ (packages/codegen/scripts/generate.ts).`,
    `// See apps/swift/Sources/EnchiridionSchema/README.md and the plan's §Supertag module`,
    `// contract ("Swift learns the schema at runtime first ... The generated`,
    `// EnchiridionSchema ... is a compile-time convenience layered on top, not a`,
    `// prerequisite.").`,
    ``,
    `import EnchiridionCore`,
    `import Foundation`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Shared runtime support (emitted once, independent of which modules are
// registered — every generated `<Tag>Fields` accessor struct calls into
// this).
// ---------------------------------------------------------------------------

interface ScalarKindConfig {
  cap: string;
  swiftType: string;
  valueCase: string;
}

const SCALAR_KINDS: ScalarKindConfig[] = [
  { cap: "Text", swiftType: "String", valueCase: "text" },
  { cap: "Number", swiftType: "Double", valueCase: "number" },
  { cap: "Boolean", swiftType: "Bool", valueCase: "boolean" },
  { cap: "Date", swiftType: "Date", valueCase: "date" },
  { cap: "DateTime", swiftType: "Date", valueCase: "dateTime" },
  { cap: "URL", swiftType: "String", valueCase: "url" },
  { cap: "Email", swiftType: "String", valueCase: "email" },
  { cap: "Phone", swiftType: "String", valueCase: "phone" },
  { cap: "Page", swiftType: "PageID", valueCase: "page" },
];

function generateFieldStorageSupportFile(): string {
  const lines: string[] = [
    `// GENERATED — DO NOT EDIT BY HAND.`,
    `//`,
    `// Produced by \`packages/codegen\`'s \`generateSwiftSchema()\` (packages/codegen/src/index.ts).`,
    `// Regenerate with:`,
    `//`,
    `//   ${REGENERATE_COMMAND}`,
    `//`,
    `// Shared generic get/set helpers over \`PageObjectMetadata.properties\`, used by every`,
    `// generated \`<Tag>Fields\` accessor struct (see \`<Module>Supertags.swift\`). This file's`,
    `// content is the same regardless of which supertag modules are registered — it is`,
    `// emitted once per codegen run, not per module.`,
    ``,
    `import EnchiridionCore`,
    `import Foundation`,
    ``,
    `public enum SupertagFieldStorage {`,
    `  private static func key(_ tagID: SupertagID, _ fieldID: SupertagFieldID) -> SupertagPropertyKey {`,
    `    SupertagPropertyKey(supertagID: tagID, fieldID: fieldID)`,
    `  }`,
    ``,
    `  private static func setSingle(`,
    `    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,`,
    `    _ value: SupertagValue?`,
    `  ) {`,
    `    let propertyKey = key(tagID, fieldID)`,
    `    if let value {`,
    `      metadata.properties[propertyKey] = [value]`,
    `    } else {`,
    `      metadata.properties[propertyKey] = nil`,
    `    }`,
    `  }`,
    ``,
    `  private static func setArray(`,
    `    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,`,
    `    _ values: [SupertagValue]`,
    `  ) {`,
    `    let propertyKey = key(tagID, fieldID)`,
    `    metadata.properties[propertyKey] = values.isEmpty ? nil : values`,
    `  }`,
  ];

  for (const kind of SCALAR_KINDS) {
    lines.push(
      ``,
      `  public static func read${kind.cap}(`,
      `    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID`,
      `  ) -> ${kind.swiftType}? {`,
      `    guard case .${kind.valueCase}(let value)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }`,
      `    return value`,
      `  }`,
      ``,
      `  public static func write${kind.cap}(`,
      `    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,`,
      `    _ value: ${kind.swiftType}?`,
      `  ) {`,
      `    setSingle(&metadata, tagID, fieldID, value.map { .${kind.valueCase}($0) })`,
      `  }`,
      ``,
      `  public static func read${kind.cap}Array(`,
      `    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID`,
      `  ) -> [${kind.swiftType}] {`,
      `    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {`,
      `      if case .${kind.valueCase}(let value) = $0 { value } else { nil }`,
      `    }`,
      `  }`,
      ``,
      `  public static func write${kind.cap}Array(`,
      `    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,`,
      `    _ values: [${kind.swiftType}]`,
      `  ) {`,
      `    setArray(&metadata, tagID, fieldID, values.map { .${kind.valueCase}($0) })`,
      `  }`,
    );
  }

  lines.push(
    ``,
    `  public static func readSelect<T: RawRepresentable>(`,
    `    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID`,
    `  ) -> T? where T.RawValue == String {`,
    `    guard case .select(let raw)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }`,
    `    return T(rawValue: raw)`,
    `  }`,
    ``,
    `  public static func writeSelect<T: RawRepresentable>(`,
    `    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,`,
    `    _ value: T?`,
    `  ) where T.RawValue == String {`,
    `    setSingle(&metadata, tagID, fieldID, value.map { .select($0.rawValue) })`,
    `  }`,
    ``,
    `  public static func readSelectArray<T: RawRepresentable>(`,
    `    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID`,
    `  ) -> [T] where T.RawValue == String {`,
    `    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {`,
    `      if case .select(let raw) = $0 { T(rawValue: raw) } else { nil }`,
    `    }`,
    `  }`,
    ``,
    `  public static func writeSelectArray<T: RawRepresentable>(`,
    `    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,`,
    `    _ values: [T]`,
    `  ) where T.RawValue == String {`,
    `    setArray(&metadata, tagID, fieldID, values.map { .select($0.rawValue) })`,
    `  }`,
    `}`,
  );

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Generates the EnchiridionSchema Swift sources from every registered
 *  supertag module. Output is GENERATED — never hand-edited (see
 *  apps/swift/Sources/EnchiridionSchema/README.md).
 *
 *  Builds a `SupertagRegistry` over the full `modules` set (this both
 *  validates the set — namespace collisions, cyclic inheritance, etc.,
 *  per registry.ts — and is what supplies `effectiveFields()` for item 5
 *  of this task, inherited-field accessors), then emits one Swift file per
 *  module that declares at least one supertag, plus one shared
 *  `SupertagFieldStorage.swift` runtime-support file (emitted once, not
 *  per module) if any supertag was generated at all. */
export function generateSwiftSchema(modules: SupertagModule[]): GeneratedSwiftSchema[] {
  if (modules.length === 0) return [];

  const registry = SupertagRegistry.build(modules);
  const tagInfoByID = buildTagInfoByID(registry);

  const outputs: GeneratedSwiftSchema[] = [];
  let generatedAnyTag = false;

  for (const qm of registry.qualifiedModules) {
    if (qm.supertags.length === 0) continue;
    generatedAnyTag = true;

    const modulePrefix = pascalCase(lastSegment(qm.id));
    const sections: string[] = [];

    for (const supertag of qm.supertags as readonly QualifiedSupertagDefinition[]) {
      const tag = tagInfoByID.get(supertag.id);
      if (!tag) continue;

      sections.push(generateFieldIDsEnum(tag));
      for (const fieldKey of tag.ownFieldsOrder) {
        const field = tag.ownFields.get(fieldKey);
        if (field?.selectEnumName) sections.push(generateSelectEnum(tag, field));
      }
      sections.push(generateFieldsStruct(tag, registry, tagInfoByID));
      sections.push(generateResponseStruct(tag, registry, tagInfoByID));
    }

    outputs.push({
      path: `Generated/${modulePrefix}Supertags.swift`,
      contents: `${fileHeader(qm.id)}\n\n${sections.join("\n\n")}\n`,
    });
  }

  if (generatedAnyTag) {
    outputs.push({
      path: "Generated/SupertagFieldStorage.swift",
      contents: generateFieldStorageSupportFile(),
    });
  }

  return outputs;
}
