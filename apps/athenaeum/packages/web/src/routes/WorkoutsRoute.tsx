import { WorkoutsPanel } from "../WorkoutsPanel.js"

// Secondary content view (see CalendarRoute.tsx's header comment for the general rationale). The
// route header takes over page identity; `WorkoutsPanel` itself (unchanged — real
// `listWorkouts`/`getWorkout` calls) renders as an open list/detail pair, laid out side-by-side on
// wide viewports via app.css's list+detail grid, matching MeetingsRoute's treatment.
export function WorkoutsRoute() {
  return (
    <div className="route-view route-view--light">
      <header className="route-heading">
        <span className="route-heading-kicker">Your activity</span>
        <h1>Workouts</h1>
        <p>Keep your activity beside the rest of your life, with details ready to search and connect.</p>
      </header>
      <WorkoutsPanel />
    </div>
  )
}
