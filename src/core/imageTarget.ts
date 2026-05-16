import type { AnyUploaderConfig } from '../uploader/types'
import { uploadImageToCloud } from '../uploader/upload'
import { toDocRelativeImagePathIfInImages } from '../utils/localImageSrcResolve'

export type ImageTargetKind = 'local' | 'cloud'

export type ImageTargetResult = {
  url: string
  kind: ImageTargetKind
}

export type ImageTargetDeps = {
  getCurrentFilePath(): string | null
  isTauriRuntime(): boolean
  ensureDir(dir: string): Promise<void>
  exists(path: string): Promise<boolean>
  getDefaultPasteDir(): Promise<string | null>
  getUserPicturesDir(): Promise<string | null>
  getAlwaysSaveLocalImages(): Promise<boolean>
  getUploaderConfig(): Promise<AnyUploaderConfig | null>
  getTranscodePrefs(): Promise<{
    convertToWebp: boolean
    webpQuality: number
    saveLocalAsWebp: boolean
  }>
  writeBinaryFile(path: string, bytes: Uint8Array): Promise<void>
  transcodeToWebpIfNeeded(
    blob: Blob,
    fname: string,
    quality: number,
    opts: { skipAnimated: boolean }
  ): Promise<{ blob: Blob; fileName: string; type?: string }>
}

export type ResolveImageTargetOptions = {
  forceLocal?: boolean
  preferRelative?: boolean
}

function pathJoin(a: string, b: string): string {
  const sep = a.includes('\\') ? '\\' : '/'
  return a.replace(/[\\/]+$/, '') + sep + b.replace(/^[\\/]+/, '')
}

function needAngle(url: string): boolean {
  return /[\s()]/.test(url) || /^[a-zA-Z]:/.test(url) || /\\/.test(url)
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

function cleanFileName(name: string, mime?: string): string {
  const raw = String(name || '').split(/[\\/]+/).pop() || ''
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  const base = cleaned || 'image'
  if (/\.[a-z0-9]{1,8}$/i.test(base)) return base
  return `${base}.${extFromMime(mime || '')}`
}

async function uniquePath(
  deps: ImageTargetDeps,
  dir: string,
  fileName: string,
): Promise<string> {
  const safeName = cleanFileName(fileName)
  const dot = safeName.lastIndexOf('.')
  const stem = dot > 0 ? safeName.slice(0, dot) : safeName
  const ext = dot > 0 ? safeName.slice(dot) : ''
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? safeName : `${stem}-${i + 1}${ext}`
    const full = pathJoin(dir, name)
    try {
      if (!(await deps.exists(full))) return full
    } catch {
      return full
    }
  }
  return pathJoin(dir, `${stem}-${Date.now()}${ext || '.png'}`)
}

async function saveBlobLocally(
  deps: ImageTargetDeps,
  blob: Blob,
  fname: string,
): Promise<string | null> {
  const { saveLocalAsWebp, webpQuality } = await deps.getTranscodePrefs()
  let blobForSave: Blob = blob
  let nameForSave = cleanFileName(fname, (blob as any)?.type || '')

  try {
    if (saveLocalAsWebp) {
      const r = await deps.transcodeToWebpIfNeeded(blob, nameForSave, webpQuality, {
        skipAnimated: true,
      })
      blobForSave = r.blob
      nameForSave = cleanFileName(r.fileName, r.type || (blobForSave as any)?.type || '')
    }
  } catch {}

  const currentFilePath = deps.getCurrentFilePath()

  if (deps.isTauriRuntime() && currentFilePath) {
    try {
      const base = currentFilePath.replace(/[\\/][^\\/]*$/, '')
      const imgDir = pathJoin(base, 'images')
      await deps.ensureDir(imgDir)
      const dst = await uniquePath(deps, imgDir, nameForSave)
      const buf = new Uint8Array(await blobForSave.arrayBuffer())
      await deps.writeBinaryFile(dst, buf)
      return dst
    } catch {}
  }

  if (deps.isTauriRuntime() && !currentFilePath) {
    try {
      const dir = await deps.getDefaultPasteDir()
      if (dir) {
        const baseDir = dir.replace(/[\\/]+$/, '')
        await deps.ensureDir(baseDir)
        const dst = await uniquePath(deps, baseDir, nameForSave)
        const buf = new Uint8Array(await blobForSave.arrayBuffer())
        await deps.writeBinaryFile(dst, buf)
        return dst
      }
    } catch {}
  }

  if (deps.isTauriRuntime() && !currentFilePath) {
    try {
      const pic = await deps.getUserPicturesDir()
      if (pic) {
        const baseDir = pic.replace(/[\\/]+$/, '')
        await deps.ensureDir(baseDir)
        const dst = await uniquePath(deps, baseDir, nameForSave)
        const buf = new Uint8Array(await blobForSave.arrayBuffer())
        await deps.writeBinaryFile(dst, buf)
        return dst
      }
    } catch {}
  }

  return null
}

function localPathToMarkdownUrl(
  localPath: string,
  currentFilePath: string | null,
  preferRelative: boolean,
): string {
  if (preferRelative) {
    const rel = toDocRelativeImagePathIfInImages(localPath, currentFilePath)
    if (rel) return rel
  }
  return needAngle(localPath) ? `<${localPath}>` : localPath
}

export async function resolveImageTarget(
  deps: ImageTargetDeps,
  blob: Blob,
  fname: string,
  mime?: string,
  opts: ResolveImageTargetOptions = {},
): Promise<ImageTargetResult | null> {
  const forceLocal = !!opts.forceLocal
  const preferRelative = opts.preferRelative !== false
  const safeName = cleanFileName(fname, mime || (blob as any)?.type || '')

  let localPath: string | null = null
  let cloudUrl: string | null = null

  const alwaysLocal = await deps.getAlwaysSaveLocalImages()
  const upCfg = await deps.getUploaderConfig()
  const uploaderEnabled = !!(upCfg && (upCfg as any).enabled)

  if (forceLocal || !uploaderEnabled || alwaysLocal) {
    localPath = await saveBlobLocally(deps, blob, safeName)
  }

  if (!forceLocal && !localPath && uploaderEnabled && upCfg) {
    try {
      const { convertToWebp, webpQuality } = await deps.getTranscodePrefs()
      let blob2: Blob = blob
      let name2 = safeName
      let mime2 = mime || (blob as any)?.type || 'application/octet-stream'
      try {
        if (convertToWebp) {
          const r = await deps.transcodeToWebpIfNeeded(blob, safeName, webpQuality, {
            skipAnimated: true,
          })
          blob2 = r.blob
          name2 = cleanFileName(r.fileName, r.type || (blob2 as any)?.type || '')
          mime2 = r.type || 'image/webp'
        }
      } catch {}
      const res = await uploadImageToCloud(blob2, name2, mime2, upCfg)
      cloudUrl = res.publicUrl
    } catch {}
  }

  if (!forceLocal && !localPath && !cloudUrl && uploaderEnabled && !alwaysLocal) {
    localPath = await saveBlobLocally(deps, blob, safeName)
  }

  if (localPath) {
    return {
      kind: 'local',
      url: localPathToMarkdownUrl(localPath, deps.getCurrentFilePath(), preferRelative),
    }
  }

  if (cloudUrl) {
    return { kind: 'cloud', url: cloudUrl }
  }

  return null
}
