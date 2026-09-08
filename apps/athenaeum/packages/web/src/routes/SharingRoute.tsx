import { SharePanel } from "../SharePanel.js"

export function SharingRoute() {
  return (
    <div className="route-view">
      <header className="route-heading">
        <span className="route-heading-kicker">Collaboration</span>
        <h1>Sharing</h1>
        <p>Invite collaborators by email or mint a share link — removals and revocations preview their downstream effect first.</p>
      </header>
      <SharePanel />
    </div>
  )
}
