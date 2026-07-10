# Installing signalk-dmi

How to install **signalk-dmi** on your own Signal K server. Three routes are
covered: the **Appstore** (easiest, once published), **npm**, and a **local
tarball** (for testing an unpublished build or an offline install). No AI or
special tooling is needed — just your Signal K server and a terminal.

## Requirements

- A running **Signal K server** (the Node.js server, `signalk-server`). The
  `environment.*` deltas work on any recent version; the **v2 Weather API
  provider** feature needs a **v2-capable** server (Signal K server ≥ 2.x).
- **Node.js 18 or newer** (whatever your Signal K server runs on).
- **Outbound internet** access to `https://opendataapi.dmi.dk`.
- **No DMI API key and no account are required.** DMI's Open Data API at
  `opendataapi.dmi.dk` is free and key-free (no authentication header, no
  registration). See <https://opendatadocs.dmi.govcloud.dk/en/Authentication>.
  You do **not** need to sign up for anything to use this plugin.
- Useful data **coverage** is Danish, North Sea and Baltic waters (DMI's model
  domains). Outside those areas the plugin simply publishes nothing.

That's it — no database is required. (Optional history/trends via the separate
`signalk-to-influxdb2` plugin; see the README.)

## How Signal K finds a plugin (background)

On startup the server scans the `node_modules` folder **inside its configuration
directory** (`$HOME/.signalk` by default) for any package whose `package.json`
`keywords` include `signalk-node-server-plugin`. Every match is loaded and listed
under **Server → Plugin Config** in the admin UI, where you enable and configure
it. All three install routes below simply get the plugin's files into that
`node_modules` folder in the supported way.

> If your server runs in **Docker**, the configuration directory is a volume
> bind-mounted to `/home/node/.signalk` inside the container. Run any `npm`
> command **inside the container** (e.g. `docker exec -w /home/node/.signalk
> <your-signalk-container> npm …`) so it uses the container's Node.js.

## Route A — Signal K Appstore (recommended, once published)

1. Open your Signal K server admin UI → **Appstore → Available**.
2. Search **signalk-dmi** (category **Weather**) → **Install**.
3. **Restart** the server when prompted.

The Appstore installs and tracks the plugin for you. (Available once the package
is published to npm.)

## Route B — npm

Run in your Signal K **configuration directory** (`~/.signalk` on a standard
install), then restart the server:

```bash
cd ~/.signalk
npm install signalk-dmi
```

This adds `signalk-dmi` to `~/.signalk/package.json` and installs it into
`node_modules`. On a Docker server, run it inside the container instead:

```bash
docker exec -w /home/node/.signalk <your-signalk-container> npm install signalk-dmi --no-audit --no-fund
```

Restart the server afterwards.

## Route C — local tarball (testing an unpublished build / offline)

Use this to test a build that is not on npm yet. It installs the plugin as a
tracked `file:` dependency, so it shows in the admin UI and survives
`node_modules` rebuilds — unlike copying files into `node_modules` by hand (which
the server will silently drop on the next `npm install`; don't do that).

**1. Build a tarball** from a checkout of this repo (on any machine with Node):

```bash
npm pack            # produces signalk-dmi-<version>.tgz, e.g. signalk-dmi-0.4.0.tgz
```

**2. Put the tarball into the server's configuration directory.**

Standard install — copy it into `~/.signalk`:

```bash
cp signalk-dmi-0.4.0.tgz ~/.signalk/
```

Docker server — copy it into the config volume (the host path you bind-mounted to
`/home/node/.signalk`), for example:

```bash
docker cp signalk-dmi-0.4.0.tgz <your-signalk-container>:/home/node/.signalk/
```

**3. Install the tarball** from the configuration directory:

```bash
# standard install
cd ~/.signalk
npm install ./signalk-dmi-0.4.0.tgz --no-audit --no-fund

# OR Docker server
docker exec -w /home/node/.signalk <your-signalk-container> npm install ./signalk-dmi-0.4.0.tgz --no-audit --no-fund
```

This adds `"signalk-dmi": "file:signalk-dmi-0.4.0.tgz"` to the config-dir
`package.json` and unpacks it into `node_modules`.

**4. Restart** the Signal K server (restart the service, or the Docker container).

### Upgrading a tarball install

Build the new version (`npm pack`), copy the new `.tgz` in, run the same
`npm install ./signalk-dmi-<newversion>.tgz`, and restart. `file:` dependencies
are cached by version, so bump `version` in `package.json` for each build (this
repo does).

## Enable and configure

1. Admin UI → **Server → Plugin Config** → **DMI (Danish Meteorological
   Institute) free data**.
2. Toggle **Enabled** and **Submit**.
3. Set the options as needed — every field has in-UI help text:
   - **Position source** — *Vessel GPS* (uses `navigation.position`) or *Fixed
     coordinates* (enter a latitude/longitude for a dock/shore install or a test).
   - **Register as Weather API provider** — ON to serve `/signalk/v2/api/weather`;
     turn OFF to run additively alongside another weather provider (the
     `environment.*` deltas still publish either way).
   - Publish toggles (observations, extended conditions, waves, ocean, warnings),
     poll interval, forecast window, and the HARMONIE/WAM/DKSS model + warning
     countries (all fixed-value dropdowns — you cannot enter an invalid id).

   The full field reference is in the [README](README.md#configuration).

Plugin settings are stored in `plugin-config-data/signalk-dmi.json` in the config
directory and are **preserved across upgrades** (that file is not part of the
tarball).

## Verify it installed and is publishing

**1. It loaded / is registered.** In the admin UI it appears under **Server →
Plugin Config**. From a shell you can also confirm the files landed:

```bash
# tracked as a dependency
grep signalk-dmi ~/.signalk/package.json
# carries the plugin keyword (so the server discovers it)
grep -l signalk-node-server-plugin ~/.signalk/node_modules/signalk-dmi/package.json
```

(On Docker, prefix with `docker exec <your-signalk-container>` and use the
`/home/node/.signalk/…` paths.)

**2. It is publishing DMI data.** Easiest check: in the admin UI open **Data
Browser** and look for paths under `environment.*` with source **signalk-dmi**.

To check from a shell, query the REST API (replace `localhost:3000` with your
server's host/port; use `https` + `-k` if TLS is on). **Note on security:** if your
server has security enabled, anonymous API reads return **HTTP 401** — either use
the admin UI Data Browser above, send a logged-in request (token), or enable
*Allow read-only access* in **Security → Settings**. With **Position source** set
to a location in Danish/North-Sea waters (e.g. a *Fixed* test position like lat
`57`, lon `11`), after one poll cycle:

```bash
# environment.* deltas — look for "$source":"signalk-dmi"
curl -s "http://localhost:3000/signalk/v1/api/vessels/self/environment" | grep -o signalk-dmi

# see actual values (atmospheric + marine)
curl -s "http://localhost:3000/signalk/v1/api/vessels/self/environment/outside/temperature"
curl -s "http://localhost:3000/signalk/v1/api/vessels/self/environment/water/temperature"
```

**3. (If Weather API provider is ON)** DMI registers as a provider:

```bash
curl -s "http://localhost:3000/signalk/v2/api/weather/_providers"
# => includes {"dmi": ...}
curl -s "http://localhost:3000/signalk/v2/api/weather/forecasts/point?lat=57&lon=11&count=2"
```

If `environment.*` shows `signalk-dmi` and the forecast endpoint returns data,
the install is working. Marine wave/current fields can be intermittent (DMI
rate-limits its marine models); atmospheric, water temperature, level and tide
come through reliably.

## Optional — history & trends (InfluxDB)

signalk-dmi publishes **live** data only; it stores nothing itself, and it needs
**no database to run**. If you want **history or trend graphs** (e.g. sparklines,
forecast-vs-actual over time), persist the DMI paths with the separate
[`signalk-to-influxdb2`](https://www.npmjs.com/package/signalk-to-influxdb2)
plugin. This is entirely optional and independent of signalk-dmi.

1. Install **signalk-to-influxdb2** from the Appstore and point it at an
   **InfluxDB 2.x** bucket (URL, org, token, bucket — see that plugin's own docs).
2. In its plugin config, set the **`filteringRules`** allow-list so the DMI paths
   are persisted. Add these allow rules (regex `path`), keeping the deny-all
   **last**. **Only add** — if you already have allow rules, keep them; just append
   these:

   ```json
   "filteringRules": [
     { "allow": true,  "path": "environment\\.outside\\." },
     { "allow": true,  "path": "environment\\.water\\." },
     { "allow": true,  "path": "environment\\.tide\\." },
     { "allow": true,  "path": "environment\\.current\\." },
     { "allow": false, "path": ".*" }
   ]
   ```

   `environment\.outside\.` covers temperature, pressure, humidity, wind **and**
   the extended `horizontalVisibility` / `cloudCover` / `precipitationRate` paths;
   `environment\.water\.` covers water temperature/level and waves/swell;
   `environment\.tide\.` and `environment\.current\.` cover the rest of the DMI
   output. (These are exactly the `environment.*` groups signalk-dmi publishes;
   they also match any same-prefix non-DMI paths — harmless for an allow-list.)
   The plugin shows this same list — and whether it is already applied — in its
   own **Plugin Config** (see the *History & trends* status field), so you can
   copy it straight from there.

3. **Restart** the server. After some data accumulates, confirm history flows via
   the Signal K **v2 History API** (replace host/port; add a login/token or enable
   read-only access if security is on):

   ```bash
   curl -s "http://localhost:3000/signalk/v2/api/history/values?paths=environment.water.temperature&from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z&resolution=1800"
   ```

   A working setup returns `data` rows of `[timestamp, value]`. (Use a `from`/`to`
   window that spans when the plugin has been running.)

## Troubleshooting

- **Not in the plugin list** → the files aren't in the config-dir `node_modules`,
  or you installed into the wrong directory (must be the server's `~/.signalk`,
  or `/home/node/.signalk` inside the container). Reinstall via a route above and
  restart.
- **Listed but no data** → make sure it's **Enabled**, a **position** is set
  (Vessel GPS needs a live `navigation.position`; otherwise use Fixed
  coordinates), and the position is within DMI's coverage. Give it one poll cycle.
- **No internet / DNS to `opendataapi.dmi.dk`** → the plugin can't fetch; check
  the server host's outbound connectivity.

## Sources

- Signal K — Server plugins (keyword discovery, config directory):
  <https://demo.signalk.org/documentation/develop/plugins/server_plugin.html>
- Signal K — Installation / configuration directory (`$HOME/.signalk`):
  <https://demo.signalk.org/documentation/Installation.html>
- DMI Open Data — Authentication (key-free access):
  <https://opendatadocs.dmi.govcloud.dk/en/Authentication>
