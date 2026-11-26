const { readText } = require("../instructions/storage");
const { readSkillSources, sourcesFilePath } = require("./model");
const { snapshotDirectoryFiles } = require("./links");

const EXCLUDED_SEGMENTS = new Set([".git", ".github", ".gitignore", "node_modules"]);

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

function githubAuth(settings) {
    const varName = settings?.githubCredentialVariable;
    const token = varName ? process.env[varName] : "";
    return { token: token || "", hasAuth: Boolean(token) };
}

function buildHeaders(settings, accept) {
    const auth = githubAuth(settings);
    const headers = {
        Accept: accept || "application/vnd.github+json",
        "User-Agent": "agents-manager-obsidian-plugin",
    };
    if (auth.hasAuth) {
        headers.Authorization = "Bearer " + auth.token;
    }
    return { headers, hasAuth: auth.hasAuth };
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
    if (response.status === 403 && (remaining === "0" || /rate limit/i.test(bodyText))) {
        throw new Error("GitHub API 请求达到速率限制；可在插件设置中配置 GitHub 凭据环境变量后重试。");
    }
    throw new Error("GitHub 请求失败（HTTP " + response.status + "）：" + url);
}

async function fetchJson(url, headers) {
    const response = await fetch(url, { headers });
    await checkResponseError(response, url);
    return response.json();
}

async function fetchBuffer(url, headers) {
    const response = await fetch(url, { headers });
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

async function fetchCommits(parsed, headers) {
    const params = new URLSearchParams({ per_page: "1" });
    if (parsed.branch) params.set("sha", parsed.branch);
    if (parsed.subpath) params.set("path", parsed.subpath);
    const url = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits?${params.toString()}`;
    return fetchJson(url, headers);
}

async function resolveSlashRef(parsed, headers) {
    if (!parsed.treeSegments || parsed.treeSegments.length <= 1) return null;
    const fullRest = parsed.treeSegments.join("/");
    const firstPrefix = parsed.treeSegments[0];
    for (const kind of ["heads", "tags"]) {
        const refUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/matching-refs/${kind}/${encodeURIComponent(firstPrefix)}`;
        let refs;
        try {
            refs = await fetchJson(refUrl, headers);
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

async function checkGitHubUpdate(source, settings) {
    let parsed = parseGitHubUrl(source.url);
    const { headers } = buildHeaders(settings);
    let commits = null;
    let firstError = null;
    try {
        commits = await fetchCommits(parsed, headers);
    } catch (error) {
        firstError = error;
    }
    if ((!Array.isArray(commits) || !commits.length) && parsed.treeSegments.length > 1) {
        const resolved = await resolveSlashRef(parsed, headers);
        if (resolved) {
            parsed = resolved;
            commits = await fetchCommits(parsed, headers);
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

    let status = "unknown-baseline";
    if (source.commit) {
        status = latestCommit.toLowerCase() === source.commit.toLowerCase() ? "up-to-date" : "update-available";
    }

    return {
        latestCommit,
        commitDate: latest?.commit?.committer?.date || latest?.commit?.author?.date || "",
        commitMessage: String(latest?.commit?.message || "").split("\n")[0],
        status,
        parsed,
    };
}

async function listEntriesViaContents(parsed, targetSha, dirPath, headers) {
    const encoded = dirPath ? "/" + encodeUriPath(dirPath) : "";
    const url = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/contents${encoded}?ref=${encodeURIComponent(targetSha)}`;
    const items = await fetchJson(url, headers);
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
            entries.push(...await listEntriesViaContents(parsed, targetSha, item.path, headers));
        } else if (item.type === "symlink") {
            const rel = prefix ? (item.path.startsWith(prefix) ? item.path.slice(prefix.length) : "") : item.path;
            if (classifyRelPath(rel)) {
                throw new Error("上游技能包含不支持的软链接条目（" + rel + "），已取消更新。");
            }
        } else if (item.type === "file") {
            const rel = prefix ? (item.path.startsWith(prefix) ? item.path.slice(prefix.length) : "") : item.path;
            if (classifyRelPath(rel)) {
                entries.push({ rel, repoPath: item.path, sha: item.sha, mode: item.mode || "100644" });
            }
        }
    }
    return entries;
}

async function listTreeEntries(parsed, targetSha, settings) {
    const { headers } = buildHeaders(settings);
    const treeUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/trees/${encodeURIComponent(targetSha)}?recursive=1`;
    const treeData = await fetchJson(treeUrl, headers);

    if (treeData.truncated) {
        const entries = await listEntriesViaContents(parsed, targetSha, parsed.subpath, headers);
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
        entries.push({ rel, repoPath: item.path, sha: item.sha, mode: item.mode || "100644" });
    }

    if (!entries.some(entry => entry.rel === "SKILL.md")) {
        throw new Error("上游目录中未找到 SKILL.md，已取消更新。");
    }
    return entries;
}

async function downloadEntries(parsed, targetSha, entries, settings) {
    const { headers, hasAuth } = buildHeaders(settings, "application/vnd.github.raw+json");
    const files = [];
    for (const entry of entries) {
        const url = hasAuth
            ? `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/blobs/${encodeURIComponent(entry.sha)}`
            : `https://raw.githubusercontent.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/${encodeURIComponent(targetSha)}/${encodeUriPath(entry.repoPath)}`;
        const buf = await fetchBuffer(url, hasAuth ? headers : { "User-Agent": "agents-manager-obsidian-plugin" });
        files.push({ rel: entry.rel, base64: buf.toString("base64"), mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    return files;
}

async function updateGitHubSkill(history, stateRoot, skill, settings) {
    const check = await checkGitHubUpdate(skill.source, settings);
    const entries = await listTreeEntries(check.parsed, check.latestCommit, settings);
    const afterFiles = await downloadEntries(check.parsed, check.latestCommit, entries, settings);
    const beforeFiles = snapshotDirectoryFiles(skill.dir);

    const sourcesPath = sourcesFilePath(stateRoot);
    const beforeSourcesText = readText(sourcesPath);
    const sourcesDoc = readSkillSources(stateRoot);
    sourcesDoc.skills[skill.sourceKey] = {
        kind: "github",
        url: skill.source.url,
        commit: check.latestCommit,
        updatedAt: new Date().toISOString(),
    };
    const afterSourcesText = JSON.stringify({ version: 1, skills: sourcesDoc.skills }, null, 2) + "\n";

    await history.apply({
        type: "github-update",
        label: "更新 " + skill.name + "（" + check.latestCommit.slice(0, 7) + "）",
        skillDir: skill.dir,
        beforeFiles,
        afterFiles,
        sourcesPath,
        beforeSourcesText,
        afterSourcesText,
    });

    return { latestCommit: check.latestCommit, fileCount: afterFiles.length };
}

module.exports = {
    parseGitHubUrl,
    checkGitHubUpdate,
    updateGitHubSkill,
};
