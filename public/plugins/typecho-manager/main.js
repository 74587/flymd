// Typecho Manager for flyMD
// 通过 XML-RPC 从 Typecho 拉取博文并保存为本地 Markdown。

const LS_KEY = 'flymd:typecho-manager:settings'

function createDefaultSettings() {
  return {
    endpoint: '',
    username: '',
    password: '',
    blogId: '0',
    baseUrl: '',
    defaultDownloadDir: '',
    alwaysUseDefaultDir: false
  }
}

async function loadSettings(context) {
  try {
    if (context?.storage?.get) {
      const stored = await context.storage.get('settings')
      if (stored && typeof stored === 'object') {
        return Object.assign(createDefaultSettings(), stored)
      }
    }
  } catch {}
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return createDefaultSettings()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return createDefaultSettings()
    return Object.assign(createDefaultSettings(), parsed)
  } catch {
    return createDefaultSettings()
  }
}

async function saveSettings(context, settings) {
  const payload = Object.assign(createDefaultSettings(), settings || {})
  try {
    if (context?.storage?.set) {
      await context.storage.set('settings', payload)
    }
  } catch {}
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(payload))
  } catch {}
  return payload
}

// ---- XML-RPC & HTTP 工具 ----

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function iso8601ForXml(d) {
  const y = d.getFullYear()
  const m = pad2(d.getMonth() + 1)
  const day = pad2(d.getDate())
  const h = pad2(d.getHours())
  const mi = pad2(d.getMinutes())
  const s = pad2(d.getSeconds())
  return `${y}${m}${day}T${h}:${mi}:${s}`
}

const httpState = { available: null, checking: null, error: null }

async function ensureHttpAvailable(context, { silent = false } = {}) {
  if (httpState.available === true) return true
  if (!httpState.checking) {
    httpState.checking = (async () => {
      try {
        const http = context?.http
        if (http?.available) {
          const ok = await http.available()
          httpState.available = (ok !== false)
          if (httpState.available) httpState.error = null
        } else {
          httpState.available = !!http?.fetch
          if (!httpState.available) {
            httpState.error = new Error('ctx.http.fetch 不可用')
          }
        }
      } catch (e) {
        httpState.available = false
        httpState.error = e
      } finally {
        httpState.checking = null
      }
      return httpState.available
    })()
  }
  const ok = await httpState.checking
  if (!ok && !silent) {
    try {
      context?.ui?.notice?.('网络层不可用：请在桌面版使用或确保已启用 @tauri-apps/plugin-http', 'err', 4000)
    } catch {}
  }
  return !!ok
}

function responseOk(res) {
  if (!res) return false
  if (typeof res.ok === 'boolean') return res.ok
  const status = typeof res.status === 'number' ? res.status : 0
  return status >= 200 && status < 300
}

async function readResponseText(res) {
  if (!res) return ''
  if (typeof res.text === 'function') {
    try { return await res.text() } catch {}
  }
  if (typeof res.data === 'string') return res.data
  if (res.body && typeof res.body === 'string') return res.body
  return ''
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function xmlEncodeValue(v) {
  if (v === null || v === undefined) return '<nil/>'
  if (Array.isArray(v)) {
    return '<array><data>' + v.map((x) => `<value>${xmlEncodeValue(x)}</value>`).join('') + '</data></array>'
  }
  if (v instanceof Date) return `<dateTime.iso8601>${iso8601ForXml(v)}</dateTime.iso8601>`
  const t = typeof v
  if (t === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`
  if (t === 'number') return Number.isInteger(v) ? `<int>${v}</int>` : `<double>${v}</double>`
  if (t === 'object') {
    return '<struct>' + Object.entries(v).map(([k, val]) => `<member><name>${xmlEscape(k)}</name><value>${xmlEncodeValue(val)}</value></member>`).join('') + '</struct>'
  }
  return `<string>${xmlEscape(String(v))}</string>`
}

function xmlBuildCall(method, params) {
  return `<?xml version="1.0"?><methodCall><methodName>${xmlEscape(method)}</methodName><params>` +
    (params || []).map((p) => `<param><value>${xmlEncodeValue(p)}</value></param>`).join('') +
    `</params></methodCall>`
}

function xmlParseResponse(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  const fault = doc.getElementsByTagName('fault')[0]

  const parseVal = (node) => {
    if (!node) return null
    const name = node.nodeName
    if (name === 'value') {
      return node.children.length ? parseVal(node.children[0]) : (node.textContent ?? '')
    }
    if (['string', 'i4', 'int', 'double', 'boolean', 'dateTime.iso8601'].includes(name)) {
      const s = (node.textContent || '').trim()
      if (name === 'boolean') return s === '1'
      if (name === 'int' || name === 'i4') return parseInt(s, 10)
      if (name === 'double') return Number(s)
      return s
    }
    if (name === 'struct') {
      const result = {}
      const members = node.getElementsByTagName('member')
      for (let i = 0; i < members.length; i++) {
        const member = members[i]
        const key = member.getElementsByTagName('name')[0]?.textContent || ''
        const val = parseVal(member.getElementsByTagName('value')[0])
        result[key] = val
      }
      return result
    }
    if (name === 'array') {
      const dataEl = node.getElementsByTagName('data')[0]
      if (!dataEl) return []
      const arr = []
      for (let i = 0; i < dataEl.children.length; i++) {
        if (dataEl.children[i].nodeName === 'value') arr.push(parseVal(dataEl.children[i]))
      }
      return arr
    }
    return node.textContent ?? ''
  }

  if (fault) {
    const valueNode = fault.getElementsByTagName('value')[0]
    const payload = parseVal(valueNode)
    const msg = (payload && (payload.faultString || payload['faultString'])) || 'XML-RPC 错误'
    const code = (payload && (payload.faultCode || payload['faultCode'])) || -1
    const err = new Error(`XML-RPC 错误 ${code}: ${msg}`)
    // @ts-ignore
    err.code = code
    throw err
  }

  const params = doc.getElementsByTagName('params')[0]
  if (!params) return null
  const first = params.getElementsByTagName('param')[0]
  if (!first) return null
  const value = first.getElementsByTagName('value')[0]
  return parseVal(value)
}

async function xmlRpcCall(context, settings, method, params) {
  const endpoint = String(settings.endpoint || '').trim()
  if (!endpoint) throw new Error('Typecho XML-RPC endpoint 未配置')
  const http = context?.http
  const xml = xmlBuildCall(method, params || [])
  const available = await ensureHttpAvailable(context, { silent: true })
  if (available && http?.fetch) {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        'Accept': 'text/xml, */*;q=0.1',
        'Cache-Control': 'no-cache',
        'User-Agent': 'flymd-typecho-manager/0.1'
      },
      body: http.Body?.text ? http.Body.text(xml) : xml,
      timeout: 20000
    }
    if (http.ResponseType?.Text !== undefined && options.responseType === undefined) {
      // @ts-ignore
      options.responseType = http.ResponseType.Text
    }
    const resp = await http.fetch(endpoint, options)
    const text = await readResponseText(resp)
    if (!responseOk(resp)) {
      throw new Error(`HTTP ${resp?.status ?? 'ERR'}: ${text.slice(0, 200)}`)
    }
    return xmlParseResponse(text)
  }
  if (context?.invoke) {
    const text = await context.invoke('http_xmlrpc_post', { req: { url: endpoint, xml } })
    return xmlParseResponse(text)
  }
  throw new Error('无法发送 XML-RPC 请求：既没有 ctx.http.fetch，也没有 ctx.invoke')
}

// ---- 管理窗口与设置窗口（UI 状态与基础骨架） ----

// 会话级状态（不持久化）
const sessionState = {
  settings: createDefaultSettings(),
  posts: [],
  categories: [],
  filterMode: 'all', // all | date | category
  dateFrom: '',
  dateTo: '',
  filterCategory: '',
  searchText: '',
  pageSize: 50,
  pageIndex: 0,
  conflictChoice: null // null | 'overwrite' | 'skip'
}

// 管理窗口 DOM 引用
let overlayEl = null
let dialogEl = null
let statusEl = null
let listBodyEl = null
let filterModeInputs = null
let dateFromInput = null
let dateToInput = null
let categorySelect = null
let defaultDirInput = null
let alwaysUseDefaultCheckbox = null
let pageInfoEl = null
let prevPageBtn = null
let nextPageBtn = null
let relatedOverlayEl = null
let statsOverlayEl = null

// 设置窗口 DOM 引用
let settingsOverlayEl = null

function ensureStyle() {
  if (document.getElementById('tm-typecho-style')) return
  const css = [
    '.tm-typecho-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:90000;}',
    '.tm-typecho-overlay.hidden{display:none;}',
    '.tm-typecho-dialog{width:820px;max-width:calc(100% - 40px);max-height:80vh;background:var(--bg);color:var(--fg);border-radius:10px;border:1px solid var(--border);box-shadow:0 14px 36px rgba(0,0,0,.35);display:flex;flex-direction:column;font-size:13px;overflow:hidden;}',
    '.tm-typecho-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;}',
    '.tm-typecho-header-left{display:flex;align-items:center;gap:8px;}',
    '.tm-typecho-badge{font-size:11px;padding:2px 6px;border-radius:999px;background:rgba(37,99,235,.1);color:#2563eb;border:1px solid rgba(37,99,235,.4);}',
    '.tm-typecho-header-right{display:flex;align-items:center;gap:8px;}',
    '.tm-typecho-btn{cursor:pointer;border:1px solid var(--border);background:rgba(127,127,127,.08);color:var(--fg);border-radius:999px;padding:4px 10px;font-size:12px;line-height:1;display:inline-flex;align-items:center;gap:4px;}',
    '.tm-typecho-btn.primary{border-color:#2563eb;background:#2563eb;color:#fff;}',
    '.tm-typecho-btn:hover{background:rgba(127,127,127,.16);}',
    '.tm-typecho-btn.primary:hover{background:#1d4ed8;border-color:#1d4ed8;}',
    '.tm-typecho-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;padding:8px 14px 10px 14px;}',
    '.tm-typecho-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
    '.tm-typecho-filter-group{display:flex;align-items:center;gap:4px;}',
    '.tm-typecho-label-muted{color:var(--muted);font-size:11px;}',
    '.tm-typecho-radio{display:flex;align-items:center;gap:8px;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.05);}',
    '.tm-typecho-radio label{display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;}',
    '.tm-typecho-radio input{margin:0;}',
    '.tm-typecho-input,.tm-typecho-select{border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:3px 9px;font-size:12px;}',
    '.tm-typecho-input-date{max-width:140px;}',
    '.tm-typecho-main{flex:1;min-height:0;margin-top:4px;border-radius:8px;border:1px solid var(--border);overflow:hidden;display:flex;flex-direction:column;background:rgba(127,127,127,.02);}',
    '.tm-typecho-table-head{display:grid;grid-template-columns:2.5fr 1.4fr 1.2fr 0.9fr 0.9fr;border-bottom:1px solid var(--border);background:rgba(127,127,127,.06);}',
    '.tm-typecho-th,.tm-typecho-td{padding:6px 8px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.tm-typecho-th{font-weight:600;color:var(--muted);}',
    '.tm-typecho-table-body{flex:1;min-height:0;overflow:auto;}',
    '.tm-typecho-row{display:grid;grid-template-columns:2.5fr 1.4fr 1.2fr 0.9fr 0.9fr;border-top:1px solid rgba(127,127,127,.12);}',
    '.tm-typecho-row:nth-child(odd){background:rgba(127,127,127,.02);}',
    '.tm-typecho-row:hover{background:rgba(37,99,235,.06);}',
    '.tm-typecho-title{cursor:pointer;}',
    '.tm-typecho-status-badge{display:inline-block;font-size:11px;padding:2px 6px;border-radius:999px;border:1px solid rgba(127,127,127,.4);color:var(--muted);}',
    '.tm-typecho-status-publish{color:#16a34a;border-color:rgba(22,163,74,.6);background:rgba(22,163,74,.06);}',
    '.tm-typecho-status-draft{color:#f97316;border-color:rgba(249,115,22,.6);background:rgba(249,115,22,.06);}',
    '.tm-typecho-footer{padding:7px 12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:rgba(127,127,127,.04);}',
    '.tm-typecho-footer-left{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted);}',
    '.tm-typecho-footer-row{display:flex;align-items:center;gap:6px;}',
    '.tm-typecho-checkbox{display:flex;align-items:center;gap:4px;font-size:12px;}',
    '.tm-typecho-footer-right{display:flex;align-items:center;gap:6px;}',
    '.tm-typecho-page-info{font-size:11px;color:var(--muted);}',
    '.tm-typecho-empty{padding:16px 12px;font-size:12px;color:var(--muted);}',
    '.tm-typecho-settings-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:90010;}',
    '.tm-typecho-settings-overlay.hidden{display:none;}',
    '.tm-typecho-settings-dialog{width:480px;max-width:calc(100% - 40px);max-height:80vh;background:var(--bg);color:var(--fg);border-radius:10px;border:1px solid var(--border);box-shadow:0 14px 36px rgba(0,0,0,.4);display:flex;flex-direction:column;overflow:hidden;font-size:13px;}',
    '.tm-typecho-settings-header{padding:9px 14px;border-bottom:1px solid var(--border);font-weight:600;font-size:14px;}',
    '.tm-typecho-settings-body{padding:12px 14px;flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;}',
    '.tm-typecho-settings-row{display:grid;grid-template-columns:110px 1fr;gap:6px;align-items:center;}',
    '.tm-typecho-settings-label{font-size:12px;color:var(--muted);}',
    '.tm-typecho-settings-input{border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:5px 8px;font-size:12px;}',
    '.tm-typecho-settings-footer{padding:8px 14px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;}'
  ].join('\n')
  const style = document.createElement('style')
  style.id = 'tm-typecho-style'
  style.textContent = css
  document.head.appendChild(style)
}

function openOverlay() {
  ensureStyle()
  if (!overlayEl) {
    overlayEl = document.createElement('div')
    overlayEl.className = 'tm-typecho-overlay hidden'
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) closeOverlay()
    })
    dialogEl = document.createElement('div')
    dialogEl.className = 'tm-typecho-dialog'
    overlayEl.appendChild(dialogEl)
    document.body.appendChild(overlayEl)
    buildManagerDialog()
  }
  overlayEl.classList.remove('hidden')
}

function closeOverlay() {
  if (overlayEl) overlayEl.classList.add('hidden')
}

function buildManagerDialog() {
  if (!dialogEl) return
  dialogEl.innerHTML = ''

  // 顶部区域
  const header = document.createElement('div')
  header.className = 'tm-typecho-header'

  const headerLeft = document.createElement('div')
  headerLeft.className = 'tm-typecho-header-left'
  const titleSpan = document.createElement('span')
  titleSpan.textContent = '管理 Typecho 博文'
  const badge = document.createElement('span')
  badge.className = 'tm-typecho-badge'
  badge.textContent = 'XML-RPC'
  statusEl = document.createElement('span')
  statusEl.className = 'tm-typecho-label-muted'
  statusEl.textContent = ''
  headerLeft.appendChild(titleSpan)
  headerLeft.appendChild(badge)
  headerLeft.appendChild(statusEl)

  const headerRight = document.createElement('div')
  headerRight.className = 'tm-typecho-header-right'

  const btnRefresh = document.createElement('button')
  btnRefresh.className = 'tm-typecho-btn'
  btnRefresh.textContent = '刷新列表'
  btnRefresh.addEventListener('click', () => { void refreshPosts(globalContextRef) })

  const btnSettings = document.createElement('button')
  btnSettings.className = 'tm-typecho-btn'
  btnSettings.textContent = '连接 / 下载设置'
  btnSettings.addEventListener('click', () => { void openSettingsDialog(globalContextRef) })

  const btnRelated = document.createElement('button')
  btnRelated.className = 'tm-typecho-btn'
  btnRelated.textContent = '相关文章'
  btnRelated.addEventListener('click', () => { void openRelatedPostsDialog(globalContextRef) })

  const btnStats = document.createElement('button')
  btnStats.className = 'tm-typecho-btn'
  btnStats.textContent = '统计 / 健康'
  btnStats.addEventListener('click', () => { void openStatsDialog(globalContextRef) })

  const btnClose = document.createElement('button')
  btnClose.className = 'tm-typecho-btn'
  btnClose.textContent = '关闭'
  btnClose.addEventListener('click', () => { closeOverlay() })

  headerRight.appendChild(btnRefresh)
  headerRight.appendChild(btnRelated)
  headerRight.appendChild(btnStats)
  headerRight.appendChild(btnSettings)
  headerRight.appendChild(btnClose)

  header.appendChild(headerLeft)
  header.appendChild(headerRight)
  dialogEl.appendChild(header)

  // 主体区域
  const body = document.createElement('div')
  body.className = 'tm-typecho-body'

  // 筛选条
  const filters = document.createElement('div')
  filters.className = 'tm-typecho-filters'

  const modeGroup = document.createElement('div')
  modeGroup.className = 'tm-typecho-filter-group tm-typecho-radio'
  filterModeInputs = {}
  ;[
    { value: 'all', label: '全部' },
    { value: 'date', label: '按时间' },
    { value: 'category', label: '按分类' }
  ].forEach((m) => {
    const lab = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'tm-typecho-mode'
    input.value = m.value
    if (m.value === sessionState.filterMode) input.checked = true
    input.addEventListener('change', () => {
      if (input.checked) {
        sessionState.filterMode = m.value
        sessionState.pageIndex = 0
        updateFilterVisibility()
        void renderPostTable()
      }
    })
    filterModeInputs[m.value] = input
    const span = document.createElement('span')
    span.textContent = m.label
    lab.appendChild(input)
    lab.appendChild(span)
    modeGroup.appendChild(lab)
  })
  filters.appendChild(modeGroup)

  // 时间筛选
  dateFromInput = document.createElement('input')
  dateFromInput.type = 'date'
  dateFromInput.className = 'tm-typecho-input tm-typecho-input-date'
  dateFromInput.value = sessionState.dateFrom
  dateFromInput.addEventListener('change', () => {
    sessionState.dateFrom = dateFromInput.value || ''
    sessionState.pageIndex = 0
    void renderPostTable()
  })
  dateToInput = document.createElement('input')
  dateToInput.type = 'date'
  dateToInput.className = 'tm-typecho-input tm-typecho-input-date'
  dateToInput.value = sessionState.dateTo
  dateToInput.addEventListener('change', () => {
    sessionState.dateTo = dateToInput.value || ''
    sessionState.pageIndex = 0
    void renderPostTable()
  })
  const dateGroup = document.createElement('div')
  dateGroup.className = 'tm-typecho-filter-group'
  const fromLabel = document.createElement('span')
  fromLabel.className = 'tm-typecho-label-muted'
  fromLabel.textContent = '从'
  const toLabel = document.createElement('span')
  toLabel.className = 'tm-typecho-label-muted'
  toLabel.textContent = '到'
  dateGroup.appendChild(fromLabel)
  dateGroup.appendChild(dateFromInput)
  dateGroup.appendChild(toLabel)
  dateGroup.appendChild(dateToInput)
  filters.appendChild(dateGroup)

  // 分类筛选
  categorySelect = document.createElement('select')
  categorySelect.className = 'tm-typecho-select'
  categorySelect.addEventListener('change', () => {
    sessionState.filterCategory = categorySelect.value || ''
    sessionState.pageIndex = 0
    void renderPostTable()
  })
  const catGroup = document.createElement('div')
  catGroup.className = 'tm-typecho-filter-group'
  const catLabel = document.createElement('span')
  catLabel.className = 'tm-typecho-label-muted'
  catLabel.textContent = '分类'
  catGroup.appendChild(catLabel)
  catGroup.appendChild(categorySelect)
  filters.appendChild(catGroup)

  // 关键字搜索
  const searchGroup = document.createElement('div')
  searchGroup.className = 'tm-typecho-filter-group'
  const searchLabel = document.createElement('span')
  searchLabel.className = 'tm-typecho-label-muted'
  searchLabel.textContent = '关键字'
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.className = 'tm-typecho-input'
  searchInput.placeholder = '标题 / 内容包含...'
  searchInput.value = sessionState.searchText || ''
  searchInput.addEventListener('input', () => {
    sessionState.searchText = searchInput.value || ''
    sessionState.pageIndex = 0
    void renderPostTable()
  })
  searchGroup.appendChild(searchLabel)
  searchGroup.appendChild(searchInput)
  filters.appendChild(searchGroup)

  body.appendChild(filters)

  // 列表
  const main = document.createElement('div')
  main.className = 'tm-typecho-main'

  const head = document.createElement('div')
  head.className = 'tm-typecho-table-head'
  ;['标题', '分类', '发布时间', '状态', '操作'].forEach((t) => {
    const th = document.createElement('div')
    th.className = 'tm-typecho-th'
    th.textContent = t
    head.appendChild(th)
  })
  main.appendChild(head)

  listBodyEl = document.createElement('div')
  listBodyEl.className = 'tm-typecho-table-body'
  main.appendChild(listBodyEl)

  body.appendChild(main)
  dialogEl.appendChild(body)

  // 底部区域
  const footer = document.createElement('div')
  footer.className = 'tm-typecho-footer'

  const footerLeft = document.createElement('div')
  footerLeft.className = 'tm-typecho-footer-left'

  const row1 = document.createElement('div')
  row1.className = 'tm-typecho-footer-row'
  const dirLabel = document.createElement('span')
  dirLabel.className = 'tm-typecho-label-muted'
  dirLabel.textContent = '默认下载目录：'
  defaultDirInput = document.createElement('input')
  defaultDirInput.type = 'text'
  defaultDirInput.className = 'tm-typecho-input'
  defaultDirInput.placeholder = '例如: typecho-import'
  defaultDirInput.value = sessionState.settings.defaultDownloadDir || ''
  defaultDirInput.addEventListener('change', async () => {
    sessionState.settings.defaultDownloadDir = defaultDirInput.value.trim()
    await saveSettings(globalContextRef, sessionState.settings)
  })
  row1.appendChild(dirLabel)
  row1.appendChild(defaultDirInput)
  const btnBrowseFooterDir = document.createElement('button')
  btnBrowseFooterDir.type = 'button'
  btnBrowseFooterDir.className = 'tm-typecho-btn'
  btnBrowseFooterDir.textContent = '浏览...'
  btnBrowseFooterDir.style.marginLeft = '6px'
  btnBrowseFooterDir.addEventListener('click', async () => {
    const ctx = globalContextRef
    if (!ctx) return
    try {
      if (ctx.pickDirectory && typeof ctx.pickDirectory === 'function') {
        const dir = await ctx.pickDirectory({ defaultPath: defaultDirInput.value || undefined })
        if (dir) {
          defaultDirInput.value = String(dir || '')
          sessionState.settings.defaultDownloadDir = defaultDirInput.value.trim()
          await saveSettings(ctx, sessionState.settings)
        }
        return
      }
      if (ctx.pickDocFiles && typeof ctx.pickDocFiles === 'function') {
        const files = await ctx.pickDocFiles({ multiple: false })
        const first = Array.isArray(files) ? (files[0] || '') : (files || '')
        const p = String(first || '').trim()
        if (!p) return
        const dir = p.replace(/[\\/][^\\/]*$/, '')
        defaultDirInput.value = dir
        sessionState.settings.defaultDownloadDir = defaultDirInput.value.trim()
        await saveSettings(ctx, sessionState.settings)
        return
      }
      ctx.ui.notice('当前环境不支持目录浏览，请在桌面版中使用。', 'err', 2600)
    } catch (e) {
      console.error('[Typecho Manager] 选择默认下载目录失败（底部）', e)
      try {
        const msg = e && e.message ? String(e.message) : String(e || '未知错误')
        ctx.ui.notice('选择默认下载目录失败：' + msg, 'err', 2600)
      } catch {}
    }
  })
  row1.appendChild(btnBrowseFooterDir)

  const row2 = document.createElement('div')
  row2.className = 'tm-typecho-footer-row'
  const cbWrap = document.createElement('label')
  cbWrap.className = 'tm-typecho-checkbox'
  alwaysUseDefaultCheckbox = document.createElement('input')
  alwaysUseDefaultCheckbox.type = 'checkbox'
  alwaysUseDefaultCheckbox.checked = !!sessionState.settings.alwaysUseDefaultDir
  alwaysUseDefaultCheckbox.addEventListener('change', async () => {
    sessionState.settings.alwaysUseDefaultDir = !!alwaysUseDefaultCheckbox.checked
    await saveSettings(globalContextRef, sessionState.settings)
  })
  const cbText = document.createElement('span')
  cbText.textContent = '始终下载到默认目录（否则下载到当前文件所在目录）'
  cbWrap.appendChild(alwaysUseDefaultCheckbox)
  cbWrap.appendChild(cbText)
  row2.appendChild(cbWrap)

  footerLeft.appendChild(row1)
  footerLeft.appendChild(row2)

  const footerRight = document.createElement('div')
  footerRight.className = 'tm-typecho-footer-right'
  pageInfoEl = document.createElement('span')
  pageInfoEl.className = 'tm-typecho-page-info'
  pageInfoEl.textContent = ''

  prevPageBtn = document.createElement('button')
  prevPageBtn.className = 'tm-typecho-btn'
  prevPageBtn.textContent = '上一页'
  prevPageBtn.addEventListener('click', () => {
    if (sessionState.pageIndex > 0) {
      sessionState.pageIndex--
      void renderPostTable()
    }
  })

  nextPageBtn = document.createElement('button')
  nextPageBtn.className = 'tm-typecho-btn'
  nextPageBtn.textContent = '下一页'
  nextPageBtn.addEventListener('click', () => {
    sessionState.pageIndex++
    void renderPostTable()
  })

  footerRight.appendChild(pageInfoEl)
  footerRight.appendChild(prevPageBtn)
  footerRight.appendChild(nextPageBtn)

  footer.appendChild(footerLeft)
  footer.appendChild(footerRight)
  dialogEl.appendChild(footer)

  updateFilterVisibility()
}

function updateFilterVisibility() {
  const mode = sessionState.filterMode
  const showDate = mode === 'date'
  const showCat = mode === 'category'
  if (dateFromInput) dateFromInput.style.display = showDate ? '' : 'none'
  if (dateToInput) dateToInput.style.display = showDate ? '' : 'none'
  if (categorySelect) categorySelect.style.display = showCat ? '' : 'none'
}

// 简单工具函数
function formatDateShort(d) {
  if (!d) return ''
  try {
    const dt = d instanceof Date ? d : new Date(d)
    if (!dt || isNaN(dt.getTime())) return ''
    const y = dt.getFullYear()
    const m = pad2(dt.getMonth() + 1)
    const day = pad2(dt.getDate())
    return `${y}-${m}-${day}`
  } catch {
    return ''
  }
}

function extractCategoriesFromPosts(posts) {
  const set = new Set()
  for (const p of posts || []) {
    const cats = p.categories || p.category || []
    if (Array.isArray(cats)) {
      for (const c of cats) {
        const s = String(c || '').trim()
        if (s) set.add(s)
      }
    } else if (cats) {
      const s = String(cats || '').trim()
      if (s) set.add(s)
    }
  }
  return Array.from(set.values()).sort()
}

function buildRelatedPosts(currentMeta, posts) {
  const results = []
  if (!currentMeta || !posts || !posts.length) return results
  const title = String(currentMeta.title || '').trim().toLowerCase()
  const cats = Array.isArray(currentMeta.categories) ? currentMeta.categories.map((x) => String(x || '').trim().toLowerCase()) : []
  const tags = Array.isArray(currentMeta.tags) ? currentMeta.tags.map((x) => String(x || '').trim().toLowerCase()) : []
  const keywords = new Set()
  for (const t of tags) if (t) keywords.add(t)
  for (const c of cats) if (c) keywords.add(c)
  const titleWords = title ? title.split(/\s+/).filter(Boolean) : []
  for (const w of titleWords) keywords.add(w)
  if (!keywords.size && !title) return results

  for (const p of posts) {
    const cid = p.postid || p.postId || p.cid || p.id
    const pTitle = String(p.title || '').trim()
    const pTitleLower = pTitle.toLowerCase()
    const pCats = p.categories || p.category || []
    const pTagsRaw = p.tags || p.mt_keywords || ''
    const pTags = Array.isArray(pTagsRaw)
      ? pTagsRaw.map((x) => String(x || '').trim())
      : (pTagsRaw ? String(pTagsRaw).split(',').map((x) => x.trim()) : [])

    let score = 0
    for (const c of (Array.isArray(pCats) ? pCats : [pCats])) {
      const s = String(c || '').trim().toLowerCase()
      if (s && keywords.has(s)) score += 3
    }
    for (const t of pTags) {
      const s = String(t || '').trim().toLowerCase()
      if (s && keywords.has(s)) score += 2
    }
    if (title && pTitleLower && (pTitleLower.includes(title) || title.includes(pTitleLower))) {
      score += 4
    }
    if (!score) continue
    results.push({ post: p, score, cid, title: pTitle })
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, 20)
}

// 拉取与渲染文章列表（逻辑部分）

async function loadAllPosts(context, settings) {
  // 使用 getRecentPosts 拉取一批足够大的文章，后续在本地筛选
  const maxCount = 1000
  const res = await xmlRpcCall(context, settings, 'metaWeblog.getRecentPosts', [
    String(settings.blogId || '0'),
    settings.username,
    settings.password,
    maxCount
  ])
  const list = []
  if (Array.isArray(res)) {
    for (const it of res) {
      if (it && typeof it === 'object') list.push(it)
    }
  }
  return list
}

async function refreshPosts(context) {
  if (!context) return
  try {
    if (!sessionState.settings.endpoint || !sessionState.settings.username || !sessionState.settings.password) {
      context.ui.notice('请先在“连接 / 下载设置”中配置 XML-RPC 地址、用户名和密码', 'err', 2600)
      if (statusEl) statusEl.textContent = '未配置连接'
      return
    }
    if (statusEl) statusEl.textContent = '正在从 Typecho 拉取文章...'

    const posts = await loadAllPosts(context, sessionState.settings)
    sessionState.posts = Array.isArray(posts) ? posts : []
    sessionState.categories = extractCategoriesFromPosts(sessionState.posts)
    sessionState.pageIndex = 0

    // 更新分类下拉
    if (categorySelect) {
      categorySelect.innerHTML = ''
      const optAll = document.createElement('option')
      optAll.value = ''
      optAll.textContent = '全部分类'
      categorySelect.appendChild(optAll)
      for (const c of sessionState.categories) {
        const opt = document.createElement('option')
        opt.value = c
        opt.textContent = c
        categorySelect.appendChild(opt)
      }
      categorySelect.value = sessionState.filterCategory || ''
    }

    await renderPostTable()
    if (statusEl) statusEl.textContent = `已加载 ${sessionState.posts.length} 篇`
  } catch (e) {
    console.error('[Typecho Manager] 刷新文章失败', e)
    const msg = e && e.message ? e.message : String(e || '未知错误')
    if (statusEl) statusEl.textContent = '加载失败'
    try { globalContextRef?.ui?.notice?.('加载 Typecho 文章失败：' + msg, 'err', 3200) } catch {}
  }
}

async function openRelatedPostsDialog(context) {
  if (!context) return
  ensureStyle()
  if (relatedOverlayEl) {
    try { relatedOverlayEl.parentNode && relatedOverlayEl.parentNode.removeChild(relatedOverlayEl) } catch {}
    relatedOverlayEl = null
  }
  const overlay = document.createElement('div')
  overlay.className = 'tm-typecho-settings-overlay'

  const dlg = document.createElement('div')
  dlg.className = 'tm-typecho-settings-dialog'
  overlay.appendChild(dlg)

  const header = document.createElement('div')
  header.className = 'tm-typecho-settings-header'
  header.textContent = '相关文章助手'
  dlg.appendChild(header)

  const body = document.createElement('div')
  body.className = 'tm-typecho-settings-body'
  dlg.appendChild(body)

  let meta = null
  try { meta = context.getDocMeta && context.getDocMeta() } catch {}
  meta = meta || {}

  if (!sessionState.posts || !sessionState.posts.length) {
    const p = document.createElement('div')
    p.style.fontSize = '12px'
    p.style.color = 'var(--muted)'
    p.textContent = '尚未加载远端文章，请先在主窗口中点击“刷新列表”。'
    body.appendChild(p)
  } else {
    const list = document.createElement('div')
    list.style.maxHeight = '320px'
    list.style.overflow = 'auto'
    const related = buildRelatedPosts(meta, sessionState.posts)
    if (!related.length) {
      const p = document.createElement('div')
      p.style.fontSize = '12px'
      p.style.color = 'var(--muted)'
      p.textContent = '根据当前文档的标题 / 分类 / 标签，未找到明显相关的文章。'
      body.appendChild(p)
    } else {
      for (const item of related) {
        const p = item.post
        const row = document.createElement('div')
        row.style.display = 'flex'
        row.style.flexDirection = 'column'
        row.style.padding = '6px 4px'
        row.style.borderBottom = '1px solid var(--border)'

        const line1 = document.createElement('div')
        line1.style.display = 'flex'
        line1.style.justifyContent = 'space-between'
        line1.style.alignItems = 'center'
        const titleSpan = document.createElement('span')
        titleSpan.textContent = item.title || '(未命名)'
        titleSpan.style.fontSize = '13px'
        titleSpan.style.fontWeight = '600'
        const scoreSpan = document.createElement('span')
        scoreSpan.style.fontSize = '11px'
        scoreSpan.style.color = 'var(--muted)'
        scoreSpan.textContent = '匹配分: ' + item.score
        line1.appendChild(titleSpan)
        line1.appendChild(scoreSpan)
        row.appendChild(line1)

        const cidSpan = document.createElement('div')
        cidSpan.style.fontSize = '11px'
        cidSpan.style.color = 'var(--muted)'
        cidSpan.textContent = 'ID=' + (item.cid || '')
        row.appendChild(cidSpan)

        const actRow = document.createElement('div')
        actRow.style.display = 'flex'
        actRow.style.gap = '6px'
        actRow.style.marginTop = '4px'
        const btnInsertLink = document.createElement('button')
        btnInsertLink.type = 'button'
        btnInsertLink.className = 'tm-typecho-btn'
        btnInsertLink.textContent = '插入链接'
        btnInsertLink.addEventListener('click', () => {
          try {
            const cid = item.cid || p.postid || p.postId || p.cid || p.id || ''
            const slug = p.wp_slug || p.slug || cid || ''
            const urlBase = sessionState.settings.baseUrl || ''
            let url = slug
            if (urlBase) {
              const sep = urlBase.endsWith('/') ? '' : '/'
              url = urlBase + sep + String(slug || cid || '')
            }
            const titleText = item.title || '(未命名)'
            const linkMd = `[${titleText}](${url})`
            if (context.insertAtCursor) context.insertAtCursor(linkMd)
            else if (context.setEditorValue && context.getEditorValue) {
              const v = String(context.getEditorValue() || '')
              context.setEditorValue(v + '\n\n' + linkMd + '\n')
            }
            context.ui.notice('已插入相关文章链接', 'ok', 2000)
          } catch (e) {
            console.error('[Typecho Manager] 插入相关文章链接失败', e)
            try {
              const msg = e && e.message ? String(e.message) : String(e || '未知错误')
              context.ui.notice('插入链接失败：' + msg, 'err', 2600)
            } catch {}
          }
        })
        const btnDownload = document.createElement('button')
        btnDownload.type = 'button'
        btnDownload.className = 'tm-typecho-btn'
        btnDownload.textContent = '下载到本地'
        btnDownload.addEventListener('click', () => { void downloadSinglePost(context, p) })
        actRow.appendChild(btnInsertLink)
        actRow.appendChild(btnDownload)
        row.appendChild(actRow)

        list.appendChild(row)
      }
      body.appendChild(list)
    }
  }

  const footer = document.createElement('div')
  footer.className = 'tm-typecho-settings-footer'
  const btnClose = document.createElement('button')
  btnClose.className = 'tm-typecho-btn'
  btnClose.textContent = '关闭'
  btnClose.addEventListener('click', () => {
    try { overlay.parentNode && overlay.parentNode.removeChild(overlay) } catch {}
    relatedOverlayEl = null
  })
  footer.appendChild(btnClose)
  dlg.appendChild(footer)

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      try { overlay.parentNode && overlay.parentNode.removeChild(overlay) } catch {}
      relatedOverlayEl = null
    }
  })

  document.body.appendChild(overlay)
  relatedOverlayEl = overlay
}

async function openStatsDialog(context) {
  if (!context) return
  ensureStyle()
  if (statsOverlayEl) {
    try { statsOverlayEl.parentNode && statsOverlayEl.parentNode.removeChild(statsOverlayEl) } catch {}
    statsOverlayEl = null
  }
  const overlay = document.createElement('div')
  overlay.className = 'tm-typecho-settings-overlay'

  const dlg = document.createElement('div')
  dlg.className = 'tm-typecho-settings-dialog'
  overlay.appendChild(dlg)

  const header = document.createElement('div')
  header.className = 'tm-typecho-settings-header'
  header.textContent = '统计 / 健康检查'
  dlg.appendChild(header)

  const body = document.createElement('div')
  body.className = 'tm-typecho-settings-body'
  dlg.appendChild(body)

  const posts = Array.isArray(sessionState.posts) ? sessionState.posts : []
  if (!posts.length) {
    const p = document.createElement('div')
    p.style.fontSize = '12px'
    p.style.color = 'var(--muted)'
    p.textContent = '尚未加载远端文章，请先在主窗口中点击“刷新列表”。'
    body.appendChild(p)
  } else {
    const total = posts.length
    let published = 0
    let drafts = 0
    const cats = new Map()
    const tags = new Map()
    let noCategory = 0
    let noTags = 0

    for (const p of posts) {
      const status = String(p.post_status || p.postStatus || p.status || '').toLowerCase()
      if (status === 'draft') drafts++
      else published++

      const pcats = p.categories || p.category || []
      const catArr = Array.isArray(pcats) ? pcats : (pcats ? [pcats] : [])
      if (!catArr.length) noCategory++
      for (const c of catArr) {
        const s = String(c || '').trim()
        if (!s) continue
        cats.set(s, (cats.get(s) || 0) + 1)
      }

      const pTagsRaw = p.tags || p.mt_keywords || ''
      const pTags = Array.isArray(pTagsRaw)
        ? pTagsRaw.map((x) => String(x || '').trim())
        : (pTagsRaw ? String(pTagsRaw).split(',').map((x) => x.trim()) : [])
      if (!pTags.length) noTags++
      for (const t of pTags) {
        const s = String(t || '').trim()
        if (!s) continue
        tags.set(s, (tags.get(s) || 0) + 1)
      }
    }

    const statsList = document.createElement('div')
    statsList.style.fontSize = '12px'
    statsList.style.display = 'flex'
    statsList.style.flexDirection = 'column'
    statsList.style.gap = '4px'

    const addLine = (text) => {
      const line = document.createElement('div')
      line.textContent = text
      statsList.appendChild(line)
    }

    addLine('总文章数：' + total)
    addLine('已发布：' + published)
    addLine('草稿：' + drafts)
    addLine('无分类文章：' + noCategory)
    addLine('无标签文章：' + noTags)

    body.appendChild(statsList)

    // 分类 / 标签 Top N 列表
    const topWrap = document.createElement('div')
    topWrap.style.display = 'flex'
    topWrap.style.gap = '16px'
    topWrap.style.marginTop = '10px'

    const buildTopList = (title, map) => {
      const box = document.createElement('div')
      const h = document.createElement('div')
      h.style.fontSize = '12px'
      h.style.fontWeight = '600'
      h.style.marginBottom = '4px'
      h.textContent = title
      box.appendChild(h)
      const ul = document.createElement('div')
      ul.style.fontSize = '12px'
      ul.style.display = 'flex'
      ul.style.flexDirection = 'column'
      ul.style.gap = '2px'
      const arr = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)
      if (!arr.length) {
        const empty = document.createElement('div')
        empty.style.color = 'var(--muted)'
        empty.textContent = '无数据'
        ul.appendChild(empty)
      } else {
        for (const [name, count] of arr) {
          const li = document.createElement('div')
          li.textContent = `${name} (${count})`
          ul.appendChild(li)
        }
      }
      box.appendChild(ul)
      return box
    }

    topWrap.appendChild(buildTopList('分类 Top', cats))
    topWrap.appendChild(buildTopList('标签 Top', tags))

    body.appendChild(topWrap)
  }

  const footer = document.createElement('div')
  footer.className = 'tm-typecho-settings-footer'
  const btnClose = document.createElement('button')
  btnClose.className = 'tm-typecho-btn'
  btnClose.textContent = '关闭'
  btnClose.addEventListener('click', () => {
    try { overlay.parentNode && overlay.parentNode.removeChild(overlay) } catch {}
    statsOverlayEl = null
  })
  footer.appendChild(btnClose)
  dlg.appendChild(footer)

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      try { overlay.parentNode && overlay.parentNode.removeChild(overlay) } catch {}
      statsOverlayEl = null
    }
  })

  document.body.appendChild(overlay)
  statsOverlayEl = overlay
}

async function renderPostTable() {
  if (!listBodyEl) return
  let items = sessionState.posts.slice()
  const mode = sessionState.filterMode
  const q = (sessionState.searchText || '').trim().toLowerCase()

  // 时间筛选
  if (mode === 'date') {
    const from = sessionState.dateFrom ? new Date(sessionState.dateFrom) : null
    const to = sessionState.dateTo ? new Date(sessionState.dateTo) : null
    items = items.filter((p) => {
      const raw = p.dateCreated || p.date_created || p.pubDate || p.date || null
      if (!raw) return false
      const d = new Date(raw)
      if (!d || isNaN(d.getTime())) return false
      if (from && d < from) return false
      if (to) {
        const dt = new Date(to.getTime())
        dt.setHours(23, 59, 59, 999)
        if (d > dt) return false
      }
      return true
    })
  }

  // 分类筛选
  if (mode === 'category' && sessionState.filterCategory) {
    const target = sessionState.filterCategory
    items = items.filter((p) => {
      const cats = p.categories || p.category || []
      if (Array.isArray(cats)) {
        return cats.some((c) => String(c || '').trim() === target)
      }
      if (cats) {
        return String(cats || '').trim() === target
      }
      return false
    })
  }

  // 关键字过滤：标题 / 摘要 / 内容中包含
  if (q) {
    items = items.filter((p) => {
      try {
        const title = String(p.title || '').toLowerCase()
        const desc = String(p.description || p.content || '').toLowerCase()
        return title.includes(q) || desc.includes(q)
      } catch {
        return false
      }
    })
  }

  // 按时间降序
  items.sort((a, b) => {
    try {
      const da = new Date(a.dateCreated || a.date_created || a.pubDate || a.date || 0).getTime() || 0
      const db = new Date(b.dateCreated || b.date_created || b.pubDate || b.date || 0).getTime() || 0
      return db - da
    } catch {
      return 0
    }
  })

  const total = items.length
  const ps = sessionState.pageSize
  const maxPageIndex = total > 0 ? Math.max(0, Math.ceil(total / ps) - 1) : 0
  if (sessionState.pageIndex > maxPageIndex) sessionState.pageIndex = maxPageIndex
  const start = sessionState.pageIndex * ps
  const end = start + ps
  const pageItems = items.slice(start, end)

  listBodyEl.innerHTML = ''
  if (pageItems.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'tm-typecho-empty'
    empty.textContent = total === 0 ? '暂无文章，检查连接设置或放宽筛选条件。' : '当前页没有匹配的文章。'
    listBodyEl.appendChild(empty)
  } else {
    for (const p of pageItems) {
      const row = document.createElement('div')
      row.className = 'tm-typecho-row'

      const cid = p.postid || p.postId || p.cid || p.id
      const title = String(p.title || '').trim() || `(未命名 #${cid || ''})`
      const cats = p.categories || p.category || []
      const dateRaw = p.dateCreated || p.date_created || p.pubDate || p.date || ''
      const status = String(p.post_status || p.postStatus || p.status || '').toLowerCase()

      const cellTitle = document.createElement('div')
      cellTitle.className = 'tm-typecho-td tm-typecho-title'
      cellTitle.textContent = title
      cellTitle.title = title
      row.appendChild(cellTitle)

      const cellCat = document.createElement('div')
      cellCat.className = 'tm-typecho-td'
      const catArr = Array.isArray(cats)
        ? cats.map((x) => String(x || '').trim()).filter(Boolean)
        : (cats ? [String(cats || '').trim()] : [])
      cellCat.textContent = catArr.join(', ')
      cellCat.title = cellCat.textContent
      row.appendChild(cellCat)

      const cellDate = document.createElement('div')
      cellDate.className = 'tm-typecho-td'
      cellDate.textContent = formatDateShort(dateRaw)
      cellDate.title = String(dateRaw || '')
      row.appendChild(cellDate)

      const cellStatus = document.createElement('div')
      cellStatus.className = 'tm-typecho-td'
      const sb = document.createElement('span')
      sb.className = 'tm-typecho-status-badge'
      if (status === 'publish') sb.classList.add('tm-typecho-status-publish')
      else if (status === 'draft') sb.classList.add('tm-typecho-status-draft')
      sb.textContent = status || '未知'
      cellStatus.appendChild(sb)
      row.appendChild(cellStatus)

      const cellActions = document.createElement('div')
      cellActions.className = 'tm-typecho-td'
      const btnDl = document.createElement('button')
      btnDl.className = 'tm-typecho-btn'
      btnDl.textContent = '下载到本地'
      btnDl.addEventListener('click', () => { void downloadSinglePost(globalContextRef, p) })
      cellActions.appendChild(btnDl)

      const btnUpdate = document.createElement('button')
      btnUpdate.className = 'tm-typecho-btn'
      btnUpdate.textContent = '用当前文档更新'
      btnUpdate.style.marginLeft = '6px'
      btnUpdate.addEventListener('click', () => { void publishCurrentForPost(globalContextRef, p) })
      cellActions.appendChild(btnUpdate)
      row.appendChild(cellActions)

      listBodyEl.appendChild(row)
    }
  }

  if (pageInfoEl) {
    if (total === 0) pageInfoEl.textContent = '共 0 篇'
    else pageInfoEl.textContent = `共 ${total} 篇 · 第 ${sessionState.pageIndex + 1}/${maxPageIndex + 1} 页`
  }
  if (prevPageBtn) prevPageBtn.disabled = sessionState.pageIndex <= 0
  if (nextPageBtn) nextPageBtn.disabled = sessionState.pageIndex >= maxPageIndex
}

// ---- 下载到本地 & 文件工具 ----

function joinPath(dir, name) {
  const a = String(dir || '')
  const b = String(name || '')
  if (!a) return b
  const sep = a.includes('\\') ? '\\' : '/'
  return a.replace(/[\\/]+$/, '') + sep + b.replace(/^[\\/]+/, '')
}

async function getCurrentBaseDir(context) {
  try {
    const fn = typeof window !== 'undefined' ? window.flymdGetCurrentFilePath : null
    if (fn && typeof fn === 'function') {
      const cur = fn()
      if (cur && typeof cur === 'string') {
        return cur.replace(/[\\/][^\\/]*$/, '')
      }
    }
  } catch {
  }
  try {
    const fn2 = typeof window !== 'undefined' ? window.flymdGetDefaultPasteDir : null
    if (fn2 && typeof fn2 === 'function') {
      const dir = await fn2()
      if (dir && typeof dir === 'string') return dir
    }
  } catch {}
  // 兜底：在插件上下文可用时，让用户通过文件选择器选一个文档，以其所在目录作为基准目录
  try {
    if (context && context.pickDocFiles && typeof context.pickDocFiles === 'function') {
      const sel = await context.pickDocFiles({ multiple: false })
      const first = Array.isArray(sel) ? (sel[0] || '') : (sel || '')
      const p = String(first || '').trim()
      if (p) return p.replace(/[\\/][^\\/]*$/, '')
    }
  } catch {}
  return null
}

function buildDownloadFilename(cid, title, dateStr) {
  const idStr = String(cid)
  const rawTitle = String(title || '').trim()
  const baseTitle = rawTitle || idStr
  let safeTitle = baseTitle
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!safeTitle) safeTitle = idStr
  const core = `${idStr}-${safeTitle}`
  return (dateStr ? `${dateStr}-` : '') + core + '.md'
}

async function checkFileExists(context, path) {
  try {
    if (!context?.invoke) return false
    const text = await context.invoke('read_text_file_any', { path })
    return typeof text === 'string'
  } catch {
    return false
  }
}

async function writeTextFileAny(context, path, content) {
  if (!context?.invoke) throw new Error('ctx.invoke 不可用，无法写入文件')
  await context.invoke('write_text_file_any', { path, content })
}

async function resolveConflictForPath(context, path) {
  if (sessionState.conflictChoice === 'overwrite') return 'overwrite'
  if (sessionState.conflictChoice === 'skip') return 'skip'
  const msg = `文件已存在：\n${path}\n\n选择“确定”将覆盖，选择“取消”将跳过。`
  let overwrite = false
  try {
    overwrite = await context.ui.confirm(msg)
  } catch {
    overwrite = false
  }
  sessionState.conflictChoice = overwrite ? 'overwrite' : 'skip'
  return sessionState.conflictChoice
}

async function downloadSinglePost(context, post) {
  if (!context) return
  try {
    const cid = post.postid || post.postId || post.cid || post.id
    if (!cid && cid !== 0) {
      context.ui.notice('该文章缺少 id，无法下载', 'err', 2200)
      return
    }

    const detail = await xmlRpcCall(context, sessionState.settings, 'metaWeblog.getPost', [
      String(cid),
      sessionState.settings.username,
      sessionState.settings.password
    ])

    const contentHtml = detail?.description || detail?.content || ''
    const title = String(detail?.title || '').trim() || `(未命名 #${cid})`
    const slug = String(detail?.wp_slug || detail?.slug || cid || '').trim()
    const cats = detail?.categories || detail?.category || post.categories || []
    const tagsRaw = detail?.mt_keywords || detail?.tags || ''
    const excerptRaw = detail?.mt_excerpt || detail?.excerpt || ''
    const tags = tagsRaw
      ? String(tagsRaw)
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : []
    const status = String(detail?.post_status || detail?.postStatus || detail?.status || '').toLowerCase() || 'publish'
    const dateRaw = detail?.dateCreated || detail?.date_created || detail?.pubDate || detail?.date || post.dateCreated
    const excerpt = String(excerptRaw || '').trim()

    let mdBody = ''
    try {
      if (context.htmlToMarkdown) {
        mdBody = await context.htmlToMarkdown(contentHtml || '', {
          baseUrl: sessionState.settings.baseUrl || ''
        })
      } else {
        mdBody = contentHtml || ''
      }
    } catch (e) {
      console.error('[Typecho Manager] htmlToMarkdown 失败，回退为原始 HTML', e)
      mdBody = contentHtml || ''
    }

    const dt = dateRaw ? new Date(dateRaw) : new Date()
    const y = dt.getFullYear()
    const m = pad2(dt.getMonth() + 1)
    const day = pad2(dt.getDate())
    const dateStr = isNaN(dt.getTime()) ? '' : `${y}-${m}-${day}`
    const filename = buildDownloadFilename(cid, title, dateStr)

    const cfgDirRaw = String(sessionState.settings.defaultDownloadDir || '').trim()
    const useDefaultDir = sessionState.settings.alwaysUseDefaultDir && !!cfgDirRaw
    const isAbsCfg = !!cfgDirRaw && (/^[a-zA-Z]:[\\/]/.test(cfgDirRaw) || /^\\\\/.test(cfgDirRaw) || /^\//.test(cfgDirRaw))

    let baseDir = ''
    if (useDefaultDir && isAbsCfg) {
      // 绝对路径：直接作为最终下载目录，不依赖当前文档
      baseDir = cfgDirRaw
    } else {
      const base = await getCurrentBaseDir(context)
      if (!base) {
        context.ui.notice('无法确定下载目录：请先打开一个本地文档，或在设置中配置默认粘贴目录后重试。', 'err', 3000)
        return
      }
      baseDir = base
      if (useDefaultDir) {
        baseDir = joinPath(base, cfgDirRaw)
      }
    }
    const fullPath = joinPath(baseDir, filename)

    const categories = Array.isArray(cats)
      ? cats.map((x) => String(x || '').trim()).filter(Boolean)
      : (cats ? [String(cats || '').trim()] : [])

    const safeSlug = slug || String(cid)

    const fm = {
      title,
      typechoId: String(cid),
      typechoSlug: safeSlug,
      typechoUpdatedAt: dateRaw ? String(dateRaw) : '',
      categories,
      tags,
      status,
      source: 'typecho'
    }

    if (excerpt) fm.excerpt = excerpt

    // 从远端自定义字段补充 cover 及 custom_* 元数据
    let coverUrl = ''
    const customFieldsRaw = Array.isArray(detail?.custom_fields)
      ? detail.custom_fields
      : (Array.isArray(detail?.customFields) ? detail.customFields : [])
    const customMeta = {}
    for (const field of customFieldsRaw) {
      if (!field || typeof field !== 'object') continue
      const key = String(field.key || field.name || '').trim()
      if (!key) continue
      const value = field.value !== undefined && field.value !== null ? String(field.value) : ''
      if (!value) continue
      const customKey = `custom_${key}`
      if (!Object.prototype.hasOwnProperty.call(customMeta, customKey)) {
        customMeta[customKey] = value
      }
      if (!coverUrl && (key === 'thumbnail' || key === 'thumb')) {
        coverUrl = value
      }
    }

    if (!coverUrl) {
      coverUrl = String(detail?.cover || detail?.thumbnail || detail?.thumb || '').trim()
    }
    if (coverUrl) fm.cover = coverUrl

    Object.assign(fm, customMeta)

    const yaml = buildYamlFromMeta(fm)
    const finalDoc = `---\n${yaml}\n---\n\n${mdBody || ''}`

    const exists = await checkFileExists(context, fullPath)
    if (exists) {
      const decision = await resolveConflictForPath(context, fullPath)
      if (decision === 'skip') return
      if (decision !== 'overwrite') return
    }

    await writeTextFileAny(context, fullPath, finalDoc)
    context.ui.notice('已保存到本地：' + fullPath, 'ok', 2400)
  } catch (e) {
    console.error('[Typecho Manager] 下载文章失败', e)
    const msg = e && e.message ? e.message : String(e || '未知错误')
    try { context.ui.notice('下载文章失败：' + msg, 'err', 3200) } catch {}
  }
  }
  
  // ---- YAML 工具：根据 meta 构造 Front Matter ----

  function buildYamlFromMeta(meta) {
    const fmLines = []

    const writeEntry = (k, v) => {
      if (v === undefined || v === null || v === '') return
      const t = typeof v

      // 数字：保持为数字字面量
      if (t === 'number') {
        if (!Number.isFinite(v)) return
        fmLines.push(`${k}: ${v}`)
        return
      }

      // 布尔：保持为布尔字面量
      if (t === 'boolean') {
        fmLines.push(`${k}: ${v}`)
        return
      }

      // 数组：逐个元素输出
      if (Array.isArray(v)) {
        if (!v.length) return
        fmLines.push(`${k}:`)
        for (const it of v) {
          if (it === undefined || it === null || it === '') continue
          const itType = typeof it
          if (itType === 'number') {
            if (!Number.isFinite(it)) continue
            fmLines.push(`  - ${it}`)
          } else if (itType === 'boolean') {
            fmLines.push(`  - ${it}`)
          } else {
            let s = String(it)
            if (!s.length) continue
            if (/[#:?\-&*!\[\]{},>|'%@`]/.test(s) || /\s/.test(s)) {
              s = `"${s.replace(/"/g, '\\"')}"`
            }
            fmLines.push(`  - ${s}`)
          }
        }
        return
      }

      // 对象：以 JSON 形式输出，便于还原
      if (t === 'object') {
        try {
          const json = JSON.stringify(v)
          if (!json) return
          fmLines.push(`${k}: ${json}`)
        } catch {
          // 回退为字符串
          let s = String(v)
          if (!s.length) return
          if (/[#:?\-&*!\[\]{},>|'%@`]/.test(s) || /\s/.test(s)) {
            s = `"${s.replace(/"/g, '\\"')}"`
          }
          fmLines.push(`${k}: ${s}`)
        }
        return
      }

      // 字符串
      let s = String(v)
      if (!s.length) return
      if (/[#:?\-&*!\[\]{},>|'%@`]/.test(s) || /\s/.test(s)) {
        s = `"${s.replace(/"/g, '\\"')}"`
      }
      fmLines.push(`${k}: ${s}`)
    }

    const preferOrder = [
      'title',
      'typechoId',
      'typechoSlug',
      'typechoUpdatedAt',
      'categories',
      'tags',
      'status',
      'source'
    ]

    if (meta && typeof meta === 'object') {
      for (const k of preferOrder) {
        if (Object.prototype.hasOwnProperty.call(meta, k)) {
          writeEntry(k, meta[k])
        }
      }
      for (const k of Object.keys(meta)) {
        if (preferOrder.indexOf(k) !== -1) continue
        writeEntry(k, meta[k])
      }
    }

    return fmLines.join('\n')
  }

  function parseDateSafe(raw) {
    if (!raw) return null
    try {
      const d = raw instanceof Date ? raw : new Date(raw)
      if (!d || isNaN(d.getTime())) return null
      return d
    } catch {
      return null
    }
  }

  // 发布前的基础元数据校验（保持保守，避免破坏旧行为）
  function validatePublishMeta(meta) {
    const errors = []
    if (!meta || typeof meta !== 'object') return errors
    // 目前仅保留结构占位，不做强制约束，避免影响既有文档
    // 如需扩展规则，可在此追加
    if (!Array.isArray(meta.categories)) {
      // 理论上不会触发（调用前已规整为数组），但保留检测以防将来修改
      errors.push('categories 必须是数组')
    }
    return errors
  }

  // ---- 发布前选项：JS 弹窗（分类 / 状态 / 时间 / slug / 头图） ----

  async function openPublishOptionsDialog(context, opts) {
    ensureStyle()

    const meta = opts || {}
    const metaCats = Array.isArray(meta.categories) ? meta.categories : []
    const selectedSet = new Set(
      metaCats.map((x) => String(x || '').trim()).filter(Boolean)
    )

    let knownCats = Array.isArray(sessionState.categories) ? sessionState.categories.slice() : []
    if ((!knownCats || !knownCats.length) && Array.isArray(sessionState.posts) && sessionState.posts.length) {
      knownCats = extractCategoriesFromPosts(sessionState.posts)
    }
    // 首次发布时若还没有分类缓存，则自动拉取一次远端文章用于提取分类
    if (!knownCats || !knownCats.length) {
      try {
        if (sessionState.settings && sessionState.settings.endpoint && sessionState.settings.username && sessionState.settings.password) {
          const posts = await loadAllPosts(context, sessionState.settings)
          if (Array.isArray(posts) && posts.length) {
            sessionState.posts = posts
            knownCats = extractCategoriesFromPosts(posts)
            sessionState.categories = knownCats.slice()
          }
        }
      } catch {}
    }

    const formatDateTimeLocal = (d) => {
      if (!d) return ''
      try {
        const dt = d instanceof Date ? d : new Date(d)
        if (!dt || isNaN(dt.getTime())) return ''
        const y = dt.getFullYear()
        const m = pad2(dt.getMonth() + 1)
        const day = pad2(dt.getDate())
        const h = pad2(dt.getHours())
        const mi = pad2(dt.getMinutes())
        return `${y}-${m}-${day}T${h}:${mi}`
      } catch {
        return ''
      }
    }

    const initialStatusDraft = !!meta.draft
    const initialStatus = initialStatusDraft ? 'draft' : 'publish'
    const initialSlug = String(meta.slug || '').trim()
    const initialCover = String(meta.cover || '').trim()
    const initialDate = meta.date instanceof Date ? meta.date : (meta.date ? new Date(meta.date) : new Date())

    return new Promise((resolve) => {
      const overlay = document.createElement('div')
      overlay.className = 'tm-typecho-settings-overlay'

      const dlg = document.createElement('div')
      dlg.className = 'tm-typecho-settings-dialog'
      overlay.appendChild(dlg)

      const header = document.createElement('div')
      header.className = 'tm-typecho-settings-header'
      header.textContent = meta.cid
        ? `更新 Typecho 文章（ID=${meta.cid}）`
        : '发布新文章到 Typecho'
      dlg.appendChild(header)

      const body = document.createElement('div')
      body.className = 'tm-typecho-settings-body'
      dlg.appendChild(body)

      const rows = {}
      const addRow = (labelText, inputEl) => {
        const row = document.createElement('div')
        row.className = 'tm-typecho-settings-row'
        const lab = document.createElement('div')
        lab.className = 'tm-typecho-settings-label'
        lab.textContent = labelText
        row.appendChild(lab)
        row.appendChild(inputEl)
        body.appendChild(row)
      }

      // 分类多选
      const catContainer = document.createElement('div')
      catContainer.style.display = 'flex'
      catContainer.style.flexWrap = 'wrap'
      catContainer.style.gap = '6px'
      catContainer.style.minHeight = '24px'

      if (knownCats && knownCats.length) {
        for (const c of knownCats) {
          const name = String(c || '').trim()
          if (!name) continue
          const lab = document.createElement('label')
          lab.style.display = 'flex'
          lab.style.alignItems = 'center'
          lab.style.gap = '4px'
          lab.style.padding = '2px 6px'
          lab.style.borderRadius = '999px'
          lab.style.border = '1px solid var(--border)'

          const cb = document.createElement('input')
          cb.type = 'checkbox'
          cb.dataset.cat = name
          cb.checked = selectedSet.has(name)

          const span = document.createElement('span')
          span.textContent = name

          lab.appendChild(cb)
          lab.appendChild(span)
          catContainer.appendChild(lab)
        }
      } else {
        const span = document.createElement('span')
        span.style.fontSize = '12px'
        span.style.color = 'var(--muted)'
        span.textContent = '未获取到远端分类，将直接使用文档中的分类'
        catContainer.appendChild(span)
      }
      addRow('分类（多选）', catContainer)

      const catHint = document.createElement('div')
      catHint.style.fontSize = '11px'
      catHint.style.color = 'var(--muted)'
      catHint.textContent = '若不选任何分类，则保留当前文档中的 categories 设置。'
      body.appendChild(catHint)

      // 发布状态
      const statusWrap = document.createElement('div')
      statusWrap.style.display = 'flex'
      statusWrap.style.gap = '12px'
      const stPub = document.createElement('label')
      const stPubRadio = document.createElement('input')
      stPubRadio.type = 'radio'
      stPubRadio.name = 'tm-typecho-status'
      stPubRadio.value = 'publish'
      stPubRadio.checked = initialStatus === 'publish'
      stPub.appendChild(stPubRadio)
      stPub.appendChild(document.createTextNode('发布'))
      const stDraft = document.createElement('label')
      const stDraftRadio = document.createElement('input')
      stDraftRadio.type = 'radio'
      stDraftRadio.name = 'tm-typecho-status'
      stDraftRadio.value = 'draft'
      stDraftRadio.checked = initialStatus === 'draft'
      stDraft.appendChild(stDraftRadio)
      stDraft.appendChild(document.createTextNode('草稿'))
      statusWrap.appendChild(stPub)
      statusWrap.appendChild(stDraft)
      addRow('发布状态', statusWrap)

      // 发布时间
      const inputDate = document.createElement('input')
      inputDate.type = 'datetime-local'
      inputDate.className = 'tm-typecho-settings-input'
      inputDate.value = formatDateTimeLocal(initialDate)
      addRow('发布时间', inputDate); rows.date = inputDate

      // 自定义 slug
      const inputSlug = document.createElement('input')
      inputSlug.type = 'text'
      inputSlug.className = 'tm-typecho-settings-input'
      inputSlug.placeholder = '留空则使用 Typecho 默认规则'
      inputSlug.value = initialSlug
      addRow('自定义 slug', inputSlug); rows.slug = inputSlug

      // 头图地址
      const inputCover = document.createElement('input')
      inputCover.type = 'text'
      inputCover.className = 'tm-typecho-settings-input'
      inputCover.placeholder = '可选：文章头图 URL（例如 https://.../cover.jpg）'
      inputCover.value = initialCover
      addRow('头图地址', inputCover); rows.cover = inputCover

      const footer = document.createElement('div')
      footer.className = 'tm-typecho-settings-footer'

      const btnCancel = document.createElement('button')
      btnCancel.className = 'tm-typecho-btn'
      btnCancel.textContent = '取消'

      const btnOk = document.createElement('button')
      btnOk.className = 'tm-typecho-btn primary'
      btnOk.textContent = meta.cid ? '更新文章' : '发布文章'

      footer.appendChild(btnCancel)
      footer.appendChild(btnOk)
      dlg.appendChild(footer)

      const cleanup = (result) => {
        if (overlay && overlay.parentNode) {
          overlay.parentNode.removeChild(overlay)
        }
        resolve(result)
      }

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) cleanup(null)
      })

      btnCancel.addEventListener('click', () => cleanup(null))

      btnOk.addEventListener('click', () => {
        const chosenCats = []
        const inputs = catContainer.querySelectorAll('input[type="checkbox"][data-cat]')
        inputs.forEach((el) => {
          if (el.checked) {
            const v = el.getAttribute('data-cat') || ''
            const s = v.trim()
            if (s) chosenCats.push(s)
          }
        })

        const statusRadio = dlg.querySelector('input[name="tm-typecho-status"]:checked')
        const st = statusRadio ? statusRadio.value : initialStatus

        const dtString = rows.date.value || ''
        let dateVal = initialDate
        if (dtString) {
          const d = new Date(dtString)
          if (d && !isNaN(d.getTime())) dateVal = d
        }

        cleanup({
          categories: chosenCats,
          status: st,
          draft: st === 'draft',
          date: dateVal,
          slug: rows.slug.value || '',
          cover: rows.cover.value || ''
        })
      })

      document.body.appendChild(overlay)
    })
  }
  
  // ---- 发布 / 更新：使用当前文档覆盖远端 ----

async function publishCurrentDocument(context) {
  if (!context) return
  sessionState.settings = await loadSettings(context)
  const s = sessionState.settings
  if (!s.endpoint || !s.username || !s.password) {
    context.ui.notice('请先在“连接 / 下载设置”中配置 XML-RPC 地址、用户名和密码', 'err', 2600)
    return
  }
  let meta = null
  let body = ''
  try {
    meta = context.getDocMeta && context.getDocMeta()
  } catch {}
  try {
    body = context.getDocBody ? context.getDocBody() : context.getEditorValue()
  } catch {
    body = ''
  }
  meta = meta || {}
  body = String(body || '')
  if (!body.trim()) {
    context.ui.notice('当前文档内容为空，已取消发布', 'err', 2200)
    return
  }
  const cid = meta.typechoId || meta.cid || meta.id

  const title = String(meta.title || '').trim() || '(未命名)'
  const excerpt = String(meta.excerpt || '').trim()
  let cats = Array.isArray(meta.categories) ? meta.categories : []
  const tagArr = Array.isArray(meta.tags)
    ? meta.tags
    : (Array.isArray(meta.keywords) ? meta.keywords : [])
  const tags = tagArr.map((x) => String(x || '').trim()).filter(Boolean)
  const statusStr = String(meta.status || '').toLowerCase()
  let draft = meta.draft === true || statusStr === 'draft'
  let slug = String(meta.slug || meta.typechoSlug || '').trim()
  let coverUrl = String(meta.cover || meta.thumbnail || meta.thumb || '').trim()

  let dtRaw = meta.dateCreated || meta.date || meta.typechoUpdatedAt || null
  let dt = dtRaw ? new Date(dtRaw) : new Date()
  if (!dt || isNaN(dt.getTime())) dt = new Date()

  const hasCid = (cid || cid === 0)
  
    // 发布前弹 JS 窗口：分类 / 状态 / 时间 / slug / 头图
  try {
    const uiOpts = await openPublishOptionsDialog(context, {
      cid: cid ? String(cid) : '',
      title,
      categories: cats,
      tags,
      draft,
      status: draft ? 'draft' : 'publish',
      date: dt,
      slug,
      cover: coverUrl
    })
    if (uiOpts === null) return
    if (uiOpts) {
      if (Array.isArray(uiOpts.categories) && uiOpts.categories.length) {
        cats = uiOpts.categories.map((x) => String(x || '').trim()).filter(Boolean)
      }
      if (uiOpts.date instanceof Date) dt = uiOpts.date
      draft = !!uiOpts.draft
      if (uiOpts.slug !== undefined) slug = String(uiOpts.slug || '').trim()
      if (uiOpts.cover !== undefined) coverUrl = String(uiOpts.cover || '').trim()
    }
  } catch {}

  // 有远端 ID 时：在真正提交前做一次远端快照，用于简单冲突检测
  let remoteSnapshot = null
  if (hasCid) {
    try {
      remoteSnapshot = await xmlRpcCall(context, s, 'metaWeblog.getPost', [
        String(cid),
        s.username,
        s.password
      ])
    } catch (e) {
      remoteSnapshot = null
    }
    try {
      const remoteDt = parseDateSafe(
        remoteSnapshot?.dateCreated ||
        remoteSnapshot?.date_created ||
        remoteSnapshot?.mt_modified ||
        remoteSnapshot?.modified ||
        remoteSnapshot?.pubDate ||
        remoteSnapshot?.date ||
        null
      )
      const localDt = parseDateSafe(meta.typechoUpdatedAt || meta.dateCreated || meta.date || null)
      if (remoteDt && localDt && remoteDt.getTime() - localDt.getTime() > 1000) {
        const remoteStr = remoteDt.toISOString()
        const localStr = localDt.toISOString()
        const ok = await context.ui.confirm(
          `检测到远端文章可能已被更新：\n\n` +
          `远端时间：${remoteStr}\n` +
          `本地记录：${localStr}\n\n` +
          `继续发布将覆盖远端的修改，是否仍要继续？`
        )
        if (!ok) return
      }
    } catch {}
  }

  const metaValidationErrors = validatePublishMeta({
    title,
    body,
    categories: cats,
    status: draft ? 'draft' : 'publish'
  })
  if (metaValidationErrors.length) {
    context.ui.notice('发布前检查失败：' + metaValidationErrors.join('；'), 'err', 2600)
    return
  }

  const postStruct = {
    title,
    description: body,
    mt_keywords: tags.join(','),
    categories: cats,
    post_type: 'post',
    wp_slug: slug,
    mt_allow_comments: 1,
    dateCreated: dt,
    post_status: draft ? 'draft' : 'publish'
  }
  if (excerpt) {
    postStruct.mt_excerpt = excerpt
  }

  const customFieldMap = new Map()
  // 从 Front Matter 中的 custom_* 字段构造通用自定义字段
  for (const [key, value] of Object.entries(meta)) {
    if (!key || !key.startsWith('custom_')) continue
    const rawKey = key.replace(/^custom_/, '')
    const k = String(rawKey || '').trim()
    if (!k) continue
    if (value === undefined || value === null || value === '') continue
    customFieldMap.set(k, String(value))
  }
  // 头图优先映射到 thumbnail/thumb，除非用户在 custom_* 中显式覆盖
  if (coverUrl) {
    if (!customFieldMap.has('thumbnail')) customFieldMap.set('thumbnail', coverUrl)
    if (!customFieldMap.has('thumb')) customFieldMap.set('thumb', coverUrl)
  }
  if (customFieldMap.size > 0) {
    postStruct.custom_fields = []
    for (const [k, v] of customFieldMap.entries()) {
      postStruct.custom_fields.push({ key: k, value: v })
    }
  }

  try {
    if (hasCid) {
      // 已有远端 ID：执行编辑
      await xmlRpcCall(context, s, 'metaWeblog.editPost', [
        String(cid),
        s.username,
        s.password,
        postStruct,
        !draft
      ])
      // 尝试回写 Front Matter：保持本地元数据与远端状态一致
      try {
        const rawMeta = context.getDocMeta && context.getDocMeta()
        const meta2 = rawMeta && typeof rawMeta === 'object' ? Object.assign({}, rawMeta) : {}
        const cidStr = String(cid)
        meta2.typechoId = cidStr
        if (!meta2.typechoSlug) meta2.typechoSlug = slug
        meta2.typechoUpdatedAt = dt.toISOString()
        if (!meta2.title) meta2.title = title
        if (!meta2.categories) meta2.categories = cats
        if (!meta2.tags) meta2.tags = tags
        if (!meta2.slug) meta2.slug = slug
        meta2.status = draft ? 'draft' : 'publish'
        if (!meta2.dateCreated) meta2.dateCreated = dt.toISOString()
        if (coverUrl && !meta2.cover) meta2.cover = coverUrl
        if (excerpt && !meta2.excerpt) meta2.excerpt = excerpt
        const yaml = buildYamlFromMeta(meta2)
        const docBody = context.getDocBody ? context.getDocBody() : body
        const newDoc = `---\n${yaml}\n---\n\n${docBody || ''}`
        context.setEditorValue(newDoc)
      } catch (e) {
        console.error('[Typecho Manager] 回写 Front Matter 失败（不影响远端更新）', e)
      }
      context.ui.notice('远端文章已更新', 'ok', 2300)
    } else {
      // 无远端 ID：执行新建
      const newCid = await xmlRpcCall(context, s, 'metaWeblog.newPost', [
        String(s.blogId || '0'),
        s.username,
        s.password,
        postStruct,
        !draft
      ])
      const cidStr = String(newCid)
      const slug = postStruct.wp_slug || cidStr
      // 尝试回写 Front Matter：补充 typechoId / typechoSlug / typechoUpdatedAt
      try {
        const rawMeta = context.getDocMeta && context.getDocMeta()
        const meta2 = rawMeta && typeof rawMeta === 'object' ? Object.assign({}, rawMeta) : {}
        meta2.typechoId = cidStr
        meta2.typechoSlug = slug
        meta2.typechoUpdatedAt = dt.toISOString()
        if (!meta2.title) meta2.title = title
        if (!meta2.categories) meta2.categories = cats
        if (!meta2.tags) meta2.tags = tags
        meta2.slug = slug
        meta2.status = draft ? 'draft' : 'publish'
        meta2.dateCreated = dt.toISOString()
        if (coverUrl && !meta2.cover) meta2.cover = coverUrl
        const yaml = buildYamlFromMeta(meta2)
        const docBody = context.getDocBody ? context.getDocBody() : body
        const newDoc = `---\n${yaml}\n---\n\n${docBody || ''}`
        context.setEditorValue(newDoc)
      } catch (e) {
        console.error('[Typecho Manager] 回写 Front Matter 失败（不影响远端新建）', e)
      }
      context.ui.notice('远端文章已创建（CID=' + cidStr + '）', 'ok', 2300)
    }
  } catch (e) {
    console.error('[Typecho Manager] 发布当前文档失败', e)
    const msg = e && e.message ? e.message : String(e || '未知错误')
    context.ui.notice('发布/更新远端文章失败：' + msg, 'err', 3200)
  }
}

async function publishCurrentForPost(context, post) {
  if (!context || !post) return
  let meta = null
  try {
    meta = context.getDocMeta && context.getDocMeta()
  } catch {}
  meta = meta || {}

  const cidPost = post.postid || post.postId || post.cid || post.id
  const cidMeta = meta.typechoId || meta.cid || meta.id

  if (!cidMeta && cidPost) {
    const ok = await context.ui.confirm(
      `当前文档没有 typechoId，将使用列表中的文章 ID=${cidPost} 作为目标，是否继续？`
    )
    if (!ok) return
    meta.typechoId = String(cidPost)
  } else if (cidMeta && cidPost && String(cidMeta) !== String(cidPost)) {
    const ok = await context.ui.confirm(
      `当前文档的 typechoId=${cidMeta} 与列表中的 ID=${cidPost} 不一致。\n\n仍要使用当前文档覆盖列表所选远端文章吗？`
    )
    if (!ok) return
    meta.typechoId = String(cidPost)
  }

  await publishCurrentDocument(context)
}

// ---- 设置窗口：一次性填写所有选项 ----

async function openSettingsDialog(context) {
  if (!context) return
  ensureStyle()

  if (!settingsOverlayEl) {
    settingsOverlayEl = document.createElement('div')
    settingsOverlayEl.className = 'tm-typecho-settings-overlay hidden'
    settingsOverlayEl.addEventListener('click', (e) => {
      if (e.target === settingsOverlayEl) settingsOverlayEl.classList.add('hidden')
    })

    const dlg = document.createElement('div')
    dlg.className = 'tm-typecho-settings-dialog'

    const header = document.createElement('div')
    header.className = 'tm-typecho-settings-header'
    header.textContent = 'Typecho 连接 / 下载设置'
    dlg.appendChild(header)

    const body = document.createElement('div')
    body.className = 'tm-typecho-settings-body'

    const rows = {}
    const addRow = (labelText, inputEl) => {
      const row = document.createElement('div')
      row.className = 'tm-typecho-settings-row'
      const lab = document.createElement('div')
      lab.className = 'tm-typecho-settings-label'
      lab.textContent = labelText
      row.appendChild(lab)
      row.appendChild(inputEl)
      body.appendChild(row)
    }

    const inputEndpoint = document.createElement('input')
    inputEndpoint.type = 'text'
    inputEndpoint.className = 'tm-typecho-settings-input'
    inputEndpoint.placeholder = 'https://blog.example.com/action/xmlrpc'
    addRow('XML-RPC 地址', inputEndpoint); rows.endpoint = inputEndpoint

    const inputUser = document.createElement('input')
    inputUser.type = 'text'
    inputUser.className = 'tm-typecho-settings-input'
    addRow('用户名', inputUser); rows.username = inputUser

    const inputPwd = document.createElement('input')
    inputPwd.type = 'password'
    inputPwd.className = 'tm-typecho-settings-input'
    addRow('密码', inputPwd); rows.password = inputPwd

    const inputBlogId = document.createElement('input')
    inputBlogId.type = 'text'
    inputBlogId.className = 'tm-typecho-settings-input'
    inputBlogId.placeholder = '通常为 0 或 1'
    addRow('Blog ID', inputBlogId); rows.blogId = inputBlogId

    const inputBaseUrl = document.createElement('input')
    inputBaseUrl.type = 'text'
    inputBaseUrl.className = 'tm-typecho-settings-input'
    inputBaseUrl.placeholder = 'https://blog.example.com（用于补全相对链接，可留空）'
    addRow('站点根地址', inputBaseUrl); rows.baseUrl = inputBaseUrl

    const inputDefaultDir = document.createElement('input')
    inputDefaultDir.type = 'text'
    inputDefaultDir.className = 'tm-typecho-settings-input'
    inputDefaultDir.placeholder = 'typecho-import 或绝对路径'
    const defaultDirRow = document.createElement('div')
    defaultDirRow.style.display = 'flex'
    defaultDirRow.style.gap = '8px'
    defaultDirRow.style.alignItems = 'center'
    defaultDirRow.appendChild(inputDefaultDir)
    const btnBrowseDir = document.createElement('button')
    btnBrowseDir.type = 'button'
    btnBrowseDir.className = 'tm-typecho-btn'
    btnBrowseDir.textContent = '浏览...'
    btnBrowseDir.addEventListener('click', async () => {
      try {
        if (context.pickDirectory && typeof context.pickDirectory === 'function') {
          const dir = await context.pickDirectory({ defaultPath: inputDefaultDir.value || undefined })
          if (dir) inputDefaultDir.value = String(dir || '')
          return
        }
        if (context.pickDocFiles && typeof context.pickDocFiles === 'function') {
          const files = await context.pickDocFiles({ multiple: false })
          const first = Array.isArray(files) ? (files[0] || '') : (files || '')
          const p = String(first || '').trim()
          if (!p) return
          const dir = p.replace(/[\\/][^\\/]*$/, '')
          inputDefaultDir.value = dir
          return
        }
        context.ui.notice('当前环境不支持目录浏览，请在桌面版中使用。', 'err', 2600)
      } catch (e) {
        console.error('[Typecho Manager] 选择默认下载目录失败', e)
        try {
          const msg = e && e.message ? String(e.message) : String(e || '未知错误')
          context.ui.notice('选择默认下载目录失败：' + msg, 'err', 2600)
        } catch {}
      }
    })
    defaultDirRow.appendChild(btnBrowseDir)
    addRow('默认下载目录', defaultDirRow); rows.defaultDir = inputDefaultDir

    const cbWrap = document.createElement('label')
    cbWrap.className = 'tm-typecho-checkbox'
    const cbAlways = document.createElement('input')
    cbAlways.type = 'checkbox'
    const cbText = document.createElement('span')
    cbText.textContent = '始终下载到默认目录（否则下载到当前文件所在目录）'
    cbWrap.appendChild(cbAlways)
    cbWrap.appendChild(cbText)
    addRow('目录策略', cbWrap); rows.always = cbAlways

    dlg.appendChild(body)

    const footer = document.createElement('div')
    footer.className = 'tm-typecho-settings-footer'

    const btnCancel = document.createElement('button')
    btnCancel.className = 'tm-typecho-btn'
    btnCancel.textContent = '取消'
    btnCancel.addEventListener('click', () => { settingsOverlayEl.classList.add('hidden') })

    const btnTest = document.createElement('button')
    btnTest.className = 'tm-typecho-btn'
    btnTest.textContent = '测试连接'

    const btnSave = document.createElement('button')
    btnSave.className = 'tm-typecho-btn primary'
    btnSave.textContent = '保存'

    footer.appendChild(btnCancel)
    footer.appendChild(btnTest)
    footer.appendChild(btnSave)
    dlg.appendChild(footer)

    settingsOverlayEl.appendChild(dlg)
    document.body.appendChild(settingsOverlayEl)
    settingsOverlayEl._rows = rows

    btnSave.addEventListener('click', async () => {
      const r = settingsOverlayEl._rows
      sessionState.settings.endpoint = String(r.endpoint.value || '').trim()
      sessionState.settings.username = String(r.username.value || '').trim()
      sessionState.settings.password = String(r.password.value || '')
      sessionState.settings.blogId = String(r.blogId.value || '0').trim() || '0'
      sessionState.settings.baseUrl = String(r.baseUrl.value || '').trim()
      sessionState.settings.defaultDownloadDir = String(r.defaultDir.value || '').trim()
      sessionState.settings.alwaysUseDefaultDir = !!r.always.checked

      await saveSettings(context, sessionState.settings)
      settingsOverlayEl.classList.add('hidden')
      try { context.ui.notice('Typecho 设置已保存', 'ok', 2200) } catch {}

      if (defaultDirInput) defaultDirInput.value = sessionState.settings.defaultDownloadDir || ''
      if (alwaysUseDefaultCheckbox) alwaysUseDefaultCheckbox.checked = !!sessionState.settings.alwaysUseDefaultDir
    })

    btnTest.addEventListener('click', async () => {
      const r = settingsOverlayEl._rows
      const tmp = {
        endpoint: String(r.endpoint.value || '').trim(),
        username: String(r.username.value || '').trim(),
        password: String(r.password.value || ''),
        blogId: String(r.blogId.value || '0').trim() || '0',
        baseUrl: String(r.baseUrl.value || '').trim()
      }
      if (!tmp.endpoint || !tmp.username || !tmp.password) {
        context.ui.notice('请先填写完整的 XML-RPC 地址、用户名和密码', 'err', 2600)
        return
      }
      try {
        await xmlRpcCall(context, tmp, 'metaWeblog.getRecentPosts', [
          String(tmp.blogId || '0'),
          tmp.username,
          tmp.password,
          1
        ])
        context.ui.notice('连接测试成功', 'ok', 2400)
      } catch (e) {
        console.error('[Typecho Manager] 连接测试失败', e)
        const msg = e && e.message ? e.message : String(e || '未知错误')
        context.ui.notice('连接测试失败：' + msg, 'err', 3200)
      }
    })
  }

  const rows = settingsOverlayEl._rows
  rows.endpoint.value = sessionState.settings.endpoint || ''
  rows.username.value = sessionState.settings.username || ''
  rows.password.value = sessionState.settings.password || ''
  rows.blogId.value = sessionState.settings.blogId || '0'
  rows.baseUrl.value = sessionState.settings.baseUrl || ''
  rows.defaultDir.value = sessionState.settings.defaultDownloadDir || ''
  rows.always.checked = !!sessionState.settings.alwaysUseDefaultDir

  settingsOverlayEl.classList.remove('hidden')
}




// ---- 插件生命周期：右键菜单入口 ----

let globalContextRef = null
let ctxMenuDisposers = []

async function openManager(context) {
  globalContextRef = context
  // 每次打开时刷新设置到会话状态
  sessionState.settings = await loadSettings(context)
  openOverlay()
  // 打开后若还未加载文章则自动拉取一次
  if (!sessionState.posts || sessionState.posts.length === 0) {
    await refreshPosts(context)
  } else {
    await renderPostTable()
  }
}

export async function activate(context) {
  globalContextRef = context
  sessionState.settings = await loadSettings(context)
  if (context.addContextMenuItem) {
    try {
      const disposeManage = context.addContextMenuItem({
        label: '管理 Typecho 博文',
        icon: '📖',
        onClick: () => { void openManager(globalContextRef) }
      })
      if (typeof disposeManage === 'function') ctxMenuDisposers.push(disposeManage)
    } catch {}
    try {
      const disposePublish = context.addContextMenuItem({
        label: '发布到 Typecho',
        icon: '⬆️',
        onClick: () => { void publishCurrentDocument(globalContextRef) }
      })
      if (typeof disposePublish === 'function') ctxMenuDisposers.push(disposePublish)
    } catch {}
  }
}

export function deactivate() {
  globalContextRef = null
  if (ctxMenuDisposers && ctxMenuDisposers.length) {
    for (const fn of ctxMenuDisposers) {
      try {
        if (typeof fn === 'function') fn()
      } catch {}
    }
  }
  ctxMenuDisposers = []
}
