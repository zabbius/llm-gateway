/**
 * The request-body reader for every endpoint that parses JSON — the
 * completions dispatch (`/llm/v1/*`) and `POST /api/login`. The body is
 * read under the configured byte cap (`server.maxRequestBodyBytes`, default
 * 4 MiB — specs/domains/configuration.md; schema.ts owns the validation and
 * the default, this module only enforces it): an over-limit request is
 * answered 413 (specs/contracts/client-gateway.md) before `JSON.parse` ever
 * sees it, so one giant body cannot buffer the whole process. The listener
 * is deliberately not given the runtime's own body limit — a runtime-level
 * rejection would bypass the OpenAI envelope; here every 413 is an envelope.
 */

/** The body exceeded the configured request-body cap — the caller answers 413. */
export class BodyLimitError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds the ${maxBytes}-byte limit`);
    this.name = "BodyLimitError";
  }
}

/**
 * Parse the request's JSON body under `maxBytes` — the configured
 * `server.maxRequestBodyBytes` cap, which every caller takes from the
 * entry point's redacted config view. Throws `BodyLimitError` as soon as
 * more than `maxBytes` has arrived (the declared `content-length` fails
 * fast before reading; the stream is cancelled so the remainder is never
 * buffered), and a parse error for an empty or malformed body — same
 * behavior `c.req.json()` had for those, minus the unbounded read.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyLimitError(maxBytes);
  }
  const reader = request.body?.getReader();
  if (reader === undefined) throw new SyntaxError("the request body is empty");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyLimitError(maxBytes);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
