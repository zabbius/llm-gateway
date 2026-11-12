# ADR-002: Model-ID prefix routing (`{upstreamId}/{model}`)

## Status

Accepted

## Context

Clients speak the OpenAI protocol and select a model by a plain model-ID string. The gateway aggregates provider connections behind one upstream layer ([ADR-001](./001-upstream-per-provider-type.md)), and the same upstream model name can be exposed by more than one connection (e.g. two OpenAI-compatible provider APIs both serving `llama-3.1-8b-instruct`). For every LLM request the gateway must resolve the client-supplied model ID to exactly one upstream connection and one upstream model name; `GET /models` must return a flat aggregated list across all connections.

Routing sits on the hot path of every request, and model IDs get baked into client configurations — the ID format is effectively irreversible once clients depend on it. The routing behaviour is detailed in [Routing domain](../domains/routing.md); the client-facing surface in [Contract: Client <-> Gateway](../contracts/client-gateway.md).

## Decision

The public model ID is `{upstreamId}/{model}`:

- `GET /models` returns the aggregated flat list using prefixed IDs, so the list is self-describing.
- On an LLM request the core splits the incoming model ID at the first `/`: the prefix selects the upstream connection, and the remainder — including any further `/` — is the upstream model name passed through unchanged.
- Upstream IDs never contain `/`; a model ID whose prefix matches no upstream is rejected with a routing error.

Resolution is a pure string operation: no mapping table, no per-request state.

## Consequences

Positive:

- Collision-free by construction — identical upstream model names on different connections stay distinct.
- No mapping table to maintain or keep in sync; behaviour is identical across environments and config copies.
- Standard OpenAI SDKs work unmodified — the model ID is an opaque string to the client.
- The aggregated model list tells the client which gateway connection serves each model.

Negative:

- Prefixed IDs become semi-stable public identifiers: renaming an upstream ID remaps client configurations, logs, and usage records.
- Upstream model names containing `/` produce nested-looking public IDs; first-slash splitting supports them, but the convention must be documented in the routing spec.
- The public ID is not byte-identical to the upstream model name — clients copying upstream names verbatim get a routing error.

## Alternatives Considered

- **Per-upstream URL paths** (`/upstreams/{upstreamId}/v1/chat/completions`): rejected — breaks standard OpenAI clients and SDKs, which target one fixed base URL with fixed protocol paths; the gateway would expose and maintain per-upstream path variants; routing through a single aggregated endpoint disappears, along with a single aggregated model list.
- **Header-based routing** (e.g. `X-Gateway-Upstream: <id>` plus bare model names): rejected — non-standard for OpenAI SDKs; clients would need custom headers that most SDK tooling cannot set conveniently; the routing key is invisible in `model`, so the aggregated list cannot be self-describing; identical model names on different connections remain ambiguous.
- **Config-side mapping without prefixes** (bare model names mapped to connections in gateway config): rejected — bare names collide when several connections expose the same model, forcing ad-hoc renames in config; the mapping must be kept in sync with upstream configuration by hand; any mismatch surfaces as a runtime routing error instead of being structurally impossible.
