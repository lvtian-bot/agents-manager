const { PluginSettingTab, Setting, Notice, FuzzySuggestModal } = require("obsidian");
const path = require("path");
const fs = require("fs");
const { modelPresets, modelPreset } = require("./models");

const harnessTargets = {
    Codex: "~/.codex/AGENTS.md", Claude: "~/.claude/CLAUDE.md", ZCode: "~/.zcode/AGENTS.md",
    "DeepSeek Harness": "~/.dsh/AGENTS.md", Antigravity: "~/.gemini/GEMINI.md",
    WorkBuddy: "~/.workbuddy/rules/AGENTS.md",
};

const defaultSkillUserTargets = {
    Claude: "~/.claude/skills",
};

const defaultSkillProjectTargets = {
    Claude: ".claude/skills",
};

const legacySources = {
    userSource: "8-永久笔记/人工智能/37-用户指令.md",
    workSource: "8-永久笔记/人工智能/37.1-Work项目指令模板.md",
    codeSource: "8-永久笔记/人工智能/37.2-Code项目指令模板.md",
};
function loadSettings(app, data, pluginDir) {
    const saved = { ...data };
    delete saved.githubCredentialVariable;
    const adapter = app.vault?.adapter;
    const root = adapter?.getBasePath?.() || adapter?.basePath;
    const config = root && path.join(root, app.vault.configDir || ".obsidian");
    const installed = config && (pluginDir ? path.resolve(root, pluginDir) : path.join(config, "plugins", "agents-manager"));
    const existing = config && (fs.existsSync(path.join(config, "nascence-sync")) ||
        fs.existsSync(path.join(installed, "sync", "legacy-settings")));
    const hasRules = Object.keys(saved.templates || {}).length > 0;
    return {
        endpoint: "", model: "", credentialVariable: "",
        modelConnection: saved.endpoint || saved.model || saved.credentialVariable ? "custom" : "",
        typeProperty: hasRules ? "content_type" : "", templates: {}, defaultTemplate: "",
        singleTemplate: saved.defaultTemplate || "",
        summaryMode: hasRules ? "multiple" : "single",
        userSource: "", workSource: "", codeSource: "",
        ...(existing ? legacySources : {}),
        targets: existing ? { ...harnessTargets } : {},
        ...saved,
        skillUserTargets: saved.skillUserTargets ? { ...saved.skillUserTargets } : { ...defaultSkillUserTargets },
        skillProjectTargets: saved.skillProjectTargets ? { ...saved.skillProjectTargets } : { ...defaultSkillProjectTargets },
    };
}

function vaultPath(value) {
    if (!value) return "";
    if (typeof value !== "string" || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes("..")) {
        throw new Error("请使用库内相对路径。");
    }
    return value.replace(/\\/g, "/");
}

function skillUserPath(value) {
    const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized) throw new Error("此项不能为空。");
    if (normalized.split("/").includes("..")) throw new Error("路径中不能包含 ..。");
    if (!normalized.startsWith("~/") && !path.isAbsolute(normalized) && !/^[A-Za-z]:\//.test(normalized)) {
        throw new Error("用户级技能目录须使用 ~/ 或绝对路径。");
    }
    return normalized;
}

function skillProjectPath(value) {
    const normalized = vaultPath(value).replace(/^\.\//, "").replace(/\/+$/, "");
    if (!normalized) throw new Error("此项不能为空。");
    if (normalized === ".agents/skills") throw new Error("项目级分发目标不能是 .agents/skills 本身。");
    return normalized;
}

function envVariableName(value) {
    if (!value) return "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("请填写有效的环境变量名。");
    return value;
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

function settingsSection(parent, title) {
    const section = parent.createEl("section");
    section.style.marginBlockEnd = "1.5em";
    const heading = section.createEl("h3", { text: title });
    heading.style.marginBlock = "0 0.65em";
    return section;
}

function textInput(parent, label, value, type = "text") {
    const input = parent.createEl("input", { attr: { type, "aria-label": label } });
    input.defaultValue = value;
    input.placeholder = label;
    input.style.cssText = "flex:1 1 10em;min-width:0;max-width:100%";
    return input;
}

function noteButton(parent, plugin, input) {
    const button = parent.createEl("button", { text: "选择笔记", attr: { type: "button", "aria-label": `选择${input.getAttribute("aria-label")}` } });
    button.onclick = () => {
        const picker = new NotePicker(plugin, path => {
            input.value = path;
            input.onchange();
        });
        plugin.modals.add(picker);
        picker.open();
    };
}

function required(value) {
    if (!value.trim()) throw new Error("此项不能为空。");
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
        const errors = new Map();
        function clearError(input) {
            input.removeAttribute("aria-invalid");
            errors.get(input)?.remove();
            errors.delete(input);
        }
        function showError(input, row, message) {
            clearError(input);
            const error = row.createDiv({ text: message, attr: { role: "alert" } });
            error.style.color = "var(--text-error)";
            errors.set(input, error);
            input.setAttribute("aria-invalid", "true");
        }
        function read(input, row, parse) {
            clearError(input);
            try {
                const value = input.value === input.defaultValue ? input.value : input.value.trim();
                return parse(value);
            } catch (error) {
                showError(input, row, error.message);
                throw error;
            }
        }
        async function save(change) {
            try {
                await plugin.updateSettings(change);
                return true;
            } catch {
                new Notice("设置保存失败。");
                return false;
            }
        }
        function saveFields(readFields) {
            let patch;
            try { patch = readFields(); } catch { return; }
            return save(current => {
                if (Object.entries(patch).every(([key, value]) => current[key] === value)) return;
                return { ...current, ...patch };
            });
        }
        function field(parent, key, label, desc, parse) {
            const row = parent.createDiv();
            const item = new Setting(row).setName(label).setDesc(desc);
            const input = textInput(item.controlEl, label, plugin.settings[key]);
            if (parse === vaultPath) noteButton(item.controlEl, plugin, input);
            const getValue = () => read(input, row, parse);
            input.onchange = () => saveFields(() => ({ [key]: getValue() }));
            return { input, getValue };
        }
        function mapping(parent, key, title, nameLabel, pathLabel, addLabel, parse) {
            const action = new Setting(parent).setName(title);
            const list = parent.createDiv();
            function add(name, value) {
                let savedName = name;
                let pending = Promise.resolve();
                function saveRow(change, onSaved) {
                    pending = pending.then(async () => {
                        const saved = await save(change);
                        onSaved(saved);
                    });
                    return pending;
                }
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
                nameInput.onchange = pathInput.onchange = () => {
                    if (remove.disabled) return;
                    clearError(nameInput);
                    clearError(pathInput);
                    if (!savedName && (!nameInput.value.trim() || !pathInput.value.trim())) return;
                    let nextName, nextPath;
                    try {
                        nextName = read(nameInput, row, required);
                        nextPath = read(pathInput, row, value => parse(required(value)));
                    } catch { return; }
                    let duplicate = false;
                    return saveRow(current => {
                        if (nextName !== savedName && Object.hasOwn(current[key], nextName)) {
                            duplicate = true;
                            showError(nameInput, row, nameLabel + "不能重复。");
                            return;
                        }
                        if (nextName === savedName && current[key][savedName] === nextPath) return;
                        const entries = new Map(Object.entries(current[key]));
                        if (savedName) entries.delete(savedName);
                        entries.set(nextName, nextPath);
                        return { ...current, [key]: Object.fromEntries(entries) };
                    }, saved => {
                        if (saved && !duplicate) savedName = nextName;
                    });
                };
                const remove = controls.createEl("button", { text: "移除" });
                remove.onclick = () => {
                    remove.disabled = nameInput.disabled = pathInput.disabled = true;
                    return saveRow(current => {
                        if (!savedName) return;
                        const remaining = { ...current[key] };
                        delete remaining[savedName];
                        return { ...current, [key]: remaining };
                    }, saved => {
                        if (saved) {
                            clearError(nameInput);
                            clearError(pathInput);
                            row.remove();
                        } else {
                            remove.disabled = nameInput.disabled = pathInput.disabled = false;
                        }
                    });
                };
                return nameInput;
            }
            for (const [name, value] of Object.entries(plugin.settings[key])) add(name, value);
            action.addButton(button => button.setButtonText(addLabel).onClick(() => add("", "").focus()));
        }

        const summary = settingsSection(container, "AI 总结笔记");
        const setting = new Setting(summary).setName("总结模式");
        const mode = setting.controlEl.createEl("select", { attr: { "aria-label": "总结模式" } });
        mode.createEl("option", { text: "单提示词模式" }).value = "single";
        mode.createEl("option", { text: "多提示词模式" }).value = "multiple";
        mode.value = plugin.settings.summaryMode;
        const single = summary.createDiv();
        const multiple = summary.createDiv();
        field(single, "singleTemplate", "总结提示词", "留空使用内置提示词。模板可以用 {activeNote} 引用笔记。", vaultPath);
        field(multiple, "typeProperty", "匹配属性", "", required);
        mapping(multiple, "templates", "提示词匹配规则", "属性值", "提示词笔记", "添加规则", vaultPath);
        field(multiple, "defaultTemplate", "未匹配时使用的提示词", "留空使用内置提示词。", vaultPath);
        function showMode() {
            single.hidden = mode.value !== "single";
            multiple.hidden = !single.hidden;
        }
        mode.onchange = async () => {
            const summaryMode = mode.value;
            showMode();
            if (!await saveFields(() => ({ summaryMode })) && mode.value === summaryMode) {
                mode.value = plugin.settings.summaryMode;
                showMode();
            }
        };
        showMode();
        const model = settingsSection(container, "模型设置");
        const modelSetting = new Setting(model).setName("模型");
        const connection = modelSetting.controlEl.createEl("select", { attr: { "aria-label": "模型" } });
        connection.createEl("option", { text: "请选择模型" }).value = "";
        for (const [id, preset] of Object.entries(modelPresets)) {
            connection.createEl("option", { text: preset.label }).value = id;
        }
        connection.createEl("option", { text: "自定义连接" }).value = "custom";
        connection.value = plugin.settings.modelConnection;

        const keyRow = model.createDiv();
        const keySetting = new Setting(keyRow).setName("API Key");
        const keyInput = textInput(keySetting.controlEl, "API Key", "", "password");
        keyInput.setAttribute("autocomplete", "off");
        function showConnection() {
            const preset = modelPreset(connection.value);
            custom.hidden = connection.value !== "custom";
            keyRow.hidden = !preset;
            keyInput.value = "";
            keyInput.placeholder = preset && plugin.app.secretStorage.getSecret(preset.secretId) ? "••••••••" : "API Key";
            clearError(keyInput);
        }
        keySetting.addButton(button => button.setButtonText("保存").onClick(() => {
            const preset = modelPreset(connection.value);
            if (!preset) return;
            let key;
            try { key = read(keyInput, keyRow, required); } catch { return; }
            try {
                plugin.app.secretStorage.setSecret(preset.secretId, key);
                showConnection();
                new Notice("设置已保存。");
            } catch {
                new Notice("设置保存失败。");
            }
        }));

        const custom = model.createDiv();
        function validateConnectionField(validate) {
            return value => Object.values(connectionFields).some(({ input }) => input.value.trim()) ? validate(value) : "";
        }
        const connectionFields = {
            endpoint: field(custom, "endpoint", "模型接口", "兼容 Chat Completions 的完整请求地址。", validateConnectionField(modelEndpoint)),
            model: field(custom, "model", "模型名称", "", validateConnectionField(required)),
            credentialVariable: field(custom, "credentialVariable", "凭据环境变量名", "只填写变量名。", validateConnectionField(value => envVariableName(required(value)))),
        };
        for (const { input } of Object.values(connectionFields)) {
            input.onchange = () => saveFields(() => Object.fromEntries(
                Object.entries(connectionFields).map(([key, { getValue }]) => [key, getValue()]),
            ));
        }
        connection.onchange = async () => {
            const modelConnection = connection.value;
            showConnection();
            if (!await saveFields(() => ({ modelConnection })) && connection.value === modelConnection) {
                connection.value = plugin.settings.modelConnection;
                showConnection();
            }
        };
        showConnection();
    }
}
module.exports = {
    loadSettings,
    ManagerSettings,
    harnessTargets,
    NotePicker,
    vaultPath,
    defaultSkillUserTargets,
    defaultSkillProjectTargets,
    skillUserPath,
    skillProjectPath,
    required,
};
