/**
 * 文本区域撤销管理器
 *
 * 目标：
 * - 为每个标签维护独立的撤销/重做栈
 * - 只在源码模式且焦点在 textarea 时接管 Ctrl+Z / Ctrl+Y
 * - 不修改 TabManager / main.ts，对现有行为最小侵入
 */

interface EditRecord {
  content: string
  selectionStart: number
  selectionEnd: number
  timestamp: number
  inputType?: string
  inputData?: string
  groupStartedAt?: number
  groupCount?: number
}

interface ManualUndoStack {
  undoStack: EditRecord[]
  redoStack: EditRecord[]
  maxSize: number
}

export class TextareaUndoManager {
  private stacks = new Map<string, ManualUndoStack>()
  private currentTabId: string | null = null
  private textarea: HTMLTextAreaElement | null = null

  private inputHandler?: (e: Event) => void
  private keydownHandler?: (e: KeyboardEvent) => void

  // 标记：正在应用撤销/重做，避免死循环
  private isApplying = false
  // 标记：外部程序性更新（如切换标签、打开文件），不记录到撤销栈
  private suppressRecording = false

  private getMaxStackSize(contentSize: number): number {
    if (contentSize > 500_000) return 15
    if (contentSize > 100_000) return 50
    return 120
  }

  /**
   * 初始化当前激活标签的撤销栈
   * 等价于第一次 switchTab
   */
  init(tabId: string, textarea: HTMLTextAreaElement): void {
    this.switchTab(tabId, textarea)
  }

  /**
   * 切换到指定标签的撤销栈
   * 不丢弃其他标签的栈，只是更换当前激活的栈
   */
  switchTab(tabId: string, textarea: HTMLTextAreaElement): void {
    // 解绑旧监听器，但保留历史栈
    this.cleanupListeners()

    this.currentTabId = tabId
    this.textarea = textarea

    // 为该标签创建撤销栈（如果还没有）
    let stack = this.stacks.get(tabId)
    const contentSize = textarea.value.length
    if (!stack) {
      const maxSize = this.getMaxStackSize(contentSize)
      stack = { undoStack: [], redoStack: [], maxSize }
      this.stacks.set(tabId, stack)

      if (contentSize > 500_000) {
        const kb = (contentSize / 1024).toFixed(1)
        console.debug(
          `[UndoManager] Large doc detected (${kb}KB), limiting stack to ${maxSize} records`
        )
      }
    }

    // 绑定新 textarea 的监听器
    this.bindListeners(textarea)

    // 首次使用该标签时，记录一个初始状态
    if (stack.undoStack.length === 0) {
      this.recordEdit()
    } else {
      // 如果当前内容和栈顶不一致，也追加一条状态作为新的基线
      const top = stack.undoStack[stack.undoStack.length - 1]
      if (
        top.content !== textarea.value ||
        top.selectionStart !== textarea.selectionStart ||
        top.selectionEnd !== textarea.selectionEnd
      ) {
        this.recordEdit()
      }
    }
  }

  /**
   * 移除指定标签的撤销栈（标签关闭时调用）
   */
  removeTab(tabId: string): void {
    this.stacks.delete(tabId)
    if (this.currentTabId === tabId) {
      this.currentTabId = null
      this.cleanupListeners()
    }
  }

  /**
   * 在一次外部程序性更新期间暂停记录撤销快照
   * 例如：切换标签、打开文件时设置 textarea.value
   */
  runWithoutRecording(fn: () => void): void {
    const prev = this.suppressRecording
    this.suppressRecording = true
    try {
      fn()
    } finally {
      this.suppressRecording = prev
    }
  }

  /**
   * 执行撤销
   * 返回是否实际处理了撤销；若返回 false，交回浏览器原生撤销处理
   */
  undo(): boolean {
    if (!this.currentTabId) return false
    const stack = this.stacks.get(this.currentTabId)
    if (!stack) return false
    if (stack.undoStack.length <= 1) return false // 至少保留一个基线状态

    const current = stack.undoStack.pop()!
    stack.redoStack.push(current)

    const prev = stack.undoStack[stack.undoStack.length - 1]
    this.applyRecord(prev)
    return true
  }

  /**
   * 执行重做
   * 返回是否实际处理了重做；若返回 false，交回浏览器原生撤销处理
   */
  redo(): boolean {
    if (!this.currentTabId) return false
    const stack = this.stacks.get(this.currentTabId)
    if (!stack) return false
    if (stack.redoStack.length === 0) return false

    const next = stack.redoStack.pop()!
    stack.undoStack.push(next)

    this.applyRecord(next)
    return true
  }

  /**
   * 绑定 textarea 的输入/按键监听
   */
  private bindListeners(textarea: HTMLTextAreaElement): void {
    this.inputHandler = (e: Event) => {
      if (this.isApplying || this.suppressRecording) return
      this.recordEdit(e)
    }

    this.keydownHandler = (e: KeyboardEvent) => {
      // 只在源码模式 + 焦点在 textarea 时接管
      const flymd = (window as any) ?? {}
      const isEditMode = flymd.flymdGetMode?.() === 'edit'
      if (!isEditMode) return
      if (document.activeElement !== textarea) return

      const isCtrlOrMeta = e.ctrlKey || e.metaKey
      if (!isCtrlOrMeta) return

      const isMeta = e.metaKey
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        this.undo()
      } else if (key === 'y' || (isMeta && key === 'z' && e.shiftKey)) {
        e.preventDefault()
        this.redo()
      }
    }

    textarea.addEventListener('input', this.inputHandler)
    textarea.addEventListener('keydown', this.keydownHandler)
  }

  /**
   * 解绑 textarea 监听器，但保留所有撤销栈
   */
  private cleanupListeners(): void {
    if (this.textarea && this.inputHandler) {
      this.textarea.removeEventListener('input', this.inputHandler)
    }
    if (this.textarea && this.keydownHandler) {
      this.textarea.removeEventListener('keydown', this.keydownHandler)
    }

    this.inputHandler = undefined
    this.keydownHandler = undefined
    this.textarea = null
  }

  /**
   * 将当前 textarea 内容重置为当前标签的基线状态
   * 用于：打开/切换到一个全新加载的文档后，避免撤销回到旧文档内容或空文档
   */
  resetCurrentStackBaseline(): void {
    if (!this.currentTabId || !this.textarea) return

    const textarea = this.textarea
    const content = textarea.value

    // 若当前标签还没有栈，按当前内容创建一个
    let stack = this.stacks.get(this.currentTabId)
    const record: EditRecord = {
      content,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      // 基线记录不参与时间窗口合并：后续第一次输入必须生成可撤销快照
      timestamp: 0,
    }

    const contentSize = content.length
    const maxSize = this.getMaxStackSize(contentSize)

    if (!stack) {
      stack = { undoStack: [record], redoStack: [], maxSize }
      this.stacks.set(this.currentTabId, stack)
      return
    }

    // 丢弃旧文档的全部历史，只保留“当前文档初始状态”
    stack.undoStack = [record]
    stack.redoStack = []
    stack.maxSize = maxSize
  }

  /**
   * 记录一次编辑快照
   * 使用时间窗口合并策略 + 栈深度限制控制内存占用
   */
  private recordEdit(event?: Event): void {
    if (!this.currentTabId || !this.textarea) return

    const stack = this.stacks.get(this.currentTabId)
    if (!stack) return

    const now = Date.now()
    const inputEvent = (typeof InputEvent !== 'undefined' && event instanceof InputEvent)
      ? event
      : null
    const inputType = inputEvent?.inputType || ''
    const inputData = inputEvent?.data || ''
    const record: EditRecord = {
      content: this.textarea.value,
      selectionStart: this.textarea.selectionStart,
      selectionEnd: this.textarea.selectionEnd,
      timestamp: now,
      inputType,
      inputData,
      groupStartedAt: now,
      groupCount: 1,
    }

    const undoStack = stack.undoStack
    const last = undoStack[undoStack.length - 1]

    if (last && this.shouldMergeEdit(last, record, now)) {
      record.groupStartedAt = last.groupStartedAt || last.timestamp
      record.groupCount = (last.groupCount || 1) + 1
      undoStack[undoStack.length - 1] = record
    } else {
      undoStack.push(record)

      // 栈满时丢弃最旧记录（FIFO）
      if (undoStack.length > stack.maxSize) {
        undoStack.shift()
      }
    }

    // 用户输入后，重做栈失效
    stack.redoStack = []

    // 栈满时打印估算内存
    if (undoStack.length === stack.maxSize) {
      const memUsage = (record.content.length * stack.maxSize / 1024).toFixed(1)
      console.debug(
        `[UndoManager] Stack full for tab ${this.currentTabId.slice(0, 8)}, ` +
        `estimated memory: ${memUsage}KB`
      )
    }
  }

  private shouldMergeEdit(last: EditRecord, next: EditRecord, now: number): boolean {
    if (!last || last.timestamp <= 0) return false
    if (!next.inputType || last.inputType !== next.inputType) return false

    const groupStartedAt = last.groupStartedAt || last.timestamp
    if (now - last.timestamp > 500) return false
    if (now - groupStartedAt > 1200) return false
    if ((last.groupCount || 1) >= 8) return false

    if (next.inputType === 'insertText') return this.canMergeInsertText(last, next)
    if (next.inputType === 'deleteContentBackward') return this.canMergeDeleteBackward(last, next)
    if (next.inputType === 'deleteContentForward') return this.canMergeDeleteForward(last, next)
    return false
  }

  private isBoundaryInput(data: string | undefined): boolean {
    if (!data || data.length !== 1) return true
    return /[\s.,;:!?，。；：！？、]/.test(data)
  }

  private canMergeInsertText(last: EditRecord, next: EditRecord): boolean {
    const data = next.inputData || ''
    if (this.isBoundaryInput(data) || this.isBoundaryInput(last.inputData)) return false
    if (last.selectionStart !== last.selectionEnd || next.selectionStart !== next.selectionEnd) return false
    if (next.content.length !== last.content.length + data.length) return false
    if (next.selectionStart !== last.selectionStart + data.length) return false
    return next.content.slice(last.selectionStart, last.selectionStart + data.length) === data
  }

  private canMergeDeleteBackward(last: EditRecord, next: EditRecord): boolean {
    if (last.selectionStart !== last.selectionEnd || next.selectionStart !== next.selectionEnd) return false
    if (next.content.length !== last.content.length - 1) return false
    return next.selectionStart === Math.max(0, last.selectionStart - 1)
  }

  private canMergeDeleteForward(last: EditRecord, next: EditRecord): boolean {
    if (last.selectionStart !== last.selectionEnd || next.selectionStart !== next.selectionEnd) return false
    if (next.content.length !== last.content.length - 1) return false
    return next.selectionStart === last.selectionStart
  }

  /**
   * 应用某条历史记录到 textarea
   * 会触发 input 事件通知其他监听器，但不会被再次记录到撤销栈
   */
  private applyRecord(record: EditRecord): void {
    if (!this.textarea) return

    this.isApplying = true
    try {
      this.textarea.value = record.content
      this.textarea.setSelectionRange(record.selectionStart, record.selectionEnd)

      // 派发 input 事件，让 dirty 标记、预览等逻辑保持工作
      const ev = new Event('input', { bubbles: true })
      this.textarea.dispatchEvent(ev)
    } finally {
      this.isApplying = false
    }
  }
}

