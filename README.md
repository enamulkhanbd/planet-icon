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

## Release Notes

This repo currently uses release links, but if no release has been published yet, create the first GitHub release to activate the latest-release URL.

## License

Add a license file (`LICENSE`) if you plan to distribute publicly.
