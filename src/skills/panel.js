const fs = require("fs");
const { Menu, Notice, ToggleComponent } = require("obsidian");
const { readText, replaceText } = require("../instructions/storage");
const { skillUserPath, skillProjectPath, required } = require("../settings");
const {
    resolveStateRoot,
    skillCreationTarget,
    skillSourceChange,
    parseSourceInput,
    parseSkillFrontmatter,
    validateSkill,
    scanAllSkillScopes,
} = require("./model");
const {
    inspectScopeHarnesses,
    createSkillsHistory,
    createSkill,
    saveSelfSkillEdit,
    distributeSingleSkill,
    unlinkSingleSkill,
    cleanBrokenLink,
    convertWholeDirToPerSkill,
    distributeAllSkills,
} = require("./links");
const { parseGitHubUrl, createUpdateChecks, updateGitHubSkill, importGitHubSkill } = require("./github");

const TAB_BASE_STYLE =
    "flex:1 1 auto;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:var(--am-font-control);box-shadow:none;" +
    "background:transparent;border:1px solid transparent;color:var(--text-muted);";
const TAB_ACTIVE_STYLE =
    "flex:1 1 auto;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:var(--am-font-control);box-shadow:none;" +
    "background:var(--background-secondary);border:1px solid var(--background-modifier-border);" +
    "color:var(--text-normal);font-weight:600;";
const SKILL_CELL_STYLE =
    "padding:5px 8px;border:0;border-bottom:1px solid var(--background-modifier-border);" +
    "vertical-align:middle;font-size:var(--am-font-control);";
const SKILL_ACTION_STYLE =
    "font-size:var(--am-font-control);padding:3px 7px;min-height:28px;height:auto;white-space:nowrap;";

function el(tag, cssText, textContent) {
    const node = document.createElement(tag);
    if (cssText) node.style.cssText = cssText;
    if (textContent !== undefined && textContent !== null) node.textContent = textContent;
    return node;
}

function mountSkills(plugin, host) {
    let closed = false;
    let activeScopeKey = null;
    let area = null;
    let renderToken = 0;
    let stateRoot = null;
    let history = null;
    let scopes = [];
    const checks = plugin.skillUpdateChecks ??= createUpdateChecks(plugin.app);
    const updateRows = [];
    let manualCheckRunning = false;

    host.empty?.();
    const content = el("div", "flex:1;overflow:auto;padding:16px 18px;min-height:0;");
    const footer = el("div",
        "display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 18px;" +
        "border-top:1px solid var(--background-modifier-border);flex-shrink:0;");
    host.appendChild(content);
    host.appendChild(footer);

    content.appendChild(el("div",
        "margin-bottom:14px;line-height:1.5;color:var(--text-muted);font-size:var(--am-font-secondary);",
        "技能来自用户主目录、当前 Obsidian 库和已登记项目下的 .agents/skills。每个技能放在单独的子目录中，目录内须有 SKILL.md。"));

    function createModal(options) {
        const dialog = plugin.openDialog(options.title, options.onClose);
        dialog.modalEl.style.width = "min(" + options.width + "px, " + options.widthVw + "vw)";
        dialog.modalEl.style.maxHeight = options.maxHeight + "vh";
        const modalFooter = el("div", null);
        modalFooter.className = "modal-button-container";
        dialog.modalEl.appendChild(modalFooter);
        return { header: dialog.titleEl, body: dialog.contentEl, footer: modalFooter, close: () => dialog.close() };
    }

    function showConfirm(title, message, confirmLabel) {
        return new Promise(resolve => {
            const modal = createModal({
                title, width: 540, widthVw: 90, maxHeight: 75,
                onClose: () => resolve(false),
            });
            modal.body.style.cssText =
                "padding:16px 18px;overflow:auto;white-space:pre-wrap;line-height:1.6;font-size:13px;";
            modal.body.textContent = message;
            const cancelBtn = el("button", null, "取消");
            cancelBtn.onclick = () => modal.close();
            const okBtn = el("button", null, confirmLabel || "确认");
            okBtn.className = "mod-cta";
            okBtn.onclick = () => {
                resolve(true);
                modal.close();
            };
            modal.footer.appendChild(cancelBtn);
            modal.footer.appendChild(okBtn);
        });
    }

    function showMessage(title, message) {
        return new Promise(resolve => {
            const modal = createModal({
                title, width: 680, widthVw: 92, maxHeight: 80,
                onClose: resolve,
            });
            modal.body.style.cssText =
                "padding:18px;overflow:auto;white-space:pre-wrap;line-height:1.6;font-size:13px;";
            modal.body.textContent = message;
            const closeBtn = el("button", null, "关闭");
            closeBtn.className = "mod-cta";
            closeBtn.onclick = () => modal.close();
            modal.footer.appendChild(closeBtn);
        });
    }

    let refreshHistory = () => {};
    async function exclusive(action) {
        if (plugin.skillsBusy) throw new Error("正在处理其他技能操作。");
        plugin.skillsBusy = true;
        try {
            return await action();
        } finally {
            plugin.skillsBusy = false;
            refreshHistory();
        }
    }

    function ensureState() {
        if (!stateRoot) {
            stateRoot = resolveStateRoot(plugin);
            history = createSkillsHistory(stateRoot);
        }
    }

    function loadScopes() {
        ensureState();
        const loaded = scanAllSkillScopes(plugin, stateRoot);
        for (const scope of loaded) {
            scope.harnessStates = inspectScopeHarnesses(scope);
        }
        return loaded;
    }

    function scopeField(parent, initialScope) {
        const label = el("label", "display:grid;gap:4px;");
        label.appendChild(el("span", "font-weight:600;", "范围"));
        const select = el("select");
        select.setAttribute("aria-label", "范围");
        for (const scope of scanAllSkillScopes(plugin, stateRoot, { includeEmpty: true })) {
            const option = el("option", null, scope.name);
            option.value = scope.key;
            option.title = scope.sourceRoot;
            select.appendChild(option);
        }
        select.value = initialScope.key;
        label.appendChild(select);
        parent.appendChild(label);
        return () => {
            const scope = scanAllSkillScopes(plugin, stateRoot, { includeEmpty: true }).find(item => item.key === select.value);
            if (!scope) throw new Error("找不到所选范围，请刷新后重试。");
            return scope;
        };
    }

    function skillTypeSelect(label, value) {
        const select = el("select", "font-size:var(--am-font-control);");
        select.setAttribute("aria-label", label);
        for (const [kind, name] of [["self", "自建"], ["github", "GitHub"]]) {
            const option = el("option", null, name);
            option.value = kind;
            select.appendChild(option);
        }
        select.value = value;
        return select;
    }

    function openCreateMenu(button, scope) {
        const menu = new Menu();
        menu.addItem(item => item.setTitle("自建").onClick(() => openEditSkillModal(null, scope)));
        menu.addItem(item => item.setTitle("GitHub").onClick(() => openGitHubLinkModal(null, scope)));
        const bounds = button.getBoundingClientRect();
        menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, button.ownerDocument);
    }

    function openViewSkillModal(skill) {
        const text = readText(skill.skillMdPath) ?? "";
        const modal = createModal({ title: "查看技能：" + skill.name, width: 820, widthVw: 94, maxHeight: 88 });
        modal.body.style.cssText = "padding:16px 18px;overflow:auto;display:flex;flex-direction:column;gap:10px;";
        modal.body.appendChild(el("div",
            "font-family:var(--font-monospace);font-size:12px;color:var(--text-muted);word-break:break-all;",
            skill.skillMdPath));
        if (skill.source.kind === "github") {
            modal.body.appendChild(el("div",
                "font-size:12px;color:var(--text-muted);",
                "上游：" + skill.source.url + (skill.source.commit ? " @ " + skill.source.commit : "")));
        }
        const pre = el("pre",
            "margin:0;padding:12px;border:1px solid var(--background-modifier-border);border-radius:6px;" +
            "background:var(--background-secondary);font-family:var(--font-monospace);font-size:var(--font-ui-medium,15px);" +
            "line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow:auto;flex:1;",
            text);
        modal.body.appendChild(pre);
        const closeBtn = el("button", null, "关闭");
        closeBtn.className = "mod-cta";
        closeBtn.onclick = () => modal.close();
        modal.footer.appendChild(closeBtn);
    }

    function openEditSkillModal(skill, creationScope) {
        const beforeText = skill ? readText(skill.skillMdPath) : "---\nname: \ndescription: \n---\n\n";
        if (beforeText === null) {
            showMessage("无法编辑", "找不到 SKILL.md：" + skill.skillMdPath);
            return;
        }
        const modal = createModal({ title: skill ? "编辑技能：" + skill.name : "新建技能", width: 840, widthVw: 94, maxHeight: 88 });
        modal.body.style.cssText = "padding:16px 18px;overflow:auto;display:flex;flex-direction:column;gap:10px;";
        let destination;
        let nameInput;
        if (skill) {
            modal.body.appendChild(el("div",
                "font-family:var(--font-monospace);font-size:12px;color:var(--text-muted);word-break:break-all;",
                skill.skillMdPath));
        } else {
            destination = scopeField(modal.body, creationScope);
            const label = el("label", "display:grid;gap:4px;");
            label.appendChild(el("span", "font-weight:600;", "技能名称"));
            nameInput = el("input");
            nameInput.type = "text";
            nameInput.value = "";
            nameInput.setAttribute("aria-label", "技能名称");
            label.appendChild(nameInput);
            modal.body.appendChild(label);
        }
        const issueLine = el("div", "font-size:12px;line-height:1.5;");
        const editor = document.createElement("textarea");
        editor.value = beforeText;
        editor.style.cssText =
            "width:100%;min-height:360px;flex:1;padding:10px;border:1px solid var(--background-modifier-border);" +
            "border-radius:6px;font-family:var(--font-monospace);font-size:var(--font-ui-medium,15px);line-height:1.6;resize:vertical;";

        const updateLint = () => {
            const parsed = parseSkillFrontmatter(editor.value);
            const issues = validateSkill(skill?.dir, skill?.name || nameInput.value.trim(), parsed);
            if (issues.length) {
                issueLine.style.color = "var(--text-error)";
                issueLine.textContent = "规范检查提示：" + issues.join("；");
            } else {
                issueLine.style.color = "var(--text-muted)";
                issueLine.textContent = "规范检查通过（name 与目录名一致，含 description）。";
            }
        };
        editor.oninput = updateLint;
        if (nameInput) {
            let previousName = "";
            nameInput.oninput = () => {
                const name = nameInput.value.trim();
                if (/^[a-z0-9-]*$/.test(name)) {
                    const oldLine = "---\nname: " + previousName + "\n";
                    if (editor.value.startsWith(oldLine)) {
                        editor.value = "---\nname: " + name + "\n" + editor.value.slice(oldLine.length);
                        previousName = name;
                    }
                }
                updateLint();
            };
        }
        updateLint();

        modal.body.appendChild(issueLine);
        modal.body.appendChild(editor);

        const cancelBtn = el("button", null, "取消");
        cancelBtn.onclick = () => modal.close();
        const saveBtn = el("button", null, "保存");
        saveBtn.className = "mod-cta";
        saveBtn.onclick = async () => {
            saveBtn.disabled = cancelBtn.disabled = true;
            try {
                if (!skill) {
                    await exclusive(async () => {
                        const scope = destination();
                        const target = skillCreationTarget(scope, nameInput.value.trim());
                        const issues = validateSkill(target.dir, target.name, parseSkillFrontmatter(editor.value));
                        if (issues.length) throw new Error(issues.join("；"));
                        const files = [{ rel: "SKILL.md", base64: Buffer.from(editor.value, "utf8").toString("base64"), mode: 0o644 }];
                        await createSkill(history, target, files, skillSourceChange(stateRoot, target.sourceKey, null));
                        activeScopeKey = scope.key;
                    });
                    modal.close();
                    await safeRefresh();
                    return;
                }
                const changed = await exclusive(() => saveSelfSkillEdit(history, skill, beforeText, editor.value));
                modal.close();
                if (changed) {
                    new Notice("已保存 " + skill.name);
                    await safeRefresh();
                }
            } catch (error) {
                saveBtn.disabled = cancelBtn.disabled = false;
                await showMessage("保存失败", error.message || String(error));
            }
        };
        modal.footer.appendChild(cancelBtn);
        modal.footer.appendChild(saveBtn);
    }

    function openGitHubLinkModal(skill, creationScope) {
        const title = !skill ? "新建技能" : skill.source.kind === "github" ? "修改链接" : "GitHub 上游地址";
        const modal = createModal({ title, width: 620, widthVw: 92, maxHeight: 80 });
        modal.body.style.cssText = "padding:16px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px;";
        const destination = skill ? null : scopeField(modal.body, creationScope);
        const urlLabel = el("label", "display:flex;flex-direction:column;gap:4px;font-size:13px;");
        urlLabel.appendChild(el("span", "font-weight:600;", "GitHub 上游地址"));
        const urlInput = el("input",
            "padding:6px 10px;border:1px solid var(--background-modifier-border);border-radius:6px;font-size:13px;");
        urlInput.type = "text";
        urlInput.setAttribute("aria-label", "GitHub 上游地址");
        urlInput.placeholder = "https://github.com/owner/repo/tree/ref/path" +
            (skill ? "（也可直接粘贴「地址 @ commit」）" : "");
        urlInput.value = skill?.source.url || "";
        urlLabel.appendChild(urlInput);

        const commitLabel = el("label", "display:flex;flex-direction:column;gap:4px;font-size:13px;");
        commitLabel.appendChild(el("span", "font-weight:600;", "已复制 Commit SHA（可选）"));
        const commitInput = el("input",
            "padding:6px 10px;border:1px solid var(--background-modifier-border);border-radius:6px;font-size:13px;");
        commitInput.type = "text";
        commitInput.setAttribute("aria-label", "已复制 Commit SHA");
        commitInput.placeholder = "留空则点击检查更新时视为基线未知";
        commitInput.value = skill?.source.commit || "";
        commitLabel.appendChild(commitInput);

        const errorEl = el("div", "color:var(--text-error);font-size:12px;");
        modal.body.appendChild(urlLabel);
        if (skill) modal.body.appendChild(commitLabel);
        modal.body.appendChild(errorEl);

        const cancelBtn = el("button", null, "取消");
        cancelBtn.onclick = () => modal.close();
        const saveBtn = el("button", null, skill ? "保存" : "导入");
        saveBtn.className = "mod-cta";
        saveBtn.onclick = async () => {
            errorEl.textContent = "";
            saveBtn.disabled = cancelBtn.disabled = true;
            try {
                await exclusive(async () => {
                    const commit = skill && urlInput.value.trim() !== skill.source.url &&
                        commitInput.value === skill.source.commit ? "" : commitInput.value;
                    const parsed = parseSourceInput(urlInput.value, commit);
                    parseGitHubUrl(parsed.url);
                    if (!skill) {
                        const scope = destination();
                        await importGitHubSkill(history, stateRoot, scope, parsed.url, checks);
                        activeScopeKey = scope.key;
                        return;
                    }
                    const change = skillSourceChange(stateRoot, skill.sourceKey, {
                        kind: "github",
                        url: parsed.url,
                        commit: parsed.commit,
                        updatedAt: new Date().toISOString(),
                    });
                    replaceText(change.sourcesPath, change.afterSourcesText);
                });
                modal.close();
                if (skill) new Notice("已更新来源设置：" + skill.name);
                await safeRefresh();
            } catch (error) {
                errorEl.textContent = error.message || String(error);
                saveBtn.disabled = cancelBtn.disabled = false;
            }
        };
        modal.footer.appendChild(cancelBtn);
        modal.footer.appendChild(saveBtn);
    }

    async function changeSkillType(select, skill) {
        const next = select.value;
        select.value = skill.source.kind;
        if (next === skill.source.kind) return;
        if (next === "github") {
            openGitHubLinkModal(skill);
            return;
        }
        try {
            await exclusive(() => {
                const change = skillSourceChange(stateRoot, skill.sourceKey, null);
                if (change.sourcesPath) replaceText(change.sourcesPath, change.afterSourcesText);
            });
            await safeRefresh();
        } catch (error) {
            await showMessage("保存失败", error.message || String(error));
        }
    }

    function openTargetsModal(isUser) {
        const config = isUser ? {
            key: "skillUserTargets",
            validator: skillUserPath,
            title: "管理用户级技能分发目标",
            desc: "填写工具名称及技能目录（须以 ~/ 开头或使用绝对路径）；保存只更新分发目标列表，不删除已有技能文件或软链接。",
            pathLabel: "技能目录",
            notice: "已更新用户级技能分发目标。",
        } : {
            key: "skillProjectTargets",
            validator: skillProjectPath,
            title: "管理项目级技能分发目标（对所有项目生效）",
            desc: "此处配置对当前仓库及所有已登记项目共同生效；填写相对于项目根目录的路径（不能为 .agents/skills 本身），保存不删除已有文件或软链接。",
            pathLabel: "相对技能目录",
            notice: "已更新项目级技能分发目标（对所有项目生效）。",
        };

        const modal = createModal({ title: config.title, width: 680, widthVw: 92, maxHeight: 84 });
        modal.body.style.cssText = "padding:16px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px;";
        modal.body.appendChild(el("div", "font-size:13px;line-height:1.55;color:var(--text-muted);", config.desc));

        const toolbar = el("div", "display:flex;justify-content:flex-end;");
        const addBtn = el("button", null, "添加目标");
        addBtn.type = "button";
        toolbar.appendChild(addBtn);
        modal.body.appendChild(toolbar);

        const list = el("div", "display:flex;flex-direction:column;gap:8px;");
        modal.body.appendChild(list);

        const errorEl = el("div", "color:var(--text-error);font-size:12px;min-height:1em;");
        errorEl.setAttribute("role", "alert");
        modal.body.appendChild(errorEl);

        const rows = [];
        let invalidInput = null;
        function clearError() {
            invalidInput?.removeAttribute("aria-invalid");
            invalidInput = null;
            errorEl.textContent = "";
        }

        function addRow(name, value) {
            const row = el("div", "display:flex;flex-wrap:wrap;gap:8px;align-items:end;");
            function column(label, initial, flex) {
                const cell = el("label", `display:grid;gap:4px;min-width:0;flex:${flex} 1 120px;font-size:12px;`);
                cell.appendChild(el("span", "color:var(--text-muted);", label));
                const input = el("input",
                    "min-width:0;max-width:100%;padding:6px 10px;border:1px solid var(--background-modifier-border);border-radius:6px;font-size:13px;");
                input.type = "text";
                input.setAttribute("aria-label", label);
                input.placeholder = label;
                input.value = initial || "";
                cell.appendChild(input);
                row.appendChild(cell);
                return input;
            }
            const nameInput = column("工具名称", name, 1);
            const pathInput = column(config.pathLabel, value, 2);
            const removeBtn = el("button", null, "移除");
            removeBtn.type = "button";
            const entry = { row, nameInput, pathInput };
            removeBtn.onclick = () => {
                clearError();
                const idx = rows.indexOf(entry);
                if (idx >= 0) rows.splice(idx, 1);
                row.remove();
            };
            row.appendChild(removeBtn);
            rows.push(entry);
            list.appendChild(row);
            return nameInput;
        }

        for (const [name, value] of Object.entries(plugin.settings[config.key] || {})) {
            addRow(name, value);
        }
        addBtn.onclick = () => {
            clearError();
            addRow("", "").focus();
        };

        const cancelBtn = el("button", null, "取消");
        cancelBtn.onclick = () => modal.close();
        const saveBtn = el("button", null, "保存");
        saveBtn.className = "mod-cta";
        saveBtn.onclick = async () => {
            clearError();
            const entries = new Map();
            function fail(input, error) {
                errorEl.textContent = error.message || String(error);
                invalidInput = input;
                input.setAttribute("aria-invalid", "true");
                input.focus();
            }
            for (const { nameInput, pathInput } of rows) {
                let keyName;
                try {
                    keyName = required(String(nameInput.value || "").trim());
                    if (entries.has(keyName)) throw new Error("工具名称不能重复。");
                } catch (error) {
                    fail(nameInput, error);
                    return;
                }
                let parsedPath;
                try {
                    parsedPath = config.validator(required(String(pathInput.value || "").trim()));
                } catch (error) {
                    fail(pathInput, error);
                    return;
                }
                entries.set(keyName, parsedPath);
            }

            saveBtn.disabled = true;
            cancelBtn.disabled = true;
            try {
                const nextMap = Object.fromEntries(entries);
                await exclusive(() => plugin.updateSettings(current => ({
                    ...current,
                    [config.key]: nextMap,
                })));
                modal.close();
                new Notice(config.notice);
                await safeRefresh();
            } catch (error) {
                saveBtn.disabled = false;
                cancelBtn.disabled = false;
                errorEl.textContent = error.message || String(error);
            }
        };
        modal.footer.appendChild(cancelBtn);
        modal.footer.appendChild(saveBtn);
    }

    function formatCheckStatus(cached) {
        if (!cached) return "";
        if (cached.error) return "检查失败：" + cached.error;
        if (cached.status === "up-to-date") return "已是最新（" + cached.latestCommit.slice(0, 7) + "）";
        if (cached.status === "update-available") {
            return "发现新版本：" + cached.latestCommit.slice(0, 7) +
                (cached.commitMessage ? " — " + cached.commitMessage : "");
        }
        return "基线未知，最新提交：" + cached.latestCommit.slice(0, 7);
    }

    function renderHarnessSummary(parent, scope) {
        if (!scope.harnessStates.length) {
            parent.appendChild(el("div",
                "margin-bottom:12px;padding:10px 12px;border:1px solid var(--background-modifier-border);" +
                "border-radius:6px;font-size:var(--am-font-secondary);color:var(--text-muted);",
                "尚未配置分发目标，可点击上方「管理分发目标」添加。"));
            return;
        }
        const box = el("div",
            "display:flex;flex-direction:column;gap:8px;margin-bottom:12px;");
        for (const hState of scope.harnessStates) {
            const row = el("div",
                "display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;" +
                "border:1px solid var(--background-modifier-border);border-radius:6px;" +
                "background:var(--background-secondary);");
            const info = el("div", "flex:1;min-width:220px;");
            info.appendChild(el("div", "font-weight:600;", hState.name));
            info.appendChild(el("div",
                "font-family:var(--font-monospace);font-size:var(--am-font-secondary);color:var(--text-muted);word-break:break-all;",
                hState.targetDir));

            const statusEl = el("span", "font-size:var(--am-font-control);");
            row.appendChild(info);

            if (hState.status === "whole-dir-linked") {
                statusEl.style.color = "var(--text-accent)";
                statusEl.textContent = "整目录已链接";
                row.appendChild(statusEl);
                const convertBtn = el("button", "font-size:var(--am-font-control);", "转为逐个链接");
                convertBtn.className = "mod-cta";
                convertBtn.onclick = async () => {
                    const msg = "将把 " + hState.name + " 的整目录链接（" + hState.targetDir + "）替换为真实目录，" +
                        "并为当前 " + scope.skills.length + " 个技能逐个建立链接。\n" +
                        "源目录中的技能文件不会改动；转换若中途中断，该工具会暂时看不到技能（可通过「撤销上次操作」恢复）。";
                    if (!await showConfirm("转为逐个链接", msg, "确认转换")) return;
                    convertBtn.disabled = true;
                    try {
                        await exclusive(() => {
                            const freshScope = loadScopes().find(item => item.key === scope.key) || scope;
                            const freshHarness = freshScope.harnessStates.find(item => item.name === hState.name) || hState;
                            return convertWholeDirToPerSkill(history, freshScope, freshHarness);
                        });
                        new Notice(hState.name + " 已转为逐个链接");
                        await safeRefresh();
                    } catch (error) {
                        convertBtn.disabled = false;
                        await showMessage("转换失败", error.message || String(error));
                    }
                };
                row.appendChild(convertBtn);
            } else if (hState.status === "dir-conflict") {
                statusEl.style.color = "var(--text-error)";
                statusEl.textContent = "目录冲突：" + hState.reason;
                row.appendChild(statusEl);
            } else {
                let linkedCount = 0;
                let conflictCount = 0;
                let brokenCount = hState.brokenLinks.length;
                for (const skill of scope.skills) {
                    const st = hState.skills[skill.name].status;
                    if (st === "linked") linkedCount += 1;
                    else if (st === "conflict") conflictCount += 1;
                    else if (st === "broken") brokenCount += 1;
                }
                const parts = ["已链接 " + linkedCount + " / " + scope.skills.length];
                if (conflictCount) parts.push(conflictCount + " 冲突");
                if (brokenCount) parts.push(brokenCount + " 失效");
                statusEl.style.color = (conflictCount || brokenCount) ? "var(--text-warning)" : "var(--text-muted)";
                statusEl.textContent = parts.join(" · ");
                row.appendChild(statusEl);
            }
            box.appendChild(row);
        }
        parent.appendChild(box);
    }

    function renderBrokenLinks(parent, scope) {
        const items = [];
        for (const hState of scope.harnessStates) {
            for (const broken of hState.brokenLinks) {
                items.push({ harnessName: hState.name, broken });
            }
        }
        if (!items.length) return;

        const card = el("div",
            "border:1px solid var(--background-modifier-border);border-radius:6px;padding:12px 14px;margin-bottom:12px;");
        card.appendChild(el("div", "font-weight:600;margin-bottom:8px;color:var(--text-warning);",
            "失效链接（" + items.length + "）"));
        for (const item of items) {
            const row = el("div",
                "display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0;" +
                "border-top:1px solid var(--background-modifier-border);");
            const meta = el("div", "flex:1;min-width:200px;");
            meta.appendChild(el("div", null, item.harnessName + " / " + item.broken.name));
            meta.appendChild(el("div",
                "font-family:var(--font-monospace);font-size:var(--am-font-secondary);color:var(--text-muted);word-break:break-all;",
                item.broken.linkPath));
            const cleanBtn = el("button", "font-size:var(--am-font-control);", "清理");
            cleanBtn.onclick = async () => {
                cleanBtn.disabled = true;
                try {
                    await exclusive(() => cleanBrokenLink(history, item.broken, item.harnessName));
                    new Notice("已清理失效链接：" + item.broken.name);
                    await safeRefresh();
                } catch (error) {
                    cleanBtn.disabled = false;
                    await showMessage("清理失败", error.message || String(error));
                }
            };
            row.appendChild(meta);
            row.appendChild(cleanBtn);
            card.appendChild(row);
        }
        parent.appendChild(card);
    }

    function renderLinkSwitch(parent, scope, skill, harness, linked) {
        const toggle = new ToggleComponent(parent).setValue(linked);
        const control = toggle.toggleEl;
        control.setAttribute("role", "switch");
        control.setAttribute("aria-label", skill.name + " 链接到 " + harness.name);
        control.setAttribute("aria-checked", String(linked));
        toggle.onChange(async enable => {
            control.setAttribute("aria-checked", String(enable));
            if (enable === linked) return;
            toggle.setDisabled(true);
            try {
                await exclusive(() => enable
                    ? distributeSingleSkill(history, scope, skill, harness)
                    : unlinkSingleSkill(history, skill, harness));
                linked = enable;
                new Notice(enable ? "已分发 " + skill.name + " → " + harness.name : "已取消链接：" + skill.name);
            } catch (error) {
                toggle.setValue(linked);
                await showMessage(enable ? "分发失败" : "取消链接失败", error.message || String(error));
            }
            await safeRefresh();
            toggle.setDisabled(false);
        });
    }

    function renderSkillRow(parent, scope, skill) {
        const row = el("tr");
        const info = el("th", SKILL_CELL_STYLE + "text-align:left;font-weight:400;min-width:140px;");
        info.setAttribute("scope", "row");
        info.appendChild(el("div", "font-weight:600;font-size:var(--am-font-primary);overflow-wrap:anywhere;", skill.name));
        const summary = skill.description || "（无 description 说明）";
        const description = el("div",
            "max-width:30ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
            "font-size:var(--am-font-secondary);color:var(--text-muted);", summary);
        description.title = summary;
        info.appendChild(description);
        if (skill.issues.length) {
            const issues = skill.issues.join("；");
            const warning = el("details", "color:var(--text-error);");
            warning.appendChild(el("summary", "cursor:pointer;", "检查异常（" + skill.issues.length + "）"));
            warning.appendChild(el("div", "max-width:30ch;overflow-wrap:anywhere;", "问题：" + issues));
            info.appendChild(warning);
        }
        row.appendChild(info);

        const typeCell = el("td", SKILL_CELL_STYLE);
        const typeSelect = skillTypeSelect("类型", skill.source.kind);
        typeSelect.title = skill.name;
        typeSelect.onchange = () => changeSkillType(typeSelect, skill);
        typeCell.appendChild(typeSelect);
        row.appendChild(typeCell);

        const actionCell = el("td", SKILL_CELL_STYLE);
        const actions = el("div", "display:flex;gap:4px;flex-wrap:wrap;");
        actionCell.appendChild(actions);
        row.appendChild(actionCell);

        if (scope.harnessStates.length) {
            for (const hState of scope.harnessStates) {
                const cell = el("td", SKILL_CELL_STYLE);
                const line = el("div", "display:flex;align-items:center;gap:4px;flex-wrap:wrap;");
                cell.appendChild(line);
                if (hState.status === "whole-dir-linked") {
                    const status = el("span", "color:var(--text-muted);", "整目录已链接");
                    status.title = "整目录已链接（需先转换再单独分发）";
                    line.appendChild(status);
                } else if (hState.status === "dir-conflict") {
                    const status = el("span", "color:var(--text-error);", "目录冲突");
                    status.title = hState.reason;
                    line.appendChild(status);
                } else {
                    const sState = hState.skills[skill.name];
                    if (sState.status === "linked" || sState.status === "unlinked") {
                        renderLinkSwitch(line, scope, skill, hState, sState.status === "linked");
                    } else if (sState.status === "broken") {
                        const status = el("span", "color:var(--text-warning);", "失效");
                        status.title = sState.reason;
                        line.appendChild(status);
                        const cleanBtn = el("button", SKILL_ACTION_STYLE, "清理");
                        cleanBtn.onclick = async () => {
                            cleanBtn.disabled = true;
                            try {
                                await exclusive(() => cleanBrokenLink(history, { name: skill.name, linkPath: sState.linkPath }, hState.name));
                                new Notice("已清理失效链接：" + skill.name);
                                await safeRefresh();
                            } catch (error) {
                                cleanBtn.disabled = false;
                                await showMessage("清理失败", error.message || String(error));
                            }
                        };
                        line.appendChild(cleanBtn);
                    } else {
                        line.appendChild(el("span", "color:var(--text-error);overflow-wrap:anywhere;max-width:24ch;", "冲突：" + sState.reason));
                    }
                }
                row.appendChild(cell);
            }
        }

        const viewBtn = el("button", SKILL_ACTION_STYLE, "查看");
        viewBtn.onclick = () => openViewSkillModal(skill);
        actions.appendChild(viewBtn);

        if (skill.source.kind === "self") {
            const editBtn = el("button", SKILL_ACTION_STYLE, "编辑");
            editBtn.onclick = () => openEditSkillModal(skill);
            actions.appendChild(editBtn);
        } else {
            const updateBtn = el("button", SKILL_ACTION_STYLE, "更新");
            const updateInfo = el("div", "max-width:30ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
            info.appendChild(updateInfo);
            let updating = false;
            const updateStatus = () => {
                const result = checks.status(skill.source);
                const available = result?.status === "update-available";
                updateBtn.className = available ? "mod-cta" : "";
                updateBtn.disabled = updating || result?.status === "up-to-date";
                updateInfo.textContent = updateInfo.title = formatCheckStatus(result);
                updateInfo.hidden = !updateInfo.textContent;
                updateInfo.style.color = available ? "var(--text-accent)" : "var(--text-muted)";
            };
            updateStatus();
            updateRows.push(updateStatus);
            updateBtn.onclick = async () => {
                if (updateBtn.disabled) return;
                updating = true;
                updateBtn.disabled = true;
                try {
                    const res = await exclusive(() => updateGitHubSkill(history, stateRoot, skill, checks));
                    if (res) new Notice("已更新 " + skill.name + "（" + res.latestCommit.slice(0, 7) + "）");
                    await safeRefresh();
                } catch (error) {
                    await showMessage("更新失败", error.message || String(error));
                } finally {
                    updating = false;
                    updateStatus();
                }
            };
            actions.appendChild(updateBtn);
            const sourceBtn = el("button", SKILL_ACTION_STYLE, "修改链接");
            sourceBtn.onclick = () => openGitHubLinkModal(skill);
            actions.appendChild(sourceBtn);
        }

        parent.appendChild(row);
    }

    function renderSkillTable(parent, scope) {
        const scroll = el("div", "overflow-x:auto;max-width:100%;");
        scroll.tabIndex = 0;
        scroll.setAttribute("aria-label", "技能");
        const table = el("table", "width:100%;border-collapse:collapse;table-layout:auto;margin:0;");
        const head = el("thead");
        const columns = el("tr");
        for (const label of ["技能", "类型", "操作", ...scope.harnessStates.map(tool => tool.name)]) {
            const header = el("th", SKILL_CELL_STYLE + "text-align:left;white-space:nowrap;", label);
            header.setAttribute("scope", "col");
            columns.appendChild(header);
        }
        head.appendChild(columns);
        table.appendChild(head);
        const body = el("tbody");
        for (const skill of scope.skills) renderSkillRow(body, scope, skill);
        table.appendChild(body);
        scroll.appendChild(table);
        parent.appendChild(scroll);
    }

    function renderInitError(error) {
        const nextArea = el("div");
        const card = el("div",
            "border:1px solid var(--background-modifier-border);border-radius:6px;padding:14px;");
        card.appendChild(el("div", "font-weight:600;margin-bottom:6px;", "技能管理不可用"));
        card.appendChild(el("div", "color:var(--text-error);white-space:pre-wrap;line-height:1.6;",
            error && error.message ? error.message : String(error)));
        nextArea.appendChild(card);
        if (area) area.remove();
        area = nextArea;
        content.appendChild(area);
    }

    function render(nextScopes) {
        scopes = nextScopes;
        updateRows.length = 0;
        const prevScroll = content.scrollTop || 0;
        const nextArea = el("div");

        const tabBar = el("div", "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;");
        const tabs = {};
        const panes = {};

        const activateTab = key => {
            activeScopeKey = key;
            for (const scope of scopes) {
                const active = scope.key === key;
                tabs[scope.key].style.cssText = active ? TAB_ACTIVE_STYLE : TAB_BASE_STYLE;
                panes[scope.key].style.display = active ? "" : "none";
            }
        };

        nextArea.appendChild(tabBar);
        for (const scope of scopes) {
            const tab = el("button", null, scope.name + "（" + scope.skills.length + "）");
            tab.onclick = () => activateTab(scope.key);
            tabs[scope.key] = tab;
            const pane = el("div");
            panes[scope.key] = pane;
            tabBar.appendChild(tab);
            nextArea.appendChild(pane);

            const secHeader = el("div",
                "margin:6px 0 10px;padding:8px 12px;background:var(--background-secondary);border-radius:6px;" +
                "display:flex;align-items:center;gap:10px;flex-wrap:wrap;");
            const secMeta = el("div", "flex:1;min-width:0;");
            secMeta.appendChild(el("div", "font-weight:600;", scope.name));
            secMeta.appendChild(el("div",
                "font-size:var(--am-font-secondary);color:var(--text-muted);margin-top:3px;" +
                "font-family:var(--font-monospace);word-break:break-all;",
                "源目录：" + scope.sourceRoot));
            const manageBtn = el("button", "flex-shrink:0;font-size:var(--am-font-control);", "管理分发目标");
            manageBtn.type = "button";
            manageBtn.onclick = () => openTargetsModal(scope.kind === "user");
            const createBtn = el("button", "flex-shrink:0;font-size:var(--am-font-control);", "新建技能");
            createBtn.type = "button";
            createBtn.onclick = () => openCreateMenu(createBtn, scope);
            secHeader.appendChild(secMeta);
            secHeader.appendChild(createBtn);
            secHeader.appendChild(manageBtn);
            pane.appendChild(secHeader);

            renderHarnessSummary(pane, scope);
            renderBrokenLinks(pane, scope);

            if (!scope.skills.length) {
                const emptyCard = el("div",
                    "border:1px solid var(--background-modifier-border);border-radius:6px;padding:14px;" +
                    "font-size:var(--am-font-secondary);color:var(--text-muted);",
                    "当前目录中尚未发现含 SKILL.md 的技能子文件夹。");
                pane.appendChild(emptyCard);
            } else {
                renderSkillTable(pane, scope);
            }
        }

        const defaultKey = scopes.some(scope => scope.key === activeScopeKey)
            ? activeScopeKey
            : (scopes[0]?.key || null);
        if (defaultKey) activateTab(defaultKey);

        if (area) area.remove();
        area = nextArea;
        content.appendChild(area);
        content.scrollTop = prevScroll;
    }

    async function refreshPanel() {
        const token = ++renderToken;
        const nextScopes = loadScopes();
        if (closed || token !== renderToken) return;
        render(nextScopes);
        refreshHistory();
    }

    async function safeRefresh() {
        try {
            await refreshPanel();
        } catch (error) {
            if (!stateRoot && !closed) {
                renderInitError(error);
                refreshHistory();
                return;
            }
            if (!closed) await showMessage("刷新失败", error && error.message ? error.message : String(error));
        }
    }

    const last = el("span", "margin-right:auto;align-self:center;font-size:var(--am-font-secondary);color:var(--text-muted);");
    const refreshButton = el("button", "font-size:var(--am-font-control);", "刷新");
    const checkUpdatesButton = el("button", "font-size:var(--am-font-control);", "检查更新");
    const undoButton = el("button", "font-size:var(--am-font-control);", "撤销上次操作");
    const bulkButton = el("button", "font-size:var(--am-font-control);", "一键分发");

    refreshHistory = () => {
        const op = history ? history.latest() : null;
        last.textContent = op ? "上次操作：" + op.label : "";
        undoButton.disabled = !op;
        const hasGitHub = scopes.some(scope => scope.skills.some(skill => skill.source.kind === "github"));
        checkUpdatesButton.disabled = !stateRoot || !hasGitHub || manualCheckRunning;
        bulkButton.disabled = !stateRoot;
    };

    refreshButton.onclick = async () => {
        if (plugin.skillsBusy) return;
        refreshButton.disabled = true;
        try {
            await safeRefresh();
        } finally {
            if (!closed) refreshButton.disabled = false;
        }
    };

    async function checkUpdates(force) {
        const sources = scopes.flatMap(scope => scope.skills.map(skill => skill.source)).filter(source => source.kind === "github");
        const urls = new Set(sources.map(source => source.url));
        for (const url of urls) {
            if (closed) return;
            if (!force && checks.status({ url })?.latestCommit) continue;
            try {
                await checks.fetchLatest(url);
            } catch {
                // 查询错误由对应技能行展示，其余来源继续检查。
            }
            if (closed) return;
            for (const update of updateRows) update();
        }
        if (force && !closed) {
            const results = sources.map(source => checks.status(source));
            const updates = results.filter(result => result?.status === "update-available").length;
            const failed = results.filter(result => result?.error).length;
            const latest = results.length - updates - failed;
            new Notice(`检查完成：${updates} 个有更新，${latest} 个无更新或待建基线` +
                (failed ? `，${failed} 个失败` : ""));
        }
    }

    checkUpdatesButton.onclick = async () => {
        if (manualCheckRunning) return;
        manualCheckRunning = true;
        checkUpdatesButton.disabled = true;
        try {
            await checkUpdates(true);
        } finally {
            manualCheckRunning = false;
            if (!closed) refreshHistory();
        }
    };

    undoButton.onclick = async () => {
        if (!history) return;
        try {
            const restored = await exclusive(() => history.undo(files => showConfirm(
                "撤销上次操作",
                "以下目标在操作后又有修改。继续撤销会覆盖这些修改：\n" + files.join("\n"),
                "继续撤销"
            )));
            if (restored) await safeRefresh();
        } catch (error) {
            await showMessage("撤销失败", error.message || String(error));
        }
    };

    bulkButton.onclick = async () => {
        if (!stateRoot) return;
        try {
            const result = await exclusive(() => distributeAllSkills(history, loadScopes()));
            if (result.createdCount > 0) {
                new Notice("一键分发完成：新建 " + result.createdCount + " 个链接" +
                    (result.skippedWholeDir ? "（跳过 " + result.skippedWholeDir + " 个整目录链接）" : ""));
                await safeRefresh();
            } else {
                const msg = result.skippedWholeDir || result.skippedConflicts
                    ? `没有可新建的链接（跳过 ${result.skippedWholeDir} 个整目录链接、${result.skippedConflicts} 处冲突或失效）。`
                    : "所有技能链接均已就绪。";
                await showMessage("一键分发技能", msg);
            }
        } catch (error) {
            await showMessage("一键分发失败", error.message || String(error));
        }
    };

    footer.appendChild(last);
    footer.appendChild(refreshButton);
    footer.appendChild(checkUpdatesButton);
    footer.appendChild(undoButton);
    footer.appendChild(bulkButton);

    async function enterPanel() {
        await safeRefresh();
        if (!closed) void checkUpdates(false);
    }

    return {
        ready: enterPanel(),
        refresh: enterPanel,
        destroy: () => { closed = true; },
        isBusy: () => Boolean(plugin.skillsBusy),
    };
}

module.exports = { mountSkills };
