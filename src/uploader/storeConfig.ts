// 从 store.get('uploader') 的原始对象解析出可用配置
// 原则：默认 provider=s3，旧字段保持不变；仅在启用时做严格校验

import type { AnyUploaderConfig, ImgLaUploaderConfig, S3UploaderConfig, UploaderProvider } from './types'

const IMGLA_BASE_URL = 'https://www.imgla.net'

function normStr(v: unknown): string {
  return String(v ?? '').trim()
}

function normUrl(v: unknown): string {
  const s = normStr(v)
  return s.replace(/\/+$/, '')
}

function normNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const s = normStr(v)
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function getUploaderProviderFromRaw(raw: any): UploaderProvider {
  const p = normStr(raw?.provider).toLowerCase()
  if (p === 'imgla') return 'imgla'
  return 's3'
}

export function parseUploaderConfigEnabledOnly(raw: any): AnyUploaderConfig | null {
  if (!raw || typeof raw !== 'object') return null
  if (!raw.enabled) return null
  return parseUploaderConfigForManagement(raw, { enabledOnly: true })
}

export function parseUploaderConfigForManagement(
  raw: any,
  opts?: { enabledOnly?: boolean },
): AnyUploaderConfig | null {
  if (!raw || typeof raw !== 'object') return null

  const enabled = !!raw.enabled
  if (opts?.enabledOnly && !enabled) return null

  const provider = getUploaderProviderFromRaw(raw)
  const convertToWebp = !!raw.convertToWebp
  const webpQuality = (typeof raw.webpQuality === 'number' && Number.isFinite(raw.webpQuality)) ? raw.webpQuality : 0.85
  const saveLocalAsWebp = !!raw.saveLocalAsWebp

  if (provider === 'imgla') {
    // Lsky Pro+ 兼容：允许用户覆写 baseUrl（默认 ImgLa）
    const baseUrl = normUrl(raw.imglaBaseUrl ?? raw.baseUrl) || IMGLA_BASE_URL
    const token = normStr(raw.imglaToken ?? raw.token)
    const strategyId = normNum(raw.imglaStrategyId ?? raw.strategyId) ?? 1
    const albumId = normNum(raw.imglaAlbumId ?? raw.albumId) ?? undefined

    if (!token) return null

    const cfg: ImgLaUploaderConfig = {
      enabled,
      provider,
      baseUrl,
      token,
      strategyId,
      albumId,
      convertToWebp,
      webpQuality,
      saveLocalAsWebp,
    }
    return cfg
  }

  // 默认：S3/R2
  const accessKeyId = normStr(raw.accessKeyId)
  const secretAccessKey = normStr(raw.secretAccessKey)
  const bucket = normStr(raw.bucket)
  if (!accessKeyId || !secretAccessKey || !bucket) return null

  const cfg: S3UploaderConfig = {
    enabled,
    provider: 's3',
    accessKeyId,
    secretAccessKey,
    bucket,
    region: typeof raw.region === 'string' ? raw.region : undefined,
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : undefined,
    customDomain: typeof raw.customDomain === 'string' ? raw.customDomain : undefined,
    keyTemplate: typeof raw.keyTemplate === 'string' ? raw.keyTemplate : '{year}/{month}{fileName}{md5}.{extName}',
    aclPublicRead: raw.aclPublicRead !== false,
    forcePathStyle: raw.forcePathStyle !== false,
    convertToWebp,
    webpQuality,
    saveLocalAsWebp,
  }
  return cfg
}
