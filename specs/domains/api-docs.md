# API Documentation (/docs)

## Purpose

The machine-readable documentation surface ([ADR-013](../decisions/013-openapi-docs-surface.md)): `GET /docs/openapi.json` serves an OpenAPI 3.1 document generated **at build time** from the gateway's own wire descriptions, and `GET /docs` serves a Swagger UI shell that renders it. One surface describes both HTTP contracts — the client surface ([client-gateway.md](../contracts/client-gateway.md)) and the management surface ([gateway-management.md](../contracts/gateway-management.md)) — so integrators get a machine-readable description and humans get a browsable reference without reading the specs. It extends the [ADR-005](../decisions/005-gateway-surface-namespace.md) namespace scheme with a fourth, documentation-only prefix; like `/ui/*` it is deliberately ungated (static protocol metadata, no instance data). Generation never runs in the gateway process: `bun run apidocs` compiles the document once per build into `dist/openapi.json`, and the server only serves that file — request handling cannot change because of the docs, and neither can the runtime dependency tree.

## Key Files

- `src/httpapi/openapi.ts` — the wire-contract description module, the OpenAPI document's single source, **build-time only** (the gateway never imports it — that is what keeps `hono-openapi` and `zod` in devDependencies): zod schemas for every gateway-served JSON shape (each citing the contract it mirrors), `ROUTE_DESCRIPTIONS` (the `describeRoute` operation configs for all twenty-three operations across fourteen paths, tagged `LLM` / `Management`), `OPENAPI_DOCUMENT_OPTIONS` (title, origin server, the `bearerAuth` / `cookieAuth` security schemes, tag vocabulary), and `OPENAPI_ROUTES` (the `{ key, method, path }` row per route — the table the generator mounts stub routes from)
- `src/httpapi/generate-openapi.ts` — the build-time generator behind `bun run apidocs` (and the root `build` script): mounts stub routes on a scratch Hono app from `OPENAPI_ROUTES` + `ROUTE_DESCRIPTIONS`, compiles the document with hono-openapi's `generateSpecs` (no stub handler ever executes), and writes `dist/openapi.json` (pretty JSON, deterministic byte-for-byte); exports `buildOpenApiDocument()` / `writeOpenApiArtifact()` for tests
- `src/httpapi/docs-shell.ts` — the Swagger UI shell: the `SWAGGER_UI_HTML` constant, the **one** docs module the runtime imports (dependency-free by design — its import-freeness is what pins the descriptive dependencies to the build)
- `src/httpapi/app.ts` — the serving wiring, stage [4c]: `GET /docs/openapi.json` reads the artifact per request (the SPA index.html pattern; injectable `openApiDocPath` option, default `OPENAPI_DOC_PATH` = `dist/openapi.json`) and answers `application/json`; a missing (or corrupt) artifact answers the envelope 404 with the regenerate hint — the server never generates. `GET /docs` → the shell constant
- `src/httpapi/openapi.test.ts` — the surface's own contract tests: the three-way sync guard (generated document ≡ `OPENAPI_ROUTES` ≡ the route table `createApp` actually mounts), the security schemes and the error-envelope shape, the `/docs` shell, the ungated-with-auth-on contrast, the envelope 404 for unknown `/docs/*`, the credential-leak guard, the freshness test (`dist/openapi.json` equals a fresh generation; bootstraps the artifact on a fresh checkout), and the equality of the two artifact-path constants
- `src/httpapi/app.test.ts` — the serving-side docs tests ("docs namespace" describe): fixture-artifact serving through `openApiDocPath`, the deployment-independent twenty-three-operation document, the missing-artifact 404, the shell's content type and document reference, and the envelope 404 for unknown `/docs/*` paths

## Core Types

The description modules' exported vocabulary — data, not behavior; nothing here validates a request at runtime (no `validator()` middleware mounts anywhere):

- `ROUTE_DESCRIPTIONS` — one `DescribeRouteOptions` per operation, keyed by the route's role (`login`, `logout`, `listModels`, `createChatCompletion`, `createCompletion`, `getStatus`, `listUpstreams`, `createUpstream`, `getUpstream`, `updateUpstream`, `deleteUpstream`, `discoverUpstream`, `listModelAliases`, `createModelAlias`, `getModelAlias`, `updateModelAlias`, `deleteModelAlias`, `listClients`, `createClient`, `getClient`, `updateClient`, `deleteClient`, `listUpstreamModels`): summary, description prose, `security` (naming the scheme the route's gate uses; an empty array marks a credential-free route), and the response map — every failure body the route can produce is the one error envelope, described per the contracts' propagation tables (the CRUD writes' `400`/`409` answers included, [ADR-014](../decisions/014-runtime-management-crud.md))
- `OPENAPI_ROUTES` — the route table as plain data: `{ key, method, path }` per operation, the generator's mount list; the sync guard asserts it equals both the generated document and `createApp`'s mounted surface
- `OPENAPI_DOCUMENT_OPTIONS` — the document's fixed header: `info.title` "llm-gateway" (version `0.1.0`, the MVP marker — `package.json` carries no version field), `servers` the gateway's own origin `/`, and `components.securitySchemes` with `bearerAuth` (HTTP Bearer, ADR-008, mounted when a `clients` block is configured) and `cookieAuth` (the ADR-007 session cookie, named by `SESSION_COOKIE` from `auth.ts` — the module's one same-layer import)
- `SWAGGER_UI_HTML` (docs-shell.ts) — the shell page: loads the pinned `swagger-ui-dist@5.35.0` stylesheet and bundle from unpkg **in the operator's browser** and initializes `SwaggerUIBundle({ url: "/docs/openapi.json", dom_id: "#swagger-ui", deepLinking: true, docExpansion: "none" })`; the page carries no data beyond that URL
- `buildOpenApiDocument` / `writeOpenApiArtifact` / `OPENAPI_ARTIFACT_PATH` (generate-openapi.ts) — the generator's three exports; the CLI mode (`bun run src/httpapi/generate-openapi.ts`, the `apidocs` script) writes the default artifact and prints a one-line summary

The zod schemas themselves (`ErrorEnvelopeSchema`, the alias-catalog shape, the status probe pair, the managed upstream/alias/client collection shapes with their `meta` and probe report, the discover result, the ADR-011 listing, the auth actions) mirror the contracts field-for-field — the document's value is that they live beside the route configs they annotate.

## Flow

```
maintainer ── bun run apidocs ──▶ generate-openapi.ts
             scratch Hono: mount stub routes from OPENAPI_ROUTES (+ describeRoute configs;
             no stub handler executes) ── generateSpecs ──▶ OpenAPI 3.1 document
             write dist/openapi.json (deterministic bytes)

operator's browser ── GET /docs ──▶ gateway: SWAGGER_UI_HTML (200, text/html; the constant)
browser ── loads pinned unpkg assets (swagger-ui-dist@5.35.0) ──▶ unpkg   (the gateway never fetches)
browser ── GET /docs/openapi.json ──▶ gateway: read dist/openapi.json per request ──▶ 200 application/json
              artifact absent/corrupt ──▶ envelope 404 + "run `bun run apidocs`" hint

SDK / codegen consumer ── GET /docs/openapi.json ──▶ same artifact, same guarantees
```

The document describes the *interface*, not a deployment: all twenty-three operations across the fourteen paths appear in every artifact — including `POST /api/login` and `POST /api/logout`, whose own descriptions state the `auth.enabled` condition. A static artifact cannot track per-deployment mounts, and a stable description is what SDK consumers need. Generation contacts no upstream, reads no config, and executes no handler: it is a compilation of the description tables, and the freshness test keeps the committed-to-disk artifact equal to a fresh generation.

## Invariants

- Build-time only: the gateway process never imports `openapi.ts` or `generate-openapi.ts` — `hono-openapi` and `zod` are devDependencies, serving is a file read, and `docs-shell.ts` stays import-free so the runtime keeps that property.
- Documentation-only: the gateway mounts no runtime validator and never generates — request handling, the envelope, and the gates are byte-identical to the pre-document behavior; the specs stay the only normative wire contract.
- The document is a projection, not a source: every schema mirrors a contract, and where prose and document disagree the specs win — `src/httpapi/openapi.ts` is corrected in the same change ([ADR-013](../decisions/013-openapi-docs-surface.md), SECURITY.md hard constraint 12).
- Zero instance data crosses the surface: route paths, wire shapes, and the fixed mask literals only — no credential, no configuration value, no probe outcome, no alias list, no payload ever appears in the shell or the document.
- The `/docs` namespace is ungated by declared rationale (SECURITY.md surface rule, hard constraint 10): it matches no gate prefix, the auth stage passes it through in every mode, and it is the same trust class as `/ui/*` under [ADR-005](../decisions/005-gateway-surface-namespace.md).
- Unknown `/docs/*` paths answer the OpenAI envelope 404 via the app's fallthrough; a missing artifact answers the envelope 404 with the regenerate hint — every gateway answer on this surface is the envelope, and the server never silently generates.
- The document, the `OPENAPI_ROUTES` table, and the mounted surface cannot drift apart: the three-way sync guard fails loudly on any two-way divergence (a mount without a row, a row without a mount, a changed path or method).
- The SPA is untouched: `/ui/*` serving, the root redirect, and the SPA fallback neither read nor depend on the docs mounts — the two static surfaces are independent (the docs shell needs no build output, the SPA needs no document).
- The gateway itself never fetches: the CDN dependency sits entirely in the operator's browser; the assets are pinned to `swagger-ui-dist@5.35.0` — an unpinned upstream UI release must never silently change this surface.

## Configuration

None — the surface has no entry in the gateway config file. The one config interaction is descriptive: the `auth` block decides whether `/api/login` and `/api/logout` exist as routes in a given deployment, and the document states that condition in the operations' own prose (a static artifact describes the interface, never a deployment's mounted subset). Two path constants must stay equal — `OPENAPI_DOC_PATH` (`app.ts`, the serving default) and `OPENAPI_ARTIFACT_PATH` (`generate-openapi.ts`, the writer) — and the sync tests assert exactly that; `app.ts`'s `openApiDocPath` option exists for tests. Asset pinning is a constant in `src/httpapi/docs-shell.ts`, not a config value — changing it is a deliberate, reviewed edit.

## Extension Points

- A new gateway route joins the document mechanically: add the handler mount, the `<newKey>` entry in `ROUTE_DESCRIPTIONS`, and the row in `OPENAPI_ROUTES` (`src/httpapi/openapi.ts`) — then run `bun run apidocs`; the three-way sync guard fails until all three views agree, so the document cannot silently lose or gain an operation.
- A new or changed wire shape updates the zod schema in `src/httpapi/openapi.ts` in the same change as the contract that defines it — both contracts' breaking-change checklists name the module and the `bun run apidocs` step; the specs lead, the description mirrors.
- A new security scheme (a future credential class) extends `components.securitySchemes` in `OPENAPI_DOCUMENT_OPTIONS` and is named by the routes that use it — the gateless `/docs` routes never reference one.
- A documentation-UI change (new Swagger UI version) is a deliberate bump of the pinned asset URLs in `SWAGGER_UI_HTML` (`docs-shell.ts`), reviewed like any surface change — never a float to `latest`.
- The surface stays two routes: serving additional files (local assets, a second page) would change its trust statement and passes the ADR bar first ([ADR-013](../decisions/013-openapi-docs-surface.md) rejected vendoring for cause).

## Related Specs

- [META](../META.md) — this spec's place in the canonical spec tree
- [ADR-013: The /docs surface](../decisions/013-openapi-docs-surface.md) — the decision this domain implements: namespace, ungated rationale, codegen-over-handwritten, build-time generation into a static artifact, pinned CDN assets
- [ADR-005: Gateway surface namespace](../decisions/005-gateway-surface-namespace.md) — the namespace scheme `/docs` extends; the trust class it shares with `/ui/*`
- [Client ↔ gateway contract](../contracts/client-gateway.md) — the LLM-surface routes and error envelope the document mirrors
- [Gateway management contract](../contracts/gateway-management.md) — the management routes, masking rule, and auth actions the document mirrors
- [Layers](../architecture/layers.md) — the dependency rule the description module lives under (httpapi-owned; the build-only module imports within the layer plus its descriptive devDependencies, the runtime imports only the dep-free shell)
- [Security model](../architecture/security-model.md) — the trust boundaries the ungated surface must respect
- [Frontend (SPA)](./frontend.md) — the sibling static surface the docs mounts never disturb
