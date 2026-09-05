# NULLSAMPLE — BUILD SPEC

Product name: **Nullsample**
Live at: **https://nullsample.maqsudjon.com**
Repo: `nullsample`

Read this whole document before writing code. Follow the build order in
section 18. Do not skip ahead. Stop at every milestone gate and wait.

---

## 0. What this is

A procedural music generator. Original tracks synthesized entirely from code —
no samples, no loops, no machine learning models, no copyrighted audio. Every
sound comes from oscillators, noise, envelopes, filters and nonlinear stages
computed at runtime.

The name is the pitch. Zero samples. Say it plainly everywhere: in the README,
in the page title, in the hero. It is the one thing competitors cannot claim.

Three non-negotiables. If a decision conflicts with one of these, the
non-negotiable wins.

1. **Determinism.** The same seed produces a bit-identical output file, on any
   machine, in any browser, forever. Everything else is subordinate to this.
2. **Quality over quantity.** One genre that sounds genuinely convincing beats
   ten that sound like a demo.
3. **Zero hosting cost.** Rendering happens on the user's device. What is
   deployed is static files on GitHub Pages.

---

## 1. Scope

### In scope

- A TypeScript DSP engine rendering a complete stereo track from a seed
- One genre preset, properly tuned
- A Node CLI for batch rendering and offline listening
- A rating workflow that feeds back into the preset's parameter ranges
- A static web app: generate, play, reroll, lock, download WAV and stems
- Full brand asset set, SEO, analytics
- Deployment to `nullsample.maqsudjon.com`

### Out of scope — do not build, do not scaffold, do not add config for

User accounts, auth, any database, payments, a backend server, a second genre,
vocals, mobile apps, real-time parameter tweaking during playback.

If you think one of these is needed, stop and ask.

---

## 2. Language and runtime

Write the engine in **TypeScript**, operating directly on `Float32Array`
buffers. Plain arithmetic on sample buffers, nothing else.

**Do not use the Web Audio API node graph for rendering.** Not
`OscillatorNode`, not `BiquadFilterNode`, not `ConvolverNode`, not
`OfflineAudioContext`. Browsers implement these nodes differently, so the same
seed would produce different audio in Chrome and Safari. That breaks
non-negotiable #1.

Web Audio is allowed for exactly one job: playing back a `Float32Array` the
engine has already rendered, via `AudioBufferSourceNode`.

One engine, two hosts:

- **Browser** — runs inside a Web Worker so the UI never blocks
- **Node** — the same files run in the CLI for batch rendering

No duplicated DSP. If reference Python exists, port it and delete it.

**SharedArrayBuffer is not available.** It requires COOP and COEP response
headers, and GitHub Pages cannot set headers. Pass audio between worker and
main thread using transferable `ArrayBuffer`s instead. Design for this from the
start; discovering it at M6 means rewriting the worker interface.

---

## 3. Repository layout

```
/core        DSP primitives. Frozen after M1.
/compose     Musical decisions: motif, harmony, rhythm, arrangement.
/presets     Genre recipes and parameter ranges. The real work lives here.
/render      Bus routing, mixdown, master chain, WAV encoding.
/cli         Node batch renderer and contact sheet builder.
/web         Static web app.
/brand       Logo sources, icon generator, OG image generator.
/test        Determinism and regression tests.
```

The boundary between `/core` and `/presets` is the most important structural
decision in this project. `/core` is generic machinery that knows nothing about
genre. `/presets` is data and recipe logic that knows nothing about DSP
internals. After M1, changing how something sounds should mean editing
`/presets` only. If you need to edit `/core` to fix a sound, the boundary is
wrong — stop and fix the boundary.

---

## 4. Determinism contract

- One seeded PRNG (xoshiro128\*\* or mulberry32), created from the track seed
  and passed explicitly down the call chain.
- `Math.random()` must not appear in `/core`, `/compose`, `/presets` or
  `/render`. Add an ESLint rule that fails the build if it does.
- No `Date.now()`, no timing-dependent logic, no iteration over unordered
  structures where order affects output.
- Each bus gets a **named child PRNG** derived by hashing `seed + ":" + busName`
  — never by consuming from a shared stream. This is what makes lock-and-reroll
  possible: rerolling the lead must not disturb the drums.
- No reliance on FMA, no parallel reduction with nondeterministic order.

Acceptance: render seed 12345 twice in Node and once in headless Chrome. All
three WAV files byte-identical.

---

## 5. DSP core (`/core`)

Pure functions or small classes over `Float32Array`. Unit test each one.

**Oscillators** — band-limited saw, pulse (variable width), triangle, sine,
white and pink noise. PolyBLEP or additive, so aliasing is deliberate, never
accidental.

**Supersaw** — 7–9 detuned saw voices, ±8–25 cents drift, randomized initial
phase, stereo spread. Detune and spread are parameters.

**Envelopes** — ADSR plus a separate exponential decay for percussive material.
Sample-accurate, no zipper noise.

**Filters** — resonant low-pass, high-pass, band-pass, peaking.
State-variable or biquad. Cache coefficients, recompute only on actual change.
Support per-sample cutoff modulation for sweeps.

**Distortion chain** — soft clip → waveshaper → hard clip, each stage
independently controllable. **Oversample 4x around every nonlinear stage** with
a polyphase or windowed-sinc filter, then downsample. This is the line between
deliberate saturation and garbage aliasing.

**Bitcrush** — bit depth and sample rate reduction, independently controllable.

**Delay** — fractional-delay line with interpolation, feedback, filtering in the
feedback path, ping-pong mode. Powers chorus, flanger, echo.

**Reverb** — feedback delay network with procedurally generated decay. Ship no
IR files.

**Dynamics** — envelope follower, compressor, limiter, and a sidechain ducker
triggered by an explicit event list rather than by analysing the kick bus.

**Drum synthesis** — kick (pitch-enveloped sine plus click transient), snare
(noise plus tuned body), clap (multi-tap noise bursts), closed and open hats
(filtered noise plus metallic ring), rim, tom.

**808 bass** — sine sub with exponential pitch glide (start +5 to +12 semitones,
down over 40–90 ms), long decay, saturation for harmonics, portamento between
notes, and a clean parallel sub below 120 Hz kept mono.

**Formant tones** — band-passed saw with formant peaks near 700 / 1150 /
2400 Hz. Synthetic vowel texture only. Must never resemble an actual singer.

---

## 6. Composition layer (`/compose`)

- **Harmony** — chord loop from a scale and degree pattern supplied by the
  preset. Power fifths, sus2, min-add9.
- **Motif** — a short figure (4–8 notes) generated under constraints: allowed
  scale degrees, allowed interval jumps, contour shape, rhythmic density.
  Constrained generation, not a random walk. A random walk produces melodies
  that are technically different and perceptually identical.
- **Rhythm** — 16 steps per bar, per-step velocity and probability, roll and
  burst subdivisions.
- **Arrangement** — assemble sections from a preset template: which buses are
  active per section, filter and gain automation, transition effects at
  boundaries.

**Variation must happen at the arrangement and timbre level, not only at the
note level.** Two renders differing only in melody notes sound like the same
track. Build variation in this priority order: arrangement → timbre → rhythm →
notes.

---

## 7. Preset format (`/presets`)

A preset declares: tempo range, key set, scale, chord degrees, which buses exist
and their gain staging, per-bus synth parameters as **ranges** with
distributions, a section template, transition effects, and master chain
settings.

Ranges live in `presets/<name>.ranges.json`, separate from code, because
section 10 rewrites that file as tuning progresses.

**The one v1 preset: hyperpop / rage-electronic.** Cold, digital, hypnotic,
loud. 150–160 BPM, straight timing. Minor key, 2- or 4-chord loop. A distorted
supersaw lead carrying a short repeated motif over an enormous distorted 808.
Trap-adjacent but rave-hard drums. Hard sidechain pumping is wanted — duck pads,
leads and reverb 40–60% under every kick, 60–140 ms release.

---

## 8. Render and master (`/render`)

Buses: `drums`, `bass808`, `lead`, `arp`, `pads`, `fx`. Keep them separate all
the way to mixdown so stem export costs nothing.

Gain-stage every bus so nothing clips before the master. Every clip in the final
output must be a deliberate design choice.

Master chain in order: glue compression → fixed makeup gain → soft saturation →
high-shelf lift → clipper → true-peak limiter. Short fade in and out.

**The whole master chain must be streamable.** No stage may look at a sample
outside the chunk it is processing. In particular there is no normalization
pass over the finished mix: loudness comes from a fixed per-preset makeup gain,
and the ceiling is set by a true-peak limiter with a short lookahead that
decides locally.

This is not a stylistic preference. Rendering is progressive — playback starts
after the first section while the rest renders ahead — and a normalization pass
would mean the audio a listener already heard had to be rescaled by a factor
only knowable at the end. The file would then not be the audio they heard. A
streaming chain makes playback and the downloaded WAV bit-identical by
construction.

The makeup gain sits *after* the glue compressor. A compressor with an absolute
threshold fed an already-boosted signal stops being glue and becomes a brick
wall.

"True peak" means inter-sample peak: detection runs on a 4x interpolated copy of
each channel, because a signal whose samples all sit under the ceiling can still
reconstruct above it, and a lossy encoder will clip that.

Everything below 120 Hz stays mono. Width comes from detuned leads, chorus, and
light Haas in mids and highs only.

Target −0.5 to −1.2 dBTP peak, −7 to −8 dBFS RMS, kick and snare transients
still punching.

Write WAV yourself: 44-byte RIFF header plus interleaved samples. No audio
library. Identical code path in Node and browser.

---

## 9. Performance budget

A 2-minute track must render in **under 5 seconds on a mid-range Android phone**
and under 1.5 seconds on a laptop. This is a hard requirement, not an
aspiration — it determines whether the one-button flow feels instant or broken.

**Measured outcome: this budget is not achievable and was replaced.** A
117-second track renders in ~15 s on an M-series laptop. The floor is
arithmetic: 4x oversampling around the nonlinear stages (section 5) costs ~1.5 s
per oversampled channel-stream, and there are seven of them; removing every
oversampler entirely still leaves ~9 s. Sections 5, 8 and 9 cannot all hold in
scalar JavaScript.

The budget was therefore replaced with a **time-to-first-sound** budget: under
2 seconds on a laptop, under 5 seconds on a mid-range phone, with the render
staying ahead of the playhead thereafter. Rendering runs at roughly 7x realtime
on a laptop and comfortably above 1x on a phone, so it does. Quality was not
traded to get here.

Consequences to design around from the start:

- Preallocate buffers. No allocation inside sample loops.
- Reuse filter state objects across notes rather than constructing per note.
- Only oversample around nonlinear stages, never the whole signal path.
- Render buses in sequence, freeing intermediates as you go — a phone will not
  hold six full-length float buffers plus 4x oversampled scratch.
- Report progress to the main thread at section boundaries.

Measure this at M3 and again at M6. If it regresses, fix it before adding
features.

---

## 10. The quality loop (`/cli`) — build before the web app

This is the mechanism that makes the output good. It is not optional tooling.

```
npm run render -- --preset hyperpop --seed 42 --out track.wav
npm run batch  -- --preset hyperpop --count 50 --out ./batch
npm run sheet  -- ./batch
npm run narrow -- ./batch
```

`batch` renders N seeds, writing each track plus a JSON record of every
parameter value sampled for that seed.

`sheet` builds one self-contained HTML page with inline players and a 1–5 rating
control per track, saving to `ratings.json`. It must work by opening the file
directly — no server, no build step, no network.

`narrow` reads the ratings, correlates parameter values against them, and
proposes a tightened ranges file. It writes a proposal plus a readable diff. It
never overwrites ranges automatically.

The human will run this loop many times: render 50 → listen → rate → narrow →
repeat. The goal is a parameter space with no bad regions in it. When fewer than
5 in 100 random renders are rated poor, the preset is done.

---

## 11. Design system

Read `/mnt/skills/public/frontend-design/SKILL.md` before writing any UI code,
and follow its two-pass process: write a design plan, review it against this
brief for anything that reads as a generic default, revise, then build.

### Brand context

This joins an existing product family (flarestamina.com, kvdrt.maqsudjon.com).
The shared language is JetBrains Mono, flare orange `#FF6A1A`, dark grounds, and
dot-matrix texture. Stay inside it. Do not introduce a second accent colour.

### Concept

**The interface is instrumentation, not marketing.** This product's world is
oscilloscopes, spectrograms, seed numbers, parameter readouts, bus lanes. The
page should read like a measuring instrument that happens to be beautiful — not
like a landing page for a startup.

Concretely, that means the hero is **the waveform itself**, drawn live as the
render completes, with section boundaries marked. Not a headline over a
gradient. Not a big number with a small label. The first thing a visitor sees
should be the product doing its job.

### Tokens

```
--void    #08090C   page ground
--panel   #101317   raised surfaces
--line    #1E232B   hairlines, grid, dot matrix
--dim     #6B7480   secondary text, labels
--text    #E4E7EB   primary text
--flare   #FF6A1A   the only accent
```

Six values. If you need a seventh, you are decorating.

`--flare` is scarce by design: the generate button, the active playhead, the
locked-bus indicator. Nothing else. An accent used everywhere stops being an
accent.

### Type

JetBrains Mono throughout, self-hosted as woff2 with `font-display: swap`. One
family only — a mono-only interface is a legitimate and deliberate position for
a DSP tool, not a shortcut.

Set a modular scale and stick to it. Mono is wide, so keep prose lines under 60
characters rather than the usual 80, and there should be very little prose on
this page anyway.

Avoid, as the skill notes: tracked-out all-caps eyebrow labels above headings,
accenting a single word in a headline, meta strings joined with middle dots, and
arrows appended to button text.

### Motion

**One orchestrated moment: the waveform drawing in when a render completes.**
Left to right, fast, in `--flare`, settling to `--text`. That is the payoff and
it should feel like something arriving.

Everything else is either a direct response to a user action (a lock toggling, a
panel opening) or nothing at all. No fade-and-slide-up on scroll. No hover
transitions on every surface. Respect `prefers-reduced-motion` by drawing the
waveform instantly instead.

### Quality floor, built in without announcing it

Responsive to 360px. Visible keyboard focus on every interactive element,
styled, not the browser default. Space and Enter both work on custom controls.
Contrast at least 4.5:1 for text — check `--dim` on `--void` and darken the
ground or lift the grey until it passes. Real `aria-label`s on icon-only
controls. A live region announcing "track ready" when a render finishes.

---

## 12. Web app interaction (`/web`)

Static. If you use a framework it must build to static files with no server
runtime. Engine runs in a Web Worker. Show real progress, not a spinner.

**Default state is one button.** No settings visible. Press it, and audio starts
within about two seconds and plays through while the rest of the track renders
ahead of the playhead. The first result must be one of the good ones, not an
average one — the second press depends on it.

Playback is progressive because a full two-minute render does not fit in the
section 9 budget on any device — see the note there. Render section by section,
begin playback once the first section is ready, and keep a buffer ahead of the
playhead. Detect underrun and handle it gracefully rather than glitching. The
first section of every arrangement is 4–8 bars so time-to-first-sound is short.
Because the master chain streams (section 8), what plays and what downloads are
the same bytes.

**Reroll is the primary action, not settings.** People do not tune sliders; they
press again. After the first track, reroll is the largest control on the page.

**Lock and reroll.** Each bus has a lock toggle. Locked buses keep their exact
sound and part across rerolls; unlocked buses regenerate. "Keep the drums, give
me a different melody" is one tap. This is the feature competitors structurally
cannot offer — put it in the main view, not an advanced panel.

**Word sliders, not numbers.** Three at most, each a plain adjective — darker,
harder, wider. Each moves several underlying parameters along a curve defined in
the preset. Never expose raw DSP values in the main UI.

**Seed is visible and shareable.** Display it. Allow pasting one. Put it in the
URL hash so a link reproduces a track exactly. This is the product's identity —
treat the seed like a serial number stamped on an instrument, not like debug
output.

**Downloads.** Full mix as WAV, stems as a zip. Both generated client-side.

**Empty and error states.** An empty state is an invitation to act, not a
placeholder. If the worker fails, say what happened and what to do — never a
vague apology.

---

## 13. Brand assets (`/brand`)

### Logo

Concept: the mark spells the name. A single-cycle band-limited saw wave where
the first cycle is flatlined at zero and the second breaks into a full saw —
null, then sample. Geometric, hard-edged, no gradients, no rounded softness.
Must survive at 16px.

Deliver: `logo.svg` (full lockup, wordmark in JetBrains Mono plus mark),
`mark.svg` (mark alone, square), and a monochrome variant of each.

### Icons

Generate procedurally from `mark.svg` with a small Node script in `/brand`, so
they regenerate on any change:

- `favicon.svg` — modern browsers, respects `prefers-color-scheme`
- `favicon.ico` — 16, 32, 48 multi-resolution, for old clients
- `apple-touch-icon.png` — 180×180, opaque `--void` ground, no transparency
- `icon-192.png`, `icon-512.png`, plus a 512 maskable variant with safe-area
  padding for the manifest

### OG images

1200×630. **Generate these from the engine itself** — render a track, draw its
waveform, compose the image with the wordmark and the line "Music generated from
code. Zero samples." Do it at build time with a Node script; the result is an
OG image that is literally a product of the product. Ship a static
`og-default.png`; per-seed OG images would require a server and are out of
scope.

Also produce `og-square.png` (1200×1200) for platforms that crop.

### Manifest

`site.webmanifest` with name, short name, description, `--void` as
`background_color` and `theme_color`, the icon set, and `display: standalone`.

---

## 14. SEO

`nullsample.maqsudjon.com` is a subdomain of an established domain, which helps
a little. Everything else has to be earned.

**Head, on every page:**

- `<title>` — "Nullsample — music generated from code, zero samples". Under 60
  characters.
- `<meta name="description">` — 150–160 characters, states what it does and the
  zero-samples claim.
- `<link rel="canonical">` — absolute, `https://nullsample.maqsudjon.com/`
- `og:title`, `og:description`, `og:image` (absolute URL), `og:url`, `og:type`,
  `og:site_name`
- `twitter:card` = `summary_large_image`, plus title, description, image
- `<meta name="theme-color" content="#08090C">`
- `<html lang="en">`

**Files at the root:**

- `robots.txt` — allow all, point to the sitemap
- `sitemap.xml` — every real page with `lastmod`
- `CNAME` — contains exactly `nullsample.maqsudjon.com`, must be present in the
  published output, not just the source

**Structured data:** one JSON-LD block, `SoftwareApplication`, with name,
description, `applicationCategory: MultimediaApplication`,
`operatingSystem: Any`, `offers` with price 0, and `author`.

**Google Search Console:** verify by DNS TXT on `maqsudjon.com` if that record
already exists, otherwise add an HTML meta verification tag. Output the exact
tag or TXT record for the human to paste — do not assume it is done. After
deploy, submit the sitemap.

**Performance is SEO here.** The page must reach first paint without loading the
engine. Lazy-load the worker bundle after paint. Target Lighthouse 95+ on
performance, accessibility, best practices and SEO, on mobile. Self-host the
font; no third-party requests on first load.

**Real content.** A single tool page ranks for nothing. Add a short `/about`
explaining how procedural synthesis works and why zero samples matters, and a
`/tracks` page listing the 20 demo tracks with their seeds. That is genuine
content, not SEO filler, and it is what the README links to.

---

## 15. Analytics

**GoatCounter.** Privacy-friendly, free for non-commercial use, no cookies, so
no consent banner is needed. One script tag, loaded `async` and `defer` after
paint. Do not add Google Analytics.

Track, via GoatCounter events: track generated, reroll pressed, bus locked, WAV
downloaded, stems downloaded. Nothing personal, no fingerprinting, no session
stitching.

Add a one-line note in the footer stating that the site uses cookieless
analytics and renders audio locally, linking to the repo. Say it plainly.

---

## 16. Deploy

GitHub Pages, project site, custom domain `nullsample.maqsudjon.com`. This
matches the existing setup — `ai`, `kvdrt`, `payvandchi` and `reshotkachi`
already CNAME to `maqsudjon-cell.github.io`.

Steps to implement:

1. A GitHub Actions workflow that builds `/web` and publishes to Pages on push
   to `main`. Cache dependencies. Fail the build on type errors, lint errors, or
   failing determinism tests.
2. Ensure `CNAME` containing `nullsample.maqsudjon.com` lands in the published
   output directory.
3. Set the custom domain in the repo's Pages settings and enable Enforce HTTPS.
   Certificate provisioning takes a few minutes after DNS resolves.
4. **Output for the human to add manually:**
   `CNAME  nullsample  →  maqsudjon-cell.github.io`, proxy status **DNS only**
   (grey cloud, not proxied — Cloudflare proxying breaks GitHub's certificate
   issuance).

Nothing else is deployed. No server, no storage bucket, no queue — audio is
rendered on the user's device and never touches infrastructure. If any part of
the design starts requiring a server, that part is wrong.

---

## 17. Testing and licensing

**Tests:** determinism across Node and headless browser, committed golden-file
hashes for reference renders, an assertion that no bus exceeds 0 dBFS before the
master, an assertion that no track contains unintended digital silence or DC
offset, and unit tests for every `/core` primitive. All run in CI.

**License:** dual. Engine open source under AGPL-3.0; a separate commercial
license for embedding in closed-source products. Add `LICENSE`,
`LICENSE-COMMERCIAL.md`, and a plain `## License` section in the README. Keep
tuned preset range files in their own directory with their own license header —
they are the commercial asset and the split must be unambiguous.

**README:** what it is, the zero-samples claim, a demo link, how to run the CLI,
how to add a preset, the license split. Include the OG image at the top.

---

## 18. Build order

Complete each milestone fully. Show the human the acceptance result at each gate
and wait for confirmation before continuing.

**M1 — Core.** DSP primitives with unit tests. A demo script rendering a saw
through a filter and distortion chain to WAV. Gate: audio is clean, tests pass,
`/core` frozen.

**M2 — First track.** Compose layer plus a rough hyperpop preset. One full
arrangement rendering to WAV. Gate: a listener recognises the genre. It does not
have to be good yet.

**M3 — Determinism and speed.** Seeded PRNG throughout, named child seeds per
bus, lint rule, golden-file tests, performance measured against section 9. Gate:
byte-identical renders across Node and browser, inside the time budget.

**M4 — Quality loop.** Batch renderer, contact sheet, ratings, narrow command.
Gate: the human can render 50, rate them, and see a proposed range diff.

**M5 — Tuning.** The long one, and it belongs to the human, not to you. Your job
is to make each iteration fast and to apply the changes they ask for. Gate:
fewer than 5 in 100 random renders rated poor.

**M6 — Web app.** Design plan first, reviewed against section 11, then build.
Worker integration, one-button flow, reroll, lock, word sliders, waveform, WAV
and stem download, seed in URL. Gate: works on a mid-range phone inside the
performance budget, Lighthouse 95+ across the board.

**M7 — Brand and SEO.** Logo, icon generator, OG generator, manifest, meta,
sitemap, robots, JSON-LD, GoatCounter, Search Console tag. Gate: the OG card
renders correctly in a link preview validator.

**M8 — Ship.** Pages workflow, CNAME, HTTPS, DNS record output, README, license
files, `/about`, `/tracks` with 20 demo tracks and their seeds.

---

## 19. Rules for you

- Ask before adding any dependency, and justify it. The engine should have close
  to zero runtime dependencies.
- Never add a feature that is not in this document. If it seems necessary, raise
  it and wait.
- Do not add a second genre. Not even a quick one to test the architecture.
- Do not build fallbacks, mocks, or placeholder audio. If something does not
  work, say so.
- **When a render sounds wrong, you cannot hear it — the human can.** Do not
  guess at fixes. Describe which parameters you can change and ask which
  direction to move.
- Prefer editing `/presets` over `/core`. If a fix seems to require `/core`
  after M1, explain why before touching it.
- Commit at every gate with a message describing what is now verifiably working.
