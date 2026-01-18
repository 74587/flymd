// 插件菜单可见性配置：统一管理“右键菜单 / 下拉菜单”开关

export type PluginMenuVisibility = {
  // 是否在右键菜单中显示
  contextMenu: boolean
  // 是否在"插件"下拉菜单中显示
  dropdownMenu: boolean
  // 是否在垂直菜单栏（Ribbon）中显示
  ribbonMenu: boolean
}

type PluginMenuVisibilityMap = Record<string, PluginMenuVisibility>

const STORAGE_KEY = 'flymd_pluginMenuVisibility'
const RIBBON_POSITION_KEY = 'flymd_pluginRibbonPosition'
const RIBBON_ORDER_KEY = 'flymd_pluginRibbonOrder'

export type PluginRibbonPosition = 'top' | 'bottom'
type PluginRibbonPositionMap = Record<string, PluginRibbonPosition>

type PluginRibbonOrderState = {
  top: string[]
  bottom: string[]
}

function sanitizeOrder(list: any): string[] {
  try {
    if (!Array.isArray(list)) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const v of list) {
      const id = String(v || '').trim()
      if (!id) continue
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  } catch {
    return []
  }
}

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

// 读取单个插件的菜单可见性；缺省值一律视为"显示"
export function getPluginMenuVisibility(pluginId: string): PluginMenuVisibility {
  const map = loadRawMap()
  const rec = map[pluginId]
  if (!rec || typeof rec !== 'object') {
    return { contextMenu: true, dropdownMenu: true, ribbonMenu: true }
  }
  return {
    contextMenu: rec.contextMenu !== false,
    dropdownMenu: rec.dropdownMenu !== false,
    ribbonMenu: rec.ribbonMenu !== false,
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
    ribbonMenu: patch.ribbonMenu ?? prev.ribbonMenu,
  }
  map[pluginId] = next
  saveRawMap(map)
  return map
}

// 读取完整映射（仅用于管理界面展示）
export function loadPluginMenuVisibilityMap(): PluginMenuVisibilityMap {
  return loadRawMap()
}

function loadRawRibbonOrderState(): PluginRibbonOrderState {
  try {
    const raw = localStorage.getItem(RIBBON_ORDER_KEY)
    if (!raw) return { top: [], bottom: [] }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { top: [], bottom: [] }
    const top = sanitizeOrder((parsed as any).top)
    const bottom = sanitizeOrder((parsed as any).bottom)
    return { top, bottom }
  } catch {
    return { top: [], bottom: [] }
  }
}

function saveRawRibbonOrderState(state: PluginRibbonOrderState): void {
  try {
    localStorage.setItem(
      RIBBON_ORDER_KEY,
      JSON.stringify({
        top: sanitizeOrder(state.top),
        bottom: sanitizeOrder(state.bottom),
      }),
    )
  } catch {
    try { console.error('保存插件 Ribbon 顺序失败') } catch {}
  }
}

export function getPluginRibbonOrder(pos: PluginRibbonPosition): string[] {
  try {
    const st = loadRawRibbonOrderState()
    return pos === 'bottom' ? st.bottom : st.top
  } catch {
    return []
  }
}

export function setPluginRibbonOrder(pos: PluginRibbonPosition, order: string[]): PluginRibbonOrderState {
  const st = loadRawRibbonOrderState()
  if (pos === 'bottom') st.bottom = sanitizeOrder(order)
  else st.top = sanitizeOrder(order)
  saveRawRibbonOrderState(st)
  return st
}

export function ensurePluginInRibbonOrder(pluginId: string, pos: PluginRibbonPosition): PluginRibbonOrderState {
  const id = String(pluginId || '').trim()
  if (!id) return loadRawRibbonOrderState()

  const order = getPluginRibbonOrder(pos)
  if (order.includes(id)) return loadRawRibbonOrderState()
  order.push(id)
  return setPluginRibbonOrder(pos, order)
}

function loadRawRibbonPositionMap(): PluginRibbonPositionMap {
  try {
    const raw = localStorage.getItem(RIBBON_POSITION_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as PluginRibbonPositionMap
  } catch {
    return {}
  }
}

function saveRawRibbonPositionMap(map: PluginRibbonPositionMap): void {
  try {
    localStorage.setItem(RIBBON_POSITION_KEY, JSON.stringify(map))
  } catch {
    try { console.error('保存插件 Ribbon 位置失败') } catch {}
  }
}

// 读取单个插件 Ribbon 位置；缺省值一律视为"顶部"
export function getPluginRibbonPosition(pluginId: string): PluginRibbonPosition {
  try {
    const map = loadRawRibbonPositionMap()
    const v = map[pluginId]
    return v === 'bottom' ? 'bottom' : 'top'
  } catch {
    return 'top'
  }
}

// 更新指定插件 Ribbon 位置
export function setPluginRibbonPosition(pluginId: string, pos: PluginRibbonPosition): PluginRibbonPositionMap {
  const map = loadRawRibbonPositionMap()
  const id = String(pluginId || '').trim()
  if (!id) return map

  const nextPos: PluginRibbonPosition = pos === 'bottom' ? 'bottom' : 'top'
  map[id] = nextPos
  saveRawRibbonPositionMap(map)

  // 位置切换时同步顺序表：从另一个位置移除，并加入新位置尾部
  try {
    const st = loadRawRibbonOrderState()
    st.top = sanitizeOrder(st.top.filter((x) => x !== id))
    st.bottom = sanitizeOrder(st.bottom.filter((x) => x !== id))
    if (nextPos === 'bottom') st.bottom.push(id)
    else st.top.push(id)
    saveRawRibbonOrderState(st)
  } catch {}

  return map
}

// 读取完整映射（仅用于管理界面展示）
export function loadPluginRibbonPositionMap(): PluginRibbonPositionMap {
  return loadRawRibbonPositionMap()
}
