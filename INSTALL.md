# Installing a custom Signal K plugin the supported way

This is the **standard for all custom maracaibo Signal K plugins** (`signalk-dmi`,
and any future in-house plugin not published to npm). It replaces the old, broken
"scp files into `node_modules`" sideload. **Never hand-patch `node_modules` again.**

## How Signal K discovers and registers plugins

Two distinct mechanisms — understand both or the install looks like it "half-works":

1. **Discovery (what makes a plugin appear + run + show in the admin UI).**
   On startup `signalk-server` scans the `node_modules` inside its config
   directory (`$HOME/.signalk`, on the boat bind-mounted from
   `/home/pi/docker/signalk`) for any package whose `package.json` `keywords`
   contains `signalk-node-server-plugin`. Every match is loaded, its `start()`
   runs, and it is listed under **Server → Plugin Config** in the admin UI where
   it can be enabled/configured. Discovery is by keyword scan — it does **not**
   read the config-dir `package.json` `dependencies`.

2. **Registration / tracking (what makes the install reproducible + manageable).**
   `$HOME/.signalk/package.json` (`name: signalk-server-config`) is the manifest
   that tracks *which* plugins are installed. The App Store writes here on
   install/remove, and `cd ~/.signalk && npm install` rebuilds `node_modules`
   from it. A plugin that is only keyword-scanned (files present in
   `node_modules` but absent from this manifest) **runs and shows in the UI**,
   but is **not tracked**: the App Store can't update/remove it, and a
   `node_modules` rebuild (`npm install`, `npm ci`, container/volume rebuild)
   silently wipes it. That was the `signalk-dmi` sideload failure mode.

> **The deploy gate ("visible in the admin UI") is satisfied by discovery alone.
> "Properly installed" additionally requires registration** — the plugin listed
> in `~/.signalk/package.json` `dependencies` so it survives rebuilds and is
> App-Store-manageable. Do both.

## Supported install methods (pick by plugin source)

| Plugin source | Method | Registers in package.json? | Survives rebuild? |
|---|---|---|---|
| Published to npm | Admin UI **App Store**, or `npm install <name>` | yes | yes |
| Local dir, dev/iteration | `npm link` | **no** (symlink; wiped on any App-Store install/update) | no — dev only |
| **Custom, unpublished, no npm/git remote** (our case) | **`npm install ./<name>-<ver>.tgz`** (tarball → `file:` dep) | **yes** | **yes** |
| Custom, in a git remote | `npm install <git-url>` | yes | yes |

`npm link` is fine while iterating on a laptop but is **not** a deploy method:
the docs note "updating and/or installing new plugins will remove the link." For
the boat, use the tarball (or a git URL once the repo is pushed).

## The supported install of `signalk-dmi` on the boat (tarball method)

Config dir on the Pi: `/home/pi/docker/signalk` (bind-mounted to
`/home/node/.signalk` inside the `signalk-server` container). Run `npm` **inside
the container** so it matches the server's node/arch.

```bash
# 1. Build a versioned tarball from the repo (on the dev machine)
cd /Volumes/development/source/my-projects/signalk-dmi
npm pack                                   # -> signalk-dmi-0.1.0.tgz

# 2. Copy it into the server config dir (= /home/node/.signalk in the container)
scp signalk-dmi-0.1.0.tgz pi@192.168.8.9:/home/pi/docker/signalk/

# 3. Remove any prior hand-dropped sideload (clean slate)
ssh pi@192.168.8.9 'docker exec signalk-server rm -rf /home/node/.signalk/node_modules/signalk-dmi'

# 4. Install the tarball => adds "signalk-dmi": "file:signalk-dmi-0.1.0.tgz" to
#    ~/.signalk/package.json AND unpacks it into node_modules (registered + discovered)
ssh pi@192.168.8.9 'docker exec -w /home/node/.signalk signalk-server npm install ./signalk-dmi-0.1.0.tgz --no-audit --no-fund'

# 5. Restart so the server re-scans and loads the freshly installed code
ssh pi@192.168.8.9 'docker restart signalk-server'
```

Plugin **configuration** lives separately in
`/home/pi/docker/signalk/plugin-config-data/signalk-dmi.json` (keyed by plugin
id) and is **preserved** across reinstall — `enabled`, `weatherProvider`, poll
settings all survive. Enable/configure in the admin UI, or seed that file.

### Upgrading to a new version

Bump `version` in `package.json`, `npm pack`, scp the new `.tgz`, then
`docker exec -w /home/node/.signalk signalk-server npm install ./signalk-dmi-<newver>.tgz`
and restart. (Same filename + same version → delete the container's npm cache
entry or bump the version, since `file:` deps are cached by version.)

## Verify (independent of the dev machine)

```bash
# registered in the tracked manifest
ssh pi@192.168.8.9 'grep signalk-dmi /home/pi/docker/signalk/package.json'
# => "signalk-dmi": "file:signalk-dmi-0.1.0.tgz"

# discovered + loaded (admin API needs auth; keyword presence confirms discovery)
ssh pi@192.168.8.9 'grep -l signalk-node-server-plugin /home/pi/docker/signalk/node_modules/signalk-dmi/package.json'

# publishing live (anon read is enabled on the boat server)
curl -sk "https://192.168.8.9:3443/signalk/v1/api/vessels/self/environment" | grep -o signalk-dmi
```

In the admin UI: **https://192.168.8.9:3443** → Server → Plugin Config →
**DMI Open Data** appears, enabled, configurable.

## Fleet note

All maracaibo custom plugins follow this. Published community plugins
(`openweather-signalk`, `signalk-to-influxdb2`, …) come from the App Store and
are already tracked in `~/.signalk/package.json`. In-house plugins
(`signalk-dmi`, and if resurrected `signalk-heater-afterburner` /
`signalk-powr3-control`) must be installed by the **tarball method above**, never
sideloaded. Once an in-house plugin is pushed to a git remote, `npm install
<git-url>` is an equally-supported alternative that avoids shipping tarballs.

## Sources

- Signal K — Server plugins (discovery, keyword, `npm link`):
  https://demo.signalk.org/documentation/develop/plugins/server_plugin.html
- Signal K — Installation / config dir (`$HOME/.signalk`, `npm install` rebuilds
  from package.json): https://demo.signalk.org/documentation/Installation.html
