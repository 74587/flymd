// 插件 Ribbon 按钮管理：管理插件在垂直菜单栏中的快捷按钮
// 支持 SVG 图标或纯文字样式

import { getPluginMenuVisibility } from './pluginMenuConfig'

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

// 获取 ribbon-top 容器
function getRibbonTopContainer(): HTMLElement | null {
  try {
    const ribbon = document.getElementById('ribbon')
    if (!ribbon) return null
    return ribbon.querySelector('.ribbon-top') as HTMLElement | null
  } catch {
    return null
  }
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
    const container = getRibbonTopContainer()
    if (container) {
      const btn = createButtonElement(config)
      container.appendChild(btn)
      _createdButtons.set(pluginId, btn)

      // 根据配置设置可见性
      updateButtonVisibility(pluginId)
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

// 检查插件是否已注册 Ribbon 按钮
export function hasPluginRibbonButton(pluginId: string): boolean {
  return _registeredPlugins.has(pluginId)
}
