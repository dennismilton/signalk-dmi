# Changelog

All notable changes to **signalk-dmi** are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); this project follows semantic versioning.

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
