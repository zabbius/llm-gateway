# ADR-003: Hono as the HTTP framework on Bun

## Status

Accepted

## Context

The gateway's HTTP layer serves the OpenAI-protocol API (chat completions incl. SSE streaming, `GET /models` — exact surface in [Contract: Client <-> Gateway](../contracts/client-gateway.md)), client authentication, and admin endpoints, on the Bun runtime. This layer is the widest boundary in the system: auth, admin guarding, streaming, and error mapping all ride on it, so the framework choice is cross-cutting and expensive to migrate once routes and middleware exist. The framework was selected during spec bootstrap after an explicit comparison of the candidates on this runtime.

## Decision

Use Hono as the HTTP framework, running on Bun — a runtime Hono officially supports, with the app served through Bun's HTTP server. All routing and cross-cutting middleware — client auth, admin guard, logging, error-to-response mapping — is built with Hono primitives. Framework usage stays at the edge: handlers validate input and delegate to the gateway core; no business logic accumulates in middleware or handlers.

## Consequences

Positive:

- Declarative middleware composition for auth, admin access, logging, and error mapping — no hand-rolled plumbing.
- First-class streaming support for SSE responses.
- TypeScript-first, small dependency footprint, and a maintained Bun integration.
- Familiar route/middleware patterns keep the client-facing contract code readable and lower onboarding cost.

Negative:

- One more dependency on the critical path: Hono major upgrades must be tracked and evaluated.
- Some Bun-native server options are reached through Hono's Bun integration rather than directly — both layers must be understood when tuning the server.
- The framework layer invites logic creep into handlers/middleware; the edge-only rule above is the guard, enforced in review.

## Alternatives Considered

- **Bun.serve built-in only (no framework)**: rejected — routing, middleware chaining (auth, admin, logging), and error-to-response mapping would all be hand-rolled on the raw fetch handler; reimplementing exactly what a framework owns raises the maintenance and bug surface for no product value.
- **Elysia**: rejected — its 2.0 line was in beta churn at decision time; API instability on the system's widest boundary is an unacceptable risk for the MVP, however attractive its type-safety features are.
