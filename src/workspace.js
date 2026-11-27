const { ItemView, setIcon } = require("obsidian");

const WORKSPACE_VIEW_TYPE = "agents-manager-workspace";
const WORKSPACE_VIEW_TITLE = "多 Agent 管理";
const WORKSPACE_VIEW_ICON = "layers";

const SECTION_DEFS = [
    { key: "instructions", label: "指令同步", icon: "refresh-cw" },
    { key: "skills", label: "技能管理", icon: "library" },
];

const NAV_BASE_STYLE =
    "display:inline-flex;align-items:center;gap:6px;padding:10px 0;height:auto;" +
    "border:0;border-bottom:2px solid transparent;border-radius:0;cursor:pointer;" +
    "font-size:var(--am-font-control);box-shadow:none;background:transparent;" +
    "white-space:nowrap;color:var(--text-muted);";
const NAV_ACTIVE_STYLE = NAV_BASE_STYLE +
    "border-bottom-color:var(--text-accent);color:var(--text-accent);font-weight:600;";

function avoidStatusBar(root, workspace) {
    const doc = root.ownerDocument;
    const statusBar = doc?.querySelector(".status-bar");
    const ResizeObserver = doc?.defaultView?.ResizeObserver;
    if (!statusBar || !ResizeObserver) return;

    const updateClearance = () => {
        const view = root.getBoundingClientRect();
        const bar = statusBar.getBoundingClientRect();
        const overlaps = bar.width > 0 && bar.height > 0 &&
            view.left < bar.right && view.right > bar.left &&
            view.top < bar.bottom && view.bottom > bar.top;
        const padding = (overlaps ? Math.ceil(view.bottom - bar.top) : 0) + "px";
        if (root.style.paddingBottom !== padding) root.style.paddingBottom = padding;
    };

    const observer = new ResizeObserver(updateClearance);
    observer.observe(root, { box: "border-box" });
    observer.observe(statusBar, { box: "border-box" });
    const layoutEvent = workspace.on("layout-change", updateClearance);
    updateClearance();
    return () => {
        observer.disconnect();
        workspace.offref(layoutEvent);
    };
}

class ManagerWorkspaceView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.activeSection = plugin._pendingSection === "skills" ? "skills" : "instructions";
        plugin._pendingSection = null;
        this.controllers = {};
        this.hosts = {};
        this.navButtons = {};
        this.opened = false;
        this.justOpened = false;
    }

    getViewType() {
        return WORKSPACE_VIEW_TYPE;
    }

    getDisplayText() {
        return WORKSPACE_VIEW_TITLE;
    }

    getIcon() {
        return WORKSPACE_VIEW_ICON;
    }

    async onOpen() {
        const root = this.contentEl;
        root.empty?.();
        root.style.cssText =
            "display:flex;flex-direction:column;height:100%;box-sizing:border-box;overflow:hidden;padding:0;" +
            "--am-font-primary:var(--font-ui-medium,15px);--am-font-control:calc(var(--font-ui-small,13px) + 1px);" +
            "--am-font-secondary:var(--font-ui-smaller,12px);font-size:var(--am-font-primary);line-height:1.5;";

        const nav = document.createElement("div");
        nav.setAttribute("role", "tablist");
        nav.style.cssText =
            "display:flex;align-items:center;gap:24px;padding:0 18px;" +
            "border-bottom:1px solid var(--background-modifier-border);flex-shrink:0;";

        const stage = document.createElement("div");
        stage.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;";

        for (const def of SECTION_DEFS) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = def.label;
            button.setAttribute("role", "tab");
            const icon = document.createElement("span");
            icon.style.cssText = "display:inline-flex;--icon-size:14px;";
            icon.setAttribute("aria-hidden", "true");
            setIcon(icon, def.icon);
            button.prepend(icon);
            button.onclick = () => {
                this.plugin.run(() => this.setSection(def.key));
            };
            this.navButtons[def.key] = button;
            nav.appendChild(button);

            const host = document.createElement("div");
            host.style.cssText = "display:none;flex-direction:column;flex:1;min-height:0;overflow:hidden;";
            this.hosts[def.key] = host;
            stage.appendChild(host);
        }

        root.appendChild(nav);
        root.appendChild(stage);
        this.stopAvoidingStatusBar = avoidStatusBar(root, this.plugin.app.workspace);
        this.opened = true;
        this.justOpened = true;
        await this.setSection(this.activeSection, { initial: true });
    }

    async setSection(section, options = {}) {
        const target = section === "skills" ? "skills" : "instructions";
        this.activeSection = target;
        if (!this.opened) return;

        for (const def of SECTION_DEFS) {
            const active = def.key === target;
            this.navButtons[def.key].style.cssText = active ? NAV_ACTIVE_STYLE : NAV_BASE_STYLE;
            this.navButtons[def.key].setAttribute("aria-selected", active ? "true" : "false");
            this.hosts[def.key].style.display = active ? "flex" : "none";
        }

        const existing = this.controllers[target];
        if (!existing) {
            const controller = target === "skills"
                ? require("./skills/panel").mountSkills(this.plugin, this.hosts.skills)
                : require("./instructions/panel").mountInstructions(this.plugin, this.hosts.instructions);
            this.controllers[target] = controller;
            await controller.ready;
            return;
        }

        await existing.ready;
        if (!options.initial && !existing.isBusy?.()) {
            await existing.refresh();
        }
    }

    async setState(state, result) {
        const next = state?.section === "skills" ? "skills" : "instructions";
        if (this.justOpened && next === this.activeSection && this.controllers[next]) {
            this.justOpened = false;
            await this.controllers[next].ready;
        } else {
            this.justOpened = false;
            await this.setSection(next);
        }
        if (super.setState) await super.setState(state, result);
    }

    getState() {
        return { section: this.activeSection };
    }

    async onClose() {
        this.opened = false;
        this.stopAvoidingStatusBar?.();
        for (const controller of Object.values(this.controllers)) {
            controller?.destroy?.();
        }
        this.controllers = {};
        this.hosts = {};
        this.navButtons = {};
    }
}

module.exports = { WORKSPACE_VIEW_TYPE, WORKSPACE_VIEW_TITLE, WORKSPACE_VIEW_ICON, ManagerWorkspaceView };
