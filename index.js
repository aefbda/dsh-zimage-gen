/**
 * dsh-zimage-gen —— DeepSeek Harness 工具插件。
 *
 * 注册两个 Host 工具：
 *   - `zimage_generate`：调用阿里云百炼 Z-Image-Turbo 出图，短提示词先用
 *     当前会话的 DSH LLM 自动扩写，并把图片登记为附件以便渲染成图片卡片。
 *   - `zimage_quota`：读取本地调用记录，统计次数与费用。
 *
 * 设计约束（与 DSH 的 bundle/插件约定一致）：
 *   - 零运行时依赖，只用 `node:` 内置模块和 `ctx` 服务，因此不需要
 *     dependencies / peerDependencies / 构建步骤，也不会在 profile 里
 *     出现裸包名解析问题。
 *   - 所有副作用（工具注册）都通过 `ctx.effect(...)` 注册，返回 disposer，
 *     插件卸载时可回收。
 *
 * @module dsh-zimage-gen
 */

import { DEFAULT_CREDENTIALS_PATH } from './lib/credentials.js'
import {
  DEFAULT_QUOTA_FILE,
  PRICE_EXTENDED_CNY,
  PRICE_STANDARD_CNY,
} from './lib/quota.js'
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from './lib/zimage-api.js'
import { createGenerateTool, createQuotaTool, validateConfig } from './lib/tools.js'

/** cordis 插件名（与 cordis.patch.yml 里的 id 对应）。 */
export const name = 'zimage-gen'

/** 只依赖工具注册表；llm / attachments 等按可选服务使用。 */
export const inject = ['tools']

/** 默认配置；`cordis.patch.yml` 里 `config` 的字段按需覆盖。 */
export const DEFAULT_CONFIG = {
  /** DashScope 多模态生成端点。 */
  baseUrl: DEFAULT_BASE_URL,
  /** 模型 id。 */
  model: DEFAULT_MODEL,
  /** 未显式传 size 时使用的分辨率。 */
  defaultSize: '1024*1024',
  /** 凭据文件路径（DASHSCOPE_API_KEY 优先）。 */
  credentialsFile: DEFAULT_CREDENTIALS_PATH,
  /** 调用记录文件路径。 */
  quotaFile: DEFAULT_QUOTA_FILE,
  /** 提示词少于该字符数时自动扩写（0 表示关闭）。 */
  autoExpandBelow: 30,
  /** 扩写结果长度下界（字符）。 */
  expandMinChars: 200,
  /** 扩写结果长度上界（字符）。 */
  expandMaxChars: 600,
  /** 扩写用的 provider 覆盖（留空则用当前 Agent 的模型选择）。 */
  expandProvider: '',
  /** 扩写用的 model 覆盖。 */
  expandModel: '',
  /** 扩写调用超时（毫秒）。 */
  expandTimeoutMs: 60_000,
  /** 扩写输出 token 上限。 */
  expandMaxTokens: 1024,
  /** 生图请求超时（毫秒）。 */
  requestTimeoutMs: 120_000,
  /** 是否把生成的图片下载并登记为附件（false 时只返回 URL）。 */
  downloadImages: true,
  /** 图片附件大小上限（字节）。 */
  maxImageBytes: 8 * 1024 * 1024,
  /** 图片下载超时（毫秒）。 */
  imageTimeoutMs: 60_000,
  /** 标准单价（元/张，prompt_extend=false）。 */
  priceStandard: PRICE_STANDARD_CNY,
  /** 开启改写后的单价（元/张，prompt_extend=true）。 */
  priceExtended: PRICE_EXTENDED_CNY,
  /** 免费额度次数；>0 时 remainingFreeQuota 才给出数字。 */
  freeQuota: 0,
}

/**
 * 用默认值补齐并纠正配置。
 *
 * @param {unknown} raw patch 行里的 config。
 * @returns {typeof DEFAULT_CONFIG} 归一化配置。
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULT_CONFIG }

  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = source[key]
    if (value === undefined || value === null) continue
    const fallback = DEFAULT_CONFIG[key]
    if (typeof fallback === 'number') {
      const numeric = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(numeric)) config[key] = numeric
    } else if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') config[key] = value
      else if (value === 'true') config[key] = true
      else if (value === 'false') config[key] = false
    } else if (typeof value === 'string') {
      config[key] = value
    }
  }

  // 允许通过环境变量快速覆盖关键项（便于不同机器共用一份 patch）。
  const env = process.env
  if (typeof env.ZIMAGE_BASE_URL === 'string' && env.ZIMAGE_BASE_URL.trim()) {
    config.baseUrl = env.ZIMAGE_BASE_URL.trim()
  }
  if (typeof env.ZIMAGE_MODEL === 'string' && env.ZIMAGE_MODEL.trim()) {
    config.model = env.ZIMAGE_MODEL.trim()
  }
  if (typeof env.ZIMAGE_QUOTA_FILE === 'string' && env.ZIMAGE_QUOTA_FILE.trim()) {
    config.quotaFile = env.ZIMAGE_QUOTA_FILE.trim()
  }
  if (typeof env.ZIMAGE_CREDENTIALS_FILE === 'string' && env.ZIMAGE_CREDENTIALS_FILE.trim()) {
    config.credentialsFile = env.ZIMAGE_CREDENTIALS_FILE.trim()
  }
  if (typeof env.ZIMAGE_EXPAND_PROVIDER === 'string' && env.ZIMAGE_EXPAND_PROVIDER.trim()) {
    config.expandProvider = env.ZIMAGE_EXPAND_PROVIDER.trim()
  }
  if (typeof env.ZIMAGE_EXPAND_MODEL === 'string' && env.ZIMAGE_EXPAND_MODEL.trim()) {
    config.expandModel = env.ZIMAGE_EXPAND_MODEL.trim()
  }

  return config
}

/**
 * 构造一个永不抛出、且在缺少 logger 时静默的日志器。
 *
 * @param {object} ctx 插件 Context。
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}} 日志器。
 */
function createLogger(ctx) {
  const silent = { debug() {}, info() {}, warn() {}, error() {} }
  let sink
  try {
    sink = typeof ctx.logger === 'function' ? ctx.logger('dsh-zimage-gen') : ctx.logger
  } catch {
    sink = undefined
  }
  if (!sink) return silent
  const wrap = (level) => (message) => {
    try {
      const fn = sink[level]
      if (typeof fn === 'function') fn.call(sink, message)
    } catch {
      /* 日志失败不能影响工具调用。 */
    }
  }
  return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') }
}

/**
 * 插件入口。
 *
 * @param {object} ctx 插件 Context（已注入 `tools`）。
 * @param {unknown} rawConfig patch 行 config。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = createLogger(ctx)

  for (const warning of validateConfig(config)) log.warn(warning)

  ctx.effect(
    () => ctx.tools.register(createGenerateTool({ ctx, config, log })),
    'dsh-zimage-gen:zimage_generate',
  )
  ctx.effect(
    () => ctx.tools.register(createQuotaTool({ ctx, config, log })),
    'dsh-zimage-gen:zimage_quota',
  )

  log.info(`已注册工具 zimage_generate / zimage_quota（model=${config.model}）。`)
}
