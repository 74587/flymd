// 通用文件系统安全操作封装（与 UI 解耦，只做路径与读写）

import { mkdir, rename, readFile, writeFile, remove } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'

// 统一路径分隔符（在当前平台风格下清洗多余分隔符）
export function normSep(p: string): string {
  return p.replace(/[\\/]+/g, p.includes('\\') ? '\\' : '/')
}

// 判断 p 是否位于 root 之内（大小写不敏感，按规范化路径前缀判断）
export function isInside(root: string, p: string): boolean {
  try {
    const r = normSep(root).toLowerCase()
    const q = normSep(p).toLowerCase()
    const base = r.endsWith('/') || r.endsWith('\\') ? r : r + (r.includes('\\') ? '\\' : '/')
    return q.startsWith(base)
  } catch {
    return false
  }
}

// 确保目录存在（递归创建）
export async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true } as any)
  } catch {}
}

// 安全移动文件：优先尝试 rename，失败则回退到复制+删除
export async function moveFileSafe(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst)
  } catch {
    const data = await readFile(src)
    await ensureDir(dst.replace(/[\\/][^\\/]*$/, ''))
    await writeFile(dst, data as any)
    try {
      await remove(src)
    } catch {}
  }
}

// 安全重命名：在同一目录内构造新路径并调用 moveFileSafe
export async function renameFileSafe(p: string, newName: string): Promise<string> {
  const base = p.replace(/[\\/][^\\/]*$/, '')
  const dst = base + (base.includes('\\') ? '\\' : '/') + newName
  await moveFileSafe(p, dst)
  return dst
}

// 将任意 open() 返回值归一化为可用于 fs API 的字符串路径
export function normalizePath(input: unknown): string {
  try {
    if (typeof input === 'string') return input
    if (input && typeof (input as any).path === 'string') return (input as any).path
    if (input && typeof (input as any).filePath === 'string') return (input as any).filePath
    const p: any = (input as any)?.path
    if (p) {
      if (typeof p === 'string') return p
      if (typeof p?.href === 'string') return p.href
      if (typeof p?.toString === 'function') {
        const s = p.toString()
        if (typeof s === 'string' && s) return s
      }
    }
    if (input && typeof (input as any).href === 'string') return (input as any).href
    if (input && typeof (input as any).toString === 'function') {
      const s = (input as any).toString()
      if (typeof s === 'string' && s) return s
    }
    return String(input ?? '')
  } catch {
    return String(input ?? '')
  }
}

// 统一读文件兜底：fs 失败则调用后端命令读取
export async function readTextFileAnySafe(p: string): Promise<string> {
  try {
    const data = await readFile(p as any)
    return new TextDecoder().decode(data as any)
  } catch (e) {
    try {
      return await invoke<string>('read_text_file_any', { path: p })
    } catch {
      throw e
    }
  }
}

// 统一写文件兜底：fs 失败则调用后端命令写入
export async function writeTextFileAnySafe(p: string, content: string): Promise<void> {
  const data = new TextEncoder().encode(content)
  try {
    await writeFile(p as any, data as any)
  } catch (e) {
    try {
      await invoke('write_text_file_any', { path: p, content })
    } catch {
      throw e
    }
  }
}

