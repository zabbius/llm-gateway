/**
 * The build-time OpenAPI generator — `bun run apidocs`.
 *
 * The document is assembled once per build, not per request: this module
 * mounts stub routes on a scratch Hono app — one stub per `OPENAPI_ROUTES`
 * row, carrying the `describeRoute` config from `ROUTE_DESCRIPTIONS` — and
 * lets hono-openapi's `generateSpecs` turn that route table into the full
 * OpenAPI 3.1 document (no stub handler ever executes; generation reads
 * configs only). The result is serialized to `dist/openapi.json`, which the
 * server serves statically (`app.ts` reads the artifact per request; the
 * docs route answers the envelope 404 with a hint while it is absent).
 *
 * Build-time only: neither this module nor `openapi.ts` is imported by the
 * gateway at runtime — that is what keeps hono-openapi and zod in
 * devDependencies (specs/decisions/013-openapi-docs-surface.md).
 *
 * Invariant: `OPENAPI_ROUTES` (here, via openapi.ts) mirrors the app.ts
 * mounts, and the openapi.test.ts sync guard asserts document ≡ table ≡
 * mounted surface — the artifact can never silently drift from the served
 * interface.
 *
 * CLI: `bun run src/httpapi/generate-openapi.ts` (the `apidocs` script)
 * writes `dist/openapi.json` and prints a one-line summary. Tests import
 * `buildOpenApiDocument` (in memory) or `writeOpenApiArtifact` (fixture
 * paths) instead of shelling out.
 */
import { Hono } from "hono";
import { describeRoute, generateSpecs } from "hono-openapi";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OPENAPI_DOCUMENT_OPTIONS, OPENAPI_ROUTES, ROUTE_DESCRIPTIONS } from "./openapi.ts";

/** The default artifact location — covered by the bare `dist` .gitignore rule. */
export const OPENAPI_ARTIFACT_PATH = join("dist", "openapi.json");

/**
 * Generate the full OpenAPI document (pretty JSON + trailing newline)
 * without touching the filesystem: a scratch app carries the stub routes,
 * `generateSpecs` compiles the document from them.
 */
export async function buildOpenApiDocument(): Promise<string> {
  const scratch = new Hono();
  for (const route of OPENAPI_ROUTES) {
    scratch.on(
      route.method,
      route.path,
      describeRoute(ROUTE_DESCRIPTIONS[route.key]),
      () => new Response(null, { status: 204 }),
    );
  }
  const document = await generateSpecs(scratch, OPENAPI_DOCUMENT_OPTIONS);
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Generate and write the artifact (default `dist/openapi.json`); returns the body. */
export async function writeOpenApiArtifact(
  targetPath: string = OPENAPI_ARTIFACT_PATH,
): Promise<string> {
  const body = await buildOpenApiDocument();
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, body);
  return body;
}

if (import.meta.main) {
  const body = await writeOpenApiArtifact();
  const document = JSON.parse(body) as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const operations = Object.values(document.paths ?? {})
    .map((item) =>
      Object.keys(item).filter((method) => method === "get" || method === "post" || method === "put" || method === "delete").length,
    )
    .reduce((sum, count) => sum + count, 0);
  console.log(
    `apidocs: wrote ${OPENAPI_ARTIFACT_PATH} — ${operations} operations across ${Object.keys(document.paths ?? {}).length} paths, ${body.length} bytes`,
  );
}
