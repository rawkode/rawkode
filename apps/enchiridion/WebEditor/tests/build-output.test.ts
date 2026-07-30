import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const outputURL = new URL(
  "../../Sources/SharedUI/Resources/Editor/index.html",
  import.meta.url
);
const html = readFileSync(outputURL, "utf8");

describe("packaged editor", () => {
  test("is a self-contained document with syntactically valid JavaScript", () => {
    expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(html).not.toContain("src=\"./assets/");
    expect(html.match(/<\/script>/gi)).toHaveLength(2);

    const module = html.match(
      /<script type="module" nonce="enchiridion-bootstrap">([\s\S]*?)<\/script>\s*<style/
    );
    expect(module).not.toBeNull();
    expect(() => new Function(module?.[1] ?? "")).not.toThrow();
  });

  test("packages recurring calendar context UI", () => {
    expect(html).toContain('id="page-context"');
    expect(html).toContain("Occurrence notes");
    expect(html).toContain('type: "openPage"');
  });

  test("packages selected-text supertagging", () => {
    expect(html).toContain("Supertag");
    expect(html).toContain('id="supertag-command"');
    expect(html).toContain("Find a page");
    expect(html).toContain("New page");
    expect(html).toMatch(/Create task (?:“|\\u201C)/);
    expect(html).toMatch(/Link existing task(?:…|\\u2026)/);
    expect(html).toContain("Task created in Inbox, but the link was not added.");
    expect(html).toContain("Retry task link");
    expect(html).toContain("min-height:2.75rem");
  });

  test("packages one unified editor command bar", () => {
    expect(html.match(/id="mobile-command-bar"/g)).toHaveLength(1);
    expect(html).not.toContain('id="selection-toolbar"');
    expect(html).toContain("dismissKeyboard");
    expect(html).toMatch(/type:\s*"editorFocusChanged"/);
  });

  test("packages exactly one editable inline page title", () => {
    expect(html.match(/id="title"/g)).toHaveLength(1);
    expect(html).toMatch(/<textarea id="title"[^>]*aria-label="Page title"/);
    expect(html).not.toMatch(/<textarea id="title"[^>]*hidden/);
  });

  test("packages compact Craft-style block and mention controls", () => {
    expect(html).toContain('id="mobile-command-bar"');
    expect(html).toContain("Text Style");
    expect(html).toContain("Indentation");
    expect(html).toContain("Find a page or date");
  });

  test("packages an accessible keyboard-first slash command palette", () => {
    expect(html).toMatch(/setAttribute\("role",\s*"listbox"\)/);
    expect(html).toContain("Slash commands");
    expect(html).toMatch(/setAttribute\("role",\s*"option"\)/);
    expect(html).toContain("aria-activedescendant");
    expect(html).toContain("ArrowDown");
    expect(html).toContain("No matching commands");
    expect(html).toContain("horizontal rule");
  });

  test("packages first-class inline web-link editing", () => {
    expect(html.match(/id="link-menu"/g)).toHaveLength(1);
    expect(html).toContain("Edit link");
    expect(html).toContain("Remove link");
    expect(html).toContain("Use a complete http:// or https:// address.");
    expect(html).toContain("Page references keep their identity.");
    expect(html).toContain('setAttribute("role", "dialog")');
    expect(html).toContain("aria-invalid");
    expect(html).toContain('rel: "noreferrer"');
    expect(html).not.toContain("window.prompt");
    expect(html).not.toContain("Link URL");
  });
});
