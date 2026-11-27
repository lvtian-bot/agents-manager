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
        const options = { notices, save: value => saved.push(value), pick: picker => {
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
        assert.equal(nodes(element => element.textContent === "用户指令目标").length, 0);
        assert.equal(nodes(element => element.tag === "button" && element.textContent === "添加目标").length, 0);
        assert.equal(fields("移除 Claude").length, 0);
        assert.equal(fields("提示词笔记")[0].value, "旧模板.md");
        assert.equal(fields("总结模式")[0].value, "multiple");
        assert.equal(fields("模型接口")[0].value, "https://legacy.example.org/v1/chat/completions");
        assert.equal(fields("模型名称")[0].value, "saved-model");
        assert.equal(fields("凭据环境变量名")[0].value, "SAVED_API_KEY");
        assert.ok(nodes(element => element.tag === "details").every(element => !element.open));
        fields("选择未匹配时使用的提示词")[0].onclick();
        assert.equal(fields("未匹配时使用的提示词")[0].value, "模板/摘要.md");
        fields("模型接口")[0].value = "无效地址";
        await save();
        assert.ok(fields("模型接口")[0].closest("details").open);
        assert.equal(saved.length, 0);
        assert.equal(plugin.settings.defaultTemplate, "");
        fields("模型接口")[0].value = "https://example.org/v1/chat/completions";
        await save();
        assert.equal(saved.length, 1);
        assert.equal(saved[0].targets.Codex, "~/.codex/AGENTS.md");
        assert.equal(saved[0].targets.Claude, "~/.claude/CLAUDE.md");
        assert.equal(saved[0].extra, 7);
        assert.equal(saved[0].model, "saved-model");
        assert.equal(saved[0].credentialVariable, "SAVED_API_KEY");
        assert.deepEqual(notices, ["设置已保存。"]);
        tab.display();
        assert.equal(fields("未匹配时使用的提示词")[0].value, "模板/摘要.md");
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


test("设置页仅保留 GitHub 凭据变量校验和保存，且不覆写技能分发目标", async () => {
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

        assert.equal(fields("技能目录").length, 0);
        assert.equal(fields("相对技能目录").length, 0);

        fields("GitHub 凭据环境变量名")[0].value = "invalid-var";
        await button("保存设置").onclick();
        assert.equal(saved.length, 0);
        assert.ok(fields("GitHub 凭据环境变量名")[0].closest("details").open);

        fields("GitHub 凭据环境变量名")[0].value = "TEST_GH_TOKEN";
        await button("保存设置").onclick();

        assert.equal(saved.length, 1);
        assert.deepEqual({ ...saved[0].skillUserTargets }, {
            Claude: "~/.claude/skills",
            Antigravity: "~/.gemini/config/skills",
        });
        assert.deepEqual({ ...saved[0].skillProjectTargets }, { Claude: ".claude/skills" });
        assert.equal(saved[0].githubCredentialVariable, "TEST_GH_TOKEN");
        assert.deepEqual(notices, ["设置已保存。"]);
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test("指令同步第一级可在页面内添加与移出用户指令目标", async (t) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-layer1-targets-"));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

    const vaultRoot = path.join(fixtureDir, "vault");
    const homeDir = path.join(fixtureDir, "home");
    const codexTarget = path.join(homeDir, ".codex", "AGENTS.md");
    const customTarget = path.join(homeDir, "custom.md");
    fs.mkdirSync(vaultRoot, { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, "用户指令.md"), "用户指令内容\n", "utf8");
    fs.mkdirSync(path.dirname(codexTarget), { recursive: true });
    fs.writeFileSync(codexTarget, "旧目标内容\n", "utf8");

    const saved = [];
    const notices = [];
    let choices = [];
    const tick = () => new Promise(resolve => setImmediate(resolve));

    const plugin = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: { adapter: { getBasePath: () => vaultRoot } },
    }, {
        fixtureDir,
        notices,
        save: value => saved.push(value),
        menu: items => { choices = items; },
        settings: {
            userSource: "用户指令.md",
            targets: {},
        },
    });

    const instructionsHost = () => plugin.body.children[0].children[0].children[1].children[0];
    const buttonIn = (label) => {
        for (const modal of plugin.body.children.slice(1).reverse()) {
            const hit = findElements(modal, node => node.tag === "button" && node.textContent === label);
            if (hit.length) return hit[0];
        }
        const hit = findElements(instructionsHost(), node => node.tag === "button" && node.textContent === label);
        assert.ok(hit.length > 0, label);
        return hit[0];
    };
    const removeButton = (name) => findElements(instructionsHost(), node => node.getAttribute("aria-label") === "移出 " + name);

    await plugin.invoke("sync-instructions");
    assert.ok(findElements(instructionsHost(), n => n.textContent?.includes("尚未添加用户指令目标，可点击上方「添加目标」选择要分发的工具。")).length > 0);
    assert.equal(buttonIn("添加目标").disabled, false);

    // 打开菜单并添加 Codex
    buttonIn("添加目标").onclick();
    assert.equal(choices.length, 6);
    assert.equal(choices[0].title, "Codex");
    await choices[0].action();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].targets.Codex, "~/.codex/AGENTS.md");
    assert.equal(notices.at(-1), "已添加用户指令目标：Codex");
    assert.equal(removeButton("Codex").length, 1);

    // 取消移出保留目标；确认移出后持久化删除且不删文件
    const cancelRemove = removeButton("Codex")[0].onclick();
    await tick();
    assert.ok(findElements(plugin.body, n => n.textContent?.includes("将把 Codex 从用户指令分发列表移出")).length > 0);
    buttonIn("取消").onclick();
    await cancelRemove;
    assert.equal(removeButton("Codex").length, 1);

    const confirmRemove = removeButton("Codex")[0].onclick();
    await tick();
    buttonIn("移出列表").onclick();
    await confirmRemove;
    await tick();
    assert.equal(saved.at(-1).targets.Codex, undefined);
    assert.equal(fs.existsSync(codexTarget), true);
    assert.equal(notices.at(-1), "已将 Codex 移出用户指令分发列表（目标文件未改动）。");
    assert.equal(removeButton("Codex").length, 0);

    // 添加全部 6 个内置目标后「添加目标」置灰，同时保留已有自定义目标
    plugin.plugin.settings.targets = { 自定义: "~/custom.md" };
    fs.writeFileSync(customTarget, "自定义内容\n", "utf8");
    await buttonIn("刷新").onclick();
    assert.equal(removeButton("自定义").length, 1);

    for (let i = 0; i < 6; i++) {
        buttonIn("添加目标").onclick();
        assert.ok(choices.length > 0);
        await choices[0].action();
    }
    assert.equal(buttonIn("添加目标").disabled, true);
    assert.equal(removeButton("自定义").length, 1);

    await plugin.closeWorkspace();
});

test("技能管理可在页面内弹窗维护用户级与项目级分发目标并校验输入", async (t) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-skills-targets-modal-"));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

    const vaultRoot = path.join(fixtureDir, "vault");
    const syncDir = path.join(vaultRoot, ".obsidian", "plugins", "agents-manager", "sync");
    const homeDir = path.join(fixtureDir, "home");
    const userSkillsRoot = path.join(homeDir, ".agents", "skills");
    const otherProjRoot = path.join(fixtureDir, "other-proj");

    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
    };
    write(path.join(userSkillsRoot, "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 示例\n---\n");
    write(path.join(vaultRoot, ".agents", "skills", "vault-skill", "SKILL.md"), "---\nname: vault-skill\ndescription: 仓库技能\n---\n");
    write(path.join(otherProjRoot, "AGENTS.md"), "# 规范\n规则\n# 项目\n其他\n");
    write(path.join(otherProjRoot, ".agents", "skills", "other-skill", "SKILL.md"), "---\nname: other-skill\ndescription: 其他\n---\n");
    write(path.join(syncDir, "instruction-projects.json"), JSON.stringify({
        version: 1,
        projects: [{ name: "其他项目", type: "work", path: path.join(otherProjRoot, "AGENTS.md") }],
    }));

    const saved = [];
    const notices = [];
    const plugin = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: { adapter: { getBasePath: () => vaultRoot }, getName: () => "当前仓库" },
    }, {
        fixtureDir,
        notices,
        save: value => saved.push(value),
    });

    const skillsHost = () => plugin.body.children[0].children[0].children[1].children[1];
    const currentModal = () => plugin.body.children.at(-1);
    const sButton = (label, index = 0) => {
        for (const modal of plugin.body.children.slice(1).reverse()) {
            const hit = findElements(modal, node => node.tag === "button" && node.textContent === label);
            if (hit.length) return hit[index] || hit[0];
        }
        const hit = findElements(skillsHost(), node => node.tag === "button" && node.textContent === label);
        assert.ok(hit.length > index, label);
        return hit[index];
    };
    const modalFields = (label) => findElements(currentModal(), node => node.getAttribute("aria-label") === label);

    await plugin.invoke("manage-skills");

    // 1. 用户级管理分发目标：校验相对路径与重复工具名，成功后刷新，清空后展示新空态提示
    sButton("管理分发目标").onclick();
    assert.ok(findElements(currentModal(), n => n.textContent?.includes("管理用户级技能分发目标")).length > 0);
    sButton("添加目标").onclick();
    modalFields("工具名称")[2].value = "Claude";
    modalFields("技能目录")[2].value = "~/dup-claude";
    await sButton("保存").onclick();
    assert.equal(saved.length, 0);
    assert.equal(modalFields("工具名称")[2].getAttribute("aria-invalid"), "true");

    modalFields("工具名称")[2].value = "CustomTool";
    modalFields("技能目录")[2].value = "relative/path";
    await sButton("保存").onclick();
    assert.equal(saved.length, 0);
    assert.equal(modalFields("技能目录")[2].getAttribute("aria-invalid"), "true");

    modalFields("技能目录")[2].value = "~/custom-skills";
    await sButton("保存").onclick();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].skillUserTargets.CustomTool, "~/custom-skills");
    assert.equal(notices.at(-1), "已更新用户级技能分发目标。");
    assert.ok(findElements(skillsHost(), n => n.textContent?.includes("CustomTool")).length > 0);

    // 清空用户级目标
    sButton("管理分发目标").onclick();
    while (modalFields("工具名称").length) sButton("移除").onclick();
    await sButton("保存").onclick();
    assert.deepEqual({ ...saved.at(-1).skillUserTargets }, {});
    assert.ok(findElements(skillsHost(), n => n.textContent?.includes("尚未配置分发目标，可点击上方「管理分发目标」添加。")).length > 0);

    // 2. 项目级管理分发目标：标明对所有项目生效、拒绝 .agents/skills、保存后对所有项目共同生效
    sButton("当前仓库（1）").onclick();
    sButton("管理分发目标", 1).onclick();
    assert.ok(findElements(currentModal(), n => n.textContent?.includes("管理项目级技能分发目标（对所有项目生效）")).length > 0);
    modalFields("相对技能目录")[0].value = ".agents/skills";
    await sButton("保存").onclick();
    assert.equal(saved.length, 2);
    assert.equal(modalFields("相对技能目录")[0].getAttribute("aria-invalid"), "true");

    modalFields("相对技能目录")[0].value = ".claude/skills";
    sButton("添加目标").onclick();
    modalFields("工具名称")[1].value = "Cursor";
    modalFields("相对技能目录")[1].value = ".cursor/skills";
    await sButton("保存").onclick();
    assert.equal(saved.length, 3);
    assert.equal(saved[2].skillProjectTargets.Cursor, ".cursor/skills");
    assert.equal(notices.at(-1), "已更新项目级技能分发目标（对所有项目生效）。");

    // 切换到「其他项目」也已出现 Cursor 分发目标
    sButton("其他项目（1）").onclick();
    assert.ok(findElements(skillsHost(), n => n.textContent?.includes(".cursor")).length > 0);

    await plugin.closeWorkspace();
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


test("PR 审查回归：并发编辑不回滚外部改动、GitHub 更新保留权限与类型转换且拒绝内部软链接", async (t) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-skills-review-"));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

    const vaultRoot = path.join(fixtureDir, "vault");
    const syncDir = path.join(vaultRoot, ".obsidian", "plugins", "agents-manager", "sync");
    const homeDir = path.join(fixtureDir, "home");
    const userSkillsRoot = path.join(homeDir, ".agents", "skills");
    const outsideDir = path.join(fixtureDir, "outside");
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
    };
    const read = (file) => fs.readFileSync(file, "utf8");
    const tick = () => new Promise(resolve => setImmediate(resolve));

    const selfMd = path.join(userSkillsRoot, "self-skill", "SKILL.md");
    write(selfMd, "---\nname: self-skill\ndescription: 原说明\n---\n原正文\n");

    const ghDir = path.join(userSkillsRoot, "gh-skill");
    write(path.join(ghDir, "SKILL.md"), "---\nname: gh-skill\ndescription: 旧版\n---\n旧内容\n");
    write(path.join(ghDir, "references"), "原本是普通文件\n");
    write(path.join(ghDir, "nested", "item.md"), "原本在子目录里\n");
    write(path.join(outsideDir, "run.sh"), "外部文件不应被覆盖\n");

    write(path.join(syncDir, "skills-sources.json"), JSON.stringify({
        version: 1,
        skills: {
            "user/gh-skill": {
                kind: "github",
                url: "https://github.com/example/repo/tree/main/gh-skill",
                commit: "1111111111111111111111111111111111111111",
            },
        },
    }));

    const chmodCalls = [];
    const filesystem = {
        ...fs,
        chmodSync(target, mode) {
            chmodCalls.push({ target, mode });
            return fs.chmodSync(target, mode);
        },
    };

    const plugin = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: { adapter: { getBasePath: () => vaultRoot } },
    }, {
        fixtureDir,
        filesystem,
        notices: [],
        settings: {
            skillUserTargets: {},
            skillProjectTargets: {},
        },
        async fetch(url) {
            if (url.includes("/commits?")) {
                return {
                    ok: true,
                    json: async () => [{
                        sha: "3333333333333333333333333333333333333333",
                        commit: { message: "feat: convert types", committer: { date: "2026-11-26T15:00:00Z" } },
                    }],
                };
            }
            if (url.includes("/git/trees/")) {
                return {
                    ok: true,
                    json: async () => ({
                        truncated: false,
                        tree: [
                            { type: "blob", path: "gh-skill/SKILL.md", sha: "b1", mode: "100644" },
                            { type: "blob", path: "gh-skill/references/guide.md", sha: "b2", mode: "100644" },
                            { type: "blob", path: "gh-skill/nested", sha: "b3", mode: "100644" },
                            { type: "blob", path: "gh-skill/scripts/run.sh", sha: "b4", mode: "100755" },
                        ],
                    }),
                };
            }
            if (url.endsWith("/gh-skill/SKILL.md")) return { ok: true, arrayBuffer: async () => Buffer.from("---\nname: gh-skill\ndescription: 新版\n---\n新内容\n") };
            if (url.endsWith("/gh-skill/references/guide.md")) return { ok: true, arrayBuffer: async () => Buffer.from("新目录内指南\n") };
            if (url.endsWith("/gh-skill/nested")) return { ok: true, arrayBuffer: async () => Buffer.from("新普通文件\n") };
            if (url.endsWith("/gh-skill/scripts/run.sh")) return { ok: true, arrayBuffer: async () => Buffer.from("#!/bin/sh\necho ok\n") };
            assert.fail("未预期的请求：" + url);
        },
    });

    const skillsHost = () => plugin.body.children[0].children[0].children[1].children[1];
    const sButton = (label) => {
        for (const modal of plugin.body.children.slice(1).reverse()) {
            const hit = findElements(modal, node => node.tag === "button" && node.textContent === label);
            if (hit.length) return hit[0];
        }
        const inTab = findElements(skillsHost(), node => node.tag === "button" && node.textContent === label);
        assert.ok(inTab.length > 0, label);
        return inTab[0];
    };

    await plugin.invoke("manage-skills");

    // 1. 并发编辑：前置检查失败绝不能用旧内容覆盖外部修改，也不残留 pending 记录
    sButton("编辑 SKILL.md").onclick();
    const editor = findElements(plugin.body, node => node.tag === "textarea")[0];
    editor.value = "---\nname: self-skill\ndescription: 弹窗修改\n---\n弹窗内容\n";
    write(selfMd, "---\nname: self-skill\ndescription: 外部最新\n---\n外部最新正文\n");
    const saveFail = sButton("保存").onclick();
    await tick();
    assert.ok(findElements(plugin.body, node => node.textContent?.includes("文件已发生变化")).length > 0);
    sButton("关闭").onclick();
    await saveFail;
    sButton("取消").onclick();
    assert.match(read(selfMd), /外部最新正文/);
    assert.equal(fs.existsSync(path.join(syncDir, "skills-pending-operation.json")), false);
    assert.equal(fs.existsSync(path.join(syncDir, "skills-last-operation.json")), false);

    // 2. 技能内部存在软链接（指向外部目录）时拒绝 GitHub 更新，外部文件与撤销槽均不受影响
    const linkType = process.platform === "win32" ? "junction" : "dir";
    const scriptsLink = path.join(ghDir, "scripts");
    fs.symlinkSync(outsideDir, scriptsLink, linkType);
    const blockedUpdate = sButton("更新").onclick();
    await tick();
    assert.ok(findElements(plugin.body, node => node.textContent?.includes("技能目录内包含软链接")).length > 0);
    sButton("关闭").onclick();
    await blockedUpdate;
    assert.equal(read(path.join(outsideDir, "run.sh")), "外部文件不应被覆盖\n");
    assert.equal(fs.existsSync(path.join(syncDir, "skills-pending-operation.json")), false);
    assert.equal(fs.existsSync(path.join(syncDir, "skills-last-operation.json")), false);
    fs.unlinkSync(scriptsLink);

    // 3. 移除阻挡软链接后更新：文件<->目录双向转换成功且脚本保留 0o755 权限，撤销也能反向恢复
    await sButton("更新").onclick();
    assert.equal(read(path.join(ghDir, "references", "guide.md")), "新目录内指南\n");
    assert.equal(read(path.join(ghDir, "nested")), "新普通文件\n");
    assert.equal(read(path.join(ghDir, "scripts", "run.sh")), "#!/bin/sh\necho ok\n");
    const runShChmod = chmodCalls.find(item => item.target === path.join(ghDir, "scripts", "run.sh"));
    assert.equal(runShChmod?.mode, 0o755);
    const opRecord = JSON.parse(read(path.join(syncDir, "skills-last-operation.json")));
    assert.equal(opRecord.afterFiles.find(file => file.rel === "scripts/run.sh").mode, 0o755);

    await sButton("撤销上次操作").onclick();
    await tick();
    assert.equal(read(path.join(ghDir, "references")), "原本是普通文件\n");
    assert.equal(read(path.join(ghDir, "nested", "item.md")), "原本在子目录里\n");
    assert.equal(fs.existsSync(path.join(ghDir, "scripts", "run.sh")), false);

    await plugin.closeWorkspace();
});


test("PR 第二轮审查回归：链接改向撤销提示、源设置变更拦截及测试库隔离用户技能目标", async (t) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-round2-"));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

    const vaultRoot = path.join(fixtureDir, "vault");
    const syncDir = path.join(vaultRoot, ".obsidian", "plugins", "agents-manager", "sync");
    const homeDir = path.join(fixtureDir, "home");
    const userSkillsRoot = path.join(homeDir, ".agents", "skills");
    const claudeUserSkills = path.join(homeDir, ".claude", "skills");
    const userTarget = path.join(homeDir, ".codex", "AGENTS.md");
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
    };
    const read = (file) => fs.readFileSync(file, "utf8");
    const tick = () => new Promise(resolve => setImmediate(resolve));

    write(path.join(vaultRoot, "A.md"), "源 A 内容\n");
    write(path.join(vaultRoot, "B.md"), "源 B 内容\n");
    write(userTarget, "目标修改后内容\n");
    write(path.join(userSkillsRoot, "skill-one", "SKILL.md"), "---\nname: skill-one\ndescription: 一号\n---\n");
    const altSkillDir = path.join(fixtureDir, "alt-skill");
    write(path.join(altSkillDir, "SKILL.md"), "---\nname: alt-skill\ndescription: 替代\n---\n");

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
        notices: [],
        settings: {
            userSource: "A.md",
            targets: { Codex: "~/.codex/AGENTS.md" },
            skillUserTargets: { Claude: "~/.claude/skills" },
            skillProjectTargets: {},
        },
    });

    const buttonIn = (rootEl, label) => {
        for (const modal of plugin.body.children.slice(1).reverse()) {
            const hit = findElements(modal, node => node.tag === "button" && node.textContent === label);
            if (hit.length) return hit[0];
        }
        const inTab = findElements(rootEl, node => node.tag === "button" && node.textContent === label);
        assert.ok(inTab.length > 0, label);
        return inTab[0];
    };

    // 1. 打开指令同步后更改 userSource 为 B.md，旧卡片回收/分发/合并必须拒绝写向 B.md
    await plugin.invoke("sync-instructions");
    const instructionsHost = plugin.body.children[0].children[0].children[1].children[0];
    plugin.plugin.settings.userSource = "B.md";
    await buttonIn(instructionsHost, "用目标版本回收进 用户指令源笔记").onclick();
    assert.equal(read(path.join(vaultRoot, "A.md")), "源 A 内容\n");
    assert.equal(read(path.join(vaultRoot, "B.md")), "源 B 内容\n");
    assert.ok(findElements(instructionsHost, n => n.textContent?.includes("源笔记设置已变化")).length > 0);
    await buttonIn(instructionsHost, "行级对比合并…").onclick();
    assert.ok(findElements(plugin.body, n => n.textContent?.includes("源笔记设置已变化")).length > 0);
    buttonIn(instructionsHost, "关闭").onclick();

    // 2. 分发技能后外部把链接改为指向另一技能，撤销须弹确认；取消则保留新链接
    await plugin.invoke("manage-skills");
    const skillsHost = plugin.body.children[0].children[0].children[1].children[1];
    await buttonIn(skillsHost, "分发").onclick();
    const linkPath = path.join(claudeUserSkills, "skill-one");
    fs.unlinkSync(linkPath);
    fs.symlinkSync(altSkillDir, linkPath, process.platform === "win32" ? "junction" : "dir");

    const undoAsk = buttonIn(skillsHost, "撤销上次操作").onclick();
    await tick();
    assert.ok(findElements(plugin.body, n => n.textContent?.includes("以下目标在操作后又有修改")).length > 0);
    buttonIn(skillsHost, "取消").onclick();
    await undoAsk;
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
    assert.match(fs.readlinkSync(linkPath), /alt-skill/);

    // 3. 校验 create-test-vault 生成的 data.json 显式禁用用户级分发目标（不触碰真实 ~/.claude/skills）
    const scriptText = fs.readFileSync(path.join(__dirname, "..", "scripts", "create-test-vault.mjs"), "utf8");
    assert.match(scriptText, /skillUserTargets:\s*\{\s*\}/);

    await plugin.closeWorkspace();
});


test("PR 第三轮审查回归：拒绝反斜杠逃逸路径、GitHub 撤销软链接预检及整目录转换新增链接确认", async (t) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-round3-"));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

    const vaultRoot = path.join(fixtureDir, "vault");
    const syncDir = path.join(vaultRoot, ".obsidian", "plugins", "agents-manager", "sync");
    const homeDir = path.join(fixtureDir, "home");
    const userSkillsRoot = path.join(homeDir, ".agents", "skills");
    const claudeUserSkills = path.join(homeDir, ".claude", "skills");
    const outsideTarget = path.join(fixtureDir, "outside.txt");
    const extraSkillDir = path.join(fixtureDir, "extra-skill");
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
    };
    const read = (file) => fs.readFileSync(file, "utf8");
    const tick = () => new Promise(resolve => setImmediate(resolve));

    write(outsideTarget, "外部安全文件\n");
    write(path.join(extraSkillDir, "SKILL.md"), "---\nname: extra-skill\ndescription: 外部新增\n---\n");

    const ghDir = path.join(userSkillsRoot, "gh-escape");
    write(path.join(ghDir, "SKILL.md"), "---\nname: gh-escape\ndescription: 原版\n---\n原内容\n");
    write(path.join(syncDir, "skills-sources.json"), JSON.stringify({
        version: 1,
        skills: {
            "user/gh-escape": {
                kind: "github",
                url: "https://github.com/example/repo/tree/main/gh-escape",
                commit: "1111111111111111111111111111111111111111",
            },
        },
    }));

    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.mkdirSync(path.dirname(claudeUserSkills), { recursive: true });
    fs.symlinkSync(userSkillsRoot, claudeUserSkills, linkType);

    let badTree = true;
    const plugin = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: { adapter: { getBasePath: () => vaultRoot } },
    }, {
        fixtureDir,
        notices: [],
        settings: {
            skillUserTargets: { Claude: "~/.claude/skills" },
            skillProjectTargets: {},
        },
        async fetch(url) {
            if (url.includes("/commits?")) {
                return {
                    ok: true,
                    json: async () => [{
                        sha: "4444444444444444444444444444444444444444",
                        commit: { message: "test", committer: { date: "2026-11-26T15:30:00Z" } },
                    }],
                };
            }
            if (url.includes("/git/trees/")) {
                return {
                    ok: true,
                    json: async () => ({
                        truncated: false,
                        tree: badTree
                            ? [
                                { type: "blob", path: "gh-escape/SKILL.md", sha: "s1", mode: "100644" },
                                { type: "blob", path: "gh-escape/..\\..\\outside.txt", sha: "s2", mode: "100644" },
                            ]
                            : [
                                { type: "blob", path: "gh-escape/SKILL.md", sha: "s1", mode: "100644" },
                            ],
                    }),
                };
            }
            if (url.endsWith("/gh-escape/SKILL.md")) {
                return { ok: true, arrayBuffer: async () => Buffer.from("---\nname: gh-escape\ndescription: 新版\n---\n新内容\n") };
            }
            assert.fail("不应下载不安全路径或未预期文件：" + url);
        },
    });

    const skillsHost = () => plugin.body.children[0].children[0].children[1].children[1];
    const sButton = (label) => {
        for (const modal of plugin.body.children.slice(1).reverse()) {
            const hit = findElements(modal, node => node.tag === "button" && node.textContent === label);
            if (hit.length) return hit[0];
        }
        const inTab = findElements(skillsHost(), node => node.tag === "button" && node.textContent === label);
        assert.ok(inTab.length > 0, label);
        return inTab[0];
    };

    await plugin.invoke("manage-skills");

    // 1. 拒绝含 Windows 反斜杠逃逸路径的上游更新，外部文件不受影响
    const blockedEscape = sButton("更新").onclick();
    await tick();
    assert.ok(findElements(plugin.body, n => n.textContent?.includes("上游包含不安全的文件路径")).length > 0);
    sButton("关闭").onclick();
    await blockedEscape;
    assert.equal(read(outsideTarget), "外部安全文件\n");
    assert.equal(fs.existsSync(path.join(syncDir, "skills-pending-operation.json")), false);

    // 2. 正常更新后，若目录内被外部放入软链接，撤销前预检拒绝且不残留 pending 文件
    badTree = false;
    await sButton("更新").onclick();
    assert.match(read(path.join(ghDir, "SKILL.md")), /新内容/);
    const nestedLink = path.join(ghDir, "extra-link");
    fs.symlinkSync(extraSkillDir, nestedLink, linkType);
    const blockedUndo = sButton("撤销上次操作").onclick();
    await tick();
    assert.ok(findElements(plugin.body, n => n.textContent?.includes("技能目录内包含软链接")).length > 0);
    sButton("关闭").onclick();
    await blockedUndo;
    assert.equal(fs.existsSync(path.join(syncDir, "skills-pending-operation.json")), false);
    fs.unlinkSync(nestedLink);

    // 3. 整目录转为逐个链接后新增了其他工具的技能链接，撤销须提示确认；取消保留，确认后恢复整目录链接
    const convertAsk = sButton("转为逐个链接").onclick();
    await tick();
    sButton("确认转换").onclick();
    await convertAsk;
    await tick();
    const addedLink = path.join(claudeUserSkills, "extra-skill");
    fs.symlinkSync(extraSkillDir, addedLink, linkType);

    const undoCancel = sButton("撤销上次操作").onclick();
    await tick();
    assert.ok(findElements(plugin.body, n => n.textContent?.includes("以下目标在操作后又有修改")).length > 0);
    sButton("取消").onclick();
    await undoCancel;
    assert.ok(fs.lstatSync(addedLink).isSymbolicLink());

    const undoConfirm = sButton("撤销上次操作").onclick();
    await tick();
    sButton("继续撤销").onclick();
    await undoConfirm;
    await tick();
    assert.ok(fs.lstatSync(claudeUserSkills).isSymbolicLink());

    await plugin.closeWorkspace();
});


test("PR 复审回归：拒绝上游软链接条目并正确解析含斜杠分支名", async (t) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-round4-"));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

    const vaultRoot = path.join(fixtureDir, "vault");
    const syncDir = path.join(vaultRoot, ".obsidian", "plugins", "agents-manager", "sync");
    const homeDir = path.join(fixtureDir, "home");
    const userSkillsRoot = path.join(homeDir, ".agents", "skills");
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
    };
    const read = (file) => fs.readFileSync(file, "utf8");
    const tick = () => new Promise(resolve => setImmediate(resolve));

    const symlinkSkillDir = path.join(userSkillsRoot, "sym-skill");
    const slashSkillDir = path.join(userSkillsRoot, "slash-skill");
    write(path.join(symlinkSkillDir, "SKILL.md"), "---\nname: sym-skill\ndescription: 原版\n---\n原内容\n");
    write(path.join(slashSkillDir, "SKILL.md"), "---\nname: slash-skill\ndescription: 原分支版\n---\n旧分支内容\n");
    write(path.join(syncDir, "skills-sources.json"), JSON.stringify({
        version: 1,
        skills: {
            "user/sym-skill": {
                kind: "github",
                url: "https://github.com/example/repo/tree/main/sym-skill",
                commit: "1111111111111111111111111111111111111111",
            },
            "user/slash-skill": {
                kind: "github",
                url: "https://github.com/example/repo/tree/feature/new-skill/skills/demo",
                commit: "1111111111111111111111111111111111111111",
            },
        },
    }));

    const plugin = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: { adapter: { getBasePath: () => vaultRoot } },
    }, {
        fixtureDir,
        notices: [],
        settings: { skillUserTargets: {}, skillProjectTargets: {} },
        async fetch(url) {
            if (url.includes("/commits?") && url.includes("path=sym-skill")) {
                return {
                    ok: true,
                    json: async () => [{ sha: "5555555555555555555555555555555555555555", commit: { message: "sym" } }],
                };
            }
            if (url.includes("/git/trees/5555555555555555555555555555555555555555")) {
                return {
                    ok: true,
                    json: async () => ({
                        truncated: false,
                        tree: [
                            { type: "blob", path: "sym-skill/SKILL.md", sha: "s1", mode: "100644" },
                            { type: "blob", path: "sym-skill/references/guide.md", sha: "s2", mode: "120000" },
                        ],
                    }),
                };
            }
            if (url.includes("/commits?") && url.includes("sha=feature&")) {
                return { ok: false, status: 404, text: async () => "Not Found" };
            }
            if (url.endsWith("/git/matching-refs/heads/feature")) {
                return {
                    ok: true,
                    json: async () => [
                        { ref: "refs/heads/feature" },
                        { ref: "refs/heads/feature/new-skill" },
                    ],
                };
            }
            if (url.includes("/commits?") && url.includes("sha=feature%2Fnew-skill&path=skills%2Fdemo")) {
                return {
                    ok: true,
                    json: async () => [{ sha: "6666666666666666666666666666666666666666", commit: { message: "slash branch" } }],
                };
            }
            if (url.includes("/git/trees/6666666666666666666666666666666666666666")) {
                return {
                    ok: true,
                    json: async () => ({
                        truncated: false,
                        tree: [
                            { type: "blob", path: "skills/demo/SKILL.md", sha: "d1", mode: "100644" },
                        ],
                    }),
                };
            }
            if (url.endsWith("/skills/demo/SKILL.md")) {
                return { ok: true, arrayBuffer: async () => Buffer.from("---\nname: slash-skill\ndescription: 新分支版\n---\n新分支内容\n") };
            }
            assert.fail("未预期的请求：" + url);
        },
    });

    const skillsHost = () => plugin.body.children[0].children[0].children[1].children[1];
    const sButtons = (label) => {
        for (const modal of plugin.body.children.slice(1).reverse()) {
            const hit = findElements(modal, node => node.tag === "button" && node.textContent === label);
            if (hit.length) return hit;
        }
        return findElements(skillsHost(), node => node.tag === "button" && node.textContent === label);
    };

    await plugin.invoke("manage-skills");

    // 1. slash-skill 排在 sym-skill 之前（alphabetical）：先验证含斜杠分支可正确检查和更新
    await sButtons("更新")[0].onclick();
    assert.match(read(path.join(slashSkillDir, "SKILL.md")), /新分支内容/);
    const sources = JSON.parse(read(path.join(syncDir, "skills-sources.json")));
    assert.equal(sources.skills["user/slash-skill"].commit, "6666666666666666666666666666666666666666");

    // 2. sym-skill 上游含 120000 软链接条目时拒绝更新，本地文件与基线均不变
    const blockedSym = sButtons("更新")[1].onclick();
    await tick();
    assert.ok(findElements(plugin.body, n => n.textContent?.includes("不支持的软链接条目")).length > 0);
    sButtons("关闭")[0].onclick();
    await blockedSym;
    assert.match(read(path.join(symlinkSkillDir, "SKILL.md")), /原内容/);
    const afterSources = JSON.parse(read(path.join(syncDir, "skills-sources.json")));
    assert.equal(afterSources.skills["user/sym-skill"].commit, "1111111111111111111111111111111111111111");

    await plugin.closeWorkspace();
});


test("PR 复审第二轮回归：中断恢复确认外部修改、重复目标路径一键分发去重与冲突隔离", async (t) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-round5-"));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

    const vaultRoot = path.join(fixtureDir, "vault");
    const syncDir = path.join(vaultRoot, ".obsidian", "plugins", "agents-manager", "sync");
    const homeDir = path.join(fixtureDir, "home");
    const userSkillsRoot = path.join(homeDir, ".agents", "skills");
    const sharedDir = path.join(homeDir, ".shared-skills");
    const uniqueDir = path.join(homeDir, ".unique-skills");
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
    };
    const read = (file) => fs.readFileSync(file, "utf8");
    const tick = () => new Promise(resolve => setImmediate(resolve));

    const selfMd = path.join(userSkillsRoot, "demo-skill", "SKILL.md");
    write(selfMd, "---\nname: demo-skill\ndescription: 外部编辑后内容\n---\n外部最新内容\n");
    write(path.join(syncDir, "skills-pending-operation.json"), JSON.stringify({
        type: "edit-skill",
        label: "编辑 demo-skill",
        path: selfMd,
        before: "---\nname: demo-skill\ndescription: 旧内容\n---\n旧正文\n",
        after: "---\nname: demo-skill\ndescription: 中断写入\n---\n中断内容\n",
    }));

    const plugin = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: { adapter: { getBasePath: () => vaultRoot } },
    }, {
        fixtureDir,
        notices: [],
        settings: {
            skillUserTargets: {
                ToolA: "~/.shared-skills",
                ToolB: "~/.shared-skills",
                ToolC: "~/.unique-skills",
            },
            skillProjectTargets: {},
        },
    });

    const skillsHost = () => plugin.body.children[0].children[0].children[1].children[1];
    const sButton = (label) => {
        for (const modal of plugin.body.children.slice(1).reverse()) {
            const hit = findElements(modal, node => node.tag === "button" && node.textContent === label);
            if (hit.length) return hit[0];
        }
        const inTab = findElements(skillsHost(), node => node.tag === "button" && node.textContent === label);
        assert.ok(inTab.length > 0, label);
        return inTab[0];
    };

    await plugin.invoke("manage-skills");

    // 1. 存在 pending 中断记录但文件已被外部修改时，撤销必须先确认；取消则保留外部修改
    const cancelPending = sButton("撤销上次操作").onclick();
    await tick();
    assert.ok(findElements(plugin.body, n => n.textContent?.includes("以下目标在操作后又有修改")).length > 0);
    sButton("取消").onclick();
    await cancelPending;
    assert.match(read(selfMd), /外部最新内容/);
    assert.equal(fs.existsSync(path.join(syncDir, "skills-pending-operation.json")), true);

    const confirmPending = sButton("撤销上次操作").onclick();
    await tick();
    sButton("继续撤销").onclick();
    await confirmPending;
    await tick();
    assert.match(read(selfMd), /旧正文/);
    assert.equal(fs.existsSync(path.join(syncDir, "skills-pending-operation.json")), false);

    // 2. 两个工具共用 ~/.shared-skills 时，一键分发按路径去重只建一次，不因 EEXIST 回滚 ToolC
    await sButton("一键分发").onclick();
    assert.ok(fs.lstatSync(path.join(sharedDir, "demo-skill")).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(uniqueDir, "demo-skill")).isSymbolicLink());

    await plugin.closeWorkspace();
});

test("技能管理自动纳入当前 Obsidian 仓库技能，支持去重、分发与来源兼容", async (t) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-vault-skills-"));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

    const homeDir = path.join(fixtureDir, "home");
    const userSkillsRoot = path.join(homeDir, ".agents", "skills");
    const vaultRoot = path.join(fixtureDir, "vault-dir");
    const syncDir = path.join(vaultRoot, ".obsidian", "plugins", "agents-manager", "sync");
    const projRoot = path.join(fixtureDir, "other-proj");
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
    };
    const read = (file) => fs.readFileSync(file, "utf8");

    write(path.join(userSkillsRoot, "user-skill", "SKILL.md"), "---\nname: user-skill\ndescription: 用户技能\n---\n");
    write(path.join(projRoot, "AGENTS.md"), "# 规范\n规则\n# 项目\n其他项目\n");
    write(path.join(projRoot, ".agents", "skills", "proj-skill", "SKILL.md"), "---\nname: proj-skill\ndescription: 项目技能\n---\n");
    write(path.join(syncDir, "instruction-projects.json"), JSON.stringify({
        version: 1,
        projects: [{ name: "其他项目", type: "work", path: path.join(projRoot, "AGENTS.md") }],
    }));

    const vaultSkillMd = path.join(vaultRoot, ".agents", "skills", "vault-skill", "SKILL.md");
    write(vaultSkillMd, "---\nname: vault-skill\ndescription: 仓库技能旧说明\n---\n\n# Vault\n旧内容\n");
    const vaultGhDir = path.join(vaultRoot, ".agents", "skills", "vault-gh");
    write(path.join(vaultGhDir, "SKILL.md"), "---\nname: vault-gh\ndescription: 仓库 GitHub 旧版\n---\n旧版\n");

    const canonVaultRoot = process.platform === "win32" ? path.resolve(vaultRoot).toLowerCase() : path.resolve(vaultRoot);
    write(path.join(syncDir, "skills-sources.json"), JSON.stringify({
        version: 1,
        skills: {
            [canonVaultRoot + "/vault-gh"]: {
                kind: "github",
                url: "https://github.com/example/repo/tree/main/.agents/skills/vault-gh",
                commit: "1111111111111111111111111111111111111111",
            },
        },
    }));

    let vaultDisplayName = "知识库名称";
    const fetchOpts = {
        fixtureDir,
        notices: [],
        settings: {
            skillUserTargets: {},
            skillProjectTargets: { Claude: ".claude/skills" },
        },
        async fetch(url) {
            if (url.includes("/commits?")) {
                return {
                    ok: true,
                    json: async () => [{ sha: "7777777777777777777777777777777777777777", commit: { message: "feat: vault gh" } }],
                };
            }
            if (url.includes("/git/trees/7777777777777777777777777777777777777777")) {
                return {
                    ok: true,
                    json: async () => ({
                        truncated: false,
                        tree: [{ type: "blob", path: ".agents/skills/vault-gh/SKILL.md", sha: "v1", mode: "100644" }],
                    }),
                };
            }
            if (url.endsWith("/.agents/skills/vault-gh/SKILL.md")) {
                return { ok: true, arrayBuffer: async () => Buffer.from("---\nname: vault-gh\ndescription: 仓库 GitHub 新版\n---\n新版\n") };
            }
            assert.fail("未预期的请求：" + url);
        },
    };

    const plugin = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: {
            adapter: { getBasePath: () => vaultRoot },
            getName: () => vaultDisplayName,
        },
    }, fetchOpts);

    const skillsHost = () => plugin.body.children[0].children[0].children[1].children[1];
    const sButton = (label, index = 0) => {
        for (const modal of plugin.body.children.slice(1).reverse()) {
            const hit = findElements(modal, node => node.tag === "button" && node.textContent === label);
            if (hit.length) return hit[index] || hit[0];
        }
        const inTab = findElements(skillsHost(), node => node.tag === "button" && node.textContent === label);
        assert.ok(inTab.length > index, label);
        return inTab[index];
    };
    const tick = () => new Promise(resolve => setImmediate(resolve));

    // 1. 顺序检查：用户级技能 -> 当前仓库（取 vault.getName()） -> 其他已登记项目
    await plugin.invoke("manage-skills");
    const tabTexts = findElements(skillsHost(), node => node.tag === "button" && /（\d+）$/.test(node.textContent)).map(n => n.textContent);
    assert.deepEqual(tabTexts, ["用户级技能（1）", "知识库名称（2）", "其他项目（1）"]);

    // 2. 当前仓库自建编辑、GitHub 更新与按项目级目标一键分发 + 撤销
    sButton("知识库名称（2）").onclick();
    sButton("编辑 SKILL.md", 1).onclick();
    const editor = findElements(plugin.body, node => node.tag === "textarea")[0];
    editor.value = "---\nname: vault-skill\ndescription: 仓库技能新说明\n---\n\n# Vault\n新内容\n";
    editor.oninput();
    await sButton("保存").onclick();
    assert.match(read(vaultSkillMd), /新内容/);

    await sButton("更新").onclick();
    assert.match(read(path.join(vaultGhDir, "SKILL.md")), /新版/);
    const updatedSources = JSON.parse(read(path.join(syncDir, "skills-sources.json")));
    assert.equal(updatedSources.skills[canonVaultRoot + "/vault-gh"].commit, "7777777777777777777777777777777777777777");

    await sButton("撤销上次操作").onclick();
    await tick();
    assert.match(read(path.join(vaultGhDir, "SKILL.md")), /旧版/);

    await sButton("一键分发").onclick();
    assert.ok(fs.lstatSync(path.join(vaultRoot, ".claude", "skills", "vault-skill")).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(vaultRoot, ".claude", "skills", "vault-gh")).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(projRoot, ".claude", "skills", "proj-skill")).isSymbolicLink());
    await plugin.closeWorkspace();

    // 3. 无 vault.getName() 时回退目录名；若同时已在登记表中，仅展示一次并沿用登记名
    const pluginFallback = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: { adapter: { basePath: vaultRoot } },
    }, fetchOpts);
    await pluginFallback.invoke("manage-skills");
    const fallbackTabs = findElements(
        pluginFallback.body.children[0].children[0].children[1].children[1],
        node => node.tag === "button" && /（\d+）$/.test(node.textContent)
    ).map(n => n.textContent);
    assert.deepEqual(fallbackTabs, ["用户级技能（1）", "vault-dir（2）", "其他项目（1）"]);
    await pluginFallback.closeWorkspace();

    write(path.join(vaultRoot, "AGENTS.md"), "# 规范\n规则\n# 本仓库\n");
    write(path.join(syncDir, "instruction-projects.json"), JSON.stringify({
        version: 1,
        projects: [
            { name: "已登记的本仓库", type: "work", path: path.join(vaultRoot, "AGENTS.md") },
            { name: "其他项目", type: "work", path: path.join(projRoot, "AGENTS.md") },
        ],
    }));
    const pluginDedup = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: { adapter: { getBasePath: () => vaultRoot }, getName: () => vaultDisplayName },
    }, fetchOpts);
    await pluginDedup.invoke("manage-skills");
    const dedupTabs = findElements(
        pluginDedup.body.children[0].children[0].children[1].children[1],
        node => node.tag === "button" && /（\d+）$/.test(node.textContent)
    ).map(n => n.textContent);
    assert.deepEqual(dedupTabs, ["用户级技能（1）", "已登记的本仓库（2）", "其他项目（1）"]);
    await pluginDedup.closeWorkspace();

    // 4. 仓库根目录与 homedir 相同时不重复显示；仓库无技能时不显示仓库标签页
    const homeVaultPlugin = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: { adapter: { getBasePath: () => homeDir }, getName: () => "HomeVault" },
    }, { ...fetchOpts, settings: { skillUserTargets: {}, skillProjectTargets: {} } });
    await homeVaultPlugin.invoke("manage-skills");
    const homeTabs = findElements(
        homeVaultPlugin.body.children[0].children[0].children[1].children[1],
        node => node.tag === "button" && /（\d+）$/.test(node.textContent)
    ).map(n => n.textContent);
    assert.deepEqual(homeTabs, ["用户级技能（1）"]);
    await homeVaultPlugin.closeWorkspace();

    const emptyVault = path.join(fixtureDir, "empty-vault");
    fs.mkdirSync(path.join(emptyVault, ".agents", "skills"), { recursive: true });
    const emptyVaultPlugin = await loadPlugin({
        workspace: { getActiveFile: () => null, getLeavesOfType: () => [] },
        vault: { adapter: { getBasePath: () => emptyVault }, getName: () => "EmptyVault" },
    }, { ...fetchOpts, settings: { skillUserTargets: {}, skillProjectTargets: {} } });
    await emptyVaultPlugin.invoke("manage-skills");
    const emptyTabs = findElements(
        emptyVaultPlugin.body.children[0].children[0].children[1].children[1],
        node => node.tag === "button" && /（\d+）$/.test(node.textContent)
    ).map(n => n.textContent);
    assert.deepEqual(emptyTabs, ["用户级技能（1）"]);
    await emptyVaultPlugin.closeWorkspace();
});

test("笔记 AI 处理覆盖请求取消、接口错误及生成期间切换或修改笔记", async () => {
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const baseSettings = {
        endpoint: "https://example.org/v1/chat/completions",
        model: "my-model",
        credentialVariable: "TEST_MODEL_API_KEY",
        summaryMode: "single",
        singleTemplate: "",
    };

    // 1. 请求取消：fetch 挂起期间点击「放弃」，应中止请求且无错误 Notice、不写回
    {
        const notices = [];
        const writes = [];
        let capturedSignal = null;
        let resolveFetch;
        const app = {
            workspace: {
                getActiveFile: () => ({ path: "笔记A.md" }),
                activeEditor: {
                    editor: {
                        getSelection: () => "Selected",
                        getValue: () => "原文A",
                        replaceSelection: value => writes.push(value),
                    },
                },
            },
            vault: { async read() { return "原文A"; } },
        };
        const plugin = await loadPlugin(app, {
            notices,
            settings: baseSettings,
            fetch(_url, req) {
                capturedSignal = req.signal;
                return new Promise((resolve, reject) => {
                    resolveFetch = resolve;
                    req.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
                });
            },
        });
        const pending = plugin.invoke("translate-selection");
        await tick();
        assert.equal(capturedSignal.aborted, false);
        const [abandon] = findElements(plugin.body, el => el.tag === "button" && el.textContent === "放弃");
        abandon.onclick();
        await pending;
        assert.equal(capturedSignal.aborted, true);
        assert.deepEqual(notices, []);
        assert.deepEqual(writes, []);
        assert.equal(plugin.body.children.length, 0);
        void resolveFetch;
    }

    // 2. 流式读取中途关闭弹窗也能安全中止，且 reader.cancel 抛错不产生未捕获异常
    {
        const notices = [];
        let readStep = 0;
        let readerCancelled = false;
        const app = {
            workspace: {
                getActiveFile: () => ({ path: "笔记A.md" }),
                activeEditor: {
                    editor: {
                        getSelection: () => "",
                        getValue: () => "整篇正文",
                        replaceSelection() {},
                    },
                },
            },
            vault: { async read() { return "整篇正文"; } },
        };
        const plugin = await loadPlugin(app, {
            notices,
            settings: baseSettings,
            async fetch(_url, req) {
                return {
                    ok: true,
                    body: {
                        getReader: () => ({
                            async read() {
                                readStep += 1;
                                if (readStep === 1) {
                                    return { value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"前半"}}]}\n'), done: false };
                                }
                                return await new Promise((_, reject) => {
                                    req.signal.addEventListener("abort", () => reject(new Error("aborted")));
                                });
                            },
                            async cancel() {
                                readerCancelled = true;
                                throw new Error("cancel failure");
                            },
                            releaseLock() {},
                        }),
                    },
                };
            },
        });
        const pending = plugin.invoke("summarize-note");
        await tick();
        const [preview] = findElements(plugin.body, el => el.tag === "textarea");
        assert.equal(preview.value, "前半");
        const [abandon] = findElements(plugin.body, el => el.tag === "button" && el.textContent === "放弃");
        abandon.onclick();
        await pending;
        assert.equal(readerCancelled, true);
        assert.deepEqual(notices, []);
        assert.equal(plugin.body.children.length, 0);
    }

    // 3. 接口错误与异常响应：预览框显示错误信息，保持只读且按钮禁用
    const errorCases = [
        {
            name: "HTTP 500",
            expected: "模型接口返回 HTTP 500。",
            fetch: async () => ({ ok: false, status: 500 }),
        },
        {
            name: "JSON error",
            expected: "模型接口返回错误。",
            fetch: async () => ({
                ok: true,
                headers: { get: () => "application/json" },
                json: async () => ({ error: { message: "bad request" } }),
            }),
        },
        {
            name: "SSE stream error with failing reader.cancel",
            expected: "模型在生成时返回错误。",
            fetch: async () => ({
                ok: true,
                body: {
                    getReader: () => ({
                        async read() {
                            return { value: new TextEncoder().encode('data: {"error":{"message":"stream fail"}}\n'), done: false };
                        },
                        async cancel() { throw new Error("cancel should not mask stream error"); },
                        releaseLock() {},
                    }),
                },
            }),
        },
        {
            name: "网络异常",
            expected: "网络连接失败",
            fetch: async () => { throw new Error("网络连接失败"); },
        },
        {
            name: "空白返回",
            expected: "模型未返回内容。",
            fetch: async () => ({
                ok: true,
                headers: { get: () => "application/json" },
                json: async () => ({ choices: [{ message: { content: "   " } }] }),
            }),
        },
        {
            name: "缺少凭据环境变量",
            expected: "MISSING_KEY_VAR",
            settings: { ...baseSettings, credentialVariable: "MISSING_KEY_VAR" },
            fetch: async () => assert.fail("缺少凭据时不应发起请求"),
        },
    ];

    for (const item of errorCases) {
        const notices = [];
        const plugin = await loadPlugin({
            workspace: {
                getActiveFile: () => ({ path: "笔记.md" }),
                activeEditor: { editor: { getSelection: () => "", getValue: () => "正文", replaceSelection() {} } },
            },
            vault: { async read() { return "正文"; } },
        }, {
            notices,
            settings: item.settings || baseSettings,
            fetch: item.fetch,
        });
        await plugin.invoke("summarize-note");
        const [preview] = findElements(plugin.body, el => el.tag === "textarea");
        const [replace] = findElements(plugin.body, el => el.tag === "button" && el.textContent === "替换");
        const [insert] = findElements(plugin.body, el => el.tag === "button" && el.textContent === "插入");
        assert.ok(preview.value.includes(item.expected), item.name);
        assert.equal(preview.readOnly, true, item.name);
        assert.equal(replace.disabled, true, item.name);
        assert.equal(insert.disabled, true, item.name);
        assert.deepEqual(notices, []);
        findElements(plugin.body, el => el.tag === "button" && el.textContent === "放弃")[0].onclick();
    }

    // 4. 生成期间切换笔记、修改正文或切换编辑器实例：拒绝写回并保留预览窗口
    const mutationScenarios = ["switch-file", "edit-content", "switch-editor"];
    for (const scenario of mutationScenarios) {
        const notices = [];
        const writesA = [];
        const writesB = [];
        let currentFile = { path: "笔记A.md" };
        let currentText = "初始内容";
        const editorA = {
            getSelection: () => "",
            getValue: () => currentText,
            replaceSelection: value => writesA.push(value),
        };
        const editorB = {
            getSelection: () => "",
            getValue: () => "另一编辑器内容",
            replaceSelection: value => writesB.push(value),
        };
        let currentEditor = editorA;

        const app = {
            workspace: {
                getActiveFile: () => currentFile,
                activeEditor: { editor: currentEditor },
            },
            vault: { async read() { return currentText; } },
        };
        const plugin = await loadPlugin(app, {
            notices,
            settings: baseSettings,
            async fetch() {
                if (scenario === "switch-file") currentFile = { path: "笔记B.md" };
                else if (scenario === "edit-content") currentText = "生成期间被修改";
                else if (scenario === "switch-editor") plugin.plugin.app.workspace.activeEditor = { editor: editorB };
                return {
                    ok: true,
                    headers: { get: () => "application/json" },
                    json: async () => ({ choices: [{ message: { content: "摘要输出" } }] }),
                };
            },
        });

        await plugin.invoke("summarize-note");
        const [preview] = findElements(plugin.body, el => el.tag === "textarea");
        assert.equal(preview.value, "摘要输出");
        findElements(plugin.body, el => el.tag === "button" && el.textContent === "替换")[0].onclick();
        findElements(plugin.body, el => el.tag === "button" && el.textContent === "插入")[0].onclick();
        assert.deepEqual(notices, ["原笔记或编辑器已变化，请重新运行。", "原笔记或编辑器已变化，请重新运行。"]);
        assert.deepEqual(writesA, []);
        assert.deepEqual(writesB, []);
        assert.equal(plugin.body.children.length, 1);
        findElements(plugin.body, el => el.tag === "button" && el.textContent === "放弃")[0].onclick();
    }
});
