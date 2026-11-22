import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "agents-manager-desktop-"));
const vault = path.join(root, "vault");
const plugin = path.join(vault, ".obsidian", "plugins", "agents-manager");
const state = path.join(plugin, "sync");
const targets = path.join(root, "targets");

async function write(file, text) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, { encoding: "utf8", flag: "wx" });
}

async function json(file, value) {
    await write(file, JSON.stringify(value, null, 2) + "\n");
}

await mkdir(plugin, { recursive: true });
for (const file of ["manifest.json", "main.js"]) {
    await copyFile(path.join(project, file), path.join(plugin, file));
}

const userTarget = path.join(targets, "example-agent", "instructions.md");
await write(path.join(vault, "用户指令.md"), "请保留来源。\n");
await write(userTarget, "请标注日期。\n");
await write(path.join(vault, "示例笔记.md"), "这是一篇用于验证选区翻译和笔记总结的合成笔记。\n");

const projects = [];
for (const type of ["work", "code"]) {
    const target = path.join(targets, type, "AGENTS.md");
    await write(path.join(vault, type + ".md"), "# 共用规范\n记录依据。\n# 模板示例\n示例内容。\n");
    await write(target, "# 共用规范\n记录版本。\n# 项目专属\n保留本段。\n");
    projects.push({ name: type + " 样例", type, path: target });
}

await json(path.join(state, "instruction-projects.json"), { version: 1, projects });
await json(path.join(plugin, "data.json"), {
    userSource: "用户指令.md", workSource: "work.md", codeSource: "code.md",
    targets: { "样例 Agent": userTarget },
    endpoint: "http://127.0.0.1:1/v1/chat/completions",
    credentialVariable: "AGENTS_MANAGER_FIXTURE_CREDENTIAL",
    model: "fixture", templates: {}, defaultTemplate: "",
});

console.log(vault);
