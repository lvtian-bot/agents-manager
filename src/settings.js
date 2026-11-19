const { PluginSettingTab, Setting, Notice } = require("obsidian");
const path = require("path");
const fs = require("fs");

const legacySources = {
    userSource: "8-永久笔记/人工智能/37-用户指令.md",
    workSource: "8-永久笔记/人工智能/37.1-Work项目指令模板.md",
    codeSource: "8-永久笔记/人工智能/37.2-Code项目指令模板.md",
};
const legacyTemplates = {
    新闻报道: "docs/prompts/文献总结-新闻简讯.md",
    观点视角: "docs/prompts/文献总结-观点视角.md",
    知识教程: "docs/prompts/文献总结-知识教程.md",
};

function defaults(app) {
    const adapter = app.vault?.adapter;
    const root = adapter?.getBasePath?.() || adapter?.basePath;
    const existing = root && fs.existsSync(path.join(root, app.vault.configDir || ".obsidian", "nascence-sync"));
    const templates = root && fs.existsSync(path.join(root, legacyTemplates.观点视角));
    return {
        endpoint: "https://api.siliconflow.cn/v1/chat/completions",
        model: "deepseek-ai/DeepSeek-V4-Flash", credentialVariable: "SILICONFLOW_API_KEY",
        languageRule: "中文译成英文，其他语言译成中文。",
        typeProperty: "content_type", templates: templates ? legacyTemplates : {},
        defaultTemplate: templates ? legacyTemplates.观点视角 : "",
        userSource: "", workSource: "", codeSource: "",
        ...(existing ? legacySources : {}),
        targets: existing ? {
            Codex: "~/.codex/AGENTS.md", Claude: "~/.claude/CLAUDE.md", ZCode: "~/.zcode/AGENTS.md",
            "DeepSeek Harness": "~/.dsh/AGENTS.md", Antigravity: "~/.gemini/GEMINI.md",
            WorkBuddy: "~/.workbuddy/rules/AGENTS.md",
        } : {},
    };
}

function vaultPath(value) {
    if (!value) return "";
    if (typeof value !== "string" || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes("..")) {
        throw new Error("请使用库内相对路径。");
    }
    return value.replace(/\\/g, "/");
}

function validate(settings) {
    const url = new URL(settings.endpoint);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
        throw new Error("模型接口须使用 HTTPS 或本机地址。");
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("请单独配置请求凭据。");
    if (!settings.model.trim() || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.credentialVariable)) throw new Error("请检查模型和凭据环境变量名。");
    for (const key of ["defaultTemplate", "userSource", "workSource", "codeSource"]) settings[key] = vaultPath(settings[key]);
    for (const key of ["templates", "targets"]) {
        const map = settings[key];
        if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("映射须为名称与路径组成的 JSON 对象。");
        for (const [name, value] of Object.entries(map)) {
            if (!name.trim() || typeof value !== "string" || !value.trim()) throw new Error("请填写名称和路径。");
            if (key === "templates") map[name] = vaultPath(value);
            else if (!path.isAbsolute(value) && !value.startsWith("~/")) throw new Error("目标文件须使用绝对路径或 ~/ 路径。");
        }
    }
    return settings;
}

class ManagerSettings extends PluginSettingTab {
    constructor(plugin) {
        super(plugin.app, plugin);
        this.owner = plugin;
    }
    display() {
        const container = this.containerEl;
        container.empty();
        const draft = { ...this.owner.settings };
        for (const [key, name, desc] of [
            ["userSource", "用户指令源笔记", "库内相对路径。"],
            ["targets", "用户指令目标", '填写名称和本机路径，例如 {"Codex":"~/.codex/AGENTS.md"}。'],
            ["workSource", "Work 项目模板", "同步前两个一级标题之间的区块。"],
            ["codeSource", "Code 项目模板", "库内相对路径。各项目的目标在同步面板中登记。"],
            ["endpoint", "模型接口", "兼容 Chat Completions 的完整请求地址。"],
            ["model", "模型名称", ""], ["credentialVariable", "凭据环境变量名", "只填写变量名。"],
            ["languageRule", "翻译方向", ""], ["typeProperty", "笔记类型属性", ""],
            ["templates", "类型与总结模板", '填写类型与库内模板路径组成的 JSON 对象。'],
            ["defaultTemplate", "默认总结模板", "留空使用内置提示词。模板可以用 {activeNote} 引用笔记。"],
        ]) {
            const item = new Setting(container).setName(name).setDesc(desc);
            if (key === "templates" || key === "targets") {
                draft[key] = JSON.stringify(draft[key], null, 2);
                item.addTextArea(field => field.setValue(draft[key]).onChange(value => { draft[key] = value; }));
            } else {
                item.addText(field => field.setValue(draft[key]).onChange(value => { draft[key] = value.trim(); }));
            }
        }
        new Setting(container).addButton(button => button.setButtonText("保存设置").setCta().onClick(async () => {
            try {
                const updated = validate({ ...draft, templates: JSON.parse(draft.templates), targets: JSON.parse(draft.targets) });
                await this.owner.saveData(updated);
                this.owner.settings = updated;
                new Notice("设置已保存。");
            } catch (error) {
                new Notice(error instanceof SyntaxError ? "映射格式有误，请检查 JSON。" : error.message);
            }
        }));
    }
}
module.exports = { defaults, ManagerSettings, validate };
