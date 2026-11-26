const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeNewlines } = require("../instructions/documents");
const { syncDirectory, readText, replaceText } = require("../instructions/storage");

const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function canonicalPath(filePath) {
    const resolved = path.resolve(String(filePath || ""));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function expandHome(filePath) {
    const raw = String(filePath || "").trim();
    if (!raw) return "";
    if (raw === "~") return os.homedir();
    if (raw.startsWith("~/") || raw.startsWith("~\\")) {
        return path.join(os.homedir(), raw.slice(2));
    }
    return path.resolve(raw);
}

function resolveStateRoot(plugin) {
    const app = plugin.app;
    const adapter = app?.vault?.adapter;
    const vaultRoot = typeof adapter?.getBasePath === "function"
        ? adapter.getBasePath()
        : (typeof adapter?.basePath === "string" ? adapter.basePath : null);
    if (!vaultRoot) {
        throw new Error("无法定位当前 Obsidian 仓库根目录，已停止读取或写入技能状态。");
    }
    const configDir = path.join(vaultRoot, app.vault.configDir || ".obsidian");
    const pluginDir = plugin.manifest?.dir
        ? path.resolve(vaultRoot, plugin.manifest.dir)
        : path.join(configDir, "plugins", "agents-manager");
    return syncDirectory(configDir, pluginDir);
}

function readProjectRegistry(stateRoot) {
    const registryPath = path.join(stateRoot, "instruction-projects.json");
    const raw = readText(registryPath);
    if (raw === null) return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error("项目登记表无法解析：" + error.message);
    }
    if (!parsed || !Array.isArray(parsed.projects)) {
        throw new Error("项目登记表结构不正确（缺少 projects 数组）。");
    }
    return parsed.projects.filter(project =>
        project &&
        typeof project.path === "string" && project.path &&
        (project.type === "work" || project.type === "code")
    );
}

function sourcesFilePath(stateRoot) {
    return path.join(stateRoot, "skills-sources.json");
}

function readSkillSources(stateRoot) {
    const file = sourcesFilePath(stateRoot);
    const raw = readText(file);
    if (raw === null) return { version: 1, skills: {} };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error("技能来源记录无法解析：" + error.message);
    }
    if (!parsed || typeof parsed.skills !== "object" || Array.isArray(parsed.skills)) {
        throw new Error("技能来源记录结构不正确（缺少 skills 对象）。");
    }
    return { version: 1, skills: parsed.skills };
}

function writeSkillSources(stateRoot, data) {
    const payload = { version: 1, skills: data.skills || {} };
    replaceText(sourcesFilePath(stateRoot), JSON.stringify(payload, null, 2) + "\n");
}

function parseSourceInput(urlInput, commitInput) {
    let url = String(urlInput || "").trim();
    let commit = String(commitInput || "").trim();
    const atIndex = url.search(/\s+@\s+/);
    if (atIndex >= 0) {
        const extracted = url.slice(atIndex).replace(/^\s+@\s+/, "").trim();
        url = url.slice(0, atIndex).trim();
        if (!commit) commit = extracted;
    }
    return { url, commit };
}

function unquoteYamlScalar(raw) {
    const value = raw.trim();
    if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
        return value.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\n/g, "\n");
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    return value;
}

function parseBlockScalar(lines, startIndex, indicator) {
    const folded = indicator.startsWith(">");
    const collected = [];
    let indent = null;
    let index = startIndex;
    while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
            collected.push("");
            index += 1;
            continue;
        }
        const leading = line.match(/^[ \t]*/)[0].length;
        if (leading === 0) break;
        if (indent === null) indent = leading;
        if (leading < indent) break;
        collected.push(line.slice(indent));
        index += 1;
    }
    while (collected.length && !collected[collected.length - 1]) collected.pop();
    const text = folded
        ? collected.map(item => (item === "" ? "\n" : item)).join(" ").replace(/ *\n */g, "\n")
        : collected.join("\n");
    return { value: text.trim(), nextIndex: index };
}

function parseSkillFrontmatter(text) {
    const normalized = normalizeNewlines(text);
    if (!normalized.startsWith("---\n") && normalized !== "---") {
        return { hasFrontmatter: false, unclosed: false, name: "", description: "" };
    }
    const match = normalized.match(/^---\n(?:([\s\S]*?)\n)?---(?:\n|$)/);
    if (!match) {
        return { hasFrontmatter: true, unclosed: true, name: "", description: "" };
    }
    const block = match[1] || "";
    const lines = block.split("\n");
    const fields = { name: "", description: "" };
    let index = 0;
    while (index < lines.length) {
        const keyMatch = lines[index].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
        if (!keyMatch) {
            index += 1;
            continue;
        }
        const key = keyMatch[1];
        const rest = keyMatch[2].trim();
        if (key !== "name" && key !== "description") {
            index += 1;
            continue;
        }
        if (/^[|>][+-]?\d*$/.test(rest)) {
            const parsed = parseBlockScalar(lines, index + 1, rest);
            fields[key] = parsed.value;
            index = parsed.nextIndex;
            continue;
        }
        if (rest) {
            fields[key] = unquoteYamlScalar(rest);
            index += 1;
            continue;
        }
        const plainLines = [];
        let lookahead = index + 1;
        while (lookahead < lines.length && /^[ \t]+\S/.test(lines[lookahead])) {
            plainLines.push(lines[lookahead].trim());
            lookahead += 1;
        }
        fields[key] = plainLines.join(" ");
        index = lookahead;
    }
    return { hasFrontmatter: true, unclosed: false, name: fields.name, description: fields.description };
}

function validateSkill(skillDir, dirName, parsed) {
    const issues = [];
    if (parsed.unclosed) {
        issues.push("frontmatter 未闭合");
    } else if (!parsed.hasFrontmatter) {
        issues.push("缺少 YAML frontmatter");
    }
    if (!parsed.name) {
        issues.push("缺少 frontmatter name");
    } else if (parsed.name !== dirName) {
        issues.push("name 与目录名不一致（" + parsed.name + "）");
    }
    if (!KEBAB_CASE_RE.test(dirName)) {
        issues.push("目录名不符合小写 kebab-case");
    }
    if (!parsed.description) {
        issues.push("缺少 description");
    }
    if (fs.existsSync(path.join(skillDir, "agents", "openai.yaml"))) {
        issues.push("包含 agents/openai.yaml");
    }
    return issues;
}

function skillSourceKey(scopeKind, projectRoot, skillName) {
    if (scopeKind === "user") return "user/" + skillName;
    return canonicalPath(projectRoot) + "/" + skillName;
}

function scanSkillsInDir(sourceRoot, scopeKind, projectRoot, sourcesMap) {
    if (!fs.existsSync(sourceRoot)) return [];
    let rootStat;
    try {
        rootStat = fs.statSync(sourceRoot);
    } catch {
        return [];
    }
    if (!rootStat.isDirectory()) return [];

    const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
    const skills = [];
    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const skillDir = path.join(sourceRoot, entry.name);
        let dirStat;
        try {
            dirStat = fs.statSync(skillDir);
        } catch {
            continue;
        }
        if (!dirStat.isDirectory()) continue;
        const skillMdPath = path.join(skillDir, "SKILL.md");
        let mdStat;
        try {
            mdStat = fs.statSync(skillMdPath);
        } catch {
            continue;
        }
        if (!mdStat.isFile()) continue;

        const rawText = fs.readFileSync(skillMdPath, "utf8");
        const parsed = parseSkillFrontmatter(rawText);
        const issues = validateSkill(skillDir, entry.name, parsed);
        const key = skillSourceKey(scopeKind, projectRoot, entry.name);
        const recorded = sourcesMap[key];
        const source = recorded && recorded.kind === "github" && recorded.url
            ? { kind: "github", url: recorded.url, commit: recorded.commit || "", updatedAt: recorded.updatedAt || "" }
            : { kind: "self" };

        skills.push({
            name: entry.name,
            dir: skillDir,
            skillMdPath,
            description: parsed.description,
            frontmatterName: parsed.name,
            issues,
            sourceKey: key,
            source,
        });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return skills;
}

function buildHarnessTargets(entries, baseDir) {
    return Object.entries(entries || {}).map(([name, target]) => ({
        name,
        rawPath: target,
        targetDir: baseDir ? path.resolve(baseDir, target) : expandHome(target),
    }));
}

function scanAllSkillScopes(plugin, stateRoot) {
    const sourcesDoc = readSkillSources(stateRoot);
    const projects = readProjectRegistry(stateRoot);
    const scopes = [];

    const userSourceRoot = path.join(os.homedir(), ".agents", "skills");
    scopes.push({
        key: "user",
        kind: "user",
        name: "用户级技能",
        projectRoot: null,
        sourceRoot: userSourceRoot,
        skills: scanSkillsInDir(userSourceRoot, "user", null, sourcesDoc.skills),
        harnessTargets: buildHarnessTargets(plugin.settings.skillUserTargets, null),
    });

    const seenRoots = new Set();
    for (const project of projects) {
        const projectRoot = path.dirname(project.path);
        const rootKey = canonicalPath(projectRoot);
        if (seenRoots.has(rootKey)) continue;
        seenRoots.add(rootKey);

        const sourceRoot = path.join(projectRoot, ".agents", "skills");
        const skills = scanSkillsInDir(sourceRoot, "project", projectRoot, sourcesDoc.skills);
        if (!skills.length) continue;

        scopes.push({
            key: "project:" + rootKey,
            kind: "project",
            type: project.type,
            name: project.name || path.basename(projectRoot),
            projectRoot,
            sourceRoot,
            skills,
            harnessTargets: buildHarnessTargets(plugin.settings.skillProjectTargets, projectRoot),
        });
    }

    return scopes;
}

module.exports = {
    canonicalPath,
    expandHome,
    resolveStateRoot,
    readProjectRegistry,
    sourcesFilePath,
    readSkillSources,
    writeSkillSources,
    parseSourceInput,
    parseSkillFrontmatter,
    validateSkill,
    skillSourceKey,
    scanAllSkillScopes,
};
