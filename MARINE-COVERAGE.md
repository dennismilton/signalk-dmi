# Marine coverage investigation — why waves/swell/current blank at our position

**Date:** 2026-07-09 · **Investigation only** (no code/config change here). Data from
DMI Open Data API (`opendataapi.dmi.dk`, key-free forecastedr) probed live during this run.

## 1. Our position (live)

Read from SignalK REST on the boat Pi:
`https://192.168.8.9:3443/signalk/v1/api/vessels/self/navigation/position`

```
latitude  56.1685984
longitude 10.2230517   ($source canboatjs / PGN 129025, GPS live)
```

This is **inner Aarhus Bay, Kattegat, Denmark** — coastal, close to shore, inside a bay.
(HTTP redirected to HTTPS; used `curl -k`. Not the fixed-coords fallback — this is live GPS.)

## 2. Collections the plugin can select (from index.js config enums)

- **WAM** (waves/swell): `wam_dw` (default), `wam_nsb`, `wam_natlant`
- **DKSS** (ocean/current/temp/level): `dkss_nsbs` (default), `dkss_idw`, `dkss_ws`,
  `dkss_lf`, `dkss_lb`, `dkss_if`

Query path (lib/dmi.js `edrPosition`):
`/v1/forecastedr/collections/<C>/position?coords=POINT(lon lat)&crs=crs84&parameter-name=…&f=GeoJSON`.
No API key — host is key-free since 2025-12-02. Retry/backoff on 429/5xx.

## 3. Domain extents (bbox) and which CONTAIN us

| Collection | bbox [W,S,E,N] | contains (10.223, 56.169)? | notes |
|---|---|---|---|
| **wam_dw** | 7.0, 53.0, 16.0, 60.0 | **YES** | Danish Waters — finest WAM |
| wam_nsb | -13.0, 47.0, 30.0, 66.0 | yes | North Sea+Baltic — coarser |
| wam_natlant | (N Atlantic) | n/a | coarsest, not needed |
| dkss_nsbs (default) | -4.125, 48.525, 30.292, 65.875 | yes | coarse basin-wide |
| **dkss_idw** | 9.34, 53.587, 14.826, 57.596 | **YES** | Inner Danish Waters — finest DKSS |

**Smallest containing WAM = `wam_dw` (already the default).**
**Smallest containing DKSS = `dkss_idw` (NOT the default `dkss_nsbs`).**

## 4. Direct data probes at our exact point + nearby

DMI was intermittently returning `429 "Server is busy"` during probing; rode it out with
`curl --retry --retry-all-errors`. A clean 200 was obtained for every probe below.

| Probe | Point | Result |
|---|---|---|
| **wam_dw** exact | 10.223, 56.169 | 200, rows present but **all wave/swell values = `null`** (masked coastal cell) |
| wam_dw open water | 11.0, 56.5 | **REAL**: sig-wave 0.74 m, swell 0.12 m |
| wam_dw near (~9 nm) | 10.45, 56.25 | **REAL**: sig-wave 0.26 m, swell 0.10 m |
| **dkss_nsbs** exact | 10.223, 56.169 | 200, rows present but **all values = `null`** (current-u/v, temp, level) |
| **dkss_idw** exact | 10.223, 56.169 | **REAL at the boat**: current-u 0.042, current-v 0.019, temp 13.75 °C, level −0.05 m |

## 5. Conclusion

**This is NOT an out-of-domain / no-coverage location, and NOT primarily a 429 problem.**
Our position sits inside every relevant domain. Two distinct causes:

### Current / temp / level → **config win available**
The default `dkss_nsbs` is a coarse basin model whose grid cell at inner Aarhus Bay is
**null-masked**, so current comes back blank. The finer **`dkss_idw` (Inner Danish Waters)**
has a live, non-null cell **at our exact point** — real current, temp and level right now.
→ **Switch `dkssCollection`: `dkss_nsbs` → `dkss_idw`.** Fixes the blank current vector
(and gives finer sea temp/level) with no code change. (Sea temp/level/tide currently
appearing on the panel come from DKSS elsewhere / obs stations; idw makes the grid path
work at the boat too.)

### Waves / swell → **no config fix; needs the fallback code fix**
`wam_dw` is already the finest WAM domain and it DOES contain us — but DMI's WAM does not
compute waves for the masked inner-bay cell at our exact point (values `null`). Real wave
data exists in open Kattegat **~9 nm away, inside the plugin's 15 nm ring**. The other WAM
domains (`wam_nsb`, `wam_natlant`) are coarser and would not resolve the inner bay any
better, so **keep `wamCollection = wam_dw`** — switching WAM domains will not help.

**Why the surrounding-area fallback (v0.3.0) does not already surface the ~9 nm waves —
root-cause bug (code, not config):** `edrPositionNearby` decides the exact point "has data"
with `if (exact.length) …`. But for a masked cell DMI returns a **full-length time-series of
`null` values**, so `exact.length` is large (many time steps) even though no wave value is
present. `edrPosition` maps only `typeof p[k] === 'number'`, so each row is just `{time}`
with no numeric fields — the ring-probe never fires, and `waterFromMarine` gets nothing →
blank card. The fallback keys on **row count**, but should key on **presence of any numeric
parameter value**. Fix belongs in lib/dmi.js (treat null-only rows as empty in `edrPosition`,
or have `edrPositionNearby` test for numeric values, not `.length`). This is a worker code
task, not a config change.

### Poll interval
Lowering `pollIntervalMinutes` will **not** help. The blanks are a masked-cell +
row-count-fallback issue, not a transient rate limit — a clean 200 still returns `null` at
the exact WAM cell and at the exact `dkss_nsbs` cell. The 429s seen during probing are
transient DMI busyness that the plugin's existing backoff already rides out; do not lower
the interval for this.

## Recommended actions

1. **Config (foreman can apply now):** `dkssCollection: dkss_nsbs → dkss_idw`.
   Keep `wamCollection: wam_dw`.
2. **Code (worker task, separate):** fix `edrPositionNearby`/`edrPosition` in lib/dmi.js so a
   time-series of all-`null` values counts as empty and triggers the surrounding-area ring —
   this is what will finally surface waves/swell (~9 nm open-Kattegat cell) with the honest
   "nearby ~X nm" marker.

## Resolution — action 2 landed (v0.3.1, 2026-07-09)

`lib/dmi.js` now has `hasNumericValues(rows, params)` and `edrPositionNearby` decides
"the exact point has data" and "a probe hit" by **numeric presence**, not `rows.length`.
A null-masked cell (full-length all-null series) is therefore treated as EMPTY, so the
ring fires and the first nearby wet WAM cell (~3–9 nm out, within the 15 nm cap) is used
with its `…nearbyDistance`/`…nearbyBearing` honest marker. A DKSS cell with a real number
in ANY requested param (e.g. `water-temperature` present while `current-u/v` are null) still
counts as present — so working ocean temp/level/tide are not ringed away. Covered by
`test/dmi.test.js` (null-masked-exact→ring, null-masked-everywhere→honest empty, DKSS
mixed-cell no-regression). Action 1 (the `dkss_idw` config switch) is still worth applying
for a non-null current vector at the exact boat cell — it is independent of this code fix.
