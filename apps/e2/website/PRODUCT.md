# Apsides accounts

## Register

product

## Users and purpose

The existing Enchiridion administration interface, migrated to Apsides. The
signed-in owner lands on Today, edits the shared `.native-note` document format,
connects Google and, when configured, GitHub accounts, starts synchronization,
reads contacts, calendar events, and supported GitHub activity, and deletes
accounts together with their mirrored data.

## Today

Today is a lazy document: opening a missing day reads only; the first edit
creates it and subsequent saves use optimistic revisions. A right sidebar shows
today's calendar events, people from event attendees or `@` mentions, and
issues, pull requests, and discussions from GitHub. GitHub activity can be
linked to a Google contact and inserted into the note as a stable entity.

Event instances have dedicated meeting-note documents. The event-series page is
synthetic and presents a feed of its instance notes.

## Design

Preserve the existing native, focused, responsive admin shell, system
typography, cool neutral surfaces, and blue action color. Use labeled native
controls, keyboard navigation, visible focus, readable contrast, and reduced
motion. Integrations register editor entities and command palette actions
through manifests so the editor does not import Worker implementations.

## Provenance

Enchiridion website AdminLayout.astro and global.css at revision 7d106fd0; the
current requested account administration scope.
