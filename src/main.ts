import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFolder,
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
}

interface ExternalBridgeSettings {
	bridges: BridgedFolder[];
	defaultTags: string[];
	openOnSync: boolean;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: ExternalBridgeSettings = {
	bridges: [],
	defaultTags: [],
	openOnSync: false,
};

const SUPPORTED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "gif", "mp3", "mp4", "mov", "docx", "xlsx", "txt", "md"];

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

function getFileStat(filePath: string): { size: number; mtime: string } | null {
	try {
		const stat = fs.statSync(filePath);
		return {
			size: stat.size,
			mtime: stat.mtime.toISOString().split("T")[0],
		};
	} catch {
		return null;
	}
}

function buildPlaceholderContent(
	filePath: string,
	vaultRelativePath: string,
	bridge: BridgedFolder,
	defaultTags: string[]
): string {
	const fileName = path.basename(filePath);
	const ext = path.extname(fileName).slice(1).toLowerCase();
	const stat = getFileStat(filePath);
	const allTags = [...defaultTags, ext, "external-bridge"].map((t) => `  - ${t}`).join("\n");

	const obsidianUri = `obsidian://open?path=${encodeURIComponent(filePath)}`;

	let viewBlock = "";
	if (["pdf"].includes(ext)) {
		viewBlock = `\n## Preview\n\n> [!info] External File\n> This file lives outside your vault and is not synced.\n> [Open in system viewer](${obsidianUri})\n\n\`\`\`dataview\n\`\`\`\n`;
	} else if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
		viewBlock = `\n## Preview\n\n![${fileName}](${filePath})\n`;
	} else {
		viewBlock = `\n## File\n\n> [!info] External File — not synced\n> [Open in system viewer](${obsidianUri})\n`;
	}

	return `---
external-path: "${filePath.replace(/\\/g, "/")}"
external-file: "${fileName}"
external-type: "${ext}"
external-size: "${stat ? formatFileSize(stat.size) : "unknown"}"
external-modified: "${stat ? stat.mtime : "unknown"}"
bridge-id: "${bridge.id}"
bridge-label: "${bridge.label}"
tags:
${allTags}
---

# ${fileName}

| Property | Value |
|---|---|
| **File** | \`${fileName}\` |
| **Type** | ${ext.toUpperCase()} |
| **Size** | ${stat ? formatFileSize(stat.size) : "unknown"} |
| **Modified** | ${stat ? stat.mtime : "unknown"} |
| **Source** | \`${filePath}\` |

[→ Open in system viewer](${obsidianUri})
${viewBlock}
---
*Managed by External Bridge plugin. Do not remove frontmatter.*
`;
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class ExternalBridgePlugin extends Plugin {
	settings: ExternalBridgeSettings;

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

		console.log("External Bridge plugin loaded.");
	}

	onunload() {
		console.log("External Bridge plugin unloaded.");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getVaultBasePath(): string {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		return "";
	}

	async syncBridge(bridge: BridgedFolder): Promise<{ created: number; updated: number; removed: number }> {
		const vaultBase = this.getVaultBasePath();
		const targetVaultFolder = normalizePath(bridge.vaultFolder);

		// Ensure vault folder exists
		if (!this.app.vault.getAbstractFileByPath(targetVaultFolder)) {
			await this.app.vault.createFolder(targetVaultFolder);
		}

		const externalFiles = getFilesRecursive(bridge.externalPath, bridge.includedExtensions, bridge.recursive);

		let created = 0;
		let updated = 0;
		let removed = 0;

		// Build map of expected placeholder paths
		const expectedPaths = new Set<string>();

		for (const externalFile of externalFiles) {
			const relativeToBridge = path.relative(bridge.externalPath, externalFile);
			const placeholderRelative = relativeToBridge.replace(/\.[^.]+$/, ".md");
			const vaultPath = normalizePath(path.join(targetVaultFolder, placeholderRelative));
			expectedPaths.add(vaultPath);

			const content = buildPlaceholderContent(
				externalFile,
				vaultPath,
				bridge,
				this.settings.defaultTags
			);

			const existing = this.app.vault.getAbstractFileByPath(vaultPath);
			if (existing) {
				// Update if external file changed
				const stat = getFileStat(externalFile);
				if (stat) {
					await this.app.vault.modify(existing as any, content);
					updated++;
				}
			} else {
				// Create subfolder if needed
				const parentDir = vaultPath.substring(0, vaultPath.lastIndexOf("/"));
				if (parentDir && !this.app.vault.getAbstractFileByPath(parentDir)) {
					await this.app.vault.createFolder(parentDir);
				}
				await this.app.vault.create(vaultPath, content);
				created++;
			}
		}

		// Remove stale placeholders (files that no longer exist externally)
		const folder = this.app.vault.getAbstractFileByPath(targetVaultFolder);
		if (folder instanceof TFolder) {
			const allPlaceholders = this.getAllMarkdownFiles(folder);
			for (const file of allPlaceholders) {
				if (!expectedPaths.has(file.path)) {
					const bridgeId = await this.getBridgeIdFromFile(file.path);
					if (bridgeId === bridge.id) {
						await this.app.vault.delete(file);
						removed++;
					}
				}
			}
		}

		// Update last synced
		bridge.lastSynced = new Date().toISOString();
		await this.saveSettings();

		return { created, updated, removed };
	}

	getAllMarkdownFiles(folder: TFolder): any[] {
		const results: any[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				results.push(...this.getAllMarkdownFiles(child));
			} else {
				results.push(child);
			}
		}
		return results;
	}

	async getBridgeIdFromFile(vaultPath: string): Promise<string | null> {
		try {
			const file = this.app.vault.getAbstractFileByPath(vaultPath) as any;
			if (!file) return null;
			const content = await this.app.vault.read(file);
			const match = content.match(/bridge-id:\s*"([^"]+)"/);
			return match ? match[1] : null;
		} catch {
			return null;
		}
	}

	async syncAllBridges() {
		if (this.settings.bridges.length === 0) {
			new Notice("No bridges configured. Open Bridge Manager to add one.");
			return;
		}

		new Notice("Syncing all bridges...");
		let totalCreated = 0;
		let totalUpdated = 0;
		let totalRemoved = 0;

		for (const bridge of this.settings.bridges) {
			try {
				const result = await this.syncBridge(bridge);
				totalCreated += result.created;
				totalUpdated += result.updated;
				totalRemoved += result.removed;
			} catch (e) {
				new Notice(`Error syncing bridge "${bridge.label}": ${e.message}`);
			}
		}

		new Notice(`Sync complete: ${totalCreated} created, ${totalUpdated} updated, ${totalRemoved} removed.`);
	}
}

// ─── Bridge Manager Modal ─────────────────────────────────────────────────────

class BridgeManagerModal extends Modal {
	plugin: ExternalBridgePlugin;

	constructor(app: App, plugin: ExternalBridgePlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.render();
	}

	render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("external-bridge-modal");

		contentEl.createEl("h2", { text: "External Bridge" });
		contentEl.createEl("p", {
			text: "Link external folders to your vault with lightweight placeholder notes.",
			cls: "bridge-subtitle",
		});

		// Bridge list
		if (this.plugin.settings.bridges.length === 0) {
			contentEl.createEl("p", {
				text: "No bridges yet. Add one below.",
				cls: "bridge-empty",
			});
		} else {
			const list = contentEl.createDiv("bridge-list");
			for (const bridge of this.plugin.settings.bridges) {
				this.renderBridgeCard(list, bridge);
			}
		}

		// Add bridge button
		const btnRow = contentEl.createDiv("bridge-btn-row");

		const addBtn = btnRow.createEl("button", { text: "+ Add Bridge", cls: "mod-cta" });
		addBtn.onclick = () => {
			new AddBridgeModal(this.app, this.plugin, () => this.render()).open();
		};

		const syncAllBtn = btnRow.createEl("button", { text: "↻ Sync All" });
		syncAllBtn.onclick = async () => {
			this.close();
			await this.plugin.syncAllBridges();
		};
	}

	renderBridgeCard(container: HTMLElement, bridge: BridgedFolder) {
		const card = container.createDiv("bridge-card");

		const header = card.createDiv("bridge-card-header");
		header.createEl("strong", { text: bridge.label });
		const badges = header.createDiv("bridge-badges");
		bridge.includedExtensions.forEach((ext) => {
			badges.createEl("span", { text: ext.toUpperCase(), cls: "bridge-badge" });
		});

		card.createEl("div", {
			text: `External: ${bridge.externalPath}`,
			cls: "bridge-path",
		});
		card.createEl("div", {
			text: `Vault folder: ${bridge.vaultFolder}`,
			cls: "bridge-path",
		});
		card.createEl("div", {
			text: `Last synced: ${bridge.lastSynced ? new Date(bridge.lastSynced).toLocaleString() : "Never"}`,
			cls: "bridge-meta",
		});

		const actions = card.createDiv("bridge-actions");

		const syncBtn = actions.createEl("button", { text: "↻ Sync" });
		syncBtn.onclick = async () => {
			syncBtn.disabled = true;
			syncBtn.setText("Syncing...");
			try {
				const result = await this.plugin.syncBridge(bridge);
				new Notice(`"${bridge.label}" synced: ${result.created} created, ${result.updated} updated, ${result.removed} removed.`);
				this.render();
			} catch (e) {
				new Notice(`Sync failed: ${e.message}`);
				syncBtn.disabled = false;
				syncBtn.setText("↻ Sync");
			}
		};

		const removeBtn = actions.createEl("button", { text: "Remove", cls: "mod-warning" });
		removeBtn.onclick = async () => {
			this.plugin.settings.bridges = this.plugin.settings.bridges.filter((b) => b.id !== bridge.id);
			await this.plugin.saveSettings();
			new Notice(`Bridge "${bridge.label}" removed. Placeholder files remain in your vault.`);
			this.render();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
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
			.addText((text) =>
				text.setPlaceholder("My PDF Notes").onChange((v) => (this.label = v))
			);

		new Setting(contentEl)
			.setName("External folder path")
			.setDesc("Absolute path to the folder on your disk (e.g. /Users/bram/Documents/Notes)")
			.addText((text) =>
				text.setPlaceholder("/path/to/folder").onChange((v) => (this.externalPath = v))
			);

		new Setting(contentEl)
			.setName("Vault folder")
			.setDesc("Where to create placeholder files inside your vault")
			.addText((text) =>
				text.setValue(this.vaultFolder).onChange((v) => (this.vaultFolder = v))
			);

		new Setting(contentEl).setName("File types").setDesc("Which file types to create placeholders for");

		const extGrid = contentEl.createDiv("ext-grid");
		for (const ext of SUPPORTED_EXTENSIONS) {
			const label = extGrid.createEl("label", { cls: "ext-checkbox" });
			const cb = label.createEl("input", { type: "checkbox" }) as HTMLInputElement;
			cb.checked = this.selectedExtensions.has(ext);
			cb.onchange = () => {
				if (cb.checked) this.selectedExtensions.add(ext);
				else this.selectedExtensions.delete(ext);
			};
			label.createSpan({ text: ext.toUpperCase() });
		}

		new Setting(contentEl)
			.setName("Include subfolders")
			.setDesc("Recursively include files in subfolders")
			.addToggle((toggle) =>
				toggle.setValue(this.recursive).onChange((v) => (this.recursive = v))
			);

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
				vaultFolder: normalizePath(this.vaultFolder + "/" + this.label),
				includedExtensions: [...this.selectedExtensions],
				recursive: this.recursive,
				lastSynced: null,
			};

			this.plugin.settings.bridges.push(bridge);
			await this.plugin.saveSettings();
			this.close();
			this.onSave();
			new Notice(`Bridge "${this.label}" added! Run Sync to create placeholder files.`);
		};

		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.onclick = () => this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
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
			.addText((text) =>
				text
					.setValue(this.plugin.settings.defaultTags.join(", "))
					.onChange(async (v) => {
						this.plugin.settings.defaultTags = v
							.split(",")
							.map((t) => t.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Open Bridge Manager on startup")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.openOnSync).onChange(async (v) => {
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
					.setDesc(`${bridge.externalPath} → ${bridge.vaultFolder}`)
					.addButton((btn) =>
						btn.setButtonText("Remove").setWarning().onClick(async () => {
							this.plugin.settings.bridges = this.plugin.settings.bridges.filter(
								(b) => b.id !== bridge.id
							);
							await this.plugin.saveSettings();
							this.display();
						})
					);
			}
		}
	}
}
