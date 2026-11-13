# ADR-0018: the Truss web UI, redesigned

Amended by [ADR-0023](0023-factory-floor-ui.md) (proposed 2026-11-03, goal `ui-redesign` revision 5b): direction D and D2 replace this ADR's visual direction (the idea, the layouts by width, the tokens, the motion, the focus colour, the screenshot widths and states). Its behaviour contract, section 10's shell and per-state role assertions, stays.

Status: proposed, 2026-11-02. Written by the design crew `redesign-design` (stage 0 of goal `ui-redesign`, plan revision 4, approved auto at 2026-11-01T01:41:19Z with checker-36). It becomes accepted when the program manager (PM) merges this crew.

Decided by: the client ("The ui of truss is horrible ... I need a vastly modern ui. Completely rethink ui."; "Give UI / UX expert complete freedom to think it fresh and design it"; "You can use front end design plugin, or preferably vercel plugin"); the PO calls of 20:49 (amend brief, PM decisions 1 to 6: the stack, the fixed server contract, the design crew's freedom, the quality bar, behaviours re-pinned by behaviour, the screenshot verifier); the plan's layout (`plan-ui-redesign.md`, "Layout fixed by the plan"); and this crew for everything the plan leaves free.

Supersedes: the web-client parts of [ADR-0011](0011-local-web-ui.md) only. That is Decision 1's ui-web row ("Static HTML, CSS and plain ES modules. No bundler, no build step.") and Decision 7's "The browser imports the ESM file as is, so it needs no bundler." Everything else in ADR-0011 stands: the four modules, the session host, the request cards and their registry, ui-state, the SSE wire (Decision 5), the HTTP guard and routes (Decision 6), the design panel's sources, and `main.ts`'s flags and output (Decision 8).

## Context

The client reads the Truss UI as a run's control room: what Claude asks, what each crew is doing, what was decided. The current client lays this out as one long page of blocks. Nothing tells the client where to look when the run waits on them, and crews read as a flat list with no sense of stage or progress.

What stays fixed:

- **The server contract.** Routes, SSE events, the Host, Origin and token guard, and the cookie don't change (PM decision 2). The page CSP is `default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` (`ui/server/http/static.ts` `PAGE_CSP`). The wire is `ui/contract/state.schema.json`: a `snapshot` (`type`, `instance`, `seq`, `state`) and a `delta` (`type`, `seq`, optional `set` and `append`).
- **Every behaviour a user has today.** Answer brief questions, approve or deny tool use and replies, send messages, see crews and their members, decisions, ADRs, the design and the retro stage, and get desktop notifications (PM decision 5). The 83 `ui` and `contract` Playwright tests pin these by role and accessible name.
- **The quality floor.** axe clean at WCAG 2.2 AA in light and dark, phone to desktop widths, keyboard use throughout (PM decisions 3 and 5).

## Decision

### 1. Stack: the PO's default, kept

React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui on Radix primitives, lucide icons, and Geist Sans and Geist Mono. Every dependency is exact-pinned in `ui/package.json` and matches `ui/package-lock.json`. The plugin stays on Node built-ins only (P19); `ui/` stays out of the marketplace and out of the plugin install.

We keep the default because nothing in this design needs another stack, and the client asked for Vercel's tools. shadcn gives us component source we own and restyle, not a look we inherit.

Two limits come from the CSP, which blocks inline `<style>` elements, inline scripts, and fonts or images from `data:` URLs:

- **No component may inject a `<style>` element.** The plan notes that Radix and sonner can (`plan-ui-redesign.md`, "Notes for the design crew"). So the client uses no sonner, no toast, and no modal primitive that locks page scroll (Dialog, Sheet, AlertDialog, modal DropdownMenu or Popover). It uses Tabs, Collapsible, RadioGroup, Checkbox, Button, Textarea and Label, plus its own markup. Any other primitive is fine once the redesign specs' `securitypolicyviolation` listener stays silent with it on screen.
- **Fonts are self-hosted woff2 files** from an exact-pinned npm package, imported by the CSS so Vite emits them into `ui/web/assets/`. There is no font CDN. TODO: the web-app crew names the Geist font package and its version when it pins it.

### 2. Layout of the files

These paths are fixed by the plan:

| Path | Tracked | What it holds |
|---|---|---|
| `ui/app/` | yes | The client source: `main.tsx`, `App.tsx`, `store/` (the wire), `views/`, `components/` (shadcn source under `components/ui/`), `styles/` (tokens and the Tailwind entry), `fonts` imports. |
| `ui/vite.config.ts`, `ui/tsconfig*.json`, `ui/components.json` | yes | Build config at the package root, as Vite and shadcn expect. |
| `ui/web/` | no, `ui/.gitignore` ignores it | The build output. |
| `ui/screens/` | no | The screenshot set, `ui/screens/<state>-<phone\|tablet\|desktop>-<light\|dark>.png`: 7 states, 3 widths, 2 themes, 42 files. |

**Build command:** `npm --prefix ui run build` runs `vite build` and writes `ui/web/index.html` and its assets. The Vite config sets:

- `root: 'app'`, `build.outDir: '../web'`, `build.emptyOutDir: true`, `base: '/'`;
- `build.assetsInlineLimit: 0`, so no font or image becomes a `data:` URL the CSP would block;
- `build.modulePreload: { polyfill: false }`, so the entry carries no extra loader code;
- the `@tailwindcss/vite` plugin, so the CSS is one extracted file, never a style tag.

The start path stays one documented line: `npm --prefix ui ci`, then `npm --prefix ui run build`, then `npm --prefix ui start`. The `start`, `test`, `e2e` and `check:live` scripts don't change (`ui/package.json` today: `start` is `node server/main.ts`, `test` is `node --test contract/state.check.ts contract/session.check.ts contract/http.check.ts test/*/*.test.ts`).

### 3. The missing-build behaviour (ui-server, `extend`)

`main.ts` already serves `join(uiDir, 'web')` (`ui/server/main.ts` `server`). Today a missing `ui/web/index.html` gives `GET /` a `404 {"error":"notfound"}` (`ui/server/http/static.ts` `notFound`, `serveStatic`). ui-serve changes this, and only this:

1. **Startup.** When `<uiDir>/web/index.html` doesn't exist, `main.ts` writes one line to stderr, `truss-ui: no client build at <uiDir>/web/index.html; run: npm --prefix ui run build`, and goes on starting. It doesn't exit, and stdout still carries only `truss-ui listening on <url>` (`ui/server/main.ts`). `ui/test/startup/shutdown.test.ts` waits for that stdout line and fails only on an early exit (`start`); `ancestors.test.ts` waits for the same line (`readPid`). Neither reads stderr for silence, so both stay green with no build.
2. **The page.** While `ui/web/index.html` is missing, `GET /` and `GET /index.html` (after the guard, as now) answer `503` with `Content-Type: text/html; charset=utf-8`, the same page CSP, and a static page: an `<h1>` "Truss needs a client build" and the command `npm --prefix ui run build` in a `<code>` element. It has no inline style or script. Every other missing static path stays `404 {"error":"notfound"}`.
3. **Types.** `TYPES` (`ui/server/http/static.ts`) gains `'.woff2': 'font/woff2'`. It has no font type today, so a woff2 file is served as `application/octet-stream` (`serveStatic`).

The route table of ADR-0011 Decision 6 stays true: `/` and static files from `ui/web/`, `/vendor/marked.js`, `/api/events`, the two POST routes and `/api/image`. `/vendor/marked.js` stays a route even though the new client bundles `marked` (Decision 9 below). `ui/contract/build.check.ts` pins this section.

### 4. The idea: the run as an erection drawing

A Truss run is a structure going up: stages are bays, crews are members, and the project manager's merge bolts a member in place. The UI draws it that way, in the drafting conventions engineers already read:

- a **merged** crew is a solid member, ink on the plate;
- a **running** crew is a member in fabrication, drawn with section hatching (thin 135° lines) in patina;
- a **planned** crew is a dashed outline, not yet cut;
- a **dropped** crew is struck through;
- a **blocked** crew carries an oxide notch at its left end and the word `blocked`.

Every member also says its state in words (R-17: status and verdict as text, never colour alone). This drawing is the one bold thing on the page. Everything around it is quiet: no shadows, no gradients, no cards stacked as decoration.

The second rule is semantic, not decorative: **signal yellow means the run waits on you.** It appears only on the "Your move" region's edge, on an open request card's edge, and in the tab title count. When nothing waits, the page has no yellow on it at all.

### 5. Information architecture

```
banner ─ Truss, session status, model, cost, background tasks, notifications
main
├─ Your move          open request cards, then the goal/message box
├─ Run (tabs)         Crews │ Decisions and ADRs │ Design
│   └─ Crews panel    stage bays of crew members, then the Retro stage
└─ Transcript         the conversation, with answered and cancelled cards
```

- **Your move** comes first in the DOM and on screen, because it is the only place the client acts. Open cards stack oldest first. The goal/message box sits under them, so answering a card and writing a reply are one place.
- **Run** holds the three views as tabs: Crews (default), Decisions and ADRs, Design. Each tab's panel is a `tabpanel`, the "panel" the tests name.
- **Transcript** is the record: user and assistant turns, error entries, and each card once it is answered or cancelled, in time order.

There are no modals, drawers or routes. One document, so the Tab order and the screen-reader order are the same as the visual order at every width.

### 6. Layouts by width

Screenshot widths: phone 390 px, tablet 834 px, desktop 1440 px

Superseded: the `Screenshot widths:` line of [ADR-0023](0023-factory-floor-ui.md), section 5, replaces the line above. The line stays here as the record of revision 4.

R-17 adds 1024 px, which the tablet layout covers.

**Desktop (1024 px and up).** Two columns, a 28rem conversation column and a fluid run column. Your move sits at the top of the left column, sticky below the banner, and the Transcript fills the rest of the left column. On screen the Transcript is left and below Your move, and Run is right; in the DOM, Run comes before Transcript. The Transcript holds no controls beyond answered cards, so the Tab order still runs Your move, then Run.

```
┌ Truss   running   opus   $1.24   2 background tasks ─────── [Turn on notifications] ┐
├───────────────────────────┬─────────────────────────────────────────────────────────┤
│▌Your move                 │ [Crews] [Decisions and ADRs] [Design]                    │
│▌┌ Question from Claude ─┐ │  Stage 0        │ Stage 1            │ Stage 2           │
│▌│ Store  ○ SQLite (Rec.)│ │  ███ design ███ │ ▨▨ quotas ▨▨▨▨▨▨   │ ┄┄ gateway ┄┄┄┄   │
│▌│        ○ Postgres     │ │  merged, PASS   │ running, QC none   │ planned           │
│▌│ [Submit answers]      │ │                 │ ▮▨ ratelimit ▨▨▨   │                   │
│▌└───────────────────────┘ │                 │ blocked, QC FAIL   │                   │
│ Goal or message  [Send]   │ Retro stage  Extract: done   Judges: running   …          │
│ Transcript …              │                                                          │
└───────────────────────────┴─────────────────────────────────────────────────────────┘
```

**Tablet (834 px; 640 to 1023 px).** One column: Your move, Run, Transcript. Bays sit two to a row.

**Phone (390 px; under 640 px).** One column, the same order. Bays stack one per row, each member full width. The banner wraps to two lines: the title and status on one, the model, cost and notifications button on the next.

At every width `documentElement.scrollWidth <= clientWidth`. Long slugs, paths and URLs wrap (`overflow-wrap: anywhere`); markdown code blocks scroll inside their own box. Bays use `grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr))`, so six stages wrap into rows instead of widening the page.

Text is left aligned everywhere. Transcript and markdown lines stop at 68ch.

### 7. Tokens

Tokens live in `ui/app/styles/tokens.css` as CSS variables, mapped into Tailwind v4 with `@theme inline`. Components use the Tailwind names (`bg-plate`, `text-ink`), never raw hex.

**Colour.** Two themes, chosen by `prefers-color-scheme` only. There is no theme switch: it would be one more Tab stop, and the choice would have to be stored, which R-13 rules out. Playwright's `colorScheme` drives both themes in the specs.

| Token | Light | Dark | Use |
|---|---|---|---|
| `plate` | `#E9EDF0` galvanized plate | `#141B24` night shift | page background |
| `sheet` | `#FFFFFF` | `#1E2733` deck | surfaces: cards, bays, inputs |
| `ink` | `#18212C` graphite | `#E6EBF0` chalk | text; merged members |
| `steel` | `#4E5A68` | `#9AA7B6` haze | secondary text |
| `rule` | `#8995A3` | `#6E7D8E` | borders, bay chords, input outlines |
| `signal` | `#F5C542` signal yellow | `#F5C542` | "waits on you" fill and edge, with `ink` or `night` text |
| `signal-edge` | `#9A7400` | `#F5C542` | signal as a line or icon on `sheet` |
| `patina` | `#0B6E74` | `#5CC8CF` | running: hatching, focus ring, links |
| `patina-wash` | `#D3E9EA` | `#123A40` | running member fill under its label |
| `oxide` | `#B3261E` | `#FF8A7A` | blocked, failed, error |
| `oxide-wash` | `#F6DAD6` | `#4A1F1B` | error card and blocked member fill |

Contrast, computed with the WCAG relative-luminance formula: `ink` on `plate` 13.80 (dark 14.44), `steel` on `plate` 5.97 (dark `haze` on `night` 7.08), `steel` on `sheet` 7.03 (dark 6.16), `ink` on `signal` 10.02 (dark `night` on `signal` 10.68), `patina` on `sheet` 6.01 (dark 7.62), `oxide` on `sheet` 6.54 (dark 6.58), `ink` on `patina-wash` 12.85, `ink` on `oxide-wash` 12.31, `chalk` on `patina-wash` 10.27, `chalk` on `oxide-wash` 11.65. Non-text: `rule` on `sheet` 3.05 (dark `rule` on `deck` 3.58), `signal-edge` on `sheet` 4.31. All text pairs clear 4.5:1 and all component edges clear 3:1. Hatching never runs under text: a member's label sits on a solid `patina-wash` plate, and the hatch fills only the rest of the bar.

**Type.** Geist Sans for everything people read, Geist Mono only for literal machine strings: crew slugs, agent names, paths, branch names, model ids and code. Mono is never used for labels. Scale on a 16 px base with a 1.25 ratio:

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `text-xs` | 12.8 / 18 px | 450 | member detail, timestamps |
| `text-sm` | 14 / 20 px | 450 | crew lines, list items |
| `text-base` | 16 / 24 px | 400 | transcript, markdown, inputs |
| `text-lg` | 20 / 28 px | 600 | card headings, region headings |
| `text-xl` | 25 / 32 px | 600 | the `Truss` wordmark |
| `text-stage` | 40 / 40 px | 300, tabular figures | the stage numeral in each bay heading |

The stage numeral is the type's one active role: a large, light, tabular figure that reads as a bay mark on a drawing. Sentence case everywhere. No all-caps labels, no eyebrows above headings.

**Spacing.** A 4 px base: `space-1` 4, `space-2` 8, `space-3` 12, `space-4` 16, `space-6` 24, `space-8` 32, `space-12` 48 px. Cards pad `space-4`; bays gap `space-6`; regions gap `space-8`.

**Shape.** Radius follows the part, not one value: members 1 px (cut steel), cards and inputs 4 px, the focus ring 2 px outside the element. No shadows anywhere; depth comes from `plate` against `sheet` and a 1 px `rule`.

**Motion.**

| Token | Value | Use |
|---|---|---|
| `duration-quick` | 120 ms | button press, checkbox, focus ring |
| `duration-open` | 200 ms | a crew line opening into its members (height and opacity) |
| `duration-arrive` | 320 ms | a request card arriving in Your move |
| `ease-settle` | `cubic-bezier(0.2, 0, 0, 1)` | all of the above |

The one orchestrated moment: a new request card slides 8 px down into Your move and the region's signal edge fills top to bottom, once. Nothing moves on its own otherwise. Hatching is static, statuses change without animation, and there are no hover transitions on members. Under `prefers-reduced-motion: reduce` every duration is 0 ms and nothing translates.

### 8. Keyboard

- **Tab order** follows the DOM: the skip link `Skip to Your move` (visible on focus), the banner's notifications button, each open card's controls in order, the goal/message box and `Send`, the Run tablist, then the active panel's controls.
- **Tabs:** one Tab stop for the tablist. Left and Right move and activate, Home and End go to the first and last tab (Radix Tabs, automatic activation).
- **Crew lines:** each is a button with `aria-expanded`; Enter or Space opens and closes its members.
- **Question cards:** a single-select question is a radio group (arrow keys move, Space selects); a multi-select question is a set of checkboxes (Space toggles). Under the options, each question has a text box, `Your own answer`, always shown and reachable by Tab; text typed there is the answer to that question. `Submit answers` sends, and Enter in the text box does the same. The answered card keeps its name and reads `Answered.`
- **Permission and reply cards:** `Approve` and `Deny`, plus an optional message box that goes with either.
- **Goal/message box:** Ctrl+Enter or Cmd+Enter sends, Enter adds a new line, and `Send` is the next Tab stop after the box. The box grows with its text up to half the viewport height, then scrolls; it is also resizable by its handle.
- **After an answer**, focus moves to the first control of the next open card, else to the goal/message box. It never falls to `body` (R-18).
- **No single-key shortcuts**, so WCAG 2.1.4 has nothing to turn off.
- **Focus** shows as a 2 px `patina` ring offset 2 px, on every Tab stop, in both themes.

### 9. Data flow in the client

- One store module in `ui/app/store/` opens `EventSource('/api/events')`. A `snapshot` replaces the whole state; a `delta` replaces each `set` key whole and appends `append.transcript` entries whose `n` is above the last one held. A snapshot with `v` other than 1 calls `location.reload()` (ADR-0011 Decision 5).
- Components read the store through `useSyncExternalStore` with narrow selectors, so a crew's QC change re-renders that crew line, not the page.
- POSTs go to `/api/message` and `/api/requests/<id>/answer` with `Content-Type: application/json`. A `409 answered` leaves the card answered; `409 ended` shows "The session has ended. Start the UI again to send more." in the Your move region.
- The Design and Decisions and ADRs panels load as lazy chunks (`React.lazy`), with `marked` imported from the npm package inside the Design chunk. Raw HTML in markdown is escaped, never passed through. A `mermaid` code block shows as its source, labelled `mermaid diagram (source)`. Images load from `/api/image`.
- The tab title is `(<open requests>) Truss`, or `Truss` at 0.
- Desktop notifications: nothing is asked until the client presses `Turn on notifications`. Then each new question and permission card raises one notification; reply cards and background status raise none.

### 10. Screens

Screenshot states: empty, pending-question, pending-approval, crews-running, blocked-crew, retro, decisions

Superseded: the `Screenshot states:` line of [ADR-0023](0023-factory-floor-ui.md), section 4, replaces the line above, with ten D2 states. Its rename table maps `pending-question` to `question`, `pending-approval` to `approval` and `blocked-crew` to `stuck-crew`. The shell and the per-state assertions below stay in force.

Each screenshot is `ui/screens/<state>-<phone|tablet|desktop>-<light|dark>.png`, taken `fullPage: true` at deviceScaleFactor 1 from a fixture made from `ui/contract/fixtures/run/`, copied to an `mkdtemp` dir with a per-run value planted (the states `empty`, `pending-question` and `pending-approval` have no truss dir: see section 11).

Every state has this shell. The specs assert it in each state:

| Role | Accessible name | Notes |
|---|---|---|
| `banner` | none | holds the session status, model, cost and background task count as text |
| `heading` level 1 | `Truss` | in the banner |
| `status` | `Session` | its text is the session status in words: `idle`, `running`, `waiting`, `working (N background tasks)`, `ended`, or `error: <first line>` |
| `button` | `Turn on notifications` | becomes `Notifications on` once granted |
| `link` | `Skip to Your move` | first Tab stop |
| `main` | none | |
| `region` | `Your move` | heading level 2 `Your move` |
| `textbox` | `Goal or message` | in a `form` named `Message` |
| `button` | `Send` | |
| `tablist` | `Run` | tabs `Crews`, `Decisions and ADRs`, `Design` |
| `log` | `Transcript` | heading level 2 `Transcript` |

Per state, what the spec asserts beyond the shell:

**empty.** No session yet, no Truss dir.
- The `status` named `Session` reads `idle`.
- Your move holds no `article`. A `heading` level 3 `Start a run` and the text "Type a goal. Truss plans it, and asks you here when it needs a call."
- A `list` named `Run status` with a `listitem` per notice, each text starting `Status:`.
- The `Crews` tab's `tabpanel` holds a `region` named `Crews` with the text `No plan yet.` and no crew `button`.
- No `region` named `Retro stage`.

**pending-question.** One open question card.
- An `article` named `Question from Claude: <header>` in `Your move`. In it, a `radiogroup` named after the question text, with one `radio` per option; the first `radio`'s name ends `(Recommended)`, whatever the order the session sent.
- A `textbox` named `Your own answer` under the options, and a `button` `Submit answers`.
- The page title is `(1) Truss`.

**pending-approval.** An open reply card (plan approval) and an open permission card.
- An `article` named `Reply needed` holding the result text, with `button`s `Approve` and `Deny` and a `textbox` named `Message with your answer`.
- An `article` named `Permission request: <tool name>` holding the tool name, title, summary, decision reason and blocked path as text, with `button`s `Approve` and `Deny`.
- The page title is `(2) Truss`.

**crews-running.** A plan with crews across stages 0 to 2, some running.
- In the `region` named `Crews`, a `group` per stage named `Stage <n>`, each with a `heading` level 3 `Stage <n>`.
- In each group, a `list` with a `listitem` per crew holding one `button` (with `aria-expanded`) whose name holds the slug, `stage <n>`, the status in words, the verdict, `QC <PASS|FAIL>` or `QC none`, and the latest activity. Exactly one `button` per slug on the page.
- Pressing a running crew's button sets `aria-expanded="true"` and shows a `list` named `<slug> members` with a `listitem` per member: name, type, model and effort, and state.

**blocked-crew.** One running crew is blocked: its newest QC verdict is `FAIL`, a member's state is `stalled`, or its latest activity is a report with the marker `BLOCKED`.
- That crew's `button` name holds `blocked` and the reason in words (`QC FAIL`, `stalled <minutes> min` or `reported BLOCKED`).
- Your move holds no card for it: a blocked crew is the PM's to handle, not a request.

**retro.** `retro/state.json` present.
- A `region` named `Retro stage` after the `region` named `Crews` in document order.
- In it a `list` with five `listitem`s named `Extract: <status>`, `Judges: <status>`, `Triage: <status>`, `Fix goal: <status>`, `Fixes applied: <status>`; a running step's detail shows as text inside its item.

**decisions.** The `Decisions and ADRs` tab selected.
- The `tab` named `Decisions and ADRs` has `aria-selected="true"`, and its `tabpanel` is named `Decisions and ADRs`.
- A `region` named `Decisions` with a `heading` level 3 per `## Run` heading and a `list` of `listitem`s, one per decision line, in file order.
- A `region` named `ADRs` with a `list` of `listitem`s, each holding the ADR title and its status in words.

The Design tab, the session error state and the answered cards are not separate screenshot states; the existing tests and the axe specs cover them.

### 11. What the redesign specs check

The redesign specs (`ui/contract/redesign/*.spec.ts`) load the real server through `ui/e2e/harness.ts`. For each state and theme they assert the roles and names above with `getByRole`, run axe (`new AxeBuilder(...)` with `.analyze()`, WCAG 2.2 AA tags) and fail on any violation. At each width they assert `documentElement.scrollWidth <= clientWidth` and write the full-page screenshot. They fail on any `securitypolicyviolation` and any console error. After load, each changes one fixture file and asserts the page shows the change. The three states `empty`, `pending-question` and `pending-approval` are served by the fake interface in `ui/e2e/harness.ts`, which has no truss dir and no fixture copy; for those the per-run value goes into the interface's state and the change is one pushed transcript delta, which the page must show.

## Rename table

The design keeps every term the base titles use: the header (`banner`), cards, crew lines, panels (the tab panels), the goal box, the Crews region and the Retro stage region, the `Status:` notices and the tab title. So no base title becomes untrue, and the table has only its header row. The e2e re-pin tasks add a row here if a re-pin changes a title.

| Old title | New title |
|---|---|

## Consequences

- `ui/web/` is no longer source. A fresh checkout needs `npm --prefix ui run build` before the page works. Without it the server still starts, says so on stderr and on the page (section 3), and `npm --prefix ui test` stays green.
- The client is a build, so its source can't be read by opening `ui/web/`. Its source is `ui/app/`.
- The client adds runtime dependencies (React, Radix, lucide, Geist) and build dependencies (Vite, TypeScript, Tailwind). They live only in `ui/package.json`; the plugin gains none.
- No style tag, no modal and no toast: the CSP stays as it is, and the specs prove it on every state.
- Light and dark follow the OS only; there is no manual switch.

## Not confirmed

- TODO: the Geist font package and version, and the exact versions of every new dependency. The web-app crew pins them; this ADR names none.
- TODO: whether each Radix primitive in section 1 renders with no `securitypolicyviolation`. The redesign specs' listener proves it on the built page; until the build exists it is a design rule, not a measurement.
