# Notes

Universal local-first notes app for iOS, iPadOS, and macOS.

Daily notes are the primary document type. The app creates today on launch, lets you open today, tomorrow, or any date from the Daily Notes section, stores one daily note per local date, and keeps note content as Tiptap JSON in SQLite rather than Markdown files.

## Architecture

- SwiftUI owns the native shell, daily-note navigation, and persistence.
- SQLite stores `documents`, `entities`, `supertags`, entity properties, entity-to-supertag links, and document-to-entity references from both entity nodes and typed `[[Entity]]` mentions.
- WKWebView hosts the bundled React/Tiptap editor.
- Tiptap persists rich document JSON, SQLite-backed entity references, local query blocks, and inline Excalidraw sketches.
- The generated web editor bundle is ignored by version control. Xcode builds it from `WebEditor/` before copying app resources.

Local query blocks support table, list, and grouped board views over SQLite-backed documents, daily notes, entities, supertags, supertag collections, entity backlinks, and entity relationship fields, with `SELECT *`, explicit field projections, `COUNT(*)`, or grouped counts such as `SELECT status, COUNT(*) FROM bookmarks GROUP BY status HAVING count > 1`. Query selections support optional `AS` aliases, plus optional `WHERE` and grouped `HAVING` predicates using `=`, `!=`, `CONTAINS`, `NOT CONTAINS`, `IN (...)`, `NOT IN (...)`, `BETWEEN ... AND ...`, `NOT BETWEEN ... AND ...`, `IS EMPTY`, `IS NOT EMPTY`, or ordered comparisons, with `AND` and `OR` predicate groups. Row-returning and grouped-count queries also support `ORDER BY` and `LIMIT` clauses. Daily-note date filters understand `today`, `yesterday`, `tomorrow`, and day arithmetic such as `today-7d`, `today+1d`, or `'today - 2 days'`. Supertag collection rows expose entity properties as queryable columns. Typed or pasted fences such as ```` ```ql view=board group=status```` create live query blocks with the selected view and board grouping. Typed note mentions like `[[Entity Name]]` create or reuse local entities and appear in backlink queries, while same-line hashtags such as `[[Entity Name]] #project` apply supertags and make the entity queryable through supertag collections. Property lines directly below a typed mention, such as `owner:: [[Rawkode Academy]]`, add or update local entity properties. Property values written as `[[Entity Name]]` are stored as entity references, expose a matching `<property>_entity_id` query column, and appear in the `entity_relationships` query source.

## Roadmap

Current local-first foundation:

- Daily notes are calendar-backed documents with today, tomorrow, arbitrary-date, and adjacent-day navigation.
- Notes are persisted as Tiptap JSON in local SQLite, with inline Excalidraw sketches.
- Entities, supertags, entity properties, backlinks, and entity-to-entity property references are indexed locally.
- Entity detail navigation opens from context panels and query rows, with local backlinks, properties, and relationship context.
- Entity detail screens expose schema-aware editors for typed supertag fields and keep extra properties separate.
- Query blocks run against local SQLite materializations and can render as tables, lists, or grouped boards.
- Saved query views can be created, edited, duplicated, reordered, inserted into notes, and queried locally.
- Saved query detail screens render table, list, and grouped board layouts, and editor insertion shows saved-view layout metadata.
- Inline query blocks can be promoted into saved query views from inside the editor.
- Supertags have strongly typed schema fields, and the native Database editor can select types, inspect properties, edit property metadata in place, and create or delete typed properties.
- Vault export and replacement import are available from the native app for local JSON portability before sync exists.

Next local milestones:

- Schema impact previews with affected entity counts and safer destructive-change workflows.

Cloudflare-backed milestones remain later:

- Durable sync protocol with conflict handling around SQLite-backed note/entity changes.
- Object snapshots for large document/editor payloads and Excalidraw assets.
- Server-side query acceleration only after the local query semantics settle.

## Project

The Xcode project is generated from `project.yml` with XcodeGen:

```sh
xcodegen generate
```

Install the web editor dependencies once:

```sh
cd WebEditor
~/.bun/bin/bun install
```

## Build

```sh
xcodebuild -project Notes.xcodeproj -scheme "Notes iOS" -destination "generic/platform=iOS Simulator" CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Notes.xcodeproj -scheme "Notes macOS" -destination "platform=macOS" -derivedDataPath DerivedData/Notes-macOS CODE_SIGNING_ALLOWED=NO build
```
