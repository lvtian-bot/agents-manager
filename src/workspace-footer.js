function createWorkspaceFooter(host, description) {
    const footer = document.createElement("div");
    footer.style.cssText =
        "display:flex;gap:8px 16px;flex-wrap:wrap;align-items:center;padding:10px 18px;" +
        "border-top:1px solid var(--background-modifier-border);flex-shrink:0;";

    const operationInfo = document.createElement("div");
    operationInfo.style.cssText =
        "flex:1 1 240px;min-width:0;line-height:1.5;overflow-wrap:anywhere;" +
        "font-size:var(--am-font-secondary);color:var(--text-muted);";
    const last = document.createElement("div");
    const explanation = document.createElement("div");
    explanation.textContent = description;
    operationInfo.appendChild(last);
    operationInfo.appendChild(explanation);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-left:auto;max-width:100%;";
    footer.appendChild(operationInfo);
    footer.appendChild(actions);
    host.appendChild(footer);
    return { last, actions };
}

module.exports = { createWorkspaceFooter };
