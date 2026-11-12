/**
 * The SPA shell: a flex row with the dock as a sticky left aside
 * (border-end) leading and the active section as the main content following.
 * The dock header is the
 * brand — the glyph mark inlined so it inherits currentColor — above the
 * section nav; the dock nav is the only navigation surface. Routing is
 * client-side over /ui/* (router.tsx, ADR-006): "/ui" and "/ui/" replace to
 * the default section, unknown paths render the default section.
 */
import { useEffect, type ReactNode } from "react";
import {
  DEFAULT_SECTION,
  Link,
  replace,
  SECTIONS,
  sectionForPath,
  sectionPath,
  usePath,
  type SectionId,
} from "./router.tsx";
import { StatusSection } from "./sections/Status.tsx";
import { ConfigurationSection } from "./sections/Configuration.tsx";
import { AboutSection } from "./sections/About.tsx";

/** The gateway mark — web/public/glyph.svg's geometry, inlined for currentColor. */
function BrandGlyph(): ReactNode {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="33 127 446 258"
      role="img"
      aria-labelledby="llm-gateway-glyph-title"
      style={{ height: "1.4rem", width: "auto" }}
    >
      <title id="llm-gateway-glyph-title">llm-gateway</title>
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <g strokeWidth={30}>
          <path d="M60 256h90" />
          <path d="M368 256C400 256 396 176 436 176h16" />
          <path d="M368 256h84" />
          <path d="M368 256C400 256 396 336 436 336h16" />
        </g>
        <g strokeWidth={24}>
          <path d="M220 184v-30" />
          <path d="M256 184v-30" />
          <path d="M292 184v-30" />
          <path d="M220 328v30" />
          <path d="M256 328v30" />
          <path d="M292 328v30" />
          <path d="M184 220h-30" />
          <path d="M184 292h-30" />
          <path d="M328 220h30" />
          <path d="M328 292h30" />
        </g>
        <rect strokeWidth={30} x={184} y={184} width={144} height={144} rx={26} />
        <rect strokeWidth={20} x={226} y={226} width={60} height={60} rx={10} />
      </g>
    </svg>
  );
}

function SectionBody({ section }: { section: SectionId }): ReactNode {
  switch (section) {
    case "status":
      return <StatusSection />;
    case "configuration":
      return <ConfigurationSection />;
    case "about":
      return <AboutSection />;
  }
}

export function App(): ReactNode {
  const path = usePath();
  const section = sectionForPath(path);

  useEffect(() => {
    // "/ui" and "/ui/" canonicalize to the default section — replace, not
    // push, so the first history entry is already the real URL.
    if (path === "/") replace(sectionPath(DEFAULT_SECTION));
  }, [path]);

  return (
    <div className="container-fluid">
      <div className="row">
        <aside
          className="col-auto border-end sticky-top align-self-start py-4 px-4"
          style={{ minWidth: "14rem" }}
        >
          <div className="d-flex align-items-center gap-2 text-body-emphasis">
            <BrandGlyph />
            <span className="fw-semibold">llm-gateway</span>
          </div>
          <nav className="nav nav-pills flex-column gap-1 mt-4" aria-label="Sections">
            {SECTIONS.map(({ id, label }) => (
              <Link
                key={id}
                to={sectionPath(id)}
                className={`nav-link ${id === section ? "active" : "link-body-emphasis"}`}
                aria-current={id === section ? "page" : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="col py-4 px-4">
          <SectionBody section={section} />
        </main>
      </div>
    </div>
  );
}
