import { BookmarksPanel } from "../BookmarksPanel.js"

// Secondary content view (see CalendarRoute.tsx's header comment for the general rationale). A
// route-level header replaces the page-identity role `BookmarksPanel`'s own `<h2>` used to carry
// alone; the panel itself (unchanged, real `createBookmark`/`listBookmarks` calls) renders as an
// open capture bar + list below, not a bordered card.
export function BookmarksRoute() {
  return (
    <div className="route-view route-view--light">
      <header className="route-heading">
        <span className="route-heading-kicker">Quick capture</span>
        <h1>Bookmarks</h1>
        <p>Paste a URL to save it to this workspace — a lightweight capture list, not a full reading app.</p>
      </header>
      <BookmarksPanel />
    </div>
  )
}
