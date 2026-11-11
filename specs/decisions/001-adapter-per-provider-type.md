# ADR-001: Adapter per provider type

## Status

Accepted

## Context

The gateway exposes a single OpenAI-protocol endpoint in front of heterogeneous LLM providers (initially OpenAI-compatible upstreams; more provider types are expected). Provider protocols differ in authentication, request/response shapes, and streaming behaviour, so the way provider integration is organized determines how new providers are added and how much of the core stays provider-agnostic.

This decision is cross-cutting: it shapes the gateway core, every provider integration, and the core↔adapters boundary ([Contract: Gateway <-> Provider Upstream](../contracts/gateway-upstream.md), [Provider adapter domain](../domains/adapters/README.md)). Once request handling is built around an integration model, replacing it means touching the hot path of every request.

## Decision

Each configured provider connection is served by its own adapter, and every adapter implements one shared base interface (base adapter class/interface). The core depends only on the base interface, never on concrete adapters. The first concrete adapter is the OpenAI-compatible adapter (configurable base URL + API key, pure pass-through proxying). Adding a provider type means adding a new adapter that implements the base interface plus a config entry — no core changes.

Which adapter handles a given request is decided by model-ID prefix routing ([ADR-002](./002-model-id-prefix-routing.md)).

## Consequences

Positive:

- The core is provider-agnostic; provider protocol details live inside adapters.
- Adding a provider is additive — a new adapter implementation plus configuration.
- Per-adapter state (credentials, base URL, connection settings) is isolated in one place.
- Adapters are testable against the base interface without the core or real upstreams.

Negative:

- The base interface must be designed up front; every interface change ripples to all adapters.
- Common plumbing (HTTP calls, streaming handling) risks duplication across adapters — mitigated by shared helpers sitting behind the interface.
- Feature gaps between providers must be handled uniformly (e.g. fail vs. drop for unsupported parameters) — the policy is defined once for the adapters domain, not improvised per call site.
- More moving parts than a single code path: adapter lifecycle (create, connect, health) needs its own management logic in the core.

## Alternatives Considered

- **Monolithic switch on provider type in the core**: rejected — does not scale; every new provider edits the same core routing/dispatch code, provider protocol details leak into core logic, and each change risks regressions across all already-supported providers. Per-provider logic also cannot be tested in isolation from the core.
- **Separate gateway instances per provider**: rejected — destroys the single entry point that is the product's core premise (one OpenAI-protocol endpoint, one aggregated model list). Clients would manage per-provider endpoints and credentials, cross-provider aggregation becomes impossible, and deployment/operations surface multiplies by the number of providers.
