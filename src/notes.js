const { Notice } = require("obsidian");
const https = require("node:https");
const { Readable } = require("node:stream");
const { json } = require("node:stream/consumers");
const { getModelConnection } = require("./models");

function requestHttps(endpoint, { method, headers, body, signal }) {
    return new Promise((resolve, reject) => {
        const request = https.request(endpoint, { method, headers, signal }, response => {
            const status = response.statusCode;
            if (status < 200 || status >= 300) {
                response.destroy();
                resolve({ ok: false, status });
                return;
            }
            const isJson = response.headers["content-type"]?.includes("application/json");
            resolve({
                ok: true,
                body: isJson ? undefined : Readable.toWeb(response),
                json: () => json(response),
            });
        });
        request.on("error", reject);
        request.end(body);
    });
}

async function requestText({ endpoint, model, credential, requestOptions }, prompt, signal, onText) {
    const payload = {
        model, messages: [{ role: "user", content: prompt }],
        stream: true, temperature: 0.3, max_tokens: 2000,
        ...requestOptions,
    };
    const isSiliconFlow = new URL(endpoint).hostname === "api.siliconflow.cn";
    if (isSiliconFlow) payload.enable_thinking = false;
    // 硅基流动的跨域预检未明确放行 Authorization。桌面端 HTTPS 请求仍可流式读取。
    const send = isSiliconFlow ? requestHttps : fetch;
    const response = await send(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + credential },
        body: JSON.stringify(payload), signal,
    });
    if (!response.ok) throw new Error("模型接口返回 HTTP " + response.status + "。");
    if (response.headers?.get("content-type")?.includes("application/json") || !response.body?.getReader) {
        const result = await response.json();
        if (result.error) throw new Error("模型接口返回错误。");
        const text = result.choices?.[0]?.message?.content;
        if (text) onText(text);
        return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    function consume(line) {
        if (!line.startsWith("data:")) return false;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return true;
        if (!data) return false;
        const item = JSON.parse(data);
        if (item.error) throw new Error("模型在生成时返回错误。");
        const text = item.choices?.[0]?.delta?.content;
        if (text) onText(text);
        return false;
    }
    try {
        while (true) {
            const { value, done } = await reader.read();
            pending += decoder.decode(value, { stream: !done });
            const lines = pending.split("\n");
            pending = lines.pop();
            if (lines.some(consume)) break;
            if (done) { consume(pending); break; }
        }
    } finally {
        try { await reader.cancel?.(); } catch {}
        reader.releaseLock?.();
    }
}

async function editWithAI(plugin, action) {
    const { app, settings } = plugin;
    const file = app.workspace.getActiveFile();
    if (!file) throw new Error("请先打开笔记。");
    const editor = app.workspace.activeEditor?.editor;
    const originalSelection = editor?.getSelection() || "";
    const translating = action === "translation";
    if (translating && !originalSelection.trim()) throw new Error("请先选中要翻译的外文。");
    const connection = getModelConnection(app, settings);
    const from = editor?.getCursor?.("from");
    const to = editor?.getCursor?.("to");
    const original = editor?.getValue?.() ?? await app.vault.read(file);
    let prompt;
    let title;
    if (translating) {
        title = "AI 翻译为中文";
        prompt = ["请将下面的外文翻译为中文，已有中文保留原文。忠实保留原意、语气和术语，只输出译文。", originalSelection.trim()].join("\n\n");
    } else {
        const multiple = settings.summaryMode === "multiple";
        const metadata = multiple && app.metadataCache?.getFileCache(file)?.frontmatter;
        const type = metadata && Object.hasOwn(metadata, settings.typeProperty) ? metadata[settings.typeProperty] : undefined;
        const match = ["string", "number", "boolean"].includes(typeof type) && Object.hasOwn(settings.templates, type) && settings.templates[type];
        const templatePath = multiple ? match || settings.defaultTemplate : settings.singleTemplate;
        title = "AI 总结笔记" + (match ? " · " + type : "");
        let template = "请忠实总结以下笔记的要点，保留关键事实、数字和结论。\n\n{activeNote}";
        if (templatePath) {
            const templateFile = app.vault.getAbstractFileByPath(templatePath);
            if (!templateFile) throw new Error("找不到总结模板：" + templatePath);
            template = (await app.vault.read(templateFile)).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
            // 部分模板保留了旧工具的第二个占位符，只需传送一次笔记。
            if (template.replace(/<text>\{activeNote\}<\/text>/g, "").includes("{activeNote}")) {
                template = template.replace(/<text>\{activeNote\}<\/text>\r?\n?/g, "");
            }
        }
        prompt = template.includes("{activeNote}") ? template.replaceAll("{activeNote}", () => original) : template + "\n\n" + original;
    }

    const controller = new AbortController();
    let closed = false;
    const modal = plugin.openDialog(title, () => { closed = true; controller.abort(); });
    const body = modal.contentEl;
    const preview = document.createElement("textarea");
    preview.readOnly = true;
    preview.placeholder = "生成中……";
    preview.value = "";
    preview.style.cssText = "width:100%;min-height:34vh;resize:vertical";
    body.appendChild(preview);
    const buttons = document.createElement("div");
    buttons.className = "modal-button-container";
    body.appendChild(buttons);
    function button(label, action) {
        const element = document.createElement("button");
        element.textContent = label;
        element.onclick = action;
        buttons.appendChild(element);
        return element;
    }
    function write(append) {
        if (app.workspace.getActiveFile()?.path !== file.path || app.workspace.activeEditor?.editor !== editor ||
            (editor.getValue && editor.getValue() !== original)) {
            new Notice("原笔记或编辑器已变化，请重新运行。");
            return;
        }
        const text = (append ? originalSelection : "") + preview.value;
        if (from && to) editor.replaceRange(text, from, to);
        else editor.replaceSelection(text);
        modal.close();
    }
    button("放弃", () => modal.close());
    const replace = button("替换", () => write(false));
    const insert = button("插入", () => write(true));
    replace.disabled = insert.disabled = true;
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
        await requestText(connection, prompt, controller.signal, delta => { if (!closed) preview.value += delta; });
        if (!preview.value.trim()) throw new Error("模型未返回内容。");
    } catch (error) {
        if (closed) return;
        if (!controller.signal.aborted || !preview.value) {
            preview.value = controller.signal.aborted ? "请求超时。" : error.message;
            return;
        }
        new Notice("请求超时，可保留已生成的部分。");
    } finally {
        clearTimeout(timer);
    }
    if (!closed) {
        preview.readOnly = false;
        replace.disabled = insert.disabled = !editor;
    }
}
module.exports = { editWithAI };
