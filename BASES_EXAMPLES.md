# External Bridge — Bases Examples

Bases is Obsidian's built-in database feature (introduced in v1.9, August 2025). Unlike Dataview, it requires no plugin, works natively with the Properties panel, and lets you edit properties directly from the view.

Each example below is a ready-to-use `.base` file. Save it anywhere in your vault and open it, or embed it in a note with `![[filename.base]]`.

> **Note:** Replace `_ExternalBridge` in `file.inFolder()` calls with your actual vault folder name if you customised it.

---

## 1. All external files — master table

Save as `External Bridge - All Files.base`

```yaml
filters:
  - file.inFolder("_ExternalBridge")

properties:
  file.name:
    displayName: Note
  external-file:
    displayName: File
  external-type:
    displayName: Type
  external-size:
    displayName: Size
  external-modified:
    displayName: Modified
  bridge-label:
    displayName: Bridge

views:
  - type: table
    name: All External Files
    order:
      - file.name
      - external-type
      - external-size
      - external-modified
      - bridge-label
```

---

## 2. PDFs only — sorted by date

Save as `External Bridge - PDFs.base`

```yaml
filters:
  and:
    - file.inFolder("_ExternalBridge")
    - 'external-type == "pdf"'

properties:
  file.name:
    displayName: Note
  external-file:
    displayName: File
  external-size:
    displayName: Size
  external-modified:
    displayName: Modified
  bridge-label:
    displayName: Bridge

views:
  - type: table
    name: PDFs
    order:
      - external-modified
      - file.name
      - external-size
      - bridge-label
```

---

## 3. Files tagged for review

Save as `External Bridge - Review Queue.base`

```yaml
filters:
  and:
    - file.inFolder("_ExternalBridge")
    - file.hasTag("review")

properties:
  file.name:
    displayName: Note
  external-file:
    displayName: File
  external-type:
    displayName: Type
  external-modified:
    displayName: Modified
  bridge-label:
    displayName: Bridge

views:
  - type: table
    name: Review Queue
    order:
      - external-modified
      - file.name
      - external-type
      - bridge-label
```

---

## 4. Recently modified — last 30 days

Save as `External Bridge - Recent.base`

```yaml
filters:
  and:
    - file.inFolder("_ExternalBridge")
    - 'date(external-modified) > today() - "30d"'

properties:
  file.name:
    displayName: Note
  external-file:
    displayName: File
  external-type:
    displayName: Type
  external-modified:
    displayName: Modified
  bridge-label:
    displayName: Bridge

views:
  - type: table
    name: Modified Last 30 Days
    order:
      - external-modified
      - file.name
      - external-type
```

---

## 5. Browse a single bridge

Useful if you have multiple bridges and want a focused view of just one.
Replace `"Handwritten Notes"` with your actual bridge label.

Save as `External Bridge - Handwritten Notes.base`

```yaml
filters:
  and:
    - file.inFolder("_ExternalBridge")
    - 'bridge-label == "Handwritten Notes"'

properties:
  file.name:
    displayName: Note
  external-file:
    displayName: File
  external-size:
    displayName: Size
  external-modified:
    displayName: Modified

views:
  - type: table
    name: Handwritten Notes
    order:
      - external-modified
      - file.name
      - external-size
  - type: cards
    name: Card View
    order:
      - external-modified
      - file.name
      - external-size
```

---

## 6. Group by file type

Shows all external files grouped by type (PDF, MP3, PNG, etc.) — great for getting a quick overview of what you have.

Save as `External Bridge - By Type.base`

```yaml
filters:
  - file.inFolder("_ExternalBridge")

properties:
  file.name:
    displayName: Note
  external-file:
    displayName: File
  external-size:
    displayName: Size
  external-modified:
    displayName: Modified
  bridge-label:
    displayName: Bridge

views:
  - type: table
    name: Grouped by Type
    groupBy:
      property: external-type
      direction: ASC
    order:
      - external-type
      - external-modified
      - file.name
      - external-size
      - bridge-label
```

---

## 7. Group by bridge

Shows all files grouped by which bridge they belong to.

Save as `External Bridge - By Bridge.base`

```yaml
filters:
  - file.inFolder("_ExternalBridge")

properties:
  file.name:
    displayName: Note
  external-file:
    displayName: File
  external-type:
    displayName: Type
  external-size:
    displayName: Size
  external-modified:
    displayName: Modified

views:
  - type: table
    name: Grouped by Bridge
    groupBy:
      property: bridge-label
      direction: ASC
    order:
      - bridge-label
      - external-modified
      - file.name
      - external-type
      - external-size
```

---

## 8. Linked to current note (sidebar use)

Drop this in your sidebar to see all external bridge placeholders that link to whatever note you're currently viewing. Works because `this` refers to the active note when a base is in the sidebar.

Save as `External Bridge - Linked Here.base`

```yaml
filters:
  and:
    - file.inFolder("_ExternalBridge")
    - file.hasLink(this.file)

properties:
  file.name:
    displayName: Note
  external-file:
    displayName: File
  external-type:
    displayName: Type
  external-modified:
    displayName: Modified

views:
  - type: table
    name: Linked to Active Note
    order:
      - file.name
      - external-type
      - external-modified
```

---

## 9. Multi-view: Table + Cards

A single base with two views — switch between them using the tabs at the top of the base.

Save as `External Bridge - Multi View.base`

```yaml
filters:
  and:
    - file.inFolder("_ExternalBridge")
    - 'external-type == "pdf"'

properties:
  file.name:
    displayName: Note
  external-file:
    displayName: File
  external-size:
    displayName: Size
  external-modified:
    displayName: Modified
  bridge-label:
    displayName: Bridge

views:
  - type: table
    name: Table
    order:
      - external-modified
      - file.name
      - external-size
      - bridge-label
  - type: cards
    name: Cards
    order:
      - file.name
      - external-modified
      - external-size
```

---

## Tips

- **Embed in a note** using `![[filename.base]]` — great for a dashboard or MOC page
- **Edit properties directly** in a base table — changes write back to the placeholder's frontmatter instantly
- **Sidebar base** (example 8) updates live as you navigate between notes
- **`this` keyword** refers to the embedding note (when embedded) or the active note (when in sidebar)
- All External Bridge properties start with `external-` or `bridge-` making them easy to filter and display
- You can freely add your own custom properties in the user content zone of any placeholder, and they'll show up in Bases immediately
