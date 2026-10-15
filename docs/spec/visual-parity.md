# Visual parity record

This is the M4 record for the plan's §9 acceptance criteria. It has two parts: a
functional checklist (the hard gate — **功能对齐**) and a computed-style and
geometry comparison against the reference page (the target — **设计语言接近**).

Two things this document is not. It is not a build gate: nothing here fails a
build, and nothing here should. And it is not a claim that the two pages look
alike pixel for pixel — the plan rules that out on purpose, because a status page
that is a pixel copy of another product is a legal problem and an original one
that reads the same way is not.

## 1. Functional checklist (hard gate)

Each row was exercised against the fixture in `apps/web/verify/api-stub.ts`,
served by `verify/vite.config.verify.ts`. "Verified" means observed in a browser,
not read in the source.

| Criterion | State | How it was verified |
|---|---|---|
| Component / section division | ✅ | Section "Public surface" renders with its description; `cmp-api` and `cmp-web` are listed inside it; `cmp-mobile` and `cmp-downloads` render ungrouped. Four `[data-component]` rows total. |
| Expand and collapse events | ✅ | Each change is a `<details>`; the ongoing incident renders open, the scheduled maintenance and the resolved incident render closed. Content is present in the DOM while closed, so Ctrl-F reaches it. |
| Subscribe dialog | ✅ | `subscribe-open` opens a Radix dialog (`subscribe-dialog` visible, count 1). Submitting the form reached the API stub and rendered `subscribe-success` with `role="status"`. Component checkboxes render only because the page has more than one component. |
| Deep links | ✅ | Loading `/status/fixture#change-chg-2` opens that entry's disclosure (`open: true`), which it is not by default — `HashTargetOpener` does it. Clicking a permalink inside the page changes the hash and opens `#change-chg-3` the same way. |
| Time zone | ✅ | Timestamps render as `<time datetime="…Z">`; the pre-hydration text is a UTC slice, and after hydration the browser formats them in the visitor's zone (`Oct 8, 2026, 12:39 AM` for a `2026-10-07T16:39Z` value in the test browser's zone). |
| Calendar / chart toggle | ✅ | A three-way radiogroup: `Chart` (90-bar strip), `Calendar` (month grid), `List` (90-row table). Switching was observed in both directions; the strip is hidden when the calendar is shown, and the calendar's Monday-first alignment was checked against real 2026 weekdays (1 July is a Wednesday, 1 August a Saturday, 1 September a Tuesday, 1 October a Thursday). |
| RSS / Atom | ✅ | `/status/fixture/feed.xml` returns 200 with `application/atom+xml; charset=utf-8`, `public, max-age=60`, three entries, and `rel="self"` pointing at the **web** origin. `/status/fixture/snapshot.json` proxies the API untouched, including its 503. |
| Responsive breakpoints | ✅ | At 1280×900 the content column is 768px and the document does not scroll sideways. At 375×812 the column is 360px, the status banner grows from 50px to 82px tall as its text wraps, the action row wraps to 68px, and `document.scrollWidth === clientWidth` — no horizontal page overflow. The only element wider than the viewport is the list-view table (448px), and it sits in an `overflow-x-auto` wrapper, so it scrolls inside itself. |
| i18n | ✅ | With `locale=zh-CN` the document is `lang="zh-CN"`, the title is `Fixture Service 状态`, the banner reads 严重故障, the affected count 4 个组件中有 1 个受影响, and the view toggle 图表 / 日历 / 列表. No apostrophes appear in either catalog, because ICU MessageFormat treats `'` as an escape. |
| Dark mode | ✅ | Selecting Dark sets `class="dark"` on `<html>` and the palette genuinely flips: `html` background `rgb(248,250,252)` → `rgb(2,6,23)`, status banner `oklch(0.971 0.013 17.38)` → `oklch(0.258 0.092 26.042)`. Selecting Light reverses it. |

## 2. Computed style and geometry (target)

Reference values were recorded by reading the reference page's computed styles and
element geometry in a browser. They are measurements of a public web page, not
copied assets: no stylesheet, markup, font file, image or copy was taken from it.

| Aspect | Reference | This project | Delta |
|---|---|---|---|
| Content column | 720px (container `max-w-2xl`, `box-content`) | 768px (`max-w-3xl`) | +48px |
| Horizontal padding | 16px, 24px from `md` | 24px at every width | — |
| Vertical padding | 32px | 40px | +8px |
| Vertical rhythm | 24px | 32px | +8px |
| Corner radius | 12px outer shell, 8px inner | 8px | −4px on the shell |
| Typeface | Inter | Inter, then `ui-sans-serif` etc. | — |
| Theme layer | shadcn neutral HSL custom properties (`--background`, `--primary`, `--radius: 0.5rem`) | Tailwind's `slate` scale used directly, no custom-property layer | different mechanism, similar result |
| History strip | inline SVG, `height=16`, 90 rects `width=5 rx=2`, x step 6.5px | 90 spans, `h-8` (32px), 6.63px wide, `rx` 2px, step 7.63px | taller; same construction and bar count |
| Unmeasured day | `hsl(var(--muted-foreground) / 0.15)` | `bg-slate-100` light, `bg-slate-800/60` dark | distinct from every status colour, as intended |
| `operational` | `#22c55e` (green-500) | `#10b981` (emerald-500) | different hue family |
| `degraded_performance` | `#eab308` (yellow-500) | `#f59e0b` (amber-500) | different hue |
| `partial_outage` | `#f97316` (orange-500) | `#f97316` (orange-500) | — |
| `full_outage` | `#ef4444` (red-500) | `#ef4444` (red-500) | — |
| `maintenance` | not observed | `#0ea5e9` (sky-500) | — |
| `unknown` | not observed | `#94a3b8` (slate-400) | — |
| Status indicator | 16px coloured disc with a 10px white lucide glyph | 8px coloured dot, no glyph | simpler |
| Calendar | month grid, Monday first, 35 cells, 30px day cells, dot on days with events | month tables, Monday first, 36px day cells, dot on every day, ring on today | dot means "measured status", not "has an event" |
| Subscribe dialog | Radix Dialog, `max-w-lg`, email field plus per-component checkboxes | Radix Dialog, email field plus per-component checkboxes | — |

### Where the differences are deliberate

**The two greens and the two ambers.** The reference uses Tailwind's `green` and
`yellow` scales for operational and degraded. This project uses `emerald` and
`amber`. The reason is not aesthetic preference: `green-500` and `emerald-500` sit
close enough that a reader cannot tell which convention a page is using, but
`yellow-500` is bright enough that it reads as a warning next to `orange-500`,
which is the *next* severity up. `amber-500` keeps a visible gap from orange while
staying clearly distinct from emerald. The four fault colours remain ordered and
separated, which is the property that matters.

**The wider column and looser rhythm.** 768px rather than 720px, and 32px rather
than 24px. The content here includes a 90-day strip and a three-column month
calendar, both of which get cramped at 720px. This is a considered departure, not
an oversight.

**No custom-property theme layer.** The reference routes every colour through
shadcn's `--background` / `--primary` / `--radius` custom properties. This project
uses Tailwind's palette classes directly and swaps them with `dark:`. The visible
result is similar — restrained neutrals, one accent, thin borders — but there is
no token layer to restyle from. Adding one later is a mechanical change; leaving
it out now means one fewer indirection while the palette is still moving.

**A dot per day rather than a dot per event.** In the reference calendar a dot
marks a day that has an incident. Here a dot carries the day's derived status, so
every measured day has one. That is a different question answered — "how did this
component do" rather than "was there an incident" — and it is the question this
page's history is about.

## 3. What could not be executed

The plan's §9 asks for two visual paths: (a) a computed-style and geometry diff,
and (b) rendered PNGs handed to a human-perspective review.

Path (a) is above. **Path (b) did not run**, and this is the honest state rather
than a completed check:

- The PNGs were rendered — `xvfb-run firefox --screenshot` at 1280×1800 in light
  and dark, and at 390×1500 — and exist as artefacts.
- No reviewer could look at them. The `visual-judge` subagent's model provider is
  not available in this environment (`provider-not-found`), and the session model
  does not accept image input. The in-app browser's screenshot path also fails
  here (`browser screenshot surface preparation timed out`).
- Path (a) is not a substitute for it. A diff table says the radius is 8px; it
  cannot say whether the page looks right.

So the numbers above are trustworthy and the human-perspective verdict is missing.
Closing it needs an image-capable reviewer, which is an environment change rather
than a code change. Until then this milestone should be described as
**functionally verified and visually unverified**.

## 4. Reproducing the measurements

The dev server used for all of the above is the fixture one, not the real Worker:

```sh
cd apps/web
npx vite dev --config verify/vite.config.verify.ts --port 5180
```

`verify/api-stub.ts` stands in for `allclear-api` over the Service Binding, so the
page renders with no D1, no KV and no migrations. Its clock is read per request;
a fixture pinned at module scope goes stale minutes after the isolate starts and
silently stops exercising the `operational` branch.

The PNG renders:

```sh
xvfb-run -a --server-args="-screen 0 1400x2000x24" \
  firefox --no-remote --profile /tmp/ffprof --window-size=1280,1800 \
  --screenshot /tmp/allclear-desktop.png "http://localhost:5180/status/fixture"
```

For the dark render, set `layout.css.prefers-color-scheme.content-override` to `0`
in the profile's `user.js` before starting, which is what `next-themes` reads when
its stored theme is `system`.
