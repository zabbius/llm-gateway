# Frontend (SPA Stub)

## Purpose

A deliberately thin placeholder SPA pinned to the React + Bootstrap stack. The MVP ships a static stub page and the build tooling; `stats`, `admin`, and `audit` exist below only as reserved names for future pages — nothing else about them is specified here.

## Key Files

- `web/package.json` — React, Bootstrap, Vite (dev server + build) <!-- TODO: verify -->
- `web/index.html` — SPA entry document <!-- TODO: verify -->
- `web/src/main.tsx` — React mount point <!-- TODO: verify -->
- `web/src/App.tsx` — root component: the MVP stub page <!-- TODO: verify -->

## Core Types

No domain types — the MVP frontend calls no gateway API. The entire UI is:

```tsx
// MVP placeholder page
export function App() {
  return (
    <div className="container py-5">
      <h1 className="display-6">llm-gateway</h1>
      <p className="text-body-secondary">UI is under construction.</p>
    </div>
  );
}
```

Reserved page names for the future (not designed in this spec): `stats` — usage dashboards; `admin` — adapter management; `audit` — request history.

## Flow

```
development:  vite dev server (web/) ──► hot-reloading stub page ──► browser
production:   vite build ──► static build output ──► gateway serves it at /
              (the MVP page makes zero API calls)
```

## Invariants

- The MVP frontend performs zero gateway API calls — it renders a static placeholder.
- The UI stack is React + Bootstrap; no other UI framework or component library enters the MVP.
- The SPA ships as pre-built static assets; the gateway only serves files and never executes UI code server-side.
- `stats`, `admin`, `audit` appear only as reserved names — no routes, components, or backing APIs exist for them in the MVP.

## Configuration

None in the MVP — the frontend has no entry in the gateway config file. The static-serve mount point (`/` ← the build output directory) is fixed by the gateway's HTTP layer.

## Extension Points

- Future pages mount as additional React routes; the stub's Bootstrap-container layout is the shell they extend or replace.
- Any future page waits for its gateway API to be specified first — the API spec leads, the UI follows.

## Related Specs

- [META](../META.md) — this stub's place in the greenfield target tree
- [Configuration](./configuration.md) — the config the future `admin` page will visualize (no UI section exists today)
