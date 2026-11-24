# Specification System

This document defines the format, rules, and procedures for creating and maintaining project specifications. It is the source of truth for how specs are structured.

## Purpose

Specifications provide AI coding agents with deterministic context about system behavior, interfaces, and architectural decisions. They enable agents to make safe, informed changes without extensive codebase exploration.

## Principles

1. **Self-standing documents** — specs are NOT generated from code. They describe intended behavior; a discrepancy between spec and code indicates a bug (in the code or the spec — determine by context).
2. **Agent-optimized** — predictable structure, explicit cross-references, no filler prose. Every section has a purpose.
3. **Living documents** — updated after code changes that alter documented behavior. Never silently drifting.
4. **Domain-based** — organized by conceptual domains, NOT by file/directory structure.
5. **Contracts are first-class** — cross-boundary interfaces deserve their own documents.

## File Organization

```
specs/
├── META.md                         this file
├── INDEX.md                        navigation: task -> spec file(s)
│
├── architecture/                   system-level concerns (layers, flows, security)
│   ├── layers.md                   layer hierarchy, import rules, responsibilities
│   ├── data-flow.md                request lifecycle through the gateway
│   └── security-model.md           authentication, key handling, isolation
│
├── domains/                        by business domain (NOT file structure)
│   ├── upstreams/
│   │   ├── README.md               upstream domain overview
│   │   ├── upstream-contract.md    the Upstream interface, connect -> serve lifecycle
│   │   └── openai-compatible.md    MVP upstream: pure proxy to an OpenAI-compatible provider API
│   ├── routing.md                  alias routing, client-scoped model catalog, dispatch, startup route inventory
│   ├── load-balancing.md           route selection strategies, in-memory route health, session affinity, failover
│   ├── model-metadata.md           per-alias limits/capabilities: detection, aggregation, the listing's discover=1 swap, CRUD probes
│   ├── configuration.md            config file location, JSON schema, startup validation, the runtime store's write-back
│   ├── observability.md            leveled pino logging to stderr
│   ├── frontend.md                 SPA shell (React + Bootstrap), /ui/* client-side routing + management sections
│   └── api-docs.md                 the /docs documentation surface: build-time OpenAPI artifact + Swagger UI shell
│
├── contracts/                      interfaces between layers
│   ├── client-gateway.md           HTTP client <-> gateway (OpenAI protocol)
│   ├── gateway-management.md       management API <-> operators/SPA (the mutation-capable /api/*)
│   └── gateway-upstream.md         gateway upstreams <-> upstream provider APIs
│
└── decisions/                      Architecture Decision Records
    ├── _template.md                        ADR template
    ├── 001-upstream-per-provider-type.md   upstream per provider connection, common interface
    ├── 002-hono-http-framework.md          Hono on Bun, edge-only handlers
    ├── 003-pino-stderr-logging.md          pino, JSON lines to stderr, no file logger
    ├── 004-per-upstream-tls-pinning.md     per-upstream TLS SPKI pinning via `tlsFingerprint`
    ├── 005-gateway-surface-namespace.md    surface namespace: LLM /llm/v1, management /api, SPA /ui
    ├── 006-tls-listener-server-block.md    listener under a `server` block, explicit TLS
    ├── 007-management-cookie-auth.md       cookie-session auth for the management surface (stage 1)
    ├── 008-client-bearer-auth.md           Bearer-token auth for the LLM surface (stage 2)
    ├── 009-alias-table-routing.md          model id = configured alias, per-client ACL, balance
    ├── 010-session-affinity.md             session affinity on the completion surface
    ├── 011-management-live-model-listing.md operator-triggered live model listing on the management surface
    ├── 012-alias-model-metadata.md         alias model metadata: c0wrk detector port, discovery, advisory-only
    ├── 013-openapi-docs-surface.md         the /docs surface: build-time OpenAPI artifact + Swagger UI shell
    ├── 014-runtime-management-crud.md      runtime management CRUD on /api: write-back, hot apply, discover
    ├── 015-adopt-react-bootstrap.md         react-bootstrap as the SPA component layer, the shared ConfirmModal
    └── 016-discover-folded-into-live-listing.md discover folded into the live listing (discover=1)
```

This tree is the canonical layout of the spec system: every spec file under `specs/` lands at the path shown here.

## Naming Conventions

- Files: `kebab-case.md`
- Directories within `domains/`: created when a domain requires multiple files
- `README.md` inside a domain directory: overview and entry point for that domain
- `_template.md` prefix: template files (not actual specs)
- ADR files: `NNN-kebab-case-slug.md` (three-digit number, kebab-case slug; numbers are unique tree-wide — a duplicate reaching the tree is resolved by renumbering the second-landed record)

## Document Formats

### Domain README (`domains/*/README.md` or `domains/*.md`)

Required sections in order:

```markdown
# [Domain Name]

## Purpose

1-3 sentences. What this domain does in the system.

## Key Files

- `path/from/repo/root/file.ext` — role description

## Core Types

Key type definitions (code blocks) with brief explanations.

## Flow

ASCII diagram or numbered sequence showing the primary happy path.

## Invariants

Bullet list of properties that ALWAYS hold. Use affirmative phrasing.

## Configuration

Key parameters from configuration with defaults and valid values.

## Extension Points

How to add new behavior without breaking existing functionality.

## Related Specs

- [link](relative/path.md) — context of relationship
```

### Domain Detail (`domains/*/<name>.md`)

For individual components within a domain:

```markdown
# [Component Name]

## Role

1 sentence: what this component does within its domain.

## Key Files

- `path/to/file.ext` — description

## Behavior

Detailed description. May include:
- State machines (ASCII)
- Decision tables
- Pseudocode
- Sequence diagrams

## Error Handling

How this component handles and propagates errors.

## Invariants

Properties that always hold for this component.

## Related Specs

- [link](relative/path.md) — relationship context
```

### Contract (`contracts/*.md`)

```markdown
# Contract: [Layer A] <-> [Layer B]

## Boundary Rule

One sentence: direction of dependency and what is NOT allowed.

## Interfaces

| Interface | Package | Consumed By | Purpose |
| --------- | ------- | ----------- | ------- |

## Initialization

How components are wired together at startup.

## Data Flow Across Boundary

What data crosses this boundary, in what form, in which direction.

## Error Propagation

Rules for wrapping/transforming errors at this boundary.

## Breaking Change Checklist

If you change X, you MUST also update Y.
```

### Architecture (`architecture/*.md`)

```markdown
# [Topic]

## Context

Why this architectural aspect matters.

## [Main Content]

Diagrams, rules, descriptions. Structure varies by topic.

## Invariants

Architectural rules that must never be violated.

## Anti-Patterns

What NOT to do, with brief explanation of why.
```

### ADR (`decisions/NNN-slug.md`)

```markdown
# ADR-NNN: [Title]

## Status

Accepted

## Context

The problem or question that required a decision.

## Decision

What was decided.

## Consequences

Positive and negative impacts on the codebase.

## Alternatives Considered

What was evaluated and why it was rejected.
```

## Cross-References

- Always use paths relative to the file containing the link (a link in `specs/domains/upstreams/README.md` to the routing spec is `../routing.md`, not `domains/routing.md`)
- Format: `[display text](relative/path.md)`
- For intra-file section references: `[display text](relative/path.md#section-name)` (lowercase, hyphens)
- When referencing source code: backtick path from repo root, e.g. `src/gateway/router.ts`

## Update Protocol

### When to update

- After any change that alters documented behavior
- After adding/removing/renaming interfaces that appear in a contract
- After changing architectural boundaries or invariants
- After changing the config schema (a top-level or per-upstream key added, removed, or renamed, or a new upstream `type` registered): `config.example.json` is updated in the same change — the rule and its enforcement test are documented in [domains/configuration.md](./domains/configuration.md)
- After a decision that passes the ADR bar — constrains work beyond the immediate change (cross-domain, cross-cutting, or hard to reverse) AND had real alternatives considered and rejected, or reverses an existing ADR or documented invariant — create an ADR; otherwise record it in the affected domain spec

### How to update

1. Read the current spec fully before modifying
2. Preserve the document format (sections, ordering) defined in this META.md
3. Update cross-references if file paths changed
4. After adding or removing a spec file, update `INDEX.md`
5. The project is pre-release — there is no decision history to preserve. An accepted ADR whose decision changes is rewritten in place: context, decision, consequences, and alternatives restated for the current truth; the ADR set never grows supersede chains. A retired decision's ADR file is deleted and the remaining ADRs are renumbered to keep the sequence contiguous, with every cross-reference updated in the same change

### Validation checklist

- [ ] All sections from the template are present
- [ ] Cross-references point to existing files
- [ ] Code paths in Key Files are accurate
- [ ] Invariants are stated affirmatively
- [ ] INDEX.md reflects the current file set
