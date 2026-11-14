/**
 * The request-body reader for every endpoint that parses JSON — the
 * completions dispatch (`/llm/v1/*`) and `POST /api/login`. The body is
 * read under a hard byte cap: an over-limit request is answered 413
 * (specs/contracts/client-gateway.md) before `JSON.parse` ever sees it, so
 * one giant body cannot buffer the whole process.
 */

/** The hard cap on any parsed request body (generous for LLM payloads, bounded for the process). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The body exceeded MAX_BODY_BYTES — the caller answers 413. */
export class BodyLimitError extends Error {
  constructor() {
    super(`request body exceeds the ${MAX_BODY_BYTES}-byte limit`);
    this.name = "BodyLimitError";
  }
}

/**
 * Parse the request's JSON body. Throws `BodyLimitError` as soon as more
 * than `MAX_BODY_BYTES` has arrived (the declared `content-length` fails
 * fast before reading; the stream is cancelled so the remainder is never
 * buffered), and a parse error for an empty or malformed body — same
 * behavior `c.req.json()` had for those, minus the unbounded read.
 */
export async function readJsonBody(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyLimitError();
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
      throw new BodyLimitError();
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
