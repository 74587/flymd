// 便签模式自动保存：把“频繁输入”直接变成“连续写盘”是愚蠢的。
// 这里做一个最小的防抖 + 串行保存：避免并发写导致“旧内容覆盖新内容”。

export type StickyAutoSaveDeps = {
  isStickyNoteMode: () => boolean
  isDirty: () => boolean
  hasCurrentFile: () => boolean
  saveNow: () => Promise<void>
}

export type StickyAutoSaver = {
  schedule: () => void
  flush: () => Promise<void>
  cancel: () => void
}

export function createStickyAutoSaver(
  deps: StickyAutoSaveDeps,
  delayMs = 400,
): StickyAutoSaver {
  let timer: number | null = null
  let inFlight = false
  let queued = false

  function cancel(): void {
    if (timer != null) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  function schedule(): void {
    try {
      if (!deps.isStickyNoteMode()) return
      if (!deps.hasCurrentFile()) return
      cancel()
      timer = window.setTimeout(() => {
        timer = null
        void flush()
      }, delayMs)
    } catch {}
  }

  async function flush(): Promise<void> {
    try {
      cancel()
      if (!deps.isStickyNoteMode()) return
      if (!deps.hasCurrentFile()) return
      if (!deps.isDirty()) return

      if (inFlight) {
        queued = true
        return
      }
      inFlight = true
      try {
        await deps.saveNow()
      } finally {
        inFlight = false
      }
      if (queued) {
        queued = false
        await flush()
      }
    } catch {}
  }

  return { schedule, flush, cancel }
}
