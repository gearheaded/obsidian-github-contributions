# GitHub Contributions for Obsidian

View your GitHub contribution heatmap directly in the Obsidian sidebar — with streak tracking, hover tooltips, and one-click daily note creation.

![GitHub contribution graph in Obsidian sidebar]

## Features

- **Contribution heatmap** - the full year grid, dark/light theme aware
- **Year navigation** - flip back through any year since 2008
- **Stats bar** - total contributions, current streak, best streak
- **Hover tooltips** - date + exact count on every cell
- **Click to open daily note** - clicking any day opens (or creates) the matching daily note
- **Configurable sidebar side** - left or right panel
- **Shimmer skeleton** while loading

## Installation

### Manual (until published to the community registry)

1. Download the latest release zip from GitHub, or build from source (see below)
2. Extract the folder into your vault's plugin directory:
   ```
   <YourVault>/.obsidian/plugins/github-contributions/
   ```
   The folder must contain: `main.js`, `manifest.json`
3. In Obsidian -> **Settings -> Community Plugins**, enable **GitHub Contributions**
4. Open the plugin settings and fill in:
   - **GitHub Username** - your GitHub handle
   - **Personal Access Token** - a PAT with `read:user` scope (see below)

### Getting a GitHub PAT

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token (classic)**
3. Give it a name (e.g. `obsidian-contributions`)
4. Select only the **`read:user`** scope
5. Click **Generate token** and paste it into the plugin settings

The token is stored locally in your vault's plugin data - it never leaves your machine except to call the GitHub GraphQL API.

## Building from source

```bash
git clone https://github.com/you/obsidian-github-contributions
cd obsidian-github-contributions
npm install
npm run build
```

Then copy `main.js` and `manifest.json` into your vault's plugin folder.

For live development with hot-reload:
```bash
npm run dev
```

## Settings

| Setting | Description |
|---|---|
| GitHub Username | Your GitHub handle |
| Personal Access Token | PAT with `read:user` scope |
| Sidebar Side | Left or right panel |
| Default Year | Year shown on first open (use the ‹ › arrows to change in-panel) |
| Daily Notes Folder | Folder to look for / create daily notes in (blank = vault root) |
| Date Format | Moment.js format matching your daily note filenames (default: `YYYY-MM-DD`) |

## Opening the panel

- Click the **GitHub icon** in the ribbon (left sidebar icon strip)
- Or run the command: `GitHub Contributions: Open GitHub Contributions panel`

## Daily note integration

Clicking any contribution cell opens the matching daily note. If it doesn't exist yet, it's created automatically in your configured daily notes folder using your date format. This works alongside the core Daily Notes and Periodic Notes plugins — just make sure the folder and date format match.

## License

MIT
