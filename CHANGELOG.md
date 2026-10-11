# Changelog

本文件记录所有值得注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-08

首个版本。

### Added

- 工具 `zimage_generate`：调用阿里云百炼 Z-Image-Turbo 出图。
  - `parameters`：`prompt`（必填）、`size`（默认 `1024*1024`，接受 `*` / `x` / `×` 分隔符，
    单边 512~2048）、`prompt_extend`（默认 `false`）。
  - `output.render`：把结果渲染为图片卡片 + 概要文本；图片通过 `ctx.attachments`
    登记为 DSH 附件，附件服务缺失或下载失败时降级为纯文本 + URL。
  - 请求/解析严格对齐百炼多模态生成端点，
    对 401 / 429 / 400 / 5xx 分别给出可执行的错误提示。
- 工具 `zimage_quota`：统计调用次数与费用，支持 `since` 时间过滤，
  按 `prompt_extend` 分档计价（¥0.1 / ¥0.2），金额按“分”累加避免浮点误差，
  每张成功出图后向 `~/.dsh/zimage-quota.json` 原子追加一条记录。
- 短提示词自动扩写：`prompt` 少于 `autoExpandBelow`（默认 30）字符时，用当前会话的
  DSH LLM（`ctx.llm.stream`）按「主体 → 场景 → 构图 → 光照 → 风格 → 约束」扩写到
  200~600 字符；由于 Z-Image-Turbo 不支持 negative prompt，约束一律用肯定式语言表达。
  任何扩写失败都只记录到 `notes` 并回退原始提示词。
- 凭据解析：`DASHSCOPE_API_KEY` 环境变量优先，其次 `~/.alibabacloud/credentials`
  的 `[default]` 段（段名可用 `ZIMAGE_CREDENTIALS_PROFILE` 覆盖）；
  只有 AK/SK 时给出明确说明而不是误用凭据。
- 零运行时依赖：不使用任何 `dependencies` / `peerDependencies`，只用 `node:` 内置模块，
  无需构建步骤。
- 离线自检 `test/offline-selfcheck.mjs`：50 项检查，用 `fetch` 桩替身覆盖请求组装、
  响应解析、凭据、配额、扩写、附件与三个完整调用周期的记账核对。
