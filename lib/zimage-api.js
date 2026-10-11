/**
 * Z-Image-Turbo（阿里云百炼）调用封装。
 *
 * 端点：POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 * 请求体：{"model":"z-image-turbo",
 *          "input":{"messages":[{"role":"user","content":[{"text":"<prompt>"}]}]},
 *          "parameters":{"size":"<宽>*<高>","prompt_extend":<bool>}}
 * 响应：output.choices[0].message.content 里含 image URL 与 text。
 *
 * 计费：prompt_extend=false ¥0.1/张，=true ¥0.2/张；速率限制 120 RPM。
 *
 * @module dsh-zimage-gen/zimage-api
 */

/** 默认端点。 */
export const DEFAULT_BASE_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

/** 默认模型 id。 */
export const DEFAULT_MODEL = 'z-image-turbo'

/** 文档给出的分辨率上下界（单边像素）。 */
export const MIN_SIDE = 512
export const MAX_SIDE = 2048

/**
 * 解析并校验 `宽*高` 形式的分辨率。
 *
 * 接受 `*`、`x`、`X`、`×` 作为分隔符，两侧允许空白；忽略首尾空白。
 *
 * @param {unknown} raw 用户/模型给出的分辨率。
 * @param {{min?: number, max?: number}} [bounds] 上下界覆盖。
 * @returns {{ok: true, width: number, height: number, size: string} | {ok: false, message: string}}
 */
export function parseSize(raw, bounds = {}) {
  const min = bounds.min ?? MIN_SIDE
  const max = bounds.max ?? MAX_SIDE
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, message: `size 必须是非空字符串，格式为 "宽*高"，例如 "1024*1024"。` }
  }
  const match = /^(\d{1,5})\s*[*xX×]\s*(\d{1,5})$/.exec(raw.trim())
  if (!match) {
    return {
      ok: false,
      message: `无法解析 size "${raw}"：格式必须是 "宽*高"（例如 "1024*1024"、"1280*720"）。`,
    }
  }
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, message: `size "${raw}" 的宽高必须是正整数。` }
  }
  if (width < min || width > max || height < min || height > max) {
    return {
      ok: false,
      message:
        `size "${raw}" 超出支持范围：单边必须在 ${min}~${max} 像素之间` +
        `（推荐 "1024*1024"、"1280*720"、"720*1280"）。`,
    }
  }
  return { ok: true, width, height, size: `${width}*${height}` }
}

/**
 * 组装 DashScope 请求体。
 *
 * @param {{prompt: string, size: string, promptExtend: boolean, model: string}} input 输入。
 * @returns {Record<string, unknown>} 请求体。
 */
export function buildRequestBody({ prompt, size, promptExtend, model }) {
  return {
    model,
    input: {
      messages: [
        {
          role: 'user',
          content: [{ text: prompt }],
        },
      ],
    },
    parameters: {
      size,
      prompt_extend: promptExtend === true,
    },
  }
}

/**
 * 从 `content` 数组的一个元素里提取图片 URL。
 *
 * DashScope 多模态返回可能是 `{image: url}`、`{image_url: url}` 或 `{url: url}`。
 *
 * @param {unknown} part content 元素。
 * @returns {string | undefined} 图片 URL。
 */
function pickImageUrl(part) {
  if (typeof part === 'string' && /^https?:\/\//i.test(part)) return part
  if (!part || typeof part !== 'object') return undefined
  for (const key of ['image', 'image_url', 'url', 'imageUrl']) {
    const value = part[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 从 `content` 数组的一个元素里提取文本。
 *
 * @param {unknown} part content 元素。
 * @returns {string | undefined} 文本。
 */
function pickText(part) {
  if (!part || typeof part !== 'object') return undefined
  const value = part.text
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 解析一次成功的生成响应。
 *
 * @param {unknown} payload 响应 JSON。
 * @returns {{imageUrl: string, rewrittenPrompt: string, requestId: string | undefined, taskStatus: string | undefined}}
 * @throws {Error} 当响应里找不到图片 URL。
 */
export function parseGenerationResponse(payload) {
  const body = payload && typeof payload === 'object' ? payload : {}
  const output = body.output && typeof body.output === 'object' ? body.output : {}
  const requestId = typeof body.request_id === 'string' ? body.request_id : undefined

  let imageUrl = ''
  let rewrittenPrompt = ''

  const choices = Array.isArray(output.choices) ? output.choices : []
  for (const choice of choices) {
    const message = choice && typeof choice === 'object' ? choice.message : undefined
    const content = message && typeof message === 'object' ? message.content : undefined
    const parts = Array.isArray(content) ? content : typeof content === 'string' ? [content] : []
    for (const part of parts) {
      if (!imageUrl) {
        const url = pickImageUrl(part)
        if (url) imageUrl = url
      }
      if (!rewrittenPrompt) {
        const text = pickText(part)
        if (text) rewrittenPrompt = text
      }
    }
  }

  // 兼容旧版 text2image 的 output.results[].url 形状。
  if (!imageUrl && Array.isArray(output.results)) {
    for (const result of output.results) {
      const url = pickImageUrl(result)
      if (url) {
        imageUrl = url
        break
      }
    }
  }

  if (!imageUrl) {
    const preview = JSON.stringify(payload ?? null)
    throw new Error(
      'Z-Image 响应里没有图片 URL。' +
        `request_id=${requestId ?? 'n/a'}，原始响应（最多 800 字符）：${
          preview.length > 800 ? `${preview.slice(0, 800)}…` : preview
        }`,
    )
  }

  const taskStatus = typeof output.task_status === 'string' ? output.task_status : undefined
  return { imageUrl, rewrittenPrompt, requestId, taskStatus }
}

/**
 * 把 HTTP 失败或业务错误整理成一条可执行的错误信息。
 *
 * @param {number} status HTTP 状态码。
 * @param {unknown} payload 响应体（已尽力解析为 JSON）。
 * @param {string} rawText 响应原文（解析失败时使用）。
 * @returns {Error} 错误对象。
 */
function toApiError(status, payload, rawText) {
  const body = payload && typeof payload === 'object' ? payload : {}
  const code = typeof body.code === 'string' ? body.code : undefined
  const message = typeof body.message === 'string' ? body.message : undefined
  const requestId = typeof body.request_id === 'string' ? body.request_id : undefined

  let hint = ''
  if (status === 401 || code === 'InvalidApiKey' || code === 'InvalidParameter.ApiKey') {
    hint = '（API-KEY 无效或未提供：请检查 DASHSCOPE_API_KEY 或 ~/.alibabacloud/credentials）'
  } else if (status === 429 || code === 'Throttling' || code === 'Throttling.RateQuota') {
    hint = '（触发限流：Z-Image 速率上限为 120 RPM，请稍后重试）'
  } else if (status === 400) {
    hint = '（请求被拒：常见原因是 size 超出 512×512~2048×2048，或提示词为空）'
  } else if (status >= 500) {
    hint = '（服务端错误：可稍后重试）'
  }

  const detail = message ?? (rawText.length > 0 ? rawText.slice(0, 500) : '(无响应体)')
  return new Error(
    `Z-Image 调用失败：HTTP ${status}${code ? ` code=${code}` : ''} - ${detail}${hint}` +
      (requestId ? ` [request_id=${requestId}]` : ''),
  )
}

/**
 * 调用 Z-Image-Turbo 生成一张图。
 *
 * @param {object} input 调用输入。
 * @param {string} input.apiKey DashScope API-KEY。
 * @param {string} input.baseUrl 端点。
 * @param {string} input.model 模型 id。
 * @param {string} input.prompt 最终提示词。
 * @param {string} input.size 归一化后的 `宽*高`。
 * @param {boolean} input.promptExtend 是否开启提示词改写。
 * @param {number} [input.timeoutMs] 超时（毫秒）。
 * @param {AbortSignal} [input.signal] 调用方取消信号。
 * @param {typeof fetch} [input.fetchImpl] fetch 实现（测试注入）。
 * @returns {Promise<{imageUrl: string, rewrittenPrompt: string, requestId: string | undefined, taskStatus: string | undefined, durationMs: number}>}
 */
export async function callZimage(input) {
  const {
    apiKey,
    baseUrl,
    model,
    prompt,
    size,
    promptExtend,
    timeoutMs = 120_000,
    signal,
    fetchImpl,
  } = input

  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new Error('当前运行环境没有可用的 fetch 实现，无法调用 Z-Image 接口。')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('zimage request timeout')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  const startedAt = Date.now()
  try {
    const response = await doFetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildRequestBody({ prompt, size, promptExtend, model })),
      signal: controller.signal,
    })

    const rawText = await response.text()
    let payload
    try {
      payload = JSON.parse(rawText)
    } catch {
      payload = undefined
    }

    if (!response.ok) throw toApiError(response.status, payload, rawText)
    if (payload && typeof payload === 'object' && typeof payload.code === 'string') {
      throw toApiError(response.status, payload, rawText)
    }

    const parsed = parseGenerationResponse(payload)
    return { ...parsed, durationMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
