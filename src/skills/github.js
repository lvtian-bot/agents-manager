const { readText } = require("../instructions/storage");
const { readSkillSources, sourcesFilePath } = require("./model");
const { snapshotDirectoryFiles } = require("./links");

const EXCLUDED_SEGMENTS = new Set([".git", ".github", ".gitignore", "node_modules"]);

function parseGitHubUrl(rawUrl) {
    const cleaned = String(rawUrl || "").trim().replace(/\/+$/, "");
    const match = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?$/i);
    if (!match) {
        throw new Error("无效的 GitHub 仓库地址：" + rawUrl);
    }
    const ref = match[3] || null;
    const isCommitSha = Boolean(ref && /^[0-9a-f]{7,40}$/i.test(ref));
    return {
        owner: match[1],
        repo: match[2],
        branch: ref && !isCommitSha ? ref : null,
        subpath: (match[4] || "").replace(/^\/+|\/+$/g, ""),
        pinnedRef: ref,
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

function isIncludedRelPath(relPath) {
    if (!relPath) return false;
    const segments = relPath.split("/");
    if (segments.some(seg => !seg || seg === "." || seg === ".." || EXCLUDED_SEGMENTS.has(seg))) {
        return false;
    }
    if (relPath === "agents/openai.yaml") return false;
    return true;
}

async function checkGitHubUpdate(source, settings) {
    const parsed = parseGitHubUrl(source.url);
    const { headers } = buildHeaders(settings);
    const params = new URLSearchParams({ per_page: "1" });
    if (parsed.branch) params.set("sha", parsed.branch);
    if (parsed.subpath) params.set("path", parsed.subpath);
    const url = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits?${params.toString()}`;
    const commits = await fetchJson(url, headers);
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
            if (subRel.split("/").some(seg => EXCLUDED_SEGMENTS.has(seg))) continue;
            entries.push(...await listEntriesViaContents(parsed, targetSha, item.path, headers));
        } else if (item.type === "file") {
            const rel = prefix ? (item.path.startsWith(prefix) ? item.path.slice(prefix.length) : "") : item.path;
            if (isIncludedRelPath(rel)) {
                entries.push({ rel, repoPath: item.path, sha: item.sha });
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
        if (item.type !== "blob") continue;
        if (prefix && !item.path.startsWith(prefix)) continue;
        const rel = prefix ? item.path.slice(prefix.length) : item.path;
        if (!isIncludedRelPath(rel)) continue;
        entries.push({ rel, repoPath: item.path, sha: item.sha });
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
        files.push({ rel: entry.rel, base64: buf.toString("base64") });
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
