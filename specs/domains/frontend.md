# Frontend (SPA)

## Purpose

The operator-facing SPA served under `/ui/*` (namespace: [ADR-006](../decisions/006-gateway-surface-namespace.md)): a single-page shell whose left dock switches between the three MVP sections — Status (upstream health), Configuration (sanitized effective config), About (static overview) — over the read-only management API. Built with React + Bootstrap only; the gateway serves pre-built static assets and never executes UI code server-side. When the gateway gates `/api/*` ([ADR-008](../decisions/008-management-cookie-auth.md)), the shell swaps to a login card on the first `401`; the static shell itself stays public — every protected byte arrives from `/api`.

## Key Files

- `web/package.json` — React 19 + Bootstrap 5.3 dependencies, Vite build; no other runtime or UI dependency enters the SPA
- `web/vite.config.ts` — build config: `base: "/ui/"` makes every emitted asset URL resolve under the `/ui` namespace (index.html references included)
- `web/index.html` — SPA entry document (the base is handled by the Vite config — `/icon.svg` and `/src/main.tsx` are emitted under `/ui/`)
- `web/src/main.tsx` — React mount point (StrictMode, the Bootstrap CSS import)
- `web/src/router.tsx` — minimal history-API router: `usePath()` (popstate + in-app navigation listener, strips the `/ui` base), `navigate()` / `replace()` (pushState/replaceState through the base), the `Link` component (real `/ui/*` hrefs, intercepts plain clicks only), the `SectionId` set, and `sectionForPath()` (unknown paths fall back to the default section)
- `web/src/api.ts` — typed fetch helpers for the management surface (`GET /api/status`, `GET /api/configuration`, and the auth actions `POST /api/login` / `POST /api/logout` — [ADR-008](../decisions/008-management-cookie-auth.md)) mirroring the contract shapes; the only gateway calls the SPA makes. A `401` (session missing or expired) surfaces as `ApiFetchError` with `status === 401`.
- `web/src/App.tsx` — the shell: a flex row with the left dock leading (sticky aside, `border-end`) and the main content following; the dock header is the brand (the glyph inlined so it inherits `currentColor`) above the section nav (Bootstrap `nav-pills flex-column`, active highlight), plus the `Log out` control when the current session came from a login; it also canonicalizes `/ui` and `/ui/` to the default section via client-side replaceState. The auth state machine probes `GET /api/status` on mount: `401` swaps the shell to the login card (Bootstrap form, error alert on failure — the server sends no native prompt), success renders the sections — and the payload's `authenticated` bit drives the dock's `Log out` control (shown for a live session, hidden on an auth-off gateway), so it survives page reloads; the HttpOnly session cookie rides same-origin fetches automatically.
- `web/src/sections/Status.tsx` — Status section: fetches `GET /api/status` on mount plus a manual refresh button; Bootstrap table (`id`, `type`, probe badge `ok`/`failed`, `reason`); loading spinner and error alert states
- `web/src/sections/Configuration.tsx` — Configuration section: fetches `GET /api/configuration`; the `server` (`listen`, `tls`) / `logLevel` / `auth` summary and the upstream table with masked secrets rendered as returned
- `web/src/sections/About.tsx` — static About section: what llm-gateway is, the stack, the OpenAI-client baseURL hint (`<host>/llm/v1`), pointers to `README.md` and `specs/`
- `web/public/icon.svg` — brand icon (tile + white mark); served as the favicon via a `<link rel="icon">` in `web/index.html`
- `web/public/glyph.svg` — monochrome variant of the same mark, stroked with `currentColor`; its geometry is inlined into `App.tsx` for the dock header; `public/*` is copied verbatim into the build output

## Core Types

Section identity and navigation (`web/src/router.tsx`) — the section set is the SPA's route table; a new section is one more entry:

```ts
export const SECTIONS = [
  { id: "status", label: "Status" },
  { id: "configuration", label: "Configuration" },
  { id: "about", label: "About" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"]; // "status" is the default
```

Management API response shapes (`web/src/api.ts`), mirroring [gateway-management.md](../contracts/gateway-management.md):

```ts
export interface GatewayStatus {
  readonly upstreams: readonly UpstreamStatus[]; // { id, type, probe: "ok" | "failed", reason? }
  readonly authenticated: boolean; // this request carries a valid session (true only behind a login)
}
export interface GatewayConfiguration {
  readonly server: {
    readonly listen: string;
    readonly tls: { readonly enabled: boolean; readonly cert: string | null; readonly key: string | null } | null;
  };
  readonly logLevel: LogLevel; // "trace" | "debug" | "info" | "warning" | "error" | "none"
  readonly upstreams: readonly RedactedUpstreamConfig[]; // { type, id, baseUrl, apiKey: "[Configured]", tlsFingerprint: string | null }
}
```

Failures throw an `ApiFetchError` carrying the HTTP status (0 when no response arrived) and the OpenAI envelope's `message` when the body is one.

## Flow

```
gateway:  GET / ──► 302 /ui ──► any unmatched GET/HEAD /ui/* serves dist/index.html (ADR-006 fallthrough)
browser:  /ui (or /ui/) ──► React mounts ──► replaceState to /ui/status (canonical default section)
          auth probe GET /api/status ──► 401 ──► login card ──► POST /api/login ──► Set-Cookie (HttpOnly)
                                                                          └► sections render
          (a 200 probe renders the sections directly; its `authenticated` bit drives the dock's Log out —
           true behind a live session, false on an auth-off gateway — so Log out survives page reloads)
          dock Link click ──► pushState /ui/<section> + re-render (no reload; the server never sees a section path)
          deep link /ui/configuration ──► server answers with index.html ──► React reads location, renders that section
          Log out ──► POST /api/logout ──► session revoked ──► back to the login card
sections: Status        ── GET /api/status        ──► { upstreams: [...] } ──► probe table
          Configuration ── GET /api/configuration ──► { server, logLevel, auth, upstreams } ──► masked table
          About         ── no API call — static content
```

## Invariants

- The SPA's stack is React + Bootstrap — no other UI framework, router library, or component library (zero runtime dependencies beyond `react`, `react-dom`, `bootstrap`).
- The SPA calls ONLY the management surface: the read-only `GET /api/status` + `GET /api/configuration`, plus the two auth actions `POST /api/login` / `POST /api/logout` ([ADR-008](../decisions/008-management-cookie-auth.md)) — never `/llm/*`, never anything that mutates gateway state.
- The session cookie is HttpOnly: the SPA never reads the session token — login state lives in the gateway's session store, and the SPA only knows "the last API call succeeded".
- The login card is the only login affordance: the server sends no `WWW-Authenticate` header, and the SPA never stores the password beyond the login POST.
- Everything beyond `/ui` is client-side routed: the server answers every section path with the same index.html and never learns about sections; section switches happen via pushState without a reload.
- `/ui` and `/ui/` land on the default section (`/ui/status`) via client-side replaceState — the URL is canonical before the user navigates further.
- Unknown paths render the default section — the SPA has no 404 view.
- Secrets stay masked end to end: the SPA renders `apiKey` / `tlsFingerprint` exactly as the management API returns them (the fixed mask, or `null`) and has no way to unmask them.
- The SPA ships as pre-built static assets; the gateway only serves files and never executes UI code server-side.

## Configuration

None — the frontend has no entry in the gateway config file. What the HTTP layer serves (the root 302, the `/ui/*` static mount, the SPA fallback, the envelope prefixes) is fixed by [ADR-006](../decisions/006-gateway-surface-namespace.md) and implemented in `src/httpapi/app.ts`; the build-time `base: "/ui/"` in `web/vite.config.ts` keeps every emitted asset URL inside the same namespace. The data the sections display comes from the management API's effective (normalized, masked) config — not from any frontend setting.

## Extension Points

- A new section is one entry in `SECTIONS` (`web/src/router.tsx`) plus one component under `web/src/sections/` wired in `App.tsx` — the dock and the router pick it up with no server-side change (the fallback already serves index.html for the new path).
- A section that needs new gateway data waits for its management endpoint to be specified in the contract first — the API spec leads, the UI follows; the typed fetch helper joins `web/src/api.ts`.

## Related Specs

- [META](../META.md) — this spec's place in the canonical spec tree
- [Gateway management contract](../contracts/gateway-management.md) — the read-only `/api/*` surface every section consumes: shapes, masking rule, mount order
- [ADR-006: Gateway surface namespace](../decisions/006-gateway-surface-namespace.md) — fixes the SPA mount at `/ui/*`, the root `302` redirect, and the client-side routing rule
- [Configuration](./configuration.md) — the config whose sanitized view the Configuration section visualizes
