# Preset range files — licence

**Files covered:** `presets/*.ranges.json`

## Why these are separate

The engine is machinery. These files are the product of listening: they record
which regions of a very large parameter space produce music worth hearing, and
they are narrowed by rating hundreds of renders and correlating the results.
That work is the commercial asset, and the split needs to be unambiguous rather
than implied.

## Terms

- **Version 1 range files, as committed here, are covered by the AGPL-3.0**
  along with the rest of the repository. They are deliberately wide starting
  brackets, published so the engine is usable and the tuning loop can be run.

- **Tuned range files are licensed separately.** A range file is "tuned" if it
  was produced by narrowing against ratings — that is, if `version` is greater
  than 1, or the `note` field records a narrowing pass. Those files are not
  covered by the AGPL grant and require a commercial licence
  (see `../LICENSE-COMMERCIAL.md`).

- **Ranges you tune yourself are yours.** If you run the quality loop on your
  own ratings, the resulting file is your work, not a derivative asset of this
  project.

- **Audio generated using any range file is yours**, under either licence,
  including for commercial release.

**Contact:** polatovmaqsudjon1@gmail.com
