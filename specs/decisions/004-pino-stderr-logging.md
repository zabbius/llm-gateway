# ADR-004: pino to stderr, no file logger for MVP

## Status

Accepted

## Context

Every layer of the gateway logs: routing decisions, upstream request outcomes, auth events, usage accounting. The MVP requires leveled logging — trace, debug, info, warning, error, none — written to stderr, and explicitly excludes a file logger (no in-process log files or rotation for MVP). Logging is a cross-cutting concern wired into every layer, and the requirement to prefer a ready-made library makes the library choice itself cross-cutting: swapping it later touches every call site.

## Decision

Use pino as the logging library, configured to write newline-delimited JSON to stderr. The gateway's level set maps onto pino levels — trace, debug, info, warning→warn, error — and `none` disables output entirely. The active level is read from the gateway JSON configuration at startup. The process owns no log files: persistence, rotation, and shipping are delegated to the environment that runs the process (service manager or container runtime). A file destination may be added later as a startup-configuration change without touching logging call sites.

## Consequences

Positive:

- Production-grade structured logging with levels and zero self-written logging code.
- JSON lines are machine-parseable by service managers, containers, and log shippers.
- stderr keeps stdout clean for protocol-relevant output.
- Level filtering comes free — `none` silences output, less verbose levels are suppressed by raising the configured level.

Negative:

- Running the process bare in a terminal loses logs; durable logging depends entirely on the surrounding environment (accepted for MVP).
- JSON-only output is less human-scannable during local development; a pretty-printing dev transport is developer tooling, not part of the product.
- pino is one more dependency; its `warn` level name (vs. the gateway's `warning`) must be documented so configuration users are not surprised.

## Alternatives Considered

- **Hand-rolled logger**: rejected — reinventing levels, formatting, stream handling, and later redaction; ongoing maintenance burden for zero product value.
- **winston**: rejected — its multi-transport sink architecture is machinery the MVP never uses (a single stderr destination); heavier footprint and configuration surface than the requirement needs.
- **`console.*` with custom prefixes**: rejected — no levels (so no level-based suppression), no structure (nothing to grep or parse reliably); it would inevitably grow into a hand-rolled logger anyway, at worse starting quality.
