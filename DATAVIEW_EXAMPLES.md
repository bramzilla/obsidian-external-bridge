# External Bridge — Dataview Examples

These queries work out of the box with the properties External Bridge adds to every placeholder note. Install the [Dataview](https://github.com/blacksmithgu/obsidian-dataview) community plugin to use them.

---

## List all external files

```dataview
TABLE external-file AS "File", external-size AS "Size", external-modified AS "Modified"
FROM "ExternalBridge"
SORT external-modified DESC
```

---

## All PDFs tagged for review

```dataview
TABLE external-file AS "File", external-size AS "Size"
FROM "ExternalBridge"
WHERE external-type = "pdf" AND contains(tags, "review")
SORT file.name ASC
```

---

## Files from a specific bridge

Replace `"Handwritten Notes"` with your bridge label.

```dataview
TABLE external-file AS "File", external-size AS "Size", external-modified AS "Modified"
FROM "ExternalBridge"
WHERE bridge-label = "Handwritten Notes"
SORT external-modified DESC
```

---

## Recently modified external files (last 30 days)

```dataview
TABLE external-file AS "File", external-modified AS "Modified", bridge-label AS "Bridge"
FROM "ExternalBridge"
WHERE date(external-modified) >= date(today) - dur(30 days)
SORT external-modified DESC
```

---

## Files by type — count summary

```dataview
TABLE length(rows) AS "Count"
FROM "ExternalBridge"
GROUP BY external-type AS "Type"
SORT length(rows) DESC
```

---

## Total size per bridge

This uses DataviewJS for the size calculation since sizes are stored as strings.

```dataviewjs
const pages = dv.pages('"_ExternalBridge"');
const byBridge = {};

for (const p of pages) {
  const label = p["bridge-label"] ?? "Unknown";
  const sizeStr = p["external-size"] ?? "0 B";
  
  // Parse size to bytes
  let bytes = 0;
  const match = sizeStr.match(/([\d.]+)\s*(B|KB|MB|GB)/i);
  if (match) {
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit === "B")  bytes = val;
    if (unit === "KB") bytes = val * 1024;
    if (unit === "MB") bytes = val * 1024 * 1024;
    if (unit === "GB") bytes = val * 1024 * 1024 * 1024;
  }
  
  byBridge[label] = (byBridge[label] ?? 0) + bytes;
}

// Format and render
const rows = Object.entries(byBridge).map(([label, bytes]) => {
  let size = "";
  if (bytes < 1024) size = `${bytes} B`;
  else if (bytes < 1024*1024) size = `${(bytes/1024).toFixed(1)} KB`;
  else if (bytes < 1024*1024*1024) size = `${(bytes/(1024*1024)).toFixed(1)} MB`;
  else size = `${(bytes/(1024*1024*1024)).toFixed(2)} GB`;
  return [label, size];
});

dv.table(["Bridge", "Total Size (external, not synced)"], rows);
```

---

## Files with no user notes yet

Useful for finding placeholders you haven't annotated yet.

```dataviewjs
const pages = dv.pages('"_ExternalBridge"');
const empty = [];

for (const p of pages) {
  const content = await dv.io.load(p.file.path);
  const userSection = content.split("bridge:user-content:start -->")[1]
    ?.split("<!-- bridge:user-content:end")[0] ?? "";
  const hasContent = userSection.replace(/<!--.*?-->/gs, "").trim().length > 0;
  if (!hasContent) empty.push(p);
}

dv.table(
  ["File", "Type", "Bridge"],
  empty.map(p => [p.file.link, p["external-type"], p["bridge-label"]])
);
```

---

## Tips

- All External Bridge properties start with `external-` or `bridge-` so they're easy to target
- Replace `"_ExternalBridge"` in the `FROM` clause with your actual vault folder name if you customised it
- You can combine External Bridge properties with your own custom properties added in the user content zone
