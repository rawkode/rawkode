# Workforce runtime boundary

The first workforce vertical is now a trusted, same-Worker admission path for one completed
micro-employee run. It proves custody and observability; it does not claim that scheduling, model
execution, MCP, or tool discovery are live yet.

## Admission contract

`WorkspaceDurableObject.admitWorkforceRun` is a native Durable Object export. It is deliberately
not part of `WorkspaceRpcApi`, the Worker HTTP surface, browser DTOs, or an unauthenticated tool
route. A caller supplies a complete, immutable workforce bundle and the terminal report text.

Before any write, the authority:

- decodes every definition and requires one connected employee, job, workflow, schedule, council,
  occurrence, run-observed event, result-observed event, and result fact;
- binds the report bytes to the terminal result summary and recomputes canonical bundle, event,
  fact, and report digests;
- derives the system actor, policy, subject, daily-note identity, publication/child identity, and
  bounded commit message from the admitted run; and
- derives a stable request identity and admission fingerprint from the immutable material.

## Atomic write and replay behavior

One Durable Object SQLite transaction owns the terminal run receipt, ledgered child-node creation,
ledgered Loro-page creation, standup publication authority records, and their event/outbox rows.
The Loro companion is populated with the exact report text before the transaction commits. The
post-commit step only publishes the prepared document into the Loro service cache.

The `workforce_runs` receipt is compare-or-replay keyed by request identity and run slot:

- an exact retry returns the original receipt without new ledger, authority, page, or feed writes;
- a changed report, bundle, event/fact digest, or slot conflicts without writes;
- a deterministic child ID cannot take over an unrelated existing node; and
- if the child page is deleted later, an exact retry returns the immutable receipt and does not
  recreate or restore historical content.

Every second-brain mutation made by this path carries `agentJob` attribution (`jobId` and `runId`)
and a non-empty commit message. The read-only `listStandupPublications` projection shows the
employee update and reports whether the live Loro companion is verified, modified, missing, or
unavailable.

## Deliberate next slices

This vertical is the runtime custody seam, not the whole autonomous workforce. The following are
still separate roadmap work:

- scheduler/alarm-driven runs and durable state-machine execution;
- model/LLM execution, MCP/plugin hosts, and per-job capability requests;
- council review, candidate routing, prompt variants, and employee lifecycle management;
- calendar/account connectors and meeting transcription; and
- richer web/native workforce views beyond the existing daily-note projection.

Those features must call this authority rather than introduce another second-brain write path.
