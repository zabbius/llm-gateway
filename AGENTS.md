# AGENTS.md

llm-gateway is an OpenAI-protocol proxy: clients speak the OpenAI API, and the gateway forwards each request to the provider adapter selected by the model-id prefix (`{adapterId}/{model}`), streaming the answer back. One gateway fronts many upstream LLM providers behind a single fixed client surface.

- **Stack (MVP):** TypeScript on Bun, Hono as the HTTP framework, JSON configuration, pino logging to stderr.
- **Status:** greenfield — no source code yet. The specs under `specs/` are design contracts: source paths in them are planned paths, marked `<!-- TODO: verify -->` until the code exists.

## Specifications

Detailed system specs live in `specs/`. Before making structural changes, read the relevant spec:

- Start with `specs/INDEX.md` to find the right document for your task.
- `specs/META.md` defines spec formats and update rules.
