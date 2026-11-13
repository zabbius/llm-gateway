/**
 * The SPA shell: a flex row with the dock as a sticky left aside
 * (border-end) leading and the active section as the main content following.
 * The dock header is the
 * brand — the glyph mark inlined so it inherits currentColor — above the
 * section nav; the dock nav is the only navigation surface. Routing is
 * client-side over /ui/* (router.tsx, ADR-006): "/ui" and "/ui/" replace to
 * the default section, unknown paths render the default section.
 *
 * Auth (ADR-008): when the gateway gates /api/*, the shell swaps to a login
 * card on the first 401; after a successful login (or on an ungated gateway)
 * the sections render as usual, and a session that came from a login gets a
 * Log out control in the dock. The shell itself is public — every protected
 * byte arrives from /api.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
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
import { ApiFetchError, fetchStatus, login as loginRequest, logout as logoutRequest } from "./api.ts";
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

/** The shell's auth state: probe → login card or the sections. */
type AuthState =
  | { kind: "checking" }
  | { kind: "login"; error: string | null }
  | { kind: "ready"; canLogout: boolean };

/** The login card — the only login affordance (the server sends no native prompt). */
function LoginCard({
  error,
  busy,
  onSubmit,
}: {
  error: string | null;
  busy: boolean;
  onSubmit: (user: string, password: string) => void;
}): ReactNode {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (user === "" || password === "" || busy) return;
    onSubmit(user, password);
  };

  return (
    <div className="container-fluid d-flex justify-content-center align-items-center" style={{ minHeight: "100vh" }}>
      <form className="card shadow-sm" style={{ width: "22rem" }} onSubmit={submit}>
        <div className="card-body">
          <h1 className="h5 card-title mb-2 d-flex align-items-center gap-2 text-body-emphasis">
            <BrandGlyph />
            llm-gateway
          </h1>
          <p className="text-body-secondary small mb-3">Sign in to the management surface.</p>
          {error !== null && (
            <div className="alert alert-danger py-2 small" role="alert">
              {error}
            </div>
          )}
          <div className="mb-3">
            <label className="form-label" htmlFor="login-user">
              Login
            </label>
            <input
              id="login-user"
              className="form-control"
              autoComplete="username"
              value={user}
              onChange={(event) => setUser(event.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="mb-3">
            <label className="form-label" htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              className="form-control"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <button className="btn btn-primary w-100" type="submit" disabled={busy || user === "" || password === ""}>
            {busy && <span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>}
            Sign in
          </button>
        </div>
      </form>
    </div>
  );
}

export function App(): ReactNode {
  const path = usePath();
  const section = sectionForPath(path);
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });

  useEffect(() => {
    // "/ui" and "/ui/" canonicalize to the default section — replace, not
    // push, so the first history entry is already the real URL.
    if (path === "/") replace(sectionPath(DEFAULT_SECTION));
  }, [path]);

  useEffect(() => {
    // One auth probe on mount: a 401 swaps to the login card; any other
    // outcome (including an auth-off gateway) renders the sections — they
    // carry their own error surfaces.
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        await fetchStatus();
        if (!cancelled) setAuth({ kind: "ready", canLogout: false });
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ApiFetchError && cause.status === 401) {
          setAuth({ kind: "login", error: null });
        } else {
          setAuth({ kind: "ready", canLogout: false });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submitLogin = useCallback(async (user: string, password: string): Promise<void> => {
    try {
      await loginRequest(user, password);
      setAuth({ kind: "ready", canLogout: true });
    } catch (cause) {
      setAuth({ kind: "login", error: cause instanceof Error ? cause.message : String(cause) });
    }
  }, []);

  const submitLogout = useCallback(async (): Promise<void> => {
    try {
      await logoutRequest();
    } catch {
      // The session is as good as gone either way — always land on the card.
    }
    setAuth({ kind: "login", error: null });
  }, []);

  if (auth.kind === "checking") {
    return (
      <div className="container-fluid d-flex justify-content-center align-items-center" style={{ minHeight: "100vh" }}>
        <div className="spinner-border" role="status" aria-hidden="true"></div>
        <span className="visually-hidden">Loading…</span>
      </div>
    );
  }

  if (auth.kind === "login") {
    return (
      <LoginCard
        error={auth.error}
        busy={false}
        onSubmit={(user, password) => {
          void submitLogin(user, password);
        }}
      />
    );
  }

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
          {auth.canLogout && (
            <button
              type="button"
              className="btn btn-outline-secondary btn-sm w-100 mt-4"
              onClick={() => {
                void submitLogout();
              }}
            >
              Log out
            </button>
          )}
        </aside>
        <main className="col py-4 px-4">
          <SectionBody section={section} />
        </main>
      </div>
    </div>
  );
}
