import { CalendarDayView } from "../CalendarDayView.js"
import { CalendarPanel } from "../CalendarPanel.js"

// Secondary content view — per .impeccable.md's "lighter, less clinical" direction for
// Calendar/Bookmarks/Meetings/Workouts vs. the daily note's single dense panel. A route-level
// header now carries this page's identity (title + one-line context), so `CalendarDayView`'s and
// `CalendarPanel`'s own in-panel `<h2>`s (unchanged) can drop to a quieter section-label treatment
// (see app.css's "secondary content views" rules) instead of duplicating page-level emphasis.
// Both components, their RPC calls, and their DOM order are untouched: the day view (primary
// content) renders first, the connect/disconnect status (secondary, occasional) below it.
export function CalendarRoute() {
  return (
    <div className="route-view route-view--light">
      <header className="route-heading">
        <span className="route-heading-kicker">Today&rsquo;s schedule</span>
        <h1>Calendar</h1>
        <p>Google Calendar events merged alongside your daily note, once a workspace is connected.</p>
      </header>
      <CalendarDayView />
      <CalendarPanel />
    </div>
  )
}
