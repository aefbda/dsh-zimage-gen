/**
 * 调用记录持久化与配额统计。
 *
 * 记录文件（默认 `~/.dsh/zimage-quota.json`）：
 * ```json
 * {
 *   "version": 1,
 *   "records": [
 *     { "timestamp": "2026-02-01T08:00:00.000Z", "size": "1024*1024",
 *       "promptExtend": false, "cost": 0.1 }
 *   ]
 * }
 * ```
 *
 * 计费：prompt_extend=false 为 ¥0.1/张，=true 为 ¥0.2/张。金额内部按“分”累加，
 * 避免 0.1+0.2 这类浮点误差。
 *
 * @module dsh-zimage-gen/quota
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 默认记录文件路径。 */
export const DEFAULT_QUOTA_FILE = join(homedir(), '.dsh', 'zimage-quota.json')

/** 记录文件格式版本。 */
export const QUOTA_FILE_VERSION = 1

/** 标准出图单价（元/张，prompt_extend=false）。 */
export const PRICE_STANDARD_CNY = 0.1

/** 开启提示词改写的单价（元/张，prompt_extend=true）。 */
export const PRICE_EXTENDED_CNY = 0.2

/**
 * 计算单张图片的费用（元）。
 *
 * @param {boolean} promptExtend 是否开启提示词改写。
 * @param {{standard?: number, extended?: number}} [prices] 单价覆盖。
 * @returns {number} 费用（元）。
 */
export function costFor(promptExtend, prices = {}) {
  return promptExtend === true
    ? (prices.extended ?? PRICE_EXTENDED_CNY)
    : (prices.standard ?? PRICE_STANDARD_CNY)
}

/**
 * 以“分”为单位计算单价，保证累加精确。
 *
 * @param {boolean} promptExtend 是否开启提示词改写。
 * @param {{standard?: number, extended?: number}} [prices] 单价覆盖。
 * @returns {number} 费用（分，整数）。
 */
function costCents(promptExtend, prices = {}) {
  return Math.round(costFor(promptExtend, prices) * 100)
}

/**
 * 读取记录文件；文件不存在或损坏时返回空记录集。
 *
 * @param {string} filePath 记录文件路径。
 * @param {(message: string) => void} [warn] 损坏时的告警回调。
 * @returns {Promise<{version: number, records: object[]}>} 记录集。
 */
export async function readQuota(filePath, warn) {
  try {
    const text = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(text)
    const records = Array.isArray(parsed?.records) ? parsed.records.filter((r) => r && typeof r === 'object') : []
    return { version: typeof parsed?.version === 'number' ? parsed.version : QUOTA_FILE_VERSION, records }
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) {
      if (error instanceof SyntaxError && typeof warn === 'function') {
        warn(`zimage 调用记录文件无法解析（将以空记录继续，并在下次写入时重建）：${filePath}`)
      }
      return { version: QUOTA_FILE_VERSION, records: [] }
    }
    throw error
  }
}

/** 串行化同一进程内的写入，避免并发 append 互相覆盖。 */
let writeChain = Promise.resolve()

/**
 * 追加一条调用记录（原子写：先写临时文件再 rename）。
 *
 * @param {string} filePath 记录文件路径。
 * @param {{timestamp: string, size: string, promptExtend: boolean, cost: number}} record 记录。
 * @param {(message: string) => void} [warn] 告警回调。
 * @returns {Promise<void>} 写入完成。
 */
export function appendRecord(filePath, record, warn) {
  const task = writeChain.then(async () => {
    const current = await readQuota(filePath, warn)
    current.records.push(record)
    const payload = JSON.stringify({ version: QUOTA_FILE_VERSION, records: current.records }, null, 2)
    await mkdir(dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await writeFile(tempPath, `${payload}\n`, 'utf8')
    await rename(tempPath, filePath)
  })
  // 无论成败都要让后续写入继续排队。
  writeChain = task.catch(() => {})
  return task
}

/**
 * 统计调用次数与费用。
 *
 * @param {object[]} records 记录数组。
 * @param {{since?: string | null, prices?: {standard?: number, extended?: number}, freeQuota?: number}} [options] 统计选项。
 * @returns {{
 *   totalCalls: number, totalCostCNY: number, standardCalls: number, thinkingCalls: number,
 *   lastCallAt: string | null, remainingFreeQuota: number | null, since: string | null
 * }}
 */
export function summarize(records, options = {}) {
  const { since = null, prices = {}, freeQuota = 0 } = options
  const sinceMs = since ? Date.parse(since) : Number.NaN
  const useSince = typeof since === 'string' && since.length > 0 && Number.isFinite(sinceMs)

  let totalCalls = 0
  let standardCalls = 0
  let thinkingCalls = 0
  let cents = 0
  let lastCallAt = null
  let lastCallMs = Number.NEGATIVE_INFINITY

  for (const record of records) {
    const timestamp = typeof record?.timestamp === 'string' ? record.timestamp : ''
    const recordMs = Date.parse(timestamp)
    if (useSince) {
      if (!Number.isFinite(recordMs) || recordMs < sinceMs) continue
    }
    const promptExtend = record?.promptExtend === true
    totalCalls += 1
    if (promptExtend) thinkingCalls += 1
    else standardCalls += 1
    cents += costCents(promptExtend, prices)
    if (Number.isFinite(recordMs) && recordMs > lastCallMs) {
      lastCallMs = recordMs
      lastCallAt = timestamp
    } else if (lastCallAt === null && timestamp.length > 0) {
      lastCallAt = timestamp
    }
  }

  const remaining = typeof freeQuota === 'number' && freeQuota > 0 ? Math.max(0, freeQuota - totalCalls) : null

  return {
    totalCalls,
    totalCostCNY: cents / 100,
    standardCalls,
    thinkingCalls,
    lastCallAt,
    remainingFreeQuota: remaining,
    since: useSince ? new Date(sinceMs).toISOString() : null,
  }
}
