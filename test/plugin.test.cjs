const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");

const bundle = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

class Element {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.style = {};
        this.textContent = "";
    }

    appendChild(child) {
        this.children.push(child);
        child.parent = this;
    }

    remove() {
        const siblings = this.parent.children;
        siblings.splice(siblings.indexOf(this), 1);
    }

    addEventListener() {}
    setAttribute(key, value) { (this.attributes ??= {})[key] = value; }
    getAttribute(key) { return this.attributes?.[key]; }
    removeAttribute(key) { delete this.attributes?.[key]; }
    focus() { this.focused = true; }
    getBoundingClientRect() { return { left: 0, bottom: 0 }; }
    closest(tag) { return this.tag === tag ? this : this.parent?.closest(tag); }
    empty() { this.children = []; }
    createEl(tag, { text, attr } = {}) {
        const child = new Element(tag);
        child.textContent = text || "";
        child.attributes = attr || {};
        this.appendChild(child);
        return child;
    }
    createDiv(options) { return this.createEl("div", options); }
    set defaultValue(value) { this.initial = this.value = value; }
    get defaultValue() { return this.initial; }
}

function findElements(element, predicate) {
    const children = element.children.flatMap((child) => findElements(child, predicate));
    return predicate(element) ? [element, ...children] : children;
}

async function loadPlugin(app, options = {}) {
    const commands = [];
    const body = new Element("body");
    const document = {
        body,
        createElement: (tag) => new Element(tag),
        addEventListener() {},
        removeEventListener() {},
    };

    class Modal {
        constructor() {
            this.modalEl = new Element("div");
            this.contentEl = new Element("div");
            this.titleEl = new Element("h2");
            this.modalEl.appendChild(this.titleEl);
            this.modalEl.appendChild(this.contentEl);
        }
        setTitle(value) { this.titleEl.textContent = value; }
        open() { body.appendChild(this.modalEl); }
        close() { this.modalEl.remove(); this.onClose?.(); }
    }
    class Plugin {
        async loadData() { return options.settings || {}; }
        async saveData(settings) { options.save(settings); }
        addSettingTab(tab) { this.settingTab = tab; }
        addCommand(command) {
            commands.push(command);
        }
    }

    class Notice {
        constructor(message) {
            if (options.notices) options.notices.push(message);
            else assert.fail(message);
        }
    }

    class Setting {
        constructor(parent) { this.controlEl = parent.createDiv(); }
        setName(label) { this.controlEl.textContent = label; return this; }
        setDesc() { return this; }
        addButton(build) {
            const element = this.controlEl.createEl("button");
            build({
                buttonEl: element,
                setButtonText(label) { element.textContent = label; return this; },
                setCta() { return this; },
                setDisabled(disabled) { element.disabled = disabled; },
                onClick(action) { element.onclick = action; },
            });
        }
    }

    const module = { exports: {} };
    runInNewContext(bundle, {
        module,
        document,
        require(name) {
            if (name === "obsidian") {
                class Menu {
                    items = [];
                    addItem(build) {
                        const item = {
                            setTitle(title) { this.title = title; return this; },
                            onClick(action) { this.action = action; return this; },
                        };
                        build(item);
                        this.items.push(item);
                    }
                    showAtPosition() { options.menu(this.items); }
                }
                return { Notice, Plugin, Modal, Setting, Menu, PluginSettingTab: class {}, FuzzySuggestModal: class {
                    constructor(app) { this.app = app; }
                    open() { options.pick(this); }
                    onClose() {}
                } };
            }
            if (name === "fs" && options.filesystem) return options.filesystem;
            if (name === "os") {
                assert.ok(options.fixtureDir, "同步测试须配置隔离目录");
                return {
                    homedir: () => path.join(options.fixtureDir, "home"),
                    tmpdir: () => path.join(options.fixtureDir, "backups"),
                };
            }
            return require(name);
        },
        process: { env: { TEST_MODEL_API_KEY: "test-key" } },
        console: { log() {}, error: (error) => assert.fail(String(error)) },
        fetch: options.fetch,
        TextDecoder, URL, AbortController,
        setTimeout() {},
        clearTimeout() {},
    });

    const plugin = new module.exports();
    plugin.app = app;
    await plugin.onload();
    return {
        commands,
        body,
        plugin,
        invoke(id) {
            const command = commands.find((candidate) => candidate.id === id);
            assert.ok(command, id);
            return command.callback();
        },
    };
}

test("总结与翻译分别注册，快捷键由使用者绑定", async () => {
    const { commands } = await loadPlugin({});
    assert.deepEqual(commands.map(({ id }) => id), [
        "summarize-note",
        "translate-selection",
        "sync-instructions",
    ]);
    assert.ok(commands.every((command) => !Object.hasOwn(command, "hotkeys")));
});

test("设置页保留旧配置，可选笔记、增删行，并在出错时保留草稿", async () => {
    const saved = [];
    const notices = [];
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-settings-"));
    try {
        const app = { vault: { adapter: { getBasePath: () => fixtureDir }, getMarkdownFiles: () => [{ path: "模板/摘要.md" }] } };
        let choices;
        const options = { notices, menu: items => { choices = items; }, save: value => saved.push(value), pick: picker => {
            picker.onChooseItem(picker.getItems()[0]);
            picker.onClose();
        } };
        const { plugin: fresh } = await loadPlugin(app, options);
        assert.deepEqual(Object.keys(fresh.settings.targets), []);
        assert.equal(fresh.settings.summaryMode, "single");
        assert.equal(fresh.settings.typeProperty, "");
        fs.mkdirSync(path.join(fixtureDir, ".obsidian", "nascence-sync"), { recursive: true });
        const { plugin } = await loadPlugin(app, {
            ...options,
            settings: {
                templates: { 文章: "旧模板.md" }, extra: 7,
                endpoint: "https://legacy.example.org/v1/chat/completions",
                model: "saved-model", credentialVariable: "SAVED_API_KEY",
            },
        });
        const tab = plugin.settingTab;
        const root = tab.containerEl = new Element("div");
        const nodes = predicate => findElements(root, predicate);
        const fields = label => nodes(element => element.getAttribute("aria-label") === label);
        const button = text => nodes(element => element.tag === "button" && element.textContent === text)[0];
        const save = () => button("保存设置").onclick();
        tab.display();
        assert.equal(nodes(element => element.textContent === "×").length, 6);
        assert.equal(fields("目标文件").length, 0);
        assert.equal(button("添加目标").disabled, true);
        assert.equal(fields("提示词笔记")[0].value, "旧模板.md");
        assert.equal(fields("总结模式")[0].value, "multiple");
        assert.equal(fields("模型接口")[0].value, "https://legacy.example.org/v1/chat/completions");
        assert.equal(fields("模型名称")[0].value, "saved-model");
        assert.equal(fields("凭据环境变量名")[0].value, "SAVED_API_KEY");
        assert.ok(nodes(element => element.tag === "details").every(element => !element.open));
        fields("选择未匹配时使用的提示词")[0].onclick();
        assert.equal(fields("未匹配时使用的提示词")[0].value, "模板/摘要.md");
        fields("移除 Claude")[0].onclick();
        button("添加目标").onclick();
        assert.deepEqual(Array.from(choices, item => item.title), ["Claude"]);
        choices[0].action();
        assert.equal(button("添加目标").disabled, true);
        fields("移除 Codex")[0].onclick();
        assert.ok(plugin.settings.targets.Codex);
        fields("模型接口")[0].value = "无效地址";
        await save();
        assert.ok(fields("模型接口")[0].closest("details").open);
        assert.equal(saved.length, 0);
        assert.equal(plugin.settings.defaultTemplate, "");
        fields("模型接口")[0].value = "https://example.org/v1/chat/completions";
        await save();
        assert.equal(saved.length, 1);
        assert.equal(saved[0].targets.Codex, undefined);
        assert.equal(saved[0].targets.Claude, "~/.claude/CLAUDE.md");
        assert.equal(saved[0].extra, 7);
        assert.equal(saved[0].model, "saved-model");
        assert.equal(saved[0].credentialVariable, "SAVED_API_KEY");
        assert.deepEqual(notices, ["设置已保存。"]);
        tab.display();
        assert.equal(fields("未匹配时使用的提示词")[0].value, "模板/摘要.md");
        assert.equal(fields("移除 Codex").length, 0);
        plugin.settings.targets = { Codex: "~/legacy.md", 自定义: "~/custom.md" };
        tab.display();
        await save();
        assert.deepEqual({ ...saved.at(-1).targets }, { Codex: "~/legacy.md", 自定义: "~/custom.md" });
        const choose = value => {
            const mode = fields("总结模式")[0];
            mode.value = value;
            mode.onchange();
        };
        choose("single");
        fields("总结提示词")[0].value = "单独.md";
        await save();
        tab.display();
        assert.equal(fields("总结模式")[0].value, "single");
        choose("multiple");
        fields("匹配属性")[0].value = "文章类型";
        button("添加规则").onclick();
        fields("属性值").at(-1).value = "访谈";
        fields("提示词笔记").at(-1).value = "访谈摘要.md";
        await save();
        assert.equal(plugin.settings.typeProperty, "文章类型");
        assert.equal(plugin.settings.templates.访谈, "访谈摘要.md");
        assert.equal(plugin.settings.defaultTemplate, "模板/摘要.md");
        assert.equal(plugin.settings.singleTemplate, "单独.md");
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test("全新安装可保存指令设置，模型连接留空时不发起 AI 请求", async () => {
    const notices = [];
    const saved = [];
    const app = {
        workspace: {
            getActiveFile: () => ({ path: "笔记.md" }),
            activeEditor: { editor: { getSelection: () => "Selected text" } },
        },
    };
    const { body, invoke, plugin } = await loadPlugin(app, {
        notices,
        save: settings => saved.push(settings),
        fetch: () => assert.fail("模型连接留空时不应发起请求"),
    });
    const tab = plugin.settingTab;
    const root = tab.containerEl = new Element("div");
    tab.display();
    const field = label => findElements(root, el => el.getAttribute("aria-label") === label)[0];
    const [save] = findElements(root, el => el.tag === "button" && el.textContent === "保存设置");
    for (const label of ["模型接口", "模型名称", "凭据环境变量名"]) assert.equal(field(label).value, "");

    field("用户指令源笔记").value = "我的指令.md";
    await save.onclick();
    assert.equal(saved[0].userSource, "我的指令.md");
    assert.equal(saved[0].endpoint, "");
    assert.equal(saved[0].model, "");
    assert.equal(saved[0].credentialVariable, "");

    field("模型接口").value = "https://example.org/v1/chat/completions";
    await save.onclick();
    assert.equal(saved.length, 1);
    assert.equal(field("模型名称").getAttribute("aria-invalid"), "true");

    await invoke("summarize-note");
    await invoke("translate-selection");
    assert.deepEqual(notices, ["设置已保存。", "请填写完整的模型接口地址。", "请填写完整的模型接口地址。"]);
    assert.equal(body.children.length, 0);
});

test("没有选区时翻译只提示，不发起模型请求", async () => {
    const notices = [];
    const plugin = await loadPlugin({
        workspace: { getActiveFile: () => ({ path: "笔记.md" }), activeEditor: { editor: { getSelection: () => " " } } },
    }, { notices });
    await plugin.invoke("translate-selection");
    assert.deepEqual(notices, ["请先选中要翻译的外文。"]);
    assert.equal(plugin.body.children.length, 0);
});

test("AI 命令保持选区翻译、按类型总结及流式内容写回", async () => {
    const cases = [
        ["观点视角", "Selected passage", null],
        ["新闻报道", "", "新闻简讯"],
        ["观点视角", "", "观点视角"],
        ["知识教程", "", "知识教程"],
        [null, "", "观点视角"],
        ["新闻报道", "样例", "新闻简讯"],
        ["新闻报道", "样例", "单独", "single"],
    ];

    for (const [type, selection, template, mode] of cases) {
        const file = { path: "样例.md" };
        const frontmatter = type ? `---\ncontent_type: "${type}"\n---\n` : "";
        const note = frontmatter + "样例文献正文";
        const writes = [];
        const openedTemplates = [];

        const app = {
            metadataCache: { getFileCache: () => {
                assert.ok(mode !== "single" && template, "单提示词模式和翻译不读取元数据");
                return { frontmatter: {文章类型: type} };
            } },
            workspace: {
                getActiveFile: () => file,
                activeEditor: {
                    editor: {
                        getSelection: () => selection,
                        replaceSelection: (value) => writes.push(value),
                    },
                },
            },
            vault: {
                getAbstractFileByPath(templatePath) {
                    openedTemplates.push(templatePath);
                    return { path: templatePath };
                },
                async read(target) {
                    return target === file ? note : "请总结：{activeNote}";
                },
            },
        };

        const plugin = await loadPlugin(app, {
            settings: {
                endpoint: "https://example.org/v1/chat/completions",
                model: "my-model", credentialVariable: "TEST_MODEL_API_KEY",
                typeProperty: "文章类型",
                ...(mode ? { summaryMode: mode, singleTemplate: "docs/prompts/文献总结-单独.md" } : {}),
                templates: { 新闻报道: "docs/prompts/文献总结-新闻简讯.md", 观点视角: "docs/prompts/文献总结-观点视角.md", 知识教程: "docs/prompts/文献总结-知识教程.md" },
                defaultTemplate: "docs/prompts/文献总结-观点视角.md",
            },
            async fetch(url, request) {
                assert.equal(url, "https://example.org/v1/chat/completions");
                assert.equal(request.headers.Authorization, "Bearer test-key");
                const body = JSON.parse(request.body);
                assert.equal(body.model, "my-model");
                assert.equal(body.stream, true);
                if (!template) {
                    assert.match(body.messages[0].content, /Selected passage/);
                    assert.match(body.messages[0].content, /外文翻译为中文/);
                    assert.doesNotMatch(body.messages[0].content, /样例文献正文/);
                } else {
                    assert.equal(body.messages[0].content, "请总结：" + note);
                }

                const chunks = [
                    'data: {"choices":[{"delta":{"content":"生成"}}]}\n',
                    'data: {"choices":[{"delta":{"content":"结果"}}]}\n\ndata: [DONE]\n',
                ];
                let index = 0;
                return {
                    ok: true,
                    body: {
                        getReader: () => ({
                            async read() {
                                const value = chunks[index++];
                                return value
                                    ? { value: new TextEncoder().encode(value), done: false }
                                    : { done: true };
                            },
                        }),
                    },
                };
            },
        });

        await plugin.invoke(template ? "summarize-note" : "translate-selection");
        assert.deepEqual(openedTemplates, template ? [`docs/prompts/文献总结-${template}.md`] : []);
        const [preview] = findElements(plugin.body, (element) => element.tag === "textarea");
        assert.equal(preview.value, "生成结果");
        assert.deepEqual(writes, []);

        if (selection) {
            preview.value = "编辑后的结果";
            const [insert] = findElements(plugin.body, (element) => element.textContent === "插入");
            insert.onclick();
            assert.deepEqual(writes, [selection + "编辑后的结果"]);
        } else {
            const [replace] = findElements(plugin.body, (element) => element.textContent === "替换");
            replace.onclick();
            assert.deepEqual(writes, ["生成结果"]);
        }
    }
});

test("指令命令沿用已有登记和基线，分发保留项目正文并备份", async (t) => {
    const tempParent = path.resolve(os.tmpdir());
    const fixturePrefix = "agents-manager-test-";
    const fixtureDir = fs.mkdtempSync(path.join(tempParent, fixturePrefix));
    t.after(() => {
        assert.equal(path.dirname(fixtureDir), tempParent);
        assert.ok(path.basename(fixtureDir).startsWith(fixturePrefix));
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    const vaultRoot = path.join(fixtureDir, "vault");
    const noteFolder = path.join(vaultRoot, "8-永久笔记", "人工智能");
    const stateFolder = path.join(vaultRoot, ".obsidian", "nascence-sync");
    const target = path.join(fixtureDir, "example-project", "AGENTS.md");
    const userTarget = path.join(fixtureDir, "home", ".codex", "AGENTS.md");
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
    };
    const read = (file) => fs.readFileSync(file, "utf8");
    const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
    const newFolder = path.join(vaultRoot, ".obsidian", "plugins", "agents-manager", "sync");
    const typeStatePath = path.join(newFolder, "type-instructions-sync.json");
    const legacyTypeState = path.join(stateFolder, "type-instructions-sync.json");
    const oldSection = "# 工作规范\n旧版本";
    const newSection = "# 工作规范\n新版本";
    const projectBody = "# 项目专属\n保留这行。\n";
    const userBody = "用户级规则。\n";
    const previousProject = oldSection + "\n" + projectBody;
    const registry = JSON.stringify({
        version: 1,
        projects: [{ name: "样例项目", type: "work", path: target }],
    });
    write(path.join(noteFolder, "37-用户指令.md"), "---\ncode: 37\n---\n" + userBody);
    write(path.join(noteFolder, "37.1-Work项目指令模板.md"), newSection + "\n# 项目模板\n");
    write(path.join(stateFolder, "instruction-projects.json"), registry);
    write(path.join(stateFolder, "user-instructions-sync.json"), JSON.stringify({
        version: 1,
        targets: [{ path: userTarget, sourceHash: hash(userBody), targetHash: hash(userBody) }],
    }));
    write(legacyTypeState, JSON.stringify({
        version: 1,
        projects: [{
            name: "样例项目",
            type: "work",
            path: target,
            sourceSectionHash: hash(oldSection),
            targetSectionHash: hash(oldSection),
        }],
    }));
    write(target, previousProject);
    write(userTarget, userBody);

    let failSourceWrite = false;
    let failTargetWrite = false;
    const notices = [];
    const filesystem = {
        ...fs,
        renameSync(from, to) {
            if (failTargetWrite && to === target) throw new Error("模拟合并第二侧写入失败");
            return fs.renameSync(from, to);
        },
    };
    const plugin = await loadPlugin({
        workspace: {
            getActiveFile: () => null,
            getLeavesOfType: () => [],
        },
        vault: {
            adapter: { getBasePath: () => vaultRoot },
            getAbstractFileByPath: relative => ({ path: relative }),
            async modify(file, text) {
                if (failSourceWrite) throw new Error("模拟源文件写入失败");
                await fs.promises.writeFile(path.join(vaultRoot, file.path), text);
            },
        },
    }, { fixtureDir, filesystem, notices });

    const panel = plugin.invoke("sync-instructions");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(read(target), previousProject);
    const [alreadySynced] = findElements(plugin.body, (element) => element.textContent === "已同步");
    assert.equal(alreadySynced.disabled, true);

    const [distribute] = findElements(plugin.body, (element) => element.textContent === "备份并分发");
    await distribute.onclick();
    assert.equal(notices.at(-1), "已分发到 样例项目");
    assert.equal(findElements(plugin.body, (element) => element.textContent === "备份并分发").length, 0);
    assert.equal(read(target), newSection + "\n" + projectBody);
    assert.equal(read(path.join(stateFolder, "instruction-projects.json")), registry);
    assert.equal(read(userTarget), userBody);
    assert.equal(JSON.parse(read(typeStatePath)).projects[0].targetSectionHash, hash(newSection));

    const journal = path.join(newFolder, "last-operation.json");
    assert.equal(JSON.parse(read(journal)).entries.find(e => e.path === target).before, previousProject);
    assert.equal(read(path.join(newFolder, "instruction-projects.json")), registry);
    assert.equal(JSON.parse(read(legacyTypeState)).projects[0].targetSectionHash, hash(oldSection));

    const [close] = findElements(plugin.body, (element) => element.textContent === "关闭");
    close.onclick();
    await panel;
    const typeSource = path.join(noteFolder, "37.1-Work项目指令模板.md");
    const sourceHeader = "---\nkind: template\n---\n";
    const sourceTail = "# 项目模板\n模板示例\n";
    write(typeSource, sourceHeader + "# 工作规范\n源端新增\n" + sourceTail);
    write(target, "# 工作规范\n目标新增\n" + projectBody);
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const button = (label) => {
        const [item] = findElements(plugin.body, node => node.tag === "button" && node.textContent === label);
        assert.ok(item, label);
        return item;
    };
    const conflict = plugin.invoke("sync-instructions");
    await tick();
    button("行级对比合并…").onclick();
    const checkboxes = findElements(plugin.body, node => node.type === "checkbox");
    assert.equal(checkboxes.length, 2);
    for (const box of checkboxes) { box.checked = true; box.onchange(); }
    const beforeMerge = [read(typeSource), read(target), read(typeStatePath)];
    failTargetWrite = true;
    await button("写回模板与项目").onclick();
    assert.deepEqual([read(typeSource), read(target), read(typeStatePath)], beforeMerge);
    assert.equal(JSON.parse(read(journal)).label, "分发到 样例项目");
    findElements(plugin.body, node => node.textContent === "关闭").at(-1).onclick();
    failTargetWrite = false;
    await button("写回模板与项目").onclick();
    assert.match(read(target), /源端新增/);
    assert.match(read(target), /目标新增/);
    assert.ok(read(typeSource).startsWith(sourceHeader) && read(typeSource).endsWith(sourceTail));
    assert.ok(read(target).endsWith(projectBody));
    for (const item of findElements(plugin.body, node => node.textContent === "关闭").reverse()) item.onclick();
    await conflict;

    const merged = [read(typeSource), read(target)];
    const mergeUndo = plugin.invoke("sync-instructions");
    await tick();
    await button("撤销上次操作").onclick();
    await tick();
    assert.deepEqual([read(typeSource), read(target), read(typeStatePath)], beforeMerge);
    button("关闭").onclick();
    await mergeUndo;
    write(typeSource, merged[0]);
    write(target, "# 工作规范\n来自目标的更新\n" + projectBody);
    const recycle = plugin.invoke("sync-instructions");
    await tick();
    const sourceBeforeFailure = read(typeSource);
    const targetBeforeFailure = read(target);
    const baselineBeforeFailure = read(typeStatePath);
    const recover = button("用项目版本回收进模板");
    failSourceWrite = true;
    await recover.onclick();
    assert.equal(read(typeSource), sourceBeforeFailure);
    assert.equal(read(target), targetBeforeFailure);
    assert.equal(read(typeStatePath), baselineBeforeFailure);
    assert.equal(recover.disabled, false);
    assert.equal(fs.existsSync(journal), false);
    failSourceWrite = false;
    await recover.onclick();
    assert.match(notices.at(-1), /已把项目工作规范回收进 Work 类型模板/);
    assert.match(notices.at(-1), /现在可直接分发给其他同类型项目/);
    assert.equal(read(typeSource), sourceHeader + "# 工作规范\n来自目标的更新\n" + sourceTail);
    button("关闭").onclick();
    await recycle;
    assert.equal(plugin.body.children.length, 0);

    // The undo slot survives closing the panel and refuses to silently overwrite later edits.
    const reopened = plugin.invoke("sync-instructions");
    await tick();
    const modified = read(typeSource) + "后续编辑\n";
    write(typeSource, modified);
    const cancelled = button("撤销上次操作").onclick();
    await tick();
    button("取消").onclick();
    await cancelled;
    assert.equal(read(typeSource), modified);
    const confirmed = button("撤销上次操作").onclick();
    await tick();
    button("继续撤销").onclick();
    await confirmed;
    await tick();
    assert.equal(read(typeSource), sourceBeforeFailure);
    assert.equal(read(typeStatePath), baselineBeforeFailure);
    assert.equal(button("撤销上次操作").disabled, true);
    button("关闭").onclick();
    await reopened;

    // One preview and one undo for an existing Work project, a new Code project and user targets.
    const codeTarget = path.join(fixtureDir, "code-project", "AGENTS.md");
    const codeSource = "# Code 规范\n代码规则\n# 项目模板\n代码示例\n";
    write(path.join(noteFolder, "37.2-Code项目指令模板.md"), codeSource);
    const updated = JSON.parse(registry);
    updated.projects.push({ name: "Code 样例", type: "code", path: codeTarget });
    write(path.join(newFolder, "instruction-projects.json"), JSON.stringify(updated));
    write(userTarget, "本地用户指令\n");
    const previousBaseline = read(typeStatePath);
    const previousTarget = read(target);

    const bulkPanel = plugin.invoke("sync-instructions");
    await tick();
    const cancelBatch = button("一键分发").onclick();
    await tick();
    button("取消").onclick();
    await cancelBatch;
    assert.equal(read(target), previousTarget);
    assert.equal(fs.existsSync(codeTarget), false);
    const batch = button("一键分发").onclick();
    await tick();
    button("确认分发").onclick();
    await batch;
    await tick();
    assert.equal(read(codeTarget), codeSource);
    assert.equal(read(userTarget), userBody);
    assert.ok(read(target).endsWith(projectBody));
    assert.notEqual(read(target), previousTarget);
    assert.match(JSON.parse(read(journal)).label, /一键分发/);
    await button("撤销上次操作").onclick();
    await tick();
    assert.equal(read(target), previousTarget);
    assert.equal(read(userTarget), "本地用户指令\n");
    assert.equal(fs.existsSync(codeTarget), false);
    assert.equal(read(typeStatePath), previousBaseline);
    assert.equal(button("撤销上次操作").disabled, true);
    button("关闭").onclick();
    await bulkPanel;
});

test("分发和撤销时保留目标符号链接", t => {
    const { replaceText } = require("../src/instructions/storage");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-manager-link-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const link = path.join(root, "AGENTS.md");
    const backing = path.join(root, "shared.md");
    try { fs.symlinkSync("shared.md", link, "file"); }
    catch (error) {
        if (error.code !== "EPERM") throw error;
        // Exercise link resolution on Windows test hosts without symlink privileges.
        const lstat = fs.lstatSync;
        t.mock.method(fs, "lstatSync", (file, options) => file === link
            ? { isSymbolicLink: () => true } : lstat(file, options));
        t.mock.method(fs, "readlinkSync", file => {
            assert.equal(file, link);
            return "shared.md";
        });
    }
    replaceText(link, "新内容");
    assert.equal(fs.readFileSync(backing, "utf8"), "新内容");
    replaceText(link, null);
    assert.equal(fs.existsSync(backing), false);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
});

test("同步面板操作后原地刷新保留标签页与滚动位置，并支持手动刷新", async (t) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-manager-refresh-"));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

    const vaultRoot = path.join(fixtureDir, "vault");
    const syncDir = path.join(vaultRoot, ".obsidian", "plugins", "agents-manager", "sync");
    const userSourcePath = path.join(vaultRoot, "用户指令.md");
    const workSourcePath = path.join(vaultRoot, "Work模板.md");
    const userTarget = path.join(fixtureDir, "home", ".codex", "AGENTS.md");
    const targetA = path.join(fixtureDir, "project-a", "AGENTS.md");
    const targetB = path.join(fixtureDir, "project-b", "AGENTS.md");

    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
    };
    const read = (file) => fs.readFileSync(file, "utf8");
    const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
    const tick = () => new Promise(resolve => setImmediate(resolve));

    const v1 = "# 工作规范\n第一版规范";
    const v1FromA = "# 工作规范\n项目A改进";
    const bodyA = "# 项目A专属\n保留A\n";
    const bodyB = "# 项目B专属\n保留B\n";
    const templateTail = "# 项目模板\n模板示例\n";

    write(userSourcePath, "用户指令内容\n");
    write(workSourcePath, v1 + "\n" + templateTail);
    write(targetA, v1FromA + "\n" + bodyA);
    write(targetB, v1 + "\n" + bodyB);
    write(path.join(syncDir, "instruction-projects.json"), JSON.stringify({
        version: 1,
        projects: [
            { name: "项目A", type: "work", path: targetA },
            { name: "项目B", type: "work", path: targetB },
        ],
    }));
    write(path.join(syncDir, "type-instructions-sync.json"), JSON.stringify({
        version: 1,
        projects: [
            { name: "项目A", type: "work", path: targetA, sourceSectionHash: hash(v1), targetSectionHash: hash(v1) },
            { name: "项目B", type: "work", path: targetB, sourceSectionHash: hash(v1), targetSectionHash: hash(v1) },
        ],
    }));

    const notices = [];
    const plugin = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: {
            adapter: { getBasePath: () => vaultRoot },
            getAbstractFileByPath: relative => ({ path: relative }),
            async modify(file, text) {
                await fs.promises.writeFile(path.join(vaultRoot, file.path), text);
            },
        },
    }, {
        fixtureDir,
        notices,
        settings: {
            userSource: "用户指令.md",
            workSource: "Work模板.md",
            targets: { Codex: "~/.codex/AGENTS.md" },
        },
    });

    const button = (label) => {
        const [item] = findElements(plugin.body, node => node.tag === "button" && node.textContent === label);
        assert.ok(item, label);
        return item;
    };
    const tabStartingWith = (prefix) => {
        const [item] = findElements(plugin.body, node => node.tag === "button" && node.textContent.startsWith(prefix));
        assert.ok(item, prefix);
        return item;
    };

    const panel = plugin.invoke("sync-instructions");
    await tick();

    // 初始时第一级有待处理项，默认停在第一级；手动切换到 Work 类型并设置滚动位置。
    const modalEl = plugin.body.children[0];
    const scrollContainer = modalEl.children[1];
    assert.match(tabStartingWith("第一级：用户级指令").style.cssText, /font-weight:600/);
    tabStartingWith("第二级：Work 类型").onclick();
    scrollContainer.scrollTop = 120;

    const assertStayedInWorkTab = (expectedTabText) => {
        assert.equal(plugin.body.children[0], modalEl);
        const workTab = tabStartingWith("第二级：Work 类型");
        assert.equal(workTab.textContent, expectedTabText);
        assert.match(workTab.style.cssText, /font-weight:600/);
        assert.equal(scrollContainer.scrollTop, 120);
    };

    // 1. 回收项目A后，原地刷新，项目B立即可分发。
    await button("用项目版本回收进模板").onclick();
    assert.match(notices.at(-1), /已把项目工作规范回收进 Work 类型模板/);
    assertStayedInWorkTab("第二级：Work 类型（1 待处理）");

    // 2. 不关闭面板，直接把更新后的模板分发给项目B。
    await button("备份并分发").onclick();
    assert.equal(notices.at(-1), "已分发到 项目B");
    assert.equal(read(targetB), v1FromA + "\n" + bodyB);
    assertStayedInWorkTab("第二级：Work 类型");

    // 3. 外部改动模板与项目A后点击底栏「刷新」按钮。
    const v2 = "# 工作规范\n模板二次更新";
    const v2FromA = "# 工作规范\n项目A二次更新";
    write(workSourcePath, v2 + "\n" + templateTail);
    write(targetA, v2FromA + "\n" + bodyA);
    await button("刷新").onclick();
    assertStayedInWorkTab("第二级：Work 类型（2 待处理）");
    assert.ok(button("行级对比合并…"));
    assert.ok(button("备份并分发"));

    // 4. 行级对比合并项目A写回后，主面板原地刷新且待处理计数准确降至 1。
    button("行级对比合并…").onclick();
    const checkboxes = findElements(plugin.body, node => node.type === "checkbox");
    assert.equal(checkboxes.length, 2);
    for (const box of checkboxes) { box.checked = true; box.onchange(); }
    await button("写回模板与项目").onclick();
    await tick();
    findElements(plugin.body, node => node.textContent === "关闭").at(-1).onclick();
    assertStayedInWorkTab("第二级：Work 类型（1 待处理）");

    // 5. 一键分发与撤销均在原地刷新，不重建弹窗。
    const batch = button("一键分发").onclick();
    await tick();
    button("确认分发").onclick();
    await batch;
    await tick();
    assert.equal(fs.existsSync(userTarget), true);
    assertStayedInWorkTab("第二级：Work 类型");

    await button("撤销上次操作").onclick();
    await tick();
    assert.equal(fs.existsSync(userTarget), false);
    assertStayedInWorkTab("第二级：Work 类型（1 待处理）");

    button("关闭").onclick();
    await panel;
    assert.equal(plugin.body.children.length, 0);
});
