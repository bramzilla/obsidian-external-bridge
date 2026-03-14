# External Bridge — Obsidian Plugin

> Link large external folders to your vault using lightweight placeholder notes — without importing files or affecting Obsidian Sync size limits.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Obsidian minimum version](https://img.shields.io/badge/Obsidian-1.4.0%2B-blueviolet)
![Desktop only](https://img.shields.io/badge/Platform-Desktop%20only-lightgrey)

---

## The Problem

You have folders of large files (handwritten PDF scans, audio recordings, video exports) that you want to organise and link in Obsidian — but you can't include them in your vault because:

- **Obsidian Sync has a size limit** (currently 10 GB, with per-file limits too)
- **Your vault would balloon in size** and slow down sync
- **The files are already organised** on disk and you don't want to move them

## The Solution

External Bridge creates **lightweight placeholder notes** (`.md` files, a few KB each) inside your vault that *point to* real files on your disk. Each placeholder has:

- Full YAML frontmatter (tags, properties, custom metadata)
- File info: name, type, size, last modified
- A direct link to open the file in your system viewer
- Inline image preview for image files

Your 2 GB folder stays exactly where it is. Your vault only gains a handful of tiny text files.

---

## Features

- 🔗 **Link any external folder** — PDFs, images, audio, video, and more
- 🏷️ **Full metadata support** — tags, properties, all Obsidian frontmatter works normally
- 👁️ **File watcher** — automatically creates/updates/removes placeholders when external files change
- 💾 **User content preserved** — notes and links you write in a placeholder survive re-syncs
- 🔄 **Smart sync** — skips unchanged files (mtime-based), so large folders sync fast
- 📁 **Recursive** — mirrors your folder hierarchy inside the vault
- 🎛️ **Configurable per bridge** — different file types, vault destinations, watch settings per folder
- 🧹 **Cleans up stale placeholders** — when external files are deleted
- 🖼️ **Image previews** — inline preview for image files
- 🔒 **Desktop only** — uses Node.js `fs` for file system access

---

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/bramzilla/obsidian-external-bridge/releases)
2. Create: `<your-vault>/.obsidian/plugins/external-bridge/`
3. Copy the three files into that folder
4. Enable the plugin in **Settings → Community Plugins**

### Via BRAT (beta testing)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. Add `bramzilla/obsidian-external-bridge` via BRAT
3. Enable External Bridge in Community Plugins

---

## Usage

### 1. Add a Bridge

Click the **folder-link icon** in the ribbon, or run `External Bridge: Open Bridge Manager` from the command palette.

Click **+ Add Bridge** and fill in:

| Field | Description |
|---|---|
| **Label** | Friendly name, e.g. "Handwritten Notes" |
| **External folder path** | Absolute path on disk, e.g. `/Users/you/Documents/PDFNotes` |
| **Vault folder** | Where placeholders go inside your vault |
| **File types** | Which extensions to create placeholders for |
| **Include subfolders** | Mirror the folder structure recursively |
| **Enable file watcher** | Auto-update placeholders when external files change |

### 2. Sync

Click **↻ Sync** on the bridge card (or **↻ Sync All**) to generate all placeholder files.

### 3. Organise

Each file in your external folder now appears as a normal note inside your vault. You can add tags, properties, links, and your own notes freely in the **user content zone** — they will never be overwritten on re-sync.

### 4. User Content Zone

Every placeholder contains a clearly marked zone for your own content:

```
<!-- bridge:user-content:start -->
Your notes, links, and tags go here.
They are NEVER overwritten on re-sync.
<!-- bridge:user-content:end -->
```

Everything above that zone (frontmatter, file info table, preview) is regenerated automatically. Everything inside is yours.

### 5. File Watcher

Enable **👁 Watch** on a bridge to have the plugin watch the external folder in real time:

- New file added → placeholder created
- File modified → placeholder meta updated, your notes preserved
- File deleted → placeholder removed

A **pulsing green dot** on the bridge card shows the watcher is active. Watchers restart automatically when Obsidian reopens.

---

## Example Placeholder

```markdown
<!-- bridge:meta:start -->
---
external-path: "/Users/bram/Documents/Notes/session-2024-03-01.pdf"
external-file: "session-2024-03-01.pdf"
external-type: "pdf"
external-size: "4.2 MB"
external-modified: "2024-03-01"
external-mtime-ms: 1709251200000
bridge-id: "a3f9bc12"
bridge-label: "Handwritten Notes"
tags:
  - pdf
  - external-bridge
---

# session-2024-03-01.pdf

[→ Open in system viewer](...)
<!-- bridge:meta:end -->

<!-- bridge:user-content:start -->
## My Notes

Links to [[Algebra MOC]]. Covers quadratic equations, pages 3–7.

#review #math
<!-- bridge:user-content:end -->
```

---

## Settings

| Setting | Description |
|---|---|
| **Default tags** | Tags automatically added to all placeholder files |
| **Watcher debounce (ms)** | Wait time after a file event before acting (default: 2000ms) |
| **Open on startup** | Show Bridge Manager when Obsidian opens |

---

## Roadmap

- [ ] PDF first-page thumbnail preview
- [ ] One-click import of selected files into vault
- [ ] Bridge health check (warn when external path is unreachable)
- [ ] Export/import bridge config across machines
- [ ] Dataview example queries in docs

---

## Contributing

PRs and issues welcome! Please open an issue before starting large changes.

## License

[MIT](LICENSE) © bramzilla
