/**
 * 短提示词自动扩展（使用当前会话的 DSH LLM）。
 *
 * 扩展规则：主体 → 场景 → 构图 → 光照 → 风格 → 约束。
 * - 结果长度控制在 200~600 字符。
 * - Z-Image-Turbo 不支持 negative prompt，因此约束必须写成肯定式语言
 *   （例如「画面干净、主体完整」而不是「不要模糊」）。
 *
 * 这里刻意不 import `@deepseek-ai/dsh-llm`：profile 里安装的 bundle 运行时
 * 不一定能解析到 dsh 安装目录下的裸包名，所以只用 ctx 服务 + 纯对象，
 * 与社区插件的做法一致。
 *
 * @module dsh-zimage-gen/prompt-expander
 */

import { randomUUID } from 'node:crypto'

/** 中文正文字符统计（按 Unicode 码位计数，避免 emoji/代理对偏大）。 */
export function charLength(text) {
  return [...String(text ?? '')].length
}

/**
 * 组装扩展用的 system 指令。
 *
 * @param {{min: number, max: number}} bounds 长度上下界。
 * @returns {string} system 文本。
 */
export function buildExpansionSystemPrompt(bounds) {
  return [
    '你是文生图提示词工程师，为 Z-Image-Turbo 这类中文文生图模型扩写提示词。',
    '把用户的简短想法扩写成一段可直接出图的中文提示词，按以下顺序覆盖六个方面：',
    '主体（外形、材质、动作）→ 场景（地点、环境细节）→ 构图（景别、视角、画面比例）→ 光照（光源、色温、氛围）→ 风格（摄影/插画/材质风格）→ 约束（画质与完整性要求）。',
    `长度控制在 ${bounds.min}~${bounds.max} 个字符之间。`,
    '该模型不支持 negative prompt，因此所有约束都必须用肯定式语言表达，',
    '例如写「画面干净、主体完整清晰」，不要写「不要模糊」「没有杂物」。',
    '只输出扩写后的提示词本身：不要解释、不要标题、不要 Markdown、不要引号、不要换行。',
  ].join('\n')
}

/**
 * 组装扩展用的用户消息文本。
 *
 * @param {string} prompt 原始提示词。
 * @param {{min: number, max: number}} bounds 长度上下界。
 * @returns {string} 用户消息文本。
 */
export function buildExpansionUserPrompt(prompt, bounds) {
  return `原始想法：${prompt}\n请扩写为 ${bounds.min}~${bounds.max} 字符的中文提示词。仅输出提示词正文。`
}

/**
 * 清理模型输出：去掉代码围栏、多余引号、换行，压平空白。
 *
 * @param {string} text 原始输出。
 * @returns {string} 清理后的提示词。
 */
export function sanitizeExpandedPrompt(text) {
  let value = String(text ?? '')
  value = value.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '')
  value = value.replace(/[\r\n]+/g, ' ')
  value = value.replace(/\s{2,}/g, ' ')
  value = value.trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('“') && value.endsWith('”')))
  ) {
    value = value.slice(1, -1).trim()
  }
  value = value.replace(/^(扩写后的?提示词|提示词|Prompt)\s*[:：]\s*/i, '')
  return value.trim()
}

/**
 * 从错误里提取一条可读信息。
 *
 * @param {unknown} error 错误。
 * @returns {string} 可读信息。
 */
function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 解析用于扩展的模型路由。
 *
 * 优先级：显式配置 > 当前 Agent 的模型选择 > 进程级默认模型选择。
 *
 * @param {object} input 输入。
 * @param {object} [input.config] 插件配置（expandProvider / expandModel）。
 * @param {{provider?: string, model?: string}} [input.agentSelection] 当前 Agent 的选择。
 * @param {() => ({provider?: string, model?: string} | undefined)} [input.defaultSelection] 默认选择读取器。
 * @returns {{provider: string, model: string} | undefined} 路由；无法确定时返回 undefined。
 */
export function resolveExpansionRoute({ config = {}, agentSelection, defaultSelection } = {}) {
  const fromConfig = {
    provider: typeof config.expandProvider === 'string' ? config.expandProvider.trim() : '',
    model: typeof config.expandModel === 'string' ? config.expandModel.trim() : '',
  }
  if (fromConfig.provider && fromConfig.model) return fromConfig

  const agent = agentSelection ?? {}
  const agentProvider = typeof agent.provider === 'string' ? agent.provider.trim() : ''
  const agentModel = typeof agent.model === 'string' ? agent.model.trim() : ''
  if (agentProvider && agentModel) {
    return {
      provider: fromConfig.provider || agentProvider,
      model: fromConfig.model || agentModel,
    }
  }

  let fallback
  try {
    fallback = typeof defaultSelection === 'function' ? defaultSelection() : undefined
  } catch {
    fallback = undefined
  }
  const fallbackProvider = typeof fallback?.provider === 'string' ? fallback.provider.trim() : ''
  const fallbackModel = typeof fallback?.model === 'string' ? fallback.model.trim() : ''
  if (fallbackProvider && fallbackModel) {
    return {
      provider: fromConfig.provider || fallbackProvider,
      model: fromConfig.model || fallbackModel,
    }
  }
  if (fromConfig.provider && fromConfig.model) return fromConfig
  return undefined
}

/**
 * 判断是否需要自动扩展。
 *
 * @param {string} prompt 原始提示词。
 * @param {number} threshold 触发阈值（字符数）。
 * @returns {boolean} 是否需要扩展。
 */
export function shouldExpand(prompt, threshold) {
  if (!(threshold > 0)) return false
  return charLength(prompt) < threshold
}

/**
 * 调用当前会话的 LLM 扩展提示词。
 *
 * 任何失败都会以 `{ ok: false }` 返回，由调用方回退到原始提示词——扩展是增强，
 * 不能让生图整体失败。
 *
 * @param {object} input 输入。
 * @param {object} input.llm `ctx.llm` 服务（含 stream 方法）。
 * @param {{provider: string, model: string}} input.route 模型路由。
 * @param {string} input.prompt 原始提示词。
 * @param {AbortSignal} [input.signal] 取消信号。
 * @param {{min: number, max: number}} input.bounds 长度上下界。
 * @param {number} [input.timeoutMs] 超时（毫秒）。
 * @param {number} [input.maxTokens] 输出 token 上限。
 * @returns {Promise<{ok: true, prompt: string, note?: string} | {ok: false, error: string}>} 扩展结果。
 */
export async function expandPrompt(input) {
  const {
    llm,
    route,
    prompt,
    signal,
    bounds,
    timeoutMs = 60_000,
    maxTokens = 1024,
  } = input

  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: '当前 profile 没有可用的 llm 服务（ctx.llm），已跳过错写扩展。' }
  }
  if (!route?.provider || !route?.model) {
    return { ok: false, error: '无法确定用于扩展的 provider/model，已跳过错写扩展。' }
  }

  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('prompt expansion timeout')), timeoutMs)

  try {
    const messages = [
      {
        id: `zimage-expand-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: buildExpansionUserPrompt(prompt, bounds) }],
        source: { kind: 'plugin', plugin: 'dsh-zimage-gen' },
      },
    ]

    let text = ''
    let finish
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      system: buildExpansionSystemPrompt(bounds),
      maxTokens,
      signal: controller.signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'finish') finish = chunk.reason
    }

    if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
      return { ok: false, error: `扩展调用未成功结束：${finish.failure?.message ?? finish.kind}` }
    }

    const expanded = sanitizeExpandedPrompt(text)
    if (expanded.length === 0) return { ok: false, error: '扩展模型没有返回文本，已回退到原始提示词。' }

    const length = charLength(expanded)
    let note
    if (length < bounds.min) {
      note = `扩展结果偏短（${length} < ${bounds.min} 字符），已按原样使用。`
    } else if (length > bounds.max) {
      note = `扩展结果偏长（${length} > ${bounds.max} 字符），已按原样使用。`
    }
    return note ? { ok: true, prompt: expanded, note } : { ok: true, prompt: expanded }
  } catch (error) {
    return { ok: false, error: `扩展调用异常：${describeError(error)}` }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
