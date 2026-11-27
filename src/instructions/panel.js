var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
const { Notice, Menu } = require("obsidian");
const { syncDirectory, readText, replaceText, createHistory } = require("./storage");
const { normalizeNewlines, extractInstructionBody, parseWorkStructure, rebuildDocument, computeLineDiff, composeMergedBody } = require("./documents");
const { harnessTargets, NotePicker, vaultPath } = require("../settings");

const TYPE_LABELS = { work: "Work", code: "Code" };
const SOURCE_LABELS = {
    userSource: "用户指令源笔记",
    workSource: "Work 项目模板",
    codeSource: "Code 项目模板",
};
const TARGET_STATUS = {
    unchanged: "已同步",
    sync: "来源已更新",
    "record-only": "待建立同步基线",
    "initial-create": "目标文件不存在",
    "initial-review": "首次同步有差异",
};

function mountInstructions(plugin, host) {
    const { app } = plugin;
    const sourceDrafts = new Map();
    const getLayer1Source = () => plugin.settings.userSource;
    const getLayer1Targets = () => Object.entries(plugin.settings.targets || {}).map(([name, file]) => ({
        name, path: file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file,
    }));
    const getTypeSources = () => ({
        work: { name: "Work 类型模板", vaultPath: plugin.settings.workSource },
        code: { name: "Code 类型模板", vaultPath: plugin.settings.codeSource },
    });
    // 通道实例：定义见下方 makeUserChannel／makeTypeChannel。
    var USER_CHANNEL = makeUserChannel();
    var TYPE_CHANNELS = {
        work: makeTypeChannel("work"),
        code: makeTypeChannel("code")
    };

    var VAULT_ROOT = null;
    var STATE_ROOT = null;
    var REGISTRY_PATH = null;
    var LAYER1_STATE_PATH = null;
    var LAYER2_STATE_PATH = null;

    let history = null;
    let refreshHistory = () => {};
    async function exclusive(action) {
        if (plugin.syncBusy) throw new Error("正在处理其他同步操作。");
        plugin.syncBusy = true;
        try { return await action(); }
        finally { plugin.syncBusy = false; refreshHistory(); }
    }

    async function addLayer1Target(name) {
        try {
            let added = false;
            await exclusive(() => plugin.updateSettings(current => {
                const targets = current.targets || {};
                if (Object.prototype.hasOwnProperty.call(targets, name)) return null;
                added = true;
                return { ...current, targets: { ...targets, [name]: harnessTargets[name] } };
            }));
            if (added) {
                new Notice("已添加用户指令目标：" + name);
                await safeRefresh();
            }
        } catch (error) {
            await showMessage("添加目标失败", error && error.message ? error.message : String(error));
        }
    }

    function removeLayer1Target(target) {
        return exclusive(async () => {
            await plugin.updateSettings(current => {
                const targets = { ...(current.targets || {}) };
                delete targets[target.name];
                return { ...current, targets };
            });
            return "已将 " + target.name + " 移出用户指令分发列表（目标文件未改动）。";
        });
    }

    function buildLayer1RemoveEntry(target, onChanged) {
        return {
            ariaLabel: "移出 " + target.name,
            tooltip: "移出分发列表（不删除目标文件）",
            confirmTitle: "移出分发列表",
            confirmMessage: "将把 " + target.name + " 从用户指令分发列表移出，目标文件不会改动；随时可通过「添加目标」重新加入。如果上次操作涉及该目标，移出后将无法直接撤销。",
            confirmButton: "移出列表",
            notify: true,
            remove: function () { return removeLayer1Target(target); },
            afterRemove: function () {
                if (onChanged) return onChanged();
            }
        };
    }

    async function loadPlans() {
        // 两级独立准备：一级出错不阻塞另一级。
        var layer1 = { error: null, plan: null };
        var layer2 = { error: null, plan: null };

        try {
            var userSource = USER_CHANNEL.extractSource(await readVaultFile(app, getLayer1Source()));
            layer1.plan = buildChannelPlan(USER_CHANNEL, getLayer1Targets(), userSource, null, readChannelState(USER_CHANNEL));
        } catch (error) {
            console.error("[sync-instructions] layer1", error);
            layer1.error = error && error.message ? error.message : String(error);
        }

        try {
            var registry = readRegistry();
            var loaded = await loadTypeSources(app, registry);
            layer2.plan = buildTypePlans(registry.projects, loaded.sources, loaded.errors);
        } catch (error) {
            console.error("[sync-instructions] layer2", error);
            layer2.error = error && error.message ? error.message : String(error);
        }

        return { layer1, layer2 };
    }
    function configureStatePaths(app) {
        var adapter = app && app.vault && app.vault.adapter;
        var vaultRoot = null;
        if (adapter && typeof adapter.getBasePath === "function") {
            vaultRoot = adapter.getBasePath();
        } else if (adapter && typeof adapter.basePath === "string") {
            vaultRoot = adapter.basePath;
        }
        if (!vaultRoot) {
            throw new Error("无法定位当前 Obsidian 仓库根目录，已停止读取或写入同步记录。");
        }

        VAULT_ROOT = vaultRoot;
        const configDir = path.join(vaultRoot, app.vault.configDir || ".obsidian");
        const pluginDir = plugin.manifest?.dir
            ? path.resolve(vaultRoot, plugin.manifest.dir)
            : path.join(configDir, "plugins", "agents-manager");
        STATE_ROOT = syncDirectory(configDir, pluginDir);
        history = createHistory(STATE_ROOT, readChange, writeChange, validateUndo);
        REGISTRY_PATH = path.join(STATE_ROOT, "instruction-projects.json");
        LAYER1_STATE_PATH = path.join(STATE_ROOT, "user-instructions-sync.json");
        LAYER2_STATE_PATH = path.join(STATE_ROOT, "type-instructions-sync.json");

        USER_CHANNEL.statePath = LAYER1_STATE_PATH;
        TYPE_CHANNELS.work.statePath = LAYER2_STATE_PATH;
        TYPE_CHANNELS.code.statePath = LAYER2_STATE_PATH;
    }

    // ===== 通用读写 =====

    async function readVaultFile(app, vaultPath) {
        // 与 syncReadVault 完全同源：面板判定与合并弹窗必须读到同一份内容，
        // 否则会出现"卡片判定不一致、对比却无差异"的矛盾。
        return syncReadVault(app, vaultPath);
    }

    function writeVaultFile(app, vaultPath, newContent) {
        var activeFile = app.workspace.getActiveFile();
        if (activeFile && activeFile.path === vaultPath) {
            var activeEditor = app.workspace.activeEditor && app.workspace.activeEditor.editor;
            if (activeEditor && typeof activeEditor.setValue === "function") {
                activeEditor.setValue(newContent);
                return app.workspace.activeEditor?.save?.();
            }
        }

        var leaf = app.workspace.getLeavesOfType("markdown").find(function (l) {
            return l.view && l.view.file && l.view.file.path === vaultPath;
        });
        if (leaf && leaf.view && leaf.view.editor && typeof leaf.view.editor.setValue === "function") {
            leaf.view.editor.setValue(newContent);
            return leaf.view.save?.();
        }

        var file = app.vault.getAbstractFileByPath(vaultPath);
        if (!file) {
            throw new Error("找不到文件：" + vaultPath);
        }
        return app.vault.modify(file, newContent);
    }

    // 同步读取 vault 文件：优先编辑器未落盘内容，否则直接读磁盘（此时文件未在编辑器中
    // 打开，磁盘内容即 vault 已保存内容）。
    function syncReadVault(app, vaultPath) {
        var activeFile = app.workspace.getActiveFile();
        if (activeFile && activeFile.path === vaultPath) {
            var activeEditor = app.workspace.activeEditor && app.workspace.activeEditor.editor;
            if (activeEditor && typeof activeEditor.getValue === "function") {
                return activeEditor.getValue();
            }
        }
        var leaf = app.workspace.getLeavesOfType("markdown").find(function (l) {
            return l.view && l.view.file && l.view.file.path === vaultPath;
        });
        if (leaf && leaf.view && leaf.view.editor && typeof leaf.view.editor.getValue === "function") {
            return leaf.view.editor.getValue();
        }
        if (!vaultPath) throw new Error("请选择来源笔记。");
        var diskPath = path.join(VAULT_ROOT, vaultPath);
        if (!fs.existsSync(diskPath)) {
            throw new Error("找不到文件：" + vaultPath);
        }
        return fs.readFileSync(diskPath, "utf8");
    }

    function canonicalPath(filePath) {
        var absolute = path.resolve(filePath);
        return process.platform === "win32" ? absolute.toLowerCase() : absolute;
    }

    function readExternalText(filePath) {
        return normalizeNewlines(fs.readFileSync(filePath, "utf8"));
    }

    function hashText(text) {
        return crypto.createHash("sha256").update(text, "utf8").digest("hex");
    }

    function withoutTrailingNewline(text) {
        return String(text).replace(/\n$/, "");
    }

    function validateUndo(entries) {
        const typeSources = getTypeSources();
        const notes = [getLayer1Source(), typeSources.work.vaultPath, typeSources.code.vaultPath].filter(Boolean);
        const targets = new Set(getLayer1Targets().map(target => canonicalPath(target.path)));
        if (entries.some(entry => entry.kind === "target" && !targets.has(canonicalPath(entry.path)))) {
            for (const project of readRegistry().projects) targets.add(canonicalPath(project.path));
        }
        for (const entry of entries) {
            const allowed = (entry.kind === "note" && notes.includes(entry.path)) ||
                (entry.kind === "target" && targets.has(canonicalPath(entry.path))) ||
                (entry.kind === "baseline" && [LAYER1_STATE_PATH, LAYER2_STATE_PATH].includes(entry.path));
            if (!allowed) throw new Error("此文件已不在当前库的同步范围：" + entry.path);
        }
    }

    function readChange(entry) {
        return entry.kind === "note" ? syncReadVault(app, entry.path) : readText(entry.path);
    }

    async function writeChange(entry, text) {
        if (entry.kind === "note") await writeVaultFile(app, entry.path, text);
        else replaceText(entry.path, text);
        if (readChange(entry) !== text) throw new Error("写入校验失败：" + entry.path);
    }

    function changeSet() {
        const entries = [];
        const states = new Map();
        return {
            document(kind, file, after) {
                const entry = { kind, path: file, after };
                entry.before = readChange(entry);
                entries.push(entry);
            },
            baseline(channel, target, source, destination) {
                if (!states.has(channel.statePath)) {
                    states.set(channel.statePath, readChannelState(channel) || channel.newState());
                }
                updateSyncEntry(states.get(channel.statePath), channel, target, source, destination);
            },
            apply(label) {
                for (const [file, state] of states) {
                    this.document("baseline", file, JSON.stringify(state, null, 2) + "\n");
                }
                return history.apply(label, entries);
            },
        };
    }

    function makeUserChannel() {
        var channel = {
            id: "user",
            layerLabel: "第一级",
            get sourceVaultPath() { return getLayer1Source(); },
            sourceName: "用户指令源笔记",
            entriesKey: "targets",
            entryHasName: false,
            get stateSourcePath() { return getLayer1Source(); },
            hashFieldSource: "sourceHash",
            hashFieldTarget: "targetHash",
            statePath: null
        };

        channel.newState = function () {
            return { version: 1, sourcePath: getLayer1Source(), targets: [] };
        };

        // 源提取：保留可选的 frontmatter 于源笔记，正文去尾部多余换行后保留单个结尾换行。
        channel.extractSource = function (text) {
            var body = extractInstructionBody(text);
            return { section: body, sectionHash: hashText(body), fullBody: body };
        };

        // 读源侧文档：raw 供备份，section 参与对比，composeSourceText 生成写回全文。
        channel.readSourceDocument = function (app) {
            var text = normalizeNewlines(syncReadVault(app, channel.sourceVaultPath));
            var match = text.match(/^---\n[\s\S]*?\n---\n?/);

            return {
                raw: text,
                section: extractInstructionBody(text),
                composeSourceText: function (newSection) {
                    return (match ? match[0] + "\n" : "") + newSection.replace(/\n+$/, "") + "\n";
                }
            };
        };

        channel.readSourceSection = function (app) {
            return extractInstructionBody(syncReadVault(app, channel.sourceVaultPath));
        };

        channel.readSourceSectionFromDisk = function () {
            return extractInstructionBody(
                normalizeNewlines(fs.readFileSync(path.join(VAULT_ROOT, channel.sourceVaultPath), "utf8"))
            );
        };

        channel.readTargetDocument = function (targetPath) {
            return {
                section: readExternalText(targetPath),
                composeTargetText: function (newSection) { return newSection; }
            };
        };

        channel.readTargetSection = function (targetPath) {
            return readExternalText(targetPath);
        };

        // 回收建立基线时 entry 存规范化尾换行后的正文。
        channel.recycleEntryText = function (section) {
            return section.replace(/\n+$/, "") + "\n";
        };

        // 合并结果写回源侧前规范为单个结尾换行。
        channel.normalizeMerged = function (merged) {
            return merged.replace(/\n+$/, "") + "\n";
        };

        channel.text = {
            deletedAfterSync: "目标文件在上次同步后被删除；确认后可用源正文重新创建。",
            initialCreate: "目标文件不存在，确认后可以创建。",
            recordOnly: "目标内容已一致，只需建立同步基线",
            unchanged: "目标内容已与 用户指令源笔记一致，已完成同步。",
            initialReview: "目标文件与 用户指令源笔记不一致；可备份并覆盖、将目标版本回收进 用户指令源笔记，或审阅合并。",
            conflictBoth: "目标文件和 用户指令源笔记在上次同步后都被修改过；一键动作保留所选一侧、丢弃另一侧（可撤销上次操作），要两边都保留请审阅合并。",
            conflictTargetOnly: "目标文件在上次同步后被外部修改，用户指令源笔记未变；可将目标版本一键回收进 用户指令源笔记，或备份并覆盖。",
            sync: "只有 用户指令源笔记发生变化，目标文件未被外部修改。",
            unchangedNoChange: "源和目标都没有变化。",
            // 用户级目标为整份文件，不存在标题结构异常，以下两条不会触发。
            invalidStructure: "",
            invalidStructureHint: "",
            baselineNoFile: "目标内容已变化，无法只建立同步基线：",
            baselineChanged: "目标内容已变化，无法只建立同步基线：",
            changedDuringDialog: "点击后目标文件又发生了变化，已停止覆盖：",
            baselineSaved: "已建立同步基线，未改写文件。",
            createdFromSource: "目标文件不存在，已创建并建立同步基线。",
            recycleIdentical: "用户指令源笔记已与目标文件一致，已建立同步基线，未改写任何文件。",
            recycleDone: "已把目标文件正文回收进 用户指令源笔记，同步基线已更新。",
            recycleTail: "",
            mergeDone: "两边已一致，该目标同步基线已更新。",
            mergeUnsavedSource: "两侧内容一致，但 用户指令源笔记在编辑器中还有未保存的修改。\n请先保存源笔记，再点击面板底部的「刷新」。",
            mergeIdentical: "两侧内容完全一致，已为该目标建立同步基线。",
            mergeTitle: function (target) { return "行级合并：" + target.name + " ← 用户指令源笔记"; },
            mergeHelp: "勾=保留该行，不勾=移除。红行=仅 用户指令源笔记有（默认不保留），绿行=仅目标文件有（默认保留）。" +
                "默认合并结果即目标文件当前正文；勾选红行可把笔记侧多出的内容并入。" +
                "写回时 用户指令源笔记正文与目标文件同时替换为合并结果，两边保持一致；写回保留源笔记 frontmatter。",
            mergeSourceLabel: "用户指令源笔记",
            mergeApplyLabel: "写回 用户指令源笔记与目标文件"
        };

        return channel;
    }

    // 类型通道（work／code）：源为类型模板，只同步第 1 个一级标题区块。
    function makeTypeChannel(typeKey) {
        var typeNames = { work: "Work 类型模板", code: "Code 类型模板" };
        var sourceTitle = typeNames[typeKey];
        var channel = {
            id: typeKey,
            layerLabel: "第二级",
            get sourceVaultPath() { return getTypeSources()[typeKey].vaultPath; },
            sourceName: sourceTitle,
            entriesKey: "projects",
            entryHasName: true,
            stateSourcePath: null,
            hashFieldSource: "sourceSectionHash",
            hashFieldTarget: "targetSectionHash",
            statePath: null
        };

        channel.newState = function () {
            return { version: 1, projects: [] };
        };

        // 源提取：第 1 个「# 」一级标题到第 2 个之间的区块参与同步；
        // fullBody 含第三级示例，仅首次接入生成完整项目文件时使用。
        channel.extractSource = function (text) {
            var structure = parseWorkStructure(text);
            return {
                section: structure.workSection,
                sectionHash: hashText(structure.workSection),
                fullBody: (structure.before + structure.workSection + "\n" + structure.after).replace(/\n+$/, "\n")
            };
        };

        channel.readSourceDocument = function (app) {
            var text = normalizeNewlines(syncReadVault(app, channel.sourceVaultPath));
            var structure = parseWorkStructure(text);
            return {
                raw: text,
                section: structure.workSection,
                composeSourceText: function (newSection) {
                    return rebuildDocument(structure, newSection);
                }
            };
        };

        channel.readSourceSection = function (app) {
            return parseWorkStructure(syncReadVault(app, channel.sourceVaultPath)).workSection;
        };

        channel.readSourceSectionFromDisk = function () {
            return parseWorkStructure(
                normalizeNewlines(fs.readFileSync(path.join(VAULT_ROOT, channel.sourceVaultPath), "utf8"))
            ).workSection;
        };

        channel.readTargetDocument = function (targetPath) {
            var structure = parseWorkStructure(readExternalText(targetPath));
            return {
                section: structure.workSection,
                composeTargetText: function (newSection) {
                    return rebuildDocument(structure, newSection);
                }
            };
        };

        channel.readTargetSection = function (targetPath) {
            return parseWorkStructure(readExternalText(targetPath)).workSection;
        };

        channel.recycleEntryText = function (section) {
            return section;
        };

        channel.normalizeMerged = function (merged) {
            return merged;
        };

        channel.text = {
            deletedAfterSync: "项目文件在上次同步后被删除；确认后可用模板重新生成完整文件。",
            initialCreate: "项目文件不存在，确认后从 " + sourceTitle + " 生成完整文件（含第三级示例，需自行按项目事实填写）。",
            recordOnly: "工作规范区块已与模板一致，只需建立同步基线。",
            unchanged: "工作规范区块已与模板一致，已完成同步。",
            initialReview: "首次接入且工作规范与模板存在差异；可将项目版本回收进模板、用模板覆盖项目区块，或审阅合并。",
            conflictBoth: "模板和项目工作规范在上次同步后都被修改过；一键动作保留所选一侧、丢弃另一侧（可撤销上次操作），要两边都保留请审阅合并。",
            conflictTargetOnly: "项目工作规范在上次同步后被修改，模板与上次分发时一致；可将项目版本一键回收进模板，或用模板覆盖项目区块。",
            sync: "模板已更新，项目工作规范仍是上次分发版本；将备份项目文件后只替换工作规范区块。",
            unchangedNoChange: "源和目标都没有变化。",
            invalidStructure: "标题结构异常，已停止处理：",
            invalidStructureHint: "\n请先人工整理为「第 1 个一级标题＝类型区块、第 2 个一级标题＝项目内容」的结构，正文顶部不要加 H1 文档标题，再运行同步。",
            baselineNoFile: "项目文件已不存在，无法建立基线：",
            baselineChanged: "项目工作规范已变化，无法只建立基线：",
            changedDuringDialog: "点击后项目工作规范又发生了变化，已停止覆盖：",
            baselineSaved: "已建立同步基线，未改写项目文件。",
            createdFromSource: "已从 " + sourceTitle + " 生成完整项目文件，并建立同步基线。",
            recycleIdentical: "模板已与项目工作规范一致，已建立同步基线，未改写任何文件。",
            recycleDone: "已把项目工作规范回收进 " + sourceTitle + "，该项目同步基线已更新。",
            recycleTail: "\n现在可直接分发给其他同类型项目。",
            mergeDone: "两边已一致，该项目同步基线已更新；现在可直接分发给其他同类型项目。",
            mergeUnsavedSource: "两侧内容一致，但模板在编辑器中还有未保存的修改。\n请先保存模板，再点击面板底部的「刷新」。",
            mergeIdentical: "两侧内容完全一致，已为该项目建立同步基线。",
            mergeTitle: function (target) { return "行级合并：" + target.name + " 工作规范 ← " + sourceTitle; },
            mergeHelp: "勾=保留该行，不勾=移除。红行=仅模板有（默认不保留），绿行=仅项目有（默认保留）。" +
                "默认合并结果即项目当前版本；勾选红行可把模板侧多出的内容并入。" +
                "写回时模板与项目的工作规范区块同时替换为合并结果，两边保持一致；" +
                "模板 frontmatter、第 2 个一级标题之后的内容和项目第三级保持不变。",
            mergeSourceLabel: "模板",
            mergeApplyLabel: "写回模板与项目"
        };

        return channel;
    }

    // ===== 通道状态 =====

    function readChannelState(channel) {
        if (!fs.existsSync(channel.statePath)) {
            return null;
        }
        try {
            var parsed = JSON.parse(fs.readFileSync(channel.statePath, "utf8"));
            if (!parsed || !Array.isArray(parsed[channel.entriesKey])) {
                throw new Error("结构不正确");
            }
            return parsed;
        } catch (error) {
            throw new Error(
                channel.layerLabel + "同步状态文件无法读取，已停止以避免误覆盖：\n" +
                    channel.statePath + "\n\n" + (error.message || String(error))
            );
        }
    }

    function findSyncEntry(channel, state, targetPath) {
        if (!state || !Array.isArray(state[channel.entriesKey])) {
            return null;
        }
        var key = canonicalPath(targetPath);
        return state[channel.entriesKey].find(function (entry) {
            return canonicalPath(entry.path) === key;
        }) || null;
    }

    function updateSyncEntry(state, channel, target, sourceText, targetText) {
        var key = canonicalPath(target.path);
        var now = new Date().toISOString();
        var entry = { path: key };
        if (channel.entryHasName) {
            entry.type = target.type;
            entry.name = target.name;
        }
        entry[channel.hashFieldSource] = hashText(sourceText);
        entry[channel.hashFieldTarget] = hashText(targetText);
        entry.syncedAt = now;
        var entries = state[channel.entriesKey];
        var index = entries.findIndex(function (item) {
            return canonicalPath(item.path) === key;
        });
        if (index >= 0) entries[index] = entry;
        else entries.push(entry);
        state.version = 1;
        if (channel.stateSourcePath) state.sourcePath = channel.stateSourcePath;
        state.updatedAt = now;

    }

    // ===== 登记表与通道源加载 =====

    function writeState(file, data) {
        fs.mkdirSync(STATE_ROOT, { recursive: true });
        const next = file + "." + crypto.randomUUID() + ".tmp";
        try {
            fs.writeFileSync(next, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
            fs.renameSync(next, file);
        } finally {
            if (fs.existsSync(next)) fs.unlinkSync(next);
        }
    }

    function readRegistry() {
        if (!fs.existsSync(REGISTRY_PATH)) {
            return { version: 1, projects: [] };
        }

        var parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
        } catch (error) {
            throw new Error("项目登记表无法解析，第二级已停止：\n" + error.message);
        }
        if (!parsed || !Array.isArray(parsed.projects)) {
            throw new Error("项目登记表结构不正确（缺少 projects 数组），第二级已停止。");
        }

        var problems = [];
        parsed.projects.forEach(function (project, index) {
            var label = project && typeof project.name === "string" && project.name
                ? project.name
                : "第 " + (index + 1) + " 项";
            if (!project || typeof project.name !== "string" || !project.name) {
                problems.push(label + "：缺少 name");
            }
            if (!project || !getTypeSources()[project.type]) {
                problems.push(label + "：type 必须是 work 或 code");
            }
            if (!project || typeof project.path !== "string" || !project.path) {
                problems.push(label + "：缺少 path");
            }
        });
        if (problems.length > 0) {
            throw new Error("项目登记表存在以下问题，第二级已停止：\n" + problems.join("\n"));
        }

        return parsed;
    }

    async function loadTypeSources(app, registry) {
        var needed = {};
        registry.projects.forEach(function (project) {
            needed[project.type] = true;
        });

        var sources = {};
        var errors = {};
        for (var typeKey in needed) {
            var channel = TYPE_CHANNELS[typeKey];
            try {
                var text = await readVaultFile(app, channel.sourceVaultPath);
                var extracted = channel.extractSource(text);
                extracted.name = channel.sourceName;
                extracted.vaultPath = channel.sourceVaultPath;
                sources[typeKey] = extracted;
            } catch (error) {
                errors[typeKey] = channel.sourceName + "结构异常，该类型所有项目本轮停止：" + error.message;
            }
        }
        return { sources: sources, errors: errors };
    }

    // 第二级按 Work／Code 分别构建计划；源加载失败的类型，其项目全部标记为 invalid。
    function buildTypePlans(projects, sources, errors) {
        var state = readChannelState(TYPE_CHANNELS.work);
        var targets = [];
        ["work", "code"].forEach(function (typeKey) {
            var channel = TYPE_CHANNELS[typeKey];
            var typeProjects = projects.filter(function (project) {
                return project.type === typeKey;
            });
            if (typeProjects.length === 0) return;
            var source = sources[typeKey] || null;
            var sourceError = errors[typeKey] || null;
            targets = targets.concat(buildChannelPlan(channel, typeProjects, source, sourceError, state).targets);
        });
        return { targets: targets };
    }

    // ===== 通用状态机（两级共用） =====

    // 通道计划：对每个目标判定同步动作。动作含义：
    //   initial-create 目标不存在且无基线，可从源创建
    //   record-only    目标与源已一致但无基线，只需建立基线
    //   unchanged      目标与源一致且已有基线
    //   initial-review 首次接入且目标与源存在差异
    //   sync           只有源变化，目标仍是上次分发版本
    //   conflict       目标在上次同步后被外部修改
    //   invalid        源加载失败或目标标题结构异常，该目标停止处理
    function buildChannelPlan(channel, targetList, source, sourceError, state) {
        var targets = [];

        targetList.forEach(function (item) {
            var target = {
                channel: channel,
                name: item.name,
                type: item.type || null,
                // 保留原始大小写供读写磁盘与显示；大小写无关的比较只在
                // findSyncEntry／saveSyncEntry 内部做规范化。
                path: item.path,
                displayPath: item.displayPath || item.path,
                sourceVaultPath: channel.sourceVaultPath,
                source: source,
                currentHash: null,
                action: null,
                reason: "",
                sourceChangedSinceSync: false
            };

            if (sourceError) {
                target.action = "invalid";
                target.reason = sourceError;
                targets.push(target);
                return;
            }

            if (!fs.existsSync(target.path) || !fs.statSync(target.path).isFile()) {
                var missing = findSyncEntry(channel, state, target.path);
                if (missing) {
                    target.action = "conflict";
                    target.reason = channel.text.deletedAfterSync;
                } else {
                    target.action = "initial-create";
                    target.reason = channel.text.initialCreate;
                }
                targets.push(target);
                return;
            }

            var document;
            try {
                document = channel.readTargetDocument(target.path);
            } catch (error) {
                target.action = "invalid";
                target.reason = channel.text.invalidStructure + error.message + channel.text.invalidStructureHint;
                targets.push(target);
                return;
            }

            var currentHash = hashText(document.section);
            target.currentHash = currentHash;
            var previous = findSyncEntry(channel, state, target.path);

            if (currentHash === source.sectionHash) {
                if (!previous) {
                    target.action = "record-only";
                    target.reason = channel.text.recordOnly;
                } else {
                    target.action = "unchanged";
                    target.reason = channel.text.unchanged;
                }
            } else if (!previous) {
                target.action = "initial-review";
                target.reason = channel.text.initialReview;
            } else if (currentHash !== previous[channel.hashFieldTarget]) {
                target.action = "conflict";
                target.sourceChangedSinceSync = source.sectionHash !== previous[channel.hashFieldSource];
                target.reason = target.sourceChangedSinceSync
                    ? channel.text.conflictBoth
                    : channel.text.conflictTargetOnly;
            } else if (source.sectionHash !== previous[channel.hashFieldSource]) {
                target.action = "sync";
                target.reason = channel.text.sync;
            } else {
                target.action = "unchanged";
                target.reason = channel.text.unchangedNoChange;
            }

            targets.push(target);
        });

        return { targets: targets };
    }

    function assertSourceUnchanged(target) {
        if (target.sourceVaultPath && target.channel.sourceVaultPath !== target.sourceVaultPath) {
            throw new Error("源笔记设置已变化，请先点击「刷新」再操作。");
        }
    }

    // 分发（含建立基线与覆盖确认）：目标不存在时从源生成完整文件，
    // 已存在时只替换参与同步的部分，通道外的内容（如第三级）原样保留。
    function planDistribution(changes, target) {
        assertSourceUnchanged(target);
        const { channel, source } = target;
        const current = fs.existsSync(target.path) ? channel.readTargetDocument(target.path) : null;
        if (channel.extractSource(syncReadVault(app, channel.sourceVaultPath)).fullBody !== source.fullBody ||
            (current ? hashText(current.section) : null) !== target.currentHash) {
            throw new Error(channel.text.changedDuringDialog + target.path);
        }
        if (!current || current.section !== source.section) {
            changes.document("target", target.path, current ? current.composeTargetText(source.section) : source.fullBody);
        }
        changes.baseline(channel, target, source.section, source.section);
    }

    async function applyChannelAction(channel, target) {
        const changes = changeSet();
        planDistribution(changes, target);
        await changes.apply("分发到 " + target.name);
        return target.action === "record-only" ? channel.text.baselineSaved : "已分发到 " + target.name;
    }

    async function applyChannelRecycle(channel, target, app) {
        assertSourceUnchanged(target);
        const external = channel.readTargetSection(target.path);
        const source = channel.readSourceDocument(app);
        if (hashText(external) !== target.currentHash || source.section !== target.source.section) {
            throw new Error(channel.text.changedDuringDialog + target.path);
        }
        const changes = changeSet();
        if (source.section !== external) {
            changes.document("note", channel.sourceVaultPath, source.composeSourceText(external));
        }
        const section = channel.recycleEntryText(external);
        changes.baseline(channel, target, section, section);
        await changes.apply("从 " + target.name + " 回收");
        return channel.text.recycleDone + channel.text.recycleTail;
    }

    // ===== 行级对比合并（两级共用） =====

    function showMergeModal(config) {
        return new Promise(function (resolve) {
            var ops;
            try {
                // 复核打开时的快照仍然有效（读取函数可能因文件变化抛错）。
                if (config.getLeft() !== config.leftText || config.getRight() !== config.rightText) {
                    throw new Error("两侧内容在打开前发生变化，请重新运行。");
                }
                ops = computeLineDiff(
                    config.leftText.replace(/\n$/, "").split("\n"),
                    config.rightText.replace(/\n$/, "").split("\n")
                );
            } catch (error) {
                showMessage("行级对比失败", error.message || String(error)).then(function () {
                    resolve("error");
                });
                return;
            }

            // 默认采纳外部侧（绿）行：合并起点即目标文件当前版本；
            // 源侧（红）行需勾选才并入，避免替换行的新旧两个版本默认并存。
            var keepFlags = ops.map(function (op) {
                return op.type === "ins";
            });

            var hasDiff = ops.some(function (op) { return op.type !== "equal"; });
            if (!hasDiff) {
                // 两侧一致本身就是可信证据：安全条件下直接建立同步基线，
                // 用户不必再重跑一次命令只为刷新卡片状态。
                Promise.resolve().then(() => config.onIdentical()).then(
                    message => showMessage("没有差异", message),
                    error => showMessage("没有差异", "更新同步状态失败：" + error.message)
                ).then(() => resolve("noop"));
                return;
            }

            var modal = createModal({
                title: config.title, width: 900, widthVw: 96, maxHeight: 90,
                onClose: function () { resolve("cancel"); }
            });
            modal.header.style.cssText =
                "padding:14px 18px;font-size:16px;font-weight:600;" +
                "border-bottom:1px solid var(--background-modifier-border);" +
                "display:flex;justify-content:space-between;align-items:center;gap:12px;";
            modal.header.appendChild(el("div",
                "font-family:var(--font-monospace);font-size:11px;color:var(--text-muted);" +
                "font-weight:400;word-break:break-all;max-width:60%;", config.pathText));

            var body = modal.body;
            body.style.cssText = "padding:0 18px;overflow:auto;flex:1;";

            var help = el("div",
                "padding:12px 0;line-height:1.6;color:var(--text-muted);font-size:12px;", config.helpText);

            var listContainer = el("div",
                "border:1px solid var(--background-modifier-border);border-radius:6px;" +
                "font-family:var(--font-monospace);font-size:12px;line-height:1.7;");

            var previewLabel = el("div", "margin:14px 0 6px;font-size:12px;font-weight:600;",
                config.previewLabel || "合并后源侧内容（实时刷新）：");

            var preview = el("pre",
                "margin:0;padding:10px;border:1px solid var(--background-modifier-border);" +
                "border-radius:6px;background:var(--background-secondary);" +
                "font-family:var(--font-monospace);font-size:12px;line-height:1.6;" +
                "white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto;");

            function refreshPreview() {
                preview.textContent = composeMergedBody(ops, keepFlags);
            }

            ops.forEach(function (op, k) {
                if (op.type === "equal") {
                    listContainer.appendChild(el("div",
                        "color:var(--text-muted);white-space:pre-wrap;word-break:break-all;" +
                        "padding:0 10px;", "  " + (op.text === "" ? "" : op.text)));
                    return;
                }

                var row = el("label",
                    "display:flex;align-items:flex-start;gap:8px;padding:2px 10px;cursor:pointer;" +
                    (op.type === "del"
                        ? "background:rgba(255,80,80,.12);"
                        : "background:rgba(80,200,120,.12);") +
                    "white-space:pre-wrap;word-break:break-all;");

                var cb = document.createElement("input");
                cb.type = "checkbox";
                cb.checked = keepFlags[k];
                cb.style.cssText = "margin-top:4px;flex-shrink:0;";
                cb.onchange = function () {
                    keepFlags[k] = cb.checked;
                    refreshPreview();
                };

                row.appendChild(cb);
                row.appendChild(el("span", "flex-shrink:0;color:var(--text-faint);min-width:110px;",
                    op.type === "del"
                        ? "[仅" + config.sourceLabel + " L" + op.aLine + "]"
                        : "[仅" + config.externalLabel + " L" + op.bLine + "]"));
                row.appendChild(el("span", null, op.text === "" ? "（空行）" : op.text));
                listContainer.appendChild(row);
            });

            var cancelButton = el("button", null, "取消");
            cancelButton.onclick = function () {
                modal.close();
                resolve("cancel");
            };

            var applyButton = el("button", null, config.applyLabel || "写回源侧");
            applyButton.className = "mod-cta";
            applyButton.onclick = async function () {
                applyButton.disabled = true;
                try {
                    // 复核弹窗打开期间两侧内容都没有再变化。
                    if (config.getLeft() !== config.leftText) {
                        throw new Error("源侧在弹窗打开期间发生了变化，已中止。请重新打开对比。");
                    }
                    if (config.getRight() !== config.rightText) {
                        throw new Error("外部文件在弹窗打开期间发生了变化，已中止。请重新打开对比。");
                    }

                    var mergedText = composeMergedBody(ops, keepFlags);
                    if (mergedText.replace(/\s+/g, "") === "") {
                        throw new Error("合并结果为空，已中止。如确认清空，请手动处理。");
                    }

                    var resultMessage = await config.apply(mergedText);
                    // 先落定结果再关闭：onClose 会按"取消"收场，Promise 已落定的结果不会被覆盖。
                    resolve("applied");
                    modal.close();
                    showMessage("合并完成", resultMessage);
                } catch (error) {
                    applyButton.disabled = false;
                    showMessage("写回失败", error.message || String(error));
                }
            };

            body.appendChild(help);
            body.appendChild(listContainer);
            body.appendChild(previewLabel);
            body.appendChild(preview);

            modal.footer.appendChild(cancelButton);
            modal.footer.appendChild(applyButton);
            refreshPreview();
        });
    }

    function buildChannelMergeConfig(channel, target, app) {
        var sourceSectionNow = channel.readSourceSection(app);
        var targetSectionNow = channel.readTargetSection(target.path);
        return {
            title: channel.text.mergeTitle(target),
            pathText: target.displayPath,
            helpText: channel.text.mergeHelp,
            sourceLabel: channel.text.mergeSourceLabel,
            externalLabel: target.name,
            leftText: sourceSectionNow,
            rightText: targetSectionNow,
            getLeft: function () {
                assertSourceUnchanged(target);
                return channel.readSourceSection(app);
            },
            getRight: function () {
                return channel.readTargetSection(target.path);
            },
            onIdentical: async function () {
                assertSourceUnchanged(target);
                var diskSection = channel.readSourceSectionFromDisk();
                if (diskSection !== sourceSectionNow) {
                    return channel.text.mergeUnsavedSource;
                }
                await exclusive(async () => {
                    const changes = changeSet();
                    changes.baseline(channel, target, diskSection, diskSection);
                    await changes.apply("建立同步基线 " + target.name);
                });
                return channel.text.mergeIdentical;
            },
            applyLabel: channel.text.mergeApplyLabel,
            previewLabel: "合并结果（同时写回两侧，实时刷新）：",
            apply: async function (mergedSection) {
                assertSourceUnchanged(target);
                // 两侧先解析核对、再写回，避免写回一半留下不一致状态。
                var normalized = channel.normalizeMerged(mergedSection);
                var sourceDocument = channel.readSourceDocument(app);
                var targetDocument = channel.readTargetDocument(target.path);

                return exclusive(async () => {
                    const changes = changeSet();
                    if (sourceDocument.section !== normalized) {
                        changes.document("note", channel.sourceVaultPath, sourceDocument.composeSourceText(normalized));
                    }
                    if (targetDocument.section !== normalized) {
                        changes.document("target", target.path, targetDocument.composeTargetText(normalized));
                    }
                    changes.baseline(channel, target, normalized, normalized);
                    await changes.apply("合并 " + target.name);
                    return channel.text.mergeDone;
                });
            }
        };
    }

    // ===== 统一面板 =====

    // 用户级、Work 和 Code 的卡片共用按钮和推荐规则，读写范围由通道决定。
    // unregister 由面板提供（第二级专用）：移除登记后清待处理计数；第一级不传。
    function appendChannelTargets(pane, targets, key, app, wrapRun, unregister, onChanged) {
        targets.forEach(function (target) {
            var buttons = [];
            var fileExists = fs.existsSync(target.path);
            var channel = target.channel;
            var distribute = wrapRun(key, target, function () {
                return applyChannelAction(channel, target);
            });
            var recycle = wrapRun(key, target, function () {
                return applyChannelRecycle(channel, target, app);
            });
            var afterSuccess = function (message) {
                new Notice(message);
                return onChanged ? onChanged() : undefined;
            };
            const hasDifferences = fileExists && target.currentHash !== null &&
                ["sync", "initial-review", "conflict"].includes(target.action);
            var openMerge = async function () {
                if (target.sourceVaultPath && channel.sourceVaultPath !== target.sourceVaultPath) {
                    return showMessage("行级对比失败", "源笔记设置已变化，请先点击「刷新」再操作。").then(function () { return "error"; });
                }
                return showMergeModal(buildChannelMergeConfig(channel, target, app));
            };
            var afterMerge = onChanged ? function () { return onChanged(); } : null;

            if (hasDifferences) {
                const preferMerge = target.action === "initial-review" || target.sourceChangedSinceSync;
                buttons = [
                    { label: "回收\n改动", primary: target.action === "conflict" && !preferMerge, run: recycle, afterSuccess },
                    { label: "覆盖\n改动", primary: target.action === "sync", run: distribute, afterSuccess },
                    { label: "审阅\n合并", primary: preferMerge, openMerge, afterMerge }
                ];
            } else if (!fileExists && target.currentHash === null && ["initial-create", "conflict"].includes(target.action)) {
                buttons.push({ label: "创建目标文件", primary: true, run: distribute, afterSuccess });
            } else if (fileExists && target.action === "record-only") {
                buttons.push({ label: "建立同步基线", primary: true, run: distribute, afterSuccess });
            }

            // 第一级目标卡片提供移出分发列表入口（右上角 ×）；第二级卡片提供移除登记入口。
            var removeEntry = null;
            if (channel.id === "user") {
                removeEntry = buildLayer1RemoveEntry(target, onChanged);
            } else if (unregister) {
                removeEntry = {
                    remove: function () { return unregisterProject(target); },
                    afterRemove: function () { unregister(key, target); }
                };
            }

            var statusText = TARGET_STATUS[target.action];
            if (target.action === "conflict") {
                statusText = !fileExists ? "目标文件已删除"
                    : target.sourceChangedSinceSync ? "两边都有修改" : "目标已修改";
            }
            appendCard(pane, {
                title: target.name,
                pathText: target.displayPath,
                reason: target.reason,
                statusText: statusText,
                buttons: buttons,
                removeEntry: removeEntry
            });
        });
    }

    // ===== 弹窗骨架（各弹窗共用） =====

    // 创建带样式的元素；cssText、textContent 为空时跳过对应设置。
    function el(tag, cssText, textContent) {
        var node = document.createElement(tag);
        if (cssText) node.style.cssText = cssText;
        if (textContent) node.textContent = textContent;
        return node;
    }

    function createModal(options) {
        const dialog = plugin.openDialog(options.title, options.onClose);
        dialog.modalEl.style.width = "min(" + options.width + "px, " + options.widthVw + "vw)";
        dialog.modalEl.style.maxHeight = options.maxHeight + "vh";
        const footer = el("div", null);
        footer.className = "modal-button-container";
        dialog.modalEl.appendChild(footer);
        return { header: dialog.titleEl, body: dialog.contentEl, footer, close: () => dialog.close() };
    }

    // 把输入路径归一为 AGENTS.md 完整路径写入登记表，并返回该项目的计划目标。
    // 接受文件夹路径或文件路径，兼容反斜杠与资源管理器复制的带引号路径；
    // 项目名自动取文件夹名。返回 { target } 或 { error }。
    function registerProject(app, typeKey, inputText) {
        var raw = String(inputText || "").trim()
            .replace(/^["']+|["']+$/g, "")
            .replace(/\\/g, "/");
        if (raw.startsWith("~/")) raw = path.join(os.homedir(), raw.slice(2)).replace(/\\/g, "/");
        if (!path.isAbsolute(raw)) return { error: "请填写绝对路径。" };
        if (!raw) {
            return { error: "请先粘贴项目路径。" };
        }
        raw = raw.replace(/[\\/]+$/, "");
        var filePath = /\/AGENTS\.md$/i.test(raw) ? raw : raw + "/AGENTS.md";
        var folder = filePath.slice(0, filePath.length - "/AGENTS.md".length);
        if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
            return { error: "目录不存在，请确认路径：" + folder };
        }

        var registry = readRegistry();
        var key = canonicalPath(filePath);
        var duplicate = registry.projects.find(function (project) {
            return canonicalPath(project.path) === key;
        });
        if (duplicate) {
            return { error: "该项目已在登记表中：" + duplicate.name };
        }

        var name = path.basename(folder);
        registry.projects.push({ name: name, type: typeKey, path: filePath });
        fs.mkdirSync(STATE_ROOT, { recursive: true });
        writeState(REGISTRY_PATH, registry);

        var channel = TYPE_CHANNELS[typeKey];
        var source = null;
        var sourceError = null;
        try {
            var text = syncReadVault(app, channel.sourceVaultPath);
            source = channel.extractSource(text);
            source.name = channel.sourceName;
            source.vaultPath = channel.sourceVaultPath;
        } catch (error) {
            sourceError = channel.sourceName + "结构异常，该类型所有项目本轮停止：" + (error.message || String(error));
        }
        var plan = buildChannelPlan(channel, [{ name: name, type: typeKey, path: filePath }], source, sourceError, readChannelState(channel));
        return { target: plan.targets[0] };
    }

    // 从登记表移除项目并同步清理其基线条目；项目文件本身不动，重新登记即可恢复跟踪。
    // 先读后写：登记表或状态文件读取失败时整体不执行，避免登记已删而基线残留。
    function unregisterProject(target) {
        var key = canonicalPath(target.path);
        if (plugin.syncBusy) throw new Error("请等待当前同步操作完成。");
        var registry = readRegistry();
        var registryIndex = registry.projects.findIndex(function (project) {
            return canonicalPath(project.path) === key;
        });
        if (registryIndex < 0) {
            throw new Error("项目已不在登记表中：" + (target.displayPath || target.path));
        }

        var channel = TYPE_CHANNELS[target.type] || null;
        var state = channel ? readChannelState(channel) : null;
        var entries = state && Array.isArray(state.projects) ? state.projects : null;
        var stateIndex = entries
            ? entries.findIndex(function (entry) { return canonicalPath(entry.path) === key; })
            : -1;

        registry.projects.splice(registryIndex, 1);
        fs.mkdirSync(STATE_ROOT, { recursive: true });
        writeState(REGISTRY_PATH, registry);
        if (stateIndex >= 0) {
            entries.splice(stateIndex, 1);
            state.updatedAt = new Date().toISOString();
            writeState(channel.statePath, state);
        }

        return "已移除 " + target.name + " 的登记与同步基线；项目文件未改动，重新登记可恢复跟踪。";
    }

    // 类型标签页顶部的登记输入行；登记成功后经 onRegistered 追加该项目卡片，
    // 校验失败在输入行下方红字提示，不动登记表。
    function appendRegisterRow(pane, typeKey, typeName, app, onRegistered) {
        var row = el("div", "display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;");
        var input = el("input",
            "flex:1 1 16em;min-width:0;padding:6px 10px;border:1px solid var(--background-modifier-border);" +
            "border-radius:6px;font-size:13px;");
        input.placeholder = "粘贴项目文件夹或 AGENTS.md 路径";
        var button = el("button", null, "登记为 " + typeName + " 项目");
        var error = el("div", "color:var(--text-error);font-size:12px;line-height:1.5;");

        var run = function () {
            error.textContent = "";
            var result;
            try {
                result = registerProject(app, typeKey, input.value);
            } catch (err) {
                error.textContent = err.message || String(err);
                return;
            }
            if (result.error) {
                error.textContent = result.error;
                return;
            }
            input.value = "";
            onRegistered(result.target);
        };
        button.onclick = run;
        input.onkeydown = function (event) {
            if (event.key === "Enter") run();
        };

        row.appendChild(input);
        row.appendChild(button);
        pane.appendChild(row);
        pane.appendChild(error);
    }

    function appendSourceRow(pane, key, extraAction) {
        const label = SOURCE_LABELS[key];
        const group = el("div", "margin:6px 0 8px;padding:6px 8px;border-radius:6px;background:var(--background-secondary);");
        const row = el("div", "display:flex;flex-wrap:wrap;align-items:center;gap:6px;");
        const field = el("label", "display:flex;align-items:center;gap:8px;flex:1 1 16em;min-width:0;");
        const name = el("span", "flex-shrink:0;font-weight:600;font-size:13px;", label);
        const input = el("input", "flex:1;min-width:0;font-size:13px;");
        input.type = "text";
        input.setAttribute("aria-label", label);
        input.placeholder = "请选择来源笔记。";
        input.defaultValue = plugin.settings[key] || "";
        if (sourceDrafts.has(key)) input.value = sourceDrafts.get(key);
        const choose = el("button", null, "选择笔记");
        choose.type = "button";
        choose.setAttribute("aria-label", "选择" + label);
        const save = el("button", null, "保存");
        save.type = "button";
        const error = el("div", "color:var(--text-error);font-size:12px;");
        error.setAttribute("role", "alert");

        input.oninput = () => {
            sourceDrafts.set(key, input.value);
            input.removeAttribute("aria-invalid");
            error.textContent = "";
        };
        choose.onclick = () => {
            const picker = new NotePicker(plugin, notePath => {
                input.value = notePath;
                input.oninput();
            });
            plugin.modals.add(picker);
            picker.open();
        };
        save.onclick = async () => {
            error.textContent = "";
            input.removeAttribute("aria-invalid");
            let next;
            try {
                next = vaultPath(input.value === input.defaultValue ? input.value : input.value.trim());
            } catch (err) {
                error.textContent = err.message;
                input.setAttribute("aria-invalid", "true");
                input.focus();
                return;
            }
            input.disabled = choose.disabled = save.disabled = true;
            try {
                await exclusive(() => plugin.updateSettings(current => (
                    next === current[key] ? null : { ...current, [key]: next }
                )));
                sourceDrafts.delete(key);
                await safeRefresh();
            } catch (err) {
                error.textContent = err.message || "设置保存失败。";
            } finally {
                input.disabled = choose.disabled = save.disabled = false;
            }
        };
        input.onkeydown = event => {
            if (event.key === "Enter" && !event.isComposing) save.onclick();
        };

        field.appendChild(name);
        field.appendChild(input);
        row.appendChild(field);
        row.appendChild(choose);
        row.appendChild(save);
        if (extraAction) row.appendChild(extraAction);
        group.appendChild(row);
        group.appendChild(error);
        pane.appendChild(group);
    }

    // 移除入口固定在右上角，同步按钮并排排列在右侧。
    function appendCard(content, card) {
        var row = el("div",
            "border:1px solid var(--background-modifier-border);border-radius:6px;" +
            "position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;" +
            "padding:6px 10px;margin-bottom:5px;" +
            (card.removeEntry ? "padding-right:34px;" : ""));
        var status = el("div",
            "flex:0 1 auto;max-width:min(100%,17em);color:var(--text-muted);font-size:12px;" +
            "line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere;", card.statusText || card.reason);
        if (card.statusText) status.title = card.reason;
        var buttonRow = el("div",
            "display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;margin-left:auto;max-width:100%;" +
            "--interactive-accent:#1765c5;--interactive-accent-hover:#1458ac;--text-on-accent:#fff;");
        var titleBlock = el("div", "flex:1 1 9em;min-width:0;line-height:1.4;");
        titleBlock.appendChild(el("div", "font-weight:600;overflow-wrap:anywhere;", card.title));
        var pathText = el("div",
            "font-family:var(--font-monospace);font-size:12px;color:var(--text-muted);" +
            "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", card.pathText);
        if (card.pathText) {
            pathText.title = card.pathText;
            titleBlock.appendChild(pathText);
        }
        row.appendChild(titleBlock);
        row.appendChild(status);

        if (card.removeEntry) {
            var remove = card.removeEntry;
            var closeButton = el("button",
                "background:transparent;border:none;box-shadow:none;cursor:pointer;" +
                "position:absolute;top:3px;right:3px;height:24px;width:24px;padding:0;" +
                "color:var(--text-faint);font-size:18px;line-height:1;", "×");
            closeButton.setAttribute("aria-label", remove.ariaLabel || "移除登记");
            closeButton.title = remove.tooltip || "移除登记（项目文件不改动）";
            closeButton.onmouseenter = function () { closeButton.style.color = "var(--text-error)"; };
            closeButton.onmouseleave = function () { closeButton.style.color = "var(--text-faint)"; };
            closeButton.onclick = function () {
                showConfirm(
                    remove.confirmTitle || "移除登记",
                    remove.confirmMessage || ("将把 " + card.title + " 从项目登记表移除，并清理它的同步基线。\n" +
                        "项目文件夹和 AGENTS.md 不会改动；重新登记即可恢复跟踪。"),
                    remove.confirmButton || "移除登记"
                ).then(async function (confirmed) {
                    if (!confirmed) return;
                    closeButton.disabled = true;
                    try {
                        var message = await remove.remove();
                        row.remove();
                        if (remove.notify) new Notice(message);
                        else showMessage(remove.confirmTitle || "移除登记", message);
                        if (remove.afterRemove) await remove.afterRemove();
                    } catch (error) {
                        closeButton.disabled = false;
                        status.textContent = (remove.confirmTitle || "移除登记") + "未完成：" + (error.message || String(error));
                    }
                });
            };
            row.appendChild(closeButton);
        }

        var runButtons = [];
        (card.buttons || []).forEach(function (entry) {
            var button = el("button",
                "font-size:12px;padding:3px 7px;min-height:26px;height:auto;max-width:100%;white-space:normal;",
                entry.label);
            if (entry.label.includes("\n")) {
                button.style.whiteSpace = "pre";
                button.style.lineHeight = "1.25";
                button.setAttribute("aria-label", entry.label.replace("\n", ""));
            }
            if (entry.primary) {
                button.className = "mod-cta";
            }

            if (entry.openMerge) {
                button.onclick = function () {
                    button.disabled = true;
                    entry.openMerge().then(async function (result) {
                        // 合并已写回两侧或建立基线，本卡片一键动作基于的旧内容全部失效。
                        if (result === "applied" || result === "noop") {
                            runButtons.forEach(function (other) {
                                other.disabled = true;
                            });
                            if (entry.afterMerge) await entry.afterMerge(result);
                        }
                        button.disabled = result === "applied" || result === "noop";
                    }).catch(function (error) {
                        status.textContent = "未完成：" + (error.message || String(error));
                        button.disabled = false;
                    });
                };
            } else {
                button.onclick = async function () {
                    button.disabled = true;
                    status.textContent = "正在处理……";
                    try {
                        var resultMessage = await entry.run();
                        status.textContent = resultMessage;
                        button.className = "";
                        // 一个动作成功后卡片状态已改变，其余一键动作基于的是过期内容，全部停用。
                        runButtons.forEach(function (other) {
                            other.disabled = true;
                        });
                        if (entry.afterSuccess) await entry.afterSuccess(resultMessage);
                    } catch (error) {
                        status.textContent = "未完成：" + (error.message || String(error));
                        button.disabled = false;
                    }
                };
            }

            runButtons.push(button);
            buttonRow.appendChild(button);
        });

        if (card.buttons?.length) row.appendChild(buttonRow);
        content.appendChild(row);
    }

    function batchPlan(channel) {
        const userTargets = getLayer1Targets();
        if (channel === USER_CHANNEL && !userTargets.length) return [];
        const projects = readRegistry().projects;
        const selected = channel === USER_CHANNEL
            ? userTargets
            : projects.filter(project => project.type === channel.id);
        if (!selected.length) return [];

        // 其他页只参与路径冲突检查，避免本页分发改写另一页的来源或目标。
        const otherTargets = channel === USER_CHANNEL
            ? projects
            : userTargets.concat(projects.filter(project => project.type !== channel.id));
        const seen = new Set(otherTargets.map(target => canonicalPath(target.path)));
        const sources = new Set([USER_CHANNEL, ...Object.values(TYPE_CHANNELS)]
            .map(item => item.sourceVaultPath)
            .filter(Boolean)
            .map(file => canonicalPath(path.join(VAULT_ROOT, file))));
        for (const target of selected) {
            const key = canonicalPath(target.path);
            if (sources.has(key)) throw new Error("指令源同时被登记为分发目标：" + target.path);
            if (seen.has(key)) throw new Error("多个目标指向同一文件：" + target.path);
            seen.add(key);
        }
        const source = channel.extractSource(syncReadVault(app, channel.sourceVaultPath));
        const { targets } = buildChannelPlan(channel, selected, source, null, readChannelState(channel));
        const invalid = targets.find(target => target.action === "invalid");
        if (invalid) throw new Error(invalid.name + "：" + invalid.reason);
        return targets.filter(target => target.action !== "unchanged");
    }

    function batchLabel(channel) {
        return channel === USER_CHANNEL ? "分发用户级指令" : "分发 " + TYPE_LABELS[channel.id] + " 项目";
    }

    async function distributePage(channel) {
        const targets = batchPlan(channel);
        const title = batchLabel(channel);
        if (!targets.length) { await showMessage(title, "当前页没有待分发的目标。"); return false; }
        const conflicts = targets.filter(target => ["conflict", "initial-review"].includes(target.action));
        const targetKind = channel === USER_CHANNEL ? " 个用户级目标" : " 个 " + TYPE_LABELS[channel.id] + " 项目";
        const summary = "本次处理 " + targets.length + targetKind + "。" +
            (conflicts.length ? "\n其中 " + conflicts.length + " 个目标有本地改动或首次比对存在差异，确认后使用源版本。\n" +
                conflicts.map(target => target.name).join("、") : "");
        if (!await showConfirm(title, summary, "确认分发")) return false;
        const fresh = batchPlan(channel);
        const signature = list => JSON.stringify(list.map(t => [t.name, t.sourceVaultPath, t.path, t.currentHash, t.action, t.source.fullBody]));
        if (signature(fresh) !== signature(targets)) throw new Error("待分发内容已变化，请重新确认。");
        const changes = changeSet();
        for (const target of fresh) planDistribution(changes, target);
        await changes.apply(title + "（" + fresh.length + " 个目标）");
        return true;
    }

    var closed = false;
    var activeKey = null;
    var area = null;
    var renderToken = 0;

    host.empty?.();
    var content = el("div", "flex:1;overflow:auto;padding:16px 18px;min-height:0;");
    var footer = el("div",
        "display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 18px;" +
        "border-top:1px solid var(--background-modifier-border);flex-shrink:0;");
    host.appendChild(content);
    host.appendChild(footer);

    content.appendChild(el("div",
        "margin-bottom:14px;line-height:1.6;color:var(--text-muted);",
        "用户级指令同步整篇正文。Work 和 Code 项目只同步第一个一级标题及其内容，到第二个一级标题前为止。"));

    var TAB_BASE_STYLE =
        "flex:1;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;box-shadow:none;" +
        "background:transparent;border:1px solid transparent;color:var(--text-muted);";
    var TAB_ACTIVE_STYLE =
        "flex:1;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;box-shadow:none;" +
        "background:var(--background-secondary);border:1px solid var(--background-modifier-border);" +
        "color:var(--text-normal);font-weight:600;";

    function renderInitError(error) {
        var nextArea = el("div");
        appendCard(nextArea, {
            title: "指令分发失败",
            pathText: "",
            reason: error && error.message ? error.message : String(error)
        });
        if (area) area.remove();
        area = nextArea;
        content.appendChild(area);
    }

    async function refreshPanel() {
        var token = ++renderToken;
        if (!STATE_ROOT) {
            configureStatePaths(app);
        }
        var next = await loadPlans();
        if (closed || token !== renderToken) return;
        render(next.layer1, next.layer2);
        refreshHistory();
    }

    async function safeRefresh() {
        try {
            await refreshPanel();
        } catch (error) {
            if (!STATE_ROOT && !closed) {
                renderInitError(error);
                refreshHistory();
                return;
            }
            if (!closed) await showMessage("刷新失败", error && error.message ? error.message : String(error));
        }
    }

    function render(layer1, layer2) {
        var prevScroll = content.scrollTop || 0;
        var nextArea = el("div");

        // ===== 标签栏：第一级与第二级的 Work／Code 各占一个标签页 =====
        // 待处理数 = 需要用户动手的目标数（unchanged 以外的动作）；整级不可用时记 1。
        var paneDefs = [];
        var layer1Pending = 0;
        if (layer1.error) {
            layer1Pending = 1;
        } else {
            layer1.plan.targets.forEach(function (target) {
                if (target.action !== "unchanged") layer1Pending += 1;
            });
        }
        paneDefs.push({ key: "layer1", label: "第一级：用户级指令", pending: layer1Pending });

        Object.entries(TYPE_LABELS).forEach(function ([type, name]) {
            var targets = layer2.plan?.targets.filter(target => target.type === type) || [];
            paneDefs.push({
                key: "type-" + type,
                label: "第二级：" + name + " 类型",
                pending: layer2.error ? 1 : targets.filter(target => target.action !== "unchanged").length,
                type: type,
                targets: targets
            });
        });

        var tabBar = el("div", "display:flex;gap:8px;margin-bottom:12px;");
        var tabs = {};
        var panes = {};

        var refreshTabLabels = function () {
            paneDefs.forEach(function (def) {
                tabs[def.key].textContent = def.label +
                    (def.pending > 0 ? "（" + def.pending + " 待处理）" : "");
            });
        };
        var activateTab = function (key) {
            activeKey = key;
            const selected = paneDefs.find(def => def.key === key);
            const channel = selected.type ? TYPE_CHANNELS[selected.type] : USER_CHANNEL;
            bulk.textContent = batchLabel(channel);
            bulk.hidden = false;
            bulk.onclick = async () => {
                try {
                    if (await exclusive(() => distributePage(channel))) await safeRefresh();
                } catch (error) { showMessage("分发失败", error.message); }
            };
            paneDefs.forEach(function (def) {
                tabs[def.key].style.cssText = def.key === key ? TAB_ACTIVE_STYLE : TAB_BASE_STYLE;
                panes[def.key].style.display = def.key === key ? "" : "none";
            });
        };
        var settlePending = function (key, wasPending) {
            if (!wasPending) return;
            paneDefs.forEach(function (def) {
                if (def.key === key) def.pending = Math.max(0, def.pending - 1);
            });
            refreshTabLabels();
        };

        // 一键动作的统一收尾：成功执行后刷新待处理计数。
        var wrapRun = function (key, target, apply) {
            return async function () {
                var wasPending = target.action !== "unchanged";
                var result = await exclusive(apply);
                target.action = "unchanged";
                settlePending(key, wasPending);
                return result;
            };
        };

        // 移除登记的收尾：卡片已随动作消失，这里只清待处理计数。
        var wrapUnregister = function (key, target) {
            var wasPending = target.action !== "unchanged";
            target.action = "unchanged";
            settlePending(key, wasPending);
        };

        nextArea.appendChild(tabBar);
        paneDefs.forEach(function (def) {
            tabs[def.key] = document.createElement("button");
            panes[def.key] = document.createElement("div");
            tabs[def.key].onclick = function () { activateTab(def.key); };
            tabBar.appendChild(tabs[def.key]);
            nextArea.appendChild(panes[def.key]);
        });
        refreshTabLabels();

        // ===== 第一级区块 =====
        var currentTargets = plugin.settings.targets || {};
        var availableHarnesses = Object.keys(harnessTargets).filter(function (name) {
            return !Object.prototype.hasOwnProperty.call(currentTargets, name);
        });
        var addTargetButton = el("button", "flex-shrink:0;", "添加目标");
        addTargetButton.type = "button";
        addTargetButton.disabled = availableHarnesses.length === 0;
        addTargetButton.onclick = function () {
            var menu = new Menu();
            availableHarnesses.forEach(function (name) {
                menu.addItem(function (item) {
                    item.setTitle(name).onClick(function () {
                        return addLayer1Target(name);
                    });
                });
            });
            var bounds = typeof addTargetButton.getBoundingClientRect === "function"
                ? addTargetButton.getBoundingClientRect()
                : { left: 0, bottom: 0 };
            menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, addTargetButton.ownerDocument);
        };
        appendSourceRow(panes.layer1, "userSource", addTargetButton);
        if (layer1.error) {
            appendCard(panes.layer1, {
                title: "第一级不可用",
                reason: layer1.error
            });
            getLayer1Targets().forEach(function (target) {
                appendCard(panes.layer1, {
                    title: target.name,
                    pathText: target.path,
                    reason: "源笔记不可用，暂时无法同步；仍可通过右上角「×」移出分发列表。",
                    removeEntry: buildLayer1RemoveEntry(target, safeRefresh)
                });
            });
        } else if (!layer1.plan.targets.length) {
            appendCard(panes.layer1, {
                title: "尚未添加用户指令目标",
                pathText: "",
                reason: "尚未添加用户指令目标，可点击上方「添加目标」选择要分发的工具。"
            });
        } else {
            appendChannelTargets(panes.layer1, layer1.plan.targets, "layer1", app, wrapRun, null, safeRefresh);
        }

        // ===== 第二级区块：按类型分标签页 =====
        paneDefs.slice(1).forEach(function (def) {
            var pane = panes[def.key];
            appendSourceRow(pane, def.type + "Source");
            if (layer2.error) {
                appendCard(pane, {
                    title: "第二级不可用",
                    reason: layer2.error
                });
                return;
            }
            appendRegisterRow(pane, def.type, TYPE_LABELS[def.type], app, function (target) {
                def.targets.push(target);
                layer2.plan.targets.push(target);
                if (target.action !== "unchanged") {
                    def.pending += 1;
                    refreshTabLabels();
                }
                appendChannelTargets(pane, [target], def.key, app, wrapRun, wrapUnregister, safeRefresh);
            });
            appendChannelTargets(pane, def.targets, def.key, app, wrapRun, wrapUnregister, safeRefresh);
        });

        // 刷新时尽量停留在原先的标签页；首次打开时停在第一个有待处理的标签页，都没有待处理则显示第一个。
        var defaultKey = paneDefs.some(function (def) { return def.key === activeKey; }) ? activeKey : null;
        if (!defaultKey) {
            defaultKey = paneDefs[0].key;
            for (var i = 0; i < paneDefs.length; i++) {
                if (paneDefs[i].pending > 0) { defaultKey = paneDefs[i].key; break; }
            }
        }
        activateTab(defaultKey);

        if (area) area.remove();
        area = nextArea;
        content.appendChild(area);
        content.scrollTop = prevScroll;
    }

    const refreshButton = el("button", null, "刷新");
    const undo = el("button", null, "撤销上次操作");
    const bulk = el("button");
    const last = el("span", "margin-right:auto;align-self:center;");
    refreshHistory = () => {
        const operation = history ? history.latest() : null;
        last.textContent = operation ? "上次操作：" + operation.label : "";
        undo.disabled = !operation;
    };
    refreshButton.onclick = async () => {
        if (plugin.syncBusy) return;
        refreshButton.disabled = true;
        try {
            await safeRefresh();
        } finally {
            if (!closed) refreshButton.disabled = false;
        }
    };
    undo.onclick = async () => {
        if (!history) return;
        try {
            const restored = await exclusive(() => history.undo(files => showConfirm(
                "撤销上次操作", "以下文件在操作后又有修改。继续撤销会覆盖这些修改：\n" + files.join("\n"), "继续撤销"
            )));
            if (restored) await safeRefresh();
        } catch (error) { showMessage("撤销失败", error.message); }
    };
    bulk.hidden = true;
    footer.appendChild(last);
    footer.appendChild(refreshButton);
    footer.appendChild(undo);
    footer.appendChild(bulk);

    // 轻量确认弹窗：确认 resolve(true)，取消或关闭 resolve(false)。
    // 确认按钮先落定结果再关闭，onClose 的 resolve(false) 不会覆盖已落定的值。
    function showConfirm(title, message, confirmLabel) {
        return new Promise(function (resolve) {
            var modal = createModal({
                title: title, width: 520, widthVw: 90, maxHeight: 70,
                onClose: function () { resolve(false); }
            });
            modal.body.style.cssText =
                "padding:16px 18px;overflow:auto;white-space:pre-wrap;line-height:1.6;font-size:13px;";
            modal.body.textContent = message;

            var cancelButton = el("button", null, "取消");
            cancelButton.onclick = function () { modal.close(); };
            var okButton = el("button", null, confirmLabel || "确认");
            okButton.className = "mod-cta";
            okButton.onclick = function () {
                resolve(true);
                modal.close();
            };
            modal.footer.appendChild(cancelButton);
            modal.footer.appendChild(okButton);
        });
    }

    function showMessage(title, message) {
        return new Promise(function (resolve) {
            var modal = createModal({
                title: title, width: 760, widthVw: 95, maxHeight: 85,
                onClose: resolve
            });
            modal.body.style.cssText =
                "padding:18px;overflow:auto;white-space:pre-wrap;line-height:1.6;font-size:13px;";
            modal.body.textContent = message;

            var button = el("button", null, "关闭");
            button.className = "mod-cta";
            button.onclick = function () { modal.close(); };
            modal.footer.appendChild(button);
        });
    }

    var ready = (async function () {
        try {
            configureStatePaths(app);
        } catch (error) {
            console.error("[sync-instructions]", error);
            if (!closed) {
                renderInitError(error);
                refreshHistory();
            }
            return;
        }
        await safeRefresh();
    })();

    return {
        ready: ready,
        refresh: safeRefresh,
        destroy: function () { closed = true; },
        isBusy: function () { return Boolean(plugin.syncBusy); }
    };
}

module.exports = { mountInstructions };
