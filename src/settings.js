const { PluginSettingTab, Setting, Notice, FuzzySuggestModal } = require("obsidian");
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

function modelEndpoint(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error("请填写完整的模型接口地址。"); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
        throw new Error("模型接口须使用 HTTPS 或本机地址。");
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("请单独配置请求凭据。");
    return value;
}

class NotePicker extends FuzzySuggestModal {
    constructor(plugin, select) {
        super(plugin.app);
        this.plugin = plugin;
        this.select = select;
    }
    getItems() { return this.app.vault.getMarkdownFiles(); }
    getItemText(file) { return file.path; }
    onChooseItem(file) { this.select(file.path); }
    onClose() { super.onClose(); this.plugin.modals.delete(this); }
}

function disclosure(parent, title) {
    const group = parent.createEl("details");
    const summary = group.createEl("summary", { text: title });
    summary.style.cssText = "cursor:pointer;padding:0.65em 0;font-weight:var(--font-semibold)";
    return group;
}

function textInput(parent, label, value) {
    const input = parent.createEl("input", { type: "text", attr: { "aria-label": label } });
    input.defaultValue = value;
    input.placeholder = label;
    input.style.cssText = "flex:1 1 10em;min-width:0;max-width:100%";
    return input;
}

function noteButton(parent, plugin, input) {
    const button = parent.createEl("button", { text: "选择笔记", attr: { type: "button", "aria-label": `选择${input.getAttribute("aria-label")}` } });
    button.onclick = () => {
        const picker = new NotePicker(plugin, path => { input.value = path; });
        plugin.modals.add(picker);
        picker.open();
    };
}

function required(value) {
    if (!value.trim()) throw new Error("此项不能为空。");
    return value;
}

function targetPath(value) {
    if (!path.isAbsolute(value) && !value.startsWith("~/")) throw new Error("目标文件须使用绝对路径或 ~/ 路径。");
    return value;
}

class ManagerSettings extends PluginSettingTab {
    constructor(plugin) {
        super(plugin.app, plugin);
        this.owner = plugin;
    }
    display() {
        const container = this.containerEl;
        container.empty();
        const plugin = this.owner;
        const readers = new Map();
        let invalidInput;
        let errorEl;
        function clearError() {
            invalidInput?.removeAttribute("aria-invalid");
            errorEl?.remove();
            errorEl = invalidInput = null;
        }
        function read(input, row, parse) {
            try {
                const value = input.value === input.defaultValue ? input.value : input.value.trim();
                return parse ? parse(value) : value;
            } catch (error) {
                clearError();
                errorEl = row.createDiv({ text: error.message, attr: { role: "alert" } });
                errorEl.style.color = "var(--text-error)";
                invalidInput = input;
                input.setAttribute("aria-invalid", "true");
                const group = input.closest("details");
                if (group) group.open = true;
                input.focus();
                throw error;
            }
        }
        function field(parent, key, label, desc, parse) {
            const row = parent.createDiv();
            const item = new Setting(row).setName(label).setDesc(desc);
            const input = textInput(item.controlEl, label, plugin.settings[key]);
            if (parse === vaultPath) noteButton(item.controlEl, plugin, input);
            readers.set(key, () => read(input, row, parse));
        }
        function mapping(parent, key, title, nameLabel, pathLabel, addLabel, parse) {
            const action = new Setting(parent).setName(title);
            const list = parent.createDiv();
            const rows = new Map();
            function add(name, value) {
                const row = list.createDiv();
                const controls = row.createDiv();
                controls.style.cssText = "display:flex;flex-wrap:wrap;gap:0.5em;margin-block:0.5em";
                function column(label, initial, flex) {
                    const cell = controls.createEl("label");
                    cell.style.cssText = `display:grid;gap:0.25em;min-width:0;flex:${flex} 1 8em`;
                    cell.createEl("small", { text: label });
                    return textInput(cell, label, initial);
                }
                controls.style.alignItems = "end";
                const nameInput = column(nameLabel, name, 1);
                const pathInput = column(pathLabel, value, 2);
                if (parse === vaultPath) noteButton(controls, plugin, pathInput);
                const remove = controls.createEl("button", { text: "移除" });
                remove.onclick = () => {
                    rows.delete(row);
                    row.remove();
                };
                rows.set(row, { nameInput, pathInput });
                return nameInput;
            }
            for (const [name, value] of Object.entries(plugin.settings[key])) add(name, value);
            action.addButton(button => button.setButtonText(addLabel).onClick(() => add("", "").focus()));
            readers.set(key, () => {
                const entries = new Map();
                for (const [row, { nameInput, pathInput }] of rows) {
                    const keyName = read(nameInput, row, value => {
                        required(value);
                        if (entries.has(value)) throw new Error(`${nameLabel}不能重复。`);
                        return value;
                    });
                    entries.set(keyName, read(pathInput, row, value => parse(required(value))));
                }
                return Object.fromEntries(entries);
            });
        }

        container.createEl("h3", { text: "分发与回收指令" });
        field(container, "userSource", "用户指令源笔记", "选择要分发给各工具的笔记。", vaultPath);
        mapping(container, "targets", "用户指令目标", "工具名称", "目标文件", "添加目标", targetPath);
        field(container, "workSource", "Work 项目模板", "同步前两个一级标题之间的区块。", vaultPath);
        field(container, "codeSource", "Code 项目模板", "各项目的目标在同步面板中登记。", vaultPath);

        container.createEl("h3", { text: "AI 总结或翻译" });
        field(container, "defaultTemplate", "默认总结模板", "留空使用内置提示词。模板可以用 {activeNote} 引用笔记。", vaultPath);
        field(container, "languageRule", "翻译方向", "");
        const types = disclosure(container, "按类型指定总结模板");
        field(types, "typeProperty", "笔记类型属性", "");
        mapping(types, "templates", "类型与总结模板", "笔记类型", "总结模板", "添加类型", vaultPath);
        const model = disclosure(container, "模型连接");
        field(model, "endpoint", "模型接口", "兼容 Chat Completions 的完整请求地址。", modelEndpoint);
        field(model, "model", "模型名称", "", required);
        field(model, "credentialVariable", "凭据环境变量名", "只填写变量名。", value => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("请填写有效的环境变量名。");
            return value;
        });
        new Setting(container).addButton(button => button.setButtonText("保存设置").setCta().onClick(async () => {
            clearError();
            button.setDisabled(true);
            try {
                const updated = { ...plugin.settings };
                for (const [key, getValue] of readers) updated[key] = getValue();
                await plugin.saveData(updated);
                plugin.settings = updated;
                new Notice("设置已保存。");
            } catch (error) {
                if (!invalidInput) new Notice("设置保存失败。");
            } finally {
                button.setDisabled(false);
            }
        }));
    }
}
module.exports = { defaults, ManagerSettings };
