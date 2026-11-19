/**
 * The Swagger UI shell — the body `GET /docs` serves (an HTML constant,
 * never a file: the surface is one page that reads one document, so a
 * build step would only add a second thing to sync).
 *
 * Dependency-free by design: this is the one piece of the docs surface
 * the gateway imports at runtime (`app.ts`), while the wire descriptions
 * stay in the build-time-only `openapi.ts` — keeping this module
 * import-free is what lets hono-openapi and zod remain devDependencies.
 *
 * The stylesheet and bundle are pinned (`swagger-ui-dist@5.35.0`, the
 * release the shell was written against — "latest" would let an
 * upstream UI release change this surface silently) and loaded from
 * unpkg in the *operator's browser*; the gateway itself never fetches
 * anything, and the page carries no data beyond the document URL.
 * The same no-gate rationale as `/ui/*` (ADR-005) applies: static
 * protocol metadata, no credentials, no configuration values.
 */
export const SWAGGER_UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>llm-gateway — API documentation</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.35.0/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.35.0/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.addEventListener("DOMContentLoaded", function () {
        window.SwaggerUIBundle({
          url: "/docs/openapi.json",
          dom_id: "#swagger-ui",
          deepLinking: true,
          docExpansion: "none",
        });
      });
    </script>
  </body>
</html>
`;
