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

function getModelConnection(app, settings) {
    const preset = modelPreset(settings.modelConnection);
    if (preset) {
        const credential = app.secretStorage.getSecret(preset.secretId);
        if (!credential) throw new Error("请在模型设置中保存 API Key。");
        return { ...preset, credential };
    }
    if (settings.modelConnection !== "custom") throw new Error("请在模型设置中选择模型。");
    const { endpoint, model, credentialVariable } = settings;
    if (!endpoint) throw new Error("请填写完整的模型接口地址。");
    if (!model) throw new Error("此项不能为空。");
    if (!credentialVariable) throw new Error("请填写有效的环境变量名。");
    return { endpoint, model, credentialVariable };
}

module.exports = { modelPresets, modelPreset, getModelConnection };
