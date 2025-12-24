/*
  平台集成层（移动端补丁）
  原则：别搞两套状态机。主程序（main.ts）负责“当前文件/库/模式”等状态，
  这里仅负责：
  - 设置平台 CSS class（用于移动端样式）
  - 接管 FAB 事件，映射到主程序已有按钮/全局函数
*/

import { getPlatform, isMobile } from './platform'
import { initMobileUI, openDrawer } from './mobile'

let _fabBound = false

function clickById(id: string): boolean {
  try {
    const el = document.getElementById(id) as HTMLElement | null
    if (!el) return false
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  } catch {
    return false
  }
}

function callGlobal(name: string): boolean {
  try {
    const anyWin = window as any
    const fn = anyWin && anyWin[name]
    if (typeof fn !== 'function') return false
    fn()
    return true
  } catch {
    return false
  }
}

function setupFABListeners(): void {
  if (_fabBound) return
  _fabBound = true

  window.addEventListener('fab-action', ((e: CustomEvent) => {
    const action = String(e?.detail?.action || '')
    if (!action) return

    switch (action) {
      case 'library': {
        openDrawer()
        break
      }
      case 'open': {
        // MVP：移动端“打开”优先引导到库（外部 SAF 文件导入后续再做）
        openDrawer()
        break
      }
      case 'new': {
        // 复用顶部隐藏按钮（它走“库内新建文件”的逻辑）
        if (!clickById('btn-new')) {
          // 兜底：退回到“新建空白文档”
          callGlobal('flymdNewFile')
        }
        break
      }
      case 'save': {
        // 直接复用主程序保存逻辑
        if (!callGlobal('flymdSaveFile')) {
          clickById('btn-save')
        }
        break
      }
      case 'preview': {
        // 等价于 Ctrl+E
        if (!callGlobal('flymdToggleModeShortcut')) {
          clickById('btn-toggle')
        }
        break
      }
    }
  }) as EventListener)
}

export async function initPlatformIntegration(): Promise<void> {
  const platform = await getPlatform()

  try {
    if (platform === 'android') {
      document.body.classList.add('platform-android')
    }
    if (isMobile() || platform === 'android') {
      document.body.classList.add('platform-mobile')
    }
  } catch {}

  // 移动端初始化 UI（FAB/抽屉遮罩/键盘适配）
  try {
    if (isMobile() || platform === 'android') {
      initMobileUI()
      setupFABListeners()
    }
  } catch {}

  console.log('[Platform] Running on:', platform)
}

