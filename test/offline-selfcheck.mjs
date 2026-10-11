/**
 * dsh-zimage-gen 离线自检。
 *
 * 目的：在不访问任何网络、不消耗任何 API 额度的前提下，验证
 *   - 插件能被 `apply(ctx, config)` 正常装载，并注册两个工具；
 *   - 工具定义符合 DSH 的 register 契约（output.schema 走真实校验器；
 *     可用时用 dsh-tools 的 assertSupportedJsonSchema / validateJsonSchemaValue）；
 *   - Z-Image 请求体、size 校验、响应解析完全按文档形状工作；
 *   - 短提示词自动扩写走 ctx.llm 的 stream 契约，失败时安全回退；
 *   - 连续 3 次调用后 zimage_quota 的次数/费用统计正确（¥0.1 / ¥0.2 分档）。
 *
 * 真实的 HTTP 出站调用由 globalThis.fetch 桩替身接管，因此本文件可在没有
 * DASHSCOPE_API_KEY、没有外网的环境下运行：
 *
 *   node test/offline-selfcheck.mjs
 *
 * 可选环境变量：
 *   DSH_TOOLS_PATH  —— @deepseek-ai/dsh-tools/lib/index.js 的绝对路径，
 *                      用于启用“真实 JSON Schema 校验器”检查（默认会自动探测）。
 */

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_CREDENTIALS_PATH,
  parseIni,
  pickApiKey,
  resolveCredentials,
} from '../lib/credentials.js'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  buildRequestBody,
  parseGenerationResponse,
  parseSize,
} from '../lib/zimage-api.js'
import { QUOTA_FILE_VERSION, appendRecord, costFor, readQuota, summarize } from '../lib/quota.js'
import { expandHome } from '../lib/paths.js'
import {
  buildExpansionSystemPrompt,
  charLength,
  expandPrompt,
  resolveExpansionRoute,
  sanitizeExpandedPrompt,
  shouldExpand,
} from '../lib/prompt-expander.js'
import { attachGeneratedImage, resolveMediaType } from '../lib/image-attachment.js'
import { DEFAULT_CONFIG, apply, normalizeConfig } from '../index.js'
import { validateConfig } from '../lib/tools.js'

// ---------------------------------------------------------------- test runner

const results = []
let currentSuite = '(root)'

function suite(title) {
  currentSuite = title
}

async function test(title, fn) {
  try {
    await fn()
    results.push({ suite: currentSuite, title, ok: true })
    console.log(`  PASS  ${title}`)
  } catch (error) {
    results.push({ suite: currentSuite, title, ok: false, error })
    console.log(`  FAIL  ${title}`)
    console.log(`        ${error && error.message ? error.message.split('\n')[0] : String(error)}`)
  }
}

function heading(title) {
  console.log(`\n== ${title}`)
}

// ------------------------------------------------- 可选的真实 schema 校验器

const validatorCandidates = [
  process.env.DSH_TOOLS_PATH,
  process.env.APPDATA
    ? join(
        process.env.APPDATA,
        'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
      )
    : undefined,
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0)

let dshTools
for (const candidate of validatorCandidates) {
  try {
    dshTools = await import(pathToFileURL(candidate).href)
    break
  } catch {
    dshTools = undefined
  }
}

// ------------------------------------------------------------------- fixtures

/** 一个符合文档描述的 DashScope 成功响应。 */
function dashscopeSuccess(imageUrl = 'https://dashscope-result.oss-cn-beijing.aliyuncs.com/zimage/out.png') {
  return {
    output: {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: [{ image: imageUrl }, { text: '一只橘猫坐在窗台上，午后暖阳。' }],
          },
        },
      ],
      task_status: 'SUCCEEDED',
    },
    usage: { image_count: 1 },
    request_id: 'req-offline-selfcheck',
  }
}

/** 1x1 PNG（真实 PNG 魔数头，供附件桩做类型判断）。 */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
])

/** 记录所有出站请求的 fetch 桩；同时服务生图与图片下载两条路径。 */
function installFetchStub(options = {}) {
  const calls = []
  const pngBytes = options.pngBytes ?? TINY_PNG

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined })

    if (String(url) === DEFAULT_BASE_URL) {
      if (options.apiError) {
        return new Response(JSON.stringify(options.apiError.body), {
          status: options.apiError.status,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(dashscopeSuccess(options.imageUrl)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    if (options.imageError) {
      return new Response('boom', { status: options.imageError.status })
    }
    return new Response(pngBytes, {
      status: 200,
      headers: { 'content-type': options.imageContentType ?? 'image/png' },
    })
  }

  return {
    calls,
    restore() {
      delete globalThis.fetch
    },
  }
}

/** 记录 appendRecord 的桩（避免污染真实记录文件）。 */
function makeAttachmentsStub() {
  const saved = []
  return {
    saved,
    async saveImage(input) {
      saved.push(input)
      return {
        attachmentId: `att-${saved.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1024,
        height: 1024,
        ...(input.name ? { name: input.name } : {}),
      }
    },
  }
}

/** 一个按 DSH stream 契约产出的 LLM 桩。 */
function makeLlmStub(text) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const payload = text
      return (async function* chunks() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: payload }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

const LONG_EXPANSION =
  '主体：一只蜷坐在老式木窗台上的橘色虎斑猫，毛发蓬松柔软，胡须清晰。' +
  '场景：窗台外是虚化的梧桐树影与浅色居民楼，室内有木质窗框与素色棉麻窗帘。' +
  '构图：中景平视，主体位于画面右侧三分线，窗框形成自然边框，横构图。' +
  '光照：午后斜射的暖阳光线从侧后方打来，在毛发上形成金色轮廓光与柔和投影。' +
  '风格：写实摄影风格，浅景深，胶片颗粒细腻，色彩温暖低饱和。' +
  '约束：画面干净整洁，主体完整清晰，毛发细节丰富，中高品质摄影质感。'

/** 捕获 apply() 注册的工具定义（形状对齐 ctx.tools.register）。 */
function makeFakeCtx(services = {}) {
  const registered = []
  return {
    registered,
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    get(serviceName) {
      return services[serviceName]
    },
    effect(callback) {
      const disposer = callback()
      return disposer
    },
  }
}

// -------------------------------------------------------------- path helpers

let tempDir

async function main() {
  tempDir = await mkdtemp(join(tmpdir(), 'dsh-zimage-selfcheck-'))

  heading('1. size 解析与校验')
  suite('size')

  await test('接受 "1024*1024" 并归一化', () => {
    const parsed = parseSize('1024*1024')
    assert.equal(parsed.ok, true)
    assert.equal(parsed.size, '1024*1024')
    assert.equal(parsed.width, 1024)
  })

  await test('接受 "1280x720" / "720 × 1280" 并归一化为 *', () => {
    assert.equal(parseSize('1280x720').size, '1280*720')
    assert.equal(parseSize(' 720 × 1280 ').size, '720*1280')
  })

  await test('拒绝越界分辨率', () => {
    const parsed = parseSize('4096*4096')
    assert.equal(parsed.ok, false)
    assert.match(parsed.message, /超出支持范围/)
    assert.equal(parseSize('256*256').ok, false)
  })

  await test('拒绝非法格式', () => {
    assert.equal(parseSize('1024').ok, false)
    assert.equal(parseSize('abc*def').ok, false)
    assert.equal(parseSize('').ok, false)
    assert.equal(parseSize(undefined).ok, false)
  })

  heading('2. 请求体与响应解析（按文档契约）')
  suite('zimage-api')

  await test('请求体 = model + input.messages[0].content[0].text + parameters', () => {
    const body = buildRequestBody({
      prompt: '一只坐在窗台上的橘猫，午后阳光',
      size: '1024*1024',
      promptExtend: false,
      model: DEFAULT_MODEL,
    })
    assert.deepEqual(body, {
      model: 'z-image-turbo',
      input: { messages: [{ role: 'user', content: [{ text: '一只坐在窗台上的橘猫，午后阳光' }] }] },
      parameters: { size: '1024*1024', prompt_extend: false },
    })
  })

  await test('解析 output.choices[0].message.content 里的 image 与 text', () => {
    const parsed = parseGenerationResponse(dashscopeSuccess('https://example.com/a.png'))
    assert.equal(parsed.imageUrl, 'https://example.com/a.png')
    assert.equal(parsed.rewrittenPrompt, '一只橘猫坐在窗台上，午后暖阳。')
    assert.equal(parsed.requestId, 'req-offline-selfcheck')
    assert.equal(parsed.taskStatus, 'SUCCEEDED')
  })

  await test('兼容 output.results[].url 旧形状', () => {
    const parsed = parseGenerationResponse({ output: { results: [{ url: 'https://example.com/b.png' }] } })
    assert.equal(parsed.imageUrl, 'https://example.com/b.png')
  })

  await test('无图片 URL 时抛出可诊断错误', () => {
    assert.throws(() => parseGenerationResponse({ output: { choices: [] } }), /没有图片 URL/)
  })

  await test('JSON Schema 校验器可用性（可选）', () => {
    if (!dshTools) {
      console.log('        SKIP  未找到 dsh-tools，跳过真实校验器断言（可用 DSH_TOOLS_PATH 指定）')
      return
    }
    assert.equal(typeof dshTools.assertSupportedJsonSchema, 'function')
    assert.equal(typeof dshTools.validateJsonSchemaValue, 'function')
  })

  heading('3. 凭据解析')
  suite('credentials')

  await test('优先使用 DASHSCOPE_API_KEY', async () => {
    const resolved = await resolveCredentials({ env: { DASHSCOPE_API_KEY: 'sk-env' }, credentialsText: '' })
    assert.deepEqual(resolved, { ok: true, apiKey: 'sk-env', source: 'env:DASHSCOPE_API_KEY' })
  })

  await test('回退到 ~/.alibabacloud/credentials 的 [default] 段', async () => {
    const text = ['[default]', 'api_key = sk-file', '', '[other]', 'api_key = sk-other'].join('\n')
    const resolved = await resolveCredentials({ env: {}, credentialsText: text })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.apiKey, 'sk-file')
    assert.match(resolved.source, /credentials#default$/)
  })

  await test('支持 ZIMAGE_CREDENTIALS_PROFILE 指定段', async () => {
    const text = ['[default]', 'api_key = sk-default', '[bailian]', 'api_key = sk-bailian'].join('\n')
    const resolved = await resolveCredentials({
      env: { ZIMAGE_CREDENTIALS_PROFILE: 'bailian' },
      credentialsText: text,
    })
    assert.equal(resolved.apiKey, 'sk-bailian')
  })

  await test('只有 AK/SK 时给出明确提示而不是误用凭据', async () => {
    const text = ['[default]', 'access_key_id = LTAI-xxx', 'access_key_secret = yyy'].join('\n')
    const resolved = await resolveCredentials({ env: {}, credentialsText: text })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, 'AKSK_ONLY')
    assert.match(resolved.hint, /Bearer/)
  })

  await test('两者都没有时返回 NO_CREDENTIALS', async () => {
    const resolved = await resolveCredentials({
      env: {},
      credentialsPath: join(tempDir, 'nope', 'credentials'),
    })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, 'NO_CREDENTIALS')
    assert.match(resolved.hint, /DASHSCOPE_API_KEY/)
  })

  await test('credentialsFile 里的 ~ 会被展开（不是当成相对路径）', async () => {
    // '~' 展开后是主目录（存在但不可作为文件读取 → EISDIR/CREDENTIALS_UNREADABLE）；
    // 若不展开，readFile('~') 会得到 ENOENT → NO_CREDENTIALS。用这个差异证明展开了。
    const resolved = await resolveCredentials({ env: {}, credentialsPath: '~' })
    assert.equal(resolved.ok, false)
    assert.equal(resolved.reason, 'CREDENTIALS_UNREADABLE')
  })

  await test('INI 解析忽略注释与引号', () => {
    const sections = parseIni('# c\n[default]\n; c2\napi_key = "sk-quoted"\n')
    assert.equal(pickApiKey(sections.default), 'sk-quoted')
  })

  heading('4. 调用记录与配额统计')
  suite('quota')

  const quotaFile = join(tempDir, 'zimage-quota.json')

  await test('expandHome 展开 ~', () => {
    assert.equal(expandHome('~'), process.env.USERPROFILE ?? process.env.HOME)
    assert.match(expandHome('~/.dsh/zimage-quota.json'), /\.dsh[\\/]zimage-quota\.json$/)
  })

  await test('单价分档 ¥0.1 / ¥0.2', () => {
    assert.equal(costFor(false), 0.1)
    assert.equal(costFor(true), 0.2)
    assert.equal(costFor(false, { standard: 0.3 }), 0.3)
  })

  await test('appendRecord 建立文件并追加', async () => {
    await appendRecord(quotaFile, {
      timestamp: '2026-02-01T10:00:00.000Z',
      size: '1024*1024',
      promptExtend: false,
      cost: 0.1,
    })
    await appendRecord(quotaFile, {
      timestamp: '2026-02-02T10:00:00.000Z',
      size: '1280*720',
      promptExtend: true,
      cost: 0.2,
    })
    const raw = JSON.parse(await readFile(quotaFile, 'utf8'))
    assert.equal(raw.version, QUOTA_FILE_VERSION)
    assert.equal(raw.records.length, 2)
  })

  await test('并发 append 不丢记录', async () => {
    const concurrentFile = join(tempDir, 'concurrent.json')
    await Promise.all(
      Array.from({ length: 8 }, (_value, index) =>
        appendRecord(concurrentFile, {
          timestamp: new Date(Date.UTC(2026, 2, 1, 0, 0, index)).toISOString(),
          size: '1024*1024',
          promptExtend: index % 2 === 0,
          cost: index % 2 === 0 ? 0.1 : 0.2,
        }),
      ),
    )
    const { records } = await readQuota(concurrentFile)
    assert.equal(records.length, 8)
  })

  await test('summarize 统计次数、费用与最后一跳时间', async () => {
    const { records } = await readQuota(quotaFile)
    const summary = summarize(records)
    assert.equal(summary.totalCalls, 2)
    assert.equal(summary.standardCalls, 1)
    assert.equal(summary.thinkingCalls, 1)
    assert.equal(summary.totalCostCNY, 0.3)
    assert.equal(summary.lastCallAt, '2026-02-02T10:00:00.000Z')
    assert.equal(summary.remainingFreeQuota, null)
  })

  await test('since 过滤 + freeQuota 计算', async () => {
    const { records } = await readQuota(quotaFile)
    const summary = summarize(records, { since: '2026-02-02', freeQuota: 100 })
    assert.equal(summary.totalCalls, 1)
    assert.equal(summary.totalCostCNY, 0.2)
    assert.equal(summary.remainingFreeQuota, 99)
  })

  await test('损坏文件按空记录处理', async () => {
    const brokenFile = join(tempDir, 'broken.json')
    await appendRecord(brokenFile, {
      timestamp: '2026-02-01T10:00:00.000Z',
      size: '1024*1024',
      promptExtend: false,
      cost: 0.1,
    })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(brokenFile, '{ not json', 'utf8')
    let warned = ''
    const { records } = await readQuota(brokenFile, (message) => {
      warned = message
    })
    assert.equal(records.length, 0)
    assert.match(warned, /无法解析/)
  })

  heading('5. 提示词扩展')
  suite('prompt-expander')

  await test('阈值判断按字符数（含中文）', () => {
    assert.equal(charLength('一只坐在窗台上的橘猫，午后阳光'), 15)
    assert.equal(shouldExpand('一只坐在窗台上的橘猫，午后阳光', 30), true)
    assert.equal(shouldExpand('x'.repeat(30), 30), false)
    assert.equal(shouldExpand('x', 0), false)
  })

  await test('system 指令包含六段结构与肯定式约束要求', () => {
    const system = buildExpansionSystemPrompt({ min: 200, max: 600 })
    for (const keyword of ['主体', '场景', '构图', '光照', '风格', '约束', '200~600', 'negative prompt']) {
      assert.ok(system.includes(keyword), `system 缺少 ${keyword}`)
    }
  })

  await test('清理模型输出（代码围栏/引号/换行/前缀）', () => {
    assert.equal(sanitizeExpandedPrompt('```\n"提示词：一只猫"\n```'), '一只猫')
    assert.equal(sanitizeExpandedPrompt('扩写后的提示词：\n一只猫\n在窗台'), '一只猫 在窗台')
  })

  await test('resolveExpansionRoute 优先级：配置 > Agent > 默认', () => {
    assert.deepEqual(
      resolveExpansionRoute({
        config: { expandProvider: 'p', expandModel: 'm' },
        agentSelection: { provider: 'a', model: 'b' },
      }),
      { provider: 'p', model: 'm' },
    )
    assert.deepEqual(
      resolveExpansionRoute({
        config: {},
        agentSelection: { provider: 'a', model: 'b' },
        defaultSelection: () => ({ provider: 'c', model: 'd' }),
      }),
      { provider: 'a', model: 'b' },
    )
    assert.deepEqual(
      resolveExpansionRoute({ config: {}, defaultSelection: () => ({ provider: 'c', model: 'd' }) }),
      { provider: 'c', model: 'd' },
    )
    assert.equal(resolveExpansionRoute({ config: {} }), undefined)
  })

  await test('通过 llm.stream 组装扩写结果', async () => {
    const llm = makeLlmStub(LONG_EXPANSION)
    const expanded = await expandPrompt({
      llm,
      route: { provider: 'fake', model: 'fake-model' },
      prompt: '一只坐在窗台上的橘猫，午后阳光',
      bounds: { min: 200, max: 600 },
    })
    assert.equal(expanded.ok, true)
    assert.equal(expanded.prompt, LONG_EXPANSION)
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].provider, 'fake')
    assert.match(llm.calls[0].messages[0].content[0].text, /一只坐在窗台上的橘猫/)
    assert.equal(llm.calls[0].messages[0].role, 'user')
  })

  await test('缺少 llm 服务 / 无路由时安全降级', async () => {
    const noLlm = await expandPrompt({
      llm: undefined,
      route: { provider: 'p', model: 'm' },
      prompt: 'x',
      bounds: { min: 200, max: 600 },
    })
    assert.equal(noLlm.ok, false)
    assert.match(noLlm.error, /llm 服务/)
    const noRoute = await expandPrompt({
      llm: makeLlmStub(LONG_EXPANSION),
      route: undefined,
      prompt: 'x',
      bounds: { min: 200, max: 600 },
    })
    assert.equal(noRoute.ok, false)
    assert.match(noRoute.error, /provider\/model/)
  })

  await test('LLM 抛错时安全降级', async () => {
    const failing = {
      stream() {
        throw new Error('boom')
      },
    }
    const expanded = await expandPrompt({
      llm: failing,
      route: { provider: 'p', model: 'm' },
      prompt: 'x',
      bounds: { min: 200, max: 600 },
    })
    assert.equal(expanded.ok, false)
    assert.match(expanded.error, /boom/)
  })

  heading('6. 图片附件')
  suite('image-attachment')

  await test('媒体类型推断', () => {
    assert.equal(resolveMediaType('image/png; charset=binary', 'https://x/y'), 'image/png')
    assert.equal(resolveMediaType('application/octet-stream', 'https://x/y.JPEG'), 'image/jpeg')
    assert.equal(resolveMediaType('text/html', 'https://x/y'), undefined)
  })

  await test('下载成功时返回附件引用', async () => {
    const stub = installFetchStub()
    try {
      const attachments = makeAttachmentsStub()
      const attached = await attachGeneratedImage({
        attachments,
        url: 'https://oss.example.com/a.png',
        name: 'a.png',
      })
      assert.ok(attached.image)
      assert.equal(attached.image.attachmentId, 'att-1')
      assert.equal(attachments.saved[0].mediaType, 'image/png')
    } finally {
      stub.restore()
    }
  })

  await test('没有 attachments 服务时降级为 URL', async () => {
    const attached = await attachGeneratedImage({ attachments: undefined, url: 'https://x/a.png' })
    assert.equal(attached.image, null)
    assert.match(attached.error, /attachments 服务/)
  })

  await test('下载失败时降级', async () => {
    const stub = installFetchStub({ imageError: { status: 403 } })
    try {
      const attached = await attachGeneratedImage({
        attachments: makeAttachmentsStub(),
        url: 'https://oss.example.com/a.png',
      })
      assert.equal(attached.image, null)
      assert.match(attached.error, /HTTP 403/)
    } finally {
      stub.restore()
    }
  })

  heading('7. 插件装载与工具定义契约')
  suite('plugin')

  await test('normalizeConfig 补齐默认值并纠正类型', () => {
    const config = normalizeConfig({ autoExpandBelow: '40', downloadImages: 'false', baseUrl: 123, priceStandard: 0.15 })
    assert.equal(config.autoExpandBelow, 40)
    assert.equal(config.downloadImages, false)
    assert.equal(config.baseUrl, DEFAULT_CONFIG.baseUrl)
    assert.equal(config.priceStandard, 0.15)
  })

  await test('normalizeConfig 支持 ZIMAGE_CREDENTIALS_FILE 环境变量覆盖', () => {
    process.env.ZIMAGE_CREDENTIALS_FILE = 'D:/tmp/zimage-credentials'
    try {
      assert.equal(normalizeConfig({}).credentialsFile, 'D:/tmp/zimage-credentials')
    } finally {
      delete process.env.ZIMAGE_CREDENTIALS_FILE
    }
    assert.equal(normalizeConfig({}).credentialsFile, DEFAULT_CONFIG.credentialsFile)
  })

  const fakeCtx = makeFakeCtx({})
  apply(fakeCtx, {})
  const generateTool = fakeCtx.registered.find((tool) => tool.name === 'zimage_generate')
  const quotaTool = fakeCtx.registered.find((tool) => tool.name === 'zimage_quota')

  await test('apply() 注册 zimage_generate 与 zimage_quota', () => {
    assert.equal(fakeCtx.registered.length, 2)
    assert.ok(generateTool)
    assert.ok(quotaTool)
  })

  await test('工具声明 name / description / parameters / output.schema / render / execute', () => {
    for (const tool of [generateTool, quotaTool]) {
      assert.equal(typeof tool.name, 'string')
      assert.ok(tool.description.length > 20)
      assert.equal(tool.parameters.type, 'object')
      assert.equal(typeof tool.parameters.properties, 'object')
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.schema, 'object')
    }
    assert.deepEqual(generateTool.parameters.required, ['prompt'])
    assert.equal(generateTool.parameters.properties.size.default, '1024*1024')
    assert.equal(generateTool.parameters.properties.prompt_extend.default, false)
    assert.deepEqual(quotaTool.parameters.properties.since.type, 'string')
    assert.equal(quotaTool.parameters.required, undefined)
  })

  await test('output.schema 通过 DSH 真实 JSON Schema 校验器', () => {
    if (!dshTools) {
      console.log('        SKIP  dsh-tools 不可用')
      return
    }
    dshTools.assertSupportedJsonSchema(generateTool.output.schema)
    dshTools.assertSupportedJsonSchema(quotaTool.output.schema)
  })

  await test('render 是纯函数且对 null 图片也安全', () => {
    const blocks = generateTool.output.render({}, {
      imageUrl: 'https://x/a.png',
      rewrittenPrompt: '',
      finalPrompt: 'p',
      promptExpanded: false,
      size: '1024*1024',
      promptExtend: false,
      timestamp: '2026-02-01T00:00:00.000Z',
      costCNY: 0.1,
      durationMs: 1200,
      requestId: null,
      image: null,
      notes: [],
    })
    assert.equal(blocks[0].type, 'text')
    assert.ok(blocks[0].text.includes('https://x/a.png'))
    const quotaBlocks = quotaTool.output.render({}, {
      totalCalls: 0,
      totalCostCNY: 0,
      standardCalls: 0,
      thinkingCalls: 0,
      lastCallAt: null,
      remainingFreeQuota: null,
      since: null,
      quotaFile: quotaFile,
    })
    assert.equal(quotaBlocks.length, 1)
    assert.ok(quotaBlocks[0].text.includes('总次数：0 次'))
  })

  heading('8. 端到端离线联调：3 次生成 + 配额核对')
  suite('end-to-end')

  const e2eQuotaFile = join(tempDir, 'e2e-quota.json')
  const e2eImageUrl = 'https://dashscope-result.oss-cn-beijing.aliyuncs.com/zimage/e2e.png'
  const fetchStub = installFetchStub({ imageUrl: e2eImageUrl })
  const llmStub = makeLlmStub(LONG_EXPANSION)
  const attachmentsStub = makeAttachmentsStub()
  const e2eCtx = makeFakeCtx({ llm: llmStub, attachments: attachmentsStub })
  const savedApiKey = process.env.DASHSCOPE_API_KEY
  process.env.DASHSCOPE_API_KEY = 'sk-offline-selfcheck'
  apply(e2eCtx, { quotaFile: e2eQuotaFile, autoExpandBelow: 30, freeQuota: 10, imageTimeoutMs: 5_000 })

  const e2eGenerate = e2eCtx.registered.find((tool) => tool.name === 'zimage_generate')
  const e2eQuota = e2eCtx.registered.find((tool) => tool.name === 'zimage_quota')
  const exec = {
    signal: new AbortController().signal,
    agent: { options: { provider: 'fake', model: 'fake-model' } },
  }

  let call1
  let call2
  let call3

  await test('第 1 次：短提示词 → 自动扩写 → 出图 → 登记附件', async () => {
    call1 = await e2eGenerate.execute({ prompt: '一只坐在窗台上的橘猫，午后阳光' }, exec)
    assert.equal(call1.promptExpanded, true)
    assert.equal(call1.finalPrompt, LONG_EXPANSION)
    assert.equal(call1.size, '1024*1024')
    assert.equal(call1.promptExtend, false)
    assert.equal(call1.costCNY, 0.1)
    assert.equal(call1.imageUrl, e2eImageUrl)
    assert.equal(call1.rewrittenPrompt, '一只橘猫坐在窗台上，午后暖阳。')
    assert.ok(call1.image && call1.image.attachmentId)
    assert.equal(call1.notes.length, 0)

    const sent = fetchStub.calls.filter((call) => call.url === DEFAULT_BASE_URL).at(-1)
    assert.equal(sent.url, DEFAULT_BASE_URL)
    assert.equal(sent.init.method, 'POST')
    assert.equal(sent.init.headers.Authorization, 'Bearer sk-offline-selfcheck')
    assert.equal(sent.body.model, 'z-image-turbo')
    assert.equal(sent.body.input.messages[0].content[0].text, LONG_EXPANSION)
    assert.deepEqual(sent.body.parameters, { size: '1024*1024', prompt_extend: false })

    const blocks = e2eGenerate.output.render({}, call1)
    assert.equal(blocks[0].type, 'image')
    assert.equal(blocks[0].attachment.attachmentId, call1.image.attachmentId)
  })

  await test('第 2 次：长提示词不扩写 + prompt_extend 开启 → ¥0.2', async () => {
    call2 = await e2eGenerate.execute(
      { prompt: LONG_EXPANSION, size: '1280x720', prompt_extend: true },
      exec,
    )
    assert.equal(call2.promptExpanded, false)
    assert.equal(call2.finalPrompt, LONG_EXPANSION)
    assert.equal(call2.size, '1280*720')
    assert.equal(call2.promptExtend, true)
    assert.equal(call2.costCNY, 0.2)
    const sent = fetchStub.calls.filter((call) => call.url === DEFAULT_BASE_URL).at(-1)
    assert.deepEqual(sent.body.parameters, { size: '1280*720', prompt_extend: true })
  })

  await test('第 3 次：短提示词 + 默认参数', async () => {
    call3 = await e2eGenerate.execute({ prompt: '一只坐在窗台上的橘猫，午后阳光' }, exec)
    assert.equal(call3.promptExpanded, true)
    assert.equal(call3.promptExtend, false)
    assert.equal(call3.costCNY, 0.1)
    assert.equal(fetchStub.calls.filter((call) => call.url === DEFAULT_BASE_URL).length, 3)
  })

  await test('返回值通过 output.schema 的真实校验（含图片附件引用）', () => {
    if (!dshTools) {
      console.log('        SKIP  dsh-tools 不可用')
      return
    }
    for (const value of [call1, call2, call3]) {
      const violations = dshTools.validateJsonSchemaValue(e2eGenerate.output.schema, value, 'value')
      assert.deepEqual(violations, [])
    }
  })

  await test('zimage_quota 统计：3 次 / 标准 2 次 / 改写 1 次 / 合计 ¥0.4', async () => {
    const summary = await e2eQuota.execute({}, exec)
    assert.equal(summary.totalCalls, 3)
    assert.equal(summary.standardCalls, 2)
    assert.equal(summary.thinkingCalls, 1)
    assert.equal(summary.totalCostCNY, 0.4)
    assert.equal(summary.remainingFreeQuota, 7)
    assert.equal(summary.quotaFile, e2eQuotaFile)
    assert.equal(typeof summary.lastCallAt, 'string')

    if (dshTools) {
      const violations = dshTools.validateJsonSchemaValue(e2eQuota.output.schema, summary, 'value')
      assert.deepEqual(violations, [])
    }
  })

  await test('zimage_quota 的 since 过滤可用', async () => {
    const summary = await e2eQuota.execute({ since: new Date(Date.now() + 60_000).toISOString() }, exec)
    assert.equal(summary.totalCalls, 0)
    assert.equal(summary.totalCostCNY, 0)
    assert.equal(summary.lastCallAt, null)
  })

  await test('非法 since 被拒绝', async () => {
    await assert.rejects(() => e2eQuota.execute({ since: '不是日期' }, exec), /不是可解析的 ISO 日期/)
  })

  await test('缺少凭据时给出可执行错误（不发出请求）', async () => {
    delete process.env.DASHSCOPE_API_KEY
    const emptyCtx = makeFakeCtx({ llm: llmStub, attachments: attachmentsStub })
    apply(emptyCtx, {
      quotaFile: join(tempDir, 'never-written.json'),
      credentialsFile: join(tempDir, 'missing-credentials'),
      autoExpandBelow: 0,
    })
    const tool = emptyCtx.registered.find((entry) => entry.name === 'zimage_generate')
    const before = fetchStub.calls.length
    await assert.rejects(
      () => tool.execute({ prompt: LONG_EXPANSION }, exec),
      /DASHSCOPE_API_KEY|DASHSCOPE_API_KEY（百炼 API-KEY）/,
    )
    assert.equal(fetchStub.calls.length, before)
    process.env.DASHSCOPE_API_KEY = 'sk-offline-selfcheck'
  })

  await test('API 返回 401 时错误信息包含鉴权提示', async () => {
    const errorStub = installFetchStub({
      apiError: { status: 401, body: { code: 'InvalidApiKey', message: 'No API-key provided.', request_id: 'r1' } },
    })
    try {
      const ctx = makeFakeCtx({ llm: llmStub, attachments: attachmentsStub })
      apply(ctx, {
        quotaFile: join(tempDir, 'never-written-2.json'),
        autoExpandBelow: 0,
      })
      const tool = ctx.registered.find((entry) => entry.name === 'zimage_generate')
      await assert.rejects(() => tool.execute({ prompt: LONG_EXPANSION }, exec), /HTTP 401/)
      await assert.rejects(() => tool.execute({ prompt: LONG_EXPANSION }, exec), /API-KEY 无效/)
    } finally {
      errorStub.restore()
    }
  })

  await test('size 越界时在发请求前就报错', async () => {
    const before = fetchStub.calls.length
    await assert.rejects(() => e2eGenerate.execute({ prompt: LONG_EXPANSION, size: '4096*4096' }, exec), /超出支持范围/)
    assert.equal(fetchStub.calls.length, before)
  })

  heading('9. 包自洽性（开源发布前检查）')
  suite('package')

  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

  await test('零运行时依赖（无 dependencies / peerDependencies / optionalDependencies）', () => {
    assert.equal(packageJson.dependencies, undefined)
    assert.equal(packageJson.peerDependencies, undefined)
    assert.equal(packageJson.optionalDependencies, undefined)
  })

  await test('可发布：非 private，且有 author / test 脚本 / engines.node', () => {
    assert.notEqual(packageJson.private, true)
    assert.equal(typeof packageJson.author, 'string')
    assert.equal(typeof packageJson.scripts?.test, 'string')
    assert.equal(typeof packageJson.engines?.node, 'string')
  })

  await test('cordis.patch.yml 的插件行 name 与包名一致', () => {
    const match = /^\s*name:\s*'?([^'\s]+)'?\s*$/m.exec(patchText)
    assert.ok(match, 'cordis.patch.yml 里找不到 name 字段')
    assert.equal(match[1], packageJson.name)
  })

  await test('dsh.bundle.patch / main / icon / exports 指向的文件都存在', async () => {
    const targets = [
      packageJson.dsh?.bundle?.patch,
      packageJson.main,
      packageJson.icon,
      ...Object.values(packageJson.exports ?? {}),
    ]
    for (const target of targets) {
      if (typeof target !== 'string' || target.includes('*')) continue
      const info = await stat(new URL(`../${target.replace(/^\.\//, '')}`, import.meta.url))
      assert.ok(info.isFile(), `${target} 不存在`)
    }
  })

  await test('LICENSE 存在且与 package.json 的 license 字段一致', async () => {
    const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8')
    assert.match(license, /MIT License/)
    assert.equal(packageJson.license, 'MIT')
  })

  await test('files 覆盖全部运行期文件', () => {
    const files = packageJson.files ?? []
    for (const required of ['index.js', 'lib', 'locale', 'cordis.patch.yml', 'icon.svg']) {
      assert.ok(files.includes(required), `files 缺少 ${required}`)
    }
  })

  await test('repository / homepage / bugs 与包名保持一致（改名时不会漏改）', () => {
    const { repository, homepage, bugs } = packageJson
    assert.equal(repository?.type, 'git')
    assert.ok(
      repository.url.endsWith(`/${packageJson.name}.git`),
      `repository.url 未指向 ${packageJson.name}：${repository.url}`,
    )
    assert.ok(homepage.includes(`/${packageJson.name}`), `homepage 未指向 ${packageJson.name}`)
    assert.ok(bugs.includes(`/${packageJson.name}/issues`), `bugs 未指向 ${packageJson.name}`)
  })

  await test('validateConfig 能识别无效配置，且默认配置无告警', () => {
    assert.deepEqual(validateConfig(DEFAULT_CONFIG), [])
    const warnings = validateConfig({
      ...DEFAULT_CONFIG,
      defaultSize: '4096*4096',
      autoExpandBelow: -1,
      expandMinChars: 600,
      expandMaxChars: 200,
      priceStandard: -1,
    })
    assert.ok(warnings.some((w) => w.includes('defaultSize')), warnings.join(' / '))
    assert.ok(warnings.some((w) => w.includes('autoExpandBelow')))
    assert.ok(warnings.some((w) => w.includes('expandMinChars')))
    assert.ok(warnings.some((w) => w.includes('priceStandard')))
  })

  // ------------------------------------------------------------------ cleanup

  fetchStub.restore()
  if (savedApiKey === undefined) delete process.env.DASHSCOPE_API_KEY
  else process.env.DASHSCOPE_API_KEY = savedApiKey

  // ------------------------------------------------------------------- report

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${'-'.repeat(72)}`)
  console.log(`共 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (!dshTools) {
    console.log('提示：未加载 @deepseek-ai/dsh-tools，真实 Schema 校验项被跳过（设置 DSH_TOOLS_PATH 可启用）。')
  }
  if (failed.length > 0) {
    console.log('\n失败明细：')
    for (const result of failed) {
      console.log(`- [${result.suite}] ${result.title}`)
      console.log(`  ${result.error?.stack ?? result.error}`)
    }
  }

  await rm(tempDir, { recursive: true, force: true })
  process.exitCode = failed.length === 0 ? 0 : 1
}

await main()
