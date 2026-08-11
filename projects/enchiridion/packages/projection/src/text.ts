// @enchiridion/projection — body text delta walk: plain text, page
// references, and formatting-mark runs.
//
// Port of `PageDocument.plainTextAndReferences`
// (apps/swift/Sources/EnchiridionSync/PageDocument.swift:750-816), adapted
// from loro-swift's `LoroText.toDelta()` to loro-crdt's JS `toDelta()`
// (loro_wasm.d.ts's `Delta<T>` — `{insert, attributes}` /
// `{delete}` / `{retain, attributes}` union, ~line 339). Only `insert`
// segments carry content or attributes; `delete`/`retain` never appear in
// a `toDelta()` read of a text container's current state (those are
// mutation-intent shapes for `applyDelta`, not read-back shapes), so this
// walk only handles the `insert` variant, matching Swift's
// `guard case .insert(...) = delta else { continue }`.
//
// OFFSET CONVENTION: `range` is Unicode Scalar (codepoint) offsets into
// `plainText`, matching `PageDocument.swift`'s documented convention
// (`FormattingMarkRun.range`'s doc comment, PageModels.swift). JS strings
// are UTF-16, so a chunk's scalar length is computed via
// `[...chunk].length` (an iterator over a JS string walks by codepoint,
// combining surrogate pairs) rather than `chunk.length` (UTF-16 code
// units) — the two diverge for any astral-plane character (emoji, etc.).

import type { Delta } from "loro-crdt/bundler";
import type { LoroText } from "./doc";

/** Mirrors `PageReference` (apps/swift/Sources/EnchiridionCore's page
 *  reference model): a decoded page-reference mark's destination, plus the
 *  page it was found on. */
export interface PageReference {
  sourcePageID: string;
  targetPageID: string;
  fallbackLabel: string;
}

/** One contiguous, single-style formatting-mark span — mirrors
 *  `FormattingMarkRun` (PageDocument.swift:191-207). `style` is always one
 *  of `FORMATTING_MARK_STYLES`, never `"pageReference"` (that's reported
 *  separately via `PageReference`, since it carries a destination payload
 *  rather than being a bare on/off style — matches Swift exactly). */
export interface FormattingMarkRun {
  style: string;
  range: { start: number; end: number };
}

/** Every mark style reported as a `FormattingMarkRun` — every registered
 *  style except `pageReference`. Matches
 *  `PageDocument.formattingMarkStyles` (PageDocument.swift:747-748). */
export const FORMATTING_MARK_STYLES = ["bold", "italic", "underline", "strikethrough", "code"] as const;

const PAGE_REFERENCE_MARK_KEY = "pageReference";

interface PageReferencePayload {
  pageID: string;
  label: string;
}

function decodePageReferencePayload(value: unknown): PageReferencePayload | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).pageID === "string" &&
      typeof (parsed as Record<string, unknown>).label === "string"
    ) {
      return parsed as PageReferencePayload;
    }
  } catch {
    // Malformed mark payload — ignored, matching Swift's `try?`-based
    // `pageReferenceDestination(fromMarkValue:)`.
  }
  return undefined;
}

/** Encodes a page-reference mark payload the same shape
 *  `PageDocument.addPageReferenceMark` writes
 *  (`PageReferenceValue { pageID, label }`, PageModels.swift). Exported for
 *  test fixtures that need to author a page-reference mark. */
export function encodePageReferencePayload(pageID: string, label: string): string {
  return JSON.stringify({ pageID, label });
}

export interface BodyTextExtraction {
  plainText: string;
  references: PageReference[];
  formattingMarks: FormattingMarkRun[];
}

/** Walks `text.toDelta()` once, producing plain text, deduplicated page
 *  references (first occurrence per target page wins, matching Swift's
 *  `seen: Set<PageID>` guard), and formatting-mark runs. Port of
 *  `PageDocument.plainTextAndReferences` — see this file's header. */
export function extractBodyText(text: LoroText, sourcePageID: string): BodyTextExtraction {
  let plainText = "";
  const references: PageReference[] = [];
  const seenTargets = new Set<string>();

  // One open-run start scalar-offset per style — matches Swift's
  // `openRunStart` dictionary and its "delta segments partition
  // plainText contiguously" argument for why no separate merge pass is
  // needed.
  const openRunStart = new Map<string, number>();
  const formattingMarks: FormattingMarkRun[] = [];
  let scalarOffset = 0;

  for (const delta of text.toDelta() as Delta<string>[]) {
    if (typeof delta.insert !== "string") continue;
    const inserted = delta.insert;
    const attributes = delta.attributes;
    plainText += inserted;
    const scalarLength = [...inserted].length;

    for (const style of FORMATTING_MARK_STYLES) {
      const isActive = attributes?.[style] != null;
      const openStart = openRunStart.get(style);
      if (isActive && openStart === undefined) {
        openRunStart.set(style, scalarOffset);
      } else if (!isActive && openStart !== undefined) {
        formattingMarks.push({ style, range: { start: openStart, end: scalarOffset } });
        openRunStart.delete(style);
      }
    }
    scalarOffset += scalarLength;

    const markValue = attributes?.[PAGE_REFERENCE_MARK_KEY];
    if (markValue == null) continue;
    const destination = decodePageReferencePayload(markValue);
    if (!destination || seenTargets.has(destination.pageID)) continue;
    seenTargets.add(destination.pageID);
    references.push({
      sourcePageID,
      targetPageID: destination.pageID,
      fallbackLabel: destination.label,
    });
  }

  // Close any styles still open at the end of the text.
  for (const [style, start] of openRunStart) {
    formattingMarks.push({ style, range: { start, end: scalarOffset } });
  }
  formattingMarks.sort((a, b) => a.range.start - b.range.start || a.style.localeCompare(b.style));

  return { plainText, references, formattingMarks };
}
