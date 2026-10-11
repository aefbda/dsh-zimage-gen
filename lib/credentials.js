/**
 * DashScope 凭据解析（零依赖：只用 node: 内置模块）。
 *
 * 解析顺序：
 *   1. 环境变量 DASHSCOPE_API_KEY（百炼平台的 API-KEY，Bearer 鉴权）
 *   2. ~/.alibabacloud/credentials（INI 格式，默认取 [default] 段；
 *      可用 ZIMAGE_CREDENTIALS_PROFILE 指定段名）
 *
 * 说明：Z-Image 走的是百炼「多模态生成」REST 端点，鉴权方式是
 * `Authorization: Bearer <API-KEY>`。~/.alibabacloud/credentials 里如果只有
 * access_key_id / access_key_secret（AK/SK），那对应该端点是无法直接使用的
 * （REST 端点不做 AK/SK 签名），因此这里会给出明确的可执行提示，而不是
 * 用错误的凭据去发请求。
 *
 * @module dsh-zimage-gen/credentials
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expandHome } from './paths.js'

/** 默认的阿里云凭据文件路径。 */
export const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.alibabacloud', 'credentials')

/** 凭据文件里可被当作 DashScope API-KEY 使用的字段名（大小写不敏感）。 */
const API_KEY_FIELDS = [
  'api_key',
  'apikey',
  'dashscope_api_key',
  'dashscope_apikey',
  'bailian_api_key',
  'model_api_key',
]

/**
 * 解析一个最小 INI 文件：`[section]` 段、`key = value` 行、`#`/`;` 注释。
 *
 * @param {string} text 文件内容。
 * @returns {Record<string, Record<string, string>>} 段名 -> 键值对。
 */
export function parseIni(text) {
  const sections = {}
  let current = 'default'
  sections[current] = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[(.+?)\]$/.exec(line)
    if (section) {
      current = section[1].trim()
      if (!sections[current]) sections[current] = {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value.length > 0) sections[current][key] = value
  }
  return sections
}

/**
 * 从一个凭据段里挑选可用的 DashScope API-KEY。
 *
 * @param {Record<string, string>} section INI 段。
 * @returns {string | undefined} API-KEY，找不到时返回 undefined。
 */
export function pickApiKey(section) {
  if (!section) return undefined
  for (const field of API_KEY_FIELDS) {
    const value = section[field]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 解析本次调用可用的 DashScope 凭据。
 *
 * @param {object} [options] 测试注入点。
 * @param {Record<string, string | undefined>} [options.env] 环境变量表，默认 process.env。
 * @param {string} [options.credentialsPath] 凭据文件路径覆盖。
 * @param {string} [options.credentialsText] 直接给出凭据文件内容（跳过磁盘读取，测试用）。
 * @returns {Promise<{ok: true, apiKey: string, source: string} | {ok: false, reason: string, hint: string}>}
 */
export async function resolveCredentials(options = {}) {
  const env = options.env ?? process.env
  const envKey = typeof env.DASHSCOPE_API_KEY === 'string' ? env.DASHSCOPE_API_KEY.trim() : ''
  if (envKey.length > 0) {
    return { ok: true, apiKey: envKey, source: 'env:DASHSCOPE_API_KEY' }
  }

  const credentialsPath = expandHome(options.credentialsPath ?? DEFAULT_CREDENTIALS_PATH)
  let text = options.credentialsText
  if (text === undefined) {
    try {
      text = await readFile(credentialsPath, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {
          ok: false,
          reason: 'NO_CREDENTIALS',
          hint:
            '未找到任何 DashScope 凭据。请设置环境变量 DASHSCOPE_API_KEY（百炼 API-KEY），' +
            `或创建 ${credentialsPath} 并在 [default] 段写入 api_key。`,
        }
      }
      return {
        ok: false,
        reason: 'CREDENTIALS_UNREADABLE',
        hint: `读取 ${credentialsPath} 失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  const profile = (typeof env.ZIMAGE_CREDENTIALS_PROFILE === 'string' && env.ZIMAGE_CREDENTIALS_PROFILE.trim())
    || 'default'
  const sections = parseIni(text)
  const section = sections[profile] ?? sections.default
  const apiKey = pickApiKey(section)

  if (apiKey) {
    return { ok: true, apiKey, source: `file:${credentialsPath}#${profile}` }
  }

  const hasAkSk = Boolean(section && (section.access_key_id || section.access_key_secret))
  if (hasAkSk) {
    return {
      ok: false,
      reason: 'AKSK_ONLY',
      hint:
        `${credentialsPath} 的 [${profile}] 段只有 access_key_id/access_key_secret。` +
        'Z-Image 的百炼 REST 端点使用 Bearer API-KEY 鉴权，不能用 AK/SK 直接调用；' +
        '请在 [default] 段补一行 api_key = <百炼 API-KEY>，或改用环境变量 DASHSCOPE_API_KEY。',
    }
  }

  return {
    ok: false,
    reason: 'NO_API_KEY_IN_FILE',
    hint:
      `在 ${credentialsPath} 的 [${profile}] 段里找不到 api_key 字段。` +
      '请写入 api_key = <百炼 API-KEY>，或改用环境变量 DASHSCOPE_API_KEY。',
  }
}
