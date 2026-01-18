// 插件 Ribbon 按钮管理：管理插件在垂直菜单栏中的快捷按钮
// 支持 SVG 图标或纯文字样式

import {
  ensurePluginInRibbonOrder,
  getPluginMenuVisibility,
  getPluginRibbonOrder,
  getPluginRibbonPosition,
  type PluginRibbonPosition,
} from './pluginMenuConfig'

export type PluginRibbonIconType = 'svg' | 'text'

export interface PluginRibbonConfig {
  pluginId: string
  // SVG 字符串或纯文字内容
  icon: string
  // 图标类型，默认 'svg'
  iconType: PluginRibbonIconType
  // 悬停提示文字
  title: string
  // 点击回调
  onClick: (ev: MouseEvent) => void
}

// 内部状态：已注册的插件配置
const _registeredPlugins = new Map<string, PluginRibbonConfig>()

// 内部状态：已创建的按钮元素
const _createdButtons = new Map<string, HTMLButtonElement>()

function getRibbonContainer(pos: PluginRibbonPosition): HTMLElement | null {
  try {
    const ribbon = document.getElementById('ribbon')
    if (!ribbon) return null
    const sel = pos === 'bottom' ? '.ribbon-bottom' : '.ribbon-top'
    return ribbon.querySelector(sel) as HTMLElement | null
  } catch {
    return null
  }
}

function insertButton(container: HTMLElement, btn: HTMLButtonElement, pos: PluginRibbonPosition): void {
  try {
    // bottom：插到最前面，避免把宿主的底部按钮（主题/扩展/语言）挤到下面去
    if (pos === 'bottom') {
      container.insertBefore(btn, container.firstChild)
      return
    }
    container.appendChild(btn)
  } catch {}
}

function isPluginRibbonButton(el: Element | null): boolean {
  try {
    return !!el && (el as HTMLElement).classList?.contains('plugin-ribbon-btn')
  } catch {
    return false
  }
}

function reorderContainer(pos: PluginRibbonPosition): void {
  try {
    const container = getRibbonContainer(pos)
    if (!container) return

    const btns = Array.from(container.querySelectorAll('button.plugin-ribbon-btn')) as HTMLButtonElement[]
    const byId = new Map<string, HTMLButtonElement>()
    for (const b of btns) {
      const id = (b.getAttribute('data-plugin-id') || '').trim()
      if (!id) continue
      byId.set(id, b)
    }

    const order = getPluginRibbonOrder(pos) || []
    const ids: string[] = []

    // 先按配置顺序排列已存在按钮
    for (const id of order) {
      if (byId.has(id)) ids.push(id)
    }
    // 再追加未写入配置的按钮（避免“消失”）
    for (const id of byId.keys()) {
      if (!ids.includes(id)) ids.push(id)
    }

    if (pos === 'top') {
      // 顶部：插件按钮全部放在内置按钮之后（append 会把按钮移动到末尾）
      for (const id of ids) {
        const b = byId.get(id)
        if (b) container.appendChild(b)
      }
      return
    }

    // 底部：插件按钮全部放在内置按钮之前
    let pivot: Element | null = null
    for (const ch of Array.from(container.children)) {
      if (!isPluginRibbonButton(ch)) {
        pivot = ch
        break
      }
    }
    for (const id of ids) {
      const b = byId.get(id)
      if (!b) continue
      if (pivot) container.insertBefore(b, pivot)
      else container.appendChild(b)
    }
  } catch {}
}

// 创建按钮元素
function createButtonElement(config: PluginRibbonConfig): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'ribbon-btn plugin-ribbon-btn'
  btn.setAttribute('data-plugin-id', config.pluginId)
  btn.title = config.title

  if (config.iconType === 'text') {
    btn.classList.add('text-icon')
    btn.textContent = config.icon
  } else {
    btn.innerHTML = config.icon
  }

  btn.addEventListener('click', (ev) => {
    try {
      config.onClick(ev)
    } catch (e) {
      console.error(`[PluginRibbon] ${config.pluginId} onClick error:`, e)
    }
  })

  return btn
}

// 更新按钮可见性
function updateButtonVisibility(pluginId: string): void {
  try {
    const btn = _createdButtons.get(pluginId)
    if (!btn) return

    const visibility = getPluginMenuVisibility(pluginId)
    if (visibility.ribbonMenu) {
      btn.style.display = ''
    } else {
      btn.style.display = 'none'
    }
  } catch {}
}

// 更新按钮位置（顶部/底部）
function updateButtonPlacement(pluginId: string): void {
  try {
    const btn = _createdButtons.get(pluginId)
    if (!btn) return

    const pos = getPluginRibbonPosition(pluginId)
    const container = getRibbonContainer(pos)
    if (!container) return

    if (btn.parentElement !== container) {
      insertButton(container, btn, pos)
    }

    // 同一位置内按用户配置重新排序
    reorderContainer(pos)
  } catch {}
}

// 注册插件 Ribbon 按钮
export function registerPluginRibbonButton(config: PluginRibbonConfig): () => void {
  try {
    const pluginId = config.pluginId
    if (!pluginId) {
      console.warn('[PluginRibbon] 注册失败：pluginId 为空')
      return () => {}
    }

    // 如果已注册，先注销
    if (_registeredPlugins.has(pluginId)) {
      unregisterPluginRibbonButton(pluginId)
    }

    // 保存配置
    _registeredPlugins.set(pluginId, config)

    // 创建并插入按钮
    const pos = getPluginRibbonPosition(pluginId)
    try { ensurePluginInRibbonOrder(pluginId, pos) } catch {}
    const container = getRibbonContainer(pos)
    if (container) {
      const btn = createButtonElement(config)
      insertButton(container, btn, pos)
      _createdButtons.set(pluginId, btn)

      // 根据配置设置可见性
      updateButtonVisibility(pluginId)
      // 根据配置排序
      reorderContainer(pos)
    }

    // 返回注销函数
    return () => unregisterPluginRibbonButton(pluginId)
  } catch (e) {
    console.error('[PluginRibbon] 注册失败:', e)
    return () => {}
  }
}

// 注销插件 Ribbon 按钮
export function unregisterPluginRibbonButton(pluginId: string): void {
  try {
    // 移除按钮元素
    const btn = _createdButtons.get(pluginId)
    if (btn && btn.parentNode) {
      btn.parentNode.removeChild(btn)
    }
    _createdButtons.delete(pluginId)

    // 移除配置
    _registeredPlugins.delete(pluginId)
  } catch (e) {
    console.error('[PluginRibbon] 注销失败:', e)
  }
}

// 获取所有已注册的 Ribbon 插件列表
export function getRegisteredRibbonPlugins(): Array<{ pluginId: string; title: string }> {
  const result: Array<{ pluginId: string; title: string }> = []
  try {
    for (const [pluginId, config] of _registeredPlugins) {
      result.push({ pluginId, title: config.title })
    }
  } catch {}
  return result
}

// 刷新所有按钮的可见性（菜单管理配置变更时调用）
export function refreshAllRibbonButtonVisibility(): void {
  try {
    for (const pluginId of _registeredPlugins.keys()) {
      updateButtonVisibility(pluginId)
    }
  } catch {}
}

// 刷新所有按钮的位置（菜单管理配置变更时调用）
export function refreshAllRibbonButtonPlacement(): void {
  try {
    for (const pluginId of _registeredPlugins.keys()) {
      updateButtonPlacement(pluginId)
    }
  } catch {}
}

// 刷新所有按钮的顺序（菜单管理配置变更时调用）
export function refreshAllRibbonButtonOrder(): void {
  try {
    reorderContainer('top')
    reorderContainer('bottom')
  } catch {}
}

// 检查插件是否已注册 Ribbon 按钮
export function hasPluginRibbonButton(pluginId: string): boolean {
  return _registeredPlugins.has(pluginId)
}
