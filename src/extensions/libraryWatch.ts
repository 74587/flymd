import {
  watch,
  watchImmediate,
  type WatchEvent,
  type UnwatchFn,
} from '@tauri-apps/plugin-fs'

export type PluginWatchEventType =
  | 'any'
  | 'other'
  | 'access'
  | 'create'
  | 'modify'
  | 'remove'

export type PluginWatchEvent = {
  type: PluginWatchEventType
  kind: string
  // 绝对路径（原始事件返回）
  paths: string[]
  // 相对库根目录的路径（不在库内则为空字符串）
  relatives: string[]
  libraryRoot: string
  raw: WatchEvent
}

export type PluginWatchOptions = {
  recursive?: boolean
  // 为 true 时立即回调（无延迟）；为 false 时使用 debounce
  immediate?: boolean
  // immediate=false 时生效
  delayMs?: number
}

function isWindowsLikePath(p: string): boolean {
  try {
    return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
  } catch {
    return false
  }
}

function normalizeSlash(p: string): string {
  return String(p || '').replace(/[\\]+/g, '/')
}

function trimSlashes(p: string): string {
  return normalizeSlash(p).replace(/\/+$/, '')
}

function normalizeEventType(t: any): { type: PluginWatchEventType; kind: string } {
  try {
    if (t === 'any') return { type: 'any', kind: 'any' }
    if (t === 'other') return { type: 'other', kind: 'other' }
    if (t && typeof t === 'object') {
      if (t.access) return { type: 'access', kind: String(t.access.kind || 'any') }
      if (t.create) return { type: 'create', kind: String(t.create.kind || 'any') }
      if (t.modify) return { type: 'modify', kind: String(t.modify.kind || 'any') }
      if (t.remove) return { type: 'remove', kind: String(t.remove.kind || 'any') }
    }
  } catch {}
  return { type: 'other', kind: 'other' }
}

function toRelativePaths(libraryRoot: string, absPaths: string[]): string[] {
  const root = trimSlashes(libraryRoot)
  const win = isWindowsLikePath(root)
  const rootCmp = win ? root.toLowerCase() : root
  const prefix = rootCmp ? rootCmp + '/' : ''
  const out: string[] = []
  for (const p of absPaths || []) {
    const abs = trimSlashes(String(p || ''))
    const absCmp = win ? abs.toLowerCase() : abs
    if (absCmp === rootCmp) {
      out.push('')
      continue
    }
    if (prefix && absCmp.startsWith(prefix)) {
      out.push(abs.slice(root.length + 1))
      continue
    }
    out.push('')
  }
  return out
}

export async function watchPathsAbs(
  libraryRoot: string,
  pathsAbs: string[],
  cb: (ev: PluginWatchEvent) => void,
  opt?: PluginWatchOptions,
): Promise<UnwatchFn> {
  const immediate = opt?.immediate !== false
  const recursive = opt?.recursive !== false
  const delayMs =
    typeof opt?.delayMs === 'number' && Number.isFinite(opt.delayMs)
      ? Math.max(0, Math.floor(opt.delayMs))
      : 200

  const fn = async (event: WatchEvent) => {
    try {
      const raw = event || ({} as any)
      const paths = Array.isArray(raw.paths) ? raw.paths.map((x) => String(x || '')) : []
      const { type, kind } = normalizeEventType(raw.type as any)
      cb({
        type,
        kind,
        paths,
        relatives: toRelativePaths(libraryRoot, paths),
        libraryRoot,
        raw,
      })
    } catch {}
  }

  if (immediate) {
    return await watchImmediate(pathsAbs, fn, { recursive })
  }
  return await watch(pathsAbs, fn, { recursive, delayMs })
}

