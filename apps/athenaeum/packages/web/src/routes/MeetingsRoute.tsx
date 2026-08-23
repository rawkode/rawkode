import { MeetingsPanel } from "../MeetingsPanel.js"

// Secondary content view (see CalendarRoute.tsx's header comment for the general rationale). The
// route header takes over page identity; `MeetingsPanel` itself (unchanged — real
// `listMeetings`/`getMeeting`/`getNode` calls) renders as an open list/transcript pair, laid out
// side-by-side on wide viewports via app.css's list+detail grid (a lighter, more app-like read for
// a read-only view than a single stacked bordered panel).
export function MeetingsRoute() {
  return (
    <div className="route-view route-view--light">
      <header className="route-heading">
        <span className="route-heading-kicker">Read-only</span>
        <h1>Meetings</h1>
        <p>Recorded and transcribed natively — select a meeting to review its transcript.</p>
      </header>
      <MeetingsPanel />
    </div>
  )
}
