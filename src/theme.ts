// 主题系统（中文注释）
// - 目标：
//   1) 提供“主题”入口（按钮由 main.ts 注入），显示一个面板选择颜色与排版
//   2) 支持编辑/所见/阅读三种模式独立背景色
//   3) 预留扩展 API：注册颜色、注册排版、注册整套主题
//   4) 首次启动应用保存的主题自动生效
// - 实现策略：
//   使用 .container 作用域内的 CSS 变量覆盖（--bg / --wysiwyg-bg / --preview-bg），避免影响标题栏等外围 UI。

export type TypographyId = 'default' | 'serif' | 'modern' | 'reading' | 'academic'
// 运行期依赖（仅在需要时使用）
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile, mkdir, exists, remove, BaseDirectory } from '@tauri-apps/plugin-fs'
import { homeDir, desktopDir, join } from '@tauri-apps/api/path'
export type MdStyleId = 'standard' | 'github' | 'notion' | 'journal' | 'card' | 'docs'

export interface ThemePrefs {
  editBg: string
  readBg: string
  wysiwygBg: string
  typography: TypographyId
  mdStyle: MdStyleId
  themeId?: string
  /** 自定义正文字体（预览/WYSIWYG 正文），为空则使用默认/排版风格 */
  bodyFont?: string
  /** 自定义等宽字体（编辑器与代码），为空则使用系统等宽栈 */
  monoFont?: string
}

export interface ThemeDefinition {
  id: string
  label: string
  colors?: Partial<Pick<ThemePrefs, 'editBg' | 'readBg' | 'wysiwygBg'>>
  typography?: TypographyId
  mdStyle?: MdStyleId
}

const STORE_KEY = 'flymd:theme:prefs'

const DEFAULT_PREFS: ThemePrefs = {
  editBg: '#ffffff',
  readBg: getCssVar('--preview-bg') || '#fbf5e6',
  wysiwygBg: getCssVar('--wysiwyg-bg') || '#e9edf5',
  typography: 'default',
  mdStyle: 'standard',
}

const _themes = new Map<string, ThemeDefinition>()
const _palettes: Array<{ id: string; label: string; color: string }> = []

// 工具：读当前 :root/.container 上的变量（若无则返回空串）
function getCssVar(name: string): string {
  try {
    const el = document.documentElement
    const v = getComputedStyle(el).getPropertyValue(name)
    return (v || '').trim()
  } catch { return '' }
}

function getContainer(): HTMLElement | null {
  return document.querySelector('.container') as HTMLElement | null
}

export function applyThemePrefs(prefs: ThemePrefs): void {
  try {
    const c = getContainer()
    if (!c) return
    // 仅作用于容器作用域，避免 titlebar/弹窗等也跟随变色
    c.style.setProperty('--bg', prefs.editBg)
    c.style.setProperty('--preview-bg', prefs.readBg)
    c.style.setProperty('--wysiwyg-bg', prefs.wysiwygBg)
    // 字体变量（为空则移除，回退默认）
    try {
      const bodyFont = (prefs.bodyFont || '').trim()
      const monoFont = (prefs.monoFont || '').trim()
      if (bodyFont) c.style.setProperty('--font-body', bodyFont)
      else c.style.removeProperty('--font-body')
      if (monoFont) c.style.setProperty('--font-mono', monoFont)
      else c.style.removeProperty('--font-mono')
    } catch {}

    // 排版：通过类名挂到 .container 上，覆盖 .preview-body 与 .ProseMirror
    c.classList.remove('typo-serif', 'typo-modern', 'typo-reading', 'typo-academic')
    if (prefs.typography === 'serif') c.classList.add('typo-serif')
    else if (prefs.typography === 'modern') c.classList.add('typo-modern')
    else if (prefs.typography === 'reading') c.classList.add('typo-reading')
    else if (prefs.typography === 'academic') c.classList.add('typo-academic')

    // Markdown 风格类名
    c.classList.remove('md-standard', 'md-github', 'md-notion', 'md-journal', 'md-card', 'md-docs')
    const mdClass = `md-${prefs.mdStyle || 'standard'}`
    c.classList.add(mdClass)

    // 触发主题变更事件（扩展可监听）
    try {
      const ev = new CustomEvent('flymd:theme:changed', { detail: { prefs } })
      window.dispatchEvent(ev)
    } catch {}
  } catch {}
}

export function saveThemePrefs(prefs: ThemePrefs): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)) } catch {}
}

export function loadThemePrefs(): ThemePrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const obj = JSON.parse(raw)
    let mdStyle: any = obj.mdStyle
    // 兼容：若历史保存为 terminal，则回退为 standard
    if (mdStyle === 'terminal') mdStyle = 'standard'
    return {
      editBg: obj.editBg || DEFAULT_PREFS.editBg,
      readBg: obj.readBg || DEFAULT_PREFS.readBg,
      wysiwygBg: obj.wysiwygBg || DEFAULT_PREFS.wysiwygBg,
      typography: (['default','serif','modern','reading','academic'] as string[]).includes(obj.typography) ? obj.typography : 'default',
      mdStyle: (['standard','github','notion','journal','card','docs'] as string[]).includes(mdStyle) ? mdStyle : 'standard',
      themeId: obj.themeId || undefined,
      bodyFont: (typeof obj.bodyFont === 'string') ? obj.bodyFont : undefined,
      monoFont: (typeof obj.monoFont === 'string') ? obj.monoFont : undefined,
    }
  } catch { return { ...DEFAULT_PREFS } }
}

export function applySavedTheme(): void {
  const prefs = loadThemePrefs()
  applyThemePrefs(prefs)
}

// ===== 扩展 API（对外暴露到 window.flymdTheme）=====
function registerTheme(def: ThemeDefinition): void {
  if (!def || !def.id) return
  _themes.set(def.id, def)
}
function registerPalette(label: string, color: string, id?: string): void {
  const _id = id || `ext-${Math.random().toString(36).slice(2, 8)}`
  _palettes.push({ id: _id, label, color })
}
function registerTypography(id: TypographyId, label: string, css?: string): void {
  // 仅允许 'default' | 'serif' | 'modern' 三选；如需更多可扩展此处分支
  if (!['default', 'serif', 'modern', 'reading', 'academic'].includes(id)) return
  if (css) {
    try {
      const style = document.createElement('style')
      style.dataset.themeTypo = id
      style.textContent = css
      document.head.appendChild(style)
    } catch {}
  }
}

function registerMdStyle(id: MdStyleId, label: string, css?: string): void {
  if (!['standard','github','notion','journal','card','docs'].includes(id)) return
  if (css) {
    try {
      const style = document.createElement('style')
      style.dataset.themeMd = id
      style.textContent = css
      document.head.appendChild(style)
    } catch {}
  }
}

export const themeAPI = { registerTheme, registerPalette, registerTypography, registerMdStyle, applyThemePrefs, loadThemePrefs, saveThemePrefs }
;(window as any).flymdTheme = themeAPI

// ===== 主题 UI =====

function buildColorList(): Array<{ id: string; label: string; color: string }> {
  // 从当前 CSS 读取"所见模式当前颜色"
  const curW = getCssVar('--wysiwyg-bg') || '#e9edf5'
  const base = [
    { id: 'sys-wys', label: '所见色', color: curW },
    { id: 'pure', label: '纯白', color: '#ffffff' },
    { id: 'parch', label: '羊皮纸', color: '#fbf5e6' },
    { id: 'soft-blue', label: '淡蓝', color: '#f7f9fc' },
    // 柔和护眼色系
    { id: 'warm-gray', label: '暖灰', color: '#f6f5f1' },
    { id: 'mist-blue', label: '雾蓝', color: '#eef3f9' },
    { id: 'mint', label: '薄荷', color: '#eef8f1' },
    { id: 'ivory', label: '象牙', color: '#fffaf0' },
    // 新增护眼色系
    { id: 'beige', label: '米色', color: '#f5f5dc' },
    { id: 'sand', label: '沙色', color: '#faf8f3' },
    { id: 'cream', label: '奶油', color: '#fffef9' },
    { id: 'pearl', label: '珍珠', color: '#fafaf8' },
    // 新增冷色调
    { id: 'sky', label: '天蓝', color: '#e8f4f8' },
    { id: 'frost', label: '冰霜', color: '#f0f8ff' },
    { id: 'lavender', label: '薰衣草', color: '#f5f3ff' },
    // 新增暖色调
    { id: 'peach', label: '蜜桃', color: '#fff5ee' },
    { id: 'rose', label: '玫瑰', color: '#fff5f7' },
    { id: 'apricot', label: '杏色', color: '#fff8f0' },
  ]
  return base.concat(_palettes)
}

function createPanel(): HTMLDivElement {
  const panel = document.createElement('div')
  panel.className = 'theme-panel hidden'
  panel.id = 'theme-panel'
  panel.innerHTML = `
    <div class="theme-section">
      <div class="theme-title">编辑背景</div>
      <div class="theme-swatches" data-target="edit"></div>
    </div>
    <div class="theme-section">
      <div class="theme-title">阅读背景</div>
      <div class="theme-swatches" data-target="read"></div>
    </div>
    <div class="theme-section">
      <div class="theme-title">所见背景</div>
      <div class="theme-swatches" data-target="wysiwyg"></div>
    </div>
    <div class="theme-section">
      <div class="theme-title">排版风格</div>
      <div class="theme-typos">
        <button class="typo-btn" data-typo="default">标准</button>
        <button class="typo-btn" data-typo="serif">经典</button>
        <button class="typo-btn" data-typo="modern">现代</button>
        <button class="typo-btn" data-typo="reading">阅读</button>
        <button class="typo-btn" data-typo="academic">学术</button>
      </div>
    </div>
    <div class="theme-section">
      <div class="theme-title">Markdown 风格</div>
      <div class="theme-md">
        <button class="md-btn" data-md="standard">标准</button>
        <button class="md-btn" data-md="github">GitHub</button>
        <button class="md-btn" data-md="notion">Notion</button>
        <button class="md-btn" data-md="journal">出版风</button>
        <button class="md-btn" data-md="card">卡片风</button>
        <button class="md-btn" data-md="docs">Docs</button>
      </div>
    </div>
    <div class="theme-section">
      <div class="theme-title">字体选择</div>
      <div class="theme-fonts">
        <label for="font-body-select">正文字体</label>
        <select id="font-body-select"></select>
        <label for="font-mono-select">等宽字体</label>
        <select id="font-mono-select"></select>
        <div class="font-actions">
      </div>
    </div>
  `
  return panel
}

function fillSwatches(panel: HTMLElement, prefs: ThemePrefs) {
  const colors = buildColorList()
  panel.querySelectorAll('.theme-swatches').forEach((wrap) => {
    const el = wrap as HTMLElement
    const tgt = el.dataset.target || 'edit'
    const cur = tgt === 'edit' ? prefs.editBg : (tgt === 'read' ? prefs.readBg : prefs.wysiwygBg)
    el.innerHTML = colors.map(({ id, label, color }) => {
      const active = (color.toLowerCase() === (cur || '').toLowerCase()) ? 'active' : ''
      const title = `${label} ${color}`
      return `<div class="theme-swatch ${active}" title="${title}" data-color="${color}" data-for="${tgt}" style="background:${color}"></div>`
    }).join('')
  })

  // 排版激活态
  panel.querySelectorAll('.typo-btn').forEach((b) => {
    const el = b as HTMLButtonElement
    const v = el.dataset.typo as TypographyId
    if (v === prefs.typography) el.classList.add('active'); else el.classList.remove('active')
  })
  // MD 风格激活态
  panel.querySelectorAll('.md-btn').forEach((b) => {
    const el = b as HTMLButtonElement
    const v = el.dataset.md as MdStyleId
    if (v === prefs.mdStyle) el.classList.add('active'); else el.classList.remove('active')
  })
}

export function initThemeUI(): void {
  try {
    const menu = document.querySelector('.menubar')
    const container = getContainer()
    if (!menu || !container) return

    let panel = document.getElementById('theme-panel') as HTMLDivElement | null
    if (!panel) {
      panel = createPanel()
      container.appendChild(panel)
    }

    const prefs = loadThemePrefs()
    let lastSaved = { ...prefs }
    fillSwatches(panel, prefs)

    // 字体选项：内置常见字体栈，首项为空表示使用默认/随排版
    const bodyOptions: Array<{ label: string; stack: string }> = [
      { label: '跟随排版（默认）', stack: '' },
      { label: '系统无衬线（系统默认）', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'" },
      { label: '现代（Inter 优先）', stack: "Inter, Roboto, 'Noto Sans', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif" },
      { label: '衬线（Georgia/思源宋体）', stack: "Georgia, 'Times New Roman', Times, 'Source Han Serif SC', serif" },
    ]
    // 扩展：追加常见系统/开源字体（仅引用名称，不随包分发）
    const moreBodyOptions: Array<{ label: string; stack: string }> = [
      { label: 'Windows 中文（微软雅黑）', stack: "'Microsoft YaHei', 'Segoe UI', 'Noto Sans', Arial, sans-serif" },
      { label: 'macOS 中文（苹方/Hiragino）', stack: "'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Source Han Sans SC', -apple-system, 'Segoe UI', Arial, sans-serif" },
      { label: '开源中文（思源黑体）', stack: "'Source Han Sans SC', 'Noto Sans CJK SC', 'Noto Sans', -apple-system, 'Segoe UI', Arial, sans-serif" },
      { label: '开源中文（思源宋体）', stack: "'Source Han Serif SC', 'Noto Serif CJK SC', 'Noto Serif', Georgia, 'Times New Roman', serif" },
      { label: 'Android/通用（Roboto）', stack: "Roboto, 'Noto Sans', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif" },
      { label: '经典无衬线（Tahoma/Verdana）', stack: "Tahoma, Verdana, Arial, Helvetica, sans-serif" },
      { label: '经典衬线（Times/宋体回退）', stack: "'Times New Roman', Times, 'SimSun', serif" },
    ]
    const moreMonoOptions: Array<{ label: string; stack: string }> = [
      { label: 'Cascadia Code', stack: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { label: 'Menlo/Monaco（macOS）', stack: "Menlo, Monaco, ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { label: 'Ubuntu Mono', stack: "'Ubuntu Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { label: 'DejaVu Sans Mono', stack: "'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace" },
      { label: 'Source Code Pro', stack: "'Source Code Pro', 'Fira Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
    ]
    const monoOptions: Array<{ label: string; stack: string }> = [
      { label: '系统等宽（默认）', stack: '' },
      { label: 'JetBrains Mono', stack: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { label: 'Fira Code', stack: "'Fira Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { label: 'Consolas 系', stack: "Consolas, 'Courier New', ui-monospace, SFMono-Regular, Menlo, Monaco, 'Liberation Mono', monospace" },
    ]

    const bodySel = panel.querySelector('#font-body-select') as HTMLSelectElement | null
    const monoSel = panel.querySelector('#font-mono-select') as HTMLSelectElement | null
    const resetBtn = panel.querySelector('#font-reset') as HTMLButtonElement | null
    const fontsWrap = panel.querySelector('.theme-fonts') as HTMLDivElement | null
    // 构造“安装字体”按钮并重组操作区（避免直接改 HTML 模板造成编码问题）
    let installBtn: HTMLButtonElement | null = null
    if (fontsWrap) {
      const actions = document.createElement('div')
      actions.className = 'font-actions'
      installBtn = document.createElement('button')
      installBtn.className = 'font-install'
      installBtn.id = 'font-install'
      installBtn.textContent = '安装字体'
      actions.appendChild(installBtn)
      if (resetBtn) actions.appendChild(resetBtn)
      fontsWrap.appendChild(actions)
    }

    // 自定义字体数据库（保存在 localStorage，仅记录元数据，文件存放于 AppLocalData/fonts）
    type CustomFont = { id: string; name: string; rel: string; ext: string; family: string }
    const FONT_DB_KEY = 'flymd:theme:fonts'
    const FONTS_DIR = 'fonts'
    function loadFontDb(): CustomFont[] {
      try { const raw = localStorage.getItem(FONT_DB_KEY); if (!raw) return []; const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr as CustomFont[] } catch {} return []
    }
    function saveFontDb(list: CustomFont[]) { try { localStorage.setItem(FONT_DB_KEY, JSON.stringify(list)) } catch {} }
    function sanitizeId(s: string): string { return s.replace(/[^a-zA-Z0-9_-]+/g, '-') }
    function getFormat(ext: string): string { const e = ext.toLowerCase(); if (e === 'ttf') return 'truetype'; if (e === 'otf') return 'opentype'; if (e === 'woff2') return 'woff2'; return 'woff' }
    async function ensureFontsDir() { try { await mkdir(FONTS_DIR as any, { baseDir: BaseDirectory.AppLocalData, recursive: true } as any) } catch {} }
    async function injectFontFace(f: CustomFont): Promise<void> {
      try {
        const bytes = await readFile(`${FONTS_DIR}/${f.rel}` as any, { baseDir: BaseDirectory.AppLocalData } as any) as Uint8Array
        const fmt = getFormat(f.ext)
        const blob = new Blob([bytes as any], { type: fmt === 'woff2' ? 'font/woff2' : (fmt === 'woff' ? 'font/woff' : 'font/ttf') })
        const url = URL.createObjectURL(blob)
        const css = `@font-face{font-family:'${f.family}';src:url(${url}) format('${fmt}');font-weight:normal;font-style:normal;font-display:swap;}`
        const style = document.createElement('style')
        style.dataset.userFont = f.id
        style.textContent = css
        document.head.appendChild(style)
      } catch {}
    }
    function mergeCustomOptions(): { body: Array<{label:string; stack:string}>, mono: Array<{label:string;stack:string}> } {
      const outB: Array<{label:string; stack:string}> = []
      const outM: Array<{label:string; stack:string}> = []
      const list = loadFontDb()
      for (const f of list) {
        outB.push({ label: `本地: ${f.name}`, stack: `'${f.family}', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif` })
        outM.push({ label: `本地: ${f.name}`, stack: `'${f.family}', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace` })
      }
      return { body: outB, mono: outM }
    }

    function rebuildFontSelects(cur: ThemePrefs) {
      try {
        const extras = mergeCustomOptions()
        if (bodySel) {
          const all = bodyOptions.concat(moreBodyOptions).concat(extras.body)
          bodySel.innerHTML = all
            .map(({ label, stack }) => `<option value="${stack.replace(/\"/g, '&quot;')}">${label}</option>`)
            .join('')
          bodySel.value = (cur.bodyFont || '')
        }
        if (monoSel) {
          const all = monoOptions.concat(moreMonoOptions).concat(extras.mono)
          monoSel.innerHTML = all
            .map(({ label, stack }) => `<option value="${stack.replace(/\"/g, '&quot;')}">${label}</option>`)
            .join('')
          monoSel.value = (cur.monoFont || '')
        }
      } catch {}
    }
    rebuildFontSelects(prefs)

    function applyBodyFont(v: string) {
      const cur = loadThemePrefs()
      cur.bodyFont = v || undefined
      saveThemePrefs(cur)
      applyThemePrefs(cur)
      lastSaved = { ...cur }
    }
    function applyMonoFont(v: string) {
      const cur = loadThemePrefs()
      cur.monoFont = v || undefined
      saveThemePrefs(cur)
      applyThemePrefs(cur)
      lastSaved = { ...cur }
    }

    if (bodySel) bodySel.addEventListener('change', () => applyBodyFont(bodySel!.value))
    if (monoSel) monoSel.addEventListener('change', () => applyMonoFont(monoSel!.value))
    if (resetBtn) resetBtn.addEventListener('click', () => {
      const cur = loadThemePrefs()
      cur.bodyFont = undefined
      cur.monoFont = undefined
      saveThemePrefs(cur)
      applyThemePrefs(cur)
      rebuildFontSelects(cur)
      lastSaved = { ...cur }
    })

    // 简单的操作系统识别（仅用于选择系统字体目录）
    function detectOS(): 'windows' | 'mac' | 'linux' | 'other' {
      try {
        const ua = navigator.userAgent || ''
        if (/Windows/i.test(ua)) return 'windows'
        if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
        if (/Linux/i.test(ua)) return 'linux'
      } catch {}
      return 'other'
    }
    // 返回系统字体目录（优先用户目录，其次系统目录），尽量确保真实存在
    async function getSystemFontsDir(): Promise<string | undefined> {
      const os = detectOS()
      const candidates: string[] = []
      try {
        if (os === 'windows') {
          const h = await homeDir()
          // Windows 用户字体目录（按用户安装）
          candidates.push(await join(h, 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'))
          // Windows 系统字体目录（可能不在 C 盘，但 C 盘是最常见，找不到则忽略）
          candidates.push('C\\Windows\\Fonts')
        } else if (os === 'mac') {
          const h = await homeDir()
          // macOS 用户字体目录
          candidates.push(await join(h, 'Library', 'Fonts'))
          // macOS 系统字体目录
          candidates.push('/Library/Fonts')
        } else if (os === 'linux') {
          const h = await homeDir()
          // Linux 常见字体目录（优先用户目录）
          candidates.push(await join(h, '.local', 'share', 'fonts'))
          candidates.push(await join(h, '.fonts'))
          candidates.push('/usr/share/fonts')
          candidates.push('/usr/local/share/fonts')
        }
      } catch {}
      // 依次尝试，找到第一个存在的目录
      for (const p of candidates) {
        try { if (await exists(p as any)) return p } catch {}
      }
      // 兜底：桌面目录（保证存在）
      try { return await desktopDir() } catch {}
      return undefined
    }

    // 安装字体：拷贝到 AppLocalData/fonts，并注册 @font-face
    if (installBtn) installBtn.addEventListener('click', async () => {
      try {
        const start = await getSystemFontsDir()
        const picked = await openDialog({
          multiple: true,
          // 默认打开系统字体目录，方便用户挑选已安装字体文件
          defaultPath: start,
          filters: [{ name: '字体', extensions: ['ttf','otf','woff','woff2'] }],
        } as any)
        const files: string[] = Array.isArray(picked) ? picked as any : (picked ? [picked as any] : [])
        if (!files.length) return
        await ensureFontsDir()
        let db = loadFontDb()
        for (const p of files) {
          try {
            const nameFull = (p.split(/[\\/]+/).pop() || '').trim()
            if (!nameFull) continue
            const m = nameFull.match(/^(.*?)(\.[^.]+)?$/) || [] as any
            const stem = (m?.[1] || 'font').trim()
            const ext = ((m?.[2] || '').replace('.', '') || 'ttf').toLowerCase()
            const id = sanitizeId(stem + '-' + Math.random().toString(36).slice(2,6))
            const family = 'UserFont-' + sanitizeId(stem)
            const rel = `${id}.${ext}`
            const bytes = await readFile(p as any)
            await writeFile(`${FONTS_DIR}/${rel}` as any, bytes as any, { baseDir: BaseDirectory.AppLocalData } as any)
            const rec: CustomFont = { id, name: stem, rel, ext, family }
            db.push(rec)
            await injectFontFace(rec)
          } catch {}
        }
        saveFontDb(db)
        rebuildFontSelects(loadThemePrefs())
      } catch {}
    })

    // 悬停预览：在颜色块上悬停时即时预览对应背景色，离开当前分组时还原
    const applyPreview = (forWhich: string, color: string) => {
      try {
        const c = getContainer(); if (!c) return
        if (forWhich === 'edit') c.style.setProperty('--bg', color)
        else if (forWhich === 'read') c.style.setProperty('--preview-bg', color)
        else c.style.setProperty('--wysiwyg-bg', color)
      } catch {}
    }
    const revertPreview = (forWhich: string) => {
      try {
        const c = getContainer(); if (!c) return
        if (forWhich === 'edit') c.style.setProperty('--bg', lastSaved.editBg)
        else if (forWhich === 'read') c.style.setProperty('--preview-bg', lastSaved.readBg)
        else c.style.setProperty('--wysiwyg-bg', lastSaved.wysiwygBg)
      } catch {}
    }
    // 事件委托：在 swatch 上方时应用预览色
    panel.addEventListener('mouseover', (ev) => {
      const t = ev.target as HTMLElement
      const sw = t.closest('.theme-swatch') as HTMLElement | null
      if (!sw) return
      const color = sw.dataset.color || '#ffffff'
      const forWhich = sw.dataset.for || 'edit'
      applyPreview(forWhich, color)
    })
    // 离开每个分组（编辑/阅读/所见）时还原该分组的原值，避免在分组内部移动造成闪烁
    panel.querySelectorAll('.theme-swatches').forEach((wrap) => {
      const el = wrap as HTMLElement
      const target = el.dataset.target || 'edit'
      el.addEventListener('mouseleave', () => revertPreview(target))
    })

    // 点击颜色：更新、保存、应用
    panel.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement
      if (t.classList.contains('theme-swatch')) {
        const color = t.dataset.color || '#ffffff'
        const forWhich = t.dataset.for || 'edit'
        const cur = loadThemePrefs()
        if (forWhich === 'edit') cur.editBg = color
        else if (forWhich === 'read') cur.readBg = color
        else cur.wysiwygBg = color
        saveThemePrefs(cur)
        applyThemePrefs(cur)
        fillSwatches(panel!, cur)
        lastSaved = { ...cur }
      } else if (t.classList.contains('typo-btn')) {
        const id = (t.dataset.typo as TypographyId) || 'default'
        const cur = loadThemePrefs()
        cur.typography = id
        saveThemePrefs(cur)
        applyThemePrefs(cur)
        fillSwatches(panel!, cur)
        lastSaved = { ...cur }
      } else if (t.classList.contains('md-btn')) {
        const id = (t.dataset.md as MdStyleId) || 'standard'
        const cur = loadThemePrefs()
        cur.mdStyle = id
        saveThemePrefs(cur)
        applyThemePrefs(cur)
        fillSwatches(panel!, cur)
        lastSaved = { ...cur }
      }
    })

    // 主题按钮：切换面板显隐
    const btn = document.getElementById('btn-theme') as HTMLDivElement | null
    if (btn) {
      btn.addEventListener('click', () => {
        try {
          // 将面板对齐到右上角，靠近按钮区域
          panel!.style.left = 'auto'
          panel!.style.right = '10px'
          panel!.style.top = '38px'
          const wasHidden = panel!.classList.contains('hidden')
          panel!.classList.toggle('hidden')
          // 面板关闭时，确保预览被还原为已保存值
          if (!wasHidden && panel!.classList.contains('hidden')) {
            try {
              const c = getContainer(); if (c) {
                c.style.setProperty('--bg', lastSaved.editBg)
                c.style.setProperty('--preview-bg', lastSaved.readBg)
                c.style.setProperty('--wysiwyg-bg', lastSaved.wysiwygBg)
              }
            } catch {}
          }
        } catch {}
      })
    }

    // 点击外部关闭
    document.addEventListener('click', (ev) => {
      try {
        const t = ev.target as HTMLElement
        if (!panel || panel.classList.contains('hidden')) return
        if (t.closest('#theme-panel') || t.closest('#btn-theme')) return
        // 关闭前先还原所有预览变量
        try {
          const c = getContainer(); if (c) {
            c.style.setProperty('--bg', lastSaved.editBg)
            c.style.setProperty('--preview-bg', lastSaved.readBg)
            c.style.setProperty('--wysiwyg-bg', lastSaved.wysiwygBg)
          }
        } catch {}
        panel.classList.add('hidden')
      } catch {}
    })
  } catch {}
}
