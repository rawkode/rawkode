import { CalendarPanel } from "../CalendarPanel.js"

// Secondary content view — per .impeccable.md's "lighter, less clinical" direction for
// Calendar/Bookmarks/Meetings/Workouts vs. the daily note's single dense panel. A route-level
// header carries this page's identity (title + one-line context), while `CalendarPanel` keeps its
// connection state secondary. The privacy-safe daily brief belongs on the daily-note route.
export function CalendarRoute() {
  return (
    <div className="route-view route-view--light">
      <header className="route-heading">
        <span className="route-heading-kicker">Today&rsquo;s schedule</span>
        <h1>Calendar</h1>
        <p>Google Calendar events merged alongside your daily note, once a workspace is connected.</p>
      </header>
      <CalendarPanel />
    </div>
  )
}
