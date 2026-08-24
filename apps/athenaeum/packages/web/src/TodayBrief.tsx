import { useMemo } from "react"
import * as Effect from "effect/Effect"
import type { GetTodayBriefOutput } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { formatTodayBriefError } from "./today-brief-errors.js"
import { todayBriefRequest } from "./today-brief-request.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"

const timeFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(undefined, { timeZone, hour: "numeric", minute: "2-digit" })

const formatHistory = (status: GetTodayBriefOutput["calendarHistory"]["status"]): string => {
  if (status === "found") return "Calendar history available"
  if (status === "noneInRetainedData") return "No calendar history retained for this day"
  return "Calendar history unavailable"
}

export function TodayBrief() {
  const request = useMemo(() => todayBriefRequest(workspaceId), [])
  const query = useEffectQuery(
    WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.getTodayBrief(request))),
    [request]
  )

  return (
    <section className="today-brief" aria-labelledby="today-brief-title">
      <div className="today-brief-heading">
        <div>
          <span className="section-kicker">Daily context</span>
          <h2 id="today-brief-title">Today&rsquo;s brief</h2>
        </div>
        {query.status === "success" && <span className="today-brief-date">{query.value.localDate}</span>}
      </div>

      {query.status === "loading" && <p className="today-brief-state">Loading today&rsquo;s brief&hellip;</p>}
      {query.status === "failure" && <p className="today-brief-state error">{formatTodayBriefError(query.error)}</p>}
      {query.status === "success" && <TodayBriefContent value={query.value} />}
    </section>
  )
}

function TodayBriefContent({ value }: { readonly value: GetTodayBriefOutput }) {
  const formatter = timeFormatter(value.timeZone)
  return (
    <>
      <p className="today-brief-history">{formatHistory(value.calendarHistory.status)}</p>
      {value.events.length === 0 ? (
        <p className="today-brief-state">Nothing scheduled in the retained calendar projection.</p>
      ) : (
        <ul className="today-brief-events">
          {value.events.map((event) => (
            <li key={event.id} className="today-brief-event">
              <time dateTime={event.start}>{formatter.format(new Date(event.start))}</time>
              <div>
                <strong>{event.title}</strong>
                {event.people.length > 0 && <span>{event.people.map((person) => person.displayName).filter(Boolean).join(", ")}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
