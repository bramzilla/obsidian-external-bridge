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
	customProperties: Record<string, string>; // key → value, injected into every placeholder
}

interface SyncLogEntry {
	timestamp: string;       // ISO string
	bridgeId: string;
	bridgeLabel: string;
	created: string[];       // file names
	updated: string[];
	removed: string[];
	skipped: number;         // count only, not stored per-file
}

interface ExternalBridgeSettings {
	bridges: BridgedFolder[];
	defaultTags: string[];
	openOnSync: boolean;
	watchDebounceMs: number;
	autoSyncOnStartup: boolean;
	syncLog: SyncLogEntry[];   // capped at MAX_LOG_ENTRIES
}

const MAX_LOG_ENTRIES = 50;

// Health status for a bridge path
type BridgeHealth = "ok" | "unreachable" | "unknown";

function checkBridgeHealth(bridge: BridgedFolder): BridgeHealth {
	try {
		if (!fs.existsSync(bridge.externalPath)) return "unreachable";
		const stat = fs.statSync(bridge.externalPath);
		return stat.isDirectory() ? "ok" : "unreachable";
	} catch {
		return "unreachable";
	}
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
	autoSyncOnStartup: false,
	syncLog: [],
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
${Object.entries(bridge.customProperties ?? {}).map(([k, v]) => `${k}: "${v}"`).join("\n")}
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

		// Start watchers and run health checks on layout ready
		this.app.workspace.onLayoutReady(async () => {
			// Health check — warn about unreachable bridges
			const unreachable = this.settings.bridges.filter(
				(b) => checkBridgeHealth(b) === "unreachable"
			);
			if (unreachable.length > 0) {
				const names = unreachable.map((b) => `"${b.label}"`).join(", ");
				new Notice(
					`External Bridge: ${unreachable.length} bridge${unreachable.length > 1 ? "s" : ""} unreachable — ${names}. Check that the external folder is accessible.`,
					8000
				);
			}

			// Auto-sync
			if (this.settings.autoSyncOnStartup && this.settings.bridges.length > 0) {
				const reachable = this.settings.bridges.filter(
					(b) => checkBridgeHealth(b) === "ok"
				);
				if (reachable.length > 0) {
					new Notice("External Bridge: auto-syncing on startup…");
					for (const bridge of reachable) {
						try { await this.syncBridge(bridge); } catch { /* skip unreachable */ }
					}
					new Notice("External Bridge: startup sync complete.");
				}
			}

			// Start watchers for any bridge that has watching enabled
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
		// Back-fill fields for bridges that pre-date them
		for (const b of this.settings.bridges) {
			if (b.watchEnabled === undefined) b.watchEnabled = false;
			if (b.customProperties === undefined) b.customProperties = {};
		}
		if (!this.settings.syncLog) this.settings.syncLog = [];
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

		let skipped = 0;
		const createdFiles: string[] = [];
		const updatedFiles: string[] = [];
		const removedFiles: string[] = [];
		const expectedPaths = new Set<string>();

		for (const externalFile of externalFiles) {
			const vaultPath = this.externalPathToVaultPath(bridge, externalFile);
			if (!vaultPath) continue;
			expectedPaths.add(vaultPath);

			const result = await this.upsertPlaceholder(bridge, externalFile, vaultPath);
			const name = path.basename(externalFile);
			if (result === "created") createdFiles.push(name);
			else if (result === "updated") updatedFiles.push(name);
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
						removedFiles.push(path.basename(file.path));
						await this.app.vault.delete(file);
					}
				}
			}
		}

		// Write log entry (only if something actually happened)
		if (createdFiles.length > 0 || updatedFiles.length > 0 || removedFiles.length > 0) {
			const entry: SyncLogEntry = {
				timestamp: new Date().toISOString(),
				bridgeId: bridge.id,
				bridgeLabel: bridge.label,
				created: createdFiles,
				updated: updatedFiles,
				removed: removedFiles,
				skipped,
			};
			this.settings.syncLog.unshift(entry); // newest first
			if (this.settings.syncLog.length > MAX_LOG_ENTRIES) {
				this.settings.syncLog = this.settings.syncLog.slice(0, MAX_LOG_ENTRIES);
			}
		}

		bridge.lastSynced = new Date().toISOString();
		await this.saveSettings();

		const created = createdFiles.length;
		const updated = updatedFiles.length;
		const removed = removedFiles.length;
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

		// Health indicator
		const health = checkBridgeHealth(bridge);
		titleRow.createEl("span", {
			cls: `bridge-health-dot ${health}`,
			title: health === "ok"
				? "External folder is accessible"
				: "⚠ External folder is unreachable — check the path or mount the drive",
		});

		// Watcher status indicator
		const watcherActive = this.plugin["watchers"].has(bridge.id);
		titleRow.createEl("span", {
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
		if (health === "unreachable") {
			syncBtn.disabled = true;
			syncBtn.title = "Cannot sync — external folder is unreachable";
		}
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

		const logBtn = actions.createEl("button", { text: "📋 Log" });
		logBtn.onclick = () => new SyncLogModal(this.app, this.plugin, bridge).open();

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
	customPropertiesRaw = ""; // raw textarea value, "key: value" per line

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
			.setName("Custom properties")
			.setDesc("Extra frontmatter fields added to every placeholder in this bridge. One per line, format: key: value");
		const customPropArea = contentEl.createEl("textarea", {
			cls: "bridge-custom-props-textarea",
			attr: { placeholder: "subject: music\nstatus: unreviewed\nnotebook: LittleBlackie" },
		}) as HTMLTextAreaElement;
		customPropArea.value = this.customPropertiesRaw;
		customPropArea.oninput = () => { this.customPropertiesRaw = customPropArea.value; };

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

			const customProperties: Record<string, string> = {};
			for (const line of this.customPropertiesRaw.split("\n")) {
				const idx = line.indexOf(":");
				if (idx === -1) continue;
				const k = line.slice(0, idx).trim();
				const v = line.slice(idx + 1).trim();
				if (k) customProperties[k] = v;
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
				customProperties,
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


// ─── Sync Log Modal ───────────────────────────────────────────────────────────

class SyncLogModal extends Modal {
	plugin: ExternalBridgePlugin;
	bridge: BridgedFolder;

	constructor(app: App, plugin: ExternalBridgePlugin, bridge: BridgedFolder) {
		super(app);
		this.plugin = plugin;
		this.bridge = bridge;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("external-bridge-modal", "sync-log-modal");

		contentEl.createEl("h2", { text: `📋 Sync Log — ${this.bridge.label}` });

		const entries = this.plugin.settings.syncLog.filter(
			(e) => e.bridgeId === this.bridge.id
		);

		if (entries.length === 0) {
			contentEl.createEl("p", {
				text: "No sync history yet. Run a sync to start logging.",
				cls: "bridge-empty",
			});
			return;
		}

		const list = contentEl.createDiv("sync-log-list");

		for (const entry of entries) {
			const row = list.createDiv("sync-log-row");

			// ── Summary line (always visible, acts as toggle) ──────────────
			const summary = row.createDiv("sync-log-summary");
			const dt = new Date(entry.timestamp);
			const dateStr = dt.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
			const timeStr = dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

			summary.createEl("span", { text: `↻ ${dateStr}, ${timeStr}`, cls: "sync-log-date" });

			const badges = summary.createDiv("sync-log-badges");
			if (entry.created.length > 0)
				badges.createEl("span", { text: `+${entry.created.length}`, cls: "sync-log-badge created" });
			if (entry.updated.length > 0)
				badges.createEl("span", { text: `~${entry.updated.length}`, cls: "sync-log-badge updated" });
			if (entry.removed.length > 0)
				badges.createEl("span", { text: `−${entry.removed.length}`, cls: "sync-log-badge removed" });
			if (entry.skipped > 0)
				badges.createEl("span", { text: `⊘${entry.skipped}`, cls: "sync-log-badge skipped" });

			// ── Detail section (collapsed by default) ─────────────────────
			const detail = row.createDiv("sync-log-detail");
			detail.style.display = "none";

			const renderGroup = (label: string, files: string[], cls: string) => {
				if (files.length === 0) return;
				const group = detail.createDiv(`sync-log-group ${cls}`);
				group.createEl("div", { text: label, cls: "sync-log-group-label" });
				for (const f of files) {
					group.createEl("div", { text: f, cls: "sync-log-file" });
				}
			};

			renderGroup("Created", entry.created, "created");
			renderGroup("Updated", entry.updated, "updated");
			renderGroup("Removed", entry.removed, "removed");

			// Toggle on click
			let expanded = false;
			summary.style.cursor = "pointer";
			summary.onclick = () => {
				expanded = !expanded;
				detail.style.display = expanded ? "block" : "none";
				row.toggleClass("expanded", expanded);
			};
		}

		// Clear log button
		const footer = contentEl.createDiv("bridge-btn-row");
		const clearBtn = footer.createEl("button", { text: "Clear log for this bridge", cls: "mod-warning" });
		clearBtn.onclick = async () => {
			this.plugin.settings.syncLog = this.plugin.settings.syncLog.filter(
				(e) => e.bridgeId !== this.bridge.id
			);
			await this.plugin.saveSettings();
			this.onOpen();
		};
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
			.setName("Auto-sync on startup")
			.setDesc("Automatically sync all reachable bridges when Obsidian opens")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoSyncOnStartup).onChange(async (v) => {
					this.plugin.settings.autoSyncOnStartup = v;
					await this.plugin.saveSettings();
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
					.setDesc(`${bridge.externalPath} → ${bridge.vaultFolder}  |  Watch: ${bridge.watchEnabled ? "on" : "off"}  |  Health: ${checkBridgeHealth(bridge) === "ok" ? "✓ reachable" : "⚠ unreachable"}`)
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
