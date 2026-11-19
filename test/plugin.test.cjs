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
    setAttribute() {}
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
        addSettingTab(tab) { this.settingTab = tab; }
        addCommand(command) {
            commands.push(command);
        }
    }

    class Notice {
        constructor(message) {
            assert.fail(message);
        }
    }

    const module = { exports: {} };
    runInNewContext(bundle, {
        module,
        document,
        require(name) {
            if (name === "obsidian") {
                return { Notice, Plugin, Modal, PluginSettingTab: class {} };
            }
            if (name === "os") {
                assert.ok(options.fixtureDir, "同步测试须配置隔离目录");
                return {
                    homedir: () => path.join(options.fixtureDir, "home"),
                    tmpdir: () => path.join(options.fixtureDir, "backups"),
                };
            }
            return require(name);
        },
        process: { env: { SILICONFLOW_API_KEY: "test-key" } },
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
        invoke(id) {
            const command = commands.find((candidate) => candidate.id === id);
            assert.ok(command, id);
            return command.callback();
        },
    };
}

test("插件仅注册两条命令，快捷键由使用者绑定", async () => {
    const { commands } = await loadPlugin({});
    assert.deepEqual(commands.map(({ id }) => id), [
        "summarize-or-translate",
        "sync-instructions",
    ]);
    assert.ok(commands.every((command) => !Object.hasOwn(command, "hotkeys")));
});

test("AI 命令保持选区翻译、按类型总结及流式内容写回", async () => {
    const cases = [
        ["观点视角", "需要翻译的选区", null],
        ["新闻报道", "", "新闻简讯"],
        ["观点视角", "", "观点视角"],
        ["知识教程", "", "知识教程"],
        [null, "", "观点视角"],
    ];

    for (const [type, selection, template] of cases) {
        const file = { path: "样例.md" };
        const frontmatter = type ? `---\ncontent_type: "${type}"\n---\n` : "";
        const note = frontmatter + "样例文献正文";
        const writes = [];
        const openedTemplates = [];

        const app = {
            metadataCache: { getFileCache: () => ({ frontmatter: {content_type: type} }) },
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
                templates: { 新闻报道: "docs/prompts/文献总结-新闻简讯.md", 观点视角: "docs/prompts/文献总结-观点视角.md", 知识教程: "docs/prompts/文献总结-知识教程.md" },
                defaultTemplate: "docs/prompts/文献总结-观点视角.md",
            },
            async fetch(url, request) {
                assert.equal(url, "https://api.siliconflow.cn/v1/chat/completions");
                const body = JSON.parse(request.body);
                assert.equal(body.stream, true);
                if (selection) {
                    assert.match(body.messages[0].content, /需要翻译的选区/);
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

        await plugin.invoke("summarize-or-translate");
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
    const typeStatePath = path.join(stateFolder, "type-instructions-sync.json");
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
    write(typeStatePath, JSON.stringify({
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
    }, { fixtureDir });

    const panel = plugin.invoke("sync-instructions");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(read(target), previousProject);
    const [alreadySynced] = findElements(plugin.body, (element) => element.textContent === "已同步");
    assert.equal(alreadySynced.disabled, true);

    const [distribute] = findElements(plugin.body, (element) => element.textContent === "备份并分发");
    await distribute.onclick();
    assert.equal(read(target), newSection + "\n" + projectBody);
    assert.equal(read(path.join(stateFolder, "instruction-projects.json")), registry);
    assert.equal(read(userTarget), userBody);
    assert.equal(JSON.parse(read(typeStatePath)).projects[0].targetSectionHash, hash(newSection));

    const backupDir = path.join(fixtureDir, "backups", "nascence-type-instructions-sync");
    const [backup] = fs.readdirSync(backupDir);
    assert.equal(read(path.join(backupDir, backup)), previousProject);

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
    await button("写回模板与项目").onclick();
    assert.match(read(target), /源端新增/);
    assert.match(read(target), /目标新增/);
    assert.ok(read(typeSource).startsWith(sourceHeader) && read(typeSource).endsWith(sourceTail));
    assert.ok(read(target).endsWith(projectBody));
    for (const item of findElements(plugin.body, node => node.textContent === "关闭").reverse()) item.onclick();
    await conflict;

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
    assert.ok(fs.readdirSync(backupDir).some(name => read(path.join(backupDir, name)) === sourceBeforeFailure));
    failSourceWrite = false;
    await recover.onclick();
    assert.equal(read(typeSource), sourceHeader + "# 工作规范\n来自目标的更新\n" + sourceTail);
    button("关闭").onclick();
    await recycle;
    assert.equal(plugin.body.children.length, 0);
});
