# Rating and tuning — private tooling

Not part of the product. `/rate` is `noindex`, excluded from `sitemap.xml`,
disallowed in `robots.txt`, and linked from nothing.

## One-time setup — done

The Worker is deployed, its KV namespace is bound, and `RATE_SECRET` is set to a
freshly generated 24-byte random value. Enter that same string once, ever, into
the **Sync key** field at `nullsample.maqsudjon.com/rate` on your phone; it is
kept in that device's `localStorage` and sent only as a request header.

To rotate it later: `cd worker && npx wrangler secret put RATE_SECRET`, then
re-enter the new value on the phone.

If it leaks the worst outcome is a stranger adding junk ratings — visible and
reversible. That is exactly why this is a Worker secret and not a GitHub token:
a token that can write ratings is harmless on a lost phone, and one that can
write code is not.

Verified live: 200 with the key, 401 without it and 401 with a wrong one.

`GITHUB_TOKEN` and `GITHUB_REPO` are deliberately unset, so `/cycle` answers
`no github binding` and the Addendum 9 loop cannot fire. Set them only after you
have rated one batch by hand.

## Repository size

The batch audio is **not committed**. Fifty tracks is about 137 MB (a 45 s
excerpt and a full track each), and replacing it every cycle would not reclaim
the history — ten cycles would be a gigabyte of audio in git.

What is committed is `manifest.json`, which carries the exact ranges the tracks
were rendered from. `npm run batch -- --rebuild` reproduces the audio
byte-identically from that alone, whatever the ranges file has moved on to, and
the deploy workflow runs it behind a cache keyed on the batch id — so an
unrelated push does not re-render anything.

## Rating

```bash
npm run batch -- --count 50 --base m5 --out ./batch --publish
npm run build && git add -A && git commit && git push     # deploys /rate
```

Then on the phone, on earbuds: `nullsample.maqsudjon.com/rate`.

- **Pass 1** is 45-second excerpts around the first drop: hook, punch, space.
- **Pass 2** is full tracks, and only the ones that scored 3 or better in pass
  1: interest alone. There is no value in judging whether a track holds for two
  minutes when it already failed on punch.
- Nothing identifying is on screen. Order is shuffled per session. Three tracks
  are silently repeated, and how consistently you score them is what decides
  whether the session is used at all.

Every tap is written to `localStorage` before anything touches the network, so
airplane mode loses nothing and there is never a spinner. A small `3 unsent`
appears if the queue is backed up.

## Reading the results

```bash
export NULLSAMPLE_RATE_KEY=...      # the same string
npm run narrow -- ./batch           # per-axis correlations, proposals only
```

## The loop

```bash
npm run tune -- ./batch --dry       # what a cycle would change
npm run tune -- ./batch             # apply it
```

`tune` never narrows a range. It reweights the sampling distribution inside the
range and floors every weight above zero, so a region that scored badly on thin
evidence becomes rare rather than unreachable and can recover. A fifth of every
batch ignores the weights entirely.

To run it unattended, set `GITHUB_REPO` and a repo-scoped `GITHUB_TOKEN` on the
Worker; it will then fire `repository_dispatch` once a batch has 40 ratings and
`.github/workflows/tune.yml` takes over. **Leave those unset until you have
rated one batch by hand** — automating a loop nobody has run once is how you
automate a bug.

`/rate/progress` shows score trends, which parameters moved, self-agreement, and
discarded sessions, and carries a pause.
