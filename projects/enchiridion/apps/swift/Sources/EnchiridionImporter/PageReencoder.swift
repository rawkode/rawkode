// PageReencoder.swift
// EnchiridionImporter
//
// Re-encodes a `DecodedOldPage` (from `OldPageDocumentDecoder`) into the NEW
// app's Loro-backed `EnchiridionSync.PageDocument` — the "re-encode" half of
// the plan's P1 importer task. Every call here goes through
// `EnchiridionSync.PageDocument`'s real public API (`create`, `insertText`,
// `mark`, `addPageReferenceMark`, `addSupertag`, `setProperty`, `setPinned`,
// `setDeleted`) — this file does not touch `Loro` directly.
//
// DETERMINISTIC-ID PROOF (task requirement: "same PageID (re-derived, not
// copied, to prove determinism holds)"): `rederivedPageID(for:)` below
// independently recomputes the id from decoded CONTENT for every case where
// the old app's own id derivation was itself deterministic, rather than
// trusting `decoded.originalPageID` — see that function's doc comment for
// exactly which cases those are and why `.free` pages are the one
// legitimate "carry the old id forward" case, not a shortcut.
import EnchiridionCore
import EnchiridionSync
import Foundation

public enum PageReencoderError: Error, Sendable {
  case engineFailure(String)
}

/// A free-form label for the vault-meta catalog entry's `docType` field
/// (`EnchiridionSync.SyncProtocolMessage`'s `CatalogEntry.docType` /
/// `workers/vault/src/catalog.ts`'s `CatalogEntry.docType` — a plain,
/// server-opaque string, confirmed by reading `vault-write-model.test.ts`'s
/// fixtures, which use bare `"free"`/etc.), derived from the page's kind.
public enum PageKindDocType {
  public static func label(for kind: PageKind) -> String {
    switch kind {
    case .daily: return "daily"
    case .free: return "free"
    case .calendarEvent: return "calendarEvent"
    case .calendarSeries: return "calendarSeries"
    case .calendarMaterializedEvent: return "calendarMaterializedEvent"
    }
  }
}

public enum PageReencoder {
  public struct Result: Sendable {
    public var pageID: PageID
    public var document: Data
    public var version: PageDocumentVersion
    public var docType: String
    public var createdAt: Date
  }

  /// Re-derives a page's NEW-app identity from decoded content wherever the
  /// old app's own id scheme was itself deterministic:
  ///   - `.daily(day)` — old: `PageID.daily(_:)`, `"daily_<YYYY-MM-DD>"`
  ///     (underscore separator, the old app's Automerge-era format). New:
  ///     `EnchiridionCore.PageID.daily(_:)` — `"daily:<YYYY-MM-DD>"` (colon
  ///     separator; see Identity.swift). The importer only ever reads the
  ///     old `day.rawValue` (the bare "YYYY-MM-DD" string, not the prefixed
  ///     id) and re-derives through the NEW scheme, so this rename is
  ///     transparent here — no old-format string is ever written out.
  ///   - `.calendarMaterializedEvent(identity)` — old:
  ///     `PageID.materializedCalendarEvent(_:)`,
  ///     `"calendar_event_<idDigest(identity.stableKey)>"`. New:
  ///     `PageID.digestIdentified(prefix: "calendar_event", canonicalKey:
  ///     identity.stableKey)` reproduces that exact derivation — both
  ///     `CalendarMaterializedIdentity.stableKey` (PageModels.swift, both
  ///     apps) and the id-digest primitive (SHA-256, first 20 bytes,
  ///     lowercase hex) are byte-for-byte identical between the two apps.
  ///   - a `.free`-kind page carrying the `person` supertag with a decoded
  ///     `email` value — the old app creates these with `id:
  ///     PageID.person(email:)` even though `kind` stays `.free`
  ///     (`LibraryRepository.swift`'s calendar-attendee ingestion path) —
  ///     `PageKind` alone can't distinguish this case, so the supertag/
  ///     property content has to be consulted. Re-derives via
  ///     `PageID.person(email:)`, the same scheme on both sides.
  ///   - everything else (plain `.free` pages, and the EventKit-only
  ///     `.calendarEvent`/`.calendarSeries` intermediate kinds, which the
  ///     plan's Cloudflare gatekeeper ingest path doesn't use — see
  ///     `graph-core/src/index.ts`'s "NOT YET PORTED" note) — there is no
  ///     deterministic scheme to recompute from, so the OLD page's own id
  ///     is carried forward verbatim. This is required for idempotency
  ///     (re-running the importer must keep mapping the same old page to
  ///     the same new page), not a shortcut: a truly random id has no
  ///     "re-derivation" to prove in the first place.
  public static func rederivedPageID(for decoded: DecodedOldPage) -> PageID {
    switch decoded.kind {
    case .daily(let day):
      return PageID.daily(DayKey(rawValue: day.rawValue))

    case .calendarMaterializedEvent(let identity):
      return PageID.digestIdentified(prefix: "calendar_event", canonicalKey: identity.stableKey)

    case .free, .calendarEvent, .calendarSeries:
      if decoded.supertagIDs.contains(SupertagID(rawValue: "person")),
        let email = firstEmail(in: decoded)
      {
        return PageID.person(email: email)
      }
      return decoded.originalPageID
    }
  }

  private static func firstEmail(in decoded: DecodedOldPage) -> String? {
    let key = SupertagPropertyKey(supertagID: .init(rawValue: "person"), fieldID: .init(rawValue: "email"))
    guard let values = decoded.properties[key] else { return nil }
    for value in values {
      if case .email(let email) = value { return email }
    }
    return nil
  }

  /// Re-derives a page-REFERENCE mark's target through the same identity
  /// scheme change `rederivedPageID(for:)` applies to a page's OWN
  /// identity. `OldPageDocumentDecoder.decode` decodes a page-reference
  /// mark's target verbatim off the old app's raw payload
  /// (`PageID(rawValue: payload.pageID)`) with no re-derivation — so a
  /// reference to a daily page still carries the OLD `daily_YYYY-MM-DD` id
  /// even though `rederivedPageID(for:)` re-encodes that same daily page's
  /// own identity under the NEW `daily:YYYY-MM-DD` scheme (see that
  /// function's doc comment). Left alone, the reference would silently
  /// dangle post-import.
  ///
  /// Every other old-app id scheme a reference could target is
  /// byte-for-byte IDENTICAL between the old and new apps, so references to
  /// those pages already round-trip correctly without this re-derivation:
  ///   - `person_<digest>` — old `PageID.person(email:)`
  ///     (PageModels.swift:42-44) and new `PageID.person(email:)`
  ///     (Identity.swift:111-116) produce the exact same string (same
  ///     prefix, same trim/lowercase, same SHA-256-first-20-bytes digest).
  ///   - `calendar_event_<digest>` — old
  ///     `PageID.materializedCalendarEvent(_:)` (PageModels.swift:34-36)
  ///     and `rederivedPageID(for:)`'s own
  ///     `PageID.digestIdentified(prefix: "calendar_event", ...)` call
  ///     produce the exact same string.
  ///   - `page_<uuid>` (free) and `event_<digest>`/`series_<digest>`
  ///     (the EventKit-only intermediate kinds) — `rederivedPageID(for:)`
  ///     carries these ids forward verbatim (no scheme change on either
  ///     side), so a reference's copy of that same old id is already
  ///     correct by construction.
  /// Only `daily_YYYY-MM-DD` changed shape, so it is the only pattern
  /// re-derived here.
  static func rederivedReferenceTarget(for pageID: PageID) -> PageID {
    guard let day = oldDailyPageDay(pageID.rawValue) else { return pageID }
    return PageID.daily(DayKey(rawValue: day))
  }

  /// Parses the old app's `"daily_<YYYY-MM-DD>"` page id format (underscore
  /// separator, `PageModels.swift`'s `PageID.daily(_:)`), returning the bare
  /// `YYYY-MM-DD` day string on a match, or `nil` otherwise. Deliberately
  /// strict about the day's shape (exactly `\d{4}-\d{2}-\d{2}`) so this
  /// can't misidentify an unrelated `daily_`-prefixed id (e.g. some other
  /// page's freeform id that merely happens to start with `daily_`) as a
  /// daily page reference.
  private static func oldDailyPageDay(_ rawValue: String) -> String? {
    let prefix = "daily_"
    guard rawValue.hasPrefix(prefix) else { return nil }
    let day = String(rawValue.dropFirst(prefix.count))
    let parts = day.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 3,
      parts[0].count == 4, parts[0].allSatisfy({ $0.isASCII && $0.isNumber }),
      parts[1].count == 2, parts[1].allSatisfy({ $0.isASCII && $0.isNumber }),
      parts[2].count == 2, parts[2].allSatisfy({ $0.isASCII && $0.isNumber })
    else { return nil }
    return day
  }

  public static func reencode(_ decoded: DecodedOldPage) throws -> Result {
    let pageID = rederivedPageID(for: decoded)
    do {
      var (document, _) = try PageDocument.create(
        id: pageID, kind: decoded.kind, title: decoded.title, createdAt: decoded.createdAt
      )

      if !decoded.body.isEmpty {
        (document, _, _) = try PageDocument.insertText(.body, at: 0, text: decoded.body, in: document)
      }

      for mark in decoded.marks {
        switch mark.kind {
        case .style(let style):
          (document, _, _) = try PageDocument.mark(
            .body, range: mark.range, style: style, value: .bool(true), in: document
          )
        case .pageReference(let targetPageID, let label):
          (document, _, _) = try PageDocument.addPageReferenceMark(
            to: rederivedReferenceTarget(for: targetPageID), label: label, range: mark.range, in: document
          )
        case .unsupported:
          // Documented gap — see the importer README's "Known
          // limitations": this importer only re-encodes the old app's
          // bold/italic/strikethrough/code/page-reference marks. Any other
          // old mark name (e.g. the meeting-transcript semantic-
          // provenance mark) is dropped, not silently corrupted.
          continue
        }
      }

      // Every supertag the page carries, whether or not it also has
      // property values (a bare tag with no fields set still needs
      // `addSupertag`).
      for supertagID in decoded.supertagIDs {
        (document, _, _) = try PageDocument.addSupertag(supertagID, in: document)
      }

      // Sorted for reproducible op ordering across two importer runs
      // (helps keep re-encoded docs as similar as possible run-to-run,
      // even though byte-identical output isn't guaranteed — see
      // VaultImporter.swift's header on why `VaultImportLedger`, not
      // snapshot-byte-equality, is this importer's idempotency mechanism).
      for (key, values) in decoded.properties.sorted(by: { $0.key.storageKey < $1.key.storageKey }) {
        (document, _, _) = try PageDocument.setProperty(key: key, values: values, in: document)
      }

      if decoded.isPinned {
        (document, _, _) = try PageDocument.setPinned(true, in: document)
      }
      if let deletedAt = decoded.deletedAt {
        (document, _, _) = try PageDocument.setDeleted(deletedAt, in: document)
      }

      let version = try PageDocument.currentVersion(of: document)
      return Result(
        pageID: pageID,
        document: document,
        version: version,
        docType: PageKindDocType.label(for: decoded.kind),
        createdAt: decoded.createdAt
      )
    } catch let error as EnchiridionSync.PageDocumentError {
      throw PageReencoderError.engineFailure(String(describing: error))
    }
  }
}
