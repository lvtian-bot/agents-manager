const { Notice, Plugin, Modal } = require("obsidian");
const { loadSettings, ManagerSettings } = require("./settings");
const { editWithAI } = require("./notes");

module.exports = class AgentsManager extends Plugin {
    async onload() {
        this.settings = loadSettings(this.app, await this.loadData());
        this.modals = new Set();
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
            callback: () => this.run(async () => {
                if (this.syncOpen) return;
                this.syncOpen = true;
                try { await require("./instructions/panel").openInstructions(this); }
                finally { this.syncOpen = false; }
            }),
        });
    }

    async run(action) {
        try { await action(); }
        catch (error) { new Notice(error.message || "操作未完成。"); }
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
