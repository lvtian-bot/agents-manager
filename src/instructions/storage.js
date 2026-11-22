const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const stateFiles = {
    "instruction-projects.json": "projects",
    "user-instructions-sync.json": "targets",
    "type-instructions-sync.json": "projects",
};

function syncDirectory(configDir, pluginDir) {
    const root = path.join(pluginDir, "sync");
    if (fs.existsSync(root)) return root;
    fs.mkdirSync(pluginDir, { recursive: true });
    const staging = fs.mkdtempSync(path.join(pluginDir, ".sync-"));
    try {
        const legacy = ["nascence-sync", "agents-manager-sync"]
            .map(name => path.join(configDir, name)).find(dir => fs.existsSync(dir));
        for (const [name, key] of Object.entries(stateFiles)) {
            if (!legacy || !fs.existsSync(path.join(legacy, name))) continue;
            const original = fs.readFileSync(path.join(legacy, name));
            const copy = path.join(staging, name);
            fs.writeFileSync(copy, original);
            if (!original.equals(fs.readFileSync(copy)) || !Array.isArray(JSON.parse(original)[key])) {
                throw new Error("同步数据迁移校验失败：" + name);
            }
        }
        if (legacy && path.basename(legacy) === "nascence-sync") {
            fs.writeFileSync(path.join(staging, "legacy-settings"), "");
        }
        fs.renameSync(staging, root);
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
    return root;
}

function readText(file) {
    try { return fs.readFileSync(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function replaceText(file, value) {
    if (value === null) { fs.unlinkSync(file); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + "." + randomUUID() + ".tmp";
    try {
        // Preserve existing permissions and follow a symlink to its backing file.
        const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
        if (target !== path.resolve(file) && fs.lstatSync(file).isSymbolicLink()) {
            replaceText(target, value);
            return;
        }
        const mode = fs.existsSync(file) ? fs.statSync(file).mode : 0o600;
        fs.writeFileSync(temp, value, { mode, flag: "wx" });
        fs.renameSync(temp, file);
    } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
}

function createHistory(root, read, write, validateUndo) {
    const last = path.join(root, "last-operation.json");
    const pending = path.join(root, "pending-operation.json");
    const record = file => JSON.parse(readText(file));
    const latest = () => record(pending) || record(last);

    async function restore(entries, force) {
        for (const entry of entries.slice().reverse()) {
            const current = read(entry);
            if (current === entry.before) continue;
            if (current !== entry.after && force?.get(entry) !== current) {
                throw new Error("文件在操作后发生变化：" + entry.path);
            }
            await write(entry, entry.before);
        }
    }

    async function apply(label, entries) {
        if (fs.existsSync(pending)) throw new Error("上次操作尚未完成，请先撤销上次操作。");
        const changes = entries.filter(entry => entry.before !== entry.after);
        if (!changes.length) return;
        const operation = { label, entries: changes };
        replaceText(pending, JSON.stringify(operation));
        const attempted = [];
        try {
            for (const entry of changes) {
                if (read(entry) !== entry.before) throw new Error("文件已变化，请重新打开面板：" + entry.path);
                attempted.push(entry);
                await write(entry, entry.after);
            }
            fs.renameSync(pending, last);
        } catch (error) {
            try {
                await restore(attempted);
                fs.unlinkSync(pending);
            } catch (recoveryError) {
                throw new Error(error.message + "\n可通过「撤销上次操作」继续恢复。\n" + recoveryError.message);
            }
            throw error;
        }
    }

    async function undo(confirmChanges) {
        const interrupted = fs.existsSync(pending);
        const file = interrupted ? pending : last;
        const operation = record(file);
        if (!operation) return false;
        validateUndo(operation.entries);
        const changed = new Map();
        for (const entry of operation.entries) {
            const current = read(entry);
            if (current !== entry.after && current !== entry.before) changed.set(entry, current);
        }
        if (changed.size && !await confirmChanges([...changed.keys()].map(entry => entry.path))) return false;
        if (!interrupted) fs.renameSync(last, pending);
        await restore(operation.entries, changed);
        fs.unlinkSync(pending);
        return true;
    }

    return { latest, apply, undo };
}

module.exports = { syncDirectory, readText, replaceText, createHistory };
