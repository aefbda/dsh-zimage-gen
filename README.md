# dsh-zimage-gen

[![CI](https://github.com/aefbda/dsh-zimage-gen/actions/workflows/ci.yml/badge.svg)](https://github.com/aefbda/dsh-zimage-gen/actions/workflows/ci.yml)

DeepSeek Harness（DSH）工具插件：把阿里云百炼（DashScope）的 **Z-Image-Turbo** 文生图能力
做成两个 Host 工具，并在本地记账。

> **English** — A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) tool plugin
> that generates images with Alibaba Cloud Model Studio **Z-Image-Turbo** (`zimage_generate`) and
> tracks local call counts and cost (`zimage_quota`). Zero runtime dependencies, no build step.

| 工具 | 作用 |
|---|---|
| `zimage_generate` | 调用 Z-Image-Turbo 出图；提示词过短时先用当前会话的 DSH LLM 自动扩写；图片渲染成图片卡片 |
| `zimage_quota` | 读取本地调用记录，统计次数与费用（按 `prompt_extend` 分档 ¥0.1 / ¥0.2） |

- **零运行时依赖**：只用 `node:` 内置模块和 DSH 的 `ctx` 服务，没有 `dependencies`、没有构建
  步骤，指向源码目录就能装。
- **短提示词自动扩写**：提示词不足 30 字符时，用当前会话的 LLM 按「主体 → 场景 → 构图 → 光照
  → 风格 → 约束」补全；扩写失败只降级，不影响出图。
- **图片卡片**：生成的图片下载后登记为 DSH 附件，直接渲染在会话里（附件服务缺失时降级为 URL）。
- **本地记账**：每次成功出图追加一条记录，按两档价目统计次数与费用，金额按“分”累加避免浮点误差。

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | `>= 20`（用到全局 `fetch`） |
| DSH | `0.1.5-rc.x`（在 0.1.5-rc.3 上开发验证） |
| 凭据 | 一个百炼 **API-KEY**（不是 AccessKey ID/Secret，见 [鉴权](#鉴权)） |
| 网络 | 能访问 `dashscope.aliyuncs.com` 与返回图片的 OSS 域名 |

## 安装

插件是 bundle 形态：`package.json` 声明 `dsh.bundle.patch`，装进某个 profile 后其
`cordis.patch.yml` 会被合进该 profile 的层栈。因为零依赖、无构建，**指向源码目录即可**。

### CLI 可管理的 profile（`web`、`headless`、自定义 profile …）

```sh
git clone https://github.com/aefbda/dsh-zimage-gen.git
dsh plugin --profile web add ./dsh-zimage-gen
dsh --profile web --dump-config | grep zimage     # 确认出现 id: zimage-gen 层
```

装完后重启该 profile 的 host；新插件通常会被热加载，刷新页面即可。

### 桌面应用使用的 `desktop` profile

该 profile 由 Electron 应用独占，CLI 会拒绝管理
（`profile "desktop" is managed exclusively by the Electron application`），需要手工复刻
`dsh plugin` 做的两件事：用应用自带的 pnpm 装上，再把包名加进 `dsh.profile.bundles`。

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
$pnpm = "<DeepSeek Harness 安装目录>\resources\runtime\pnpm\bin\pnpm.cjs"
Copy-Item "$prof\package.json" "$prof\package.json.bak"      # 先备份
Push-Location $prof
& node $pnpm add "/path/to/dsh-zimage-gen"
Pop-Location
# 然后编辑 $prof\package.json，把 "dsh-zimage-gen" 追加进 dsh.profile.bundles
```

运行中的 host 会热加载新 bundle，一般无需重启。

## 鉴权

按顺序解析：

1. 环境变量 `DASHSCOPE_API_KEY`（百炼 API-KEY）；
2. `~/.alibabacloud/credentials`（INI）里的 `[default]` 段，字段名可以是
   `api_key` / `apikey` / `dashscope_api_key`；段名可用 `ZIMAGE_CREDENTIALS_PROFILE` 覆盖。

```ini
[default]
api_key = sk-xxxxxxxxxxxxxxxx
```

凭据是**每次调用时重新读取**的，所以改完文件不需要重启 host（环境变量才需要重启，因为进程只在
启动时继承一次）。

> **AK/SK 不可用。** 如果凭据段里只有 `access_key_id` / `access_key_secret`，插件会明确报错而不是
> 拿错凭据去发请求——Z-Image 走的是百炼多模态生成的 REST 端点，鉴权方式是
> `Authorization: Bearer <API-KEY>`，REST 端点不做 AK/SK 签名。

请求形状（与官方文档一致）：

```json
{
  "model": "z-image-turbo",
  "input": { "messages": [{ "role": "user", "content": [{ "text": "<prompt>" }] }] },
  "parameters": { "size": "<宽>*<高>", "prompt_extend": false }
}
```

## 配置

`cordis.patch.yml` 里的 `config` 可直接覆盖，省略即用默认值：

```yaml
- insert:
    - id: zimage-gen
      name: 'dsh-zimage-gen'
      config:
        defaultSize: '1024*1024'
        autoExpandBelow: 30
        downloadImages: true
```

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | DashScope 多模态生成端点 | 端点覆盖 |
| `model` | `z-image-turbo` | 模型 id |
| `defaultSize` | `1024*1024` | 未传 `size` 时的分辨率 |
| `credentialsFile` | `~/.alibabacloud/credentials` | 凭据文件（支持 `~` 展开） |
| `quotaFile` | `~/.dsh/zimage-quota.json` | 调用记录文件 |
| `autoExpandBelow` | `30` | 提示词短于该字符数时自动扩写；`0` 关闭 |
| `expandMinChars` / `expandMaxChars` | `200` / `600` | 扩写目标长度区间 |
| `expandProvider` / `expandModel` | 空 | 扩写模型路由覆盖；空则用当前 Agent 的模型选择 |
| `expandTimeoutMs` / `expandMaxTokens` | `60000` / `1024` | 扩写调用参数 |
| `requestTimeoutMs` | `120000` | 生图请求超时 |
| `downloadImages` | `true` | 是否把图片下载并登记为附件（`false` 只返回 URL） |
| `maxImageBytes` / `imageTimeoutMs` | `8388608` / `60000` | 附件登记限制 |
| `priceStandard` / `priceExtended` | `0.1` / `0.2` | 计价单价（元/张） |
| `freeQuota` | `0` | `>0` 时 `remainingFreeQuota` 才给出数字，否则为 `null`（未知） |

环境变量可覆盖关键项（这些需要 host 重启才可见）：`ZIMAGE_BASE_URL`、`ZIMAGE_MODEL`、
`ZIMAGE_QUOTA_FILE`、`ZIMAGE_CREDENTIALS_FILE`、`ZIMAGE_EXPAND_PROVIDER`、
`ZIMAGE_EXPAND_MODEL`、`ZIMAGE_CREDENTIALS_PROFILE`。

## 用法

```
zimage_generate(prompt="一只坐在窗台上的橘猫，午后阳光")        # 短提示词 → 自动扩写
zimage_generate(prompt="<长提示词>", size="1280x720")         # size 接受 * / x / ×
zimage_generate(prompt="<长提示词>", prompt_extend=true)      # 开启服务端改写（¥0.2）

zimage_quota()                                                # 全部记录
zimage_quota(since="2026-10-01")                              # 时间过滤
```

`zimage_generate` 返回：

```json
{
  "imageUrl": "https://.../out.png",
  "rewrittenPrompt": "响应里的 text 字段",
  "finalPrompt": "实际发给模型的提示词",
  "promptExpanded": true,
  "size": "1024*1024",
  "promptExtend": false,
  "timestamp": "2026-10-08T11:13:50.818Z",
  "costCNY": 0.1,
  "durationMs": 3889,
  "requestId": "…",
  "image": { "attachmentId": "…", "mediaType": "image/jpeg", "bytes": 137433, "width": 1024, "height": 1024 },
  "notes": []
}
```

`image` 为 `null` 表示附件登记失败（例如没有 `ctx.attachments`），此时只有 `imageUrl` 可用，
失败原因写在 `notes` 里。

`size` 的单边取值范围是 512~2048，推荐 `1024*1024`、`1280*720`、`720*1280`。

## 提示词优化

当 `prompt` 字符数 `< autoExpandBelow` 时，用**当前会话的 DSH LLM**（`ctx.llm.stream`）扩写：

- 顺序覆盖 **主体 → 场景 → 构图 → 光照 → 风格 → 约束**；
- 目标长度 200~600 字符；
- Z-Image-Turbo 不支持 negative prompt，因此 system 指令要求全部约束写成**肯定式语言**
  （例如「画面干净通透」而不是「不要模糊」）；
- 路由解析优先级：`expandProvider/expandModel` 配置 > 当前 Agent 的 `options.provider/model`
  > `ctx.agentDefaultModel.currentSelection()`；
- 任何失败（无 llm 服务、无路由、超时、模型报错、输出为空）都只记入 `notes` 并回退原始提示词，
  **不会让生图失败**。

## 计费与配额

每次 `zimage_generate` 成功后向 `quotaFile` 追加一条记录：

```json
{ "version": 1, "records": [
  { "timestamp": "2026-10-08T11:13:50.818Z", "size": "1024*1024", "promptExtend": false, "cost": 0.1 }
] }
```

写入采用「临时文件 + rename」的原子替换，并在进程内串行化以抵御并发调用。官方计价为
`prompt_extend=false` ¥0.1/张、`=true` ¥0.2/张，速率上限 120 RPM；官方调价时改
`priceStandard` / `priceExtended` 即可。

## 开发与测试

```sh
npm test        # 离线自检：58 项检查，不访问网络、不消耗任何 API 额度
npm run check   # node --check + npm test
```

自检用 `globalThis.fetch` 桩替身跑通完整的 `execute` 路径，覆盖：size 校验、请求体契约、
响应解析、凭据解析（含 AK/SK 拒绝路径）、配额持久化/统计/并发/`since` 过滤、扩写契约与降级、
附件登记与降级、插件装载与工具定义契约、**连续 3 次调用后的记账核对**，以及包自洽性
（零依赖、可发布字段、`cordis.patch.yml` 与包名一致、`repository` 与包名同步等）。

若本机装有 DSH，自检会额外用 `@deepseek-ai/dsh-tools` 的**真实**校验器
（`assertSupportedJsonSchema` / `validateJsonSchemaValue`）校验 `output.schema` 与返回值；
找不到时自动跳过，可用 `DSH_TOOLS_PATH` 显式指定
`…/@deepseek-ai/dsh-tools/lib/index.js`。CI 在 Node 20 / 22 / 24 上跑同样的检查。

### 目录结构

```
dsh-zimage-gen/
  package.json             声明 dsh.bundle.patch -> cordis.patch.yml；零 dependencies
  cordis.patch.yml         bundle patch：插入 id=zimage-gen 的插件行及其 config
  index.js                 插件入口：name / inject 导出 + apply(ctx, config)
  lib/credentials.js       DASHSCOPE_API_KEY / ~/.alibabacloud/credentials 解析
  lib/zimage-api.js        size 校验、请求体组装、响应解析、HTTP 错误归类
  lib/prompt-expander.js   短提示词自动扩写（ctx.llm.stream）
  lib/quota.js             调用记录持久化与统计（原子写 + 进程内串行化）
  lib/image-attachment.js  下载图片并登记为 DSH 附件
  lib/paths.js             ~ 展开等路径小工具
  lib/tools.js             两个工具的 definition（parameters / output.schema / render / execute）
  locale/{en,zh}.json      插件卡片显示文本
  icon.svg                 插件图标
  test/offline-selfcheck.mjs  离线自检
  .github/workflows/ci.yml CI
```

### 实测记录

在 DSH 桌面应用（`desktop` profile）里连续调用 3 次，结果与离线自检的预期完全一致：

| 次序 | 提示词 | size 入参 | prompt_extend | 本地扩写 | 耗时 | 计费 |
|---|---|---|---|---|---|---|
| 1 | 一只坐在窗台上的橘猫，午后阳光（15 字） | 默认 | false | ✅ 触发 | 3.9s | ¥0.1 |
| 2 | 一只柯基犬在雨后的青石板街道上奔跑…（40 字） | 默认 | true | ⏭ 未触发 | 22.3s | ¥0.2 |
| 3 | 雪山日出，云海翻涌（9 字） | `1280x720` | false | ✅ 触发 | 3.6s | ¥0.1 |

- `zimage_quota` 返回 `总次数 3 · 总费用 ¥0.4 · 标准 2 · 改写 1`，与逐条记录相加一致；
- `since` 过滤边界正确；三张图都以图片卡片渲染；`size` 分隔符 `x` 被归一化为 `*`。

## 设计说明与已知限制

- **零运行时依赖是刻意的**：只用 `node:` 内置模块和 `ctx` 服务，不 import 任何
  `@deepseek-ai/*` 包。profile 里安装的 bundle 运行时不保证能解析这些裸包名（社区插件同样只
  依赖 `ctx`），因此这里直接构造 `ctx.tools.register()` 需要的定义对象——形状与 `defineTool`
  的产物一致（`{ name, description, parameters, output: { schema, render }, execute }`），
  参数校验由 `lib/tools.js` 自己完成。自检里有一条断言守住这个约束。
- **未声明 `Config`**：声明 Config 需要 `@deepseek-ai/schemastery`，与零依赖冲突；配置在
  `normalizeConfig()` 里做默认值合并与类型纠正，`validateConfig()` 在加载时只告警不阻断。
- **`ctx.tools.register()` 不做参数校验**（那是 `defineTool` 的包装行为），所以插件自己校验
  形状与取值；模型传入非法参数会得到一条 `Error: …` 结果，而不会中断本轮对话。
- **图片卡片依赖 `ctx.attachments`**；该服务缺失或图片下载失败时降级为纯文本 + `imageUrl`。
  附件库中的对象是**归一化后的副本**（统一 JPEG、可能缩放、无扩展名），不是百炼返回的原始字节。
- **图片 URL 会过期**（OSS 签名链接），需要长期留存请用附件副本或自行转存。
- **`remainingFreeQuota`** 只有在配置了 `freeQuota > 0` 时才是数字，否则返回 `null`
  （百炼免费额度是账号维度、随活动变化，插件不猜测）。

## 许可证

[MIT](LICENSE)。变更记录见 [CHANGELOG.md](CHANGELOG.md)。
