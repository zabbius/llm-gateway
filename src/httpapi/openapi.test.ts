/**
 * The documenting surface's own contract tests: the BUILD-TIME generator
 * (src/httpapi/generate-openapi.ts over openapi.ts's tables) plus the [4c]
 * static docs mounts in app.ts. The sync guard proves three views of the
 * interface stay equal — the generated document's operations, the
 * OPENAPI_ROUTES table the generator mounts its stubs from, and the route
 * table createApp actually mounts (codegen drift fails loudly). The
 * served-surface tests read a fixture artifact through the app
 * (`openApiDocPath`) the same way production serves dist/openapi.json: the
 * two security schemes, the error envelope every gateway failure is
 * described with, the /docs shell, the namespace's deliberately ungated
 * placement outside every gate prefix, the envelope-404 fallthrough for
 * unknown /docs/* paths, and the credential-leak guard — the document
 * describes the masking rule's "[Configured]" contract forms and nothing
 * else (no credential material from a fully credentialed fixture). The
 * freshness test keeps the on-disk dist/openapi.json honest against a
 * fresh generation.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type pino from "pino";
import type { Upstream, UpstreamConfig, ModelEntry, ProxyRequest } from "../upstreams/upstream.ts";
import { UpstreamRegistry, type UpstreamFactories } from "../upstreams/registry.ts";
import { createApp, OPENAPI_DOC_PATH } from "./app.ts";
import { redactedConfigView } from "../config/redact.ts";
import { ConfigStore } from "../config/store.ts";
import { DEFAULT_MAX_REQUEST_BODY_BYTES, type ClientConfig, type ModelConfig } from "../config/schema.ts";
import { SESSION_COOKIE } from "./auth.ts";
import { CONFIGURED_MASK, OPENAPI_ROUTES } from "./openapi.ts";
import { OPENAPI_ARTIFACT_PATH, buildOpenApiDocument, writeOpenApiArtifact } from "./generate-openapi.ts";

/* ------------------------------------------------------------------ */
/* test infrastructure — the app.test.ts fixture pattern, credentialed */
/* ------------------------------------------------------------------ */

/**
 * Deliberately secret-shaped fixture material across all three credential
 * classes (upstream key + pin, client key, operator hash): the leak guard
 * proves none of it reaches the document.
 */
const FIXTURE_UPSTREAM_KEY = "sk-fixture-upstream-credential-NOT-REAL";
const FIXTURE_UPSTREAM_PIN = "AAkBFixTUREpIN0bPq0WE1cR4m5jXKzlvJNUdBtTR0=";
const FIXTURE_CLIENT_KEY = "sk-fixture-client-credential-NOT-REAL";
const FIXTURE_OPERATOR_USER = "admin";
const FIXTURE_OPERATOR_HASH = "fixture-argon2id-hash-not-a-real-credential";

/**
 * The fixture artifact this file serves through the app — written fresh by
 * the generator in beforeAll (the production default path dist/openapi.json
 * is exercised by the freshness test below instead, never by these served
 * tests, so a missing checkout artifact cannot fail them). Distinct from
 * app.test.ts's docs fixture: bun test may run the files concurrently.
 */
const DOCS_FIXTURE_DIR = join(import.meta.dir, "..", "..", "web", "docs-fixture-openapi");
const FIXTURE_DOC_PATH = join(DOCS_FIXTURE_DIR, "openapi.json");

/** Minimal silent stand-in for the root pino logger (auth.test.ts pattern). */
function silentLogger(): pino.Logger {
  const build = (bound: Record<string, unknown>): pino.Logger =>
    ({
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child: (next: Record<string, unknown>) => build({ ...bound, ...next }),
    }) as unknown as pino.Logger;
  return build({});
}

/** A never-contacted upstream stand-in — document generation must not call it. */
class FakeUpstream implements Upstream {
  readonly id: string;
  readonly type: UpstreamConfig["type"] = "openai-compatible";

  constructor(config: UpstreamConfig) {
    this.id = config.id;
  }

  async connect(): Promise<void> {}

  async listModels(): Promise<ModelEntry[]> {
    return [{ id: "gpt-4o", object: "model", created: 1712267047, owned_by: "openai" }];
  }

  async forward(_request: ProxyRequest): Promise<Response> {
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }
}

const FIXTURE_CLIENTS: ClientConfig[] = [
  { name: "fixture-client", apiKey: FIXTURE_CLIENT_KEY, models: ["fast"] },
];

const FIXTURE_MODELS: ModelConfig[] = [
  { alias: "fast", routes: [{ upstream: "alpha", model: "gpt-4o" }], balance: { strategy: "round-robin" } },
];

/**
 * The fully credentialed gateway (session gate + client gate mounted, an
 * upstream carrying a key and a pin): every credential class is present so
 * the guards below have real material to prove absent from the document.
 * The docs route serves this file's fixture artifact via `openApiDocPath`.
 */
async function credentialedGateway() {
  const entries: UpstreamConfig[] = [
    {
      type: "openai-compatible",
      id: "alpha",
      baseUrl: "https://alpha.example/v1",
      apiKey: FIXTURE_UPSTREAM_KEY,
      tlsFingerprint: FIXTURE_UPSTREAM_PIN,
    },
  ];
  const upstreams = new Map<string, FakeUpstream>([["alpha", new FakeUpstream(entries[0] as UpstreamConfig)]]);
  const factories: UpstreamFactories = {
    "openai-compatible": (entry) => {
      const made = upstreams.get(entry.id);
      if (made === undefined) throw new Error(`unexpected upstream id "${entry.id}"`);
      return made;
    },
  };
  const logger = silentLogger();
  const registry = await UpstreamRegistry.create(entries, factories, logger);
  // The entry point builds the redacted view from the same entries and hands
  // it to createApp — the raw config never crosses into the HTTP layer.
  const configuration = redactedConfigView({
    server: { listen: "127.0.0.1:8080", maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES },
    logLevel: "info",
    clients: FIXTURE_CLIENTS,
    models: FIXTURE_MODELS,
    upstreams: entries,
  });
  const app = createApp(registry, logger, configuration, {
    auth: { enabled: true, user: FIXTURE_OPERATOR_USER, passwordHash: FIXTURE_OPERATOR_HASH },
    clients: FIXTURE_CLIENTS,
    models: FIXTURE_MODELS,
    openApiDocPath: FIXTURE_DOC_PATH,
    // The runtime store backs the ADR-014 CRUD mounts — the full documented
    // interface must mount for the sync guard below. No test in this file
    // mutates, so the (never-written) config path is a fixture-local name.
    configStore: new ConfigStore(
      {
        server: { listen: "127.0.0.1:8080", maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES },
        logLevel: "info",
        clients: FIXTURE_CLIENTS,
        models: FIXTURE_MODELS,
        upstreams: entries,
      },
      join(DOCS_FIXTURE_DIR, "config.json"),
    ),
  });
  return { app, upstreams };
}

/** The generated document's own shape, as the tests read it. */
interface OpenApiDocument {
  openapi: string;
  info: { title: string };
  paths: Record<string, Record<string, unknown>>;
  components?: {
    securitySchemes?: Record<string, { type: string; scheme?: string; in?: string; name?: string }>;
  };
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** Every operation in a document as `METHOD path` — `{id}`/`{alias}` as generated. */
function operationsOf(document: OpenApiDocument): string[] {
  const operations: string[] = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) operations.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return operations.sort();
}

/** Hono's `:param` route patterns render as `{param}` in the OpenAPI document. */
function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
}

/** Every documented-namespace operation createApp actually mounts (gates are `use` mounts — excluded by method; the CRUD verbs PUT/DELETE ride their real methods). */
function mountedOperations(app: ReturnType<typeof createApp>): string[] {
  return app.routes
    .filter((route) => route.method === "GET" || route.method === "POST" || route.method === "PUT" || route.method === "DELETE")
    .filter((route) => route.path.startsWith("/llm/") || route.path.startsWith("/api/"))
    .map((route) => `${route.method} ${openApiPath(route.path)}`)
    .sort();
}

/* ------------------------------------------------------------------ */
/* fixture: generate once, serve through the app like production does  */
/* ------------------------------------------------------------------ */

let generatedBody!: string;
let generatedDocument!: OpenApiDocument;

beforeAll(async () => {
  generatedBody = await buildOpenApiDocument();
  generatedDocument = JSON.parse(generatedBody) as OpenApiDocument;
  await writeOpenApiArtifact(FIXTURE_DOC_PATH);
});

afterAll(() => {
  rmSync(DOCS_FIXTURE_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("the documenting surface: GET /docs and GET /docs/openapi.json", () => {
  test("(sync guard) the document ≡ the OPENAPI_ROUTES table ≡ the mounted surface, exactly", async () => {
    const { app } = await credentialedGateway();
    // View 1 — the generator's output (what /docs/openapi.json serves).
    const document = generatedDocument;
    // View 2 — the generator's input: the table it mounts stub routes from.
    const table = OPENAPI_ROUTES.map((row) => `${row.method} ${openApiPath(row.path)}`).sort();
    // View 3 — the server: what createApp actually mounts (the session gate
    // is on in this fixture, and the runtime store is wired, so the full
    // twenty-three-operation interface mounts;
    // app.test.ts covers the gate-off deployment variant).
    const mounted = mountedOperations(app);
    // Not more and not less in any view: a mount without a table row, a row
    // without a mount, or a description that drifts from either — all break
    // this equality. The codegen guard. Rows sharing a path (GET/POST
    // /api/upstreams, GET/PUT/DELETE /api/upstreams/:id) render as one path
    // entry, so the document's path count is the table's DISTINCT path count.
    expect(operationsOf(document)).toEqual(table);
    expect(mounted).toEqual(table);
    const distinctPaths = new Set(OPENAPI_ROUTES.map((row) => openApiPath(row.path)));
    expect(Object.keys(document.paths)).toHaveLength(distinctPaths.size);
  });

  test("components.securitySchemes declares bearerAuth and cookieAuth; failures carry the error envelope", async () => {
    const { app } = await credentialedGateway();
    const document = (await (await app.request("/docs/openapi.json")).json()) as OpenApiDocument;

    const schemes = document.components?.securitySchemes ?? {};
    expect(schemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(schemes.cookieAuth).toMatchObject({ type: "apiKey", in: "cookie", name: SESSION_COOKIE });

    // The one error shape every gateway-generated failure shares: the
    // envelope is described inline on each failure response (LLM surface
    // and management surface alike — `message`/`type` required, `param` and
    // `code` optional strings).
    const status = document.paths["/api/status"] as {
      get?: { responses?: Record<string, { content?: Record<string, { schema?: EnvelopeSchemaShape }> }> };
    };
    const chat = document.paths["/llm/v1/chat/completions"] as {
      post?: { responses?: Record<string, { content?: Record<string, { schema?: EnvelopeSchemaShape }> }> };
    };
    expectEnvelopeSchema(status.get?.responses?.["401"]?.content?.["application/json"]?.schema);
    expectEnvelopeSchema(chat.post?.responses?.["400"]?.content?.["application/json"]?.schema);
  });

  test("GET /docs answers 200 text/html referencing the document route", async () => {
    const { app } = await credentialedGateway();
    const response = await app.request("/docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(await response.text()).toContain("/docs/openapi.json");
  });

  test("auth enabled: the gated sibling answers 401 while both docs routes answer 200 without a session", async () => {
    const { app } = await credentialedGateway();
    // The session gate is mounted and live in this fixture.
    const gated = await app.request("/api/status");
    expect(gated.status).toBe(401);

    // The docs namespace sits outside every gate prefix — ungated by design.
    const shell = await app.request("/docs");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
    const document = await app.request("/docs/openapi.json");
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toContain("application/json");
  });

  test("unknown /docs/* paths are not mounted — the envelope 404 fallthrough", async () => {
    const { app } = await credentialedGateway();
    const response = await app.request("/docs/unknown");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(typeof body.error.message).toBe("string");
  });

  test("the document leaks no credential material — the mask appears only in its contract forms", async () => {
    const raw = generatedBody;

    // No secret-like literal from any credential class of the fixture, and
    // no sk-style key-shaped literal at all.
    expect(raw).not.toContain(FIXTURE_UPSTREAM_KEY);
    expect(raw).not.toContain(FIXTURE_UPSTREAM_PIN);
    expect(raw).not.toContain(FIXTURE_CLIENT_KEY);
    expect(raw).not.toContain(FIXTURE_OPERATOR_USER);
    expect(raw).not.toContain(FIXTURE_OPERATOR_HASH);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/);

    // The mask is part of the wire contract itself (gateway-management.md
    // masking rule; CONFIGURED_MASK in src/config/redact.ts), so the document
    // legitimately describes it — but only in its contract-designated forms:
    // the ADR-014 management CRUD surfaces' own restatements of the rule —
    // the masked-entry schemas the reads serve and the create/update prose
    // that says the mask is rejected as input (the upstreams and clients
    // surfaces; the models surface shares the upstreams prose shapes). Any
    // other occurrence — a leaked rendered config view, an example payload —
    // fails here.
    expect(raw.split(CONFIGURED_MASK).length - 1).toBe(18);
    const document = JSON.parse(raw) as unknown;
    const occurrences: { pointer: string[]; value: string }[] = [];
    collectMaskStrings(document, [], occurrences);
    expect(occurrences).toHaveLength(18);
    const designatedPaths = new Set([
      "/api/upstreams",
      "/api/upstreams/{id}",
      "/api/clients",
      "/api/clients/{name}",
    ]);
    for (const occurrence of occurrences) {
      expect(occurrence.pointer[0]).toBe("paths");
      expect(designatedPaths.has(occurrence.pointer[1] ?? "")).toBe(true);
    }
    const prose = occurrences.filter((occurrence) => occurrence.pointer.at(-1) === "description");
    expect(prose).toHaveLength(6);
    const consts = occurrences.filter((occurrence) => occurrence.value === CONFIGURED_MASK);
    expect(consts).toHaveLength(12);

    // No example payloads anywhere in the document — a rendered config view
    // would have to ride one.
    const examplePointers: string[] = [];
    collectKeysNamed(document, ["example", "examples", "default"], [], examplePointers);
    expect(examplePointers).toEqual([]);
  });

  test("the build-time artifact stays fresh: dist/openapi.json equals a fresh generation", async () => {
    const fresh = await buildOpenApiDocument();
    const current = await Bun.file(OPENAPI_ARTIFACT_PATH)
      .text()
      .catch(() => null);
    if (current === null) {
      // Fresh checkout: the artifact is gitignored, so bootstrap it (the
      // docs route needs it on disk) — nothing to compare against yet.
      await writeOpenApiArtifact();
      console.log("apidocs: bootstrapped dist/openapi.json — run `bun run apidocs` whenever the API changes");
      return;
    }
    // Drift means the served document no longer matches the code — the fix
    // is always `bun run apidocs`.
    expect(current).toBe(fresh);
  });

  test("the two artifact-path constants stay equal — app.ts serves what apidocs writes", () => {
    expect(OPENAPI_DOC_PATH).toBe(OPENAPI_ARTIFACT_PATH);
  });
});

/** The error-envelope schema shape as hono-openapi inlines ErrorEnvelopeSchema. */
interface EnvelopeSchemaShape {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

function expectEnvelopeSchema(schema: EnvelopeSchemaShape | undefined): void {
  expect(schema).toBeDefined();
  const error = schema?.properties?.error as EnvelopeSchemaShape | undefined;
  expect(error?.type).toBe("object");
  expect(error?.required).toEqual(expect.arrayContaining(["message", "type"]));
  for (const field of ["message", "type", "param", "code"]) {
    expect((error?.properties?.[field] as EnvelopeSchemaShape | undefined)?.type).toBe("string");
  }
}

/** Depth-first collection of every string value carrying the mask literal. */
function collectMaskStrings(node: unknown, pointer: string[], found: { pointer: string[]; value: string }[]): void {
  if (typeof node === "string") {
    if (node.includes(CONFIGURED_MASK)) found.push({ pointer, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectMaskStrings(item, [...pointer, String(index)], found));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      collectMaskStrings(value, [...pointer, key], found);
    }
  }
}

/** Depth-first collection of object keys named exactly one of `names`. */
function collectKeysNamed(node: unknown, names: string[], pointer: string[], found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectKeysNamed(item, names, [...pointer, String(index)], found));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (names.includes(key)) found.push([...pointer, key].join("/"));
      collectKeysNamed(value, names, [...pointer, key], found);
    }
  }
}
