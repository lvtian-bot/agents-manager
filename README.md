# 多 Agent 管理

面向同时使用多个 Agent 的人，管理可跨工具共享的用户指令及项目规范，并保留各项目自己的内容。配套提供 Obsidian 笔记总结和选区翻译。

| 命令 | 插件行为 |
| --- | --- |
| 分发与回收指令 | 比对源笔记、目标文件和上次同步记录，支持分发、回收及行级合并。 |
| AI 总结或翻译 | 有选区时翻译，未选中时总结当前笔记，预览后可替换或插入。 |

两项命令都由插件原生实现，快捷键可自行绑定。运行需要 Obsidian 桌面版，最低版本见 [manifest.json](manifest.json)。

## 安装

1. 从 [GitHub Releases](https://github.com/lvtian-bot/agents-manager/releases) 下载同一版本的 `main.js` 和 `manifest.json`。
2. 在知识库的 Obsidian 配置目录下创建 `plugins/agents-manager/`，放入这两个文件。配置目录默认为 `.obsidian`。
3. 重新打开 Obsidian，在「设置 → 第三方插件」启用「多 Agent 管理」。在插件设置中填写指令源和目标。使用总结或翻译时，配置模型接口、模型名称及凭据环境变量名。

## 开发入口

项目根目录执行 `npm ci` 安装依赖。使用 `npm test` 构建并运行隔离测试；使用 `npm run test:vault` 生成独立桌面测试库。单独构建使用 `npm run build`。测试和构建不需要真实模型凭据。

- [项目指令](AGENTS.md)
- [技术架构与模块索引](docs/技术架构.md)
- [当前待办](docs/TODO.md)与[版本归档](docs/TODO-ARCHIVE.md)
