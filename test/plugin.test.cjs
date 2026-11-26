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
    const views = {};
    const leaves = [];
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
    class ItemView {
        constructor(leaf) {
            this.leaf = leaf;
            this.contentEl = new Element("div");
        }
        setState() {}
        getState() { return {}; }
    }
    class Plugin {
        async loadData() { return options.settings || {}; }
        async saveData(settings) { options.save(settings); }
        registerView(type, factory) { views[type] = factory; }
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

    class MockLeaf {
        constructor() {
            this.type = null;
            this.view = null;
            this.containerEl = new Element("div");
        }
        async setViewState(viewState) {
            if (this.view?.onClose) await this.view.onClose();
            this.containerEl.empty();
            this.type = viewState.type;
            const factory = views[viewState.type];
            assert.ok(factory, viewState.type);
            this.view = factory(this);
            this.containerEl.appendChild(this.view.contentEl);
            if (!this.containerEl.parent) body.appendChild(this.containerEl);
            if (this.view.onOpen) await this.view.onOpen();
            if (viewState.state && this.view.setState) await this.view.setState(viewState.state, {});
        }
        async detach() {
            if (this.view?.onClose) await this.view.onClose();
            const index = leaves.indexOf(this);
            if (index >= 0) leaves.splice(index, 1);
            if (this.containerEl.parent) this.containerEl.remove();
            this.view = null;
            this.type = null;
        }
    }

    const baseWorkspace = app.workspace || {};
    const originalGetLeaves = baseWorkspace.getLeavesOfType?.bind(baseWorkspace);
    app.workspace = {
        ...baseWorkspace,
        getLeavesOfType(type) {
            const matched = leaves.filter(leaf => leaf.type === type);
            if (matched.length || type === "agents-manager-workspace") return matched;
            return originalGetLeaves ? originalGetLeaves(type) : [];
        },
        getLeaf() {
            const leaf = new MockLeaf();
            leaves.push(leaf);
            return leaf;
        },
        revealLeaf() {},
    };

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
                return { Notice, Plugin, Modal, ItemView, Setting, Menu, PluginSettingTab: class {}, FuzzySuggestModal: class {
                    constructor(app) { this.app = app; }
                    open() { options.pick(this); }
                    onClose() {}
                } };
            }
            if (name === "fs" && options.filesystem) return options.filesystem;
            if (name === "os") {
                assert.ok(options.fixtureDir, "同步测试须配置隔离目录");
                return {
                    ...os,
                    homedir: () => path.join(options.fixtureDir, "home"),
                    tmpdir: () => path.join(options.fixtureDir, "backups"),
                };
            }
            return require(name);
        },
        process: { platform: process.platform, env: { TEST_MODEL_API_KEY: "test-key", TEST_GH_TOKEN: "ghp-test-token", ...(options.env || {}) } },
        console: { log() {}, error: (error) => assert.fail(String(error)) },
        fetch: options.fetch,
        Buffer, TextDecoder, URL, URLSearchParams, AbortController,
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
        async closeWorkspace() {
            for (const leaf of leaves.slice()) await leaf.detach();
        },
    };
}

test("总结与翻译分别注册，快捷键由使用者绑定", async () => {
    const { commands } = await loadPlugin({});
    assert.deepEqual(commands.map(({ id }) => id), [
        "summarize-note",
        "translate-selection",
        "sync-instructions",
        "manage-skills",
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

    await plugin.invoke("sync-instructions");

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

    await plugin.closeWorkspace();
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
    await plugin.invoke("sync-instructions");
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
    await plugin.closeWorkspace();

    const merged = [read(typeSource), read(target)];
    await plugin.invoke("sync-instructions");
    await button("撤销上次操作").onclick();
    await tick();
    assert.deepEqual([read(typeSource), read(target), read(typeStatePath)], beforeMerge);
    await plugin.closeWorkspace();
    write(typeSource, merged[0]);
    write(target, "# 工作规范\n来自目标的更新\n" + projectBody);
    await plugin.invoke("sync-instructions");
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
    await plugin.closeWorkspace();
    assert.equal(plugin.body.children.length, 0);

    // The undo slot survives closing the panel and refuses to silently overwrite later edits.
    await plugin.invoke("sync-instructions");
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
    await plugin.closeWorkspace();

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

    await plugin.invoke("sync-instructions");
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
    await plugin.closeWorkspace();
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

    await plugin.invoke("sync-instructions");

    // 初始时第一级有待处理项，默认停在第一级；手动切换到 Work 类型并设置滚动位置。
    const workspaceEl = plugin.body.children[0];
    const scrollContainer = workspaceEl.children[0].children[1].children[0].children[0];
    assert.match(tabStartingWith("第一级：用户级指令").style.cssText, /font-weight:600/);
    tabStartingWith("第二级：Work 类型").onclick();
    scrollContainer.scrollTop = 120;

    const assertStayedInWorkTab = (expectedTabText) => {
        assert.equal(plugin.body.children[0], workspaceEl);
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

    // 5. 一键分发与撤销均在原地刷新，不重建工作区标签页。
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

    await plugin.closeWorkspace();
    assert.equal(plugin.body.children.length, 0);
});


test("设置页支持技能分发目标与 GitHub 凭据变量校验和保存", async () => {
    const saved = [];
    const notices = [];
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-skill-settings-"));
    try {
        const app = { vault: { adapter: { getBasePath: () => fixtureDir }, getMarkdownFiles: () => [] } };
        const { plugin } = await loadPlugin(app, { notices, save: value => saved.push(value) });
        assert.deepEqual({ ...plugin.settings.skillUserTargets }, {
            Claude: "~/.claude/skills",
            Antigravity: "~/.gemini/config/skills",
        });
        assert.deepEqual({ ...plugin.settings.skillProjectTargets }, { Claude: ".claude/skills" });
        assert.equal(plugin.settings.githubCredentialVariable, "");

        const tab = plugin.settingTab;
        const root = tab.containerEl = new Element("div");
        tab.display();
        const nodes = predicate => findElements(root, predicate);
        const button = (text, index = 0) => nodes(el => el.tag === "button" && el.textContent === text)[index];
        const fields = label => nodes(el => el.getAttribute("aria-label") === label);

        // 项目级目标禁止填为 .agents/skills 本身
        fields("相对技能目录")[0].value = ".agents/skills";
        await button("保存设置").onclick();
        assert.equal(saved.length, 0);
        assert.equal(fields("相对技能目录")[0].getAttribute("aria-invalid"), "true");

        fields("相对技能目录")[0].value = ".claude/skills";
        fields("GitHub 凭据环境变量名")[0].value = "invalid-var";
        await button("保存设置").onclick();
        assert.equal(saved.length, 0);
        assert.ok(fields("GitHub 凭据环境变量名")[0].closest("details").open);

        fields("GitHub 凭据环境变量名")[0].value = "TEST_GH_TOKEN";
        button("添加目标", 1).onclick();
        fields("工具名称")[2].value = "CustomTool";
        fields("技能目录")[2].value = "~/custom-skills";
        await button("保存设置").onclick();

        assert.equal(saved.length, 1);
        assert.equal(saved[0].skillUserTargets.CustomTool, "~/custom-skills");
        assert.equal(saved[0].githubCredentialVariable, "TEST_GH_TOKEN");
        assert.deepEqual(notices, ["设置已保存。"]);
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test("技能管理支持工作区切换、检查、自建编辑、逐个分发、整目录转换及 GitHub 更新与撤销", async (t) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-skills-e2e-"));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

    const vaultRoot = path.join(fixtureDir, "vault");
    const syncDir = path.join(vaultRoot, ".obsidian", "plugins", "agents-manager", "sync");
    const homeDir = path.join(fixtureDir, "home");
    const userSkillsRoot = path.join(homeDir, ".agents", "skills");
    const claudeUserSkills = path.join(homeDir, ".claude", "skills");
    const antigravityUserSkills = path.join(homeDir, ".gemini", "config", "skills");

    const projARoot = path.join(fixtureDir, "proj-a");
    const projBRoot = path.join(fixtureDir, "proj-b");
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    };
    const read = (file) => fs.readFileSync(file, "utf8");
    const tick = () => new Promise(resolve => setImmediate(resolve));

    write(path.join(vaultRoot, "用户指令.md"), "用户规则\n");
    write(path.join(vaultRoot, "Work模板.md"), "# 规范\n工作规则\n# 示例\n示例\n");
    write(path.join(vaultRoot, "Code模板.md"), "# 规范\n代码规则\n# 示例\n示例\n");
    write(path.join(projARoot, "AGENTS.md"), "# 规范\n工作规则\n# 项目\nA\n");
    write(path.join(projBRoot, "AGENTS.md"), "# 规范\n代码规则\n# 项目\nB\n");
    write(path.join(syncDir, "instruction-projects.json"), JSON.stringify({
        version: 1,
        projects: [
            { name: "项目A", type: "work", path: path.join(projARoot, "AGENTS.md") },
            { name: "项目B", type: "code", path: path.join(projBRoot, "AGENTS.md") },
        ],
    }));

    // 用户级技能与忽略项
    const alphaSkillMd = path.join(userSkillsRoot, "alpha-skill", "SKILL.md");
    write(alphaSkillMd, "---\nname: alpha-skill\ndescription: Alpha 技能说明。\n---\n\n# Alpha\n初始正文\n");
    write(path.join(userSkillsRoot, "Bad_Name", "SKILL.md"), "---\nname: wrong-name\n---\n\n# Bad\n");
    write(path.join(userSkillsRoot, "Bad_Name", "agents", "openai.yaml"), "name: bad\n");
    write(path.join(userSkillsRoot, "conflict-skill", "SKILL.md"), "---\nname: conflict-skill\ndescription: 冲突样例。\n---\n");
    write(path.join(userSkillsRoot, "gog", "SKILL.md"), "---\nname: gog\ndescription: Google CLI 技能。\n---\n旧版本\n");
    write(path.join(userSkillsRoot, "gog", "stale.txt"), "待删除旧文件\n");
    write(path.join(userSkillsRoot, ".hidden-dir", "SKILL.md"), "---\nname: hidden\ndescription: ignore\n---\n");
    write(path.join(userSkillsRoot, "not-a-skill", "README.md"), "无 SKILL.md\n");

    // 项目A有技能，项目B为空技能目录（不应显示）
    write(path.join(projARoot, ".agents", "skills", "proj-skill", "SKILL.md"),
        "---\nname: proj-skill\ndescription: 项目A专属技能。\n---\n");
    fs.mkdirSync(path.join(projBRoot, ".agents", "skills"), { recursive: true });

    // Claude 用户级预设为整目录链接；Antigravity 用户级存在冲突实体目录和失效链接
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.mkdirSync(path.dirname(claudeUserSkills), { recursive: true });
    fs.symlinkSync(userSkillsRoot, claudeUserSkills, linkType);

    fs.mkdirSync(path.join(antigravityUserSkills, "conflict-skill"), { recursive: true });
    write(path.join(antigravityUserSkills, "conflict-skill", "keep.txt"), "不能覆盖\n");
    const danglingTarget = path.join(userSkillsRoot, "old-removed");
    fs.mkdirSync(danglingTarget, { recursive: true });
    fs.symlinkSync(danglingTarget, path.join(antigravityUserSkills, "old-removed"), linkType);
    fs.rmSync(danglingTarget, { recursive: true, force: true });

    const binaryBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const fetchCalls = [];
    const notices = [];

    const plugin = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: { adapter: { getBasePath: () => vaultRoot } },
    }, {
        fixtureDir,
        notices,
        settings: {
            userSource: "用户指令.md",
            workSource: "Work模板.md",
            codeSource: "Code模板.md",
            targets: {},
            githubCredentialVariable: "TEST_GH_TOKEN",
        },
        async fetch(url, req) {
            fetchCalls.push({ url, auth: req?.headers?.Authorization });
            if (url.includes("/commits?")) {
                assert.equal(url.includes("sha="), false);
                assert.equal(url.includes("path=.agents%2Fskills%2Fgog"), true);
                assert.equal(req.headers.Authorization, "Bearer ghp-test-token");
                return {
                    ok: true,
                    json: async () => [{
                        sha: "2222222222222222222222222222222222222222",
                        commit: { message: "feat: update gog", committer: { date: "2026-11-26T10:00:00Z" } },
                    }],
                };
            }
            if (url.includes("/git/trees/2222222222222222222222222222222222222222")) {
                return {
                    ok: true,
                    json: async () => ({
                        truncated: false,
                        tree: [
                            { type: "blob", path: ".agents/skills/gog/SKILL.md", sha: "blob-md" },
                            { type: "blob", path: ".agents/skills/gog/assets/icon.bin", sha: "blob-bin" },
                            { type: "blob", path: ".agents/skills/gog/.github/workflows/ci.yml", sha: "blob-ci" },
                            { type: "blob", path: ".agents/skills/gog/agents/openai.yaml", sha: "blob-oa" },
                        ],
                    }),
                };
            }
            if (url.endsWith("/git/blobs/blob-md")) {
                return {
                    ok: true,
                    arrayBuffer: async () => Buffer.from("---\nname: gog\ndescription: 新版 Google CLI。\n---\n新版本\n"),
                };
            }
            if (url.endsWith("/git/blobs/blob-bin")) {
                return { ok: true, arrayBuffer: async () => binaryBytes };
            }
            assert.fail("未预期的请求：" + url);
        },
    });

    const button = (label) => {
        const items = findElements(plugin.body, node => node.tag === "button" && node.textContent === label);
        assert.ok(items.length > 0, label);
        return items[0];
    };
    const textIncludes = (snippet) => findElements(plugin.body, node => node.textContent?.includes(snippet));

    // 1. 打开「技能管理」，验证同一标签页复用及栏目切换
    await plugin.invoke("manage-skills");
    assert.equal(plugin.plugin.app.workspace.getLeavesOfType("agents-manager-workspace").length, 1);
    assert.equal(button("技能管理").getAttribute("aria-selected"), "true");

    await plugin.invoke("sync-instructions");
    assert.equal(plugin.plugin.app.workspace.getLeavesOfType("agents-manager-workspace").length, 1);
    assert.equal(button("指令同步").getAttribute("aria-selected"), "true");

    await plugin.invoke("manage-skills");
    assert.equal(plugin.plugin.app.workspace.getLeavesOfType("agents-manager-workspace").length, 1);
    assert.equal(button("技能管理").getAttribute("aria-selected"), "true");

    // 2. 验证扫描结果：项目A显示，项目B（空）隐藏，.hidden-dir 与 not-a-skill 不显示，规范问题准确报出
    const skillsHost = plugin.body.children[0].children[0].children[1].children[1];
    const skillsTextIncludes = (snippet) => findElements(skillsHost, node => node.textContent?.includes(snippet));
    const sButton = (label) => {
        for (const modal of plugin.body.children.slice(1).reverse()) {
            const hit = findElements(modal, node => node.tag === "button" && node.textContent === label);
            if (hit.length) return hit[0];
        }
        const inTab = findElements(skillsHost, node => node.tag === "button" && node.textContent === label);
        assert.ok(inTab.length > 0, label);
        return inTab[0];
    };
    assert.ok(skillsTextIncludes("用户级技能（4）").length > 0);
    assert.ok(skillsTextIncludes("项目A（1）").length > 0);
    assert.equal(skillsTextIncludes("项目B").length, 0);
    assert.equal(skillsTextIncludes("hidden-dir").length, 0);
    assert.equal(skillsTextIncludes("not-a-skill").length, 0);
    assert.ok(skillsTextIncludes("name 与目录名不一致（wrong-name）").length > 0);
    assert.ok(skillsTextIncludes("目录名不符合小写 kebab-case").length > 0);
    assert.ok(skillsTextIncludes("缺少 description").length > 0);
    assert.ok(skillsTextIncludes("包含 agents/openai.yaml").length > 0);

    // 3. 自建技能编辑与撤销
    sButton("编辑 SKILL.md").onclick();
    const editor = findElements(plugin.body, node => node.tag === "textarea")[0];
    assert.match(editor.value, /初始正文/);
    editor.value = "---\nname: alpha-skill\ndescription: 修改后的 Alpha 说明。\n---\n\n# Alpha\n新版正文\n";
    editor.oninput();
    await sButton("保存").onclick();
    assert.match(read(alphaSkillMd), /新版正文/);
    assert.ok(skillsTextIncludes("修改后的 Alpha 说明。").length > 0);

    await sButton("撤销上次操作").onclick();
    await tick();
    assert.match(read(alphaSkillMd), /初始正文/);

    // 4. 失效链接清理 + 单技能分发 + 取消链接 + 一键分发 + 整目录转换
    assert.ok(skillsTextIncludes("失效链接（1）").length > 0);
    await sButton("清理").onclick();
    assert.equal(fs.lstatSync(path.join(antigravityUserSkills, "old-removed"), { throwIfNoEntry: false }), undefined);

    await sButton("分发").onclick();
    const alphaLink = path.join(antigravityUserSkills, "alpha-skill");
    assert.ok(fs.lstatSync(alphaLink).isSymbolicLink());

    await sButton("取消链接").onclick();
    assert.equal(fs.lstatSync(alphaLink, { throwIfNoEntry: false }), undefined);
    assert.equal(fs.existsSync(alphaSkillMd), true);

    await sButton("一键分发").onclick();
    assert.ok(fs.lstatSync(alphaLink).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(projARoot, ".claude", "skills", "proj-skill")).isSymbolicLink());
    // 整目录链接的 Claude 不得向 ~/.agents/skills 内写入循环子链接
    assert.equal(fs.lstatSync(path.join(userSkillsRoot, "alpha-skill", "alpha-skill"), { throwIfNoEntry: false }), undefined);
    // 冲突实体目录保持原样
    assert.equal(read(path.join(antigravityUserSkills, "conflict-skill", "keep.txt")), "不能覆盖\n");

    await sButton("撤销上次操作").onclick();
    await tick();
    assert.equal(fs.lstatSync(alphaLink, { throwIfNoEntry: false }), undefined);

    // 整目录链接转为逐个链接并验证撤销及非链接文件保护
    const convertPromise = sButton("转为逐个链接").onclick();
    await tick();
    sButton("确认转换").onclick();
    await convertPromise;
    await tick();
    assert.equal(fs.lstatSync(claudeUserSkills).isSymbolicLink(), false);
    assert.ok(fs.statSync(claudeUserSkills).isDirectory());
    assert.ok(fs.lstatSync(path.join(claudeUserSkills, "alpha-skill")).isSymbolicLink());
    assert.equal(fs.existsSync(alphaSkillMd), true);

    await sButton("撤销上次操作").onclick();
    await tick();
    assert.ok(fs.lstatSync(claudeUserSkills).isSymbolicLink());

    // 再次转换并放入真实文件后，撤销必须拒绝执行以免误删用户文件
    const convertAgain = sButton("转为逐个链接").onclick();
    await tick();
    sButton("确认转换").onclick();
    await convertAgain;
    await tick();
    write(path.join(claudeUserSkills, "user-note.txt"), "用户自建文件");
    const failedUndo = sButton("撤销上次操作").onclick();
    await tick();
    assert.ok(textIncludes("目标目录内存在非软链接的文件或目录").length > 0);
    assert.equal(read(path.join(claudeUserSkills, "user-note.txt")), "用户自建文件");
    sButton("关闭").onclick();
    await failedUndo;

    // 5. GitHub 来源设置（含 @ commit 粘贴格式）、检查更新、直接更新与撤销
    const sourceButtons = findElements(skillsHost, node => node.tag === "button" && node.textContent === "设置来源");
    assert.equal(sourceButtons.length, 5);
    sourceButtons[3].onclick(); // 用户级 gog 排在 alpha-skill, Bad_Name, conflict-skill 之后
    const modeSelect = findElements(plugin.body, node => node.getAttribute("aria-label") === "来源类型")[0];
    modeSelect.value = "github";
    modeSelect.onchange();
    findElements(plugin.body, node => node.getAttribute("aria-label") === "GitHub 上游地址")[0].value =
        "https://github.com/openclaw/gogcli/tree/1111111111111111111111111111111111111111/.agents/skills/gog @ 1111111111111111111111111111111111111111";
    await sButton("保存").onclick();
    assert.ok(skillsTextIncludes("GitHub · 1111111").length > 0);
    assert.equal(findElements(skillsHost, node => node.tag === "button" && node.textContent === "编辑 SKILL.md").length, 4);
    assert.equal(findElements(skillsHost, node => node.tag === "button" && node.textContent === "查看 SKILL.md").length, 1);

    await sButton("检查更新").onclick();
    assert.ok(skillsTextIncludes("发现新版本：2222222").length > 0);

    // 点击「更新」直接更新（无安全确认弹窗）
    await sButton("更新").onclick();
    assert.match(read(path.join(userSkillsRoot, "gog", "SKILL.md")), /新版 Google CLI/);
    assert.deepEqual(fs.readFileSync(path.join(userSkillsRoot, "gog", "assets", "icon.bin")), binaryBytes);
    assert.equal(fs.existsSync(path.join(userSkillsRoot, "gog", ".github")), false);
    assert.equal(fs.existsSync(path.join(userSkillsRoot, "gog", "agents", "openai.yaml")), false);
    assert.equal(fs.existsSync(path.join(userSkillsRoot, "gog", "stale.txt")), false);
    const savedSources = JSON.parse(read(path.join(syncDir, "skills-sources.json")));
    assert.equal(savedSources.skills["user/gog"].commit, "2222222222222222222222222222222222222222");

    // 撤销 GitHub 更新，恢复旧文件与旧 commit 基线
    await sButton("撤销上次操作").onclick();
    await tick();
    assert.match(read(path.join(userSkillsRoot, "gog", "SKILL.md")), /旧版本/);
    assert.equal(read(path.join(userSkillsRoot, "gog", "stale.txt")), "待删除旧文件\n");
    assert.equal(fs.existsSync(path.join(userSkillsRoot, "gog", "assets", "icon.bin")), false);
    const restoredSources = JSON.parse(read(path.join(syncDir, "skills-sources.json")));
    assert.equal(restoredSources.skills["user/gog"].commit, "1111111111111111111111111111111111111111");

    await plugin.closeWorkspace();
    assert.equal(plugin.body.children.length, 0);
});
