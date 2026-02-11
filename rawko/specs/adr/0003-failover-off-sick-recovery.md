# ADR 0003: Standardized retries, off-sick pool, and periodic health probes

- Status: Accepted
- Date: 2026-02-11

## Context

The system must run indefinitely and handle provider/SDK instability without requiring user
intervention.

User requirements:

- Retry failed agent calls immediately up to 4 times.
- After retries are exhausted, mark agent as `off_sick`.
- Keep off-sick agents in a recovery queue.
- Probe off-sick agents every 5 minutes with a simple liveness ping.
- Any valid response marks the agent alive and re-adds it to available pool immediately.
- Support model failover per agent across multiple providers.

## Decision

Adopt a uniform runtime reliability policy for all agent roles (manager, worker, council):

- Attempt model/provider routes in configured priority order.
- On call failure, retry immediate attempts up to 4 times.
- On persistent failure, transition agent to `off_sick`.
- Run background health probes every 5 minutes.
- Reinstate agent to active pool on any successful probe response.

## Consequences

### Positive

- CLI remains self-healing during transient provider outages.
- Failover can cross providers, not only models.
- Same policy across all agent roles simplifies runtime behavior.

### Negative

- Longer degraded periods if too many agents become off-sick.
- Added scheduler complexity for health checks and reintegration.
