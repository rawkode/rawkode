import { useEffect, useState } from "react"

const CALLBACK_PATH = "/oauth/google-calendar/callback"

/** The browser never exchanges provider code/state; the fixed server callback owns that custody. */
export function CalendarOAuthCallback() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (window.location.pathname !== CALLBACK_PATH) return
    // Drop callback query data immediately. It can contain provider code/state and is never retained.
    window.history.replaceState(null, "", CALLBACK_PATH)
    setVisible(true)
  }, [])

  if (window.location.pathname !== CALLBACK_PATH && !visible) return null

  return (
    <div className="oauth-callback-overlay">
      <div className="oauth-callback-card">
        <h2>Google Calendar connection</h2>
        <p>Your Google Calendar authorization was returned to Athenaeum. Check Calendar for its connection status.</p>
        <button type="button" onClick={() => window.location.assign("/")}>
          Back to Athenaeum
        </button>
      </div>
    </div>
  )
}
