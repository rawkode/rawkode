# Modes Extension

Project-local Pi extension that switches the agent between four working modes:

- `normal`: unrestricted default mode (Pi-default behavior)
- `plan`: read/analyze and produce plans
- `council`: review/challenge and identify risks
- `build`: implement and modify code

## Commands

- `/mode` - interactive mode picker
- `/mode normal|plan|council|build` - switch directly
- `/mode-status` - show current mode and active tools
- `/mode-auto <objective>` - run `plan -> build -> council` automatically
- `/mode-stop` - stop automatic flow

## Shortcuts

- `Ctrl+Alt+P` -> `plan`
- `Ctrl+Alt+C` -> `council`
- `Ctrl+Alt+B` -> `build`

## Behavior

- Uses an `xstate` machine for mode and auto-flow state transitions.
- Defaults to `normal` when not orchestrating.
- Persists mode and auto state in session branch custom entries.
- Injects hidden mode context before each turn for `plan`/`council`/`build` only.
- `plan` and `council` block:
  - `edit` and `write` tool calls
  - mutating `bash` commands (best-effort pattern match)
- Tool profiles:
  - `normal`: all available tools (no mode-imposed restrictions)
  - `plan`: `read,bash,grep,find,ls`
  - `council`: `read,bash,grep,find,ls,subagent`
  - `build`: `read,bash,edit,write,grep,find,ls`
- Auto flow sequence:
  - `plan` -> `build` -> `council`
  - `council` must output: `VERDICT: DONE|BUILD|PLAN`
  - `DONE` ends flow and returns mode to `normal`
  - `BUILD` runs another build pass, then council
  - `PLAN` runs replanning, then build, then council
- Council fan-out:
  - If `subagent` tool is available, council runs 3 parallel reviewers (`council-claude`, `council-openai`, `council-google`) and then synthesizes on the primary model.
  - If `subagent` is unavailable, council falls back to single-model review.

## Plan Handoff

- Plan phase writes to OS cache: `<cacheDir>/.rawko/plans/plan-<uuid>.md`.
- Build and Council phases receive that file path as shared context.
- Council phase writes to OS cache: `<cacheDir>/.rawko/council/council-<uuid>.md`.
- Follow-up Plan/Build phases receive that council feedback path as shared context.

## Setup

- Dependency: `xstate` is managed by Pi via `.pi/settings.json` package source:
  - `"packages": ["npm:xstate"]`
- Pi installs missing project packages into `.pi/npm/` on startup.

## Notes

- This extension is auto-discovered from `.pi/extensions/`.
- For global usage, place it under `~/.pi/agent/extensions/`.
- Multi-model council requires a `subagent` extension and matching agent definitions in `.pi/agents/`.
