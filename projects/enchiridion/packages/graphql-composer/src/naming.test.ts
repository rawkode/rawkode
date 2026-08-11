import { describe, expect, test } from "bun:test";
import { lowerFirst, pluralize, toCamelCase, toEnumValueName, toPascalCase } from "./naming";

describe("toCamelCase", () => {
  test("single word stays lowercase", () => {
    expect(toCamelCase("email")).toBe("email");
  });

  test("hyphenated field ids become camelCase", () => {
    expect(toCamelCase("relationship-notes")).toBe("relationshipNotes");
    expect(toCamelCase("all-day")).toBe("allDay");
    expect(toCamelCase("start-date")).toBe("startDate");
    expect(toCamelCase("schedule-granularity")).toBe("scheduleGranularity");
  });

  test("collapses repeated separators and mixed casing", () => {
    expect(toCamelCase("estimated--minutes")).toBe("estimatedMinutes");
    expect(toCamelCase("COMPLETED-AT")).toBe("completedAt");
  });
});

describe("toPascalCase", () => {
  test("single word capitalizes first letter only", () => {
    expect(toPascalCase("status")).toBe("Status");
    expect(toPascalCase("Person")).toBe("Person");
  });

  test("hyphenated ids become PascalCase", () => {
    expect(toPascalCase("schedule-granularity")).toBe("ScheduleGranularity");
  });
});

describe("toEnumValueName", () => {
  test("slugified option ids become SCREAMING_SNAKE_CASE", () => {
    expect(toEnumValueName("to-do")).toBe("TO_DO");
    expect(toEnumValueName("in-progress")).toBe("IN_PROGRESS");
    expect(toEnumValueName("date-time")).toBe("DATE_TIME");
    expect(toEnumValueName("active")).toBe("ACTIVE");
  });

  test("prefixes a leading digit to stay a valid GraphQL name", () => {
    expect(toEnumValueName("1-off")).toBe("_1_OFF");
  });
});

describe("pluralize", () => {
  test("regular nouns get a trailing s", () => {
    expect(pluralize("organization")).toBe("organizations");
    expect(pluralize("event")).toBe("events");
    expect(pluralize("area")).toBe("areas");
    expect(pluralize("project")).toBe("projects");
    expect(pluralize("task")).toBe("tasks");
    expect(pluralize("place")).toBe("places");
  });

  test("nouns ending in a consonant + y become -ies", () => {
    expect(pluralize("company")).toBe("companies");
  });

  test("person is irregular and case-preserving", () => {
    expect(pluralize("person")).toBe("people");
    expect(pluralize("Person")).toBe("People");
  });
});

describe("lowerFirst", () => {
  test("lowercases only the first character", () => {
    expect(lowerFirst("Person")).toBe("person");
    expect(lowerFirst("")).toBe("");
  });
});
