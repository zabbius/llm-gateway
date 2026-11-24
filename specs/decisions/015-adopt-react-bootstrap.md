# ADR-015: `react-bootstrap` as the SPA's component layer

## Status

Accepted

## Context

The SPA was built directly on the Bootstrap 5 stylesheet: every control was hand-written markup carrying Bootstrap class strings — tables, forms, alerts, buttons, the login card — and destructive deletes leaned on the native `window.confirm()`. That worked, and the stack invariant in [frontend.md](../domains/frontend.md) pinned the stack to React + Bootstrap with an explicit ban on component libraries — a ban written when nothing sat on top of the Bootstrap CSS. The costs of the status quo compounded with each new affordance: the same skeletons (form groups, table rows, alert bars) were re-typed by hand in every section, accessibility machinery (focus trapping, Esc handling, ARIA wiring) existed only where someone had remembered to write it, and the native confirm dialog blocks the event loop, renders outside the SPA's theme, and cannot express the severity of the destructive action it gates.

The question was whether to keep hand-writing Bootstrap markup or adopt a React component layer that renders those same Bootstrap classes. The historical candidate, `reactstrap`, is dormant: its latest release (9.2.3) predates React 19 and carries no React 19 adaptation. `react-bootstrap` 2.10.x explicitly updated its internals for React 19 (deprecated methods removed, React 18+ support), and the SPA is a React 19 codebase (`web/package.json`: `react ^19.3.1`). The ADR bar is met: the choice constrains every future SPA surface — each new control composes through the component layer, and the no-component-library wording of the stack invariant had to be rewritten — and it had a real rejected alternative set: the incumbent hand-written markup, the dormant `reactstrap`, and a self-built headless layer.

## Decision

1. **`react-bootstrap` is the SPA's component library, consumed by direct named imports.** The controls the SPA renders go through react-bootstrap — in use: `Alert`, `Badge`, `Button`, `Card`, `Form`, `Modal`, `Nav`, `Spinner`, `Table` — and every consuming file imports exactly the components it uses (`import { Button, Modal } from "react-bootstrap"`), mirroring the lucide-react import rule: no wrapper module, no barrel. Tree-shaking keeps the cost bounded: the migration added +41.7 KB of JS (9 components across 6 files) and left the stylesheet byte-identical.
2. **The Bootstrap stylesheet stays the single styling vocabulary.** react-bootstrap renders Bootstrap's own classes, so the prebuilt CSS imported once in `web/src/main.tsx` is unchanged, Bootstrap utility classes keep working alongside the components, and nothing about the bundle-at-build/no-CDN rule moves: every dependency still ships inside the build output, nothing loads from an external server at runtime.
3. **One shared confirmation surface replaces `window.confirm()`.** `web/src/ui/ConfirmModal.tsx` renders a react-bootstrap `Modal` driven by a caller-owned `ConfirmDialog` value — open exactly while the value is non-null, and the caller clears it as part of the confirmed action. Esc, the backdrop, the header close button, and Cancel only dismiss; the action happens solely through the confirm button, which carries `variant="danger"` when the dialog is destructive. All three CRUD sections route every delete through it — a styled, non-blocking dialog that can carry destructive visual weight, in place of the native dialog that could do none of that.
4. **The rest of the stack fence holds.** `lucide-react` stays the only icon library (direct imports, no barrel), the hand-rolled history router stays the only router, and react-bootstrap is the only component library — the stack invariant in [frontend.md](../domains/frontend.md) names react-bootstrap explicitly so the fence and the code cannot drift.

## Consequences

Positive:

- Repeated skeletons and accessibility duties are the library's job now: modals trap focus and answer Esc with the right ARIA state, forms wire labels and help text, tables, alerts, badges, and spinners are consistent — a new affordance composes instead of re-typing markup.
- Deletes are reviewed through one styled, non-blocking dialog with a red destructive variant, replacing a native dialog that blocked the event loop, rendered out of theme, and expressed nothing.
- The stylesheet is untouched: react-bootstrap emits Bootstrap's own classes, so the prebuilt CSS survived the migration byte-identical and utility classes keep composing with component output.
- The bundle cost is measured and small: +41.7 KB of JS for the whole migrated surface, zero CSS delta.

Negative:

- A runtime dependency with its own release cadence and React-compatibility line now sits under every SPA surface; a future React major is gated on react-bootstrap following (2.10.x carries the React 19 adaptation today).
- The rendered markup is library-shaped: debugging a control means knowing which Bootstrap classes react-bootstrap emits, and a bespoke layout occasionally fights the library's structure instead of a class string.
- The initial JS bundle grew ~15% (315 KB from 273 KB) — acceptable for a LAN operator tool, but not free.

## Alternatives Considered

- **`reactstrap`:** rejected — a dormant upstream: the latest release (9.2.3) predates React 19 and carries no React 19 adaptation, while react-bootstrap 2.10.x explicitly updated its internals for React 19; adopting the unmaintained fork over the maintained library inverts the maintenance argument that motivated a component layer in the first place.
- **Status quo — hand-written class markup with `window.confirm()`:** rejected — every control re-typed Bootstrap skeletons and hand-carried its ARIA and focus duties, and deletes leaned on a native dialog that blocks the event loop, renders out of theme, and cannot express destructiveness; the cost compounds with every new affordance.
- **A self-built headless component layer over the Bootstrap CSS:** rejected — it displaces the very thing the Bootstrap CSS was adopted for: the project would own focus trapping, form wiring, and ARIA correctness forever, re-implementing what react-bootstrap ships tested, growing maintenance precisely where the SPA has the least of it.
- **A larger UI kit (MUI, Chakra, Ant Design, …):** rejected — it displaces the Bootstrap stylesheet entirely with its own styling system and a far larger bundle, breaking the React + Bootstrap stack identity the specs pin; a LAN operator tool gains nothing that justifies it.
