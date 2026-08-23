import { useState, type FormEvent } from "react"
import { signIn, type DevSession } from "./dev-session.js"

// Web-stage task item 1: "A minimal dev sign-in screen (email input, per the Decisions stage's
// scheme) — clearly labeled as a dev-only stand-in." Rendered by `App.tsx` whenever there is no
// valid persisted `DevSession` — see `dev-session.ts`'s header comment for the full HARD
// CONSTRAINT framing this component's own on-page copy repeats for the end user.

export function SignIn({ onSignedIn }: { readonly onSignedIn: (session: DevSession) => void }) {
  const [email, setEmail] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = email.trim()
    if (trimmed.length === 0) return

    setSubmitting(true)
    setError(null)
    signIn(trimmed).then(
      (session) => {
        setSubmitting(false)
        onSignedIn(session)
      },
      (thrown: unknown) => {
        setSubmitting(false)
        setError(thrown instanceof Error ? thrown.message : String(thrown))
      }
    )
  }

  return (
    <main className="app sign-in-screen">
      <h1>Athenaeum</h1>
      <div className="sign-in-card">
        <p className="dev-auth-banner">
          <strong>Dev sign-in</strong> — a stand-in for real sign-in, not production auth. Any
          email works; no password, no verification. See <code>docs/</code> for the real auth plan.
        </p>
        <form onSubmit={handleSubmit} className="sign-in-form">
          <label htmlFor="sign-in-email">Email</label>
          <input
            id="sign-in-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            disabled={submitting}
            autoFocus
          />
          <button type="submit" disabled={submitting || email.trim().length === 0}>
            {submitting ? "Signing in…" : "Sign in (dev)"}
          </button>
        </form>
        {error !== null && <p className="error">{error}</p>}
      </div>
    </main>
  )
}
