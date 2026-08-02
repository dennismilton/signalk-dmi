# Changelog

All notable changes to **signalk-dmi** are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); this project follows semantic versioning.

## 0.6.0

- **Reliable marine fallback — waves/swell/current never vanish.** DMI's WAM/DKSS marine
  models frequently have **no data at the boat** (coastal grid gap) or **429-rate-limit**,
  so waves and swell used to disappear for hours or days. A new **Open-Meteo Marine API**
  fallback (free, key-free, unlimited; models GWAM/EWAM/MFWAM) fills any
  `environment.water.waves.*`, `.swell.*`, `environment.current.*` and
  `environment.water.temperature` path that DMI left empty. **DMI stays primary** where it
  has data (authoritative for Danish waters); Open-Meteo only fills the gaps, and only
  after the DMI exact-point + surrounding-area ring already came up empty.
  - **Honest source markers.** Each group publishes its provenance:
    `environment.water.waves.source` / `environment.current.source` /
    `environment.water.temperature.source` = `"DMI-WAM"` / `"DMI-DKSS"` / `"DMI"` when DMI
    supplied it, `"Open-Meteo"` when the fallback filled it, or `"DMI-WAM + Open-Meteo"`
    for a mixed wave block — so it is always clear which source each value came from.
  - **Config toggle** *Reliable marine fallback (Open-Meteo)* (`openMeteoFallback`, default
    **ON**). Turn off to keep DMI-only behaviour.
  - Robust fetch: per-request timeout via `AbortController`, fully error-caught (never
    crashes the plugin), reuses the boat position and respects the existing self-recovery
    poll loop. Units converted to SI (km/h→m/s, °→rad, °C→K).
  - Attribution: Open-Meteo data is CC BY 4.0 (© Open-Meteo.com).
- This CHANGELOG is now included in the published npm tarball.

## 0.5.0

- **Self-recovery — the poll loop can no longer wedge.** The marine/observation poll now
  self-schedules with a guaranteed re-arm (`runAndReschedule` runs the next tick in a
  `finally`), so a thrown error, a rejected promise, a DMI **429 storm**, or a hung fetch
  can never permanently stop future polls. Previously a sustained 429 could leave the
  plugin dark for days until a manual Signal K restart. Two supporting bounds:
  - The marine ring-probe **cooldown no longer re-extends on a bare exact-point 429**
    (only a real ring probe opens it) and is **capped at 2 h** (`MAX_MARINE_COOLDOWN_MS`),
    so the surrounding-area probe is always re-armed within the cap.
  - **Last-good values expire.** A value whose source has been silent for more than ~4
    poll cycles (~2 h at the 30-min default) is dropped and the path goes **absent**
    (honest) instead of being re-published frozen-but-fresh-timestamped forever — the
    reason stale marine data masqueraded as live.
- **`environment.current.*` now publishes at masked-current cells.** DKSS frequently
  reports water temperature/level at the boat's exact cell while the **current vector is
  null-masked**; the old presence test counted the cell as "has data" (temp present), so
  the surrounding-area ring never fired for current and `current.drift`/`current.setTrue`
  stayed absent. A **focused current probe** now rings specifically for the current
  vector (both `current-u` AND `current-v` required) on its own cooldown key, using the
  nearest wet cell with an honest `environment.current.nearbyDistance`/`nearbyBearing`
  marker. Temp/level sourcing is unchanged.

## 0.4.0

- **In-UI InfluxDB history guidance.** The plugin now detects (read-only) whether a
  `signalk-to-influxdb2` persistence plugin is installed and whether it already covers
  the DMI paths, and shows the result in the plugin config page: either "history
  unavailable — install signalk-to-influxdb2 to trend DMI data", "DMI paths already
  persisted", or "add these paths" with a ready-to-paste `filteringRules` snippet. It
  never writes another plugin's config — guidance only. A `historyGuidance` toggle
  silences the hint.

## 0.3.2

- Marine "surrounding-area" grid probe now backs off, cools down, and aborts against
  DMI rate limits (HTTP 429) instead of hammering the API.

## 0.3.1

- Null-masked marine grid cells are treated as empty, so the nearby-grid fallback
  fires correctly instead of reporting a blank at the exact position.

## 0.3.0

- **Marine surrounding-area fallback.** When the exact position sits in a grid gap
  (waves / swell / current unavailable at the point), the plugin samples the nearest
  valid grid cell and reports the offset distance, so marine data stays populated with
  an honest "nearby" marker rather than going blank.

## 0.2.0

- Config-page polish — clearer option descriptions and enum choices for all settings.

## 0.1.0

- Initial release. Ingests DMI (Danish Meteorological Institute) free Open Data into
  Signal K: HARMONIE forecasts, met observations (Tier-1 `environment.outside.*`),
  WAM waves, DKSS ocean (sea level, current, water temperature), and official
  DMI/MeteoAlarm weather & marine warnings — published to Signal K paths and the v2
  Weather API. Key-free (DMI Open Data), CC BY 4.0.
