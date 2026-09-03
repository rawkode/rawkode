import { CalendarPanel } from "../CalendarPanel.js"
import { CalendarEventsPanel } from "../CalendarEventsPanel.js"

// Secondary content view — per .impeccable.md's "lighter, less clinical" direction for
// Calendar/Bookmarks/Meetings/Workouts vs. the daily note's single dense panel. A route-level
// header carries this page's identity (title + one-line context), while `CalendarPanel` keeps its
// content quiet (see app.css's secondary-content rules). The brief lives on Today, where it
// provides context for the writing surface rather than competing with the full calendar view.
export function CalendarRoute() {
  return (
    <div className="route-view route-view--light">
      <header className="route-heading">
        <span className="route-heading-kicker">Today&rsquo;s schedule</span>
        <h1>Calendar</h1>
        <p>Google Calendar events merged alongside your daily note, once a workspace is connected.</p>
      </header>
      <CalendarPanel />
      <CalendarEventsPanel />
    </div>
  )
}
