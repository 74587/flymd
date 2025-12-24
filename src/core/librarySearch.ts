// 库内搜索（MVP：文件名匹配）
// 说明：
// - 只做最小可用：按文件名（含相对路径）模糊匹配
// - 默认跳过 .flymd / .git / node_modules 等目录，避免把索引/缓存当成内容

import { readDir, stat } from '@tauri-apps/plugin-fs'

export type LibrarySearchResult = {
  path: string
  relative: string
  name: string
  mtime?: number
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

function normalizeRelative(root: string, abs: string): string {
  const r = trimSlashes(root)
  const a = trimSlashes(abs)
  const win = isWindowsLikePath(r)
  const rCmp = win ? r.toLowerCase() : r
  const aCmp = win ? a.toLowerCase() : a
  if (aCmp === rCmp) return ''
  const prefix = rCmp ? rCmp + '/' : ''
  if (prefix && aCmp.startsWith(prefix)) return a.slice(r.length + 1)
  return a
}

function joinPath(dir: string, name: string): string {
  const base = String(dir || '').replace(/[\\/]+$/, '')
  const sep = base.includes('\\') ? '\\' : '/'
  const n = String(name || '').replace(/^[/\\]+/, '')
  return base + sep + n
}

function shouldSkipDir(name: string, relDir: string): boolean {
  const n = String(name || '').trim()
  if (!n) return true
  if (n === '.' || n === '..') return true
  if (n === '.git' || n === 'node_modules') return true
  // flymd 内部目录：索引/缓存/元数据
  if (n === '.flymd') return true
  // 防御：任何层级出现 /.flymd/ 都跳过
  const rel = normalizeSlash(relDir)
  if (rel === '.flymd' || rel.startsWith('.flymd/')) return true
  return false
}

export async function searchLibraryFilesByName(
  libraryRoot: string,
  termRaw: string,
  opt?: {
    maxResults?: number
    maxDepth?: number
    extensions?: string[]
  },
): Promise<LibrarySearchResult[]> {
  const root = String(libraryRoot || '').trim()
  const term = String(termRaw || '').trim()
  if (!root || !term) return []

  const termLower = term.toLowerCase()
  const allow = new Set(
    (opt?.extensions || ['md', 'markdown', 'txt', 'pdf'])
      .map((x) => String(x || '').replace(/^\./, '').toLowerCase())
      .filter(Boolean),
  )
  const maxResults =
    typeof opt?.maxResults === 'number' && Number.isFinite(opt.maxResults)
      ? Math.max(1, Math.min(500, Math.floor(opt.maxResults)))
      : 200
  const maxDepth =
    typeof opt?.maxDepth === 'number' && Number.isFinite(opt.maxDepth)
      ? Math.max(0, Math.min(64, Math.floor(opt.maxDepth)))
      : 32

  const out: LibrarySearchResult[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  let step = 0
  while (stack.length) {
    const cur = stack.pop()!
    const dir = cur.dir
    const depth = cur.depth
    if (depth > maxDepth) continue

    let entries: any[] = []
    try {
      entries = (await readDir(dir, { recursive: false } as any)) as any[]
    } catch {
      entries = []
    }

    for (const it of entries || []) {
      const name = String(it?.name || '').trim()
      const full =
        typeof it?.path === 'string' && it.path
          ? String(it.path)
          : joinPath(dir, name)
      let isDir = false
      try {
        const s = (await stat(full as any)) as any
        isDir = !!s?.isDirectory
      } catch {
        isDir = false
      }

      if (isDir) {
        const relDir = normalizeRelative(root, full)
        if (shouldSkipDir(name, relDir)) continue
        stack.push({ dir: full, depth: depth + 1 })
        continue
      }

      const ext = (name.split('.').pop() || '').toLowerCase()
      if (allow.size > 0 && !allow.has(ext)) continue

      const rel = normalizeRelative(root, full)
      const hay = (name + ' ' + rel).toLowerCase()
      if (!hay.includes(termLower)) continue

      out.push({ path: full, relative: rel, name })
      if (out.length >= maxResults) return out
    }

    // 让出事件循环：避免大库搜索把 UI 卡死
    step++
    if ((step & 7) === 0) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => setTimeout(r, 0))
    }
  }

  return out
}

