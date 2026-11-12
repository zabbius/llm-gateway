import type { ReactNode } from "react";

/**
 * About section — static overview: what llm-gateway is, the stack, the one
 * detail every OpenAI client needs (the baseURL), and where the documents
 * live. No API calls, no state.
 */
export function AboutSection(): ReactNode {
  return (
    <section aria-labelledby="about-heading">
      <h1 className="h3 mb-2" id="about-heading">
        About
      </h1>
      <p>
        <strong>llm-gateway</strong> is an OpenAI-protocol proxy: clients speak
        the OpenAI API, and the gateway forwards each request to the upstream
        selected by the model-id prefix <code>{"{upstreamId}/{model}"}</code>,
        streaming the answer back. One gateway fronts many LLM providers
        behind a single fixed client surface.
      </p>

      <h2 className="h5 mt-4">Using it</h2>
      <p>
        Point any OpenAI client at <code>{"<host>"}/llm/v1</code> as its
        baseURL and request models as <code>upstream-id/model-name</code> —
        for example <code>openai-main/gpt-4o</code>. The management API is
        read-only JSON at <code>/api/*</code>; this UI at <code>/ui</code> is
        its browser view.
      </p>

      <h2 className="h5 mt-4">Stack</h2>
      <ul className="mb-0">
        <li>
          Gateway: TypeScript on Bun, Hono as the HTTP framework, pino logging
          to stderr
        </li>
        <li>This UI: React 19 + Bootstrap 5.3, built by Vite — no other runtime dependency</li>
      </ul>

      <h2 className="h5 mt-4">Documents</h2>
      <ul className="mb-0">
        <li>
          <code>README.md</code> — setup, configuration, and commands
        </li>
        <li>
          <code>specs/</code> — the design contracts; start at{" "}
          <code>specs/INDEX.md</code>
        </li>
        <li>
          <code>config.example.json</code> — an annotated configuration file
        </li>
      </ul>
    </section>
  );
}
