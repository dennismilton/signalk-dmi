# signalk-dmi — Integration Test Evidence (Phase 2.5)

Plugin run **inside a real Signal K server** (Docker), against the **live DMI Open
Data API**, with anonymous read enabled so every check is reproducible with plain
`curl`. All outputs below are real captures from the running container on
2026-07-07.

## Environment under test

| Item | Value |
|---|---|
| Signal K server | `signalk-server` **2.30.0** (Docker image `signalk/signalk-server:latest`) |
| Container name | **`sk-dmi-test`** — left RUNNING on host port **3000** |
| Plugin | mounted read-only from the repo → `/home/node/.signalk/node_modules/signalk-dmi` |
| Position | fixed **57.0 N, 11.0 E** (Kattegat) via plugin config `positionSource: fixed` |
| Auth | `security.json` with `allow_readonly: true` → anonymous GET works (no token) |
| Poll interval | 5 min; forecast look-ahead 12 h |

### How it was stood up (reproducible)
```
docker pull signalk/signalk-server:latest
mkdir -m 777 -p /private/tmp/skcfg/plugin-config-data
# config files written to /private/tmp/skcfg: defaults.json, settings.json,
#   security.json (allow_readonly:true), plugin-config-data/signalk-dmi.json
docker run -d --name sk-dmi-test -p 3000:3000 \
  -v /private/tmp/skcfg:/home/node/.signalk \
  -v /Volumes/development/source/my-projects/signalk-dmi:/home/node/.signalk/node_modules/signalk-dmi:ro \
  signalk/signalk-server:latest
```
Plugin config (`/private/tmp/skcfg/plugin-config-data/signalk-dmi.json`):
```json
{ "enabled": true, "configuration": {
  "positionSource": "fixed", "fixedLatitude": 57.0, "fixedLongitude": 11.0,
  "pollIntervalMinutes": 5, "forecastHours": 12,
  "weatherProvider": true, "observations": true, "waves": true, "ocean": true } }
```

---

## Checks

### (a) Plugin loads with no errors — **PASS**
```
docker logs sk-dmi-test 2>&1 | grep -iE "signalk-dmi|error|running"
```
Output: `signalk-server running at 0.0.0.0:3000` — no plugin errors. Provider registered:
```
curl -s "http://localhost:3000/signalk/v2/api/weather/_providers"
→ {"signalk-dmi":{"name":"DMI","isDefault":true}}   [HTTP 200]
```

### (b) Weather API forecast returns real DMI data — **PASS**
```
curl -s "http://localhost:3000/signalk/v2/api/weather/forecasts/point?lat=57&lon=11&count=2"
```
HTTP **200**. Warm response ~2.5 s, cold ~7 s (bounded — no hang; see Bug B). First entry:
```json
{
  "date": "2026-07-07T21:00:00.000Z",
  "type": "point",
  "outside": {
    "temperature": 289.99033,
    "dewPointTemperature": 282.55203,
    "relativeHumidity": 0.6135669,
    "pressure": 100511.65,
    "cloudCover": 9.155413e-7,
    "horizontalVisibility": 50000,
    "precipitationVolume": 0
  },
  "wind": { "speedTrue": 8.26064, "gust": 13.580303, "directionTrue": 5.77064 }
}
```
Observations endpoint (metObs + oceanObs), HTTP 200:
```
curl -s "http://localhost:3000/signalk/v2/api/weather/observations?lat=57&lon=11"
```
```json
{
  "date": "2026-07-07T20:00:00Z", "type": "observation",
  "outside": { "temperature": 289.55, "dewPointTemperature": 283.41,
    "relativeHumidity": 0.6692, "pressure": 100386, "cloudCover": 0,
    "horizontalVisibility": 9178, "precipitationVolume": 0 },
  "wind": { "speedTrue": 12.83, "gust": 15.79, "directionTrue": 5.874778 },
  "water": { "temperature": 289.85, "level": 0.26 }
}
```
> Note: forecast `water.*` (WAM waves / DKSS ocean) appears when those collections
> respond; during DMI 429 bursts the atmospheric block still returns and the
> marine values are reliably present in the environment deltas (background poll
> retries — see check c). This is graceful degradation, not failure.

### (c) Published environment.* deltas — **PASS**
```
curl -s "http://localhost:3000/signalk/v1/api/vessels/self/environment"
```
HTTP **200**, 18 paths, all `$source: signalk-dmi`:
```
environment.outside.temperature        = 289.55        (K)
environment.outside.dewPointTemperature= 283.41        (K)
environment.outside.pressure           = 100386        (Pa)
environment.outside.humidity           = 0.6692        (ratio)
environment.outside.wind.speed         = 12.83         (m/s)
environment.outside.wind.gust          = 15.79         (m/s)
environment.outside.wind.direction     = 5.874778      (rad)
environment.water.waves.significantHeight = 1.1132853  (m)
environment.water.waves.period         = 3.9023438     (s)
environment.water.waves.direction      = 5.6942805     (rad)
environment.water.swell.height         = 0.38965243    (m)
environment.water.swell.period         = 4.9492188     (s)
environment.water.swell.direction      = 4.5837273     (rad)
environment.water.temperature          = 289.85        (K)
environment.water.level                = 0.26          (m)
environment.current.drift              = 0.26205843    (m/s)
environment.current.setTrue            = 3.5476671     (rad)
environment.tide.heightNow             = 0.26          (m)
```
Source + meta confirmed:
```
curl -s "http://localhost:3000/signalk/v1/api/vessels/self/environment/outside/temperature"
→ {"meta":{"units":"K",...},"value":289.55,"$source":"signalk-dmi","timestamp":"..."}
```

### (d) Units sane — **PASS**
- Temperatures ~289–290 K = ~16–17 °C ✓ (air + water; K, SI)
- Pressure 100386–100512 Pa = ~1004–1005 hPa ✓ (Pa, SI)
- Humidity 0.61–0.67 ratio ✓ (0–1, not %)
- Wind 8–13 m/s, gust 13–16 m/s ✓ (m/s); direction 5.77–5.87 rad ≈ 330–336° ✓
- Waves 1.11 m / 3.9 s ✓; swell 0.39 m ✓; current 0.26 m/s ✓; sea level 0.26 m ✓

---

## Bugs found by integration testing and fixed this phase

1. **Atmospheric deltas absent (Bug A).** `nearestStation` chose the single
   geographically-nearest station — a precipitation-only gauge (05031) with no
   temp/wind — so `environment.outside.*` never published. Fixed: `nearestParams`
   resolves **each parameter from the nearest station reporting it** (temp/wind
   from synop 06079, precip from 05031). Regression test added.
2. **Forecast endpoint hung (Bug B).** On-demand DMI fetch had no timeout → HTTP
   request hung forever when DMI was slow/429. Fixed: per-request AbortController
   timeout (6 s) + 2 tries, the 3 collections fetched in **parallel**, a forecast
   cache, and a 2.5 s cache-serve deadline. Now returns 200 in ~2.5 s warm / ~7 s
   cold, never hangs.
3. **429 resilience.** `getJson` retries 429/5xx/timeout with exponential backoff
   (0.7/1.4/2.8 s); per-source failures degrade gracefully (`tryEdr`/`tryObs`
   return []); marine deltas keep a **last-good cache** so a busy poll re-publishes
   the previous value instead of dropping the path. Stays under 500 req/5 s.

## Verdict: **PASS** (a, b, c, d all green)

## For the foreman to re-validate (container is UP on :3000)
```
curl -s "http://localhost:3000/signalk/v2/api/weather/_providers"
curl -s "http://localhost:3000/signalk/v2/api/weather/forecasts/point?lat=57&lon=11&count=2"
curl -s "http://localhost:3000/signalk/v2/api/weather/observations?lat=57&lon=11"
curl -s "http://localhost:3000/signalk/v1/api/vessels/self/environment"
```
All return HTTP 200 anonymously. Container `sk-dmi-test` intentionally left running
(do not `docker rm`). Not deployed to the Pi.
