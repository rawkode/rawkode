import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { DurableWorkforceRuntimeStore } from "./workforce-runtime-store.js"

export type WorkforceRunExecutor = (run: NonNullable<ReturnType<DurableWorkforceRuntimeStore["claimDue"]>>) => Promise<void>
/** Owns the single DO alarm.  Any caller may ask for a drain; claim CAS provides correctness. */
export class WorkforceScheduler {
  private executor: WorkforceRunExecutor | undefined
  private workflowIds: readonly string[] | undefined
  constructor(private readonly storage: DurableObjectStorage, private readonly store: DurableWorkforceRuntimeStore, executor?: WorkforceRunExecutor, workflowIds?: readonly string[]) {
    this.executor = executor
    this.workflowIds = workflowIds
  }
  setExecutor(executor: WorkforceRunExecutor, workflowIds: readonly string[]): void {
    if (this.executor !== undefined || workflowIds.length === 0) throw new Error("invalid workforce executor registration")
    this.executor = executor
    this.workflowIds = [...workflowIds]
  }
  async rearm(): Promise<void> { const due = this.store.nextDueAt(); if (due) await this.storage.setAlarm(due.getTime()); else await this.storage.deleteAlarm() }
  async drain(owner: string, now = new Date()): Promise<void> {
    // Runtime plumbing may be deployed before an executor package. Never claim work we cannot run.
    if (!this.executor) { await this.rearm(); return }
    const token = crypto.randomUUID(), run = this.storage.transactionSync(() => this.store.claimDue(now, owner, token, 60_000, this.workflowIds))
    await this.rearm()
    if (run && this.executor) {
      await this.executor(run)
      // Executors terminalize/retry through the same store; never rely on the previous alarm
      // after a completion, retry, or a DO eviction between those two operations.
      await this.rearm()
    }
  }
}
