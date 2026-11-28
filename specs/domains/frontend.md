# Frontend (SPA)

## Purpose

The operator-facing SPA served under `/ui/*` (namespace: [ADR-005](../decisions/005-gateway-surface-namespace.md)): a single-page shell whose left dock switches between the five sections — Status (upstream health), Models (the alias CRUD with the effective token budgets and capability badges), Upstreams (the upstream CRUD plus the per-upstream live model catalogs), Clients (the client CRUD), About (static overview) — over the management API. The SPA drives the boundary's full sanctioned mutation set ([ADR-014](../decisions/014-runtime-management-crud.md) D5: the endpoints, their contract rows, and the SPA sections that consume them land together — the boundary never presents a mutating API its own operator UI cannot drive): the create/edit/delete forms over `upstreams`, `models` and `clients` (every delete confirms through the shared ConfirmModal — [ADR-015](../decisions/015-adopt-react-bootstrap.md)), the Load-models button (its fetch carries `discover=1` — [ADR-016](../decisions/016-discover-folded-into-live-listing.md)), and the auth actions. Built with React + Bootstrap rendered through the `react-bootstrap` component layer ([ADR-015](../decisions/015-adopt-react-bootstrap.md)); the gateway serves pre-built static assets and never executes UI code server-side. When the gateway gates `/api/*` ([ADR-007](../decisions/007-management-cookie-auth.md)), the shell swaps to a login card on the first `401`; the static shell itself stays public — every protected byte arrives from `/api`.

## Key Files

- `web/package.json` — React 19 + Bootstrap 5.3 dependencies, the `react-bootstrap` component layer ([ADR-015](../decisions/015-adopt-react-bootstrap.md)) plus the `lucide-react` icon glyphs, Vite build; every dependency ships inside the built bundle (nothing loads from an external server at runtime), and no other runtime or UI dependency enters the SPA
- `web/vite.config.ts` — build config: `base: "/ui/"` makes every emitted asset URL resolve under the `/ui` namespace (index.html references included)
- `web/index.html` — SPA entry document (the base is handled by the Vite config — `/icon.svg` and `/src/main.tsx` are emitted under `/ui/`)
- `web/src/main.tsx` — React mount point (StrictMode, the Bootstrap CSS import)
- `web/src/router.tsx` — minimal history-API router: `usePath()` (popstate + in-app navigation listener, strips the `/ui` base), `navigate()` / `replace()` (pushState/replaceState through the base), the `Link` component (real `/ui/*` hrefs, intercepts plain clicks only), the `SectionId` set, and `sectionForPath()` (unknown paths fall back to the default section)
- `web/src/api.ts` — typed fetch helpers for the management surface mirroring the contract shapes ([gateway-management.md](../contracts/gateway-management.md)): the slim `GET /api/status` probe, the three CRUD collections (list/get/create/update/delete over `/api/upstreams`, `/api/models`, `/api/clients` — [ADR-014](../decisions/014-runtime-management-crud.md)), the ADR-011 live listing `GET /api/upstreams/:id/models` (its `discover=1` variant folds the former discover mount in — [ADR-016](../decisions/016-discover-folded-into-live-listing.md)), and the auth actions `POST /api/login` / `POST /api/logout` ([ADR-007](../decisions/007-management-cookie-auth.md)) — the only gateway calls the SPA makes. One generic transport (`request` + a JSON `send` for any method); a `401` (session missing or expired) surfaces as `ApiFetchError` with `status === 401`, and every failure carries the OpenAI envelope's `message`.
- `web/src/App.tsx` — the shell: a flex row with the left dock leading (sticky aside, `border-end`) and the main content following; the dock header is the brand (the glyph inlined so it inherits `currentColor`) above the section nav (Bootstrap `nav-pills flex-column`, active highlight — every entry carries the lucide-react icon declared in its `SECTIONS` row), plus the `Log out` control (a lucide `LogOut` glyph) when the current session came from a login; it also canonicalizes `/ui` and `/ui/` to the default section via client-side replaceState. The auth state machine probes `GET /api/status` on mount: `401` swaps the shell to the login card (Bootstrap form, error alert on failure — the server sends no native prompt), success renders the sections — and the payload's `authenticated` bit drives the dock's `Log out` control (shown for a live session, hidden on an auth-off gateway), so it survives page reloads; the HttpOnly session cookie rides same-origin fetches automatically.
- `web/src/ui/ConfirmModal.tsx` — the SPA's one confirmation surface ([ADR-015](../decisions/015-adopt-react-bootstrap.md)): a react-bootstrap `Modal` driven by a caller-owned `ConfirmDialog` value — open exactly while the value is non-null, the caller clears it as part of the confirmed action; Esc, the backdrop, the header close button and Cancel only dismiss, so the action happens solely through the confirm button, which carries `variant="danger"` when the dialog is destructive. The three CRUD sections route every delete through it — the styled, non-blocking replacement for the native `window.confirm`
- `web/src/ui/EditorModal.tsx` — the CRUD sections' shared create/edit dialog shell: a react-bootstrap `Modal` whose body hosts a real `Form` carrying the caller's `onSubmit` — the footer's submit button binds to it through the HTML `form` attribute, and Enter in an input submits through the form's explicit `onKeyDown` → `requestSubmit()` (a `Modal` never roots the dialog as a form: `as="form"` leaks as an inert attribute onto the `.modal-dialog` div, so a `type="submit"` button without a form owner is a dead button, and Chromium's native implicit submission ignores an out-of-form default button), 90% of the viewport wide (`dialogClassName="modal-90w"`), static backdrop with Esc disabled — a typed editing session survives stray gestures and closing stays explicit: Cancel or the header close button, both the caller's `onClose`. The caller owns the state and passes the `title`, the body as `children` (form fields plus the submit-error alert, so submit errors surface inside the dialog, never behind the overlay) and the `onSubmit` / `onClose` events; `editing` flips the footer between Save and Create, `busy` shows the spinner and disables the buttons, `submitDisabled` carries an extra validity gate — the footer's buttons carry the lucide `Save`/`Plus`/`X` glyphs; the dialog's width override lives in `web/src/ui/modal.css` (`.modal-dialog.modal-90w { max-width: 90% }`), imported by the component
- `web/src/sections/Status.tsx` — Status section: the upstream table built from `GET /api/upstreams` (id, type, a probe column, a reason column, `baseUrl`) plus the slim `GET /api/status` verdict badge; manual refresh (a lucide `RefreshCw` glyph), loading spinner, error alert, and an empty state pointing at the Upstreams section. Since [ADR-014](../decisions/014-runtime-management-crud.md) D3 the list carries the redacted view only — no probe fields — so the probe and reason cells render “—” on every row (`probe === undefined ? "—"`, `reason ?? "—"`): the retained outcomes are startup log facts, and the two columns are the table's shape waiting for a boundary that serves them
- `web/src/sections/Models.tsx` — Models section: the models CRUD ([ADR-014](../decisions/014-runtime-management-crud.md), the [ADR-009](../decisions/009-alias-table-routing.md) alias table) — a table from `GET /api/models` (alias, the `meta` context window / output limit with unknown → “—”, the strict-AND capability flags as badges, the route set with weights) over the shared create/edit/delete form — a modal pop-up over the table (the shared EditorModal shell — a react-bootstrap Modal with a static backdrop and Esc disabled, so a typed editing session survives stray gestures and closing stays explicit via Cancel or the header close button; submit errors surface inside the dialog): `alias` immutable on edit (the path parameter owns it), route rows (upstream select fed by `GET /api/upstreams`, provider-native `model` — a select without manual input, fed by the upstream's live catalog: opening the dropdown fires the one `GET /api/upstreams/:id/models` fetch per upstream per editor visit (ADR-011 semantics: never on mount or form open), picking a listed id sets the field, a stored value renders as a plain option (the field never annotates catalog provenance), the loading / error / empty states are options inside the dropdown, and the loaded / error status text renders below the route row — it moves only what follows the row, never the row's own columns; `weight` only under the weighted strategy), the `balance.strategy` select, optional `limits.context`/`limits.output` (positive integers; both empty = no limits block); client-side checks mirror the store's grammar, and the store stays authoritative — its `400` problem lines, the `404` and the `409` `resource_in_use` refusals land as envelope-message alerts; the toolbar and table-row buttons carry lucide glyphs (`Pencil`, `Trash2`, `Plus`, `RefreshCw`); the form's `Save`/`X` footer glyphs live in the shared EditorModal
- `web/src/sections/Upstreams.tsx` — Upstreams section: the upstream CRUD ([ADR-014](../decisions/014-runtime-management-crud.md)) — a table from `GET /api/upstreams` (masks rendered exactly as returned; a `proxy` column renders the outbound proxy URL verbatim in monospace, “—” when `null` — a direct connection, [ADR-017](../decisions/017-per-upstream-outbound-proxy.md)) over Bootstrap modal create/edit pop-ups (the shared EditorModal form): `id`/`type` immutable on edit, `apiKey` optional on edit labeled “пусто = не менять” (an empty field is omitted from the body — the D7 keep-existing semantics, [ADR-018](../decisions/018-uniform-optional-value-write-policy.md); the mask literal is never submitted; create requires the key — the client-side grammar pass mirrors the store's create rules (the id pattern, the absolute http(s) `baseUrl`, the non-empty create `apiKey`, the `proxy` URL grammar) and surfaces every refusal as the in-modal alert, never a silent no-op), the pin field following the same keep-existing rule (every field is trimmed before it rides the body, and a field whose trimmed value is empty is omitted — `""` on the wire is an explicit clear, [ADR-018](../decisions/018-uniform-optional-value-write-policy.md) — so a blank edit never clears a stored pin; the SPA submits no `null`, so clearing a stored pin is a direct management-API or config-file edit, not an SPA affordance), and the `proxy` field ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)) — served verbatim (not secret), so it is pre-filled on edit; an empty field is omitted the same way (keep the stored proxy on edit, a direct connection on create), while a filled one is checked against the store's grammar client-side (an `http:` or `socks5:` URL with a non-empty host, an explicit port in 1–65535, no userinfo, path, query or fragment — the refusal names the rule, never the typed value) — and the create/update answers render the D8 blocking-probe verdict (`ok` / `reason`) as data. Below the table, one card per configured upstream with the one affordance: **Load models** (`GET /api/upstreams/:id/models?discover=1` — the ADR-011 listing as amended by [ADR-016](../decisions/016-discover-folded-into-live-listing.md), the former standalone Discover folded in: the fetch swaps the upstream's metadata slice before the answer, filterable by model id, every id click-to-copy, idle/loading/error/empty states per card, a failed load surfacing as the card's error state); the buttons carry lucide glyphs (`Copy`, `Download`, `Plus`, `RefreshCw`, `Pencil`, `Trash2`) and the form's `Save`/`X` footer glyphs live in the shared EditorModal
- `web/src/sections/Clients.tsx` — Clients section: the client CRUD ([ADR-014](../decisions/014-runtime-management-crud.md)) — a table from `GET /api/clients` (masks as returned) over the same modal-form pattern (`name` immutable on edit, `apiKey` optional on edit = keep-existing — an empty field is trimmed and omitted from the body, never submitted as `""`, which the wire reads as an explicit clear ([ADR-018](../decisions/018-uniform-optional-value-write-policy.md)); create requires the key), the alias ACL as a checkbox group fed by `GET /api/models`; the buttons carry lucide glyphs (`Plus`, `RefreshCw`, `Pencil`, `Trash2`) and the form's `Save`/`X` footer glyphs live in the shared EditorModal
- `web/src/sections/About.tsx` — static About section: what llm-gateway is, the stack, the OpenAI-client baseURL hint (`<host>/llm/v1`), pointers to `README.md` and `specs/`
- `web/public/icon.svg` — brand icon (tile + white mark); served as the favicon via a `<link rel="icon">` in `web/index.html`
- `web/public/glyph.svg` — monochrome variant of the same mark, stroked with `currentColor`; its geometry is inlined into `App.tsx` for the dock header; `public/*` is copied verbatim into the build output

## Core Types

Section identity and navigation (`web/src/router.tsx`) — the section set is the SPA's route table; a new section is one more entry:

```ts
export const SECTIONS = [
  { id: "status", label: "Status", icon: Activity },
  { id: "models", label: "Models", icon: Layers },
  { id: "upstreams", label: "Upstreams", icon: Server },
  { id: "clients", label: "Clients", icon: KeyRound },
  { id: "about", label: "About", icon: Info },
] as const;                                  // `icon` is the lucide-react component the dock renders per entry
export type SectionId = (typeof SECTIONS)[number]["id"]; // "status" is the default
```

Management API response shapes (`web/src/api.ts`), mirroring [gateway-management.md](../contracts/gateway-management.md):

```ts
export interface GatewayStatus {
  readonly status: "ok";          // the fixed literal — the process is up and serving
  readonly authenticated: boolean; // this request carries a valid session (true only behind a login)
}
export interface ManagedUpstream {
  readonly type: string;
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey: "[Configured]";          // the mask, exactly as returned — never a real value
  readonly tlsFingerprint: string | null;   // "[Configured]" | null
  readonly proxy: string | null;            // verbatim http://host:port or socks5://host:port; null = direct connection (ADR-017) — not masked: the grammar admits no credentials in it
  readonly probe?: "ok" | "failed";         // optional on the type; the list has carried no probe fields since ADR-014 D3, so the SPA reads undefined
  readonly reason?: string;                 // present only when `probe` is "failed"
}
export interface UpstreamWriteResponse {   // POST /api/upstreams, PUT /api/upstreams/:id (ADR-014 D8)
  readonly upstream: ManagedUpstream;
  readonly probe: { ok: boolean; reason?: string };  // data, never a gate — a failed probe still landed
}
export interface ManagedModelAlias {       // GET /api/models entries (ADR-014 D4 — `meta` lives here)
  readonly alias: string;
  readonly routes: ReadonlyArray<{ upstream: string; model: string; weight: number | null }>;
  readonly balance: { readonly strategy: string };
  readonly limits: { readonly context: number | null; readonly output: number | null } | null;
  readonly meta: {
    readonly contextWindow: number | null;
    readonly outputLimit: number | null;
    readonly capabilities: { attachment: boolean; reasoning: boolean; temperature: boolean; toolCall: boolean } | null;
  };
}
export interface ManagedClient {
  readonly name: string;
  readonly apiKey: "[Configured]";
  readonly models: readonly string[];
}
```

Write requests follow the D7 semantics as amended by [ADR-018](../decisions/018-uniform-optional-value-write-policy.md) (the normative table is [gateway-management.md](../contracts/gateway-management.md), "Optional values in a write body — keep / clear / reject"): create requires the key; an update omits `apiKey` entirely to mean keep-existing, every field is trimmed before it rides the body and an empty-after-trim field is omitted (`""` on the wire is an explicit clear), and the mask literal is never submitted. Failures throw an `ApiFetchError` carrying the HTTP status (0 when no response arrived) and the OpenAI envelope's `message` — the `409 resource_in_use` and last-entry `400` refusals land as alerts with that message.

## Flow

```
gateway:  GET / ──► 302 /ui ──► unmatched GET/HEAD /ui/* serves dist/index.html (ADR-005 fallthrough)
                                        └► document missing since startup ──► plain-text 404/500 (no envelope, no upstream)
browser:  /ui (or /ui/) ──► React mounts ──► replaceState to /ui/status (canonical default section)
          auth probe GET /api/status ──► 401 ──► login card ──► POST /api/login ──► Set-Cookie (HttpOnly)
                                                                          └► sections render
          (a 200 probe renders the sections directly; its `authenticated` bit drives the dock's Log out —
           true behind a live session, false on an auth-off gateway — so Log out survives page reloads)
          dock Link click ──► pushState /ui/<section> + re-render (no reload; the server never sees a section path)
          deep link /ui/upstreams ──► server answers with index.html ──► React reads location, renders that section
          Log out ──► POST /api/logout ──► session revoked ──► back to the login card
sections: Status        ── GET /api/upstreams + GET /api/status ──► inventory table (probe/reason cells "—" — D3) + verdict badge
          Models        ── GET /api/models + GET /api/upstreams ──► alias table (meta budgets + capability badges + routes)
                        ── POST /api/models, PUT/DELETE /api/models/:alias per form submit / ConfirmModal-confirmed delete ──► routing-table rebuild hot-applies; 400/404/409 land as alerts
                        ── GET /api/upstreams/:id/models per route-row model-select open (ADR-011) ──► picking a listed id sets the route's model
          Upstreams     ── GET/POST /api/upstreams, GET/PUT/DELETE /api/upstreams/:id ──► table + modal create/edit pop-ups;
                        create/update answers render the D8 probe verdict; failures (incl. 409) land as alerts
                        ── GET /api/upstreams/:id/models?discover=1 per Load-models click (ADR-011, ADR-016) ──► live catalog: filter, click-to-copy; the slice swap folded in
          Clients       ── GET/POST /api/clients, GET/PUT/DELETE /api/clients/:name ──► table + modal create/edit pop-ups;
                        the ACL checkbox group is fed by GET /api/models
          About         ── no API call — static content
```

## Invariants

- The SPA's stack is React + Bootstrap rendered through `react-bootstrap` as the component layer ([ADR-015](../decisions/015-adopt-react-bootstrap.md)), with `lucide-react` as the only icon library — no second component library, no router library, and no other UI framework or icon set enters the SPA. react-bootstrap and lucide-react are imported directly by name in the components that use them — no wrapper module, no barrel. A runtime dependency is allowed only when it is bundled into the build output at build time; nothing may be loaded from an external server at runtime (no CDN links, no hosted scripts, fonts, or icon packs).
- The SPA calls ONLY the management surface: the slim `GET /api/status` probe, the three CRUD collections (`GET`/`POST` on `/api/upstreams`, `/api/models`, `/api/clients` and their `GET`/`PUT`/`DELETE` detail routes — [ADR-014](../decisions/014-runtime-management-crud.md)), the ADR-011 live listing `GET /api/upstreams/:id/models` (fired only by an explicit Load-models click on the Upstreams section or the opening of a route-row model select on the Models section, never on its own schedule; the Upstreams click's fetch carries `discover=1` — [ADR-016](../decisions/016-discover-folded-into-live-listing.md) — while the dropdown's stays a pure read), plus the two auth actions `POST /api/login` / `POST /api/logout` ([ADR-007](../decisions/007-management-cookie-auth.md)) — never `/llm/*`, and no mutation beyond the boundary's sanctioned set; every mutating call is an operator-initiated form submission or button click, never a scheduled or on-mount side effect.
- The session cookie is HttpOnly: the SPA never reads the session token — login state lives in the gateway's session store, and the SPA only knows "the last API call succeeded".
- The login card is the only login affordance: the server sends no `WWW-Authenticate` header, and the SPA never stores the password beyond the login POST.
- Everything beyond `/ui` is client-side routed: the server answers every section path with the same index.html — a document missing since startup gets a plain-text 404/500, never the OpenAI envelope and never an upstream error — and never learns about sections; section switches happen via pushState without a reload.
- `/ui` and `/ui/` land on the default section (`/ui/status`) via client-side replaceState — the URL is canonical before the user navigates further.
- Unknown paths render the default section — the SPA has no 404 view.
- Secrets stay masked end to end: the SPA renders `apiKey` / `tlsFingerprint` exactly as the management API returns them (the fixed mask, or `null`) and has no way to unmask them; the edit forms invert the direction honestly — an empty key field is omitted from the submitted body (keep-existing, [ADR-014](../decisions/014-runtime-management-crud.md) D7) and the mask literal is never a submitted value. No edit form clears a stored field to `null`: `tlsFingerprint` and `proxy` are set or kept, and the boundary's `null` clear is reachable only through the management API itself. The upstream `proxy` is the deliberate exception — not secret (its grammar admits no userinfo), so it is rendered and edited verbatim ([ADR-017](../decisions/017-per-upstream-outbound-proxy.md)).
- Every management failure lands visibly as an alert carrying the OpenAI envelope's `message` — including the `409 resource_in_use` refusals (D6) and the last-entry `400` answers — so a refused delete or create is operator-readable, never silent.
- The Models section's alias table renders the `meta` values from `GET /api/models` (unknown → “—”, never a fabricated zero); a finished `discover=1` load on the Upstreams section swaps the upstream's metadata slice, so the refreshed minima appear on the table's next read ([ADR-016](../decisions/016-discover-folded-into-live-listing.md)).
- The SPA ships as pre-built static assets; the gateway only serves files and never executes UI code server-side.

## Configuration

None — the frontend has no entry in the gateway config file. What the HTTP layer serves (the root 302, the `/ui/*` static mount, the SPA fallback, the envelope prefixes) is fixed by [ADR-005](../decisions/005-gateway-surface-namespace.md) and implemented in `src/httpapi/app.ts`; the build-time `base: "/ui/"` in `web/vite.config.ts` keeps every emitted asset URL inside the same namespace. The data the sections display comes from the management API's effective (normalized, masked) config — not from any frontend setting.

## Extension Points

- A new section is one entry in `SECTIONS` (`web/src/router.tsx`) plus one component under `web/src/sections/` wired in `App.tsx` — the dock and the router pick it up with no server-side change (the fallback already serves index.html for the new path).
- A section that needs new gateway data waits for its management endpoint to be specified in the contract first — the API spec leads, and the UI lands in the same change ([ADR-014](../decisions/014-runtime-management-crud.md) D5); the typed fetch helpers and shapes join `web/src/api.ts`.
- The CRUD sections share one form pattern (table + modal create/edit pop-ups — the shared `EditorModal` shell (`web/src/ui/EditorModal.tsx`), a static-backdrop react-bootstrap Modal whose submit errors surface inside the dialog; immutable identity key, optional key fields meaning keep-existing, envelope-message alerts) — a fourth collection (if a future ADR adds one to the store) extends the pattern rather than inventing a second one.
- **Load-models control**: the Upstreams section's per-upstream card carries the one Load-models button; its fetch carries `discover=1` ([ADR-016](../decisions/016-discover-folded-into-live-listing.md)), so a successful load both renders the live catalog and swaps the upstream's metadata slice, which folds into the Models section's alias table on its next read — a failed load answers the `502` envelope and lands as the card's error state, the previous slice serving ([gateway-management.md](../contracts/gateway-management.md)).

## Related Specs

- [META](../META.md) — this spec's place in the canonical spec tree
- [Gateway management contract](../contracts/gateway-management.md) — the `/api/*` surface every section consumes: shapes, masking rule, the D7/D8 write semantics the forms implement, mount order
- [ADR-005: Gateway surface namespace](../decisions/005-gateway-surface-namespace.md) — fixes the SPA mount at `/ui/*`, the root `302` redirect, and the client-side routing rule
- [ADR-014: runtime management CRUD](../decisions/014-runtime-management-crud.md) — the mutation surface the SPA drives (D5: the sections land with the endpoints)
- [ADR-015: `react-bootstrap` as the component layer](../decisions/015-adopt-react-bootstrap.md) — the component library over the Bootstrap CSS, the shared ConfirmModal, the direct-import rule
- [Configuration](./configuration.md) — the config file the CRUD forms write through the store (the schema the forms' fields mirror)
