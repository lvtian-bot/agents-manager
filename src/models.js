const { createHash } = require("node:crypto");

const modelPresets = {
    deepseek: {
        label: "DeepSeek 官方",
        endpoint: "https://api.deepseek.com/chat/completions",
        model: "deepseek-flash",
        secretId: "agents-manager-deepseek-api-key",
        requestOptions: { thinking: { type: "disabled" } },
    },
    siliconflow: {
        label: "硅基流动",
        endpoint: "https://api.siliconflow.cn/v1/chat/completions",
        model: "deepseek-ai/DeepSeek-V4.1-Flash",
        secretId: "agents-manager-siliconflow-api-key",
    },
};

function modelPreset(id) {
    return Object.hasOwn(modelPresets, id) ? modelPresets[id] : null;
}

function modelEndpoint(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error("请填写完整的模型接口地址。"); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
        throw new Error("模型接口须使用 HTTPS 或本机地址。");
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("请单独配置请求凭据。");
    return url.href;
}

function modelSecretId(selection, endpoint) {
    const preset = modelPreset(selection);
    if (preset) return preset.secretId;
    if (selection !== "custom" || !endpoint) return null;
    let normalized;
    try { normalized = modelEndpoint(endpoint); } catch { return null; }
    return "agents-manager-custom-" + createHash("sha256").update(normalized).digest("hex");
}

function getModelConnection(app, settings) {
    const { modelConnection, endpoint, model } = settings;
    let connection = modelPreset(modelConnection);
    if (!connection) {
        if (modelConnection !== "custom") throw new Error("请在模型设置中选择模型。");
        const address = modelEndpoint(endpoint);
        if (!model) throw new Error("此项不能为空。");
        connection = { endpoint: address, model };
    }
    const credential = app.secretStorage.getSecret(modelSecretId(modelConnection, connection.endpoint));
    if (!credential) throw new Error("请在模型设置中保存 API Key。");
    return { ...connection, credential };
}

module.exports = { modelPresets, modelPreset, modelEndpoint, modelSecretId, getModelConnection };
