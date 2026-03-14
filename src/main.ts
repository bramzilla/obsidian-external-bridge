import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFolder,
	TFile,
	normalizePath,
	FileSystemAdapter,
} from "obsidian";

import * as path from "path";
import * as fs from "fs";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BridgedFolder {
	id: string;
	externalPath: string;
	vaultFolder: string;
	label: string;
	includedExtensions: string[];
	recursive: boolean;
	lastSynced: string | null;
	watchEnabled: boolean;
}

interface ExternalBridgeSettings {
	bridges: BridgedFolder[];
	defaultTags: string[];
	openOnSync: boolean;
	watchDebounceMs: number;
}

// User content is stored between the two sentinels in each placeholder note.
// Everything outside those sentinels is regenerated on sync.
const USER_CONTENT_START = "<!-- bridge:user-content:start -->";
const USER_CONTENT_END   = "<!-- bridge:user-content:end -->";

// Marks the auto-generated metadata block so we can reliably replace it.
const META_START = "<!-- bridge:meta:start -->";
const META_END   = "<!-- bridge:meta:end -->";

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: ExternalBridgeSettings = {
	bridges: [],
	defaultTags: [],
	openOnSync: false,
	watchDebounceMs: 2000,
};

const SUPPORTED_EXTENSIONS = [
	"pdf", "png", "jpg", "jpeg", "gif", "webp",
	"mp3", "mp4", "mov", "m4a",
	"docx", "xlsx", "pptx",
	"txt", "md",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
	return Math.random().toString(36).slice(2, 10);
}

function getFilesRecursive(dir: string, extensions: string[], recursive: boolean): string[] {
	const results: string[] = [];
	if (!fs.existsSync(dir)) return results;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory() && recursive) {
			results.push(...getFilesRecursive(fullPath, extensions, recursive));
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name).slice(1).toLowerCase();
			if (extensions.length === 0 || extensions.includes(ext)) {
				results.push(fullPath);
			}
		}
	}
	return results;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getFileStat(filePath: string): { size: number; mtime: string; mtimeMs: number } | null {
	try {
		const stat = fs.statSync(filePath);
		return {
			size: stat.size,
			mtime: stat.mtime.toISOString().split("T")[0],
			mtimeMs: stat.mtimeMs,
		};
	} catch {
		return null;
	}
}

// ─── Content building ─────────────────────────────────────────────────────────

/**
 * Build the YAML frontmatter block only (always goes at top of file).
 */
function buildFrontmatter(
	filePath: string,
	bridge: BridgedFolder,
	defaultTags: string[]
): string {
	const fileName = path.basename(filePath);
	const ext = path.extname(fileName).slice(1).toLowerCase();
	const stat = getFileStat(filePath);
	const allTags = [...new Set([...defaultTags, ext, "external-bridge"])].map((t) => `  - ${t}`).join("\n");

	return `---
external-path: "${filePath.replace(/\\/g, "/")}"
external-file: "${fileName}"
external-type: "${ext}"
external-size: "${stat ? formatFileSize(stat.size) : "unknown"}"
external-modified: "${stat ? stat.mtime : "unknown"}"
external-mtime-ms: ${stat ? stat.mtimeMs : 0}
bridge-id: "${bridge.id}"
bridge-label: "${bridge.label}"
tags:
${allTags}
---`;
}

/**
 * Build the auto-generated body block (below frontmatter).
 * Wrapped in META_START / META_END so it can be replaced on re-sync
 * without touching the user content section below it.
 */
function buildMetaBody(
	filePath: string,
	bridge: BridgedFolder,
	defaultTags: string[]
): string {
	const fileName = path.basename(filePath);
	const ext = path.extname(fileName).slice(1).toLowerCase();
	const stat = getFileStat(filePath);
	// Use file:// URI so the OS opens it in the default application
	const obsidianUri = `file://${filePath.replace(/\\/g, "/").replace(/ /g, "%20")}`;

	let previewBlock = "";
	if (ext === "pdf") {
		previewBlock = `\n> [!info] External PDF\n> This file is stored outside your vault and is not synced.\n> [→ Open in system viewer](${obsidianUri})\n`;
	} else if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
		previewBlock = `\n![${fileName}](${filePath})\n`;
	} else if (["mp3", "mp4", "mov", "m4a"].includes(ext)) {
		previewBlock = `\n> [!info] External Media\n> [→ Open in system viewer](${obsidianUri})\n`;
	} else {
		previewBlock = `\n> [!info] External File\n> [→ Open in system viewer](${obsidianUri})\n`;
	}

	return `${META_START}
# ${fileName}

| | |
|---|---|
| **Type** | ${ext.toUpperCase()} |
| **Size** | ${stat ? formatFileSize(stat.size) : "unknown"} |
| **Modified** | ${stat ? stat.mtime : "unknown"} |
| **Source** | \`${filePath}\` |

[→ Open in system viewer](${obsidianUri})
${previewBlock}
${META_END}`;
}

/**
 * Build the full placeholder for a brand-new file (no existing user content).
 * Structure: frontmatter → meta body → user content zone
 */
function buildFullPlaceholder(
	filePath: string,
	bridge: BridgedFolder,
	defaultTags: string[]
): string {
	const frontmatter = buildFrontmatter(filePath, bridge, defaultTags);
	const metaBody    = buildMetaBody(filePath, bridge, defaultTags);
	return `${frontmatter}
${metaBody}

${USER_CONTENT_START}
<!-- Add your notes, links, and tags below this line. They will be preserved on re-sync. -->

${USER_CONTENT_END}
`;
}

/**
 * Given the current content of an existing placeholder, replace the
 * frontmatter and meta body while leaving user content untouched.
 * If sentinel markers are missing (legacy format), migrate gracefully.
 */
function mergeUpdatedContent(
	existingContent: string,
	filePath: string,
	bridge: BridgedFolder,
	defaultTags: string[]
): string {
	const frontmatter = buildFrontmatter(filePath, bridge, defaultTags);
	const metaBody    = buildMetaBody(filePath, bridge, defaultTags);

	// Strip existing frontmatter (everything up to and including the closing ---)
	const afterFrontmatter = existingContent.replace(/^---[\s\S]*?---\n/, "");

	const metaStartIdx = afterFrontmatter.indexOf(META_START);
	const metaEndIdx   = afterFrontmatter.indexOf(META_END);

	if (metaStartIdx !== -1 && metaEndIdx !== -1) {
		// Replace the meta body block, keep everything after META_END (user content)
		const after = afterFrontmatter.slice(metaEndIdx + META_END.length);
		return `${frontmatter}\n${metaBody}${after}`;
	}

	// Legacy / missing sentinels — migrate and preserve any user content found
	const preservedUserContent = existingContent
		.split(USER_CONTENT_START)[1]
		?.split(USER_CONTENT_END)[0] ?? "";

	return `${frontmatter}
${metaBody}

${USER_CONTENT_START}
${preservedUserContent.trim() || "<!-- Add your notes, links, and tags below this line. They will be preserved on re-sync. -->"}

${USER_CONTENT_END}
`;
}

// ─── File Watcher ─────────────────────────────────────────────────────────────

type WatcherCallback = (event: "add" | "change" | "unlink", filePath: string) => void;

class FolderWatcher {
	private watcher: fs.FSWatcher | null = null;
	private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private knownFiles: Map<string, number> = new Map(); // path → mtimeMs
	private pollInterval: ReturnType<typeof setInterval> | null = null;

	constructor(
		private dir: string,
		private extensions: string[],
		private recursive: boolean,
		private debounceMs: number,
		private callback: WatcherCallback
	) {}

	start() {
		this.stop();

		// Seed known files
		const initial = getFilesRecursive(this.dir, this.extensions, this.recursive);
		for (const f of initial) {
			const stat = getFileStat(f);
			if (stat) this.knownFiles.set(f, stat.mtimeMs);
		}

		// Use Node's fs.watch where possible (fast, event-driven)
		// Fall back to polling for network drives / edge cases
		try {
			this.watcher = fs.watch(
				this.dir,
				{ recursive: this.recursive, persistent: false },
				(eventType, filename) => {
					if (!filename) return;
					// fs.watch gives relative paths on some platforms
					const resolved = path.isAbsolute(filename)
						? filename
						: path.join(this.dir, filename);
					const ext = path.extname(resolved).slice(1).toLowerCase();
					if (this.extensions.length > 0 && !this.extensions.includes(ext)) return;
					this.scheduleCheck(resolved);
				}
			);
		} catch {
			// fs.watch not available (e.g. network share) — use polling
			this.startPolling();
		}
	}

	private startPolling() {
		this.pollInterval = setInterval(() => {
			const current = getFilesRecursive(this.dir, this.extensions, this.recursive);
			const currentSet = new Set(current);

			// Detect new / changed
			for (const f of current) {
				const stat = getFileStat(f);
				if (!stat) continue;
				const known = this.knownFiles.get(f);
				if (known === undefined) {
					this.knownFiles.set(f, stat.mtimeMs);
					this.scheduleCheck(f, "add");
				} else if (stat.mtimeMs > known) {
					this.knownFiles.set(f, stat.mtimeMs);
					this.scheduleCheck(f, "change");
				}
			}

			// Detect removed
			for (const [f] of this.knownFiles) {
				if (!currentSet.has(f)) {
					this.knownFiles.delete(f);
					this.callback("unlink", f);
				}
			}
		}, 5000);
	}

	private scheduleCheck(filePath: string, hintEvent?: "add" | "change") {
		const existing = this.debounceTimers.get(filePath);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			this.debounceTimers.delete(filePath);
			const exists = fs.existsSync(filePath);
			if (!exists) {
				this.knownFiles.delete(filePath);
				this.callback("unlink", filePath);
				return;
			}
			const stat = getFileStat(filePath);
			if (!stat) return;
			const known = this.knownFiles.get(filePath);
			if (known === undefined) {
				this.knownFiles.set(filePath, stat.mtimeMs);
				this.callback(hintEvent ?? "add", filePath);
			} else if (stat.mtimeMs > known) {
				this.knownFiles.set(filePath, stat.mtimeMs);
				this.callback("change", filePath);
			}
		}, this.debounceMs);

		this.debounceTimers.set(filePath, timer);
	}

	stop() {
		if (this.watcher) { this.watcher.close(); this.watcher = null; }
		if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
		for (const t of this.debounceTimers.values()) clearTimeout(t);
		this.debounceTimers.clear();
	}
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class ExternalBridgePlugin extends Plugin {
	settings!: ExternalBridgeSettings;
	private watchers: Map<string, FolderWatcher> = new Map(); // bridge.id → watcher

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("folder-symlink", "External Bridge", () => {
			new BridgeManagerModal(this.app, this).open();
		});

		this.addCommand({
			id: "open-bridge-manager",
			name: "Open Bridge Manager",
			callback: () => new BridgeManagerModal(this.app, this).open(),
		});

		this.addCommand({
			id: "sync-all-bridges",
			name: "Sync all bridges",
			callback: () => this.syncAllBridges(),
		});

		this.addSettingTab(new ExternalBridgeSettingTab(this.app, this));

		if (this.settings.openOnSync) {
			this.app.workspace.onLayoutReady(() => {
				new BridgeManagerModal(this.app, this).open();
			});
		}

		// Start watchers for any bridge that has watching enabled
		this.app.workspace.onLayoutReady(() => {
			for (const bridge of this.settings.bridges) {
				if (bridge.watchEnabled) this.startWatcher(bridge);
			}
		});
	}

	onunload() {
		this.stopAllWatchers();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Back-fill watchEnabled for existing bridges that pre-date this field
		for (const b of this.settings.bridges) {
			if (b.watchEnabled === undefined) b.watchEnabled = false;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getVaultBasePath(): string {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
		return "";
	}

	// ─── Watcher management ────────────────────────────────────────────────────

	startWatcher(bridge: BridgedFolder) {
		this.stopWatcher(bridge.id);

		const watcher = new FolderWatcher(
			bridge.externalPath,
			bridge.includedExtensions,
			bridge.recursive,
			this.settings.watchDebounceMs,
			async (event, filePath) => {
				const vaultPath = this.externalPathToVaultPath(bridge, filePath);
				if (!vaultPath) return;

				if (event === "unlink") {
					const file = this.app.vault.getAbstractFileByPath(vaultPath);
					if (file instanceof TFile) {
						await this.app.vault.delete(file);
						new Notice(`External Bridge: removed placeholder for deleted file "${path.basename(filePath)}"`);
					}
				} else {
					// add or change
					await this.upsertPlaceholder(bridge, filePath, vaultPath);
					new Notice(`External Bridge: ${event === "add" ? "created" : "updated"} "${path.basename(filePath)}"`);
				}
			}
		);

		watcher.start();
		this.watchers.set(bridge.id, watcher);
	}

	stopWatcher(bridgeId: string) {
		const w = this.watchers.get(bridgeId);
		if (w) { w.stop(); this.watchers.delete(bridgeId); }
	}

	stopAllWatchers() {
		for (const w of this.watchers.values()) w.stop();
		this.watchers.clear();
	}

	// ─── Path helpers ──────────────────────────────────────────────────────────

	externalPathToVaultPath(bridge: BridgedFolder, externalFile: string): string | null {
		const ext = path.extname(externalFile).slice(1).toLowerCase();
		if (bridge.includedExtensions.length > 0 && !bridge.includedExtensions.includes(ext)) return null;
		const relativeToBridge = path.relative(bridge.externalPath, externalFile);
		const placeholderRelative = relativeToBridge.replace(/\.[^.]+$/, ".md");
		return normalizePath(path.join(bridge.vaultFolder, placeholderRelative));
	}

	// ─── Placeholder upsert ───────────────────────────────────────────────────

	async upsertPlaceholder(
		bridge: BridgedFolder,
		externalFile: string,
		vaultPath: string
	): Promise<"created" | "updated" | "skipped"> {
		// Ensure parent folder exists
		const parentDir = vaultPath.substring(0, vaultPath.lastIndexOf("/"));
		if (parentDir && !this.app.vault.getAbstractFileByPath(parentDir)) {
			await this.app.vault.createFolder(parentDir);
		}

		const existing = this.app.vault.getAbstractFileByPath(vaultPath);

		if (!existing) {
			const content = buildFullPlaceholder(externalFile, bridge, this.settings.defaultTags);
			await this.app.vault.create(vaultPath, content);
			return "created";
		}

		// File exists — check if external file has actually changed since last write
		const existingFile = existing as TFile;
		const existingContent = await this.app.vault.read(existingFile);

		// Extract stored mtime from frontmatter to avoid unnecessary rewrites
		const storedMtimeMatch = existingContent.match(/external-mtime-ms:\s*(\d+)/);
		const storedMtime = storedMtimeMatch ? parseInt(storedMtimeMatch[1]) : 0;
		const stat = getFileStat(externalFile);

		if (stat && stat.mtimeMs <= storedMtime) return "skipped";

		const merged = mergeUpdatedContent(existingContent, externalFile, bridge, this.settings.defaultTags);
		await this.app.vault.modify(existingFile, merged);
		return "updated";
	}

	// ─── Sync ─────────────────────────────────────────────────────────────────

	async syncBridge(bridge: BridgedFolder): Promise<{ created: number; updated: number; skipped: number; removed: number }> {
		const targetVaultFolder = normalizePath(bridge.vaultFolder);

		if (!this.app.vault.getAbstractFileByPath(targetVaultFolder)) {
			await this.app.vault.createFolder(targetVaultFolder);
		}

		const externalFiles = getFilesRecursive(bridge.externalPath, bridge.includedExtensions, bridge.recursive);

		let created = 0, updated = 0, skipped = 0, removed = 0;
		const expectedPaths = new Set<string>();

		for (const externalFile of externalFiles) {
			const vaultPath = this.externalPathToVaultPath(bridge, externalFile);
			if (!vaultPath) continue;
			expectedPaths.add(vaultPath);

			const result = await this.upsertPlaceholder(bridge, externalFile, vaultPath);
			if (result === "created") created++;
			else if (result === "updated") updated++;
			else skipped++;
		}

		// Remove stale placeholders
		const folder = this.app.vault.getAbstractFileByPath(targetVaultFolder);
		if (folder instanceof TFolder) {
			const allFiles = this.getAllMarkdownFiles(folder);
			for (const file of allFiles) {
				if (!expectedPaths.has(file.path)) {
					const bridgeId = await this.getBridgeIdFromFile(file.path);
					if (bridgeId === bridge.id) {
						await this.app.vault.delete(file);
						removed++;
					}
				}
			}
		}

		bridge.lastSynced = new Date().toISOString();
		await this.saveSettings();

		return { created, updated, skipped, removed };
	}

	async syncAllBridges() {
		if (this.settings.bridges.length === 0) {
			new Notice("No bridges configured. Open Bridge Manager to add one.");
			return;
		}

		new Notice("Syncing all bridges…");
		let tc = 0, tu = 0, tr = 0;

		for (const bridge of this.settings.bridges) {
			try {
				const r = await this.syncBridge(bridge);
				tc += r.created; tu += r.updated; tr += r.removed;
			} catch (e) {
				new Notice(`Error syncing "${bridge.label}": ${(e as Error).message}`);
			}
		}

		new Notice(`Sync complete — ${tc} created, ${tu} updated, ${tr} removed.`);
	}

	getAllMarkdownFiles(folder: TFolder): TFile[] {
		const results: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) results.push(...this.getAllMarkdownFiles(child));
			else if (child instanceof TFile) results.push(child);
		}
		return results;
	}

	async getBridgeIdFromFile(vaultPath: string): Promise<string | null> {
		try {
			const file = this.app.vault.getAbstractFileByPath(vaultPath) as TFile;
			if (!file) return null;
			const content = await this.app.vault.read(file);
			const match = content.match(/bridge-id:\s*"([^"]+)"/);
			return match ? match[1] : null;
		} catch { return null; }
	}
}

// ─── Bridge Manager Modal ─────────────────────────────────────────────────────

class BridgeManagerModal extends Modal {
	plugin: ExternalBridgePlugin;

	constructor(app: App, plugin: ExternalBridgePlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() { this.render(); }

	render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("external-bridge-modal");

		contentEl.createEl("h2", { text: "External Bridge" });
		contentEl.createEl("p", {
			text: "Link external folders to your vault with lightweight placeholder notes.",
			cls: "bridge-subtitle",
		});

		if (this.plugin.settings.bridges.length === 0) {
			contentEl.createEl("p", { text: "No bridges yet. Add one below.", cls: "bridge-empty" });
		} else {
			const list = contentEl.createDiv("bridge-list");
			for (const bridge of this.plugin.settings.bridges) {
				this.renderBridgeCard(list, bridge);
			}
		}

		const btnRow = contentEl.createDiv("bridge-btn-row");
		const addBtn = btnRow.createEl("button", { text: "+ Add Bridge", cls: "mod-cta" });
		addBtn.onclick = () => new AddBridgeModal(this.app, this.plugin, () => this.render()).open();

		const syncAllBtn = btnRow.createEl("button", { text: "↻ Sync All" });
		syncAllBtn.onclick = async () => { this.close(); await this.plugin.syncAllBridges(); };
	}

	renderBridgeCard(container: HTMLElement, bridge: BridgedFolder) {
		const card = container.createDiv("bridge-card");

		const header = card.createDiv("bridge-card-header");
		const titleRow = header.createDiv("bridge-card-title-row");
		titleRow.createEl("strong", { text: bridge.label });

		// Watcher status indicator
		const watcherActive = this.plugin["watchers"].has(bridge.id);
		const watchDot = titleRow.createEl("span", {
			cls: `bridge-watch-dot ${watcherActive ? "active" : "inactive"}`,
			title: watcherActive ? "File watcher active" : "File watcher off",
		});

		const badges = header.createDiv("bridge-badges");
		bridge.includedExtensions.forEach((ext) => {
			badges.createEl("span", { text: ext.toUpperCase(), cls: "bridge-badge" });
		});

		card.createEl("div", { text: `External: ${bridge.externalPath}`, cls: "bridge-path" });
		card.createEl("div", { text: `Vault folder: ${bridge.vaultFolder}`, cls: "bridge-path" });
		card.createEl("div", {
			text: `Last synced: ${bridge.lastSynced ? new Date(bridge.lastSynced).toLocaleString() : "Never"}`,
			cls: "bridge-meta",
		});

		const actions = card.createDiv("bridge-actions");

		const syncBtn = actions.createEl("button", { text: "↻ Sync" });
		syncBtn.onclick = async () => {
			syncBtn.disabled = true;
			syncBtn.setText("Syncing…");
			try {
				const result = await this.plugin.syncBridge(bridge);
				new Notice(`"${bridge.label}": ${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.removed} removed.`);
				this.render();
			} catch (e) {
				new Notice(`Sync failed: ${(e as Error).message}`);
				syncBtn.disabled = false;
				syncBtn.setText("↻ Sync");
			}
		};

		// Watch toggle button
		const watchBtn = actions.createEl("button", {
			text: watcherActive ? "⏸ Stop Watch" : "👁 Watch",
			cls: watcherActive ? "mod-active" : "",
		});
		watchBtn.onclick = async () => {
			if (this.plugin["watchers"].has(bridge.id)) {
				this.plugin.stopWatcher(bridge.id);
				bridge.watchEnabled = false;
			} else {
				this.plugin.startWatcher(bridge);
				bridge.watchEnabled = true;
				new Notice(`Watching "${bridge.label}" for changes…`);
			}
			await this.plugin.saveSettings();
			this.render();
		};

		const removeBtn = actions.createEl("button", { text: "Remove", cls: "mod-warning" });
		removeBtn.onclick = async () => {
			this.plugin.stopWatcher(bridge.id);
			this.plugin.settings.bridges = this.plugin.settings.bridges.filter((b) => b.id !== bridge.id);
			await this.plugin.saveSettings();
			new Notice(`Bridge "${bridge.label}" removed. Placeholder files remain in your vault.`);
			this.render();
		};
	}

	onClose() { this.contentEl.empty(); }
}

// ─── Add Bridge Modal ─────────────────────────────────────────────────────────

class AddBridgeModal extends Modal {
	plugin: ExternalBridgePlugin;
	onSave: () => void;

	label = "";
	externalPath = "";
	vaultFolder = "_ExternalBridge";
	selectedExtensions: Set<string> = new Set(["pdf"]);
	recursive = true;
	watchEnabled = false;

	constructor(app: App, plugin: ExternalBridgePlugin, onSave: () => void) {
		super(app);
		this.plugin = plugin;
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Add External Bridge" });

		new Setting(contentEl)
			.setName("Label")
			.setDesc("A name for this bridge (e.g. Handwritten Notes)")
			.addText((t) => t.setPlaceholder("My PDF Notes").onChange((v) => (this.label = v)));

		new Setting(contentEl)
			.setName("External folder path")
			.setDesc("Absolute path to the folder on your disk")
			.addText((t) => t.setPlaceholder("/path/to/folder").onChange((v) => (this.externalPath = v)));

		new Setting(contentEl)
			.setName("Vault folder")
			.setDesc("Where to create placeholder files inside your vault")
			.addText((t) => t.setValue(this.vaultFolder).onChange((v) => (this.vaultFolder = v)));

		new Setting(contentEl).setName("File types").setDesc("Which file types to create placeholders for");

		const extGrid = contentEl.createDiv("ext-grid");
		for (const ext of SUPPORTED_EXTENSIONS) {
			const lbl = extGrid.createEl("label", { cls: "ext-checkbox" });
			const cb  = lbl.createEl("input", { type: "checkbox" }) as HTMLInputElement;
			cb.checked = this.selectedExtensions.has(ext);
			cb.onchange = () => { if (cb.checked) this.selectedExtensions.add(ext); else this.selectedExtensions.delete(ext); };
			lbl.createSpan({ text: ext.toUpperCase() });
		}

		new Setting(contentEl)
			.setName("Include subfolders")
			.setDesc("Recursively include files in subfolders")
			.addToggle((t) => t.setValue(this.recursive).onChange((v) => (this.recursive = v)));

		new Setting(contentEl)
			.setName("Enable file watcher")
			.setDesc("Automatically update placeholders when external files are added, changed, or deleted")
			.addToggle((t) => t.setValue(this.watchEnabled).onChange((v) => (this.watchEnabled = v)));

		const btnRow = contentEl.createDiv("bridge-btn-row");
		const saveBtn = btnRow.createEl("button", { text: "Add Bridge", cls: "mod-cta" });
		saveBtn.onclick = async () => {
			if (!this.label || !this.externalPath) {
				new Notice("Please fill in Label and External folder path.");
				return;
			}
			if (!fs.existsSync(this.externalPath)) {
				new Notice("External folder path does not exist.");
				return;
			}

			const bridge: BridgedFolder = {
				id: generateId(),
				label: this.label,
				externalPath: this.externalPath,
				vaultFolder: normalizePath(`${this.vaultFolder}/${this.label}`),
				includedExtensions: [...this.selectedExtensions],
				recursive: this.recursive,
				lastSynced: null,
				watchEnabled: this.watchEnabled,
			};

			this.plugin.settings.bridges.push(bridge);
			await this.plugin.saveSettings();

			if (this.watchEnabled) {
				this.plugin.startWatcher(bridge);
			}

			this.close();
			this.onSave();
			new Notice(`Bridge "${this.label}" added! Run Sync to create placeholders.`);
		};

		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.onclick = () => this.close();
	}

	onClose() { this.contentEl.empty(); }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class ExternalBridgeSettingTab extends PluginSettingTab {
	plugin: ExternalBridgePlugin;

	constructor(app: App, plugin: ExternalBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "External Bridge Settings" });

		new Setting(containerEl)
			.setName("Default tags")
			.setDesc("Comma-separated tags added to all placeholder files (e.g. source/external, review)")
			.addText((t) =>
				t.setValue(this.plugin.settings.defaultTags.join(", "))
				 .onChange(async (v) => {
					this.plugin.settings.defaultTags = v.split(",").map((x) => x.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				 })
			);

		new Setting(containerEl)
			.setName("File watcher debounce (ms)")
			.setDesc("How long to wait after a file change before updating the placeholder (default: 2000)")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.watchDebounceMs))
				 .onChange(async (v) => {
					const n = parseInt(v);
					if (!isNaN(n) && n >= 500) {
						this.plugin.settings.watchDebounceMs = n;
						await this.plugin.saveSettings();
					}
				 })
			);

		new Setting(containerEl)
			.setName("Open Bridge Manager on startup")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.openOnSync).onChange(async (v) => {
					this.plugin.settings.openOnSync = v;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "Active Bridges" });
		if (this.plugin.settings.bridges.length === 0) {
			containerEl.createEl("p", { text: "No bridges configured yet." });
		} else {
			for (const bridge of this.plugin.settings.bridges) {
				new Setting(containerEl)
					.setName(bridge.label)
					.setDesc(`${bridge.externalPath} → ${bridge.vaultFolder}  |  Watch: ${bridge.watchEnabled ? "on" : "off"}`)
					.addButton((btn) =>
						btn.setButtonText("Remove").setWarning().onClick(async () => {
							this.plugin.stopWatcher(bridge.id);
							this.plugin.settings.bridges = this.plugin.settings.bridges.filter((b) => b.id !== bridge.id);
							await this.plugin.saveSettings();
							this.display();
						})
					);
			}
		}
	}
}
