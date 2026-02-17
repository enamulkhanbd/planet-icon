# Planet Icon

Planet Icon is a Figma plugin that syncs icon files from remote repositories (Azure DevOps or GitHub), previews them in-app, and inserts production SVG icons into your design file.

## Features

- Sync icons from:
  - Azure DevOps Repos
  - GitHub Repositories
- Supports icon variants:
  - `outline`
  - `fill`
  - `bulk`
- Icon size controls: `xs`, `sm`, `md`, `lg`, `xl`
- Persistent icon-index cache for faster reloads
- Color icon handling:
  - Preserves original colors for `bulk` and multi-color SVGs
  - Tints standard mono icons to plugin theme color
- Remote sync error reporting in UI

## Repository

- Repo: https://github.com/enamulkhanbd/planet-icon
- Releases: https://github.com/enamulkhanbd/planet-icon/releases
- Latest Release: https://github.com/enamulkhanbd/planet-icon/releases/latest

## Project Structure

- `manifest.json` Figma plugin manifest
- `code.js` plugin runtime logic (provider sync, insertion, cache)
- `ui.html` plugin UI
- `scripts/inject-version.js` version sync script
- `package.json` version source and automation scripts

## Setup (Development)

1. Clone the repository.
2. In Figma desktop: `Plugins` -> `Development` -> `Import plugin from manifest...`
3. Select this repo's `manifest.json`.
4. Run the plugin and configure provider settings.

## Provider Configuration

### Azure DevOps

- Organization URL: `https://dev.azure.com/<organization>`
- Project: `<project>`
- Repository: `<repository>` or `project/_git/repository`
- Branch: `<branch>`
- PAT scope: at least repository read access

### GitHub

- Repository: `owner/repo`
- Branch: `<branch>`
- PAT scope: repository read access

## Versioning Automation

`package.json` is the single source of truth for plugin version.

- Sync UI version labels from `package.json`:
  - `npm run sync-version`
- Bump and sync:
  - `npm run bump:patch`
  - `npm run bump:minor`
  - `npm run bump:major`

These commands update version labels used in `ui.html` (loading screen and footer).

## Release Flow (Fully Automatic)

Releases are automated via GitHub Actions with two workflows:

- `.github/workflows/releases-auto-version.yml`
  - Trigger: push to `main`
  - Computes semantic bump from commit subjects:
    - `breaking:` / `breaking change:` / `...!:` -> **major**
    - `feat:` / `release:` / `releases:` -> **minor**
    - `fix:` / `perf:` / `refactor:` -> **patch**
  - First release fallback:
    - If no prior `v*` tag exists and no bump keyword is found, it creates an initial **patch** release.
  - Updates:
    - `package.json` version
    - `ui.html` version labels (`npm run sync-version`)
    - optional `RELEASES.md` section (if `Release:`/`Releases:` lines exist)
  - Creates and pushes git tag `vX.Y.Z`.
  - Packages and publishes a GitHub Release asset zip containing only:
    - `manifest.json`
    - `manifest.main` (currently `code.js`)
    - `manifest.ui` (currently `ui.html`)

- `.github/workflows/releases-zip.yml`
  - Trigger:
    - push tag `v*`, or
    - completion of `.github/workflows/releases-auto-version.yml` (success)
  - Packages plugin zip from files defined by `manifest.json` (`main`, `ui`) plus `manifest.json`
  - Creates GitHub Release and uploads zip artifact.
  - If a tag exists but release is missing, it auto-publishes that pending release (no manual step).

### Skip Controls

- Add `[no release]` in commit message to skip release/tag creation for that push.
- Add `[skip ci]` to skip workflow execution.

## Release Notes

Important:
- The `zip` / `tar.gz` shown under the **Tags** tab are GitHub source archives (full repository snapshot).
- The plugin install package is the custom zip uploaded under the **Releases** tab assets.

## License

Add a license file (`LICENSE`) if you plan to distribute publicly.
