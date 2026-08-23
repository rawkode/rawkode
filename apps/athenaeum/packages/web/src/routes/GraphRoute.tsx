import { GraphView } from "../GraphView.js"

export function GraphRoute() {
  return (
    <div className="route-view graph-route">
      <header className="route-heading">
        <span className="route-heading-kicker">Knowledge graph</span>
        <h1>Graph</h1>
        <p>Browse nodes tagged across this workspace via a read-only compiled view.</p>
      </header>
      <GraphView />
    </div>
  )
}
