import { resolveImageTarget, type ImageTargetDeps } from './imageTarget'

export type HtmlPasteImageRewriteOptions = {
  baseUrl?: string
  enabled?: boolean
  maxImages?: number
  maxBytes?: number
  timeoutMs?: number
  concurrency?: number
  forceLocal?: boolean
  onProgress?: (done: number, total: number) => void
}

export type HtmlPasteImageRewriteResult = {
  html: string
  total: number
  rewritten: number
}

export type MarkdownPasteImageRewriteResult = {
  markdown: string
  total: number
  rewritten: number
}

const DEFAULT_MAX_IMAGES = 50
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_CONCURRENCY = 4
const MARKDOWN_IMAGE_RE = /!\[[^\]]*]\(\s*(<([^>]+)>|([^\s)]+))([^)]*)\)/g

function isRemoteImageSrc(src: string): boolean {
  return /^https?:\/\//i.test(String(src || '').trim())
}

function isDataImageSrc(src: string): boolean {
  return /^data:image\//i.test(String(src || '').trim())
}

function isDownloadableImageSrc(src: string, baseUrl?: string): boolean {
  const raw = String(src || '').trim()
  if (isDataImageSrc(raw) || isRemoteImageSrc(raw)) return true
  if (!baseUrl) return false
  try {
    return /^https?:$/i.test(new URL(raw, baseUrl).protocol)
  } catch {
    return false
  }
}

function absolutize(src: string, baseUrl?: string): string {
  try {
    if (!baseUrl) return src
    return new URL(src, baseUrl).href
  } catch {
    return src
  }
}

function extFromMime(mime: string): string {
  const m = String(mime || '').toLowerCase()
  if (m.includes('jpeg')) return 'jpg'
  if (m.includes('png')) return 'png'
  if (m.includes('gif')) return 'gif'
  if (m.includes('webp')) return 'webp'
  if (m.includes('bmp')) return 'bmp'
  if (m.includes('avif')) return 'avif'
  if (m.includes('svg')) return 'svg'
  if (m.includes('x-icon') || m.includes('icon')) return 'ico'
  return 'png'
}

function safeFileNameFromPathLike(pathLike: string | null): string {
  let s = String(pathLike || '').trim()
  if (!s) return ''
  s = s.replace(/\\/g, '/')
  try { s = decodeURIComponent(s) } catch {}
  s = s.replace(/[?#].*$/, '')
  const base = s.split('/').filter(Boolean).pop() || ''
  if (!base || /^assets\.php$/i.test(base)) return ''
  return base
}

function guessNameFromUrl(url: string, index: number, mime?: string): string {
  try {
    const u = new URL(url)
    const fromPathParam =
      safeFileNameFromPathLike(u.searchParams.get('path')) ||
      safeFileNameFromPathLike(u.searchParams.get('file')) ||
      safeFileNameFromPathLike(u.searchParams.get('filename')) ||
      safeFileNameFromPathLike(u.searchParams.get('name'))
    if (fromPathParam) return sanitizeName(fromPathParam, mime)

    const fromPathname = safeFileNameFromPathLike(u.pathname || '')
    if (fromPathname && !/\.php$/i.test(fromPathname)) return sanitizeName(fromPathname, mime)
  } catch {}
  const idx = String(index + 1).padStart(3, '0')
  return `image-${idx}.${extFromMime(mime || '')}`
}

function sanitizeName(name: string, mime?: string): string {
  const safe = (String(name || '').trim() || 'image')
    .split(/[\\/]+/)
    .pop()!
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
  if (/\.[A-Za-z0-9]{2,8}$/.test(safe)) return safe
  return `${safe}.${extFromMime(mime || '')}`
}

function headerValue(headers: any, name: string): string {
  try {
    if (!headers) return ''
    if (typeof headers.get === 'function') {
      return String(headers.get(name) || headers.get(name.toLowerCase()) || '')
    }
    return String(headers[name] || headers[name.toLowerCase()] || '')
  } catch {
    return ''
  }
}

function bytesFromUnknownResponse(resp: any): Promise<Uint8Array> | Uint8Array {
  if (resp?.data instanceof Uint8Array) return resp.data
  if (Array.isArray(resp?.data)) return new Uint8Array(resp.data)
  if (resp?.arrayBuffer) {
    return resp.arrayBuffer().then((buf: ArrayBuffer) => new Uint8Array(buf || new ArrayBuffer(0)))
  }
  if (resp?.data && typeof resp.data === 'string') {
    const bin = String(resp.data)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i) & 0xff
    return arr
  }
  return new Uint8Array()
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('timeout')), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

async function fetchRemoteImageAsBlob(
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ blob: Blob; mime: string }> {
  const run = async () => {
    const { getHttpClient } = await import('../extensions/runtime')
    const http = await getHttpClient()
    if (http?.fetch) {
      const resp = await http.fetch(url, {
        method: 'GET',
        headers: { Accept: 'image/*;q=0.9,*/*;q=0.1' },
        responseType: http.ResponseType?.Binary,
      })
      const ok = resp && (resp.ok === true || (typeof resp.status === 'number' && resp.status >= 200 && resp.status < 300))
      if (!ok) throw new Error(`HTTP ${resp?.status || 0}`)
      const lenRaw = headerValue(resp.headers, 'content-length')
      const len = lenRaw ? Number(lenRaw) : 0
      if (Number.isFinite(len) && len > maxBytes) throw new Error('image too large')
      const bytes = await bytesFromUnknownResponse(resp)
      if (bytes.byteLength > maxBytes) throw new Error('image too large')
      const mimeRaw = headerValue(resp.headers, 'content-type').split(';')[0].trim()
      const mime = /^image\//i.test(mimeRaw) ? mimeRaw : ''
      return { blob: new Blob([bytes], { type: mime || 'application/octet-stream' }), mime }
    }

    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const browserTimer = ctrl ? window.setTimeout(() => ctrl.abort(), timeoutMs) : undefined
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'image/*;q=0.9,*/*;q=0.1' },
        signal: ctrl?.signal,
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const lenRaw = resp.headers.get('content-length') || ''
      const len = lenRaw ? Number(lenRaw) : 0
      if (Number.isFinite(len) && len > maxBytes) throw new Error('image too large')
      const buf = await resp.arrayBuffer()
      if (buf.byteLength > maxBytes) throw new Error('image too large')
      const mimeRaw = (resp.headers.get('content-type') || '').split(';')[0].trim()
      const mime = /^image\//i.test(mimeRaw) ? mimeRaw : ''
      return { blob: new Blob([buf], { type: mime || 'application/octet-stream' }), mime }
    } finally {
      if (browserTimer !== undefined) window.clearTimeout(browserTimer)
    }
  }
  return await withTimeout(run(), timeoutMs)
}

function dataImageToBlob(src: string, maxBytes: number): { blob: Blob; mime: string } | null {
  const m = String(src || '').match(/^data:(image\/[a-z0-9.+-]+)(;[^,]*)?,([\s\S]*)$/i)
  if (!m) return null
  const mime = m[1].toLowerCase()
  const meta = m[2] || ''
  const data = m[3] || ''
  let bytes: Uint8Array
  if (/;base64/i.test(meta)) {
    const bin = atob(data.replace(/\s+/g, ''))
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff
  } else {
    const decoded = decodeURIComponent(data)
    bytes = new TextEncoder().encode(decoded)
  }
  if (bytes.byteLength > maxBytes) throw new Error('image too large')
  return { blob: new Blob([bytes], { type: mime }), mime }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const safeLimit = Math.max(1, Math.min(limit || 1, items.length || 1))
  let idx = 0
  await Promise.all(Array.from({ length: safeLimit }, async () => {
    for (;;) {
      const i = idx++
      if (i >= items.length) return
      try { await fn(items[i], i) } catch {}
    }
  }))
}

export async function rewriteHtmlImagesByDownload(
  deps: ImageTargetDeps,
  html: string,
  opts: HtmlPasteImageRewriteOptions = {},
): Promise<HtmlPasteImageRewriteResult> {
  const srcHtml = String(html || '')
  if (!srcHtml || opts.enabled === false) return { html: srcHtml, total: 0, rewritten: 0 }

  const doc = new DOMParser().parseFromString(
    `<!doctype html><meta charset="utf-8"><div id="__flymd_root__">${srcHtml}</div>`,
    'text/html',
  )
  const root = doc.getElementById('__flymd_root__')
  if (!root) return { html: srcHtml, total: 0, rewritten: 0 }

  const maxImages = Math.max(1, opts.maxImages ?? DEFAULT_MAX_IMAGES)
  const maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES)
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)

  const imgs = Array.from(root.querySelectorAll('img[src]')) as HTMLImageElement[]
  const targets = imgs
    .map((img, order) => {
      const raw = img.getAttribute('src') || ''
      const src = isDataImageSrc(raw) ? raw : absolutize(raw, opts.baseUrl)
      return { img, raw, src, order }
    })
    .filter(({ src }) => isRemoteImageSrc(src) || isDataImageSrc(src))
    .slice(0, maxImages)

  const total = targets.length
  if (!total) return { html: root.innerHTML, total: 0, rewritten: 0 }
  try { opts.onProgress?.(0, total) } catch {}

  let done = 0
  let rewritten = 0
  const remoteCache = new Map<string, Promise<string | null>>()

  await runWithConcurrency(targets, concurrency, async ({ img, src, order }) => {
    try {
      let finalUrl: string | null = null
      if (isDataImageSrc(src)) {
        const data = dataImageToBlob(src, maxBytes)
        if (data) {
          const name = `image-${String(order + 1).padStart(3, '0')}.${extFromMime(data.mime)}`
          const target = await resolveImageTarget(deps, data.blob, name, data.mime, {
            forceLocal: opts.forceLocal !== false,
            preferRelative: true,
          })
          finalUrl = target?.url || null
        }
      } else {
        let promise = remoteCache.get(src)
        if (!promise) {
          promise = (async () => {
            const fetched = await fetchRemoteImageAsBlob(src, maxBytes, timeoutMs)
            const name = guessNameFromUrl(src, order, fetched.mime || '')
            const target = await resolveImageTarget(deps, fetched.blob, name, fetched.mime, {
              forceLocal: opts.forceLocal !== false,
              preferRelative: true,
            })
            return target?.url || null
          })().catch(() => null)
          remoteCache.set(src, promise)
        }
        finalUrl = await promise
      }
      if (finalUrl) {
        img.setAttribute('src', finalUrl)
        rewritten += 1
      }
    } catch {
      // 单张失败保留原 URL
    } finally {
      done += 1
      try { opts.onProgress?.(done, total) } catch {}
    }
  })

  return { html: root.innerHTML, total, rewritten }
}

export function hasDownloadableMarkdownImages(markdown: string, baseUrl?: string): boolean {
  try {
    const text = String(markdown || '')
    if (!text.includes('![')) return false
    MARKDOWN_IMAGE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = MARKDOWN_IMAGE_RE.exec(text)) !== null) {
      const raw = String(m[3] || m[4] || '').trim()
      if (raw && isDownloadableImageSrc(raw, baseUrl)) return true
    }
  } catch {}
  return false
}

export async function rewriteMarkdownImagesByDownload(
  deps: ImageTargetDeps,
  markdown: string,
  opts: HtmlPasteImageRewriteOptions = {},
): Promise<MarkdownPasteImageRewriteResult> {
  const srcText = String(markdown || '')
  if (!srcText || opts.enabled === false) return { markdown: srcText, total: 0, rewritten: 0 }

  const maxImages = Math.max(1, opts.maxImages ?? DEFAULT_MAX_IMAGES)
  const maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES)
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)

  const entries: Array<{ src: string; order: number }> = []
  const seen = new Set<string>()
  MARKDOWN_IMAGE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MARKDOWN_IMAGE_RE.exec(srcText)) !== null) {
    const raw = String(m[3] || m[4] || '').trim()
    if (!raw) continue
    const src = isDataImageSrc(raw) ? raw : absolutize(raw, opts.baseUrl)
    if (!isRemoteImageSrc(src) && !isDataImageSrc(src)) continue
    if (seen.has(src)) continue
    seen.add(src)
    entries.push({ src, order: entries.length })
    if (entries.length >= maxImages) break
  }

  const total = entries.length
  if (!total) return { markdown: srcText, total: 0, rewritten: 0 }
  try { opts.onProgress?.(0, total) } catch {}

  let done = 0
  const finalBySrc = new Map<string, string>()

  await runWithConcurrency(entries, concurrency, async ({ src, order }) => {
    try {
      let finalUrl: string | null = null
      if (isDataImageSrc(src)) {
        const data = dataImageToBlob(src, maxBytes)
        if (data) {
          const name = `image-${String(order + 1).padStart(3, '0')}.${extFromMime(data.mime)}`
          const target = await resolveImageTarget(deps, data.blob, name, data.mime, {
            forceLocal: opts.forceLocal !== false,
            preferRelative: true,
          })
          finalUrl = target?.url || null
        }
      } else {
        const fetched = await fetchRemoteImageAsBlob(src, maxBytes, timeoutMs)
        const name = guessNameFromUrl(src, order, fetched.mime || '')
        const target = await resolveImageTarget(deps, fetched.blob, name, fetched.mime, {
          forceLocal: opts.forceLocal !== false,
          preferRelative: true,
        })
        finalUrl = target?.url || null
      }
      if (finalUrl) finalBySrc.set(src, finalUrl)
    } catch {
      // 单张失败保留原 URL
    } finally {
      done += 1
      try { opts.onProgress?.(done, total) } catch {}
    }
  })

  let rewritten = 0
  MARKDOWN_IMAGE_RE.lastIndex = 0
  const result = srcText.replace(MARKDOWN_IMAGE_RE, (full, token, _angle, angleUrl, plainUrl) => {
    try {
      const raw = String(angleUrl || plainUrl || '').trim()
      const src = isDataImageSrc(raw) ? raw : absolutize(raw, opts.baseUrl)
      const finalUrl = finalBySrc.get(src)
      if (!finalUrl) return full
      rewritten += 1
      return String(full).replace(String(token), finalUrl)
    } catch {
      return full
    }
  })

  return { markdown: result, total, rewritten }
}
