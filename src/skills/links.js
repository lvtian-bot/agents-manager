const fs = require("fs");
const path = require("path");
const { readText, replaceText } = require("../instructions/storage");
const { canonicalPath } = require("./model");

function linkTypeForPlatform() {
    return process.platform === "win32" ? "junction" : "dir";
}

function normalizeReadlinkTarget(linkPath, rawTarget) {
    let cleaned = String(rawTarget || "");
    if (cleaned.startsWith("\\\\?\\UNC\\")) {
        cleaned = "\\\\" + cleaned.slice(8);
    } else if (cleaned.startsWith("\\\\?\\")) {
        cleaned = cleaned.slice(4);
    }
    return path.resolve(path.dirname(linkPath), cleaned);
}

function inspectPath(targetPath) {
    const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
    if (!stat) return { kind: "missing" };
    if (stat.isSymbolicLink()) {
        let rawTarget = "";
        let resolvedTarget = "";
        let targetExists = false;
        let targetIsDir = false;
        try {
            rawTarget = fs.readlinkSync(targetPath);
            resolvedTarget = normalizeReadlinkTarget(targetPath, rawTarget);
        } catch {
            // Leave target empty if unreadable.
        }
        try {
            const targetStat = fs.statSync(targetPath);
            targetExists = true;
            targetIsDir = targetStat.isDirectory();
        } catch {
            // Broken symlink or dangling junction.
        }
        return { kind: "symlink", rawTarget, resolvedTarget, targetExists, targetIsDir };
    }
    if (stat.isDirectory()) return { kind: "directory" };
    return { kind: "file" };
}

function safeUnlinkSymlink(linkPath) {
    const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isSymbolicLink()) {
        throw new Error("目标不是软链接，已停止删除：" + linkPath);
    }
    fs.unlinkSync(linkPath);
    return true;
}

function sameRealDir(dirA, dirB) {
    try {
        return canonicalPath(fs.realpathSync(dirA)) === canonicalPath(fs.realpathSync(dirB));
    } catch {
        return false;
    }
}

function inspectScopeHarnesses(scope) {
    const skillMap = new Map(scope.skills.map(skill => [skill.name, skill]));
    const sourceRootKey = canonicalPath(scope.sourceRoot);

    return scope.harnessTargets.map(harness => {
        const dirInfo = inspectPath(harness.targetDir);
        const result = {
            name: harness.name,
            rawPath: harness.rawPath,
            targetDir: harness.targetDir,
            status: "ready",
            reason: "",
            wholeTarget: "",
            skills: {},
            brokenLinks: [],
        };

        if (dirInfo.kind === "symlink") {
            if (dirInfo.resolvedTarget && canonicalPath(dirInfo.resolvedTarget) === sourceRootKey) {
                result.status = "whole-dir-linked";
                result.wholeTarget = dirInfo.resolvedTarget;
                result.reason = "当前整个技能目录已链接到源目录，不能在其中直接写入单个技能链接。";
                return result;
            }
            result.status = "dir-conflict";
            result.reason = "目标目录是指向其他位置的软链接：" + (dirInfo.resolvedTarget || dirInfo.rawTarget);
            return result;
        }
        if (dirInfo.kind === "file") {
            result.status = "dir-conflict";
            result.reason = "目标路径是普通文件，无法作为技能目录。";
            return result;
        }
        if (dirInfo.kind === "directory" && fs.existsSync(scope.sourceRoot) && sameRealDir(harness.targetDir, scope.sourceRoot)) {
            result.status = "dir-conflict";
            result.reason = "目标目录解析后与源技能目录相同，已禁止写入。";
            return result;
        }

        for (const skill of scope.skills) {
            const linkPath = path.join(harness.targetDir, skill.name);
            const entry = inspectPath(linkPath);
            if (entry.kind === "missing") {
                result.skills[skill.name] = { status: "unlinked", linkPath };
            } else if (entry.kind === "symlink") {
                if (!entry.targetExists || !entry.targetIsDir) {
                    result.skills[skill.name] = { status: "broken", linkPath, reason: "软链接失效（目标不存在或非目录）" };
                } else if (canonicalPath(entry.resolvedTarget) === canonicalPath(skill.dir)) {
                    result.skills[skill.name] = { status: "linked", linkPath };
                } else {
                    result.skills[skill.name] = { status: "conflict", linkPath, reason: "已是指向其他路径的软链接：" + entry.resolvedTarget };
                }
            } else if (entry.kind === "directory") {
                result.skills[skill.name] = { status: "conflict", linkPath, reason: "已存在同名实体目录，不覆盖" };
            } else {
                result.skills[skill.name] = { status: "conflict", linkPath, reason: "已存在同名文件，不覆盖" };
            }
        }

        if (dirInfo.kind === "directory") {
            for (const entry of fs.readdirSync(harness.targetDir, { withFileTypes: true })) {
                if (entry.name.startsWith(".") || skillMap.has(entry.name)) continue;
                if (!entry.isSymbolicLink()) continue;
                const childPath = path.join(harness.targetDir, entry.name);
                const childInfo = inspectPath(childPath);
                const pointsIntoSource = childInfo.resolvedTarget &&
                    canonicalPath(path.dirname(childInfo.resolvedTarget)) === sourceRootKey;
                if (!childInfo.targetExists || !childInfo.targetIsDir || pointsIntoSource) {
                    result.brokenLinks.push({
                        name: entry.name,
                        linkPath: childPath,
                        target: childInfo.resolvedTarget || childInfo.rawTarget,
                    });
                }
            }
        }

        return result;
    });
}

function collectMissingAncestors(dirPath) {
    const missing = [];
    let current = path.resolve(dirPath);
    while (current && !fs.existsSync(current)) {
        missing.unshift(current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return missing;
}

function removeEmptyDirs(dirs) {
    for (const dir of dirs.slice().reverse()) {
        try {
            if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
                fs.rmdirSync(dir);
            }
        } catch {
            // Keep non-empty or protected directories intact.
        }
    }
}

function snapshotDirectoryFiles(rootDir) {
    const files = [];
    if (!fs.existsSync(rootDir)) return files;
    function walk(current, relBase) {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            const rel = relBase ? relBase + "/" + entry.name : entry.name;
            if (entry.isDirectory()) {
                walk(full, rel);
            } else if (entry.isFile()) {
                files.push({ rel, base64: fs.readFileSync(full).toString("base64") });
            }
        }
    }
    walk(rootDir, "");
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    return files;
}

function writeSnapshotFiles(rootDir, files, expectedOldFiles) {
    const nextRels = new Set(files.map(item => item.rel));
    fs.mkdirSync(rootDir, { recursive: true });
    for (const item of files) {
        const dest = path.join(rootDir, ...item.rel.split("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const buf = Buffer.from(item.base64, "base64");
        fs.writeFileSync(dest, buf);
    }
    for (const old of expectedOldFiles) {
        if (!nextRels.has(old.rel)) {
            const target = path.join(rootDir, ...old.rel.split("/"));
            if (fs.existsSync(target)) fs.unlinkSync(target);
        }
    }
    cleanEmptySubdirs(rootDir);
}

function cleanEmptySubdirs(rootDir) {
    if (!fs.existsSync(rootDir)) return;
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(rootDir, entry.name);
        cleanEmptySubdirs(sub);
        if (fs.readdirSync(sub).length === 0) fs.rmdirSync(sub);
    }
}

function createSkillsHistory(stateRoot) {
    const lastPath = path.join(stateRoot, "skills-last-operation.json");
    const pendingPath = path.join(stateRoot, "skills-pending-operation.json");
    const readOp = file => {
        const raw = readText(file);
        return raw ? JSON.parse(raw) : null;
    };
    const latest = () => readOp(pendingPath) || readOp(lastPath);

    async function runForward(op) {
        if (op.type === "edit-skill") {
            if (readText(op.path) !== op.before) {
                throw new Error("文件已发生变化，请刷新后重试：" + op.path);
            }
            replaceText(op.path, op.after);
            return;
        }
        if (op.type === "link-batch") {
            const linkType = linkTypeForPlatform();
            const createdDirs = new Set();
            for (const item of op.actions) {
                if (item.kind === "create") {
                    for (const dir of collectMissingAncestors(path.dirname(item.linkPath))) {
                        createdDirs.add(dir);
                    }
                    if (inspectPath(item.linkPath).kind !== "missing") {
                        throw new Error("目标路径已存在内容，已停止：" + item.linkPath);
                    }
                    fs.mkdirSync(path.dirname(item.linkPath), { recursive: true });
                    fs.symlinkSync(item.targetPath, item.linkPath, linkType);
                } else if (item.kind === "remove") {
                    safeUnlinkSymlink(item.linkPath);
                }
            }
            op.createdDirs = Array.from(createdDirs);
            return;
        }
        if (op.type === "convert-whole-dir") {
            const linkType = linkTypeForPlatform();
            const dirInfo = inspectPath(op.targetDir);
            if (dirInfo.kind !== "symlink" || canonicalPath(dirInfo.resolvedTarget) !== canonicalPath(op.wholeTarget)) {
                throw new Error("目标目录不再是指向源目录的整目录链接：" + op.targetDir);
            }
            safeUnlinkSymlink(op.targetDir);
            fs.mkdirSync(op.targetDir, { recursive: true });
            for (const skill of op.skills) {
                fs.symlinkSync(skill.targetPath, skill.linkPath, linkType);
            }
            return;
        }
        if (op.type === "github-update") {
            writeSnapshotFiles(op.skillDir, op.afterFiles, op.beforeFiles);
            replaceText(op.sourcesPath, op.afterSourcesText);
        }
    }

    async function runRestore(op, forceConfirm) {
        if (op.type === "edit-skill") {
            const current = readText(op.path);
            if (current === op.before) return;
            if (current !== op.after && !forceConfirm) {
                throw new Error("文件在操作后发生变化：" + op.path);
            }
            replaceText(op.path, op.before);
            return;
        }
        if (op.type === "link-batch") {
            const linkType = linkTypeForPlatform();
            for (const item of op.actions.slice().reverse()) {
                const info = inspectPath(item.linkPath);
                if (item.kind === "create") {
                    if (info.kind === "missing") continue;
                    if (info.kind !== "symlink") {
                        throw new Error("目标路径已变为非软链接，无法撤销：" + item.linkPath);
                    }
                    safeUnlinkSymlink(item.linkPath);
                } else if (item.kind === "remove") {
                    if (info.kind === "symlink") continue;
                    if (info.kind !== "missing") {
                        throw new Error("目标路径已存在其他内容，无法恢复软链接：" + item.linkPath);
                    }
                    fs.mkdirSync(path.dirname(item.linkPath), { recursive: true });
                    fs.symlinkSync(item.targetPath, item.linkPath, linkType);
                }
            }
            removeEmptyDirs(op.createdDirs || []);
            return;
        }
        if (op.type === "convert-whole-dir") {
            const linkType = linkTypeForPlatform();
            const dirInfo = inspectPath(op.targetDir);
            if (dirInfo.kind === "symlink" && canonicalPath(dirInfo.resolvedTarget) === canonicalPath(op.wholeTarget)) {
                return;
            }
            if (dirInfo.kind === "missing") {
                fs.mkdirSync(path.dirname(op.targetDir), { recursive: true });
                fs.symlinkSync(op.wholeTarget, op.targetDir, linkType);
                return;
            }
            if (dirInfo.kind !== "directory") {
                throw new Error("目标路径不是目录，无法恢复整目录链接：" + op.targetDir);
            }
            const entries = fs.readdirSync(op.targetDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isSymbolicLink()) {
                    throw new Error("目标目录内存在非软链接的文件或目录（" + entry.name + "），已停止撤销以免误删。");
                }
            }
            for (const entry of entries) {
                safeUnlinkSymlink(path.join(op.targetDir, entry.name));
            }
            fs.rmdirSync(op.targetDir);
            fs.symlinkSync(op.wholeTarget, op.targetDir, linkType);
            return;
        }
        if (op.type === "github-update") {
            const currentDisk = snapshotDirectoryFiles(op.skillDir);
            writeSnapshotFiles(op.skillDir, op.beforeFiles, currentDisk);
            if (op.beforeSourcesText !== null || fs.existsSync(op.sourcesPath)) {
                replaceText(op.sourcesPath, op.beforeSourcesText);
            }
        }
    }

    function detectExternalEdits(op) {
        if (op.type === "edit-skill") {
            const current = readText(op.path);
            if (current !== op.after && current !== op.before) return [op.path];
        } else if (op.type === "github-update") {
            const currentDisk = JSON.stringify(snapshotDirectoryFiles(op.skillDir));
            const expectedAfter = JSON.stringify(op.afterFiles);
            const expectedBefore = JSON.stringify(op.beforeFiles);
            const currentSources = readText(op.sourcesPath);
            const dirChanged = currentDisk !== expectedAfter && currentDisk !== expectedBefore;
            const sourcesChanged = currentSources !== op.afterSourcesText && currentSources !== op.beforeSourcesText;
            const changed = [];
            if (dirChanged) changed.push(op.skillDir);
            if (sourcesChanged) changed.push(op.sourcesPath);
            return changed;
        }
        return [];
    }

    async function apply(op) {
        if (fs.existsSync(pendingPath)) throw new Error("上次技能操作尚未完成，请先撤销上次操作。");
        replaceText(pendingPath, JSON.stringify(op));
        try {
            await runForward(op);
            replaceText(pendingPath, JSON.stringify(op));
            fs.renameSync(pendingPath, lastPath);
        } catch (error) {
            try {
                await runRestore(op, true);
                if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
            } catch (recoveryError) {
                throw new Error(error.message + "\n可通过「撤销上次操作」继续恢复。\n" + recoveryError.message);
            }
            throw error;
        }
    }

    function validateBeforeUndo(op) {
        if (op.type === "link-batch") {
            for (const item of op.actions) {
                const info = inspectPath(item.linkPath);
                if (item.kind === "create" && info.kind !== "missing" && info.kind !== "symlink") {
                    throw new Error("目标路径已变为非软链接，无法撤销：" + item.linkPath);
                }
                if (item.kind === "remove" && info.kind !== "symlink" && info.kind !== "missing") {
                    throw new Error("目标路径已存在其他内容，无法恢复软链接：" + item.linkPath);
                }
            }
            return;
        }
        if (op.type === "convert-whole-dir") {
            const dirInfo = inspectPath(op.targetDir);
            if (dirInfo.kind === "missing") return;
            if (dirInfo.kind === "symlink" && canonicalPath(dirInfo.resolvedTarget) === canonicalPath(op.wholeTarget)) {
                return;
            }
            if (dirInfo.kind !== "directory") {
                throw new Error("目标路径不是目录，无法恢复整目录链接：" + op.targetDir);
            }
            for (const entry of fs.readdirSync(op.targetDir, { withFileTypes: true })) {
                if (!entry.isSymbolicLink()) {
                    throw new Error("目标目录内存在非软链接的文件或目录（" + entry.name + "），已停止撤销以免误删。");
                }
            }
        }
    }

    async function undo(confirmChanges) {
        const interrupted = fs.existsSync(pendingPath);
        const file = interrupted ? pendingPath : lastPath;
        const op = readOp(file);
        if (!op) return false;

        validateBeforeUndo(op);
        let forceConfirm = interrupted;
        if (!interrupted) {
            const changed = detectExternalEdits(op);
            if (changed.length) {
                if (!await confirmChanges(changed)) return false;
                forceConfirm = true;
            }
            fs.renameSync(lastPath, pendingPath);
        }

        await runRestore(op, forceConfirm);
        if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
        return true;
    }

    return { latest, apply, undo };
}

async function saveSelfSkillEdit(history, skill, beforeText, afterText) {
    if (beforeText === afterText) return false;
    await history.apply({
        type: "edit-skill",
        label: "编辑 " + skill.name,
        path: skill.skillMdPath,
        before: beforeText,
        after: afterText,
    });
    return true;
}

async function distributeSingleSkill(history, scope, skill, harness) {
    const linkPath = path.join(harness.targetDir, skill.name);
    await history.apply({
        type: "link-batch",
        label: "分发 " + skill.name + " → " + harness.name,
        actions: [{ kind: "create", linkPath, targetPath: skill.dir }],
        createdDirs: [],
    });
}

async function unlinkSingleSkill(history, skill, harness) {
    const linkPath = path.join(harness.targetDir, skill.name);
    const info = inspectPath(linkPath);
    if (info.kind !== "symlink") {
        throw new Error("目标不是软链接，无法取消：" + linkPath);
    }
    await history.apply({
        type: "link-batch",
        label: "取消链接 " + skill.name + "（" + harness.name + "）",
        actions: [{ kind: "remove", linkPath, targetPath: info.resolvedTarget || skill.dir }],
        createdDirs: [],
    });
}

async function cleanBrokenLink(history, brokenItem, harnessName) {
    const info = inspectPath(brokenItem.linkPath);
    if (info.kind !== "symlink") {
        throw new Error("目标不是软链接，无法清理：" + brokenItem.linkPath);
    }
    await history.apply({
        type: "link-batch",
        label: "清理失效链接 " + brokenItem.name + "（" + harnessName + "）",
        actions: [{ kind: "remove", linkPath: brokenItem.linkPath, targetPath: info.resolvedTarget || info.rawTarget }],
        createdDirs: [],
    });
}

async function convertWholeDirToPerSkill(history, scope, harnessState) {
    const skills = scope.skills.map(skill => ({
        name: skill.name,
        linkPath: path.join(harnessState.targetDir, skill.name),
        targetPath: skill.dir,
    }));
    await history.apply({
        type: "convert-whole-dir",
        label: harnessState.name + " 转为逐个链接（" + skills.length + " 个技能）",
        targetDir: harnessState.targetDir,
        wholeTarget: scope.sourceRoot,
        skills,
    });
}

async function distributeAllSkills(history, scopes) {
    const actions = [];
    let skippedWholeDir = 0;
    let skippedConflicts = 0;

    for (const scope of scopes) {
        const harnessStates = inspectScopeHarnesses(scope);
        for (const hState of harnessStates) {
            if (hState.status === "whole-dir-linked") {
                skippedWholeDir += 1;
                continue;
            }
            if (hState.status !== "ready") {
                skippedConflicts += 1;
                continue;
            }
            for (const skill of scope.skills) {
                const sState = hState.skills[skill.name];
                if (sState.status === "unlinked") {
                    actions.push({ kind: "create", linkPath: sState.linkPath, targetPath: skill.dir });
                } else if (sState.status === "conflict" || sState.status === "broken") {
                    skippedConflicts += 1;
                }
            }
        }
    }

    if (actions.length) {
        await history.apply({
            type: "link-batch",
            label: "一键分发技能（" + actions.length + " 个链接）",
            actions,
            createdDirs: [],
        });
    }

    return { createdCount: actions.length, skippedWholeDir, skippedConflicts };
}

module.exports = {
    linkTypeForPlatform,
    normalizeReadlinkTarget,
    inspectPath,
    safeUnlinkSymlink,
    inspectScopeHarnesses,
    snapshotDirectoryFiles,
    createSkillsHistory,
    saveSelfSkillEdit,
    distributeSingleSkill,
    unlinkSingleSkill,
    cleanBrokenLink,
    convertWholeDirToPerSkill,
    distributeAllSkills,
};
