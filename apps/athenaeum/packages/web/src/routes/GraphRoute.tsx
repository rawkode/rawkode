import { GraphView } from "../GraphView.js"

export function GraphRoute() {
  return (
    <div className="route-view graph-route">
      <header className="route-heading">
        <span className="route-heading-kicker">Workspace entities</span>
        <h1>Entities</h1>
        <p>Browse and open the typed nodes connected to this workspace.</p>
      </header>
      <GraphView />
    </div>
  )
}
