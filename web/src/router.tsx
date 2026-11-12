/**
 * Minimal history-API router for the /ui namespace (ADR-006). No router
 * library: `usePath()` observes `location.pathname` with the `/ui` base
 * stripped (popstate plus in-app navigation), `navigate()` / `replace()`
 * push history entries through the base, and `Link` renders real `/ui/*`
 * hrefs and intercepts plain clicks. The server never sees a section path —
 * any unmatched GET/HEAD under /ui/* serves index.html (SPA fallback).
 */
import {
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";

/** The SPA namespace — every SPA URL is this base plus an in-namespace path. */
export const UI_BASE = "/ui";

/** The SPA sections, in dock order. A new section = one entry here + a component. */
export const SECTIONS = [
  { id: "status", label: "Status" },
  { id: "configuration", label: "Configuration" },
  { id: "about", label: "About" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/** Rendered when the path is the namespace root or names nothing known. */
export const DEFAULT_SECTION: SectionId = "status";

/** The in-namespace path of a section (`"/status"` for `"status"`). */
export function sectionPath(id: SectionId): string {
  return `/${id}`;
}

/** Strip the /ui base from an absolute pathname; the root of the namespace is "/". */
function stripBase(pathname: string): string {
  const hasBase = pathname === UI_BASE || pathname.startsWith(`${UI_BASE}/`);
  const bare = hasBase ? pathname.slice(UI_BASE.length) : pathname;
  return bare === "" ? "/" : bare;
}

/** Absolute href for an in-namespace path (the namespace root has no trailing slash). */
function hrefFor(path: string): string {
  const normalized =
    path === "" || path === "/" ? "" : path.startsWith("/") ? path : `/${path}`;
  return normalized === "" ? UI_BASE : `${UI_BASE}${normalized}`;
}

/** Map an in-namespace path to its section; unknown paths use the default section. */
export function sectionForPath(path: string): SectionId {
  const name = path.split("/")[1] ?? "";
  return SECTIONS.some((section) => section.id === name)
    ? (name as SectionId)
    : DEFAULT_SECTION;
}

/**
 * pushState/replaceState do not fire popstate, so in-app navigation notifies
 * `usePath()` subscribers directly through this set.
 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** pushState navigation through the /ui base (a back/forward-able entry). */
export function navigate(path: string): void {
  window.history.pushState(null, "", hrefFor(path));
  notify();
}

/** replaceState through the /ui base — canonicalizing URLs without a new entry. */
export function replace(path: string): void {
  window.history.replaceState(null, "", hrefFor(path));
  notify();
}

/**
 * The current in-namespace path, reactive: popstate (back/forward, manual URL
 * edits) and in-app navigate/replace both update it.
 */
export function usePath(): string {
  const [path, setPath] = useState(() => stripBase(window.location.pathname));
  useEffect(() => {
    const update = (): void => setPath(stripBase(window.location.pathname));
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  /** In-namespace path, e.g. "/status" — the rendered href gets the /ui base. */
  to: string;
}

/**
 * An anchor with a real shareable `/ui/*` href; a plain left click is
 * intercepted into client-side navigation, every modified click (new tab,
 * middle click) keeps the browser's native handling.
 */
export function Link({ to, children, ...rest }: LinkProps): ReactNode {
  return (
    <a
      {...rest}
      href={hrefFor(to)}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
