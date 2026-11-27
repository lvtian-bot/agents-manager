const { parseSkillFrontmatter, skillCreationTarget, skillSourceChange } = require("./model");
const { createSkill, snapshotDirectoryFiles } = require("./links");

const EXCLUDED_SEGMENTS = new Set([".git", ".github", ".gitignore", "node_modules"]);
const RAW_HEADERS = { "User-Agent": "agents-manager-obsidian-plugin" };
const API_HEADERS = { ...RAW_HEADERS, Accept: "application/vnd.github+json" };

function decodeSegment(segment) {
    try {
        return decodeURIComponent(segment);
    } catch {
        throw new Error("无效的 GitHub URL 编码片段：" + segment);
    }
}

function parseGitHubUrl(rawUrl) {
    const cleaned = String(rawUrl || "").trim().replace(/\/+$/, "");
    const match = cleaned.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/(.+))?$/i);
    if (!match) {
        throw new Error("无效的 GitHub 仓库地址（须使用 https://github.com/...）：" + rawUrl);
    }
    const owner = decodeSegment(match[1]);
    const repo = decodeSegment(match[2]);
    const rawTree = (match[3] || "").replace(/^\/+|\/+$/g, "");
    if (!rawTree) {
        return { owner, repo, branch: null, subpath: "", pinnedRef: null, treeSegments: [] };
    }
    const treeSegments = rawTree.split("/").filter(Boolean).map(decodeSegment);
    const first = treeSegments[0];
    const isCommitSha = Boolean(first && /^[0-9a-f]{7,40}$/i.test(first));
    return {
        owner,
        repo,
        branch: isCommitSha ? null : first,
        subpath: treeSegments.slice(1).join("/"),
        pinnedRef: first,
        treeSegments: isCommitSha ? [] : treeSegments,
    };
}

async function checkResponseError(response, url) {
    if (response.ok) return;
    let bodyText = "";
    try {
        bodyText = await response.text();
    } catch {
        // Ignore unread body errors.
    }
    const remaining = response.headers?.get?.("x-ratelimit-remaining");
    if (response.status === 429 || (response.status === 403 && (remaining === "0" || /rate limit/i.test(bodyText)))) {
        throw new Error("GitHub 请求过于频繁，请稍后再试。");
    }
    throw new Error("GitHub 请求失败（HTTP " + response.status + "）：" + url);
}

async function fetchJson(url, cache = "default") {
    const response = await fetch(url, { headers: API_HEADERS, cache });
    await checkResponseError(response, url);
    return response.json();
}

async function fetchBuffer(url) {
    const response = await fetch(url, { headers: RAW_HEADERS });
    await checkResponseError(response, url);
    return Buffer.from(await response.arrayBuffer());
}

function encodeUriPath(repoPath) {
    return repoPath.split("/").map(encodeURIComponent).join("/");
}

function classifyRelPath(relPath) {
    if (typeof relPath !== "string" || !relPath || /[\\:\0-\x1f]/.test(relPath)) {
        throw new Error("上游包含不安全的文件路径：" + relPath);
    }
    const segments = relPath.split("/");
    if (segments.some(seg => !seg || seg === "." || seg === "..")) {
        throw new Error("上游包含不安全的文件路径：" + relPath);
    }
    if (segments.some(seg => EXCLUDED_SEGMENTS.has(seg.toLowerCase()))) return false;
    if (relPath.toLowerCase() === "agents/openai.yaml") return false;
    return true;
}

async function fetchCommits(parsed) {
    const params = new URLSearchParams({ per_page: "1" });
    if (parsed.branch) params.set("sha", parsed.branch);
    if (parsed.subpath) params.set("path", parsed.subpath);
    const url = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits?${params.toString()}`;
    return fetchJson(url, "no-cache");
}

async function resolveSlashRef(parsed) {
    if (!parsed.treeSegments || parsed.treeSegments.length <= 1) return null;
    const fullRest = parsed.treeSegments.join("/");
    const firstPrefix = parsed.treeSegments[0];
    for (const kind of ["heads", "tags"]) {
        const refUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/matching-refs/${kind}/${encodeURIComponent(firstPrefix)}`;
        let refs;
        try {
            refs = await fetchJson(refUrl);
        } catch {
            continue;
        }
        if (!Array.isArray(refs)) continue;
        const prefix = `refs/${kind}/`;
        let best = null;
        for (const item of refs) {
            const name = typeof item?.ref === "string" && item.ref.startsWith(prefix) ? item.ref.slice(prefix.length) : "";
            if (!name || name === parsed.branch) continue;
            if (fullRest === name || fullRest.startsWith(name + "/")) {
                if (!best || name.length > best.length) best = name;
            }
        }
        if (best) {
            return {
                ...parsed,
                branch: best,
                subpath: fullRest.length > best.length ? fullRest.slice(best.length + 1) : "",
            };
        }
    }
    return null;
}

async function fetchLatestRevision(url) {
    let parsed = parseGitHubUrl(url);
    let commits = null;
    let firstError = null;
    try {
        commits = await fetchCommits(parsed);
    } catch (error) {
        firstError = error;
    }
    if ((!Array.isArray(commits) || !commits.length) && parsed.treeSegments.length > 1) {
        const resolved = await resolveSlashRef(parsed);
        if (resolved) {
            parsed = resolved;
            commits = await fetchCommits(parsed);
            firstError = null;
        }
    }
    if (firstError) throw firstError;
    if (!Array.isArray(commits) || !commits.length) {
        throw new Error("未在 GitHub 上游找到提交记录。");
    }
    const latest = commits[0];
    const latestCommit = latest?.sha || "";
    if (!latestCommit) {
        throw new Error("GitHub 返回的提交记录缺少 SHA。");
    }

    return {
        latestCommit,
        commitMessage: String(latest?.commit?.message || "").split("\n")[0],
        parsed,
    };
}

const CHECK_MAX_AGE = 24 * 60 * 60 * 1000;

function revisionStatus(commit, latestCommit) {
    if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/i.test(commit)) return "unknown-baseline";
    return latestCommit.toLowerCase().startsWith(commit.toLowerCase()) ? "up-to-date" : "update-available";
}

function createUpdateChecks(app) {
    const results = new Map();
    const pending = new Map();
    const storageKey = url => "agents-manager:github-check:" + url;

    function status(source) {
        if (!results.has(source.url)) results.set(source.url, app.loadLocalStorage(storageKey(source.url)));
        const entry = results.get(source.url);
        if (entry?.error) return entry;
        if (typeof entry?.latestCommit !== "string" || !entry.latestCommit) return null;
        const age = Date.now() - entry?.checkedAt;
        if (!Number.isFinite(age) || age < 0 || age >= CHECK_MAX_AGE) return null;
        return { ...entry, status: revisionStatus(source.commit, entry.latestCommit) };
    }

    function fetchLatest(url) {
        if (pending.has(url)) return pending.get(url);
        const request = fetchLatestRevision(url).then(result => {
            if (pending.get(url) === request) {
                const entry = { latestCommit: result.latestCommit, commitMessage: result.commitMessage, checkedAt: Date.now() };
                results.set(url, entry);
                app.saveLocalStorage(storageKey(url), entry);
            }
            return result;
        }, error => {
            if (pending.get(url) === request) {
                results.set(url, { error: error.message || String(error) });
                app.saveLocalStorage(storageKey(url), null);
            }
            throw error;
        }).finally(() => pending.delete(url));
        pending.set(url, request);
        return request;
    }

    return { status, fetchLatest, dispose: () => pending.clear() };
}

async function listEntriesViaContents(parsed, targetSha, dirPath) {
    const encoded = dirPath ? "/" + encodeUriPath(dirPath) : "";
    const url = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/contents${encoded}?ref=${encodeURIComponent(targetSha)}`;
    const items = await fetchJson(url);
    const list = Array.isArray(items) ? items : [items];
    const entries = [];
    const prefix = parsed.subpath ? parsed.subpath + "/" : "";

    for (const item of list) {
        if (item.type === "dir") {
            const subRel = prefix && item.path.startsWith(prefix) ? item.path.slice(prefix.length) : item.path;
            if (/[\\:\0-\x1f]/.test(subRel) || subRel.split("/").some(seg => !seg || seg === "." || seg === "..")) {
                throw new Error("上游包含不安全的文件路径：" + subRel);
            }
            if (subRel.split("/").some(seg => EXCLUDED_SEGMENTS.has(seg.toLowerCase()))) continue;
            entries.push(...await listEntriesViaContents(parsed, targetSha, item.path));
        } else if (item.type === "symlink") {
            const rel = prefix ? (item.path.startsWith(prefix) ? item.path.slice(prefix.length) : "") : item.path;
            if (classifyRelPath(rel)) {
                throw new Error("上游技能包含不支持的软链接条目（" + rel + "），已取消更新。");
            }
        } else if (item.type === "file") {
            const rel = prefix ? (item.path.startsWith(prefix) ? item.path.slice(prefix.length) : "") : item.path;
            if (classifyRelPath(rel)) {
                entries.push({ rel, repoPath: item.path, mode: item.mode || "100644" });
            }
        }
    }
    return entries;
}

async function listTreeEntries(parsed, targetSha) {
    const treeUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/trees/${encodeURIComponent(targetSha)}?recursive=1`;
    const treeData = await fetchJson(treeUrl);

    if (treeData.truncated) {
        const entries = await listEntriesViaContents(parsed, targetSha, parsed.subpath);
        if (!entries.some(entry => entry.rel === "SKILL.md")) {
            throw new Error("上游目录中未找到 SKILL.md，已取消更新。");
        }
        return entries;
    }

    const prefix = parsed.subpath ? parsed.subpath + "/" : "";
    const entries = [];
    for (const item of treeData.tree || []) {
        if (item.type !== "blob" && item.type !== "commit") continue;
        if (prefix && !item.path.startsWith(prefix)) continue;
        const rel = prefix ? item.path.slice(prefix.length) : item.path;
        if (!classifyRelPath(rel)) continue;
        if (item.mode === "120000") {
            throw new Error("上游技能包含不支持的软链接条目（" + rel + "），已取消更新。");
        }
        if (item.type === "commit" || item.mode === "160000") {
            throw new Error("上游技能包含不支持的子模块条目（" + rel + "），已取消更新。");
        }
        entries.push({ rel, repoPath: item.path, mode: item.mode || "100644" });
    }

    if (!entries.some(entry => entry.rel === "SKILL.md")) {
        throw new Error("上游目录中未找到 SKILL.md，已取消更新。");
    }
    return entries;
}

async function downloadEntries(parsed, targetSha, entries) {
    const files = [];
    for (const entry of entries) {
        const url = `https://raw.githubusercontent.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/${encodeURIComponent(targetSha)}/${encodeUriPath(entry.repoPath)}`;
        const buf = await fetchBuffer(url);
        files.push({ rel: entry.rel, base64: buf.toString("base64"), mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    return files;
}

async function downloadGitHubSkill(url, check) {
    const entries = await listTreeEntries(check.parsed, check.latestCommit);
    const files = await downloadEntries(check.parsed, check.latestCommit, entries);
    return { files, parsed: check.parsed, source: {
        kind: "github",
        url,
        commit: check.latestCommit,
        updatedAt: new Date().toISOString(),
    } };
}

async function updateGitHubSkill(history, stateRoot, skill, checks) {
    const check = await checks.fetchLatest(skill.source.url);
    if (revisionStatus(skill.source.commit, check.latestCommit) === "up-to-date") return null;
    const { files, source } = await downloadGitHubSkill(skill.source.url, check);
    await history.apply({
        type: "github-update",
        label: "更新 " + skill.name + "（" + source.commit.slice(0, 7) + "）",
        skillDir: skill.dir,
        beforeFiles: snapshotDirectoryFiles(skill.dir),
        afterFiles: files,
        ...skillSourceChange(stateRoot, skill.sourceKey, source),
    });

    return { latestCommit: source.commit, fileCount: files.length };
}

async function importGitHubSkill(history, stateRoot, scope, url, checks) {
    const check = await checks.fetchLatest(url);
    const { files, parsed, source } = await downloadGitHubSkill(url, check);
    const md = files.find(file => file.rel === "SKILL.md");
    const frontmatter = parseSkillFrontmatter(Buffer.from(md.base64, "base64").toString("utf8"));
    const fallback = parsed.subpath.split("/").at(-1) || parsed.repo;
    const skill = skillCreationTarget(scope, frontmatter.name || fallback);
    return createSkill(history, skill, files, skillSourceChange(stateRoot, skill.sourceKey, source));
}

module.exports = {
    parseGitHubUrl,
    createUpdateChecks,
    updateGitHubSkill,
    importGitHubSkill,
};
