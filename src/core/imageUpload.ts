// 粘贴/拖拽图片异步上传核心模块
// 只关心占位符替换与本地/图床/兜底策略，不直接依赖 DOM 全局

import type { AnyUploaderConfig } from '../uploader/types'
import { resolveImageTarget, type ImageTargetDeps } from './imageTarget'

export type EditorMode = 'edit' | 'preview'

export interface ImageUploadDeps extends ImageTargetDeps {
  // 编辑器内容读写
  getEditorValue(): string
  setEditorValue(v: string): void
  // 编辑器状态
  getMode(): EditorMode
  isWysiwyg(): boolean
  // 视图刷新
  renderPreview(): void
  scheduleWysiwygRender(): void
  // 标记文档已修改并刷新标题/状态栏
  markDirtyAndRefresh(): void
  // 光标处插入文本
  insertAtCursor(text: string): void
  // 当前文档路径（用于决定本地保存目录）
  getCurrentFilePath(): string | null
  // 运行时与路径相关工具
  isTauriRuntime(): boolean
  ensureDir(dir: string): Promise<void>
  getDefaultPasteDir(): Promise<string | null>
  getUserPicturesDir(): Promise<string | null>
  // 图床与转码配置
  getAlwaysSaveLocalImages(): Promise<boolean>
  // 本地图片链接写法：仅影响写入 Markdown（不改渲染与已有内容）
  getPreferRelativeLocalImages(): Promise<boolean>
  getUploaderConfig(): Promise<AnyUploaderConfig | null>
  getTranscodePrefs(): Promise<{ convertToWebp: boolean; webpQuality: number; saveLocalAsWebp: boolean }>
  // 文件写入与 dataURL 工具
  writeBinaryFile(path: string, bytes: Uint8Array): Promise<void>
  fileToDataUrl(file: File): Promise<string>
  // WebP 转码：由调用方注入，保持行为一致
  transcodeToWebpIfNeeded(
    blob: Blob,
    fname: string,
    quality: number,
    opts: { skipAnimated: boolean }
  ): Promise<{ blob: Blob; fileName: string; type?: string }>
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function genUploadId(): string {
  return `upl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function replaceUploadingPlaceholder(
  deps: ImageUploadDeps,
  id: string,
  replacementMarkdown: string
) {
  try {
    const token = `uploading://${id}`
    const re = new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(token)}\\)`)
    const before = deps.getEditorValue()
    if (re.test(before)) {
      const next = before.replace(re, replacementMarkdown)
      deps.setEditorValue(next)
      deps.markDirtyAndRefresh()
      const mode = deps.getMode()
      if (mode === 'preview') deps.renderPreview()
      else if (deps.isWysiwyg()) deps.scheduleWysiwygRender()
    }
  } catch {
    // 静默失败：占位符保留在文档中
  }
}

export function createImageUploader(deps: ImageUploadDeps) {
  async function handleUploadCore(fileOrBlob: File | Blob, fname: string, mime?: string) {
    const id = genUploadId()
    deps.insertAtCursor(`![${fname || 'image'}](uploading://${id})`)

    void (async () => {
      try {
        const target = await resolveImageTarget(deps, fileOrBlob, fname, mime, {
          preferRelative: true,
        })
        if (target?.url) {
          replaceUploadingPlaceholder(deps, id, `![${fname}](${target.url})`)
          return
        }
      } catch {
        // 完全失败时占位符保留，避免插入 base64 破坏文档
      }
    })()
  }

  function startAsyncUploadFromFile(file: File, fname: string): Promise<void> {
    void handleUploadCore(file, fname, file.type || 'application/octet-stream')
    return Promise.resolve()
  }

  function startAsyncUploadFromBlob(blob: Blob, fname: string, mime: string): Promise<void> {
    void handleUploadCore(blob, fname, mime)
    return Promise.resolve()
  }

  return {
    startAsyncUploadFromFile,
    startAsyncUploadFromBlob,
  }
}
