const { Notice, Plugin, Modal } = require("obsidian");
const { loadSettings, ManagerSettings } = require("./settings");
const { editWithAI } = require("./notes");
const {
    WORKSPACE_VIEW_TYPE, WORKSPACE_VIEW_TITLE, WORKSPACE_VIEW_ICON, ManagerWorkspaceView,
} = require("./workspace");

module.exports = class AgentsManager extends Plugin {
    async onload() {
        this.settings = loadSettings(this.app, await this.loadData(), this.manifest?.dir);
        this.modals = new Set();
        this.registerView(WORKSPACE_VIEW_TYPE, leaf => new ManagerWorkspaceView(leaf, this));
        this.addRibbonIcon(WORKSPACE_VIEW_ICON, WORKSPACE_VIEW_TITLE, () => this.run(() => this.openWorkspace()));
        this.addSettingTab(new ManagerSettings(this));
        this.addCommand({
            id: "summarize-note", name: "AI 总结笔记",
            callback: () => this.run(() => editWithAI(this, "summary")),
        });
        this.addCommand({
            id: "translate-selection", name: "AI 翻译为中文",
            callback: () => this.run(() => editWithAI(this, "translation")),
        });
        this.addCommand({
            id: "sync-instructions", name: "分发与回收指令",
            callback: () => this.run(() => this.openWorkspace("instructions")),
        });
        this.addCommand({
            id: "manage-skills", name: "管理技能",
            callback: () => this.run(() => this.openWorkspace("skills")),
        });
    }

    async openWorkspace(section) {
        const existing = this.app.workspace.getLeavesOfType(WORKSPACE_VIEW_TYPE)[0];
        const leaf = existing || this.app.workspace.getLeaf("tab");
        if (!existing || section !== undefined) {
            section ??= "instructions";
            if (leaf.view instanceof ManagerWorkspaceView) {
                await leaf.view.setSection(section);
            } else {
                this._pendingSection = section;
                try {
                    await leaf.setViewState({ type: WORKSPACE_VIEW_TYPE, active: true, state: { section } });
                } finally {
                    this._pendingSection = null;
                }
            }
        }
        await this.app.workspace.revealLeaf(leaf);
        return leaf;
    }

    async run(action) {
        try { await action(); }
        catch (error) { new Notice(error.message || "操作未完成。"); }
    }

    updateSettings(buildNext) {
        const run = (this._settingsQueue || Promise.resolve()).then(async () => {
            const next = await buildNext({ ...(this.settings || {}) });
            if (!next) return this.settings;
            await this.saveData(next);
            this.settings = next;
            return next;
        });
        this._settingsQueue = run.catch(() => {});
        return run;
    }

    openDialog(title, onClose) {
        const modal = new Modal(this.app);
        modal.setTitle(title);
        modal.onClose = () => {
            this.modals.delete(modal);
            onClose?.();
        };
        this.modals.add(modal);
        modal.open();
        return modal;
    }

    onunload() {
        for (const modal of [...this.modals].reverse()) modal.close();
    }
};
