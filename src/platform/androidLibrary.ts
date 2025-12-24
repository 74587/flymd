/**
 * Android 端库目录初始化（MVP：先用应用私有目录做“本地库”）
 *
 * 目标：
 * - 不碰 SAF/外置存储，先把“浏览/搜索/编辑 + WebDAV 同步 + 插件（AI/RAG/待办）”跑通
 * - 不破坏桌面端：仅在 get_platform === 'android' 时生效
 */

import { appLocalDataDir } from '@tauri-apps/api/path'
import { mkdir } from '@tauri-apps/plugin-fs'

import { getPlatform } from '../platform'
import { getActiveLibraryRoot, upsertLibrary } from '../utils/library'

export const ANDROID_DEFAULT_LIBRARY_ID = 'android-local'

function joinPath(base: string, parts: string[]): string {
  const b = String(base || '').replace(/[\\/]+$/, '')
  const sep = b.includes('\\') ? '\\' : '/'
  const clean = parts
    .map((p) => String(p || '').replace(/^[/\\]+/, '').replace(/[\\/]+$/, ''))
    .filter(Boolean)
  return b + (clean.length ? sep + clean.join(sep) : '')
}

export async function ensureAndroidDefaultLibraryRoot(): Promise<string | null> {
  const platform = await getPlatform()
  if (platform !== 'android') return null

  const cur = await getActiveLibraryRoot()
  if (cur) return cur

  // Android：默认把库放到 AppLocalData/flymd/library
  const base = (await appLocalDataDir()).replace(/[\\/]+$/, '')
  const root = joinPath(base, ['flymd', 'library'])
  await mkdir(root as any, { recursive: true } as any)

  await upsertLibrary({ id: ANDROID_DEFAULT_LIBRARY_ID, name: '本地库', root })
  return root
}

