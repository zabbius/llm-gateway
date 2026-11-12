# ADR-001: Upstream per provider type

## Status

Accepted

## Context

The gateway exposes a single OpenAI-protocol endpoint in front of heterogeneous LLM providers (initially OpenAI-compatible provider APIs; more provider types are expected). Provider protocols differ in authentication, request/response shapes, and streaming behaviour, so the way provider integration is organized determines how new providers are added and how much of the core stays provider-agnostic.

This decision is cross-cutting: it shapes the gateway core, every provider integration, and the core↔upstreams boundary ([Contract: Gateway <-> Provider Upstream](../contracts/gateway-upstream.md), [Upstreams domain](../domains/upstreams/README.md)). Once request handling is built around an integration model, replacing it means touching the hot path of every request.

## Decision

Each configured provider connection is served by its own upstream, and every upstream implements one shared base interface. The core depends only on the base interface, never on concrete upstreams. The first concrete upstream is the OpenAI-compatible upstream (configurable base URL + API key, pure pass-through proxying). Adding a provider type means adding a new upstream that implements the base interface plus a config entry — no core changes.

Which upstream handles a given request is decided by model-ID prefix routing ([ADR-002](./002-model-id-prefix-routing.md)).

Vocabulary: an *upstream* is one configured provider connection — a config entry plus its `Upstream` instance in `src/upstreams/`; the *provider (API)* is the remote LLM service an upstream connects to.

## Consequences

Positive:

- The core is provider-agnostic; provider protocol details live inside upstreams.
- Adding a provider is additive — a new upstream implementation plus configuration.
- Per-upstream state (credentials, base URL, connection settings) is isolated in one place.
- Upstreams are testable against the base interface without the core or a real provider.

Negative:

- The base interface must be designed up front; every interface change ripples to all upstreams.
- Common plumbing (HTTP calls, streaming handling) risks duplication across upstreams — mitigated by shared helpers sitting behind the interface.
- Feature gaps between providers must be handled uniformly (e.g. fail vs. drop for unsupported parameters) — the policy is defined once for the upstreams domain, not improvised per call site.
- More moving parts than a single code path: upstream lifecycle (create, connect, health) needs its own management logic in the core.

## Alternatives Considered

- **Monolithic switch on provider type in the core**: rejected — does not scale; every new provider edits the same core routing/dispatch code, provider protocol details leak into core logic, and each change risks regressions across all already-supported providers. Per-provider logic also cannot be tested in isolation from the core.
- **Separate gateway instances per provider**: rejected — destroys the single entry point that is the product's core premise (one OpenAI-protocol endpoint, one aggregated model list). Clients would manage per-provider endpoints and credentials, cross-provider aggregation becomes impossible, and deployment/operations surface multiplies by the number of providers.
