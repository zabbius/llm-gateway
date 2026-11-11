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
│   ├── adapters/
│   │   ├── README.md               provider adapter domain overview
│   │   ├── adapter-contract.md     the Adapter interface, connect -> serve lifecycle
│   │   └── openai-compatible.md    MVP adapter: pure proxy to an OpenAI-compatible upstream
│   ├── routing.md                  prefix routing, model aggregation, dispatch
│   ├── configuration.md            config file location, JSON schema, startup validation
│   ├── observability.md            leveled pino logging to stderr
│   └── frontend.md                 SPA stub (React + Bootstrap), reserved page names
│
├── contracts/                      interfaces between layers
│   ├── client-gateway.md           HTTP client <-> gateway (OpenAI protocol)
│   └── gateway-upstream.md         provider adapters <-> upstream provider APIs
│
└── decisions/                      Architecture Decision Records
    ├── _template.md                ADR template
    ├── 001-adapter-per-provider-type.md  adapter per provider connection, common interface
    ├── 002-model-id-prefix-routing.md    public model id = {adapterId}/{model}
    ├── 003-hono-http-framework.md        Hono on Bun, edge-only handlers
    └── 004-pino-stderr-logging.md        pino, JSON lines to stderr, no file logger
```

The repository is greenfield — it has no source code yet. This tree is the **target structure**: it is authoritative before any of these files exist, and every spec file created under `specs/` must land at the path shown here. Source-code paths referenced inside specs follow the Greenfield Rule (see Update Protocol).

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

What data crosses the boundary, in what form, in which direction.

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

Accepted | Superseded by [NNN](./NNN-slug.md)

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

- Always use paths relative to the file containing the link (a link in `specs/domains/adapters/README.md` to the routing spec is `../routing.md`, not `domains/routing.md`)
- Format: `[display text](relative/path.md)`
- For intra-file section references: `[display text](relative/path.md#section-name)` (lowercase, hyphens)
- When referencing source code: backtick path from repo root, e.g. `src/gateway/router.ts`

## Update Protocol

### When to update

- After any change that alters documented behavior
- After adding/removing/renaming interfaces that appear in a contract
- After changing architectural boundaries or invariants
- After a decision that passes the ADR bar — constrains work beyond the immediate change (cross-domain, cross-cutting, or hard to reverse) AND had real alternatives considered and rejected, or contradicts/supersedes an existing ADR or documented invariant — create an ADR; otherwise record it in the affected domain spec

### Greenfield Rule

The repository currently contains no source code. Until code exists for a documented area, source paths in specs are **planned paths** — the locations the implementation is expected to create:

- Every Key Files entry for not-yet-existing code MUST end with a `<!-- TODO: verify -->` marker:

  ```markdown
  ## Key Files

  - `src/adapters/openai-compatible.ts` — OpenAI-compatible proxy adapter <!-- TODO: verify -->
  ```

- The marker is removed only after the file exists at that path and the description has been verified against the actual code. When the implementation lands at a different path, update the entry to the real path — the planned path expressed intent, not a claim about current code.
- The same marking applies to every reference to a not-yet-existing source path anywhere in a spec (contract interface tables, architecture examples, flow diagrams).
- While its `<!-- TODO: verify -->` markers are in place, a spec is a design contract: the "code paths in Key Files are accurate" validation item is deferred until the markers are removed.

### How to update

1. Read the current spec fully before modifying
2. Preserve the document format (sections, ordering) defined in this META.md
3. Update cross-references if file paths changed
4. After adding or removing a spec file, update `INDEX.md`
5. ADRs with `Status: Accepted` are immutable once committed to the repository; an uncommitted accepted ADR is an editable draft, and a committed one is superseded by a new ADR

### Validation checklist

- [ ] All sections from the template are present
- [ ] Cross-references point to existing files
- [ ] Code paths in Key Files are accurate — greenfield: each planned path carries `<!-- TODO: verify -->`; accuracy is verified when the marker is removed
- [ ] Invariants are stated affirmatively
- [ ] INDEX.md reflects the current file set
