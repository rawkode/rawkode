# ADR-0003: statig FSM

## Status

Accepted

## Context

rawko uses a finite state machine to orchestrate agent execution. States represent agent roles, and transitions represent arbiter decisions. We need an FSM library that:

- Integrates with Rust's type system
- Supports async operations
- Allows dynamic transitions (arbiter-decided)
- Scales to multiple agents
- Potentially supports hierarchical states in future

FSM libraries evaluated:
- statig
- rust-fsm
- sm (state machine)
- smlang
- Custom implementation

## Decision

We will use the `statig` crate for finite state machine implementation.

## Consequences

### Positive

**Type Safety**
- States and events are Rust enums
- Invalid transitions caught at compile time
- Clear state definitions
- Exhaustive matching enforced

**Superstate Support**
- Hierarchical state machine capability
- States can inherit behavior from parent states
- Enables future agent groupings
- Reduces transition duplication

**Async Support**
- Works with async/await
- Compatible with Tokio runtime
- Non-blocking state transitions
- Async action handlers

**Clean API**
- Derive macros reduce boilerplate
- Intuitive transition definitions
- Easy to read and maintain
- Good documentation

**Future Flexibility**
- Can evolve to hierarchical design if needed
- Superstates allow agent categories
- Guard conditions for complex routing
- Action hooks for observability

### Negative

**Learning Curve**
- Superstate concepts take time to understand
- Macro-based API has some magic
- Documentation could be more extensive

**Compile Time**
- Procedural macros add compile time
- Complex state machines slow to compile
- Incremental compilation helps

**Dynamic Limitations**
- State machine structure defined at compile time
- Adding agents requires recompilation
- Less flexible than runtime-defined FSM

**Dependency**
- External crate dependency
- Must track upstream updates
- Potential breaking changes

## Alternatives Considered

### rust-fsm

Pros:
- Simple API
- Minimal dependencies
- Easy to understand

Cons:
- No superstate support
- Less type safety
- Limited features

Rejected because: Lack of superstate support limits future hierarchical designs.

### smlang

Pros:
- DSL-based definition
- Visual state diagrams
- Good for simple machines

Cons:
- DSL adds complexity
- Limited async support
- Less Rust-idiomatic

Rejected because: DSL approach feels foreign in Rust codebase.

### sm (state machine)

Pros:
- Compile-time verification
- No runtime overhead
- Type-safe

Cons:
- Very macro-heavy
- Hard to debug
- Limited documentation

Rejected because: Debugging difficulty outweighs benefits.

### Custom Implementation

Build FSM from scratch.

Pros:
- Exact features needed
- No dependencies
- Full control

Cons:
- Development time
- Must implement everything
- Bug risk
- Maintenance burden

Rejected because: Statig provides the needed features without reinventing the wheel.

## Usage Pattern

```rust
use statig::prelude::*;

#[derive(Default)]
pub struct AgentOrchestrator {
    context: TaskContext,
}

#[state_machine(
    initial = "State::idle()",
    state(derive(Debug, Clone)),
    superstate(derive(Debug)),
)]
impl AgentOrchestrator {
    #[state]
    async fn idle(&self, event: &Event) -> Response<State> {
        match event {
            Event::TaskReceived(task) => {
                Transition(State::selecting(task.clone()))
            }
            _ => Super
        }
    }

    #[state]
    async fn selecting(&self, event: &Event, task: &Task) -> Response<State> {
        match event {
            Event::AgentSelected(agent) => {
                Transition(State::executing(agent.clone(), task.clone()))
            }
            _ => Super
        }
    }

    #[state]
    async fn executing(&self, event: &Event, agent: &Agent, task: &Task) -> Response<State> {
        match event {
            Event::AgentComplete(result) => {
                Transition(State::evaluating(result.clone()))
            }
            Event::AgentFailed(error) => {
                Transition(State::handling_failure(error.clone()))
            }
            _ => Super
        }
    }
}
```

## Notes

- Current design uses flat states (agent roles)
- Superstates reserved for future agent categories
- Dynamic arbiter decisions work via events carrying next agent selection
