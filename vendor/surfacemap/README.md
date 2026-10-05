# vendor/surfacemap

A copy of [surfacemap](../../../surfacemap) (`bin/`, `src/`, `LICENSE`) at commit `972c446`, kept here so the
surface map builds and is checked in CI without an install step. Do not edit these files in place: change
surfacemap, then copy `bin/` and `src/` over and update the commit above.

Rebuild the map after changing `cli-spec.mjs`, `surfaces.mjs`, a `routes-*.mjs` file or `dashboard.html`:

    node vendor/surfacemap/bin/surfacemap.mjs build

`surfacemap.test.mjs` fails when `docs/surfacemap.html` or `.json` is out of date.
