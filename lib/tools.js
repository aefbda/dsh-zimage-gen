/**
 * 两个 Host 工具的定义：zimage_generate / zimage_quota。
 *
 * 这里直接构造 `ctx.tools.register()` 需要的定义对象，而不是 import
 * `defineTool`。原因：profile 里安装的 bundle 运行时不保证能解析到
 * `@deepseek-ai/dsh-tools` 这个裸包名（社区插件同样只依赖 ctx），所以插件
 * 保持零运行时依赖。形状与 `defineTool` 的产物一致：
 *   { name, description, parameters(原始 JSON Schema), output: { schema, render }, execute }
 * 参数校验由本文件自己完成（defineTool 的校验包装在这条路径上不存在）。
 *
 * @module dsh-zimage-gen/tools
 */

import { appendRecord, costFor, readQuota, summarize } from './quota.js'
import { expandHome } from './paths.js'
import { resolveCredentials } from './credentials.js'
import { attachGeneratedImage } from './image-attachment.js'
import { callZimage, parseSize } from './zimage-api.js'
import { expandPrompt, resolveExpansionRoute, shouldExpand } from './prompt-expander.js'

/** 可选图片附件引用的 JSON Schema 分支。 */
const IMAGE_REF_SCHEMA = {
  type: 'object',
  properties: {
    attachmentId: { type: 'string', description: '附件存储标识。' },
    mediaType: { type: 'string', description: '图片媒体类型。' },
    bytes: { type: 'integer', description: '字节数。' },
    width: { type: 'integer', description: '宽度（像素）。' },
    height: { type: 'integer', description: '高度（像素）。' },
    name: { type: 'string', description: '展示名。' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  additionalProperties: false,
}

/** 允许为 null 的字符串节点。 */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** 允许为 null 的数字节点。 */
const NULLABLE_NUMBER = { oneOf: [{ type: 'number' }, { type: 'null' }] }

/**
 * 把任意值裁剪成一段单行文本。
 *
 * @param {unknown} value 输入。
 * @param {number} max 最大字符数。
 * @returns {string} 单行文本。
 */
function oneLine(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return [...text].length > max ? `${[...text].slice(0, max).join('')}…` : text
}

/**
 * 创建 `zimage_generate` 工具定义。
 *
 * @param {object} deps 依赖。
 * @param {object} deps.ctx 插件 Context。
 * @param {object} deps.config 归一化后的插件配置。
 * @param {{warn: (m: string) => void, info: (m: string) => void, error: (m: string) => void}} deps.log 日志器。
 * @returns {object} 工具定义。
 */
export function createGenerateTool({ ctx, config, log }) {
  return {
    name: 'zimage_generate',
    description:
      '用阿里云百炼 Z-Image-Turbo 生成一张图片。提示词不足 ' +
      `${config.autoExpandBelow} 个字符时会先用当前会话的 DSH LLM 自动扩写。` +
      '返回图片 URL、改写后的提示词与计费信息；图片会以图片卡片呈现。' +
      `计费：prompt_extend=false 时 ¥${config.priceStandard}/张，开启时 ¥${config.priceExtended}/张。`,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '生图提示词（中文或英文）。少于阈值字符数时会自动扩写。',
        },
        size: {
          type: 'string',
          default: config.defaultSize,
          description:
            `分辨率，格式 "宽*高"，单边 512~2048。默认 "${config.defaultSize}"；` +
            '常用 "1024*1024"、"1280*720"、"720*1280"。',
        },
        prompt_extend: {
          type: 'boolean',
          default: false,
          description:
            `是否启用百炼服务端的提示词改写（prompt_extend）。默认 false（¥${config.priceStandard}/张），` +
            `开启后 ¥${config.priceExtended}/张。与本地短提示词自动扩写是两件事。`,
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          imageUrl: { type: 'string', description: '生成图片的临时下载 URL。' },
          rewrittenPrompt: {
            type: 'string',
            description: '响应里返回的 text 字段（服务端改写后的提示词）；为空字符串表示响应未包含。',
          },
          finalPrompt: { type: 'string', description: '实际发给 Z-Image 的提示词。' },
          promptExpanded: { type: 'boolean', description: '是否触发了本地短提示词自动扩写。' },
          size: { type: 'string', description: '归一化后的分辨率 "宽*高"。' },
          promptExtend: { type: 'boolean', description: '本次是否开启了服务端提示词改写。' },
          timestamp: { type: 'string', description: '调用完成时间（ISO 8601）。' },
          costCNY: { type: 'number', description: '本次调用费用（人民币元）。' },
          durationMs: { type: 'integer', description: '接口耗时（毫秒）。' },
          requestId: NULLABLE_STRING,
          image: {
            oneOf: [IMAGE_REF_SCHEMA, { type: 'null' }],
            description: '已登记的图片附件引用；为 null 时只能通过 imageUrl 访问。',
          },
          notes: {
            type: 'array',
            items: { type: 'string' },
            description: '非致命提示（扩写降级、附件登记失败等）。',
          },
        },
        required: [
          'imageUrl',
          'rewrittenPrompt',
          'finalPrompt',
          'promptExpanded',
          'size',
          'promptExtend',
          'timestamp',
          'costCNY',
          'durationMs',
          'requestId',
          'image',
          'notes',
        ],
        additionalProperties: false,
      },
      render(_args, value) {
        const blocks = []
        if (value && value.image && typeof value.image === 'object' && value.image.attachmentId) {
          blocks.push({ type: 'image', attachment: { ...value.image } })
        }
        const lines = [
          `Z-Image-Turbo 出图完成 · ${value.size} · ${value.promptExtend ? `服务端改写已开(¥${value.costCNY})` : `标准(¥${value.costCNY})`}`,
          `图片 URL：${value.imageUrl}`,
        ]
        if (value.promptExpanded) lines.push('已用 DSH LLM 自动扩写提示词。')
        if (value.rewrittenPrompt && value.rewrittenPrompt.length > 0) {
          lines.push(`响应 text：${oneLine(value.rewrittenPrompt, 400)}`)
        }
        lines.push(`实际提示词：${oneLine(value.finalPrompt, 600)}`)
        if (Array.isArray(value.notes) && value.notes.length > 0) {
          for (const note of value.notes) lines.push(`注意：${oneLine(note, 300)}`)
        }
        lines.push(`时间：${value.timestamp} · 耗时：${value.durationMs}ms`)
        blocks.push({ type: 'text', text: lines.join('\n') })
        return blocks
      },
    },
    isConcurrencySafe() {
      return false
    },
    async execute(args, exec) {
      const rawPrompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (rawPrompt.length === 0) throw new Error('prompt 不能为空。')

      const sizeInput = typeof args?.size === 'string' && args.size.trim().length > 0 ? args.size : config.defaultSize
      const parsedSize = parseSize(sizeInput)
      if (!parsedSize.ok) throw new Error(parsedSize.message)

      const promptExtend = args?.prompt_extend === true
      const notes = []

      const credentials = await resolveCredentials({
        env: process.env,
        credentialsPath: config.credentialsFile,
      })
      if (!credentials.ok) {
        throw new Error(`${credentials.hint}（原因：${credentials.reason}）`)
      }

      // 阶段三：短提示词用当前会话的 DSH LLM 自动扩写。
      let finalPrompt = rawPrompt
      let promptExpanded = false
      if (shouldExpand(rawPrompt, config.autoExpandBelow)) {
        const defaultSelectionSource = ctx.get('agentDefaultModel')
        const route = resolveExpansionRoute({
          config,
          agentSelection: exec?.agent?.options,
          defaultSelection: () =>
            typeof defaultSelectionSource?.currentSelection === 'function'
              ? defaultSelectionSource.currentSelection()
              : undefined,
        })
        const expanded = await expandPrompt({
          llm: ctx.get('llm'),
          route,
          prompt: rawPrompt,
          signal: exec?.signal,
          bounds: { min: config.expandMinChars, max: config.expandMaxChars },
          timeoutMs: config.expandTimeoutMs,
        })
        if (expanded.ok) {
          finalPrompt = expanded.prompt
          promptExpanded = true
          if (expanded.note) notes.push(expanded.note)
        } else {
          notes.push(expanded.error)
          log.warn(`提示词自动扩写已跳过：${expanded.error}`)
        }
      }

      const api = await callZimage({
        apiKey: credentials.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        prompt: finalPrompt,
        size: parsedSize.size,
        promptExtend,
        timeoutMs: config.requestTimeoutMs,
        signal: exec?.signal,
      })

      const timestamp = new Date().toISOString()
      const cost = costFor(promptExtend, {
        standard: config.priceStandard,
        extended: config.priceExtended,
      })

      const quotaFile = expandHome(config.quotaFile)
      try {
        await appendRecord(
          quotaFile,
          { timestamp, size: parsedSize.size, promptExtend, cost },
          (message) => log.warn(message),
        )
      } catch (error) {
        const message = `写入调用记录失败（不影响出图）：${error instanceof Error ? error.message : String(error)}`
        notes.push(message)
        log.warn(message)
      }

      let image = null
      if (config.downloadImages) {
        const attached = await attachGeneratedImage({
          attachments: ctx.get('attachments'),
          url: api.imageUrl,
          name: `zimage-${parsedSize.size.replace('*', 'x')}.png`,
          maxBytes: config.maxImageBytes,
          timeoutMs: config.imageTimeoutMs,
          signal: exec?.signal,
        })
        if (attached.image) image = attached.image
        else if (attached.error) {
          notes.push(attached.error)
          log.warn(attached.error)
        }
      }

      log.info(
        `zimage_generate ok: ${parsedSize.size} prompt_extend=${promptExtend} cost=¥${cost} ` +
          `duration=${api.durationMs}ms credential=${credentials.source}`,
      )

      return {
        imageUrl: api.imageUrl,
        rewrittenPrompt: api.rewrittenPrompt ?? '',
        finalPrompt,
        promptExpanded,
        size: parsedSize.size,
        promptExtend,
        timestamp,
        costCNY: cost,
        durationMs: api.durationMs,
        requestId: api.requestId ?? null,
        image,
        notes,
      }
    },
  }
}

/**
 * 创建 `zimage_quota` 工具定义。
 *
 * @param {object} deps 依赖。
 * @param {object} deps.ctx 插件 Context。
 * @param {object} deps.config 归一化后的插件配置。
 * @param {{warn: (m: string) => void, info: (m: string) => void, error: (m: string) => void}} deps.log 日志器。
 * @returns {object} 工具定义。
 */
export function createQuotaTool({ ctx, config, log }) {
  const quotaFile = expandHome(config.quotaFile)
  return {
    name: 'zimage_quota',
    description:
      '统计本机 Z-Image-Turbo 的调用次数与费用。读取本地记录文件 ' +
      `(${quotaFile})，按 prompt_extend 区分 ¥${config.priceStandard}/张 与 ¥${config.priceExtended}/张 计费。`,
    parameters: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: '可选。只统计该时间点（含）之后的调用，ISO 8601 日期或日期时间，例如 "2026-02-01"。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          totalCalls: { type: 'integer', description: '调用总次数。' },
          totalCostCNY: { type: 'number', description: '总费用（人民币元）。' },
          standardCalls: { type: 'integer', description: 'prompt_extend=false 的次数。' },
          thinkingCalls: { type: 'integer', description: 'prompt_extend=true 的次数。' },
          lastCallAt: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '最后一次调用时间。' },
          remainingFreeQuota: {
            oneOf: [{ type: 'number' }, { type: 'null' }],
            description: '剩余免费额度；未配置 freeQuota 时为 null（未知）。',
          },
          since: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '实际生效的起始时间。' },
          quotaFile: { type: 'string', description: '记录文件路径。' },
        },
        required: [
          'totalCalls',
          'totalCostCNY',
          'standardCalls',
          'thinkingCalls',
          'lastCallAt',
          'remainingFreeQuota',
          'since',
          'quotaFile',
        ],
        additionalProperties: false,
      },
      render(_args, value) {
        const free =
          value.remainingFreeQuota === null
            ? '未配置免费额度（freeQuota=0）'
            : `剩余 ${value.remainingFreeQuota} 次`
        return [
          {
            type: 'text',
            text: [
              `Z-Image 调用统计${value.since ? `（${value.since} 起）` : '（全部）'}`,
              `总次数：${value.totalCalls} 次 · 总费用：¥${value.totalCostCNY}`,
              `标准（prompt_extend=false）：${value.standardCalls} 次 · 改写（prompt_extend=true）：${value.thinkingCalls} 次`,
              `最后调用：${value.lastCallAt ?? '无记录'}`,
              `免费额度：${free}`,
              `记录文件：${value.quotaFile}`,
            ].join('\n'),
          },
        ]
      },
    },
    isConcurrencySafe() {
      return true
    },
    async execute(args) {
      const rawSince = typeof args?.since === 'string' ? args.since.trim() : ''
      if (rawSince.length > 0 && !Number.isFinite(Date.parse(rawSince))) {
        throw new Error(`since "${rawSince}" 不是可解析的 ISO 日期，例如 "2026-02-01" 或 "2026-02-01T00:00:00Z"。`)
      }

      const { records } = await readQuota(quotaFile, (message) => log.warn(message))
      const summary = summarize(records, {
        since: rawSince.length > 0 ? rawSince : null,
        prices: { standard: config.priceStandard, extended: config.priceExtended },
        freeQuota: config.freeQuota,
      })

      return { ...summary, quotaFile }
    },
  }
}

/**
 * 校验插件配置是否合理（启动时只告警，不阻断加载）。
 *
 * @param {object} config 归一化后的插件配置。
 * @returns {string[]} 告警列表；为空表示配置自洽。
 */
export function validateConfig(config) {
  const warnings = []
  if (!(config.expandMinChars > 0) || !(config.expandMaxChars >= config.expandMinChars)) {
    warnings.push('expandMinChars/expandMaxChars 配置不合理，扩写长度约束会被忽略。')
  }
  if (!(config.autoExpandBelow >= 0)) {
    warnings.push('autoExpandBelow 必须 >= 0（0 表示关闭短提示词自动扩写）。')
  }
  const defaultSize = parseSize(config.defaultSize)
  if (!defaultSize.ok) {
    warnings.push(`defaultSize 配置无效：${defaultSize.message}`)
  }
  for (const key of ['priceStandard', 'priceExtended']) {
    if (!(config[key] >= 0)) warnings.push(`${key} 必须是非负数字。`)
  }
  return warnings
}
