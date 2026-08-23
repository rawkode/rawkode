import { WorkoutsPanel } from "../WorkoutsPanel.js"

// Secondary content view (see CalendarRoute.tsx's header comment for the general rationale). The
// route header takes over page identity; `WorkoutsPanel` itself (unchanged — real
// `listWorkouts`/`getWorkout` calls) renders as an open list/detail pair, laid out side-by-side on
// wide viewports via app.css's list+detail grid, matching MeetingsRoute's treatment.
export function WorkoutsRoute() {
  return (
    <div className="route-view route-view--light">
      <header className="route-heading">
        <span className="route-heading-kicker">Read-only</span>
        <h1>Workouts</h1>
        <p>Imported from HealthKit — select a workout to review its exercise/set or split detail.</p>
      </header>
      <WorkoutsPanel />
    </div>
  )
}
