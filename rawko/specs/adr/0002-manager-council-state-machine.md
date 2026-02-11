# ADR 0002: Actor-style manager loop with council unanimity completion

- Status: Accepted
- Date: 2026-02-11

## Context

The system needs to run continuously, delegate work across specialized agents (including parallel
work), and determine completion by committee rather than a static checklist.

User requirements:

- Exactly one manager agent (`manager: true`) acts as entry point.
- At least one council agent (`council: true`) exists.
- Manager delegates work; manager does no direct implementation.
- Manager may delegate to multiple agents in parallel.
- Completion is declared only when council members unanimously agree.
- Council voting should happen only when manager decides it is time.
- If not unanimous, manager should only receive dissenting feedback.
- `rawko` should remain interactive after completion.

## Decision

Use an internal actor model:

- `ManagerActor`: infinite orchestration loop, delegation, and council voting trigger.
- `WorkerActor` instances: execute delegated subproblems.
- `CouncilActor` instances: completion voting when requested.
- `UserActor`: interactive user input queue to manager.

Completion gate:

- Manager requests council vote.
- Every council member must indicate completion.
- Any dissent keeps loop active and returns only dissenting feedback to manager.

## Consequences

### Positive

- Delegation strategy is flexible and prompt-driven.
- Completion criteria are explicit and multi-agent.
- Interactive control remains available throughout runtime.

### Negative

- Free-form responses require robust prompt design and interpretation.
- No strict schema means behavior quality depends on agent instructions.
