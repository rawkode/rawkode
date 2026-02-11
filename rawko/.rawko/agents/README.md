# Starter agents

This folder contains a default manager/worker/council set for local development.

The default manager route uses `provider=github` with model `gemini-3-flash-preview`, with an `openai` fallback.
The worker/council defaults use `provider=openai` with the Codex SDK (`@openai/codex-sdk`) and local Codex auth.

If a model is unavailable in your environment, update the `models` list in each agent file.
The runtime rotates through listed model routes on retries.
