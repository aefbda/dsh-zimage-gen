/**
 * 把生成的图片下载并登记为 DSH 附件，使其能作为图片卡片渲染。
 *
 * 附件服务（`ctx.attachments`）只接受 png/jpeg/webp/gif，并会校验真实字节。
 * 拿不到附件服务或下载失败时返回 `{ image: null, error }`，由调用方降级为
 * 纯文本结果——图片卡片是增强，不能让生图整体失败。
 *
 * @module dsh-zimage-gen/image-attachment
 */

/** 允许的图片媒体类型（与 dsh-attachment 的 ImageMediaType 对齐）。 */
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * 从响应头或 URL 推断媒体类型。
 *
 * @param {string | null} contentType Content-Type 响应头。
 * @param {string} url 图片 URL。
 * @returns {string | undefined} 允许的媒体类型。
 */
export function resolveMediaType(contentType, url) {
  const header = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (ALLOWED_MEDIA_TYPES.has(header)) return header
  const pathname = String(url ?? '').split('?')[0].toLowerCase()
  if (pathname.endsWith('.png')) return 'image/png'
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg'
  if (pathname.endsWith('.webp')) return 'image/webp'
  if (pathname.endsWith('.gif')) return 'image/gif'
  return undefined
}

/**
 * 下载图片并登记为附件。
 *
 * @param {object} input 输入。
 * @param {object | undefined} input.attachments `ctx.attachments` 服务。
 * @param {string} input.url 图片 URL。
 * @param {string} [input.name] 附件展示名。
 * @param {number} [input.maxBytes] 最大字节数。
 * @param {number} [input.timeoutMs] 超时（毫秒）。
 * @param {AbortSignal} [input.signal] 取消信号。
 * @param {typeof fetch} [input.fetchImpl] fetch 实现（测试注入）。
 * @returns {Promise<{image: object | null, error?: string}>} 附件引用或失败原因。
 */
export async function attachGeneratedImage(input) {
  const {
    attachments,
    url,
    name,
    maxBytes = 8 * 1024 * 1024,
    timeoutMs = 60_000,
    signal,
    fetchImpl,
  } = input

  if (!attachments || typeof attachments.saveImage !== 'function') {
    return { image: null, error: '当前 profile 没有可用的 attachments 服务，结果只返回图片 URL。' }
  }
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    return { image: null, error: '当前运行环境没有可用的 fetch 实现，无法下载图片。' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('image download timeout')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const response = await doFetch(url, { signal: controller.signal })
    if (!response.ok) {
      return { image: null, error: `下载生成图片失败：HTTP ${response.status}` }
    }
    const mediaType = resolveMediaType(response.headers?.get?.('content-type'), url)
    if (!mediaType) {
      return { image: null, error: '下载到的内容不是受支持的图片类型（png/jpeg/webp/gif）。' }
    }
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength === 0) {
      return { image: null, error: '下载到的图片为空。' }
    }
    if (buffer.byteLength > maxBytes) {
      return {
        image: null,
        error: `下载到的图片 ${buffer.byteLength} 字节，超过上限 ${maxBytes} 字节，未登记为附件。`,
      }
    }
    const ref = await attachments.saveImage({
      data: buffer,
      mediaType,
      ...(name ? { name } : {}),
    })
    return { image: { ...ref } }
  } catch (error) {
    return {
      image: null,
      error: `登记图片附件失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
