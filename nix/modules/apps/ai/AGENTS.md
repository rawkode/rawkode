# Agent Rules

- Use `jj` instead of Git when the Git root contains `.jj`.
- Always use conventional commits.
- Inspect repository status and resolve the exact revision and requested scope before editing.
- Preserve unrelated working-copy and history changes.

## Model Workflow

For every material implementation task, use separate delegated agents for planning, building, and reviewing when delegation is available.

A material task changes runtime behaviour, architecture, data, dependencies, permissions, build or release configuration, or multiple files. Typo- and comment-only changes are exempt but still require scoped verification.

### 1. Optional Problem Framing — Sol

- Terra is the default operational coordinator. Do not use Sol as the continuous coordinator for repository exploration or routine delegation.
- For genuinely ambiguous, high-stakes, or architecture-heavy tasks, request one bounded framing pass from GPT-5.6 Sol (`gpt-5.6-sol`) before exploration.
- Sol identifies the hardest unknowns, architectural risks, assumptions to challenge, research questions, and acceptance threats. It does not perform a broad repository scan or produce the full execution plan.
- Return a compact framing brief to Terra. Skip this stage when the request and architecture are already clear.

### 2. Explore and Plan — Terra

- Delegate operational coordination and read-only planning to GPT-5.6 Terra (`gpt-5.6-terra`).
- Terra inspects the repository baseline, relevant instructions, existing implementation, tests, and established patterns.
- Terra may delegate independent exploration questions to additional Terra agents using effort levels appropriate to each question.
- Give each explorer a bounded question, explicit directory or component scope, and a structured output contract. Do not ask multiple agents to perform the same broad repository scan unless independent confirmation has clear value.
- Explorer handoffs contain conclusions, supporting file and line references, relevant invariants, risks, and unresolved questions. Do not forward raw tool logs or full exploration transcripts by default.
- Terra synthesizes the exploration evidence into one dependency-aware execution plan designed to be divided among multiple build agents.
- Divide the plan into the smallest useful independently assignable work packages. Each package must include:
  - a stable identifier and objective;
  - precise scope and explicit non-goals;
  - expected files or components and ownership boundaries;
  - dependencies and prerequisite packages;
  - inputs, outputs, interfaces, and handoff contracts;
  - implementation steps;
  - risks and likely conflicts;
  - acceptance criteria and exact verification commands.
- Identify which packages may run in parallel, which must run sequentially, and where integration checkpoints are required.
- Avoid assigning overlapping writes to parallel agents. If overlap is unavoidable, designate one owner and make other agents provide read-only findings or patches for that owner to integrate.
- Identify the critical path, integration owner, merge order, and final system-level verification.
- Continue without an approval pause when safe in-scope defaults exist. Ask the user only when a material product or scope decision remains unresolved.

### 3. Architecture Gate — Sol

- Before implementation, give Sol the original request, acceptance criteria, optional framing brief, Terra's proposed execution plan, and compact evidence handoffs with repository references.
- Keep this review bounded. Do not send the complete exploration transcript or duplicate raw repository context unless Sol requests a specific missing artifact.
- Sol must try to falsify the plan and identify architectural flaws, missing constraints, unsafe boundaries, needless complexity, weak abstractions, data-flow errors, security or privacy risks, migration or compatibility gaps, concurrency or sync hazards, integration risks, and insufficient verification.
- Sol returns precise amendments classified as `blocking` or `non-blocking`; it should not rewrite the whole plan when targeted corrections are sufficient.
- Terra incorporates accepted amendments and republishes the execution plan. Implementation begins only after zero blocking architecture findings remain.
- Repeat the gate only when plan changes materially affect architecture or risk.

### 4. Build — Terra or Luna

- The Terra coordinator assigns each approved work package.
- Use Terra for architectural, cross-cutting, ambiguous, high-risk, security or privacy, persistence, migration, sync, concurrency, integration, and difficult debugging work.
- Use GPT-5.6 Luna (`gpt-5.6-luna`) for bounded, well-specified, low-risk packages with clear acceptance criteria and no unresolved design decisions.
- If Luna encounters material ambiguity, an undeclared dependency, or a need to depart materially from the plan, return the package to the coordinator for Terra reassignment rather than improvising.
- Every builder must stay within its ownership boundary, follow the package contract, record deviations, preserve unrelated work, and return implementation plus verification evidence.
- Parallel builders may work only on independent scopes.

### 5. Integrate — Terra

- The Terra integration owner collects package handoffs, resolves cross-package conflicts, checks interface contracts, and runs integration and system-level verification.
- Reconcile the final diff against the approved plan and record all material deviations.
- If integration reveals a new architectural assumption or invalidates the approved design, return to the Sol architecture gate before continuing.

### 6. Final Adversarial Review — Sol

- After integration, delegate an independent final review to Sol before declaring completion. High-risk packages may receive an additional bounded Sol review before integration.
- Give Sol the original request, acceptance criteria, approved plan, package handoffs, exact revision and diff, recorded deviations, and concise verification evidence. Include raw excerpts when failures or disputed claims require them.
- Do not give Sol the builders' verdicts or ask it to confirm a preferred conclusion.
- Sol may inspect the repository and run checks, but must not edit the implementation.
- Sol must attempt to falsify correctness by looking for regressions, missed requirements, edge cases, missing tests, architectural drift, unsafe data changes, security or privacy risks, concurrency or migration failures, integration defects, and unsupported claims.
- Findings must cite evidence and be classified as `blocking` or `non-blocking`.
- Return blocking findings to the appropriate builder or integration owner. Repeat affected verification and Sol review after material fixes.
- Completion requires zero unresolved blocking findings.

## Token and Context Efficiency

- Use Sol for bounded framing and review gates, not continuous orchestration or routine repository exploration.
- Keep one Terra coordinator responsible for the repository map, execution plan, and integration state.
- Partition exploration and implementation by independent questions and ownership boundaries instead of duplicating broad context across agents.
- Prefer compact, evidence-backed handoffs with repository references. Pass the minimum sufficient context and let a reviewer request specific missing evidence.
- Reuse accepted findings and plans across stages rather than asking later agents to rediscover the same facts.

## Reasoning Effort

- Never prescribe a fixed reasoning effort globally, by role, or by model.
- Prefer leaving reasoning effort unspecified so the selected model and runtime can choose appropriately.
- If the interface requires an explicit effort, the coordinating model must choose it independently for each stage or work package based on complexity, ambiguity, risk, and evidence burden.
- Do not default Sol to Max or assume that Luna implies Low effort. Model choice and effort are separate decisions.
- Explicit user instructions about model or effort always take precedence.
- If Luna is unavailable, assign its packages to Terra.
- If Sol is unavailable, disclose that the adversarial-review gate is incomplete rather than silently substituting another model.

## Completion Gate

Before declaring work complete:

- inspect repository status, the scoped diff, and relevant ancestry;
- confirm the final diff contains only requested work;
- verify every work package and its handoff contract;
- run final integration and system-level checks;
- report material deviations from the plan;
- report exact verification commands and results;
- report Sol's verdict and remaining non-blocking risks.
