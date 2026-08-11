import { describe, expect, test } from "bun:test";
import coreModule, { CoreSupertagIDs } from "@enchiridion/supertags-core";
import { generateSwiftSchema } from "./index";

function fileFor(outputs: ReturnType<typeof generateSwiftSchema>, path: string) {
  const file = outputs.find((f) => f.path === path);
  if (!file) throw new Error(`expected generated output "${path}" — got: ${outputs.map((f) => f.path).join(", ")}`);
  return file;
}

describe("generateSwiftSchema — supertags/core", () => {
  const outputs = generateSwiftSchema([coreModule]);

  test("emits exactly one file per module with declared supertags, plus the shared runtime support file", () => {
    expect(outputs.map((f) => f.path).sort()).toEqual([
      "Generated/CoreSupertags.swift",
      "Generated/SupertagFieldStorage.swift",
    ]);
  });

  test("is a pure function of its input — regenerating twice produces byte-identical output", () => {
    const again = generateSwiftSchema([coreModule]);
    expect(again).toEqual(outputs);
  });

  const core = () => fileFor(outputs, "Generated/CoreSupertags.swift").contents;

  test("every generated file opens with a GENERATED-DO-NOT-EDIT header naming the regeneration command", () => {
    const contents = core();
    expect(contents).toContain("GENERATED — DO NOT EDIT BY HAND");
    expect(contents).toContain("bun run --cwd packages/codegen generate");
  });

  test("imports EnchiridionCore and Foundation, never EnchiridionSync (EnchiridionSchema's real dependency graph)", () => {
    const contents = core();
    expect(contents).toContain("import EnchiridionCore");
    expect(contents).toContain("import Foundation");
    expect(contents).not.toContain("import EnchiridionSync");
    expect(contents).not.toContain("import Loro");
  });

  test("generates field ID constants namespaced per supertag (item 1)", () => {
    const contents = core();
    expect(contents).toContain("public enum CoreTaskFieldIDs {");
    expect(contents).toContain(`public static let supertagID = SupertagID(rawValue: "${CoreSupertagIDs.task}")`);
    expect(contents).toContain('public static let status = SupertagFieldID(rawValue: "status")');
    expect(contents).toContain('public static let scheduleGranularity = SupertagFieldID(rawValue: "schedule-granularity")');
  });

  test("generates a typed accessor struct wrapping PageObjectMetadata, not a stringly-typed escape hatch (item 2)", () => {
    const contents = core();
    expect(contents).toContain("public struct CoreTaskFields: Hashable, Sendable {");
    expect(contents).toContain("public var metadata: PageObjectMetadata");
    expect(contents).not.toContain(": Any");
    expect(contents).not.toContain(": Any?");
  });

  test("select fields become RawRepresentable String enums with slugified case names matching stored option ids (item 3)", () => {
    const contents = core();
    expect(contents).toContain("public enum CoreTaskStatus: String, Codable, Hashable, Sendable, CaseIterable {");
    expect(contents).toContain('case toDo = "to-do"');
    expect(contents).toContain('case inProgress = "in-progress"');
    expect(contents).toContain('case done = "done"');
    expect(contents).toContain('case cancelled = "cancelled"');
  });

  test("entityReference fields become PageID accessors, arrays for allowsMultiple (item 4)", () => {
    const contents = core();
    // single-valued: task.project
    expect(contents).toMatch(/public var project: PageID\? \{[\s\S]*?readPage/);
    // allowsMultiple: task.assignee, event.attendees
    expect(contents).toMatch(/public var assignee: \[PageID\] \{[\s\S]*?readPageArray/);
    expect(contents).toMatch(/public var attendees: \[PageID\] \{[\s\S]*?readPageArray/);
  });

  test("Company's generated accessor includes its own fields AND Organization's inherited fields (item 5)", () => {
    const contents = core();
    const companyFieldsMatch = contents.match(
      /public struct CoreCompanyFields: Hashable, Sendable \{[\s\S]*?\n\}/,
    );
    expect(companyFieldsMatch).not.toBeNull();
    const companyFields = companyFieldsMatch?.[0] ?? "";
    // Company's own fields.
    expect(companyFields).toContain("public var registrationNumber: String?");
    expect(companyFields).toContain("public var industry: String?");
    // Inherited from Organization, referencing Organization's own FieldIDs type
    // (not a duplicate CoreCompanyFieldIDs.website, which doesn't exist).
    expect(companyFields).toContain("public var website: String?");
    expect(companyFields).toContain("CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.website");
  });

  test("generates a Codable GraphQL response struct per supertag with epoch-ms Float date conversion, not JSONDecoder.dateDecodingStrategy (item 6)", () => {
    const contents = core();
    expect(contents).toContain("public struct CoreTask: Codable, Hashable, Sendable {");
    expect(contents).toContain("public var deadline: Date?");
    // Manual epoch-ms decode/encode, per workers/vault/src/graphql/schema.ts's Float convention.
    expect(contents).toContain(
      "self.deadline = (try container.decodeIfPresent(Double.self, forKey: .deadline)).map { Date(timeIntervalSince1970: $0 / 1000) }",
    );
    expect(contents).toContain(
      "try container.encodeIfPresent(deadline.map { $0.timeIntervalSince1970 * 1000 }, forKey: .deadline)",
    );
    // The doc comment above explains *why* dateDecodingStrategy isn't used (it can only
    // apply one uniform strategy per decoder, not a per-field wire convention) — assert
    // no code actually sets/uses it, not that the phrase never appears in a comment.
    expect(contents).not.toMatch(/\.dateDecodingStrategy\s*=/);
  });

  test("throws a descriptive error rather than silently generating on an invalid module set", () => {
    const brokenModule = {
      ...coreModule,
      supertags: {
        ...coreModule.supertags,
        // Not owned by this module's namespace -> qualifyModule should reject it.
        rogue: { name: "Rogue", symbol: "questionmark", fields: {}, id: "not.owned.by.core" },
      },
    };
    expect(() => generateSwiftSchema([brokenModule])).toThrow();
  });

  test("returns [] for an empty module list, and skips modules with zero declared supertags", () => {
    expect(generateSwiftSchema([])).toEqual([]);
    const emptyModule = { id: "dev.rawkode.enchiridion.empty", version: 1, supertags: {} };
    expect(generateSwiftSchema([emptyModule])).toEqual([]);
  });
});
