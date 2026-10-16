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
than a completed check. It was retried after M4 and failed the same way:

- The PNGs render. `xvfb-run firefox --screenshot` at 1280×1800 (light) and
  390×1500 (mobile) produced `/tmp/ac-desktop.png` and `/tmp/ac-mobile.png`.
- No reviewer could look at them. The `visual-judge` subagent's model provider is
  not available in this environment. The retry returned the same error as the
  first attempt: `provider-not-found; selection=…/GLM-5.3-Flash`. The session
  model does not accept image input either, and the in-app browser's screenshot
  path fails here.
- Path (a) is not a substitute for it. A diff table says the radius is 8px; it
  cannot say whether the page looks right.

So the numbers above are trustworthy and the human-perspective verdict is
missing. Closing it needs an image-capable reviewer, which is an environment
change rather than a code change. Until then this milestone should be described
as **functionally verified and visually unverified**.

### A correction: the M4 "dark" PNG was not dark

Re-rendering for the retry turned up a defect in this document's own artefacts.
The M4 dark render used
`layout.css.prefers-color-scheme.content-override` set to `0`, which was assumed
to make headless Firefox report a dark preference. It does not — not with `0`,
and not with `1`. Measured mean luminance of the three renders:

| Artefact | Mean luminance (0–255) |
|---|---|
| `allclear-desktop.png` (M4, light) | 248.7 |
| `allclear-dark.png` (M4, labelled dark) | 248.7 |
| `ac-desktop.png` (this session, light) | 248.6 |
| `docs/images/status-page.png` (README screenshot, light) | 248.3 |

The two M4 files are byte-different (174 926 vs 174 939 bytes, from
anti-aliasing and the clock) but visually identical: **the file named dark is a
light render.** The pref reaches `prefs.js` and Firefox still renders light, so
the approach is wrong rather than mistyped, and §4's instruction has been
corrected to say so.

What survives is the dark-mode *behaviour* claim in §1: that was observed by
selecting Dark in the running page's own toggle, which writes `localStorage`, and
the recorded palette values (`rgb(2,6,23)` background, the `oklch` banner values)
came from that. The toggle path works. It is only the headless screenshot that
cannot reach it, because `--screenshot` has no way to seed `localStorage` before
the page's own theme script runs.

The practical consequence: there is **no trustworthy dark-mode image artefact**,
and the light one is the only render worth reviewing. Producing a dark PNG needs
either an image-capable reviewer with a real browser session or a build-time
`?theme=dark` hook, and neither exists.

### A second trap: against the dev server, the render can come out unstyled

Found while producing the README screenshot. The page's HTML carries

```html
<link rel="stylesheet" crossorigin="anonymous" href="/app/globals.css" …>
```

but under Vite **dev**, that URL does not return CSS. It returns a JavaScript
module — the response body begins with
`import { createHotContext … } from "/@vite/client"` and calls
`__vite__updateStyle` — because dev-mode styles are injected at runtime by the
client. The browser cannot parse it as a stylesheet, so the styles arrive only
once the JS entry module runs and injects them.

`firefox --screenshot` captures at the load event, which can precede that
injection. The result is a render with the markup but **none of the CSS**: the
container is not centred, the header does not split left/right, and the page
collapses into a narrow left-hand column. It still looks like "a page", which is
what makes it dangerous — nothing about the file says it is wrong.

**How to tell, without an image-capable reviewer.** Measure the horizontal extent
of ink per horizontal band, not the file as a whole:

```python
# every band of a correctly styled render spans the same centred column
xs = [x for y in range(y0, y1) for x in range(w) if luminance(x, y) < 235]
```

On a correct render at 880px wide, every band spans **x 80..799** — a 719px
column whose centre (439.5) is the viewport centre (440). On an unstyled render
the ink stays in the left third.

**Do not judge this from a downsampled thumbnail.** An ASCII or averaged preview
of a styled page looks like a narrow left-hand column, because averaging a cell
wipes out thin glyph strokes and keeps only the densest text. That misreading was
made once here, from a correct render, and corrected by measuring instead.

`docs/images/status-page.png` (the README screenshot) came from this path and was
checked the measuring way: 880×1445, content continuous from row 16 to row 1420
with no gap over 47px, all four sampled bands spanning x 80..799, and status hues
present. It is a light render of a styled page. It has **not** been reviewed by
eye — no image-capable reviewer exists in this environment (§3) — so treat it as
geometrically verified and aesthetically unverified, exactly like every other
render in this document.

## 4. Reproducing the measurements

The dev server used for all of the above is the fixture one, not the real Worker:

```sh
cd apps/web
npx vite dev --config verify/vite.config.verify.ts --port 5219
```

5219 is the current convention; the M4 measurements were taken on 5180, which is
otherwise identical.

`verify/api-stub.ts` stands in for `allclear-api` over the Service Binding, so the
page renders with no D1, no KV and no migrations. Its clock is read per request;
a fixture pinned at module scope goes stale minutes after the isolate starts and
silently stops exercising the `operational` branch.

The PNG renders:

```sh
xvfb-run -a --server-args="-screen 0 880x1600x24" \
  firefox --no-remote --profile "$(mktemp -d)" --window-size=880,1600 \
  --screenshot /tmp/ac-desktop.png "http://localhost:5219/status/fixture"
```

Warm the page with a `curl` first — the first compile of `/status/fixture` takes
tens of seconds, and a screenshot taken during it is a screenshot of nothing.

**Check that the render is styled before using it.** Under the dev server the CSS
arrives by JavaScript injection and a `--screenshot` capture can beat it, giving a
page with no styling at all that still looks like a page. §3 explains the
measurement that distinguishes the two. The symptom is content in a narrow
left-hand column instead of a centred one.

For the mobile render, use a narrower screen and window (`-screen 0 900x1900x24`,
`--window-size=390,1500`) and a **separate profile directory**; reusing one
profile for a second concurrent run produces no file at all, silently.

**Do not attempt a dark render this way.** Earlier versions of this document
suggested setting `layout.css.prefers-color-scheme.content-override` to `0` in the
profile's `user.js`. That does not work: the pref lands in `prefs.js` and Firefox
still reports a light preference, so the resulting file is a light render with a
dark name. See §3. A dark artefact needs a real browser session that can set
`localStorage`, which `--screenshot` cannot do.
