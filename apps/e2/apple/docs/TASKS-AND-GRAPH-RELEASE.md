# Tasks and voice graph tools — release candidate

Status: locally implemented and verified; production deployment and TestFlight delivery pending approval. This document is not evidence of a live release.

## User-facing changes

- Native iPhone and Mac Tasks workspace: Inbox, Today and overdue, Upcoming, Completed; search, capture, due day, priority, completion and reopening.
- Account-and-origin-scoped task cache and persistent outbox. Pending writes remain visible offline and survive relaunch. Revision conflicts preserve the local edit for review.
- Voice code mode can search graph entities, inspect Supertags and fields, read bounded entity/note content, and list/read/create/update/complete tasks. Owner identity comes from authenticated host state.
- Tasks use canonical graph entities. Provider-imported issues and PRs are not automatically treated as personal tasks.

## Verification

- 31 focused backend tests passed: canonical storage, HTTP task contracts, graph reads, voice task tools, and code-execution limits.
- Backend/deployment type checking, formatting and website build passed. Website build retains its existing large-chunk warning.
- iPhone and Mac builds passed. Simulator tests cover offline capture/relaunch and both Rosé Pine palettes.
- An isolated harness compiling the actual native store checks stale account scope, cache isolation, durable pending identity and stale response rejection.
- Independent source review found and verified fixes for asynchronous RPC disposal, draft account identity, and refresh/mutation races.
- Live provider-backed graph/task voice actions and production task API behavior remain unverified until deployment.

## Deployment plan

The read-only Alchemy production plan reports five Worker updates (entities, agent, GitHub, Google, website), two private entity service bindings (agent and website), and twenty unchanged resources. No deletions. Managed secret resources remain unchanged. Deploy using the complete production stack and `--stage production`.

Automatic approval review blocked production mutation setup. Await approval before applying this plan. Deploy and exercise the backend before pushing the Apple release to the automatic Xcode Cloud/TestFlight workflow.

## Deliberate limits

Recurrence, reminders, subtasks, native project/link pickers, and task-linked note editing are not included. Existing manually supertagged graph tasks are not yet surfaced: this first task collection uses explicit creation receipts to distinguish personal tasks from provider imports. Graph and note tools are read-only except for the dedicated task mutations. Unknown voice write outcomes are not retried automatically.
