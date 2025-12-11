/**
 * 配置备份模块
 * 从 main.ts 拆分，包含配置文件的收集、备份、恢复等功能
 */

import { readDir, readFile, writeFile, mkdir, remove } from '@tauri-apps/plugin-fs'
import { BaseDirectory } from '@tauri-apps/plugin-fs'

// 备份相关常量
export const CONFIG_BACKUP_VERSION = 2
export const PLUGINS_DIR = 'flymd/plugins'
export const SETTINGS_FILE_NAME = 'flymd-settings.json'
export const BACKUP_PREFIX_APPDATA = 'appdata'
export const BACKUP_PREFIX_APPLOCAL = 'applocal'
export const APP_LOCAL_EXCLUDE_ROOTS = ['EBWebView']
// 配置备份文件扩展名（原本定义在 main.ts 中）
export const CONFIG_BACKUP_FILE_EXT = 'flymdconfig'

// 类型定义
export type ConfigBackupEntry = { path: string; data: string; size: number }
export type ConfigBackupPayload = { version: number; exportedAt: string; files: ConfigBackupEntry[] }
export type BackupPathInfo = { baseDir: BaseDirectory; relPath: string }

export function normalizeBackupPath(input: string): string {
  try {
    if (!input) return ''
    const raw = String(input).replace(/\\/g, '/').replace(/\/+/g, '/')
    const trimmed = raw.replace(/^\/+/, '')
    const parts = trimmed.split('/').filter(part => part && part !== '.' && part !== '..')
    return parts.join('/')
  } catch {
    return ''
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (!bytes || bytes.length === 0) return ''
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize)
    let chunk = ''
    for (let j = 0; j < slice.length; j++) {
      chunk += String.fromCharCode(slice[j])
    }
    binary += chunk
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array()
  const binary = atob(b64)
  const len = binary.length
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function getSettingsBaseDir(): BaseDirectory {
  const anyBase = BaseDirectory as any
  return (anyBase?.AppData) ?? (anyBase?.AppConfig) ?? BaseDirectory.AppData
}

export async function collectDirFilesForBackup(baseDir: BaseDirectory, relDir: string, prefix: string, list: ConfigBackupEntry[]): Promise<number> {
  const normalizedDir = normalizeBackupPath(relDir || '')
  const readTarget = normalizedDir ? normalizedDir : '.'
  let entries: any[] = []
  try {
    entries = await readDir(readTarget as any, { baseDir, recursive: false } as any) as any[]
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    const name = (entry && entry.name) ? String(entry.name) : ''
    if (!name) continue
    const childRel = normalizedDir ? `${normalizedDir}/${name}` : name
    if (prefix === BACKUP_PREFIX_APPLOCAL) {
      const normalizedChild = normalizeBackupPath(childRel)
      if (normalizedChild && APP_LOCAL_EXCLUDE_ROOTS.some((root) => normalizedChild === root || normalizedChild.startsWith(root + '/'))) {
        continue
      }
    }
    const isDir = entry?.isDirectory === true || entry?.isDir === true || Array.isArray(entry?.children)
    if (isDir) {
      count += await collectDirFilesForBackup(baseDir, childRel, prefix, list)
    } else {
      try {
        const data = await readFile(childRel as any, { baseDir } as any)
        const storedPath = normalizeBackupPath(`${prefix}/${childRel}`)
        if (!storedPath) continue
        list.push({ path: storedPath, data: bytesToBase64(data), size: data.length })
        count++
      } catch {}
    }
  }
  return count
}

export async function collectConfigBackupFiles(): Promise<{ files: ConfigBackupEntry[] }> {
  const files: ConfigBackupEntry[] = []
  const scopes: Array<{ baseDir: BaseDirectory; prefix: string }> = [
    { baseDir: getSettingsBaseDir(), prefix: BACKUP_PREFIX_APPDATA },
    { baseDir: BaseDirectory.AppLocalData, prefix: BACKUP_PREFIX_APPLOCAL },
  ]
  for (const scope of scopes) {
    await collectDirFilesForBackup(scope.baseDir, '', scope.prefix, files)
  }
  return { files }
}

export function resolveBackupPath(pathRaw: string): BackupPathInfo | null {
  const normalized = normalizeBackupPath(pathRaw)
  if (!normalized) return null
  if (normalized.startsWith(BACKUP_PREFIX_APPDATA + '/')) {
    const rel = normalizeBackupPath(normalized.slice((BACKUP_PREFIX_APPDATA + '/').length))
    if (!rel) return null
    return { baseDir: getSettingsBaseDir(), relPath: rel }
  }
  if (normalized.startsWith(BACKUP_PREFIX_APPLOCAL + '/')) {
    const rel = normalizeBackupPath(normalized.slice((BACKUP_PREFIX_APPLOCAL + '/').length))
    if (!rel) return null
    return { baseDir: BaseDirectory.AppLocalData, relPath: rel }
  }
  if (normalized === SETTINGS_FILE_NAME) {
    return { baseDir: getSettingsBaseDir(), relPath: SETTINGS_FILE_NAME }
  }
  if (normalized.startsWith('flymd/')) {
    return { baseDir: BaseDirectory.AppLocalData, relPath: normalized }
  }
  return null
}

export async function ensureParentDirsForBackup(info: BackupPathInfo | null): Promise<void> {
  if (!info) return
  const normalized = normalizeBackupPath(info.relPath)
  if (!normalized) return
  const parts = normalized.split('/')
  if (parts.length <= 1) return
  let cur = ''
  for (let i = 0; i < parts.length - 1; i++) {
    cur += (cur ? '/' : '') + parts[i]
    if (!cur) continue
    try {
      await mkdir(cur as any, { baseDir: info.baseDir, recursive: true } as any)
    } catch {}
  }
}

export async function clearDirectory(baseDir: BaseDirectory, relDir: string = ''): Promise<void> {
  const normalizedDir = normalizeBackupPath(relDir || '')
  const readTarget = normalizedDir ? normalizedDir : '.'
  let entries: any[] = []
  try {
    entries = await readDir(readTarget as any, { baseDir, recursive: false } as any) as any[]
  } catch {
    return
  }
  for (const entry of entries) {
    const name = (entry && entry.name) ? String(entry.name) : ''
    if (!name) continue
    const childRel = normalizedDir ? `${normalizedDir}/${name}` : name
    const isDir = entry?.isDirectory === true || entry?.isDir === true || Array.isArray(entry?.children)
    if (isDir) {
      await clearDirectory(baseDir, childRel)
      try { await remove(childRel as any, { baseDir } as any) } catch {}
    } else {
      try { await remove(childRel as any, { baseDir } as any) } catch {}
    }
  }
}

export async function clearAppLocalDataForRestore(): Promise<void> {
  let entries: any[] = []
  try {
    entries = await readDir('.' as any, { baseDir: BaseDirectory.AppLocalData, recursive: false } as any) as any[]
  } catch {
    return
  }
  for (const entry of entries) {
    const name = entry?.name ? String(entry.name) : ''
    if (!name) continue
    if (APP_LOCAL_EXCLUDE_ROOTS.includes(name.replace(/\\/g, '/'))) continue
    const isDir = entry?.isDirectory === true || entry?.isDir === true || Array.isArray(entry?.children)
    if (isDir) {
      await clearDirectory(BaseDirectory.AppLocalData, name)
      try { await remove(name as any, { baseDir: BaseDirectory.AppLocalData } as any) } catch {}
    } else {
      try { await remove(name as any, { baseDir: BaseDirectory.AppLocalData } as any) } catch {}
    }
  }
}

// 备份文件名时间戳（从 main.ts 拆分，保持行为不变）
export function formatBackupTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}
