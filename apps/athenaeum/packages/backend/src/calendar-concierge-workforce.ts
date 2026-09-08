import {
  WORKFORCE_SCHEMA_VERSION,
  type WorkforceResult,
  type WorkforceStandupInput
} from "@athenaeum/domain"

const definition = (kind: string, id: string, label: string, version = "v1") => ({
  schemaVersion: WORKFORCE_SCHEMA_VERSION,
  kind,
  id,
  version,
  label
})

export const calendarConciergeBundle = (input: Readonly<{
  readonly runId: string
  readonly occurrenceId: string
  readonly civilDate: string
  readonly result: Readonly<{ readonly kind: WorkforceResult["kind"]; readonly summary: string }>
}>): WorkforceStandupInput => {
  const microEmployee = definition("microEmployee", "calendar-concierge", "Calendar relationship concierge")
  const job = definition("job", "calendar-attendee-enrichment", "Enrich calendar attendees")
  const workflow = definition("workflow", "calendar-relationship-concierge", "Calendar relationship concierge")
  const schedule = definition("schedule", "calendar-relationship-concierge", "Calendar attendee observations")
  const council = definition("council", "calendar-concierge-counsel", "Calendar concierge counsel")
  const microEmployeeRef = { kind: "microEmployee", id: microEmployee.id, version: microEmployee.version }
  const jobRef = { kind: "job", id: job.id, version: job.version }
  const workflowRef = { kind: "workflow", id: workflow.id, version: workflow.version }
  const scheduleRef = { kind: "schedule", id: schedule.id, version: schedule.version }
  const councilRef = { kind: "council", id: council.id, version: council.version }
  const run = { microEmployee: microEmployeeRef, job: jobRef, workflow: workflowRef, runId: input.runId }
  const occurrence = { schedule: scheduleRef, occurrenceId: input.occurrenceId, civilDate: input.civilDate }
  const runObserved = {
    schemaVersion: WORKFORCE_SCHEMA_VERSION,
    kind: "runObserved",
    eventId: `calendar-run:${input.runId}:observed`,
    sequence: 0,
    run,
    occurrence
  }
  const resultObserved = {
    schemaVersion: WORKFORCE_SCHEMA_VERSION,
    kind: "resultObserved",
    eventId: `calendar-run:${input.runId}:result`,
    sequence: 1,
    run,
    occurrence,
    result: input.result,
    causedByEventId: runObserved.eventId
  }
  const runFact = {
    schemaVersion: WORKFORCE_SCHEMA_VERSION,
    kind: "runFactObserved",
    factId: `calendar-run:${input.runId}:fact`,
    sequence: 2,
    run,
    occurrence,
    causedByEventId: resultObserved.eventId,
    observation: { kind: "result", result: input.result }
  }
  return {
    microEmployees: { state: "known", values: [{ ...microEmployee, role: "Resolve and maintain calendar relationships", jobRefs: [jobRef] }] },
    jobs: { state: "known", values: [{ ...job, workflowRef }] },
    workflows: { state: "known", values: [{ ...workflow, scheduleRef, councilRefs: [councilRef] }] },
    schedules: { state: "known", values: [{ ...schedule, civilTimeZone: "UTC", occurrenceIds: [input.occurrenceId] }] },
    councils: { state: "known", values: [{ ...council, memberRefs: [microEmployeeRef] }] },
    events: { state: "known", values: [runObserved, resultObserved] },
    runFacts: { state: "known", values: [runFact] },
    civilScope: occurrence
  } as unknown as WorkforceStandupInput
}

export const calendarCivilDate = (event: Readonly<{ readonly start: { readonly kind: string; readonly date?: string; readonly dateTime?: string } }>): string =>
  event.start.kind === "date" ? event.start.date ?? "1970-01-01" : (event.start.dateTime ?? "1970-01-01T00:00:00.000Z").slice(0, 10)
