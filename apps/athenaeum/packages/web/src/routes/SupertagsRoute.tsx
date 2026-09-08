import { SupertagsManager } from "../SupertagsManager.js"

// One file per routed section, same convention `NotesRoute.tsx`/`GraphRoute.tsx` already
// establish (docs/supertag-centering-decisions.md §3, "New `/supertags` route — minimal, concrete
// shape": "`packages/web/src/routes/SupertagsRoute.tsx` (new) → a new `SupertagsManager.tsx`
// component").
export function SupertagsRoute() {
  return (
    <div className="route-view supertags-route">
      <header className="route-heading">
        <span className="route-heading-kicker">Type system</span>
        <h1>Supertags</h1>
        <p>
          Typed tags with inherited fields — the organizing primitive every node&rsquo;s facts hang
          off of. Create a tag, give it parents, and define the fields it (and everything beneath
          it) carries.
        </p>
      </header>
      <SupertagsManager />
    </div>
  )
}
