import * as Schema from "effect/Schema"
import {
  canonicalStandupPublicationText,
  canonicalWorkforcePreimageV1,
  canonicalWorkforceValueV1,
  decodeWorkforceStandupInput,
  digestWorkforcePreimageV1,
  EntityId,
  projectWorkforceStandup,
  RUN_IDENTITY_VERSION,
  standupPublicationRequestIdentity,
  STANDUP_PUBLICATION_SLOT_IDENTITY_VERSION,
  type DefinitionRef,
  type ResultObservedEvent,
  type WorkforceDefinition,
  type WorkforceRunFact,
  type WorkforceStandupInput
} from "@athenaeum/domain"
import {
  STANDUP_PRIVATE_GRANT_VERSION,
  STANDUP_PRIVATE_REQUEST_VERSION,
  STANDUP_RUN_GRANT_MAX_TTL_MS,
  canonicalDailyNoteIdForCivilDate,
  resolvePrivatePublicationIntent,
  resolveStandupRunGrant,
  type ResolvedStandupRunGrantV1
} from "./standup-publication-private-contract.js"

/** Trusted internal ingress. This schema is never mounted on WorkspaceRpcApi. */
export const WorkforceRunClaim = Schema.Struct({
  /** Runtime row id, claim token, and monotonic attempt fence are all issuer-owned values. */
  runId: Schema.String.pipe(Schema.minLength(1)),
  claimToken: Schema.String.pipe(Schema.minLength(1)),
  claimFence: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1))
})

export const AdmitWorkforceRunInput = Schema.Struct({
  workspaceId: EntityId,
  bundle: Schema.Unknown,
  reportText: Schema.String.pipe(Schema.minLength(1)),
  /** Present only when a live runtime worker is admitting its own terminal result. */
  claim: Schema.optional(WorkforceRunClaim)
})

export type AdmitWorkforceRunInput = typeof AdmitWorkforceRunInput.Type
export type WorkforceRunClaim = typeof WorkforceRunClaim.Type

export const WORKFORCE_RUN_AUTHORITY_VERSION = "athenaeum.workforce-run-authority.v1" as const
export const WORKFORCE_RUN_MESSAGE_DERIVATION_VERSION = "athenaeum.workforce-run-message.v1" as const
export const WORKFORCE_RUN_RECEIPT_VERSION = "athenaeum.workforce-run-receipt.v1" as const

export type WorkforceRunReceiptV1 = Readonly<{
  readonly version: typeof WORKFORCE_RUN_RECEIPT_VERSION
  readonly requestIdentity: string
  readonly admissionFingerprint: string
  readonly workspaceId: string
  readonly runId: string
  readonly occurrenceId: string
  readonly civilDate: string
  readonly terminalEventId: string
  readonly terminalEventDigest: string
  readonly terminalFactId: string
  readonly terminalFactDigest: string
  readonly resultKind: "completed" | "blocked" | "failed" | "skipped"
  readonly resultSummary: string
  readonly reportDigest: string
  readonly reportByteLength: number
  readonly definitionBundleDigest: string
  readonly definitionBundle: string
  readonly grant: ResolvedStandupRunGrantV1
  readonly commitMessage: string
  readonly publicationId: string
  readonly dailyNoteId: string
  readonly childNodeId: string
  readonly custodyFingerprint: string
  readonly committedAt: string
}>

export type WorkforceRunReceiptOutputV1 = Readonly<{
  readonly version: typeof WORKFORCE_RUN_AUTHORITY_VERSION
  readonly requestIdentity: string
  readonly runId: string
  readonly occurrenceId: string
  readonly civilDate: string
  readonly resultKind: WorkforceRunReceiptV1["resultKind"]
  readonly resultSummary: string
  readonly publicationId: string
  readonly dailyNoteId: string
  readonly childNodeId: string
  readonly commitMessage: string
  readonly committedAt: string
  readonly replayed: boolean
}>

export class WorkforceRunAdmissionError extends Error {
  constructor(message: string) {
    super(`workforce run admission rejected: ${message}`)
  }
}

export class WorkforceRunConflictError extends Error {
  constructor(message = "request identity has a different immutable run result") {
    super(`workforce run conflict: ${message}`)
  }
}

const fail = (message: string): never => {
  throw new WorkforceRunAdmissionError(message)
}

const isKnown = <T>(value: { readonly state: string }): value is { readonly state: "known"; readonly values: readonly T[] } => value.state === "known"

const sameRef = (left: DefinitionRef, right: DefinitionRef): boolean =>
  left.kind === right.kind && left.id === right.id && left.version === right.version

const sameOccurrence = (
  left: WorkforceStandupInput["civilScope"],
  right: WorkforceStandupInput["civilScope"]
): boolean =>
  sameRef(left.schedule, right.schedule) &&
  left.occurrenceId === right.occurrenceId &&
  left.civilDate === right.civilDate

const sameRun = (left: ResultObservedEvent["run"], right: ResultObservedEvent["run"]): boolean =>
  sameRef(left.microEmployee, right.microEmployee) &&
  sameRef(left.job, right.job) &&
  sameRef(left.workflow, right.workflow) &&
  left.runId === right.runId

const refKey = (ref: DefinitionRef): string => `${ref.kind}:${ref.id}:${ref.version}`

const definitionFor = (
  definitions: readonly WorkforceDefinition[],
  ref: DefinitionRef
): WorkforceDefinition => {
  const matches = definitions.filter((candidate) =>
    candidate.kind === ref.kind && candidate.id === ref.id && candidate.version === ref.version
  )
  if (matches.length !== 1) fail(`definition ${refKey(ref)} is not uniquely resolved`)
  return matches[0]!
}

const digest = (domain: string, value: unknown): string =>
  digestWorkforcePreimageV1(canonicalWorkforcePreimageV1({
    domain,
    value: value as never
  }))

const canonicalJson = (value: unknown): string => {
  try {
    return canonicalWorkforceValueV1(value as never)
  } catch (error) {
    return fail(`canonical workforce value rejected: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const boundedCommitMessage = (jobLabel: string, kind: string, summary: string): string => {
  const prefix = `Workforce ${jobLabel} run ${kind}: `
  const available = 500 - prefix.length
  if (available <= 3) return prefix.slice(0, 500)
  return `${prefix}${summary.length > available ? `${summary.slice(0, available - 3)}...` : summary}`
}

const completeBundle = (bundle: WorkforceStandupInput): void => {
  for (const [name, source] of Object.entries(bundle)) {
    if (name === "civilScope") continue
    if (!isKnown(source as { readonly state: string })) fail(`bundle input ${name} must be fully loaded`)
  }
}

/**
 * Decode a complete, single-run bundle and bind its report bytes to the terminal result event.
 * This is the pure boundary used by the DO actor before any storage or page mutation occurs.
 */
export const decodeWorkforceRunAdmission = (input: AdmitWorkforceRunInput): Readonly<{
  readonly workspaceId: string
  readonly bundle: WorkforceStandupInput
  readonly bundleCanonical: string
  readonly bundleDigest: string
  readonly terminal: ResultObservedEvent
  readonly terminalEventDigest: string
  readonly terminalFact: WorkforceRunFact
  readonly terminalFactDigest: string
  readonly reportText: string
  readonly reportDigest: string
  readonly reportByteLength: number
  readonly requestIdentity: string
  readonly admissionFingerprint: string
  readonly dailyNoteId: string
  readonly commitMessage: string
}> => {
  const decoded = decodeWorkforceStandupInput(input.bundle)
  if (decoded._tag === "Left") fail(`${decoded.left.path.join(".") || "$"}: ${decoded.left.message}`)
  const bundle = (decoded as { readonly _tag: "Right"; readonly right: WorkforceStandupInput }).right
  completeBundle(bundle)

  const events = bundle.events.state === "known" ? bundle.events.values : []
  const results = events.filter((event): event is ResultObservedEvent => event.kind === "resultObserved")
  if (results.length !== 1) fail("bundle must contain exactly one terminal result event")
  const terminal = results[0]!
  const runObserved = events.filter((event) => event.kind === "runObserved" && sameRun(event.run, terminal.run) && sameOccurrence(event.occurrence, bundle.civilScope))
  if (runObserved.length !== 1) fail("bundle must contain exactly one matching runObserved event")
  if (terminal.causedByEventId !== runObserved[0]!.eventId) fail("terminal result must be caused by its runObserved event")
  if (!sameOccurrence(terminal.occurrence, bundle.civilScope)) fail("terminal result is outside the civil scope")

  const facts = bundle.runFacts.state === "known"
    ? bundle.runFacts.values.filter((candidate) =>
        sameRun(candidate.run, terminal.run) &&
        sameOccurrence(candidate.occurrence, bundle.civilScope) &&
        candidate.causedByEventId === terminal.eventId &&
        candidate.observation.kind === "result"
      )
    : []
  if (facts.length !== 1) fail("bundle must contain exactly one matching terminal result fact")
  const terminalFact = facts[0]!

  // A projection with no diagnostics is the canonical graph/causality validation. This import is
  // deliberately dynamic only for the function value so the rest of the module remains portable
  // across the Worker and pure test runtimes.
  const projection = projectWorkforceBundle(bundle)
  if (projection.diagnostics.length > 0) {
    fail(`bundle projection has diagnostics: ${projection.diagnostics.map((diagnostic) => diagnostic.code).join(", ")}`)
  }

  const employee = definitionFor(projection.resolvedDefinitions, terminal.run.microEmployee)
  const job = definitionFor(projection.resolvedDefinitions, terminal.run.job)
  const workflow = definitionFor(projection.resolvedDefinitions, terminal.run.workflow)
  const schedule = definitionFor(projection.resolvedDefinitions, terminal.occurrence.schedule)
  if (employee.kind !== "microEmployee") fail("terminal employee reference does not resolve to a micro-employee")
  if (job.kind !== "job") fail("terminal job reference does not resolve to a job")
  if (workflow.kind !== "workflow") fail("terminal workflow reference does not resolve to a workflow")
  if (schedule.kind !== "schedule") fail("terminal schedule reference does not resolve to a schedule")
  const employeeDefinition = employee as Extract<WorkforceDefinition, { readonly kind: "microEmployee" }>
  const jobDefinition = job as Extract<WorkforceDefinition, { readonly kind: "job" }>
  const workflowDefinition = workflow as Extract<WorkforceDefinition, { readonly kind: "workflow" }>
  const scheduleDefinition = schedule as Extract<WorkforceDefinition, { readonly kind: "schedule" }>
  if (!employeeDefinition.jobRefs.some((ref) => sameRef(ref, terminal.run.job))) fail("employee does not own the terminal job")
  if (!sameRef(jobDefinition.workflowRef, terminal.run.workflow)) fail("job does not point to the terminal workflow")
  if (workflowDefinition.scheduleRef === null || !sameRef(workflowDefinition.scheduleRef, terminal.occurrence.schedule)) fail("workflow does not point to the terminal schedule")
  if (!scheduleDefinition.occurrenceIds.includes(terminal.occurrence.occurrenceId)) fail("schedule does not contain the terminal occurrence")
  for (const [label, value] of [
    ["microEmployee", employeeDefinition.label],
    ["job", jobDefinition.label],
    ["workflow", workflowDefinition.label],
    ["schedule", scheduleDefinition.label]
  ] as const) {
    if (value.length > 200) fail(`${label} label exceeds the workforce authority label limit`)
  }
  for (const councilRef of workflowDefinition.councilRefs) {
    const council = definitionFor(projection.resolvedDefinitions, councilRef)
    if (council.kind !== "council" || !council.memberRefs.some((ref) => sameRef(ref, terminal.run.microEmployee))) {
      fail(`council ${refKey(councilRef)} does not include the terminal employee`)
    }
  }
  if (terminalFact.observation.result.kind !== terminal.result.kind || terminalFact.observation.result.summary !== terminal.result.summary) {
    fail("terminal result fact does not match the terminal result event")
  }
  if (input.reportText !== terminal.result.summary) fail("reportText must be the terminal result summary")

  const report = canonicalStandupPublicationText(input.reportText)
  const bundleCanonical = canonicalJson(bundle)
  const bundleDigest = digest("athenaeum.workforce-definition-bundle.v1", bundle)
  const terminalEventDigest = digest("athenaeum.workforce-terminal-event.v1", terminal)
  const terminalFactDigest = digest("athenaeum.workforce-terminal-fact.v1", terminalFact)
  const dailyNoteId = canonicalDailyNoteIdForCivilDate(terminal.occurrence.civilDate)
  const slot = {
    version: STANDUP_PUBLICATION_SLOT_IDENTITY_VERSION,
    workspaceId: input.workspaceId,
    dailyNoteId,
    runIdentityVersion: RUN_IDENTITY_VERSION,
    microEmployee: terminal.run.microEmployee,
    job: terminal.run.job,
    workflow: terminal.run.workflow,
    schedule: terminal.occurrence.schedule,
    runId: terminal.run.runId,
    occurrenceId: terminal.occurrence.occurrenceId,
    civilDate: terminal.occurrence.civilDate,
    councilRefs: workflowDefinition.councilRefs
  }
  const requestIdentity = standupPublicationRequestIdentity(slot)
  const commitMessage = boundedCommitMessage(job.label, terminal.result.kind, terminal.result.summary)
  const admissionFingerprint = digest("athenaeum.workforce-run-admission.v1", {
    version: WORKFORCE_RUN_AUTHORITY_VERSION,
    requestIdentity,
    bundleDigest,
    terminalEventDigest,
    terminalFactDigest,
    reportDigest: report.sha256,
    reportByteLength: report.byteLength,
    commitMessageDerivationVersion: WORKFORCE_RUN_MESSAGE_DERIVATION_VERSION,
    commitMessage
  })
  return Object.freeze({
    workspaceId: input.workspaceId,
    bundle,
    bundleCanonical,
    bundleDigest,
    terminal,
    terminalEventDigest,
    terminalFact,
    terminalFactDigest,
    reportText: input.reportText,
    reportDigest: report.sha256,
    reportByteLength: report.byteLength,
    requestIdentity,
    admissionFingerprint,
    dailyNoteId,
    commitMessage
  })
}

const projectWorkforceBundle = (bundle: WorkforceStandupInput) => projectWorkforceStandup(bundle)

export const grantForWorkforceAdmission = (
  admission: ReturnType<typeof decodeWorkforceRunAdmission>,
  now: string,
  grantId: string
): ResolvedStandupRunGrantV1 => {
  const issuedAt = new Date(now)
  if (Number.isNaN(issuedAt.valueOf()) || issuedAt.toISOString() !== now) fail("authority clock must return a canonical UTC instant")
  const expiresAt = new Date(issuedAt.valueOf() + STANDUP_RUN_GRANT_MAX_TTL_MS)
  const terminal = admission.terminal
  const workflow = admission.bundle.workflows.state === "known"
    ? admission.bundle.workflows.values.find((candidate) => candidate.id === terminal.run.workflow.id && candidate.version === terminal.run.workflow.version)
    : undefined
  if (workflow === undefined || workflow.kind !== "workflow") fail("terminal workflow definition disappeared")
  const workflowDefinition = workflow as Extract<WorkforceDefinition, { readonly kind: "workflow" }>
  return resolveStandupRunGrant({
    version: STANDUP_PRIVATE_GRANT_VERSION,
    issuerId: "athenaeum-workforce-authority",
    grantId,
    grantRecordVersion: "1",
    workspaceId: admission.workspaceId,
    civilDate: terminal.occurrence.civilDate,
    dailyNoteId: admission.dailyNoteId,
    runIdentityVersion: RUN_IDENTITY_VERSION,
    microEmployee: terminal.run.microEmployee,
    job: terminal.run.job,
    workflow: terminal.run.workflow,
    schedule: terminal.occurrence.schedule,
    councilRefs: workflowDefinition.councilRefs,
    runId: terminal.run.runId,
    occurrenceId: terminal.occurrence.occurrenceId,
    microEmployeeLabel: definitionFor(admission.bundle.microEmployees.state === "known" ? admission.bundle.microEmployees.values : [], terminal.run.microEmployee).label,
    jobLabel: definitionFor(admission.bundle.jobs.state === "known" ? admission.bundle.jobs.values : [], terminal.run.job).label,
    workflowLabel: workflowDefinition.label,
    scheduleLabel: definitionFor(admission.bundle.schedules.state === "known" ? admission.bundle.schedules.values : [], terminal.occurrence.schedule).label,
    subject: `workforce:employee:${terminal.run.microEmployee.id}`,
    replayAudience: `workforce:workspace:${admission.workspaceId}`,
    actorKind: "system",
    authorityGeneration: "athenaeum-workforce-authority.v1",
    revocationId: `workforce:${admission.workspaceId}`,
    revocationGeneration: "0",
    policyVersion: "athenaeum-workforce-policy.v1",
    issuedAt: now,
    expiresAt: expiresAt.toISOString(),
    oneUseBudget: 1
  })
}

export const publicWorkforceReceipt = (receipt: WorkforceRunReceiptV1, replayed: boolean): WorkforceRunReceiptOutputV1 => Object.freeze({
  version: WORKFORCE_RUN_AUTHORITY_VERSION,
  requestIdentity: receipt.requestIdentity,
  runId: receipt.runId,
  occurrenceId: receipt.occurrenceId,
  civilDate: receipt.civilDate,
  resultKind: receipt.resultKind,
  resultSummary: receipt.resultSummary,
  publicationId: receipt.publicationId,
  dailyNoteId: receipt.dailyNoteId,
  childNodeId: receipt.childNodeId,
  commitMessage: receipt.commitMessage,
  committedAt: receipt.committedAt,
  replayed
})

const storedNonBlank = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`corrupt workforce run receipt: ${field}`)
  return value
}

const parseReceipt = (value: string): WorkforceRunReceiptV1 => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`corrupt workforce run receipt: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("corrupt workforce run receipt")
  const record = parsed as Record<string, unknown>
  if (record.version !== WORKFORCE_RUN_RECEIPT_VERSION) throw new Error("corrupt workforce run receipt version")
  for (const field of [
    "requestIdentity", "admissionFingerprint", "workspaceId", "runId", "occurrenceId", "civilDate",
    "terminalEventId", "terminalEventDigest", "terminalFactId", "terminalFactDigest", "resultSummary",
    "reportDigest", "definitionBundleDigest", "definitionBundle", "commitMessage", "publicationId",
    "dailyNoteId", "childNodeId", "custodyFingerprint", "committedAt"
  ]) storedNonBlank(record[field], field)
  if (!Number.isSafeInteger(record.reportByteLength) || (record.reportByteLength as number) < 1) throw new Error("corrupt workforce run receipt: reportByteLength")
  if (record.resultKind !== "completed" && record.resultKind !== "blocked" && record.resultKind !== "failed" && record.resultKind !== "skipped") throw new Error("corrupt workforce run receipt: resultKind")
  const grant = resolveStandupRunGrant(record.grant)
  if (grant.workspaceId !== record.workspaceId || grant.runId !== record.runId || grant.occurrenceId !== record.occurrenceId || grant.dailyNoteId !== record.dailyNoteId) {
    throw new Error("corrupt workforce run receipt: grant identity mismatch")
  }
  let rawBundle: unknown
  try {
    rawBundle = JSON.parse(record.definitionBundle as string)
  } catch (error) {
    throw new Error(`corrupt workforce run receipt: definitionBundle is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  let admission: ReturnType<typeof decodeWorkforceRunAdmission>
  try {
    admission = decodeWorkforceRunAdmission({
      workspaceId: record.workspaceId as AdmitWorkforceRunInput["workspaceId"],
      bundle: rawBundle,
      reportText: record.resultSummary as string
    })
  } catch (error) {
    throw new Error(`corrupt workforce run receipt: immutable bundle validation failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const intent = resolvePrivatePublicationIntent(grant, {
    version: STANDUP_PRIVATE_REQUEST_VERSION,
    originalText: record.resultSummary as string
  })
  if (
    admission.requestIdentity !== record.requestIdentity ||
    admission.admissionFingerprint !== record.admissionFingerprint ||
    admission.bundleCanonical !== record.definitionBundle ||
    admission.bundleDigest !== record.definitionBundleDigest ||
    admission.terminal.eventId !== record.terminalEventId ||
    admission.terminalEventDigest !== record.terminalEventDigest ||
    admission.terminalFact.factId !== record.terminalFactId ||
    admission.terminalFactDigest !== record.terminalFactDigest ||
    admission.terminal.result.kind !== record.resultKind ||
    admission.reportDigest !== record.reportDigest ||
    admission.reportByteLength !== record.reportByteLength ||
    admission.commitMessage !== record.commitMessage ||
    admission.dailyNoteId !== record.dailyNoteId ||
    intent.custodyFingerprint !== record.custodyFingerprint ||
    intent.publicationId !== record.publicationId ||
    intent.childNodeId !== record.childNodeId
  ) throw new Error("corrupt workforce run receipt: immutable digest or publication binding mismatch")
  return Object.freeze({
    version: WORKFORCE_RUN_RECEIPT_VERSION,
    requestIdentity: record.requestIdentity as string,
    admissionFingerprint: record.admissionFingerprint as string,
    workspaceId: record.workspaceId as string,
    runId: record.runId as string,
    occurrenceId: record.occurrenceId as string,
    civilDate: record.civilDate as string,
    terminalEventId: record.terminalEventId as string,
    terminalEventDigest: record.terminalEventDigest as string,
    terminalFactId: record.terminalFactId as string,
    terminalFactDigest: record.terminalFactDigest as string,
    resultKind: record.resultKind as WorkforceRunReceiptV1["resultKind"],
    resultSummary: record.resultSummary as string,
    reportDigest: record.reportDigest as string,
    reportByteLength: record.reportByteLength as number,
    definitionBundleDigest: record.definitionBundleDigest as string,
    definitionBundle: record.definitionBundle as string,
    grant,
    commitMessage: record.commitMessage as string,
    publicationId: record.publicationId as string,
    dailyNoteId: record.dailyNoteId as string,
    childNodeId: record.childNodeId as string,
    custodyFingerprint: record.custodyFingerprint as string,
    committedAt: record.committedAt as string
  })
}

/** SQL receipt table used inside the owning Workspace DO transaction. */
export class DurableWorkforceRunReceiptStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS workforce_runs (
      requestIdentity TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL,
      runId TEXT NOT NULL,
      occurrenceId TEXT NOT NULL,
      publicationId TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL
    )`)
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS workforce_runs_slot
      ON workforce_runs (workspaceId, runId, occurrenceId)`)
  }

  get(requestIdentity: string): WorkforceRunReceiptV1 | undefined {
    const row = this.sql.exec<{ value: string }>(
      "SELECT value FROM workforce_runs WHERE requestIdentity = ?",
      requestIdentity
    ).toArray()[0]
    return row === undefined ? undefined : parseReceipt(row.value)
  }

  getBySlot(workspaceId: string, runId: string, occurrenceId: string): WorkforceRunReceiptV1 | undefined {
    const row = this.sql.exec<{ value: string }>(
      "SELECT value FROM workforce_runs WHERE workspaceId = ? AND runId = ? AND occurrenceId = ?",
      workspaceId,
      runId,
      occurrenceId
    ).toArray()[0]
    return row === undefined ? undefined : parseReceipt(row.value)
  }

  /** Resolve the receipt companion for one immutable publication. The SQL index is only an
   * accelerator: each denormalized key is rebound to the self-validating receipt before callers
   * can use it, so a substituted row can never acquire another publication's public outcome. */
  getByPublicationId(publicationId: string): WorkforceRunReceiptV1 | undefined {
    const row = this.sql.exec<{
      publicationId: string
      workspaceId: string
      runId: string
      occurrenceId: string
      value: string
    }>(
      "SELECT publicationId, workspaceId, runId, occurrenceId, value FROM workforce_runs WHERE publicationId = ?",
      publicationId
    ).toArray()[0]
    if (row === undefined) return undefined
    const receipt = parseReceipt(row.value)
    if (
      row.publicationId !== receipt.publicationId ||
      row.workspaceId !== receipt.workspaceId ||
      row.runId !== receipt.runId ||
      row.occurrenceId !== receipt.occurrenceId
    ) throw new Error("corrupt workforce run receipt row binding")
    return receipt
  }

  stage(receipt: WorkforceRunReceiptV1): void {
    if (receipt.version !== WORKFORCE_RUN_RECEIPT_VERSION) throw new Error("unsupported workforce run receipt version")
    const existing = this.get(receipt.requestIdentity)
    if (existing !== undefined) {
      if (existing.admissionFingerprint !== receipt.admissionFingerprint) throw new WorkforceRunConflictError()
      throw new WorkforceRunConflictError("workforce run receipt already exists")
    }
    const existingSlot = this.getBySlot(receipt.workspaceId, receipt.runId, receipt.occurrenceId)
    if (existingSlot !== undefined) throw new WorkforceRunConflictError("workforce run slot already has a receipt")
    this.sql.exec(
      `INSERT INTO workforce_runs (requestIdentity, workspaceId, runId, occurrenceId, publicationId, value)
       VALUES (?, ?, ?, ?, ?, ?)`,
      receipt.requestIdentity,
      receipt.workspaceId,
      receipt.runId,
      receipt.occurrenceId,
      receipt.publicationId,
      JSON.stringify(receipt)
    )
  }
}
