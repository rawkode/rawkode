/**
 * Private, job-scoped authority for the first calendar relationship concierge.
 *
 * This is intentionally not an RPC contract and deliberately has no dependency on a Durable
 * Object, SQL, CalendarService, or repositories.  The future runtime owns durable claim/fence
 * checks through the injected adapter; the executor receives only these five named operations.
 */
export const CALENDAR_CONCIERGE_CAPABILITY_VERSION = "athenaeum.calendar-concierge-capability.v1" as const

declare const opaqueCalendarConciergeGrantToken: unique symbol

export type OpaqueCalendarConciergeGrantToken = Readonly<{
  readonly [opaqueCalendarConciergeGrantToken]: "athenaeum.calendar-concierge-grant"
}>

export type CalendarConciergeDefinitionRef<K extends "microEmployee" | "job" | "workflow"> = Readonly<{
  readonly kind: K
  readonly id: string
  readonly version: string
}>

export type CalendarConciergeTool =
  | "readObservedAttendee"
  | "resolveUniquePersonByEmailDigest"
  | "createCalendarPerson"
  | "recordCalendarRelationshipObservation"
  | "publishRunTerminal"

export type CalendarConciergeGrantV1 = Readonly<{
  readonly version: typeof CALENDAR_CONCIERGE_CAPABILITY_VERSION
  readonly grantId: string
  readonly grantRecordVersion: string
  readonly workspaceId: string
  readonly microEmployee: CalendarConciergeDefinitionRef<"microEmployee">
  readonly job: CalendarConciergeDefinitionRef<"job">
  readonly workflow: CalendarConciergeDefinitionRef<"workflow">
  readonly runId: string
  /** Durable claim identity.  It is never browser-visible. */
  readonly claimToken: string
  readonly claimFence: number
  readonly observationId: string
  /** Digest only: raw provider event ids and attendee email addresses stay outside this contract. */
  readonly sourceRevisionDigest: string
  readonly policyGeneration: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly allowedTools: readonly CalendarConciergeTool[]
}>

export type CalendarConciergeExecutionBinding = Readonly<{
  readonly workspaceId: string
  readonly microEmployee: CalendarConciergeDefinitionRef<"microEmployee">
  readonly job: CalendarConciergeDefinitionRef<"job">
  readonly workflow: CalendarConciergeDefinitionRef<"workflow">
  readonly runId: string
  readonly claimToken: string
  readonly claimFence: number
  readonly observationId: string
  readonly sourceRevisionDigest: string
  readonly policyGeneration: string
}>

export type CalendarConciergeCustody = Readonly<{
  readonly version: typeof CALENDAR_CONCIERGE_CAPABILITY_VERSION
  readonly workspaceId: string
  readonly actorId: string
  readonly grantId: string
  readonly grantRecordVersion: string
  readonly microEmployee: CalendarConciergeDefinitionRef<"microEmployee">
  readonly job: CalendarConciergeDefinitionRef<"job">
  readonly workflow: CalendarConciergeDefinitionRef<"workflow">
  readonly runId: string
  readonly claimFence: number
  readonly observationId: string
  readonly sourceRevisionDigest: string
  readonly policyGeneration: string
}>

export type CalendarObservedAttendee = Readonly<{
  readonly observationId: string
  readonly emailDigest: string
  readonly sourceRevisionDigest: string
}>

export type CalendarConciergeTerminalResult = "completed" | "blocked" | "failed" | "skipped"

export interface CalendarConciergeJobPort {
  readonly readObservedAttendee: (input: Readonly<{ readonly custody: CalendarConciergeCustody; readonly observationId: string; readonly sourceRevisionDigest: string }>) => CalendarObservedAttendee | undefined
  readonly resolveUniquePersonByEmailDigest: (input: Readonly<{ readonly custody: CalendarConciergeCustody; readonly emailDigest: string }>) => Readonly<{ readonly personId: string }> | undefined
  readonly createCalendarPerson: (input: Readonly<{ readonly custody: CalendarConciergeCustody; readonly emailDigest: string; readonly commitMessage: string }>) => Readonly<{ readonly personId: string }>
  readonly recordCalendarRelationshipObservation: (input: Readonly<{ readonly custody: CalendarConciergeCustody; readonly personId: string; readonly observationId: string; readonly sourceRevisionDigest: string; readonly commitMessage: string }>) => void
  readonly publishRunTerminal: (input: Readonly<{ readonly custody: CalendarConciergeCustody; readonly result: CalendarConciergeTerminalResult; readonly reportText: string; readonly commitMessage: string }>) => Readonly<{ readonly publicationId: string }>
}

/**
 * Later DO integration supplies this from the durable run store.  It must fail closed when the
 * run left claimed state, the token/fence is stale, or policy/revocation changed.
 */
export interface CalendarConciergeExecutionAdapter {
  readonly assertLiveClaim: (binding: CalendarConciergeExecutionBinding) => Readonly<{ readonly status: "admitted" | "denied" }>
}

export interface CalendarConciergeGrantResolver {
  readonly resolve: (token: OpaqueCalendarConciergeGrantToken) => unknown
  readonly recheckFresh: (grant: CalendarConciergeGrantV1, binding: CalendarConciergeExecutionBinding) => Readonly<{ readonly status: "admitted" | "denied" }>
}

export class CalendarConciergeCapabilityError extends Error {
  constructor(message: string) {
    super(`calendar concierge capability denied: ${message}`)
  }
}

const tools = new Set<CalendarConciergeTool>([
  "readObservedAttendee", "resolveUniquePersonByEmailDigest", "createCalendarPerson", "recordCalendarRelationshipObservation", "publishRunTerminal"
])

const fail = (message: string): never => { throw new CalendarConciergeCapabilityError(message) }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const exactDataRecord = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!record(value)) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && own.every((key) => typeof key === "string" && keys.includes(key) && Object.prototype.hasOwnProperty.call(value, key) && Object.prototype.propertyIsEnumerable.call(value, key) && "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}))
}
const nonBlank = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a nonblank string`)
  return value as string
}
const positiveFence = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${field} must be a positive integer`)
  return value as number
}
const instant = (value: unknown, field: string): string => {
  const text = nonBlank(value, field)
  const parsed = new Date(text)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== text) fail(`${field} must be a canonical ISO instant`)
  return text
}
const ref = <K extends "microEmployee" | "job" | "workflow">(value: unknown, kind: K, field: string): CalendarConciergeDefinitionRef<K> => {
  if (!exactDataRecord(value, ["kind", "id", "version"]) || value.kind !== kind) fail(`${field} must be an exact ${kind} reference`)
  const raw = value as Record<string, unknown>
  return Object.freeze({ kind, id: nonBlank(raw.id, `${field}.id`), version: nonBlank(raw.version, `${field}.version`) })
}
const sameRef = (left: CalendarConciergeDefinitionRef<"microEmployee" | "job" | "workflow">, right: CalendarConciergeDefinitionRef<"microEmployee" | "job" | "workflow">): boolean =>
  left.kind === right.kind && left.id === right.id && left.version === right.version

const grantKeys = ["version", "grantId", "grantRecordVersion", "workspaceId", "microEmployee", "job", "workflow", "runId", "claimToken", "claimFence", "observationId", "sourceRevisionDigest", "policyGeneration", "issuedAt", "expiresAt", "allowedTools"] as const

/** Strictly resolve an issuer-owned immutable record; a token has no minting constructor here. */
export const resolveCalendarConciergeGrant = (value: unknown): CalendarConciergeGrantV1 => {
  if (!exactDataRecord(value, grantKeys)) fail("grant has unknown, missing, or accessor fields")
  const raw = value as Record<string, unknown>
  if (raw.version !== CALENDAR_CONCIERGE_CAPABILITY_VERSION) fail("unsupported grant version")
  const rawAllowedTools = raw.allowedTools
  if (!Array.isArray(rawAllowedTools) || rawAllowedTools.length === 0) fail("allowedTools must be a nonempty exact tool list")
  const toolEntries = rawAllowedTools as unknown[]
  const allowedTools = toolEntries.map((tool: unknown, index: number) => {
    if (typeof tool !== "string" || !tools.has(tool as CalendarConciergeTool)) fail(`allowedTools[${index}] is not a registered concierge tool`)
    return tool as CalendarConciergeTool
  })
  if (new Set(allowedTools).size !== allowedTools.length) fail("allowedTools cannot contain duplicates")
  const issuedAt = instant(raw.issuedAt, "issuedAt")
  const expiresAt = instant(raw.expiresAt, "expiresAt")
  if (Date.parse(expiresAt) < Date.parse(issuedAt)) fail("expiresAt precedes issuedAt")
  return Object.freeze({
    version: CALENDAR_CONCIERGE_CAPABILITY_VERSION,
    grantId: nonBlank(raw.grantId, "grantId"), grantRecordVersion: nonBlank(raw.grantRecordVersion, "grantRecordVersion"), workspaceId: nonBlank(raw.workspaceId, "workspaceId"),
    microEmployee: ref(raw.microEmployee, "microEmployee", "microEmployee"), job: ref(raw.job, "job", "job"), workflow: ref(raw.workflow, "workflow", "workflow"),
    runId: nonBlank(raw.runId, "runId"), claimToken: nonBlank(raw.claimToken, "claimToken"), claimFence: positiveFence(raw.claimFence, "claimFence"),
    observationId: nonBlank(raw.observationId, "observationId"), sourceRevisionDigest: nonBlank(raw.sourceRevisionDigest, "sourceRevisionDigest"), policyGeneration: nonBlank(raw.policyGeneration, "policyGeneration"),
    issuedAt, expiresAt, allowedTools: Object.freeze([...allowedTools])
  })
}

const bindingFor = (grant: CalendarConciergeGrantV1): CalendarConciergeExecutionBinding => Object.freeze({
  workspaceId: grant.workspaceId, microEmployee: grant.microEmployee, job: grant.job, workflow: grant.workflow,
  runId: grant.runId, claimToken: grant.claimToken, claimFence: grant.claimFence, observationId: grant.observationId,
  sourceRevisionDigest: grant.sourceRevisionDigest, policyGeneration: grant.policyGeneration
})
const sameBinding = (left: CalendarConciergeExecutionBinding, right: CalendarConciergeExecutionBinding): boolean =>
  left.workspaceId === right.workspaceId && sameRef(left.microEmployee, right.microEmployee) && sameRef(left.job, right.job) && sameRef(left.workflow, right.workflow) &&
  left.runId === right.runId && left.claimToken === right.claimToken && left.claimFence === right.claimFence && left.observationId === right.observationId &&
  left.sourceRevisionDigest === right.sourceRevisionDigest && left.policyGeneration === right.policyGeneration
const sameGrant = (left: CalendarConciergeGrantV1, right: CalendarConciergeGrantV1): boolean =>
  left.grantId === right.grantId && left.grantRecordVersion === right.grantRecordVersion && left.issuedAt === right.issuedAt && left.expiresAt === right.expiresAt &&
  sameBinding(bindingFor(left), bindingFor(right)) && left.allowedTools.length === right.allowedTools.length && left.allowedTools.every((tool, index) => tool === right.allowedTools[index])

const custodyFor = (grant: CalendarConciergeGrantV1): CalendarConciergeCustody => Object.freeze({
  version: CALENDAR_CONCIERGE_CAPABILITY_VERSION, workspaceId: grant.workspaceId, actorId: `workforce:employee:${grant.microEmployee.id}`,
  grantId: grant.grantId, grantRecordVersion: grant.grantRecordVersion, microEmployee: grant.microEmployee, job: grant.job, workflow: grant.workflow,
  runId: grant.runId, claimFence: grant.claimFence, observationId: grant.observationId, sourceRevisionDigest: grant.sourceRevisionDigest, policyGeneration: grant.policyGeneration
})

export type CalendarConciergeJobCapability = Readonly<{
  readonly readObservedAttendee: () => CalendarObservedAttendee | undefined
  readonly resolveUniquePersonByEmailDigest: (emailDigest: string) => Readonly<{ readonly personId: string }> | undefined
  readonly createCalendarPerson: (emailDigest: string, commitMessage: string) => Readonly<{ readonly personId: string }>
  readonly recordCalendarRelationshipObservation: (personId: string, commitMessage: string) => void
  readonly publishRunTerminal: (result: CalendarConciergeTerminalResult, reportText: string, commitMessage: string) => Readonly<{ readonly publicationId: string }>
}>

export const createCalendarConciergeJobCapability = (input: Readonly<{
  readonly token: OpaqueCalendarConciergeGrantToken
  readonly binding: CalendarConciergeExecutionBinding
  readonly resolver: CalendarConciergeGrantResolver
  readonly execution: CalendarConciergeExecutionAdapter
  readonly port: CalendarConciergeJobPort
  readonly now?: () => Date
}>): CalendarConciergeJobCapability => {
  const initial = resolveCalendarConciergeGrant(input.resolver.resolve(input.token))
  const expectedBinding = bindingFor(initial)
  if (!sameBinding(expectedBinding, input.binding)) fail("job binding does not match grant")
  const now = input.now ?? (() => new Date())
  let terminal = false
  const admit = (tool: CalendarConciergeTool): CalendarConciergeCustody => {
    if (terminal) fail("grant was already used to publish a terminal result")
    const current = resolveCalendarConciergeGrant(input.resolver.resolve(input.token))
    if (!sameGrant(initial, current)) fail("grant binding changed after capability creation")
    if (Date.parse(current.expiresAt) <= now().getTime()) fail("grant is expired")
    if (!current.allowedTools.includes(tool)) fail(`tool ${tool} is not allowed by this grant`)
    if (input.resolver.recheckFresh(current, expectedBinding).status !== "admitted") fail("grant is revoked or no longer fresh")
    if (input.execution.assertLiveClaim(expectedBinding).status !== "admitted") fail("run claim is stale or no longer live")
    return custodyFor(current)
  }
  return Object.freeze({
    readObservedAttendee: () => {
      const custody = admit("readObservedAttendee")
      return input.port.readObservedAttendee({ custody, observationId: custody.observationId, sourceRevisionDigest: custody.sourceRevisionDigest })
    },
    resolveUniquePersonByEmailDigest: (emailDigest) => input.port.resolveUniquePersonByEmailDigest({ custody: admit("resolveUniquePersonByEmailDigest"), emailDigest: nonBlank(emailDigest, "emailDigest") }),
    createCalendarPerson: (emailDigest, commitMessage) => input.port.createCalendarPerson({ custody: admit("createCalendarPerson"), emailDigest: nonBlank(emailDigest, "emailDigest"), commitMessage: nonBlank(commitMessage, "commitMessage") }),
    recordCalendarRelationshipObservation: (personId, commitMessage) => {
      const custody = admit("recordCalendarRelationshipObservation")
      input.port.recordCalendarRelationshipObservation({ custody, personId: nonBlank(personId, "personId"), observationId: custody.observationId, sourceRevisionDigest: custody.sourceRevisionDigest, commitMessage: nonBlank(commitMessage, "commitMessage") })
    },
    publishRunTerminal: (result, reportText, commitMessage) => {
      if (result !== "completed" && result !== "blocked" && result !== "failed" && result !== "skipped") fail("terminal result is invalid")
      const output = input.port.publishRunTerminal({ custody: admit("publishRunTerminal"), result, reportText: nonBlank(reportText, "reportText"), commitMessage: nonBlank(commitMessage, "commitMessage") })
      terminal = true
      return output
    }
  })
}
