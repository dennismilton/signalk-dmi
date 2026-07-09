# Publishing signalk-dmi to npm and the Signal K Appstore

This is the full, verified procedure for pushing a new release of **signalk-dmi**
to the public npm registry, from where the **Signal K Appstore** picks it up
automatically. It is written so anyone with the npm publish rights can follow it.

> **The publish is public and irreversible.** `npm publish` cannot be undone
> (unpublish is heavily restricted after 72 hours and disallowed once others
> depend on the package). Run the dry-run first (step 4) and only publish when the
> file list is clean.

> **Maintainer-only steps.** Everything that publishes or claims a public
> identity — `npm login` / npm 2FA, `npm publish --access public`, creating the
> public GitHub repository, and any Signal K Appstore/registry submission — is the
> **package maintainer's (Dennis's) call** and must be run by the maintainer with
> their own npm/GitHub credentials. The build, dry-run and verification steps are
> safe for anyone to run; the actual publish is not automated and not delegated.

---

## How the Appstore listing works (mechanism)

- A plugin appears in the Signal K Appstore purely by being **published to the npm
  registry with the `signalk-node-server-plugin` keyword** in `package.json`.
  There is **no separate submission or approval step**.
  <sup>[[1]](#refs)</sup>
- Optional **category** keywords place it in an Appstore category. This package
  carries `signalk-category-weather`, so it lists under **Weather**.
  <sup>[[1]](#refs)</sup>
- `"signalk-plugin-enabled-by-default": false` (our setting) means the plugin
  installs disabled and the user enables it in _Plugin Config_ — correct, because
  it needs no mandatory config but should not start blind.
  <sup>[[1]](#refs)</sup>
- The **signalk-plugin-registry** scans npm for that keyword on a **nightly** run.
  It installs, loads and tests each plugin against a real Signal K server and
  assigns a quality score (0–100). A plugin is **retested when its version
  changes**, and any plugin whose results are older than 7 days is retested on the
  nightly run. You can request an expedited re-score by opening a GitHub issue on
  the registry with the "Request a plugin re-score" template.
  <sup>[[2]](#refs)</sup>
- Net effect: after `npm publish`, the new version is installable from npm
  immediately; the Appstore's **Available** list and score refresh on the next
  nightly registry run (or sooner via a re-score request).
  <sup>[[1]](#refs)[[2]](#refs)</sup>
- Install-time lifecycle scripts (`preinstall`/`install`/`postinstall`) are **not**
  run by the Appstore installer for security. This package has none and needs no
  build step, so nothing special is required; if a build were ever added, use
  `prepublishOnly`. <sup>[[1]](#refs)</sup>

---

## One-time setup (first publish only)

1. **npm account.** You need an npmjs.com account that has publish rights to the
   `signalk-dmi` name. The name was unclaimed at the time of writing (`npm view
   signalk-dmi` returned 404), so the first `npm publish` claims it under your
   account.
2. **Enable 2FA** on the npm account (Account → Two-Factor Authentication →
   "Authorization and Publishing"). npm will prompt for an OTP at publish time.
3. **Log in on this machine:**
   ```bash
   npm login
   ```
   Follow the browser/OTP prompt. Verify with `npm whoami`.

---

## Release procedure (every publish)

### 1. Land your changes and pick the version

Follow **semver**: patch for fixes, minor for backward-compatible features, major
for breaking changes. The current repo version is **0.3.2** (not yet published —
the first `npm publish` will be the initial public release).

Bump the version with npm (this rewrites `package.json`, makes a commit, and tags):
```bash
npm version patch
```
Use `npm version minor` or `npm version major` as appropriate. Push the tag:
```bash
git push --follow-tags
```

> If you prefer to hand-edit the `version` field in `package.json` instead of
> `npm version`, do that and commit + tag manually.

### 2. Confirm metadata is release-ready

`package.json` must have, and this package does:
- `name`: `signalk-dmi`
- `keywords` including **`signalk-node-server-plugin`** (required) and
  `signalk-category-weather`
- `repository`, `bugs`, `homepage`
- a `files` allow-list (ships only `index.js`, `lib/`, `README.md`, `LICENSE`,
  `INSTALL.md`, `PUBLISH.md`)
- `license`: `MIT`, and a `LICENSE` file present

### 3. Verify the tarball contents (dry run)

```bash
npm pack --dry-run
```
Read the printed file list. It **must not** contain: any `*.tgz`, `RESEARCH.md`,
`TEST.md`, `test/`, `.env*`, `.itest/`, or `package-lock.json`. It **must**
contain `index.js`, `lib/*.js`, `README.md`, `LICENSE`, `INSTALL.md`, `PUBLISH.md`
and `package.json`.

Then the full publish dry-run (does everything except upload):
```bash
npm publish --dry-run
```

### 4. Publish (public, irreversible)

```bash
npm publish --access public
```
Enter the OTP when prompted. `--access public` is explicit and safe for an
unscoped public package.

### 5. Verify it went out

```bash
npm view signalk-dmi version
```
should print the version you just published. The package page is
`https://www.npmjs.com/package/signalk-dmi`.

### 6. Verify it appears in the Appstore

- In a Signal K server admin UI, open **Appstore → Available** and search
  **signalk-dmi**. A brand-new package may take until the next **nightly** registry
  run to appear; to speed it up, open a "Request a plugin re-score" issue on the
  [signalk-plugin-registry](https://github.com/SignalK/signalk-plugin-registry).
  <sup>[[2]](#refs)</sup>
- Install it from the Appstore, restart, and confirm **DMI (Danish Meteorological
  Institute) free data** shows in **Server → Plugin Config** and (optionally) as a
  Weather API provider under `/signalk/v2/api/weather`.

---

## Update flow (subsequent releases)

1. Make changes, run `npm test`.
2. `npm version patch|minor|major` → `git push --follow-tags`.
3. `npm pack --dry-run` (inspect) → `npm publish --dry-run` → `npm publish
   --access public`.
4. Existing Appstore users see the new version as an **update** in
   **Appstore → Installed** after the next nightly registry run; the registry
   retests automatically on the version change. <sup>[[2]](#refs)</sup>

---

## Exact commands (copy/paste for a patch release)

```bash
npm login
npm whoami
npm test
npm version patch
git push --follow-tags
npm pack --dry-run
npm publish --dry-run
npm publish --access public
npm view signalk-dmi version
```

---

## <a id="refs"></a>References

1. Signal K — *Publishing to The AppStore* (required `signalk-node-server-plugin`
   keyword, `signalk-category-*` categories, `signalk-plugin-enabled-by-default`,
   no install-time scripts, `npm publish`):
   https://demo.signalk.org/documentation/Developing/Plugins/Publishing_to_The_AppStore.html
2. SignalK/signalk-plugin-registry — nightly keyword scan, install/load/activate
   testing, 0–100 scoring, retest on version change / >7-day age, re-score request
   template: https://github.com/SignalK/signalk-plugin-registry
