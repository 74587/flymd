// 插件菜单可见性配置：统一管理“右键菜单 / 下拉菜单”开关

export type PluginMenuVisibility = {
  // 是否在右键菜单中显示
  contextMenu: boolean
  // 是否在“插件”下拉菜单中显示
  dropdownMenu: boolean
}

type PluginMenuVisibilityMap = Record<string, PluginMenuVisibility>

const STORAGE_KEY = 'flymd_pluginMenuVisibility'

function loadRawMap(): PluginMenuVisibilityMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as PluginMenuVisibilityMap
  } catch {
    return {}
  }
}

function saveRawMap(map: PluginMenuVisibilityMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 本地存储失败不视为致命错误，仅在控制台提示
    try { console.error('保存插件菜单可见性失败') } catch {}
  }
}

// 读取单个插件的菜单可见性；缺省值一律视为“显示”
export function getPluginMenuVisibility(pluginId: string): PluginMenuVisibility {
  const map = loadRawMap()
  const rec = map[pluginId]
  if (!rec || typeof rec !== 'object') {
    return { contextMenu: true, dropdownMenu: true }
  }
  return {
    contextMenu: rec.contextMenu !== false,
    dropdownMenu: rec.dropdownMenu !== false,
  }
}

// 更新指定插件的菜单可见性（局部 patch），返回更新后的完整映射
export function setPluginMenuVisibility(
  pluginId: string,
  patch: Partial<PluginMenuVisibility>,
): PluginMenuVisibilityMap {
  const map = loadRawMap()
  const prev = getPluginMenuVisibility(pluginId)
  const next: PluginMenuVisibility = {
    contextMenu: patch.contextMenu ?? prev.contextMenu,
    dropdownMenu: patch.dropdownMenu ?? prev.dropdownMenu,
  }
  map[pluginId] = next
  saveRawMap(map)
  return map
}

// 读取完整映射（仅用于管理界面展示）
export function loadPluginMenuVisibilityMap(): PluginMenuVisibilityMap {
  return loadRawMap()
}

