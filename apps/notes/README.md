# Notes

Universal local-first notes app for iOS, iPadOS, and macOS.

Daily notes are the primary document type. The app creates today on launch, lets you open any date from the Daily Notes section, stores one daily note per local date, and keeps note content as Tiptap JSON in SQLite rather than Markdown files.

## Architecture

- SwiftUI owns the native shell, daily-note navigation, and persistence.
- SQLite stores `documents`, `entities`, `supertags`, entity properties, entity-to-supertag links, and document-to-entity references from both entity nodes and typed `[[Entity]]` mentions.
- WKWebView hosts the bundled React/Tiptap editor.
- Tiptap persists rich document JSON, SQLite-backed entity references, local query blocks, and inline Excalidraw sketches.
- The generated web editor bundle is ignored by version control. Xcode builds it from `WebEditor/` before copying app resources.

Local query blocks support table, list, and grouped board views over SQLite-backed documents, daily notes, entities, supertags, supertag collections, entity backlinks, and entity relationship fields, with `SELECT *`, explicit field projections, `COUNT(*)`, or grouped counts such as `SELECT status, COUNT(*) FROM bookmarks GROUP BY status HAVING count > 1`. Query selections support optional `AS` aliases, plus optional `WHERE` and grouped `HAVING` predicates using `=`, `!=`, `CONTAINS`, `NOT CONTAINS`, `IN (...)`, `NOT IN (...)`, or ordered comparisons, with `AND` and `OR` predicate groups. Row-returning and grouped-count queries also support `ORDER BY` and `LIMIT` clauses. Daily-note date filters understand `today`, `yesterday`, and `tomorrow`. Supertag collection rows expose entity properties as queryable columns. Typed or pasted fences such as ```` ```ql view=board group=status```` create live query blocks with the selected view and board grouping. Typed note mentions like `[[Entity Name]]` create or reuse local entities, same-line hashtags such as `[[Entity Name]] #project` apply supertags, and both appear in backlink queries. Property lines directly below a typed mention, such as `owner:: [[Rawkode Academy]]`, add or update local entity properties. Property values written as `[[Entity Name]]` are stored as entity references, expose a matching `<property>_entity_id` query column, and appear in the `entity_relationships` query source. Cloudflare sync/storage and a broader query language are still roadmap features.

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
