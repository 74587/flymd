import { readDir, stat, mkdir, rename, remove, exists, writeTextFile, writeFile, readFile, watchImmediate } from '@tauri-apps/plugin-fs'
import { t } from './i18n'
import appIconUrl from '../Flymdnew.png?url'

export type FileTreeOptions = {
  // 获取库根目录（未设置时返回 null）
  getRoot: () => Promise<string | null>
  // 打开已有文件（双击文件触发）
  onOpenFile: (path: string) => Promise<void> | void
  // 新建文件后打开（用于默认进入编辑态）
  onOpenNewFile?: (path: string) => Promise<void> | void
  // 状态变更回调（选中/展开变化时可通知外层）
  onStateChange?: () => void
  // 文件被移动后的通知（用于外层更新当前打开文件路径等）
  onMoved?: (src: string, dst: string) => Promise<void> | void
}

export type FileTreeAPI = {
  init: (container: HTMLElement, opts: FileTreeOptions) => Promise<void>
  refresh: () => Promise<void>
  getSelectedDir: () => string | null
  newFileInSelected: () => Promise<void>
  newFolderInSelected: () => Promise<void>
  // 设置排序方式
  setSort: (mode: 'name_asc' | 'name_desc' | 'mtime_asc' | 'mtime_desc') => void
}

const state = {
  container: null as HTMLElement | null,
  opts: null as FileTreeOptions | null,
  expanded: new Set<string>(),
  selected: null as string | null,
  selectedIsDir: false,
  watching: false,
  unwatch: null as null | (() => void),
  sortMode: 'name_asc' as 'name_asc' | 'name_desc' | 'mtime_asc' | 'mtime_desc',
  currentRoot: null as string | null,
}

const EXPANDED_KEY_PREFIX = 'flymd:libExpanded:'
function expandedStorageKey(root: string) {
  return `${EXPANDED_KEY_PREFIX}${root}`
}

function restoreExpandedState(root: string | null) {
  state.expanded = new Set<string>()
  if (!root) return
  let restored = false
  try {
    const raw = localStorage.getItem(expandedStorageKey(root))
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        restored = true
        for (const item of arr) {
          if (typeof item === 'string') state.expanded.add(item)
        }
      }
    }
  } catch {}
  if (!restored) state.expanded.add(root)
}

function persistExpandedState() {
  try {
    const root = state.currentRoot
    if (!root) return
    const arr = Array.from(state.expanded)
    localStorage.setItem(expandedStorageKey(root), JSON.stringify(arr))
  } catch {}
}

function setExpandedState(path: string, expanded: boolean) {
  state.expanded[expanded ? 'add' : 'delete'](path)
  persistExpandedState()
}

// 目录递归包含受支持文档的缓存
const hasDocCache = new Map<string, boolean>()
const hasDocPending = new Map<string, Promise<boolean>>()

function sep(p: string): string { return p.includes('\\') ? '\\' : '/' }
function norm(p: string): string { return p.replace(/[\\/]+/g, sep(p)) }
function join(a: string, b: string): string { const s = sep(a); return (a.endsWith(s) ? a : a + s) + b }
function base(p: string): string { return p.split(/[\\/]+/).slice(0, -1).join(sep(p)) }
function nameOf(p: string): string { const n = p.split(/[\\/]+/).pop() || p; return n }
function isInside(root: string, p: string): boolean { const r = norm(root).toLowerCase(); const q = norm(p).toLowerCase(); const s = r.endsWith(sep(r)) ? r : r + sep(r); return q.startsWith(s) }

async function ensureDir(dir: string) { try { await mkdir(dir, { recursive: true } as any) } catch {} }

async function moveFileSafe(src: string, dst: string): Promise<void> {
  try { await rename(src, dst) } catch {
    const data = await readFile(src)
    await ensureDir(base(dst))
    await writeFile(dst, data as any)
    try { await remove(src) } catch {}
  }
}

async function newFileSafe(dir: string, hint = '新建文档.md'): Promise<string> {
  const s = sep(dir)
  let n = hint, i = 1
  while (await exists(dir + s + n)) {
    const m = hint.match(/^(.*?)(\.[^.]+)$/); const stem = m ? m[1] : hint; const ext = m ? m[2] : ''
    n = `${stem} ${++i}${ext}`
  }
  const full = dir + s + n
  await ensureDir(dir)
  await writeTextFile(full, '# 标题\n\n', {} as any)
  return full
}

async function newFolderSafe(dir: string, hint = '新建文件夹'): Promise<string> {
  const s = sep(dir)
  let n = hint, i = 1
  while (await exists(dir + s + n)) { n = `${hint} ${++i}` }
  const full = dir + s + n
  await mkdir(full, { recursive: true } as any)
  // 创建一个占位文件，使文件夹在库侧栏中可见
  const placeholder = full + s + 'README.md'
  await writeTextFile(placeholder, '# ' + n + '\n\n', {} as any)
  return full
}

function saveSelection(path: string, isDir: boolean, row: HTMLElement) {
  state.selected = path
  state.selectedIsDir = isDir
  try {
    state.container?.querySelectorAll('.lib-node.selected').forEach(el => el.classList.remove('selected'))
  } catch {}
  row.classList.add('selected')
  state.opts?.onStateChange?.()
}

function toMtimeMs(meta: any): number {
  try {
    const cands = [
      meta?.modifiedAt,
      meta?.modifiedTime,
      meta?.mtimeMs,
      meta?.mtime,
      meta?.modificationTime,
      meta?.st_mtime_ms,
      meta?.st_mtime,
      meta?.changedAt,
      meta?.ctimeMs,
      meta?.ctime,
    ]
    for (const v of cands) {
      if (v == null) continue
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
      if (typeof v === 'string') {
        const t = Date.parse(v)
        if (Number.isFinite(t)) return t
      }
      try { if (v instanceof Date) { const t = (v as Date).getTime(); if (Number.isFinite(t)) return t } } catch {}
    }
  } catch {}
  return 0
}

async function listDir(root: string, dir: string): Promise<{ name: string; path: string; isDir: boolean }[]> {
  const items: { name: string; path: string; isDir: boolean; mtime?: number }[] = []
  let ents: any[] = []
  try { ents = await readDir(dir, { recursive: false } as any) as any[] } catch { ents = [] }
  const dirs: { name: string; path: string; isDir: boolean; mtime?: number }[] = []
  // 仅展示指定后缀的文档（md / markdown / txt / pdf）
  const allow = new Set(['md', 'markdown', 'txt', 'pdf'])
  for (const it of ents) {
  const needMtime = (state.sortMode === 'mtime_asc' || state.sortMode === 'mtime_desc')
    const p: string = typeof it?.path === 'string' ? it.path : join(dir, it?.name || '')
    let isDir = !!(it as any)?.isDirectory
    let st: any = null
    if ((it as any)?.isDirectory === undefined) {
      try { st = await stat(p) as any; isDir = !!st?.isDirectory } catch { isDir = false }
    }
    if (!st && needMtime) {
      try { st = await stat(p) as any } catch {}
    }
    if (isDir) {
      // 仅保留“包含受支持文档(递归)”的目录
      if (await dirHasSupportedDocRecursive(p, allow)) {
        dirs.push({ name: nameOf(p), path: p, isDir: true, mtime: needMtime ? toMtimeMs(st) : undefined })
      }
    } else {
      const nm = nameOf(p)
      const ext = (nm.split('.').pop() || '').toLowerCase()
       if (allow.has(ext)) items.push({ name: nm, path: p, isDir: false, mtime: needMtime ? toMtimeMs(st) : undefined })
    }
  }
  const byNameAsc = (a: any, b: any) => a.name.localeCompare(b.name)
  const byNameDesc = (a: any, b: any) => -a.name.localeCompare(b.name)
  const byMtimeAsc = (a: any, b: any) => ((a.mtime ?? 0) - (b.mtime ?? 0))
  const byMtimeDesc = (a: any, b: any) => ((b.mtime ?? 0) - (a.mtime ?? 0))

  if (state.sortMode === 'name_asc') { dirs.sort(byNameAsc); items.sort(byNameAsc) }
  else if (state.sortMode === 'name_desc') { dirs.sort(byNameDesc); items.sort(byNameDesc) }
  else if (state.sortMode === 'mtime_asc') { dirs.sort(byMtimeAsc); items.sort(byMtimeAsc) }
  else if (state.sortMode === 'mtime_desc') { dirs.sort(byMtimeDesc); items.sort(byMtimeDesc) }
  else { dirs.sort(byNameAsc); items.sort(byNameAsc) }
  return [...dirs, ...items]
}

// 递归判断目录是否包含受支持文档（带缓存）
async function dirHasSupportedDocRecursive(dir: string, allow: Set<string>, depth = 20): Promise<boolean> {
  try {
    if (hasDocCache.has(dir)) return hasDocCache.get(dir) as boolean
    if (hasDocPending.has(dir)) return await (hasDocPending.get(dir) as Promise<boolean>)

    const p = (async (): Promise<boolean> => {
      if (depth <= 0) { hasDocCache.set(dir, false); return false }
      let entries: any[] = []
      try { entries = await readDir(dir, { recursive: false } as any) as any[] } catch { entries = [] }
      // 先扫描本层文件
      for (const it of (entries || [])) {
        const full: string = typeof it?.path === 'string' ? it.path : join(dir, it?.name || '')
        let isDir = false
         if ((it as any)?.isDirectory !== undefined) { isDir = !!(it as any)?.isDirectory } else { try { isDir = !!(await stat(full) as any)?.isDirectory } catch { isDir = false } }
        if (!isDir) {
          const nm = nameOf(full)
          const ext = (nm.split('.').pop() || '').toLowerCase()
          if (allow.has(ext)) { hasDocCache.set(dir, true); return true }
        }
      }
      // 再递归子目录
      for (const it of (entries || [])) {
        const full: string = typeof it?.path === 'string' ? it.path : join(dir, it?.name || '')
        let isDir = false
         if ((it as any)?.isDirectory !== undefined) { isDir = !!(it as any)?.isDirectory } else { try { isDir = !!(await stat(full) as any)?.isDirectory } catch { isDir = false } }
        if (isDir) {
          const ok = await dirHasSupportedDocRecursive(full, allow, depth - 1)
          if (ok) { hasDocCache.set(dir, true); return true }
        }
      }
      hasDocCache.set(dir, false)
      return false
    })()
    hasDocPending.set(dir, p)
    const r = await p
    hasDocPending.delete(dir)
    return r
  } catch { return false }
}

function makeTg(): HTMLElement { const s = document.createElementNS('http://www.w3.org/2000/svg','svg'); s.setAttribute('viewBox','0 0 24 24'); s.classList.add('lib-tg'); const p=document.createElementNS('http://www.w3.org/2000/svg','path'); p.setAttribute('d','M9 6l6 6-6 6'); s.appendChild(p); return s as any }
function makeFolderIcon(path?: string): HTMLElement {
  const span=document.createElement('span')
  span.className='lib-ico lib-ico-folder'
  // 优先使用单个文件夹的自定义图标，其次使用全局默认
  let icon = '🗂️'
  try {
    if (path) {
      const customIcons = JSON.parse(localStorage.getItem('flymd:folderIcons') || '{}')
      if (customIcons[path]) icon = customIcons[path]
      else {
        const prefs = JSON.parse(localStorage.getItem('flymd:theme:prefs') || '{}')
        if (prefs.folderIcon) icon = prefs.folderIcon
      }
    } else {
      const prefs = JSON.parse(localStorage.getItem('flymd:theme:prefs') || '{}')
      if (prefs.folderIcon) icon = prefs.folderIcon
    }
  } catch {}
  span.textContent = icon
  span.style.fontSize = '16px'
  return span as any
}

async function buildDir(root: string, dir: string, parent: HTMLElement) {
  parent.innerHTML = ''
  const entries = await listDir(root, dir)
  for (const e of entries) {
    const row = document.createElement('div')
    row.className = 'lib-node ' + (e.isDir ? 'lib-dir' : 'lib-file')
    ;(row as any).dataset.path = e.path
    const label = document.createElement('span')
    label.className = 'lib-name'
    label.textContent = e.name

    if (e.isDir) {
      const tg = makeTg()
      const ico = makeFolderIcon(e.path)
      row.appendChild(tg); row.appendChild(ico); row.appendChild(label)
      const kids = document.createElement('div')
      kids.className = 'lib-children'
      kids.style.display = 'none'
      parent.appendChild(row)
      parent.appendChild(kids)

      const exp = state.expanded.has(e.path)
      if (exp) { kids.style.display = ''; row.classList.add('expanded'); await buildDir(root, e.path, kids) }

      row.addEventListener('click', async (ev) => {
        const was = state.expanded.has(e.path)
        if (ev.detail === 2) return
        saveSelection(e.path, true, row)
        const now = !was
        setExpandedState(e.path, now)
        kids.style.display = now ? '' : 'none'
        row.classList.toggle('expanded', now)
        if (now && kids.childElementCount === 0) await buildDir(root, e.path, kids)
      })

      row.addEventListener('dragover', (ev) => {
        ev.preventDefault()
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
        row.classList.add('selected')
        console.log('[拖动] 拖动到文件夹:', e.path)
      })
      // 一些平台需要在 dragenter 同样 preventDefault，才能从“禁止”光标切到可放置
      row.addEventListener('dragenter', (ev) => { try { ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'; row.classList.add('selected') } catch {} })
      row.addEventListener('dragleave', () => { row.classList.remove('selected') })
      row.addEventListener('drop', async (ev) => {
        try {
          ev.preventDefault(); row.classList.remove('selected')
          console.log('[拖动] Drop事件触发，目标文件夹:', e.path)
          const src = ev.dataTransfer?.getData('text/plain') || ''
          if (!src) return
          const dst = join(e.path, nameOf(src))
          if (src === dst) return
          if (!isInside(root, src) || !isInside(root, dst)) return alert(t('ft.move.within'))
          let finalDst = dst
          if (await exists(dst)) {
            const choice = await conflictModal(t('ft.exists'), [t('action.overwrite'), t('action.renameAuto'), t('action.cancel')], 1)
            if (choice === 2) return
            if (choice === 1) {
              const nm = nameOf(src)
              const stem = nm.replace(/(\.[^.]+)$/,''); const ext = nm.match(/(\.[^.]+)$/)?.[1] || ''
              let i=1, cand=''
              do { cand = `${stem} ${++i}${ext}` } while (await exists(join(e.path, cand)))
              finalDst = join(e.path, cand)
              await moveFileSafe(src, finalDst)
            } else {
              await moveFileSafe(src, dst)
            }
          } else {
            await moveFileSafe(src, dst)
          }
          try { await state.opts?.onMoved?.(src, finalDst) } catch {}
          await refresh()
          console.log('[拖动] 移动完成:', src, '→', finalDst)
        } catch (err) { console.error('[拖动] 移动失败:', err) }
      })
    } else {
      // 为文件显示类型化图标：
      // - markdown/txt 使用简洁的“文档形状”图标，并显示 MD/TXT 标识
      // - pdf 使用程序图标的红色变体（通过 CSS 滤镜实现区分）
      // - 其他类型使用程序图标
      const ext = (() => { try { return (e.name.split('.').pop() || '').toLowerCase() } catch { return '' } })()
      let iconEl: HTMLElement
      if (ext === 'md' || ext === 'markdown') {
        // 按照用户要求：MD 图标保持原样（程序图标），不要改动
        const img = document.createElement('img')
        img.className = 'lib-ico lib-ico-app'
        try { img.setAttribute('src', appIconUrl) } catch {}
        iconEl = img
      } else if (ext === 'txt') {
        const span = document.createElement('span')
        span.className = 'lib-ico lib-ico-file lib-ico-txt'
        iconEl = span
      } else if (ext === 'pdf') {
        const img = document.createElement('img')
        img.className = 'lib-ico lib-ico-app lib-ico-pdf'
        try { img.setAttribute('src', appIconUrl) } catch {}
        iconEl = img
      } else {
        const img = document.createElement('img')
        img.className = 'lib-ico lib-ico-app'
        try { img.setAttribute('src', appIconUrl) } catch {}
        iconEl = img
      }
      // 让图标与文字都成为可拖拽起点（某些内核仅触发“被按住元素”的拖拽，不会透传到父元素）
      try { iconEl.setAttribute('draggable', 'true') } catch {}
      try { label.setAttribute('draggable', 'true') } catch {}
      // 统一的拖拽启动处理（Edge/WebView2 兼容：设置 dataTransfer 与拖拽影像）
      let nativeDragStarted = false
      const startDrag = (ev: DragEvent) => {
        try {
          ev.stopPropagation()
          const dt = ev.dataTransfer
          if (!dt) return
          nativeDragStarted = true
          // 必须至少写入一种类型的数据，否则某些内核会判定为“无效拖拽”
          dt.setData('text/plain', e.path)
          // 兼容某些解析器：附带 URI 列表
          try {
            const fileUrl = (() => {
              try {
                const p = e.path.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, 'file:///$1:/')
                return p.startsWith('file:///') ? p : ('file:///' + p.replace(/^\//, ''))
              } catch { return '' }
            })()
            if (fileUrl) dt.setData('text/uri-list', fileUrl)
          } catch {}
          // 允许移动/复制（由目标决定 dropEffect）
          dt.effectAllowed = 'copyMove'
          // 提供拖拽影像，避免出现无预览时的“禁止”提示
          try { dt.setDragImage(row, 4, 4) } catch {}
        } catch {}
      }
      row.addEventListener('dragstart', startDrag)
      iconEl.addEventListener('dragstart', startDrag as any)
      label.addEventListener('dragstart', startDrag as any)
      // 自绘拖拽兜底：在某些 WebView2 场景下，原生 DnD 会一直显示禁止图标，
      // 我们在移动阈值触发后启用自绘拖拽，模拟“拖到文件夹释放即可移动”。
      const setupFallbackDrag = (host: HTMLElement) => {
        let down = false, sx = 0, sy = 0, moved = false
        let ghost: HTMLDivElement | null = null
        let hoverEl: HTMLElement | null = null
        let prevRowDraggable: string | null = null
        let prevIconDraggable: string | null = null
        let prevLabelDraggable: string | null = null
        const suppressClick = (ev: MouseEvent) => { if (moved) { ev.stopImmediatePropagation(); ev.preventDefault() } }
        const restoreDraggable = () => {
          try { if (prevRowDraggable !== null) row.setAttribute('draggable', prevRowDraggable); else row.removeAttribute('draggable') } catch {}
          try { if (prevIconDraggable !== null) (iconEl as any).setAttribute('draggable', prevIconDraggable); else (iconEl as any).removeAttribute('draggable') } catch {}
          try { if (prevLabelDraggable !== null) label.setAttribute('draggable', prevLabelDraggable); else label.removeAttribute('draggable') } catch {}
        }
        const onMove = (ev: MouseEvent) => {
          if (!down) return
          // 若原生拖拽已经启动，放弃兜底
          if (nativeDragStarted) { cleanup(); return }
          const dx = ev.clientX - sx, dy = ev.clientY - sy
          if (!moved && Math.hypot(dx, dy) > 6) {
            moved = true
            ghost = document.createElement('div')
            ghost.className = 'ft-ghost'
            // 图标
            const gico = document.createElement('img')
            try { gico.setAttribute('src', appIconUrl) } catch {}
            gico.style.width = '16px'
            gico.style.height = '16px'
            gico.style.borderRadius = '3px'
            gico.style.objectFit = 'cover'
            gico.style.marginRight = '6px'
            // 文本
            const glab = document.createElement('span')
            glab.textContent = e.name
            glab.style.fontSize = '12px'
            // 组合
            ghost.appendChild(gico)
            ghost.appendChild(glab)
            // 位置与通用样式（兜底）
            ghost.style.position = 'fixed'
            ghost.style.left = ev.clientX + 8 + 'px'
            ghost.style.top = ev.clientY + 8 + 'px'
            ghost.style.padding = '6px 10px'
            ghost.style.background = 'rgba(17,17,17,0.85)'
            ghost.style.color = '#fff'
            ghost.style.borderRadius = '8px'
            ghost.style.boxShadow = '0 4px 12px rgba(0,0,0,0.35)'
            ghost.style.pointerEvents = 'none'
            ghost.style.zIndex = '99999'
            document.body.appendChild(ghost)
            try { document.body.style.cursor = 'grabbing' } catch {}
            try { document.body.style.userSelect = 'none' } catch {}
          }
          if (moved && ghost) {
            ghost.style.left = ev.clientX + 8 + 'px'
            ghost.style.top = ev.clientY + 8 + 'px'
            // 命中测试：查找鼠标下的目录节点
            let el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
            let tgt = el?.closest?.('.lib-node.lib-dir') as HTMLElement | null
            if (hoverEl && hoverEl !== tgt) hoverEl.classList.remove('selected')
            if (tgt) tgt.classList.add('selected')
            hoverEl = tgt
          }
          try { ev.preventDefault() } catch {}
        }
        const finish = async () => {
          try {
            const base = (hoverEl as any)?.dataset?.path as string | undefined
            if (!moved || !base) return
            const root = await state.opts!.getRoot()
            if (!root) return
            const dst = join(base, nameOf(e.path))
            if (e.path === dst) return
            if (!isInside(root, e.path) || !isInside(root, dst)) { alert(t('ft.move.within')); return }
            let finalDst = dst
            if (await exists(dst)) {
              try { if (ghost) ghost.style.display = 'none' } catch {}
              const choice = await conflictModal(t('ft.exists'), [t('action.overwrite'), t('action.renameAuto'), t('action.cancel')], 1)
              if (choice === 2) return
              if (choice === 1) {
                const nm = nameOf(e.path)
                const stem = nm.replace(/(\.[^.]+)$/,''); const ext = nm.match(/(\.[^.]+)$/)?.[1] || ''
                let i=1, cand=''
                do { cand = `${stem} ${++i}${ext}` } while (await exists(join(base, cand)))
                finalDst = join(base, cand)
                await moveFileSafe(e.path, finalDst)
              } else {
                await moveFileSafe(e.path, dst)
              }
            } else {
              await moveFileSafe(e.path, dst)
            }
            try { await state.opts?.onMoved?.(e.path, finalDst) } catch {}
            await refresh()
          } catch (err) { console.error('[拖动] 兜底移动失败:', err) }
        }
        const cleanup = () => {
          document.removeEventListener('mousemove', onMove)
          down = false
          moved = false
          try { if (ghost && ghost.parentElement) ghost.parentElement.removeChild(ghost) } catch {}
          try { document.querySelectorAll('.ft-ghost').forEach((el) => { try { (el as any).parentElement?.removeChild(el) } catch {} }) } catch {}
          try { document.body.style.cursor = '' } catch {}
          try { document.body.style.userSelect = '' } catch {}
          ghost = null
          if (hoverEl) hoverEl.classList.remove('selected')
          hoverEl = null
          try { host.removeEventListener('click', suppressClick, true) } catch {}
          restoreDraggable()
        }
        const onDown = (ev: MouseEvent) => {
          if (ev.button !== 0) return
          // 允许文本选择/点击，不阻止默认；兜底触发依靠移动阈值
          down = true; sx = ev.clientX; sy = ev.clientY; moved = false; nativeDragStarted = false
          try { ev.stopPropagation() } catch {}
          // 暂时禁用原生 DnD，避免阻断 mousemove
          try {
            prevRowDraggable = row.getAttribute('draggable')
            prevIconDraggable = (iconEl as any).getAttribute?.('draggable') ?? null
            prevLabelDraggable = label.getAttribute('draggable')
            row.removeAttribute('draggable')
            ;(iconEl as any).removeAttribute?.('draggable')
            label.removeAttribute('draggable')
          } catch {}
          try { host.addEventListener('click', suppressClick, true) } catch {}
          document.addEventListener('mousemove', onMove)
          const onUp = async () => { document.removeEventListener('mouseup', onUp); if (!nativeDragStarted) { await finish() } cleanup() }
          document.addEventListener('mouseup', onUp, { once: true })
        }
        host.addEventListener('mousedown', onDown, true)
      }
      // 将兜底拖拽仅绑定到整行，避免多次绑定造成多个“幽灵”遗留
      setupFallbackDrag(row)
      row.appendChild(iconEl); row.appendChild(label)
      try { if (ext) row.classList.add('file-ext-' + ext) } catch {}

      // 单击加载文档并保持选中
      row.addEventListener('click', async () => { saveSelection(e.path, false, row); try { await state.opts?.onOpenFile(e.path) } catch {} })
      // 双击加载，兼容旧习惯
      row.addEventListener('dblclick', async () => { await state.opts?.onOpenFile(e.path) })

      row.setAttribute('draggable','true')

      parent.appendChild(row)
    }
  }
}

async function renderRoot(root: string) {
  if (!state.container) return
  state.container.innerHTML = ''
  const topRow = document.createElement('div')
  topRow.className = 'lib-node lib-dir'
  ;(topRow as any).dataset.path = root
  const tg = makeTg(); const ico = makeFolderIcon(root); const label = document.createElement('span'); label.className='lib-name'; label.textContent = nameOf(root) || root
  topRow.appendChild(tg); topRow.appendChild(ico); topRow.appendChild(label)
  const kids = document.createElement('div')
  kids.className = 'lib-children'
  state.container.appendChild(topRow)
  state.container.appendChild(kids)
  const rootExpanded = state.expanded.has(root)
  topRow.classList.toggle('expanded', rootExpanded)
  kids.style.display = rootExpanded ? '' : 'none'
  if (rootExpanded) await buildDir(root, root, kids)

  // 刷新后恢复选中态
  try {
    if (state.selected) {
      const all = Array.from(state.container.querySelectorAll('.lib-node')) as HTMLElement[]
      const hit = all.find((el) => (el as any).dataset?.path === state.selected)
      if (hit) { hit.classList.add('selected') }
    }
  } catch {}

  // 根节点的拖放处理
  topRow.addEventListener('dragover', (ev) => {
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
    topRow.classList.add('selected')
    console.log('[拖动] 拖动到根文件夹:', root)
  })
  topRow.addEventListener('dragenter', (ev) => { try { ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'; topRow.classList.add('selected') } catch {} })
  topRow.addEventListener('dragleave', () => { topRow.classList.remove('selected') })
  topRow.addEventListener('drop', async (ev) => {
    try {
      ev.preventDefault(); topRow.classList.remove('selected')
      const src = ev.dataTransfer?.getData('text/plain') || ''
      if (!src) return
      const dst = join(root, nameOf(src))
      if (src === dst) return
      if (!isInside(root, src) || !isInside(root, dst)) return alert(t('ft.move.within'))
      let finalDst = dst
      if (await exists(dst)) {
        const choice = await conflictModal(t('ft.exists'), [t('action.overwrite'), t('action.renameAuto'), t('action.cancel')], 1)
        if (choice === 2) return
        if (choice === 1) {
          const nm = nameOf(src)
          const stem = nm.replace(/(\.[^.]+)$/,''); const ext = nm.match(/(\.[^.]+)$/)?.[1] || ''
          let i=1, cand=''
          do { cand = `${stem} ${++i}${ext}` } while (await exists(join(root, cand)))
          finalDst = join(root, cand)
          await moveFileSafe(src, finalDst)
        } else {
          await moveFileSafe(src, dst)
        }
      } else {
        await moveFileSafe(src, dst)
      }
      try { await state.opts?.onMoved?.(src, finalDst) } catch {}
      await refresh()
      console.log('[拖动] 移动完成:', src, '→', finalDst)
    } catch (err) { console.error('[拖动] 移动失败:', err) }
  })

  topRow.addEventListener('click', async () => {
    const was = state.expanded.has(root)
    const now = !was
    setExpandedState(root, now)
    kids.style.display = now ? '' : 'none'
    topRow.classList.toggle('expanded', now)
    if (now && kids.childElementCount === 0) await buildDir(root, root, kids)
  })
}

async function refresh() {
  const root = await state.opts!.getRoot()
  // 若未选择库目录，不再在侧栏显示提示，保持空白即可，避免误导用户
  if (!root) {
    state.currentRoot = null
    state.expanded = new Set<string>()
    if (state.container) state.container.innerHTML = ''
    return
  }
  state.currentRoot = root
  restoreExpandedState(root)
  // 刷新前清理目录缓存，确保显示与实际文件状态一致
  try { hasDocCache.clear(); hasDocPending.clear() } catch {}
  await renderRoot(root)
}

async function init(container: HTMLElement, opts: FileTreeOptions) {
  state.container = container; state.opts = opts
  // 兜底：在整个文件树区域内允许 dragover，避免出现全局“禁止”光标
  try {
    container.addEventListener('dragover', (ev) => { ev.preventDefault() })
  } catch {}
  await refresh()
  if (!state.watching) {
    try {
      const root = await state.opts.getRoot(); if (root) {
        const u = await watchImmediate(root, { recursive: true } as any, async () => { await refresh() })
        state.unwatch = () => { try { (u as any).unwatch?.(); } catch {} }
        state.watching = true
      }
    } catch { /* ignore */ }
  }
}

async function newFileInSelected() {
  const root = await state.opts!.getRoot()
  if (!root) return
  const dir = state.selectedIsDir ? (state.selected || root) : base(state.selected || root)
  const p = await newFileSafe(dir)
  if (state.opts?.onOpenNewFile) await state.opts.onOpenNewFile(p); else await state.opts!.onOpenFile(p)
  await refresh()
}

async function newFolderInSelected() {
  const root = await state.opts!.getRoot(); if (!root) return
  const dir = state.selectedIsDir ? (state.selected || root) : base(state.selected || root)
  await newFolderSafe(dir)
  await refresh()
}

async function conflictModal(title: string, actions: string[], defaultIndex = 1): Promise<number> {
  return await new Promise<number>((resolve) => {
    try {
      let dom = document.getElementById('ft-modal') as HTMLDivElement | null
      if (!dom) {
        dom = document.createElement('div'); dom.id='ft-modal'; dom.style.position='fixed'; dom.style.inset='0'; dom.style.background='rgba(0,0,0,0.35)'; dom.style.display='flex'; dom.style.alignItems='center'; dom.style.justifyContent='center'; dom.style.zIndex='9999'
        const box = document.createElement('div'); box.className='ft-box'; box.style.background='var(--bg)'; box.style.color='var(--fg)'; box.style.border='1px solid var(--border)'; box.style.borderRadius='12px'; box.style.boxShadow='0 12px 36px rgba(0,0,0,0.2)'; box.style.minWidth='320px'; box.style.maxWidth='80vw'
        const hd = document.createElement('div'); hd.style.padding='12px 16px'; hd.style.fontWeight='600'; hd.style.borderBottom='1px solid var(--border)'; box.appendChild(hd)
        const bd = document.createElement('div'); bd.style.padding='14px 16px'; box.appendChild(bd)
        const ft = document.createElement('div'); ft.style.display='flex'; ft.style.gap='8px'; ft.style.justifyContent='flex-end'; ft.style.padding='8px 12px'; ft.style.borderTop='1px solid var(--border)'; box.appendChild(ft)
        dom.appendChild(box)
        document.body.appendChild(dom)
      }
      const box = dom.firstElementChild as HTMLDivElement
      const hd = box.children[0] as HTMLDivElement
      const bd = box.children[1] as HTMLDivElement
      const ft = box.children[2] as HTMLDivElement
      hd.textContent = title
      bd.textContent = t('ft.conflict.prompt')
      ft.innerHTML = ''
      actions.forEach((txt, idx) => {
        const b = document.createElement('button') as HTMLButtonElement
        b.textContent = txt
        b.style.border='1px solid var(--border)'; b.style.borderRadius='8px'; b.style.padding='6px 12px'; b.style.background= idx===defaultIndex ? '#2563eb' : 'rgba(127,127,127,0.08)'; b.style.color = idx===defaultIndex ? '#fff' : 'var(--fg)'
        b.addEventListener('click', () => { dom!.style.display='none'; resolve(idx) })
        ft.appendChild(b)
      })
      dom.style.display='flex'
    } catch { resolve(defaultIndex) }
  })
}

// 24个可选图标
export const FOLDER_ICONS = ['📁', '📂', '🗂️', '🗃️', '🗄️', '📚', '📖', '📕', '📗', '📘', '📙', '📓', '📔', '📋', '📑', '📦', '🎯', '⭐', '🔖', '💼', '🎨', '🔧', '⚙️', '🏠']

export async function folderIconModal(folderName: string, icons: string[]): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    try {
      let dom = document.getElementById('folder-icon-modal') as HTMLDivElement | null
      if (!dom) {
        dom = document.createElement('div'); dom.id='folder-icon-modal'; dom.style.position='fixed'; dom.style.inset='0'; dom.style.background='rgba(0,0,0,0.35)'; dom.style.display='flex'; dom.style.alignItems='center'; dom.style.justifyContent='center'; dom.style.zIndex='9999'
        const box = document.createElement('div'); box.className='ft-box'; box.style.background='var(--bg)'; box.style.color='var(--fg)'; box.style.border='1px solid var(--border)'; box.style.borderRadius='12px'; box.style.boxShadow='0 12px 36px rgba(0,0,0,0.2)'; box.style.minWidth='320px'; box.style.maxWidth='80vw'
        const hd = document.createElement('div'); hd.style.padding='12px 16px'; hd.style.fontWeight='600'; hd.style.borderBottom='1px solid var(--border)'; box.appendChild(hd)
        const bd = document.createElement('div'); bd.style.padding='14px 16px'; bd.style.display='grid'; bd.style.gridTemplateColumns='repeat(8, 1fr)'; bd.style.gap='8px'; box.appendChild(bd)
        const ft = document.createElement('div'); ft.style.display='flex'; ft.style.gap='8px'; ft.style.justifyContent='flex-end'; ft.style.padding='8px 12px'; ft.style.borderTop='1px solid var(--border)'; box.appendChild(ft)
        dom.appendChild(box)
        document.body.appendChild(dom)
      }
      const box = dom.firstElementChild as HTMLDivElement
      const hd = box.children[0] as HTMLDivElement
      const bd = box.children[1] as HTMLDivElement
      const ft = box.children[2] as HTMLDivElement
      hd.textContent = `${folderName} - 选择图标`
      bd.innerHTML = ''
      icons.forEach((icon, idx) => {
        const btn = document.createElement('button')
        btn.textContent = icon
        btn.style.fontSize = '24px'
        btn.style.width = '48px'
        btn.style.height = '48px'
        btn.style.border = '1px solid var(--border)'
        btn.style.borderRadius = '8px'
        btn.style.background = 'rgba(127,127,127,0.04)'
        btn.style.cursor = 'pointer'
        btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(127,127,127,0.12)' })
        btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(127,127,127,0.04)' })
        btn.addEventListener('click', () => { dom!.style.display='none'; resolve(idx) })
        bd.appendChild(btn)
      })
      ft.innerHTML = ''
      const cancelBtn = document.createElement('button')
      cancelBtn.textContent = '取消'
      cancelBtn.style.border='1px solid var(--border)'; cancelBtn.style.borderRadius='8px'; cancelBtn.style.padding='6px 12px'; cancelBtn.style.background='rgba(127,127,127,0.08)'; cancelBtn.style.color='var(--fg)'
      cancelBtn.addEventListener('click', () => { dom!.style.display='none'; resolve(null) })
      ft.appendChild(cancelBtn)
      dom.style.display='flex'
    } catch { resolve(null) }
  })
}

export const fileTree: FileTreeAPI = {
  init, refresh,
  getSelectedDir: () => (state.selectedIsDir ? (state.selected || null) : (state.selected ? base(state.selected) : null)),
  newFileInSelected, newFolderInSelected,
  setSort: (mode) => { state.sortMode = mode },
}

export default fileTree
