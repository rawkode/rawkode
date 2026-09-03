# Agent Guidance

Treat this as adaptable guidance, not a fixed workflow. Scale coordination, delegation, review, and verification to the task's scope, risk, ambiguity, available capabilities, and explicit instructions.

## Orchestration and Delegation

- Coordinate explicitly when work has independent questions, multiple ownership boundaries, or material integration risk. Keep one agent responsible for the overall plan, dependencies, and integration state.
- Delegate bounded exploration, implementation, or review when that improves coverage, speed, or independence. Give each assignment an objective, scope and non-goals, dependencies, expected handoff, acceptance criteria, and verification.
- Keep parallel write scopes independent. When scopes overlap, prefer one implementation owner with read-only contributors.
- Prefer compact, evidence-backed handoffs with conclusions, file references, assumptions, risks, unresolved questions, and exact verification results over raw transcripts.
- Separate planning, implementation, integration, and review when risk warrants it; keep small work direct and proportionate.

## Architecture and Review Gates

- For material work, consider an independent architecture gate before implementation and whenever a material design or risk assumption changes.
- Ask the reviewer to try to falsify the design or plan across boundaries, contracts, data flow, security and privacy, compatibility, concurrency, integration, and verification. Classify findings as `blocking` or `non-blocking`; unresolved blocking findings should pause the affected work.
- After integration, consider a read-only adversarial review of the final diff and evidence for regressions, omissions, unsafe changes, and unsupported claims.
- If the appropriate independent reviewer or capability is unavailable, disclose the missing assurance instead of treating a substitute as equivalent.

## Model and Reasoning Selection

- Choose the model and reasoning effort independently for each task or delegated assignment based on its complexity, ambiguity, risk, and evidence burden.
- Do not hard-code model names, permanent role-to-model mappings, or reasoning levels. Reassess the choice when the work or its risks change, and follow explicit user instructions when provided.

## Scope and Evidence

- Preserve unrelated user work and respect the narrowest reasonable scope.
- Match verification to the claim: a formatter, parser, build, render, deployment, device run, and live end-to-end result each establish different evidence.
- Report what was checked, what was not checked, any environmental limitations, and any remaining non-blocking risk.
