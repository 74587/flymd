// 插件菜单管理窗口：统一管理“扩展菜单”的右键 / 下拉显示开关
// 仅负责 UI，真实开关逻辑由 pluginMenuConfig + contextMenus / pluginMenu 执行

import type { InstalledPlugin } from './runtime'
import type { PluginContextMenuItem } from '../ui/contextMenus'
import { t } from '../i18n'
import {
  getPluginMenuVisibility,
  setPluginMenuVisibility,
} from './pluginMenuConfig'
import {
  getRegisteredRibbonPlugins,
  refreshAllRibbonButtonVisibility,
} from './pluginRibbonManager'

export interface PluginMenuManagerHost {
  getInstalledPlugins(): Promise<Record<string, InstalledPlugin>>
  getPluginContextMenuItems(): PluginContextMenuItem[]
  getDropdownPlugins(): Array<{ pluginId: string; label: string }>
}

const OVERLAY_ID = 'plugin-menu-manager-overlay'
const BODY_ID = 'plugin-menu-manager-body'
const CLOSE_BTN_ID = 'plugin-menu-manager-close'
const CLOSE_BTN2_ID = 'plugin-menu-manager-close2'

function ensureOverlay(): HTMLDivElement | null {
  try {
    const container = document.querySelector('.container') as HTMLDivElement | null
    if (!container) return null

    let ov = document.getElementById(OVERLAY_ID) as HTMLDivElement | null
    if (ov) return ov

    ov = document.createElement('div')
    ov.id = OVERLAY_ID
    ov.className = 'link-overlay hidden'
    ov.innerHTML = `
      <div class="link-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-menu-manager-title">
        <div class="link-header">
          <div id="plugin-menu-manager-title">${t('plugins.menuManager.title') || '菜单管理'}</div>
          <button id="${CLOSE_BTN_ID}" class="about-close" title="${t('about.close')}">×</button>
        </div>
        <div class="link-body" id="${BODY_ID}"></div>
        <div class="link-actions">
          <button id="${CLOSE_BTN2_ID}">${t('about.close')}</button>
        </div>
      </div>
    `
    container.appendChild(ov)

    const close = () => {
      try { ov!.classList.add('hidden') } catch {}
    }

    const btn1 = ov.querySelector(`#${CLOSE_BTN_ID}`) as HTMLButtonElement | null
    if (btn1) btn1.addEventListener('click', close)
    const btn2 = ov.querySelector(`#${CLOSE_BTN2_ID}`) as HTMLButtonElement | null
    if (btn2) btn2.addEventListener('click', close)

    ov.addEventListener('click', (e) => {
      if (e.target === ov) close()
    })

    return ov
  } catch {
    return null
  }
}

type PluginMenuRow = {
  pluginId: string
  name: string
  hasContextMenu: boolean
  hasDropdownMenu: boolean
  hasRibbonMenu: boolean
}

export async function openPluginMenuManager(host: PluginMenuManagerHost): Promise<void> {
  try {
    const ov = ensureOverlay()
    if (!ov) return
    const body = ov.querySelector(`#${BODY_ID}`) as HTMLDivElement | null
    if (!body) return

    let installed: Record<string, InstalledPlugin> = {}
    try {
      installed = await host.getInstalledPlugins()
    } catch {
      installed = {}
    }

    let ctxItems: PluginContextMenuItem[] = []
    try {
      ctxItems = host.getPluginContextMenuItems() || []
    } catch {
      ctxItems = []
    }

    let dropdownItems: Array<{ pluginId: string; label: string }> = []
    try {
      dropdownItems = host.getDropdownPlugins() || []
    } catch {
      dropdownItems = []
    }

    const rowsMap = new Map<string, PluginMenuRow>()

    // 获取已注册 Ribbon 按钮的插件
    let ribbonPlugins: Array<{ pluginId: string; title: string }> = []
    try {
      ribbonPlugins = getRegisteredRibbonPlugins() || []
    } catch {
      ribbonPlugins = []
    }
    const ribbonPluginIds = new Set(ribbonPlugins.map((r) => r.pluginId))

    // 先根据"已安装扩展"初始化行（用于提供友好名称）
    for (const p of Object.values(installed)) {
      if (!p || !p.id) continue
      const id = p.id
      rowsMap.set(id, {
        pluginId: id,
        name: String(p.name || p.id || '').trim() || id,
        hasContextMenu: false,
        hasDropdownMenu: false,
        hasRibbonMenu: ribbonPluginIds.has(id),
      })
    }

    // 右键菜单项 → 标记 hasContextMenu
    for (const it of ctxItems) {
      if (!it || !it.pluginId) continue
      const id = it.pluginId
      const existed = rowsMap.get(id)
      if (existed) {
        existed.hasContextMenu = true
      } else {
        rowsMap.set(id, {
          pluginId: id,
          name: id,
          hasContextMenu: true,
          hasDropdownMenu: false,
          hasRibbonMenu: ribbonPluginIds.has(id),
        })
      }
    }

    // "插件"下拉菜单项 → 标记 hasDropdownMenu
    for (const it of dropdownItems) {
      if (!it || !it.pluginId) continue
      const id = it.pluginId
      const label = (it.label || '').trim()
      const existed = rowsMap.get(id)
      if (existed) {
        existed.hasDropdownMenu = true
        // 若之前没有友好名称，则使用菜单标签
        if (!existed.name && label) existed.name = label
      } else {
        rowsMap.set(id, {
          pluginId: id,
          name: label || id,
          hasContextMenu: false,
          hasDropdownMenu: true,
          hasRibbonMenu: ribbonPluginIds.has(id),
        })
      }
    }

    // Ribbon 按钮 → 标记 hasRibbonMenu（并确保在列表中显示）
    for (const rp of ribbonPlugins) {
      if (!rp || !rp.pluginId) continue
      const id = rp.pluginId
      const existed = rowsMap.get(id)
      if (existed) {
        existed.hasRibbonMenu = true
        // 若之前没有友好名称，则使用 Ribbon 标题
        if (!existed.name && rp.title) existed.name = rp.title
      } else {
        rowsMap.set(id, {
          pluginId: id,
          name: rp.title || id,
          hasContextMenu: false,
          hasDropdownMenu: false,
          hasRibbonMenu: true,
        })
      }
    }

    const rows = Array.from(rowsMap.values()).filter(
      (r) => r.hasContextMenu || r.hasDropdownMenu || r.hasRibbonMenu,
    )

    if (!rows.length) {
      body.innerHTML = `<div style="font-size:13px;color:var(--muted);">${t('plugins.menuManager.empty') || '当前没有已注册的扩展菜单。'}</div>`
      ov.classList.remove('hidden')
      return
    }

    rows.sort((a, b) => {
      const na = (a.name || a.pluginId || '').toLowerCase()
      const nb = (b.name || b.pluginId || '').toLowerCase()
      if (na < nb) return -1
      if (na > nb) return 1
      return 0
    })

    const headerPlugin = t('plugins.menuManager.col.plugin') || '扩展'
    const headerCtx = t('plugins.menuManager.col.context') || '右键菜单'
    const headerDropdown = t('plugins.menuManager.col.dropdown') || '下拉菜单'
    const headerRibbon = t('plugins.menuManager.col.ribbon') || '垂直菜单栏'
    const tip = t('plugins.menuManager.tip') || '勾选表示显示，取消勾选后对应菜单将被隐藏。'

    let html = ''
    html += `<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">${tip}</div>`
    html += `<div style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:4px;">`
    html += `<table style="width:100%;border-collapse:collapse;font-size:13px;">`
    html += `<thead><tr>`
    html += `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);">${headerPlugin}</th>`
    html += `<th style="text-align:center;padding:6px 8px;border-bottom:1px solid var(--border);">${headerCtx}</th>`
    html += `<th style="text-align:center;padding:6px 8px;border-bottom:1px solid var(--border);">${headerDropdown}</th>`
    html += `<th style="text-align:center;padding:6px 8px;border-bottom:1px solid var(--border);">${headerRibbon}</th>`
    html += `</tr></thead><tbody>`

    for (const row of rows) {
      const vis = getPluginMenuVisibility(row.pluginId)
      const ctxDisabled = !row.hasContextMenu
      const ddDisabled = !row.hasDropdownMenu
      const ribbonDisabled = !row.hasRibbonMenu

      const ctxChecked = vis.contextMenu !== false && row.hasContextMenu
      const ddChecked = vis.dropdownMenu !== false && row.hasDropdownMenu
      const ribbonChecked = vis.ribbonMenu !== false && row.hasRibbonMenu

      const ctxAttrDisabled = ctxDisabled ? ' disabled' : ''
      const ddAttrDisabled = ddDisabled ? ' disabled' : ''
      const ribbonAttrDisabled = ribbonDisabled ? ' disabled' : ''

      html += `<tr>`
      html += `<td style="padding:4px 8px;border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${row.pluginId}">${row.name || row.pluginId}</td>`
      html += `<td style="padding:4px 8px;text-align:center;border-bottom:1px solid var(--border);">`
      html += `<input type="checkbox" class="plugin-menu-manager-ctx" data-plugin-id="${row.pluginId}"${ctxChecked ? ' checked' : ''}${ctxAttrDisabled}>`
      html += `</td>`
      html += `<td style="padding:4px 8px;text-align:center;border-bottom:1px solid var(--border);">`
      html += `<input type="checkbox" class="plugin-menu-manager-dropdown" data-plugin-id="${row.pluginId}"${ddChecked ? ' checked' : ''}${ddAttrDisabled}>`
      html += `</td>`
      html += `<td style="padding:4px 8px;text-align:center;border-bottom:1px solid var(--border);">`
      html += `<input type="checkbox" class="plugin-menu-manager-ribbon" data-plugin-id="${row.pluginId}"${ribbonChecked ? ' checked' : ''}${ribbonAttrDisabled}>`
      html += `</td>`
      html += `</tr>`
    }

    html += `</tbody></table></div>`

    body.innerHTML = html

    // 绑定事件：勾选/取消复选框时更新配置
    body.querySelectorAll<HTMLInputElement>('input.plugin-menu-manager-ctx').forEach((el) => {
      el.addEventListener('change', () => {
        const id = el.getAttribute('data-plugin-id') || ''
        if (!id) return
        try {
          setPluginMenuVisibility(id, { contextMenu: el.checked })
        } catch {}
      })
    })

    body.querySelectorAll<HTMLInputElement>('input.plugin-menu-manager-dropdown').forEach((el) => {
      el.addEventListener('change', () => {
        const id = el.getAttribute('data-plugin-id') || ''
        if (!id) return
        try {
          setPluginMenuVisibility(id, { dropdownMenu: el.checked })
        } catch {}
      })
    })

    // 绑定事件：Ribbon 复选框
    body.querySelectorAll<HTMLInputElement>('input.plugin-menu-manager-ribbon').forEach((el) => {
      el.addEventListener('change', () => {
        const id = el.getAttribute('data-plugin-id') || ''
        if (!id) return
        try {
          setPluginMenuVisibility(id, { ribbonMenu: el.checked })
          // 刷新所有 Ribbon 按钮的可见性
          refreshAllRibbonButtonVisibility()
        } catch {}
      })
    })

    ov.classList.remove('hidden')
  } catch (e) {
    console.error('打开插件菜单管理窗口失败:', e)
  }
}

