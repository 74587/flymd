// Typecho Manager for flyMD
// 通过 XML-RPC 从 Typecho 拉取博文并保存为本地 Markdown。

// 轻量多语言：跟随宿主（flymd.locale），默认用系统语言
const TM_LOCALE_LS_KEY = 'flymd.locale'
function tmDetectLocale() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    const lang = (nav && (nav.language || nav.userLanguage)) || 'en'
    const lower = String(lang || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
  } catch {}
  return 'en'
}
function tmGetLocale() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null
    const v = ls && ls.getItem(TM_LOCALE_LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  return tmDetectLocale()
}
function tmText(zh, en) {
  return tmGetLocale() === 'en' ? en : zh
}

const LS_KEY = 'flymd:typecho-manager:settings'

// 设备检测：复用 s3-gallery 的成熟模式
function tmIsMobile() {
  return window.innerWidth <= 600  // 与现有 @media 断点一致
}

function tmGetDeviceType() {
  const width = window.innerWidth
  if (width <= 600) return 'mobile'
  if (width <= 768) return 'tablet'
  return 'desktop'
}

// z-index 层级规范
const TM_Z_INDEX = {
  OVERLAY: 90000,        // 主对话框遮罩
  DIALOG: 90001,         // 主对话框内容
  HEADER_MENU: 90005,    // 移动端头部菜单
  SUB_OVERLAY: 90010,    // 子对话框遮罩
  SUB_DIALOG: 90011,     // 子对话框内容
  ACTION_SHEET: 90015,   // 移动端底部操作表
  CONTEXT_MENU: 90020,   // 右键菜单（最高层）
}

function createDefaultSettings() {
  return {
    endpoint: '',
    username: '',
    password: '',
    blogId: '0',
    baseUrl: '',
    defaultDownloadDir: '',
    alwaysUseDefaultDir: false,
    savedViews: [],
    backups: {}
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
            httpState.error = new Error(tmText('ctx.http.fetch 不可用', 'ctx.http.fetch is not available'))
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
      context?.ui?.notice?.(
        tmText('网络层不可用：请在桌面版使用或确保已启用 @tauri-apps/plugin-http', 'Network layer is unavailable: please use the desktop app or ensure @tauri-apps/plugin-http is enabled'),
        'err',
        4000,
      )
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
  conflictChoice: null, // null | 'overwrite' | 'skip'
  selectedIds: new Set()
}

// 上传结果缓存：避免同一 URL 重复上传浪费流量
const tmUploadCache = new Map()

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
let headSelectAllCheckbox = null
let rollbackOverlayEl = null
let rowContextMenuEl = null
let headerMenuEl = null        // 移动端头部菜单元素
let cardActionSheetEl = null   // 移动端卡片操作表元素
let migrateOverlayEl = null    // 迁移状态窗口
let migrateLogEl = null
let migrateProgressEl = null
let migrateStyleReady = false

// 移动端过滤器折叠状态
let filtersCollapsed = true // 默认折叠
const LS_FILTERS_COLLAPSED_KEY = 'flymd:typecho-manager:filtersCollapsed'

// 初始化时从 localStorage 读取
try {
  const stored = localStorage.getItem(LS_FILTERS_COLLAPSED_KEY)
  if (stored === 'false') filtersCollapsed = false
} catch {}

// 设置窗口 DOM 引用
let settingsOverlayEl = null

function ensureStyle() {
  if (document.getElementById('tm-typecho-style')) return
  const css = [
    '.tm-typecho-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:' + TM_Z_INDEX.OVERLAY + ';}',
    '.tm-typecho-overlay.hidden{display:none;}',
    '.tm-typecho-dialog{width:1040px;max-width:calc(100% - 40px);max-height:80vh;background:var(--bg);color:var(--fg);border-radius:10px;border:1px solid var(--border);box-shadow:0 14px 36px rgba(0,0,0,.35);display:flex;flex-direction:column;font-size:13px;overflow:hidden;}',
    '.tm-typecho-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;}',
    '.tm-typecho-header-left{display:flex;align-items:center;gap:8px;}',
    '.tm-typecho-badge{font-size:11px;padding:2px 6px;border-radius:999px;background:rgba(37,99,235,.1);color:#2563eb;border:1px solid rgba(37,99,235,.4);}',
    '.tm-typecho-header-right{display:flex;align-items:center;gap:8px;}',
    '.tm-typecho-btn{cursor:pointer;border:1px solid var(--border);background:rgba(127,127,127,.08);color:var(--fg);border-radius:999px;padding:4px 10px;font-size:12px;line-height:1;display:inline-flex;align-items:center;gap:4px;}',
    '.tm-typecho-btn.primary{border-color:#2563eb;background:#2563eb;color:#fff;}',
    '.tm-typecho-btn:hover{background:rgba(127,127,127,.16);}',
    '.tm-typecho-btn.primary:hover{background:#1d4ed8;border-color:#1d4ed8;}',
    '.tm-typecho-btn:active{opacity:0.7;transform:scale(0.98);}',
    '.tm-typecho-btn:focus-visible{outline:2px solid #2563eb;outline-offset:2px;}',
    '.tm-typecho-migrate-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:' + (TM_Z_INDEX.OVERLAY + 1) + ';}',
    '.tm-typecho-migrate-dialog{width:520px;max-width:90vw;background:var(--bg);color:var(--fg);border-radius:10px;border:1px solid var(--border);box-shadow:0 14px 36px rgba(0,0,0,.35);padding:16px;display:flex;flex-direction:column;gap:10px;font-size:13px;}',
    '.tm-typecho-migrate-title{font-weight:600;font-size:14px;}',
    '.tm-typecho-migrate-log{min-height:140px;max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px;background:rgba(0,0,0,.02);font-family:monospace;font-size:12px;white-space:pre-wrap;}',
    '.tm-typecho-migrate-progress{font-size:12px;color:var(--muted);}',
    '.tm-card-btn-primary{background:linear-gradient(135deg, #2563eb, #1d4ed8) !important;border-color:transparent !important;color:#fff !important;box-shadow:0 2px 6px rgba(37,99,235,.3);}',
    '.tm-card-btn-primary:active{box-shadow:0 1px 3px rgba(37,99,235,.3);}',
    '.tm-card-btn-secondary{background:rgba(127,127,127,.08) !important;border-color:var(--border) !important;color:var(--fg) !important;}',
    '.tm-typecho-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;padding:8px 14px 10px 14px;}',
    '.tm-typecho-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
    '.tm-typecho-filter-group{display:flex;align-items:center;gap:4px;}',
    '.tm-typecho-label-muted{color:var(--muted);font-size:11px;}',
    '.tm-typecho-radio{display:flex;align-items:center;gap:8px;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.05);}',
    '.tm-typecho-radio label{display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;}',
    '.tm-typecho-radio input{margin:0;}',
    '.tm-typecho-input,.tm-typecho-select{border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:3px 9px;font-size:12px;}',
    '.tm-typecho-input:focus,.tm-typecho-select:focus{outline:2px solid #2563eb;outline-offset:2px;}',
    '.tm-typecho-input-date{max-width:140px;}',
    '.tm-typecho-main{flex:1;min-height:0;margin-top:4px;border-radius:8px;border:1px solid var(--border);overflow:hidden;display:flex;flex-direction:column;background:rgba(127,127,127,.02);}',
    '.tm-typecho-table-head{display:grid;grid-template-columns:2.5fr 1.4fr 1.2fr 0.9fr 1.2fr;border-bottom:1px solid var(--border);background:rgba(127,127,127,.06);}',
    '.tm-typecho-th,.tm-typecho-td{padding:6px 8px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.tm-typecho-th{font-weight:600;color:var(--muted);}',
    '.tm-typecho-table-body{flex:1;min-height:0;overflow:auto;}',
    '.tm-typecho-row{display:grid;grid-template-columns:2.5fr 1.4fr 1.2fr 0.9fr 1.2fr;border-top:1px solid rgba(127,127,127,.12);}',
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
    '.tm-typecho-settings-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:' + TM_Z_INDEX.SUB_OVERLAY + ';}',
    '.tm-typecho-settings-overlay.hidden{display:none;}',
    '.tm-typecho-settings-dialog{width:480px;max-width:calc(100% - 40px);max-height:80vh;background:var(--bg);color:var(--fg);border-radius:10px;border:1px solid var(--border);box-shadow:0 14px 36px rgba(0,0,0,.4);display:flex;flex-direction:column;overflow:hidden;font-size:13px;}',
    '.tm-typecho-settings-header{padding:9px 14px;border-bottom:1px solid var(--border);font-weight:600;font-size:14px;}',
    '.tm-typecho-settings-body{padding:12px 14px;flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;}',
    '.tm-typecho-settings-row{display:grid;grid-template-columns:110px 1fr;gap:6px;align-items:center;}',
    '.tm-typecho-settings-label{font-size:12px;color:var(--muted);}',
    '.tm-typecho-settings-input{border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:5px 8px;font-size:12px;}',
    '.tm-typecho-settings-footer{padding:8px 14px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;}',
    '.tm-typecho-row-menu{position:fixed;z-index:' + TM_Z_INDEX.CONTEXT_MENU + ';min-width:150px;background:var(--bg);color:var(--fg);border-radius:8px;border:1px solid var(--border);box-shadow:0 14px 36px rgba(0,0,0,.35);font-size:12px;padding:4px 0;}',
    '.tm-typecho-row-menu-item{padding:6px 12px;cursor:pointer;white-space:nowrap;}',
    '.tm-typecho-row-menu-item:hover{background:rgba(127,127,127,.10);}',
    '.tm-typecho-row-menu-sep{margin:4px 0;border-top:1px solid var(--border);}',
    // 移动端卡片式布局
    '@media (max-width:600px){',
    '  .tm-typecho-dialog{width:100vw;height:100vh;max-width:100vw;max-height:100vh;border-radius:0;}',
    '  .tm-typecho-header{padding-top:max(10px, env(safe-area-inset-top));padding-left:max(16px, env(safe-area-inset-left));padding-right:max(16px, env(safe-area-inset-right));}',
    '  .tm-typecho-body{padding:8px;padding-bottom:max(8px, env(safe-area-inset-bottom));}',
    '  .tm-typecho-header-right{flex-wrap:wrap;gap:4px;}',
    '  .tm-typecho-header-right button{padding:4px 8px;font-size:12px;}',
    '  .tm-typecho-filters{flex-direction:column;align-items:stretch;}',
    '  .tm-typecho-filters input,.tm-typecho-filters select{width:100%;font-size:16px;}',
    '  .tm-typecho-table-head{display:none;}',
    '  .tm-typecho-row{display:flex;flex-wrap:wrap;gap:8px;padding:12px;border:none;border-radius:12px;margin-bottom:12px;background:var(--bg);box-shadow:0 2px 8px rgba(0,0,0,.08);transition:transform 0.1s ease, box-shadow 0.1s ease;}',
    '  .tm-typecho-row>div{word-break:break-word;}',
    '  .tm-typecho-row>div:nth-child(1){width:100%;font-size:15px;font-weight:600;line-height:1.4;order:1;}',
    '  .tm-typecho-row>div:nth-child(1)::before{content:none !important;}',
    '  .tm-typecho-row>div:nth-child(2){font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:3px;order:2;width:auto;flex:0 0 auto;margin-right:8px;}',
    '  .tm-typecho-row>div:nth-child(2)::before{content:"📁";font-weight:normal;}',
    '  .tm-typecho-row>div:nth-child(3){font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:3px;order:2;width:auto;flex:0 0 auto;margin-right:8px;}',
    '  .tm-typecho-row>div:nth-child(3)::before{content:"📅";font-weight:normal;}',
    '  .tm-typecho-row>div:nth-child(4){order:2;width:auto;flex:0 0 auto;}',
    '  .tm-typecho-row>div:nth-child(4)::before{content:none !important;}',
    '  .tm-typecho-row>div:nth-child(4) .tm-typecho-status-badge{font-size:11px;padding:2px 6px;}',
    '  .tm-typecho-row>div:nth-child(5){width:100%;display:grid;grid-template-columns:1fr auto;gap:8px;order:3;}',
    '  .tm-typecho-row>div:nth-child(5)::before{content:none !important;}',
    '  .tm-typecho-row>div:nth-child(5) button{min-height:44px;font-size:15px;border-radius:8px;font-weight:500;}',
    '  .tm-typecho-footer{flex-direction:column;gap:10px;align-items:stretch;}',
    '  .tm-typecho-footer-left,.tm-typecho-footer-right{width:100%;}',
    '  .tm-typecho-footer-right{justify-content:space-between;}',
    '  .tm-typecho-footer-right button{min-height:44px;padding:8px 16px;}',
    '  .tm-typecho-settings-dialog,.tm-typecho-related-dialog,.tm-typecho-stats-dialog,.tm-typecho-rollback-dialog{width:100vw;height:auto;max-height:90vh;border-radius:0;}',
    '  .tm-typecho-settings-header{padding-top:max(9px, env(safe-area-inset-top));padding-left:max(14px, env(safe-area-inset-left));padding-right:max(14px, env(safe-area-inset-right));}',
    '  .tm-typecho-settings-body{padding-left:max(14px, env(safe-area-inset-left));padding-right:max(14px, env(safe-area-inset-right));padding-bottom:max(12px, env(safe-area-inset-bottom));}',
    '  .tm-typecho-settings-footer{padding-left:max(14px, env(safe-area-inset-left));padding-right:max(14px, env(safe-area-inset-right));padding-bottom:max(8px, env(safe-area-inset-bottom));}',
    '  .tm-filters-toggle{background:rgba(37,99,235,.06);border-color:#2563eb;color:#2563eb;font-weight:600;}',
    '  .tm-filters-toggle:active{background:rgba(37,99,235,.12);}',
    '  .tm-typecho-btn{-webkit-tap-highlight-color:rgba(0,0,0,0);}',
    '  .tm-typecho-header-right button{-webkit-tap-highlight-color:transparent;}',
    '  input,select,textarea,button{-webkit-text-size-adjust:100%;text-size-adjust:100%;}',
    '  .tm-typecho-row:active{transform:scale(0.98);box-shadow:0 1px 4px rgba(0,0,0,.12);}',
    '  .tm-header-menu-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:' + TM_Z_INDEX.HEADER_MENU + ';display:flex;align-items:flex-end;opacity:0;transition:opacity 0.2s ease;}',
    '  .tm-header-menu{width:100%;background:var(--bg);border-radius:16px 16px 0 0;padding:16px;padding-bottom:max(16px, env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;transform:translateY(100%);transition:transform 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);}',
    '  .tm-header-menu-item{padding:14px 16px;border-radius:12px;background:rgba(127,127,127,.08);border:1px solid var(--border);text-align:left;font-size:15px;cursor:pointer;color:var(--fg);}',
    '  .tm-header-menu-item:active{background:rgba(37,99,235,.12);}',
    '  .tm-action-sheet-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:' + TM_Z_INDEX.ACTION_SHEET + ';display:flex;align-items:flex-end;opacity:0;transition:opacity 0.2s ease;}',
    '  .tm-action-sheet{width:100%;background:var(--bg);border-radius:16px 16px 0 0;padding:0;padding-bottom:max(16px, env(safe-area-inset-bottom));transform:translateY(100%);transition:transform 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);}',
    '  .tm-action-sheet-title{padding:16px;font-size:13px;color:var(--muted);text-align:center;border-bottom:1px solid var(--border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '  .tm-action-sheet-item{width:100%;padding:16px;background:transparent;border:none;border-bottom:1px solid rgba(127,127,127,.08);text-align:center;font-size:16px;color:#2563eb;cursor:pointer;}',
    '  .tm-action-sheet-item:active{background:rgba(127,127,127,.08);}',
    '  .tm-action-sheet-item.danger{color:#ef4444;}',
    '  .tm-action-sheet-cancel{width:100%;padding:16px;margin-top:8px;background:var(--bg);border:none;font-size:16px;font-weight:600;color:var(--fg);cursor:pointer;border-top:8px solid rgba(127,127,127,.04);}',
    '  .tm-filters-summary{padding:8px 12px;margin-bottom:8px;background:rgba(37,99,235,.06);border:1px solid rgba(37,99,235,.2);border-radius:8px;font-size:12px;color:#2563eb;text-align:center;}',
    '  *{-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;}',
    '  button, .tm-typecho-title, .tm-typecho-row-menu-item{touch-action:manipulation;user-select:none;}',
    '  input[type="checkbox"], input[type="radio"]{width:20px;height:20px;cursor:pointer;}',
    '  .tm-typecho-table-body, .tm-typecho-settings-body{-webkit-overflow-scrolling:touch;overscroll-behavior:contain;}',
    '}'
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
  titleSpan.textContent = tmText('管理 Typecho 博文', 'Manage Typecho posts')
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
  btnRefresh.textContent = tmText('刷新列表', 'Refresh list')
  btnRefresh.addEventListener('click', () => { void refreshPosts(globalContextRef) })

  const btnSettings = document.createElement('button')
  btnSettings.className = 'tm-typecho-btn'
  btnSettings.textContent = tmText('连接 / 下载设置', 'Connection / download settings')
  btnSettings.addEventListener('click', () => { void openSettingsDialog(globalContextRef) })

  const btnRelated = document.createElement('button')
  btnRelated.className = 'tm-typecho-btn'
  btnRelated.textContent = tmText('相关文章', 'Related posts')
  btnRelated.addEventListener('click', () => { void openRelatedPostsDialog(globalContextRef) })

  const btnStats = document.createElement('button')
  btnStats.className = 'tm-typecho-btn'
  btnStats.textContent = tmText('统计 / 健康', 'Stats / health')
  btnStats.addEventListener('click', () => { void openStatsDialog(globalContextRef) })

  const btnClose = document.createElement('button')
  btnClose.className = 'tm-typecho-btn'
  btnClose.textContent = tmText('关闭', 'Close')
  btnClose.addEventListener('click', () => { closeOverlay() })

  // 移动端：简化按钮布局，使用菜单
  if (tmIsMobile()) {
    headerRight.appendChild(btnRefresh)

    const btnMenu = document.createElement('button')
    btnMenu.className = 'tm-typecho-btn'
    btnMenu.textContent = '☰ ' + tmText('菜单', 'Menu')
    btnMenu.addEventListener('click', () => { openHeaderMenu(globalContextRef) })
    headerRight.appendChild(btnMenu)

    headerRight.appendChild(btnClose)
  } else {
    // 桌面端：保持原有布局
    headerRight.appendChild(btnRefresh)
    headerRight.appendChild(btnRelated)
    headerRight.appendChild(btnStats)
    headerRight.appendChild(btnSettings)
    headerRight.appendChild(btnClose)
  }

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
    { value: 'all', label: tmText('全部', 'All') },
    { value: 'date', label: tmText('按时间', 'By date') },
    { value: 'category', label: tmText('按分类', 'By category') }
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
  fromLabel.textContent = tmText('从', 'From')
  const toLabel = document.createElement('span')
  toLabel.className = 'tm-typecho-label-muted'
  toLabel.textContent = tmText('到', 'To')
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
  catLabel.textContent = tmText('分类', 'Category')
  catGroup.appendChild(catLabel)
  catGroup.appendChild(categorySelect)
  filters.appendChild(catGroup)

  // 关键字搜索
  const searchGroup = document.createElement('div')
  searchGroup.className = 'tm-typecho-filter-group'
  const searchLabel = document.createElement('span')
  searchLabel.className = 'tm-typecho-label-muted'
  searchLabel.textContent = tmText('关键字', 'Keyword')
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.className = 'tm-typecho-input'
  searchInput.placeholder = tmText('标题 / 内容包含...', 'Title / content contains...')
  searchInput.value = sessionState.searchText || ''
  searchInput.addEventListener('input', () => {
    sessionState.searchText = searchInput.value || ''
    sessionState.pageIndex = 0
    void renderPostTable()
  })
  searchGroup.appendChild(searchLabel)
  searchGroup.appendChild(searchInput)
  filters.appendChild(searchGroup)

  // 移动端：添加过滤器折叠按钮
  if (tmIsMobile()) {
    const toggleBtn = document.createElement('button')
    toggleBtn.id = 'tm-filters-toggle-btn'
    toggleBtn.className = 'tm-typecho-btn tm-filters-toggle'
    toggleBtn.style.width = '100%'
    toggleBtn.style.minHeight = '44px'
    toggleBtn.style.marginBottom = '8px'
    toggleBtn.style.display = 'flex'
    toggleBtn.style.justifyContent = 'space-between'
    toggleBtn.style.alignItems = 'center'
    toggleBtn.style.padding = '10px 16px'

    const leftSpan = document.createElement('span')
    leftSpan.textContent = tmText('筛选条件', 'Filters')

    const rightSpan = document.createElement('span')
    rightSpan.id = 'tm-filters-toggle-icon'
    rightSpan.textContent = filtersCollapsed ? '▼' : '▲'
    rightSpan.style.fontSize = '12px'

    toggleBtn.appendChild(leftSpan)
    toggleBtn.appendChild(rightSpan)
    toggleBtn.addEventListener('click', toggleFiltersOnMobile)
    body.appendChild(toggleBtn)

    // 添加筛选摘要（折叠时显示）
    if (filtersCollapsed) {
      const summary = document.createElement('div')
      summary.id = 'tm-filters-summary'
      summary.className = 'tm-filters-summary'
      summary.textContent = getFilterSummary()
      body.appendChild(summary)
    }
  }

  // 移动端：根据折叠状态设置初始显示
  if (tmIsMobile() && filtersCollapsed) {
    filters.style.display = 'none'
  }

  body.appendChild(filters)

  // 列表
  const main = document.createElement('div')
  main.className = 'tm-typecho-main'

  const head = document.createElement('div')
  head.className = 'tm-typecho-table-head'
  ;[
    tmText('标题', 'Title'),
    tmText('分类', 'Category'),
    tmText('发布时间', 'Published at'),
    tmText('状态', 'Status'),
    tmText('操作', 'Actions'),
  ].forEach((t, idx) => {
    const th = document.createElement('div')
    th.className = 'tm-typecho-th'
    if (idx === 0) {
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.style.marginRight = '6px'
      cb.addEventListener('change', () => {
        if (!sessionState.selectedIds) sessionState.selectedIds = new Set()
        const pageItems = sessionState.lastPageItems || []
        for (const p of pageItems) {
          const cid = p.postid || p.postId || p.cid || p.id
          if (!cid && cid !== 0) continue
          const key = String(cid)
          if (cb.checked) sessionState.selectedIds.add(key)
          else sessionState.selectedIds.delete(key)
        }
        void renderPostTable()
      })
      headSelectAllCheckbox = cb
      th.appendChild(cb)
      const span = document.createElement('span')
      span.textContent = t
      th.appendChild(span)
    } else {
      th.textContent = t
    }
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
  dirLabel.textContent = tmText('默认下载目录：', 'Default download directory: ')
  defaultDirInput = document.createElement('input')
  defaultDirInput.type = 'text'
  defaultDirInput.className = 'tm-typecho-input'
  defaultDirInput.placeholder = tmText('例如: typecho-import', 'e.g. typecho-import')
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
  btnBrowseFooterDir.textContent = tmText('浏览...', 'Browse...')
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
        if (dir) return
      }
      // Android 兜底：直接走 SAF 选文件夹（避免“只能选到指定文件 / 选目录不可用”）
      try {
        const safDir = await safPickFolderForPlugin(ctx)
        if (safDir) {
          defaultDirInput.value = String(safDir || '')
          sessionState.settings.defaultDownloadDir = defaultDirInput.value.trim()
          await saveSettings(ctx, sessionState.settings)
          return
        }
      } catch (e) {
        // 继续走后续兜底（桌面/旧宿主）
      }
      if (ctx.pickDocFiles && typeof ctx.pickDocFiles === 'function') {
        const files = await ctx.pickDocFiles({ multiple: false })
        const first = Array.isArray(files) ? (files[0] || '') : (files || '')
        const p = String(first || '').trim()
        if (!p) return
        if (isContentUriPath(p)) {
          ctx.ui.notice(tmText('Android 外置库请使用“浏览...”选择文件夹（SAF），不要选文件。', 'On Android, please pick a folder (SAF) instead of a file.'), 'err', 2600)
          return
        }
        const dir = p.replace(/[\\/][^\\/]*$/, '')
        defaultDirInput.value = dir
        sessionState.settings.defaultDownloadDir = defaultDirInput.value.trim()
        await saveSettings(ctx, sessionState.settings)
        return
      }
      ctx.ui.notice(
        tmText('当前环境不支持目录浏览，请在桌面版中使用。', 'Directory picker not supported in current environment, please use desktop version.'),
        'err',
        2600,
      )
    } catch (e) {
      console.error('[Typecho Manager] 选择默认下载目录失败（底部）', e)
      try {
        const msg = e && e.message ? String(e.message) : String(e || '未知错误')
        ctx.ui.notice(
          tmText('选择默认下载目录失败：', 'Failed to choose default download directory: ') + msg,
          'err',
          2600,
        )
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
  cbText.textContent = tmText('始终下载到默认目录（否则下载到当前文件所在目录）', 'Always download to default directory (otherwise use current file directory)')
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

  const btnBatchDownload = document.createElement('button')
  btnBatchDownload.className = 'tm-typecho-btn'
  btnBatchDownload.textContent = tmText('批量下载选中', 'Download selected')
  btnBatchDownload.addEventListener('click', () => { void batchDownloadSelected(globalContextRef) })

  const btnMigrateImages = document.createElement('button')
  btnMigrateImages.className = 'tm-typecho-btn'
  btnMigrateImages.textContent = tmText('迁移图床', 'Migrate images')
  btnMigrateImages.addEventListener('click', () => { void batchMigrateImages(globalContextRef) })

  prevPageBtn = document.createElement('button')
  prevPageBtn.className = 'tm-typecho-btn tm-typecho-btn-page'
  prevPageBtn.textContent = tmText('上一页', 'Prev page')
  if (tmIsMobile()) {
    prevPageBtn.style.minHeight = '44px'
    prevPageBtn.style.padding = '10px 16px'
    prevPageBtn.style.fontSize = '14px'
  }
  prevPageBtn.addEventListener('click', () => {
    if (sessionState.pageIndex > 0) {
      sessionState.pageIndex--
      void renderPostTable()
    }
  })

  nextPageBtn = document.createElement('button')
  nextPageBtn.className = 'tm-typecho-btn tm-typecho-btn-page'
  nextPageBtn.textContent = tmText('下一页', 'Next page')
  if (tmIsMobile()) {
    nextPageBtn.style.minHeight = '44px'
    nextPageBtn.style.padding = '10px 16px'
    nextPageBtn.style.fontSize = '14px'
  }
  nextPageBtn.addEventListener('click', () => {
    sessionState.pageIndex++
    void renderPostTable()
  })

  footerRight.appendChild(pageInfoEl)
  footerRight.appendChild(btnMigrateImages)
  footerRight.appendChild(btnBatchDownload)
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

function getSelectedPosts() {
  const result = []
  if (!sessionState.selectedIds || !sessionState.selectedIds.size) return result
  const ids = sessionState.selectedIds
  for (const p of sessionState.posts || []) {
    const cid = p.postid || p.postId || p.cid || p.id
    if (!cid && cid !== 0) continue
    if (ids.has(String(cid))) result.push(p)
  }
  return result
}

function closeRowContextMenu() {
  if (rowContextMenuEl) {
    try { rowContextMenuEl.parentNode && rowContextMenuEl.parentNode.removeChild(rowContextMenuEl) } catch {}
    rowContextMenuEl = null
  }
}

// 移动端头部菜单功能
function openHeaderMenu(context) {
  closeHeaderMenu()

  const overlay = document.createElement('div')
  overlay.className = 'tm-header-menu-overlay'
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeHeaderMenu()
  })

  const menu = document.createElement('div')
  menu.className = 'tm-header-menu'

  const addMenuItem = (text, onClick) => {
    const item = document.createElement('button')
    item.className = 'tm-header-menu-item'
    item.textContent = text
    item.addEventListener('click', () => {
      closeHeaderMenu()
      onClick && onClick()
    })
    menu.appendChild(item)
  }

  addMenuItem(tmText('相关文章', 'Related posts'), () => {
    void openRelatedPostsDialog(context)
  })

  addMenuItem(tmText('统计 / 健康', 'Stats / health'), () => {
    void openStatsDialog(context)
  })

  addMenuItem(tmText('连接 / 下载设置', 'Connection / download settings'), () => {
    void openSettingsDialog(context)
  })

  overlay.appendChild(menu)
  document.body.appendChild(overlay)
  headerMenuEl = overlay

  // 添加滑入动画
  requestAnimationFrame(() => {
    overlay.style.opacity = '1'
    menu.style.transform = 'translateY(0)'
  })
}

function closeHeaderMenu() {
  if (headerMenuEl) {
    headerMenuEl.style.opacity = '0'
    const menu = headerMenuEl.querySelector('.tm-header-menu')
    if (menu) menu.style.transform = 'translateY(100%)'
    setTimeout(() => {
      headerMenuEl?.remove()
      headerMenuEl = null
    }, 200)
  }
}

function toggleFiltersOnMobile() {
  if (!tmIsMobile()) return
  filtersCollapsed = !filtersCollapsed

  try {
    localStorage.setItem(LS_FILTERS_COLLAPSED_KEY, String(filtersCollapsed))
  } catch {}

  updateFiltersPanelVisibility()
}

// 获取筛选条件摘要
function getFilterSummary() {
  const parts = []
  if (sessionState.filterMode === 'date' && (sessionState.dateFrom || sessionState.dateTo)) {
    parts.push(`${tmText('时间', 'Time')}: ${sessionState.dateFrom || tmText('始', 'Start')} ~ ${sessionState.dateTo || tmText('今', 'Now')}`)
  }
  if (sessionState.filterMode === 'category' && sessionState.filterCategory) {
    parts.push(`${tmText('分类', 'Category')}: ${sessionState.filterCategory}`)
  }
  if (sessionState.searchText) {
    parts.push(`${tmText('关键字', 'Keyword')}: ${sessionState.searchText}`)
  }
  return parts.length ? parts.join(' · ') : tmText('暂无筛选', 'No filters')
}

function updateFiltersPanelVisibility() {
  if (!tmIsMobile()) return

  const filtersEl = document.querySelector('.tm-typecho-filters')
  const toggleBtn = document.getElementById('tm-filters-toggle-btn')
  const toggleIcon = document.getElementById('tm-filters-toggle-icon')
  const summary = document.getElementById('tm-filters-summary')

  if (!filtersEl || !toggleBtn) return

  if (filtersCollapsed) {
    // 折叠：隐藏筛选条，显示摘要
    filtersEl.style.maxHeight = '0'
    filtersEl.style.overflow = 'hidden'
    filtersEl.style.opacity = '0'
    filtersEl.style.transition = 'max-height 0.3s ease, opacity 0.2s ease'
    filtersEl.style.display = 'flex'  // 保持 flex 以便动画

    if (toggleIcon) toggleIcon.textContent = '▼'

    // 显示或更新摘要
    if (!summary) {
      const s = document.createElement('div')
      s.id = 'tm-filters-summary'
      s.className = 'tm-filters-summary'
      s.textContent = getFilterSummary()
      toggleBtn.after(s)
    } else {
      summary.textContent = getFilterSummary()
      summary.style.display = 'block'
    }
  } else {
    // 展开：显示筛选条，隐藏摘要
    filtersEl.style.maxHeight = '1000px'
    filtersEl.style.overflow = 'visible'
    filtersEl.style.opacity = '1'
    filtersEl.style.display = 'flex'

    if (toggleIcon) toggleIcon.textContent = '▲'

    // 隐藏摘要
    if (summary) summary.style.display = 'none'
  }
}

async function openRowContextMenu(context, post, x, y) {
  if (!context || !post) return
  ensureStyle()
  closeRowContextMenu()

  const menu = document.createElement('div')
  menu.className = 'tm-typecho-row-menu'

  // 暂时设置在 (0,0) 以获取真实尺寸
  menu.style.left = '0px'
  menu.style.top = '0px'
  menu.style.visibility = 'hidden'

  const addItem = (label, fn) => {
    const item = document.createElement('div')
    item.className = 'tm-typecho-row-menu-item'
    item.textContent = label
    item.addEventListener('click', () => {
      closeRowContextMenu()
      try { fn && fn() } catch {}
    })
    menu.appendChild(item)
  }

  addItem(tmText('下载到本地', 'Download to local'), () => { void downloadSinglePost(context, post) })
  addItem(tmText('用当前文档更新', 'Update from current document'), () => { void publishCurrentForPost(context, post) })
  const sep = document.createElement('div')
  sep.className = 'tm-typecho-row-menu-sep'
  menu.appendChild(sep)
  addItem(tmText('回滚到备份版本', 'Rollback to backup version'), () => { void openRollbackDialog(context, post) })

  document.body.appendChild(menu)
  rowContextMenuEl = menu

  // 智能边界检测
  const rect = menu.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const pad = 8 // 边距

  let finalX = Math.max(pad, x - 4)
  let finalY = Math.max(pad, y - 4)

  // 右侧溢出检测
  if (finalX + rect.width > vw - pad) {
    finalX = vw - rect.width - pad
  }

  // 底部溢出检测
  if (finalY + rect.height > vh - pad) {
    finalY = vh - rect.height - pad
  }

  // 确保不小于最小边距
  finalX = Math.max(pad, finalX)
  finalY = Math.max(pad, finalY)

  menu.style.left = finalX + 'px'
  menu.style.top = finalY + 'px'
  menu.style.visibility = 'visible'

  const handler = (e) => {
    try {
      if (menu && !menu.contains(e.target)) {
        closeRowContextMenu()
      }
    } catch {
      closeRowContextMenu()
    }
  }
  setTimeout(() => {
    document.addEventListener('mousedown', handler, { once: true, capture: true })
    document.addEventListener('touchstart', handler, { once: true, capture: true }) // 新增触摸支持
  }, 0)
}

// 移动端底部操作表功能
async function openCardActionSheet(context, post) {
  if (!context || !post) return
  closeCardActionSheet()

  const overlay = document.createElement('div')
  overlay.className = 'tm-action-sheet-overlay'
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCardActionSheet()
  })

  const sheet = document.createElement('div')
  sheet.className = 'tm-action-sheet'

  const addAction = (icon, label, fn, danger = false) => {
    const btn = document.createElement('button')
    btn.className = 'tm-action-sheet-item'
    if (danger) btn.classList.add('danger')
    btn.textContent = `${icon} ${label}`
    btn.addEventListener('click', () => {
      closeCardActionSheet()
      fn && fn()
    })
    sheet.appendChild(btn)
  }

  const title = document.createElement('div')
  title.className = 'tm-action-sheet-title'
  title.textContent = String(post.title || '').trim() || tmText('操作', 'Actions')
  sheet.appendChild(title)

  addAction('⬇', tmText('下载到本地', 'Download to local'), () => {
    void downloadSinglePost(context, post)
  })

  addAction('↑', tmText('用当前文档更新', 'Update from current'), () => {
    void publishCurrentForPost(context, post)
  })

  addAction('⟲', tmText('回滚到备份', 'Rollback'), () => {
    void openRollbackDialog(context, post)
  }, true)

  const btnCancel = document.createElement('button')
  btnCancel.className = 'tm-action-sheet-cancel'
  btnCancel.textContent = tmText('取消', 'Cancel')
  btnCancel.addEventListener('click', closeCardActionSheet)
  sheet.appendChild(btnCancel)

  overlay.appendChild(sheet)
  document.body.appendChild(overlay)
  cardActionSheetEl = overlay

  // 添加滑入动画
  requestAnimationFrame(() => {
    overlay.style.opacity = '1'
    sheet.style.transform = 'translateY(0)'
  })
}

function closeCardActionSheet() {
  if (cardActionSheetEl) {
    cardActionSheetEl.style.opacity = '0'
    const sheet = cardActionSheetEl.querySelector('.tm-action-sheet')
    if (sheet) sheet.style.transform = 'translateY(100%)'
    setTimeout(() => {
      cardActionSheetEl?.remove()
      cardActionSheetEl = null
    }, 200)
  }
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
      context.ui.notice(
        tmText('请先在“连接 / 下载设置”中配置 XML-RPC 地址、用户名和密码', 'Please configure XML-RPC endpoint, username and password in "Connection / download settings" first'),
        'err',
        2600,
      )
      if (statusEl) statusEl.textContent = tmText('未配置连接', 'Not configured')
      return
    }
    if (statusEl) statusEl.textContent = tmText('正在从 Typecho 拉取文章...', 'Fetching posts from Typecho...')

    const posts = await loadAllPosts(context, sessionState.settings)
    sessionState.posts = Array.isArray(posts) ? posts : []
    sessionState.categories = extractCategoriesFromPosts(sessionState.posts)
    sessionState.pageIndex = 0
    sessionState.selectedIds = new Set()

    // 更新分类下拉
    if (categorySelect) {
      categorySelect.innerHTML = ''
      const optAll = document.createElement('option')
      optAll.value = ''
      optAll.textContent = tmText('全部分类', 'All categories')
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
    if (statusEl) statusEl.textContent = tmText('已加载 ', 'Loaded ') + `${sessionState.posts.length}` + tmText(' 篇', ' posts')
  } catch (e) {
    console.error('[Typecho Manager] 刷新文章失败', e)
    const msg = e && e.message ? e.message : String(e || '未知错误')
    if (statusEl) statusEl.textContent = tmText('加载失败', 'Load failed')
    try {
      globalContextRef?.ui?.notice?.(
        tmText('加载 Typecho 文章失败：', 'Failed to load Typecho posts: ') + msg,
        'err',
        3200,
      )
    } catch {}
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
  header.textContent = tmText('相关文章助手', 'Related posts helper')
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
    p.textContent = tmText('尚未加载远端文章，请先在主窗口中点击“刷新列表”。', 'Remote posts not loaded yet. Please click "Refresh list" in the main window first.')
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
      p.textContent = tmText('根据当前文档的标题 / 分类 / 标签，未找到明显相关的文章。', 'No clearly related posts found based on current document title / categories / tags.')
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
        titleSpan.textContent = item.title || tmText('(未命名)', '(Untitled)')
        titleSpan.style.fontSize = '13px'
        titleSpan.style.fontWeight = '600'
        const scoreSpan = document.createElement('span')
        scoreSpan.style.fontSize = '11px'
        scoreSpan.style.color = 'var(--muted)'
        scoreSpan.textContent = tmText('匹配分: ', 'Score: ') + item.score
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
        btnInsertLink.textContent = tmText('插入链接', 'Insert link')
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
            context.ui.notice(tmText('已插入相关文章链接', 'Inserted related post link'), 'ok', 2000)
          } catch (e) {
            console.error('[Typecho Manager] 插入相关文章链接失败', e)
            try {
              const msg = e && e.message ? String(e.message) : String(e || '未知错误')
              context.ui.notice(tmText('插入链接失败：', 'Failed to insert link: ') + msg, 'err', 2600)
            } catch {}
          }
        })
        const btnDownload = document.createElement('button')
        btnDownload.type = 'button'
        btnDownload.className = 'tm-typecho-btn'
        btnDownload.textContent = tmText('下载到本地', 'Download to local')
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
  btnClose.textContent = tmText('关闭', 'Close')
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
  header.textContent = tmText('统计 / 健康检查', 'Stats / health check')
  dlg.appendChild(header)

  const body = document.createElement('div')
  body.className = 'tm-typecho-settings-body'
  dlg.appendChild(body)

  const posts = Array.isArray(sessionState.posts) ? sessionState.posts : []
  if (!posts.length) {
    const p = document.createElement('div')
    p.style.fontSize = '12px'
    p.style.color = 'var(--muted)'
    p.textContent = tmText('尚未加载远端文章，请先在主窗口中点击“刷新列表”。', 'Remote posts not loaded yet. Please click "Refresh list" in the main window first.')
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

    addLine(tmText('总文章数：', 'Total posts: ') + total)
    addLine(tmText('已发布：', 'Published: ') + published)
    addLine(tmText('草稿：', 'Drafts: ') + drafts)
    addLine(tmText('无分类文章：', 'Posts without category: ') + noCategory)
    addLine(tmText('无标签文章：', 'Posts without tags: ') + noTags)

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
        empty.textContent = tmText('无数据', 'No data')
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

    topWrap.appendChild(buildTopList(tmText('分类 Top', 'Category Top'), cats))
    topWrap.appendChild(buildTopList(tmText('标签 Top', 'Tag Top'), tags))

    body.appendChild(topWrap)
  }

  const footer = document.createElement('div')
  footer.className = 'tm-typecho-settings-footer'
  const btnClose = document.createElement('button')
  btnClose.className = 'tm-typecho-btn'
  btnClose.textContent = tmText('关闭', 'Close')
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

async function batchDownloadSelected(context) {
  if (!context) return
  const list = getSelectedPosts()
  if (!list.length) {
    try {
      context.ui.notice(
        tmText('请先勾选要下载的文章', 'Please select posts to download first'),
        'err',
        2200,
      )
    } catch {}
    return
  }
  let ok = false
  try {
    ok = await context.ui.confirm(`将下载 ${list.length} 篇文章到本地，是否继续？`)
  } catch {}
  if (!ok) return
  for (const p of list) {
    try { // 单篇下载内部已有错误提示
      // eslint-disable-next-line no-await-in-loop
      await downloadSinglePost(context, p)
    } catch {}
  }
}

// ---- 图床迁移：行内/引用式 Markdown 图片 + cover/thumbnail/thumb ----

function tmEscapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tmNormalizeImgRefId(id) {
  return String(id || '').trim().toLowerCase()
}

function tmIsHttpUrl(u) {
  const s = String(u || '').trim().toLowerCase()
  return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('//')
}

function tmResolveUrl(raw, baseUrl) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s.startsWith('data:') || s.startsWith('file:') || s.startsWith('about:')) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('//')) return 'https:' + s
  if (!baseUrl) return s
  try {
    const u = new URL(s, baseUrl)
    return u.toString()
  } catch {
    return s
  }
}

function tmPickFileNameFromUrl(u, fallbackPrefix) {
  try {
    const urlObj = new URL(u)
    const parts = urlObj.pathname.split('/')
    const last = parts.pop() || ''
    const safe = last.replace(/[\\/:*?"<>|]/g, '').replace(/^\s+|\s+$/g, '')
    if (safe) return safe
  } catch {}
  return `${fallbackPrefix || 'image'}-${Date.now()}.png`
}

function tmGuessExtFromTypeOrName(contentType, name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  if (m) return m[1]
  const t = String(contentType || '').toLowerCase()
  if (/jpeg/.test(t)) return 'jpg'
  if (/png/.test(t)) return 'png'
  if (/gif/.test(t)) return 'gif'
  if (/webp/.test(t)) return 'webp'
  if (/bmp/.test(t)) return 'bmp'
  if (/avif/.test(t)) return 'avif'
  if (/svg/.test(t)) return 'svg'
  return 'png'
}

function tmBaseNameNoExt(name) {
  const n = String(name || '').split(/[\\/]+/).pop() || String(name || '')
  return n.replace(/\.[^.]+$/, '')
}

function tmMd5Hex(input) {
  const x = input instanceof Uint8Array ? input : new Uint8Array(input || new ArrayBuffer(0))
  const len = x.length
  const words = new Uint32Array(((len + 8 >>> 6) + 1) << 4)
  for (let i = 0; i < len; i++) words[i >> 2] |= x[i] << ((i % 4) << 3)
  const bitLen = len * 8
  words[bitLen >> 5] |= 0x80 << (bitLen % 32)
  words[((bitLen + 64 >>> 9) << 4) + 14] = bitLen
  let a = 1732584193; let b = -271733879; let c = -1732584194; let d = 271733878
  const ff = (aa, bb, cc, dd, x0, s, t) => (((aa + ((bb & cc) | (~bb & dd)) + x0 + t) << s | (aa + ((bb & cc) | (~bb & dd)) + x0 + t) >>> (32 - s)) + bb) | 0
  const gg = (aa, bb, cc, dd, x0, s, t) => (((aa + ((bb & dd) | (cc & ~dd)) + x0 + t) << s | (aa + ((bb & dd) | (cc & ~dd)) + x0 + t) >>> (32 - s)) + bb) | 0
  const hh = (aa, bb, cc, dd, x0, s, t) => (((aa + (bb ^ cc ^ dd) + x0 + t) << s | (aa + (bb ^ cc ^ dd) + x0 + t) >>> (32 - s)) + bb) | 0
  const ii = (aa, bb, cc, dd, x0, s, t) => (((aa + (cc ^ (bb | ~dd)) + x0 + t) << s | (aa + (cc ^ (bb | ~dd)) + x0 + t) >>> (32 - s)) + bb) | 0
  for (let i = 0; i < words.length; i += 16) {
    const oa = a; const ob = b; const oc = c; const od = d
    a = ff(a, b, c, d, words[i + 0], 7, -680876936)
    d = ff(d, a, b, c, words[i + 1], 12, -389564586)
    c = ff(c, d, a, b, words[i + 2], 17, 606105819)
    b = ff(b, c, d, a, words[i + 3], 22, -1044525330)
    a = ff(a, b, c, d, words[i + 4], 7, -176418897)
    d = ff(d, a, b, c, words[i + 5], 12, 1200080426)
    c = ff(c, d, a, b, words[i + 6], 17, -1473231341)
    b = ff(b, c, d, a, words[i + 7], 22, -45705983)
    a = ff(a, b, c, d, words[i + 8], 7, 1770035416)
    d = ff(d, a, b, c, words[i + 9], 12, -1958414417)
    c = ff(c, d, a, b, words[i + 10], 17, -42063)
    b = ff(b, c, d, a, words[i + 11], 22, -1990404162)
    a = ff(a, b, c, d, words[i + 12], 7, 1804603682)
    d = ff(d, a, b, c, words[i + 13], 12, -40341101)
    c = ff(c, d, a, b, words[i + 14], 17, -1502002290)
    b = ff(b, c, d, a, words[i + 15], 22, 1236535329)
    a = gg(a, b, c, d, words[i + 1], 5, -165796510)
    d = gg(d, a, b, c, words[i + 6], 9, -1069501632)
    c = gg(c, d, a, b, words[i + 11], 14, 643717713)
    b = gg(b, c, d, a, words[i + 0], 20, -373897302)
    a = gg(a, b, c, d, words[i + 5], 5, -701558691)
    d = gg(d, a, b, c, words[i + 10], 9, 38016083)
    c = gg(c, d, a, b, words[i + 15], 14, -660478335)
    b = gg(b, c, d, a, words[i + 4], 20, -405537848)
    a = gg(a, b, c, d, words[i + 9], 5, 568446438)
    d = gg(d, a, b, c, words[i + 14], 9, -1019803690)
    c = gg(c, d, a, b, words[i + 3], 14, -187363961)
    b = gg(b, c, d, a, words[i + 8], 20, 1163531501)
    a = gg(a, b, c, d, words[i + 13], 5, -1444681467)
    d = gg(d, a, b, c, words[i + 2], 9, -51403784)
    c = gg(c, d, a, b, words[i + 7], 14, 1735328473)
    b = gg(b, c, d, a, words[i + 12], 20, -1926607734)
    a = hh(a, b, c, d, words[i + 5], 4, -378558)
    d = hh(d, a, b, c, words[i + 8], 11, -2022574463)
    c = hh(c, d, a, b, words[i + 11], 16, 1839030562)
    b = hh(b, c, d, a, words[i + 14], 23, -35309556)
    a = hh(a, b, c, d, words[i + 1], 4, -1530992060)
    d = hh(d, a, b, c, words[i + 4], 11, 1272893353)
    c = hh(c, d, a, b, words[i + 7], 16, -155497632)
    b = hh(b, c, d, a, words[i + 10], 23, -1094730640)
    a = hh(a, b, c, d, words[i + 13], 4, 681279174)
    d = hh(d, a, b, c, words[i + 0], 11, -358537222)
    c = hh(c, d, a, b, words[i + 3], 16, -722521979)
    b = hh(b, c, d, a, words[i + 6], 23, 76029189)
    a = hh(a, b, c, d, words[i + 9], 4, -640364487)
    d = hh(d, a, b, c, words[i + 12], 11, -421815835)
    c = hh(c, d, a, b, words[i + 15], 16, 530742520)
    b = hh(b, c, d, a, words[i + 2], 23, -995338651)
    a = ii(a, b, c, d, words[i + 0], 6, -198630844)
    d = ii(d, a, b, c, words[i + 7], 10, 1126891415)
    c = ii(c, d, a, b, words[i + 14], 15, -1416354905)
    b = ii(b, c, d, a, words[i + 5], 21, -57434055)
    a = ii(a, b, c, d, words[i + 12], 6, 1700485571)
    d = ii(d, a, b, c, words[i + 3], 10, -1894986606)
    c = ii(c, d, a, b, words[i + 10], 15, -1051523)
    b = ii(b, c, d, a, words[i + 1], 21, -2054922799)
    a = ii(a, b, c, d, words[i + 8], 6, 1873313359)
    d = ii(d, a, b, c, words[i + 15], 10, -30611744)
    c = ii(c, d, a, b, words[i + 6], 15, -1560198380)
    b = ii(b, c, d, a, words[i + 13], 21, 1309151649)
    a = (a + oa) | 0
    b = (b + ob) | 0
    c = (c + oc) | 0
    d = (d + od) | 0
  }
  const r = new DataView(new ArrayBuffer(16))
  r.setUint32(0, a, true)
  r.setUint32(4, b, true)
  r.setUint32(8, c, true)
  r.setUint32(12, d, true)
  const out = []
  const b8 = new Uint8Array(r.buffer)
  for (let i = 0; i < b8.length; i++) out.push(b8[i].toString(16).padStart(2, '0'))
  return out.join('')
}

async function tmMakeKeyFromTemplate(template, fileName, contentType, bytesInput) {
  const u8 = bytesInput instanceof Uint8Array ? bytesInput : new Uint8Array(bytesInput || new ArrayBuffer(0))
  const now = new Date()
  const year = String(now.getFullYear())
  const month = pad2(now.getMonth() + 1)
  const day = pad2(now.getDate())
  const hour = pad2(now.getHours())
  const minute = pad2(now.getMinutes())
  const second = pad2(now.getSeconds())
  const extName = tmGuessExtFromTypeOrName(contentType, fileName)
  const fileBase = tmBaseNameNoExt(fileName)
  let key = template || '{year}/{month}{fileName}{md5}.{extName}'
  let md5 = ''
  try {
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    md5 = tmMd5Hex(buf)
  } catch { md5 = '' }
  key = key
    .replace(/\{year\}/g, year)
    .replace(/\{month\}/g, month)
    .replace(/\{day\}/g, day)
    .replace(/\{hour\}/g, hour)
    .replace(/\{minute\}/g, minute)
    .replace(/\{second\}/g, second)
    .replace(/\{fileName\}/g, fileBase)
    .replace(/\{md5\}/g, md5)
    .replace(/\{extName\}/g, extName)
  return key.replace(/^\/+/, '')
}

function tmParseMarkdownImages(body) {
  const lines = String(body || '').split(/\r?\n/)
  const inlineMatches = []
  const refDefs = new Map()
  const refUses = new Set()
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    let m
    const inlineRe = /!\[[^\]]*]\((\s*<?)([^)\s]+)(>?)([^)]*)\)/g
    while ((m = inlineRe.exec(line))) {
      const url = String(m[2] || '').trim()
      if (url) inlineMatches.push({ url, lineIndex: i })
    }

    const refUseRe = /!\[[^\]]*]\[([^\]]+)\]/g
    while ((m = refUseRe.exec(line))) {
      const id = tmNormalizeImgRefId(m[1])
      if (id) refUses.add(id)
    }

    const defMatch = line.match(/^\s*\[([^\]]+)\]:\s*(\S+)(.*)$/)
    if (defMatch) {
      const idRaw = defMatch[1]
      const id = tmNormalizeImgRefId(idRaw)
      if (!id) continue
      const url = String(defMatch[2] || '').trim()
      const tail = defMatch[3] || ''
      // 同名定义取最后一个，符合 Markdown 覆盖语义
      refDefs.set(id, { idRaw, url, tail, lineIndex: i })
    }
  }
  return { lines, inlineMatches, refDefs, refUses }
}

function tmApplyImageReplacements(parsed, urlMap) {
  const lines = parsed.lines.slice()
  if (!urlMap || !urlMap.size) return lines.join('\n')

  const inlineRe = /!\[([^\]]*)]\((\s*<?)([^)\s]+)(>?)([^)]*)\)/g
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    line = line.replace(inlineRe, (full, alt, p1, url, p3, tail) => {
      const key = String(url || '').trim()
      const nu = urlMap.get(key)
      if (!nu) return full
      return `![${alt}](${p1 || ''}${nu}${p3 || ''}${tail || ''})`
    })
    lines[i] = line
  }

  for (const [id, def] of parsed.refDefs.entries()) {
    if (parsed.refUses.size && !parsed.refUses.has(id)) continue
    const nu = urlMap.get(String(def.url || '').trim())
    if (!nu) continue
    const safeId = tmEscapeRegExp(def.idRaw || '')
    const reg = new RegExp(`^(\\s*\\[${safeId}\\]:\\s*)(\\S+)(.*)$`)
    lines[def.lineIndex] = (lines[def.lineIndex] || '').replace(reg, (_, pfx, _oldUrl, tail) => `${pfx}${nu}${tail || ''}`)
  }

  return lines.join('\n')
}

function tmOpenMigrateOverlay() {
  try { tmCloseMigrateOverlay() } catch {}
  if (!migrateStyleReady) {
    const id = 'tm-typecho-migrate-style'
    if (!document.getElementById(id)) {
      const style = document.createElement('style')
      style.id = id
      style.textContent = [
        '.tm-typecho-migrate-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:' + (TM_Z_INDEX.OVERLAY + 1) + ';}',
        '.tm-typecho-migrate-dialog{width:520px;max-width:90vw;background:var(--bg);color:var(--fg);border-radius:10px;border:1px solid var(--border);box-shadow:0 14px 36px rgba(0,0,0,.35);padding:16px;display:flex;flex-direction:column;gap:10px;font-size:13px;}',
        '.tm-typecho-migrate-title{font-weight:600;font-size:14px;}',
        '.tm-typecho-migrate-log{min-height:140px;max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px;background:rgba(0,0,0,.02);font-family:monospace;font-size:12px;white-space:pre-wrap;}',
        '.tm-typecho-migrate-progress{font-size:12px;color:var(--muted);}',
      ].join('')
      document.head.appendChild(style)
    }
    migrateStyleReady = true
  }
  const overlay = document.createElement('div')
  overlay.className = 'tm-typecho-migrate-overlay'
  overlay.addEventListener('click', (e) => { if (e.target === overlay) tmCloseMigrateOverlay() })
  const dlg = document.createElement('div')
  dlg.className = 'tm-typecho-migrate-dialog'
  const title = document.createElement('div')
  title.className = 'tm-typecho-migrate-title'
  title.textContent = '正在迁移图片到当前图床'
  const log = document.createElement('div')
  log.className = 'tm-typecho-migrate-log'
  const progress = document.createElement('div')
  progress.className = 'tm-typecho-migrate-progress'
  progress.textContent = ''
  dlg.appendChild(title)
  dlg.appendChild(log)
  dlg.appendChild(progress)
  overlay.appendChild(dlg)
  document.body.appendChild(overlay)
  migrateOverlayEl = overlay
  migrateLogEl = log
  migrateProgressEl = progress
}

function tmAppendMigrateLog(msg, level) {
  if (!migrateLogEl) return
  const line = document.createElement('div')
  line.textContent = msg
  if (level === 'err') line.style.color = '#dc2626'
  else if (level === 'ok') line.style.color = '#16a34a'
  migrateLogEl.appendChild(line)
  try { migrateLogEl.scrollTop = migrateLogEl.scrollHeight } catch {}
}

function tmUpdateMigrateProgress(text) {
  if (migrateProgressEl) migrateProgressEl.textContent = text || ''
}

function tmCloseMigrateOverlay() {
  try {
    migrateOverlayEl?.remove()
  } catch {}
  migrateOverlayEl = null
  migrateLogEl = null
  migrateProgressEl = null
}

async function tmDownloadImage(context, url) {
  if (!context || !context.http || !context.http.fetch) throw new Error('HTTP 客户端不可用')
  const http = context.http
  const tryFetch = async (target) => {
    const resp = await http.fetch(target, { method: 'GET', responseType: http.ResponseType?.Binary })
    const ok = resp?.ok === true || (typeof resp?.status === 'number' && resp.status >= 200 && resp.status < 300)
    if (!ok) return { ok: false, status: resp?.status || 0 }
    const buf = (typeof resp.arrayBuffer === 'function') ? await resp.arrayBuffer() : resp.data
    if (buf instanceof ArrayBuffer) return { ok: true, data: new Uint8Array(buf) }
    if (buf instanceof Uint8Array) return { ok: true, data: buf }
    if (Array.isArray(buf)) return { ok: true, data: new Uint8Array(buf) }
    return { ok: false, status: resp?.status || 0 }
  }
  const first = await tryFetch(url)
  if (first.ok) return first.data
  // 兜底：若 URL 含转义的 / 或空格，尝试解码一次再请求
  if (/%2[fF]/.test(url) || /%20/.test(url)) {
    try {
      const decoded = decodeURIComponent(url)
      if (decoded && decoded !== url) {
        const second = await tryFetch(decoded)
        if (second.ok) return second.data
      }
    } catch {}
  }
  throw new Error(`HTTP ${first.status || 0}`)
}

async function tmGetActiveUploaderConfig() {
  try {
    const fn = typeof window !== 'undefined' ? window.flymdGetUploaderConfig : null
    if (fn && typeof fn === 'function') return await fn()
  } catch {}
  return null
}

async function tmUploadViaImgLa(context, cfg, bytes, fileName, contentType) {
  const payload = {
    baseUrl: cfg.baseUrl || cfg.imglaBaseUrl,
    token: cfg.token || cfg.imglaToken,
    strategyId: cfg.strategyId || cfg.imglaStrategyId || 1,
    albumId: cfg.albumId || cfg.imglaAlbumId || null,
    bytes: Array.from(bytes),
    fileName: fileName,
    contentType: contentType || 'application/octet-stream'
  }
  const res = await context.invoke('flymd_imgla_upload', { req: payload })
  if (!res || !res.public_url) throw new Error('ImgLa 上传失败：返回数据缺少 public_url')
  return res.public_url
}

async function tmUploadViaS3(context, cfg, bytes, fileName, contentType) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || new ArrayBuffer(0))
  const key = await tmMakeKeyFromTemplate(cfg.keyTemplate || '{year}/{month}{fileName}{md5}.{extName}', fileName, contentType, u8)
  const req = {
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    bucket: cfg.bucket,
    region: cfg.region || 'us-east-1',
    endpoint: cfg.endpoint || undefined,
    forcePathStyle: cfg.forcePathStyle !== false,
    customDomain: cfg.customDomain || undefined,
    aclPublicRead: cfg.aclPublicRead !== false,
    key,
    contentType: contentType || 'application/octet-stream',
    bytes: Array.from(u8)
  }
  const res = await context.invoke('upload_to_s3', { req })
  if (!res || !res.public_url) throw new Error('S3 上传失败：返回数据缺少 public_url')
  return res.public_url
}

async function tmUploadToActiveHost(context, cfg, url, bytes, contentType) {
  if (!cfg || !cfg.enabled) throw new Error('未启用图床')
  const fileName = tmPickFileNameFromUrl(url, 'image')
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let ct = contentType || ''
  if (!ct) {
    const ext = tmGuessExtFromTypeOrName('', fileName)
    if (ext === 'jpg' || ext === 'jpeg') ct = 'image/jpeg'
    else if (ext === 'png') ct = 'image/png'
    else if (ext === 'gif') ct = 'image/gif'
    else if (ext === 'webp') ct = 'image/webp'
    else if (ext === 'bmp') ct = 'image/bmp'
    else if (ext === 'svg') ct = 'image/svg+xml'
  }
  const finalCt = ct || 'application/octet-stream'
  if (cfg.provider === 'imgla') {
    return await tmUploadViaImgLa(context, cfg, u8, fileName, finalCt)
  }
  return await tmUploadViaS3(context, cfg, u8, fileName, finalCt)
}

async function migrateImagesForPost(context, post, uploaderCfg) {
  const cid = post.postid || post.postId || post.cid || post.id
  if (!cid && cid !== 0) throw new Error('文章缺少 ID')
  const s = sessionState.settings
  if (!s.endpoint || !s.username || !s.password) throw new Error('XML-RPC 未配置')

  const detail = await xmlRpcCall(context, s, 'metaWeblog.getPost', [
    String(cid),
    s.username,
    s.password
  ])

  const body = String(detail?.description || detail?.content || '')
  const baseUrl = s.baseUrl || ''
  const parsed = tmParseMarkdownImages(body)
  const urlMap = new Map()
  const downloadKeys = new Set()

  for (const it of parsed.inlineMatches) {
    const abs = tmResolveUrl(it.url, baseUrl)
    if (!tmIsHttpUrl(abs)) continue
    urlMap.set(it.url.trim(), abs)
    downloadKeys.add(abs)
  }
  for (const [id, def] of parsed.refDefs.entries()) {
    if (parsed.refUses.size && !parsed.refUses.has(id)) continue
    const abs = tmResolveUrl(def.url, baseUrl)
    if (!tmIsHttpUrl(abs)) continue
    urlMap.set(def.url.trim(), abs)
    downloadKeys.add(abs)
  }

  let coverUrlRaw = ''
  const customFieldsRaw = Array.isArray(detail?.custom_fields) ? detail.custom_fields : (Array.isArray(detail?.customFields) ? detail.customFields : [])
  const updatedCustomFields = []
  for (const field of customFieldsRaw) {
    if (!field || typeof field !== 'object') continue
    const k = String(field.key || field.name || '').trim()
    const v = String(field.value || '').trim()
    if (!k) continue
    if (k === 'thumbnail' || k === 'thumb') {
      if (v) {
        const abs = tmResolveUrl(v, baseUrl)
        if (tmIsHttpUrl(abs)) {
          urlMap.set(v, abs)
          downloadKeys.add(abs)
          coverUrlRaw = coverUrlRaw || v
        }
      }
    }
    updatedCustomFields.push({ key: k, value: v })
  }
  const topThumb = String(detail?.thumb || detail?.thumbnail || detail?.cover || '').trim()
  if (topThumb) {
    const abs = tmResolveUrl(topThumb, baseUrl)
    if (tmIsHttpUrl(abs)) {
      urlMap.set(topThumb, abs)
      downloadKeys.add(abs)
      if (!coverUrlRaw) coverUrlRaw = topThumb
    }
  }

  if (!downloadKeys.size) return { changed: false }

  const rawToNew = new Map()
  for (const [raw, abs] of urlMap.entries()) {
    const cached = tmUploadCache.get(abs)
    if (cached) {
      rawToNew.set(raw, cached)
      continue
    }
    const bytes = await tmDownloadImage(context, abs)
    const contentType = ''
    const newUrl = await tmUploadToActiveHost(context, uploaderCfg, abs, bytes, contentType || 'application/octet-stream')
    tmUploadCache.set(abs, newUrl)
    rawToNew.set(raw, newUrl)
  }

  const newBody = tmApplyImageReplacements(parsed, rawToNew)

  let newThumb = ''
  if (coverUrlRaw) {
    const nu = rawToNew.get(coverUrlRaw)
    if (nu) newThumb = nu
  }
  const newCustomFields = []
  for (const cf of updatedCustomFields) {
    if (cf.key === 'thumbnail' || cf.key === 'thumb') {
      const nu = rawToNew.get(cf.value)
      newCustomFields.push({ key: cf.key, value: nu || cf.value })
    } else {
      newCustomFields.push(cf)
    }
  }

  const title = String(detail?.title || '').trim() || `(未命名 #${cid})`
  const cats = detail?.categories || detail?.category || post.categories || []
  const tagsRaw = detail?.mt_keywords || detail?.tags || ''
  const tags = tagsRaw
    ? String(tagsRaw).split(',').map((x) => x.trim()).filter(Boolean)
    : []
  const status = String(detail?.post_status || detail?.postStatus || detail?.status || '').toLowerCase() || 'publish'
  const slug = String(detail?.wp_slug || detail?.slug || cid || '').trim()
  const excerptRaw = detail?.mt_excerpt || detail?.excerpt || ''
  const excerpt = String(excerptRaw || '').trim()
  const publishFlag = status !== 'draft'
  let dateCreated = detail?.dateCreated || detail?.date_created || detail?.pubDate || detail?.date
  try { dateCreated = dateCreated ? new Date(dateCreated) : new Date() } catch { dateCreated = new Date() }

  const postStruct = {
    title,
    description: newBody,
    mt_keywords: tags.join(','),
    categories: Array.isArray(cats) ? cats : (cats ? [cats] : []),
    post_type: 'post',
    wp_slug: slug,
    mt_allow_comments: detail?.mt_allow_comments ?? 1,
    dateCreated,
    post_status: status || 'publish'
  }
  if (excerpt) postStruct.mt_excerpt = excerpt
  if (newCustomFields.length) postStruct.custom_fields = newCustomFields
  if (newThumb) {
    postStruct.thumb = newThumb
    if (!postStruct.custom_fields) postStruct.custom_fields = []
    let hasThumb = false
    let hasThumbnail = false
    for (const cf of postStruct.custom_fields) {
      if (cf.key === 'thumb') hasThumb = true
      if (cf.key === 'thumbnail') hasThumbnail = true
    }
    if (!hasThumb) postStruct.custom_fields.push({ key: 'thumb', value: newThumb })
    if (!hasThumbnail) postStruct.custom_fields.push({ key: 'thumbnail', value: newThumb })
  }

  // 备份远端
  try {
    const backups = s.backups && typeof s.backups === 'object' ? s.backups : {}
    const key = String(cid)
    const list = Array.isArray(backups[key]) ? backups[key] : []
    list.push({ ts: new Date().toISOString(), post: detail })
    while (list.length > 5) list.shift()
    backups[key] = list
    s.backups = backups
    sessionState.settings = await saveSettings(context, s)
  } catch {}

  await xmlRpcCall(context, s, 'metaWeblog.editPost', [
    String(cid),
    s.username,
    s.password,
    postStruct,
    publishFlag
  ])

  const prevChoice = sessionState.conflictChoice
  sessionState.conflictChoice = 'overwrite'
  try {
    await downloadSinglePost(context, post)
  } finally {
    sessionState.conflictChoice = prevChoice
  }

  return { changed: true, total: rawToNew.size }
}

async function batchMigrateImages(context) {
  if (!context) return
  const list = getSelectedPosts()
  if (!list.length) {
    try { context.ui.notice('请先勾选要迁移的文章', 'err', 2200) } catch {}
    return
  }
  const uploaderCfg = await tmGetActiveUploaderConfig()
  if (!uploaderCfg || !uploaderCfg.enabled) {
    try { context.ui.notice('未启用图床：请在宿主先配置并开启图床', 'err', 2600) } catch {}
    return
  }
  tmOpenMigrateOverlay()
  tmAppendMigrateLog(`开始迁移 ${list.length} 篇文章的图片...`)
  let ok = 0
  const failed = []
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    const cid = p.postid || p.postId || p.cid || p.id
    try {
      tmUpdateMigrateProgress(`正在迁移：${i + 1}/${list.length}（ID=${cid}）`)
      const res = await migrateImagesForPost(context, p, uploaderCfg)
      if (res && res.changed) ok++
      tmAppendMigrateLog(`ID=${cid} 迁移完成，替换 ${res && res.total ? res.total : 0} 条`, 'ok')
    } catch (e) {
      const msg = e && e.message ? e.message : String(e || '未知错误')
      failed.push({ cid, msg })
      tmAppendMigrateLog(`ID=${cid} 迁移失败：${msg}`, 'err')
    }
  }
  tmUpdateMigrateProgress(`完成：成功 ${ok}/${list.length}，失败 ${failed.length}`)
  if (failed.length) {
    const errMsg = failed.map((x) => `ID=${x.cid}: ${x.msg}`).join('; ')
    try { context.ui.notice(`迁移完成：成功 ${ok}/${list.length}，失败 ${failed.length}；失败详情：${errMsg}`, 'err', 4600) } catch {}
  } else {
    try { context.ui.notice(`迁移完成：成功 ${ok}/${list.length}`, 'ok', 2600) } catch {}
  }
  setTimeout(() => { tmCloseMigrateOverlay() }, failed.length ? 5000 : 2000)
}

async function openRollbackDialog(context, post) {
  if (!context) return
  ensureStyle()
  const cid = post.postid || post.postId || post.cid || post.id
  const cidStr = String(cid || '')
  if (!cidStr) {
    try {
      context.ui.notice(
        tmText('该文章缺少 ID，无法回滚', 'This post has no ID, cannot rollback'),
        'err',
        2200,
      )
    } catch {}
    return
  }
  const s = sessionState.settings || await loadSettings(context)
  const backupsRoot = s.backups && typeof s.backups === 'object' ? s.backups : {}
  const list = Array.isArray(backupsRoot[cidStr]) ? backupsRoot[cidStr] : []
  if (!list.length) {
    try {
      context.ui.notice(
        tmText('当前文章尚无可用回滚版本', 'Current post has no available backup versions to rollback'),
        'err',
        2400,
      )
    } catch {}
    return
  }
  if (rollbackOverlayEl) {
    try { rollbackOverlayEl.parentNode && rollbackOverlayEl.parentNode.removeChild(rollbackOverlayEl) } catch {}
    rollbackOverlayEl = null
  }
  const overlay = document.createElement('div')
  overlay.className = 'tm-typecho-settings-overlay'

  const dlg = document.createElement('div')
  dlg.className = 'tm-typecho-settings-dialog'
  overlay.appendChild(dlg)

  const header = document.createElement('div')
  header.className = 'tm-typecho-settings-header'
  header.textContent = tmText(`回滚 Typecho 文章（ID=${cidStr}）`, `Rollback Typecho post (ID=${cidStr})`)
  dlg.appendChild(header)

  const body = document.createElement('div')
  body.className = 'tm-typecho-settings-body'
  dlg.appendChild(body)

  const info = document.createElement('div')
  info.style.fontSize = '11px'
  info.style.color = 'var(--muted)'
  info.style.marginBottom = '6px'
  info.textContent = tmText(
    '以下为最近保存的远端版本快照，选择一个版本可将远端文章回滚到当时的内容（不会自动修改本地文档）。',
    'Below are recently saved remote snapshots. Choosing one will rollback the remote post to that content (local document will not be modified).',
  )
  body.appendChild(info)

  const listEl = document.createElement('div')
  listEl.style.maxHeight = '320px'
  listEl.style.overflow = 'auto'

  const doRollback = async (bk) => {
    try {
      const postStruct = bk && bk.post ? bk.post : null
      if (!postStruct || typeof postStruct !== 'object') {
        context.ui.notice(
          tmText('备份数据不完整，无法回滚', 'Backup data is incomplete, cannot rollback'),
          'err',
          2400,
        )
        return
      }
      const status = String(postStruct.post_status || postStruct.postStatus || postStruct.status || '').toLowerCase()
      const draft = (status === 'draft')
      const ok = await context.ui.confirm(
        `确定将远端文章 ID=${cidStr} 回滚到备份时间 ${bk.ts} 的版本吗？\n\n` +
        `该操作仅影响远端文章，不会修改当前本地文档。`
      )
      if (!ok) return
      await xmlRpcCall(context, s, 'metaWeblog.editPost', [
        cidStr,
        s.username,
        s.password,
        postStruct,
        !draft
      ])
      context.ui.notice('远端文章已回滚到所选备份版本', 'ok', 2600)
      try { overlay.parentNode && overlay.parentNode.removeChild(overlay) } catch {}
      rollbackOverlayEl = null
    } catch (e) {
      console.error('[Typecho Manager] 回滚失败', e)
      const msg = e && e.message ? String(e.message) : String(e || '未知错误')
      try { context.ui.notice('回滚失败：' + msg, 'err', 3200) } catch {}
    }
  }

  list.slice().reverse().forEach((bk, idx) => {
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.justifyContent = 'space-between'
    row.style.alignItems = 'center'
    row.style.padding = '6px 4px'
    row.style.borderBottom = '1px solid var(--border)'

    const left = document.createElement('div')
    left.style.display = 'flex'
    left.style.flexDirection = 'column'
    const tsSpan = document.createElement('span')
    tsSpan.style.fontSize = '12px'
    tsSpan.textContent = bk.ts || '(未知时间)'
    left.appendChild(tsSpan)
    const statusSpan = document.createElement('span')
    statusSpan.style.fontSize = '11px'
    statusSpan.style.color = 'var(--muted)'
    const status = String(bk.post?.post_status || bk.post?.postStatus || bk.post?.status || '').toLowerCase()
    statusSpan.textContent = '状态：' + (status || '未知')
    left.appendChild(statusSpan)

    // 备份版本与当前列表项的简单对比（标题 / 分类 / 标签）
    try {
      const curTitle = String(post.title || '').trim()
      const bkTitle = String(bk.post?.title || '').trim()
      if (curTitle || bkTitle) {
        const tSpan = document.createElement('span')
        tSpan.style.fontSize = '11px'
        tSpan.style.color = 'var(--muted)'
        if (curTitle && bkTitle && curTitle !== bkTitle) {
          tSpan.textContent = `标题变化：当前="${curTitle}"，备份="${bkTitle}"`
        } else {
          tSpan.textContent = '标题：' + (bkTitle || curTitle || '(无)')
        }
        left.appendChild(tSpan)
      }
      const getCats = (p) => {
        const pc = p.categories || p.category || []
        const arr = Array.isArray(pc) ? pc : (pc ? [pc] : [])
        return arr.map((x) => String(x || '').trim()).filter(Boolean)
      }
      const curCats = getCats(post)
      const bkCats = getCats(bk.post || {})
      if (curCats.length || bkCats.length) {
        const cSpan = document.createElement('span')
        cSpan.style.fontSize = '11px'
        cSpan.style.color = 'var(--muted)'
        const curStr = curCats.join(', ')
        const bkStr = bkCats.join(', ')
        if (curStr !== bkStr) {
          cSpan.textContent = `分类变化：当前=[${curStr || '无'}]，备份=[${bkStr || '无'}]`
        } else {
          cSpan.textContent = '分类：' + (bkStr || curStr || '无')
        }
        left.appendChild(cSpan)
      }
      const getTags = (p) => {
        const raw = p.tags || p.mt_keywords || ''
        const arr = Array.isArray(raw) ? raw : (raw ? String(raw).split(',') : [])
        return arr.map((x) => String(x || '').trim()).filter(Boolean)
      }
      const curTags = getTags(post)
      const bkTags = getTags(bk.post || {})
      if (curTags.length || bkTags.length) {
        const tgSpan = document.createElement('span')
        tgSpan.style.fontSize = '11px'
        tgSpan.style.color = 'var(--muted)'
        const curStr2 = curTags.join(', ')
        const bkStr2 = bkTags.join(', ')
        if (curStr2 !== bkStr2) {
          tgSpan.textContent = `标签变化：当前=[${curStr2 || '无'}]，备份=[${bkStr2 || '无'}]`
        } else {
          tgSpan.textContent = '标签：' + (bkStr2 || curStr2 || '无')
        }
        left.appendChild(tgSpan)
      }
      const desc = String(bk.post?.description || bk.post?.content || '').trim()
      if (desc) {
        const snippet = desc.length > 80 ? desc.slice(0, 80) + '…' : desc
        const dSpan = document.createElement('span')
        dSpan.style.fontSize = '11px'
        dSpan.style.color = 'var(--muted)'
        dSpan.textContent = '摘要：' + snippet
        left.appendChild(dSpan)
      }
    } catch {}
    row.appendChild(left)

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tm-typecho-btn'
    btn.textContent = idx === 0 ? '最新备份' : '回滚到此版本'
    btn.addEventListener('click', () => { void doRollback(bk) })
    row.appendChild(btn)

    listEl.appendChild(row)
  })

  body.appendChild(listEl)

  const footer = document.createElement('div')
  footer.className = 'tm-typecho-settings-footer'
  const btnClose = document.createElement('button')
  btnClose.className = 'tm-typecho-btn'
  btnClose.textContent = tmText('关闭', 'Close')
  btnClose.addEventListener('click', () => {
    try { overlay.parentNode && overlay.parentNode.removeChild(overlay) } catch {}
    rollbackOverlayEl = null
  })
  footer.appendChild(btnClose)
  dlg.appendChild(footer)

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      try { overlay.parentNode && overlay.parentNode.removeChild(overlay) } catch {}
      rollbackOverlayEl = null
    }
  })

  document.body.appendChild(overlay)
  rollbackOverlayEl = overlay
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
  sessionState.lastPageItems = pageItems

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
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        void openRowContextMenu(globalContextRef, p, e.clientX, e.clientY)
      })

      const cid = p.postid || p.postId || p.cid || p.id
      const title = String(p.title || '').trim() || `(未命名 #${cid || ''})`
      const cats = p.categories || p.category || []
      const dateRaw = p.dateCreated || p.date_created || p.pubDate || p.date || ''
      const status = String(p.post_status || p.postStatus || p.status || '').toLowerCase()

      const cellTitle = document.createElement('div')
      cellTitle.className = 'tm-typecho-td tm-typecho-title'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.style.marginRight = '6px'
      checkbox.checked = !!(cid || cid === 0) && sessionState.selectedIds && sessionState.selectedIds.has(String(cid))
      checkbox.addEventListener('change', () => {
        if (!sessionState.selectedIds) sessionState.selectedIds = new Set()
        const key = String(cid)
        if (checkbox.checked) sessionState.selectedIds.add(key)
        else sessionState.selectedIds.delete(key)
      })
      cellTitle.appendChild(checkbox)
      const titleSpan = document.createElement('span')
      titleSpan.textContent = title
      cellTitle.appendChild(titleSpan)
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

      // 移动端：简化按钮布局，只显示主要操作 + 更多菜单
      if (tmIsMobile()) {
        const btnDl = document.createElement('button')
        btnDl.className = 'tm-typecho-btn tm-card-btn-primary'
        btnDl.textContent = '⬇ 下载到本地'
        btnDl.addEventListener('click', (e) => {
          e.stopPropagation()
          void downloadSinglePost(globalContextRef, p)
        })
        cellActions.appendChild(btnDl)

        const btnMore = document.createElement('button')
        btnMore.className = 'tm-typecho-btn tm-card-btn-secondary'
        btnMore.textContent = '⋯ 更多'
        btnMore.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          void openCardActionSheet(globalContextRef, p)
        })
        cellActions.appendChild(btnMore)
      } else {
        // 桌面端：保持原有按钮布局
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

        const btnRollback = document.createElement('button')
        btnRollback.className = 'tm-typecho-btn'
        btnRollback.textContent = '回滚'
        btnRollback.style.marginLeft = '6px'
        btnRollback.addEventListener('click', () => { void openRollbackDialog(globalContextRef, p) })
        cellActions.appendChild(btnRollback)
      }
      row.appendChild(cellActions)

      listBodyEl.appendChild(row)
    }
  }

  if (pageInfoEl) {
    if (total === 0) pageInfoEl.textContent = '共 0 篇'
    else pageInfoEl.textContent = `共 ${total} 篇 · 第 ${sessionState.pageIndex + 1}/${maxPageIndex + 1} 页`
  }
  if (headSelectAllCheckbox) {
    if (!pageItems.length) {
      headSelectAllCheckbox.checked = false
      headSelectAllCheckbox.indeterminate = false
    } else {
      let checkedCount = 0
      for (const p of pageItems) {
        const cid = p.postid || p.postId || p.cid || p.id
        if (!cid && cid !== 0) continue
        if (sessionState.selectedIds && sessionState.selectedIds.has(String(cid))) checkedCount++
      }
      if (checkedCount === 0) {
        headSelectAllCheckbox.checked = false
        headSelectAllCheckbox.indeterminate = false
      } else if (checkedCount === pageItems.length) {
        headSelectAllCheckbox.checked = true
        headSelectAllCheckbox.indeterminate = false
      } else {
        headSelectAllCheckbox.checked = false
        headSelectAllCheckbox.indeterminate = true
      }
    }
  }
  if (prevPageBtn) prevPageBtn.disabled = sessionState.pageIndex <= 0
  if (nextPageBtn) nextPageBtn.disabled = sessionState.pageIndex >= maxPageIndex
}

// ---- 下载到本地 & 文件工具 ----

function isContentUriPath(p) {
  return typeof p === 'string' && p.startsWith('content://')
}

// Android SAF：把 content:// URI 变成更可读的名字（仅用于提示，不做逻辑判断）
function safPrettyName(uri) {
  try {
    const raw = String(uri || '').trim()
    if (!raw) return ''
    const last = (raw.split('/').pop() || raw).trim()
    if (!last) return raw
    const decoded = decodeURIComponent(last)
    const afterSlash = decoded.split('/').pop() || decoded
    const afterColon = afterSlash.includes(':') ? (afterSlash.split(':').pop() || afterSlash) : afterSlash
    return afterColon || raw
  } catch {
    return String(uri || '')
  }
}

async function isAndroidPlatform(context) {
  try {
    if (context?.invoke) {
      const p = await context.invoke('get_platform')
      if (typeof p === 'string' && p) return p === 'android'
    }
  } catch {}
  try {
    const ua = String(navigator?.userAgent || '')
    return /Android/i.test(ua)
  } catch {
    return false
  }
}

// Android：兜底的 SAF 文件夹选择（兼容旧宿主没有 pickDirectory/或移动端不支持目录选择的情况）
async function safPickFolderForPlugin(context) {
  try {
    if (!context?.invoke) return ''
    const isAndroid = await isAndroidPlatform(context)
    if (!isAndroid) return ''
    const uri = await context.invoke('android_saf_pick_folder', { timeoutMs: 60_000 })
    return uri ? String(uri) : ''
  } catch (e) {
    const msg = String(e?.message || e || '')
    if (/cancel/i.test(msg) || /canceled/i.test(msg) || /cancellation/i.test(msg)) return ''
    throw e
  }
}

async function persistSafUriPermissionForPlugin(context, uri) {
  try {
    if (!context?.invoke) return
    if (!isContentUriPath(uri)) return
    await context.invoke('android_persist_uri_permission', { uri })
  } catch {}
}

async function safListDirForPlugin(context, uri) {
  if (!context?.invoke) throw new Error('ctx.invoke 不可用，无法列举目录')
  return await context.invoke('android_saf_list_dir', { uri })
}

async function safCreateFileForPlugin(context, parentUri, name, mimeType) {
  if (!context?.invoke) throw new Error('ctx.invoke 不可用，无法创建文件')
  // 注意：Tauri 2.0 会把 Rust 的 snake_case 参数名映射为 JS 的 camelCase
  return await context.invoke('android_saf_create_file', { parentUri, name, mimeType })
}

async function resolveSafFileUriForWrite(context, parentUri, filename) {
  await persistSafUriPermissionForPlugin(context, parentUri)

  // 先列目录判断是否存在同名文件，以便复用/覆盖，而不是对“文件夹 URI”瞎写导致 openOutputStream 失败
  let existingUri = ''
  try {
    const ents = await safListDirForPlugin(context, parentUri)
    if (Array.isArray(ents)) {
      for (const it of ents) {
        const name = String(it?.name || '').trim()
        const path = String(it?.path || '').trim()
        const isDir = !!it?.isDir
        if (!name || !path || isDir) continue
        if (name === filename) {
          existingUri = path
          break
        }
      }
    }
  } catch (e) {
    // 目录列举失败时仍尝试 createDocument；失败再把错误抛给上层提示
    existingUri = ''
  }

  if (existingUri) {
    const display = `${safPrettyName(parentUri) || '(SAF)'}${'/' + filename}`
    const decision = await resolveConflictForPath(context, display)
    if (decision === 'skip') return null
    if (decision !== 'overwrite') return null
    return existingUri
  }

  const created = await safCreateFileForPlugin(context, parentUri, filename, 'text/markdown')
  const out = String(created || '').trim()
  if (!out) throw new Error('创建文件失败：返回 URI 为空')
  return out
}

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
        // SAF(content://) 不能用字符串截断推导父目录：这会制造伪路径，后续写入必炸
        if (isContentUriPath(cur)) return null
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
      // SAF(content://) 无法从文件 URI 推导父目录：要求用户显式选择默认下载目录（文件夹）
      if (p && !isContentUriPath(p)) return p.replace(/[\\/][^\\/]*$/, '')
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
    const useSafFolder = useDefaultDir && isContentUriPath(cfgDirRaw)
    const isAbsCfg = !!cfgDirRaw && (/^[a-zA-Z]:[\\/]/.test(cfgDirRaw) || /^\\\\/.test(cfgDirRaw) || /^\//.test(cfgDirRaw))

    let baseDir = ''
    let safFolderUri = ''
    if (useSafFolder) {
      // Android 外置库：defaultDownloadDir 是 SAF 文件夹 URI（content://...），不能当“路径字符串”拼接
      safFolderUri = cfgDirRaw
    } else if (useDefaultDir && isAbsCfg) {
      // 绝对路径：直接作为最终下载目录，不依赖当前文档
      baseDir = cfgDirRaw
    } else {
      const base = await getCurrentBaseDir(context)
      if (!base) {
        context.ui.notice('无法确定下载目录：请先打开一个本地文档，或在“连接 / 下载设置”中配置默认下载目录后重试。', 'err', 3000)
        return
      }
      baseDir = base
      if (useDefaultDir) {
        baseDir = joinPath(base, cfgDirRaw)
      }
    }

    // SAF(content://) 下载：目标是“文件夹 URI”，不能当成普通路径拼接
    if (!safFolderUri && isContentUriPath(baseDir)) safFolderUri = baseDir
    const fullPath = safFolderUri ? '' : joinPath(baseDir, filename)

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

    if (safFolderUri) {
      const fileUri = await resolveSafFileUriForWrite(context, safFolderUri, filename)
      if (!fileUri) return
      await writeTextFileAny(context, fileUri, finalDoc)
      context.ui.notice(tmText('已保存到外置库：', 'Saved to SAF folder: ') + filename, 'ok', 2400)
      // 刷新文件树
      try {
        const refreshFn = typeof window !== 'undefined' ? window.flymdRefreshFileTree : null
        if (refreshFn && typeof refreshFn === 'function') {
          await refreshFn()
        }
      } catch (e) {
        console.log('[Typecho Manager] 刷新文件树失败，但不影响下载:', e)
      }
      return
    }

    const exists = await checkFileExists(context, fullPath)
    if (exists) {
      const decision = await resolveConflictForPath(context, fullPath)
      if (decision === 'skip') return
      if (decision !== 'overwrite') return
    }

    await writeTextFileAny(context, fullPath, finalDoc)
    context.ui.notice('已保存到本地：' + fullPath, 'ok', 2400)

    // 刷新文件树
    try {
      const refreshFn = typeof window !== 'undefined' ? window.flymdRefreshFileTree : null
      if (refreshFn && typeof refreshFn === 'function') {
        await refreshFn()
      }
    } catch (e) {
      console.log('[Typecho Manager] 刷新文件树失败，但不影响下载:', e)
    }
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

    const initialTitle = String(meta.title || '').trim()
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

      // 标题
      const inputTitle = document.createElement('input')
      inputTitle.type = 'text'
      inputTitle.className = 'tm-typecho-settings-input'
      inputTitle.placeholder = '若为空则使用文档标题或 (未命名)'
      inputTitle.value = initialTitle
      addRow('标题', inputTitle); rows.title = inputTitle

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
      inputCover.placeholder = tmText('可选：文章头图 URL（例如 https://.../cover.jpg）', 'Optional: cover image URL (e.g. https://.../cover.jpg)')
      inputCover.value = initialCover
      addRow(tmText('头图地址', 'Cover URL'), inputCover); rows.cover = inputCover

      const footer = document.createElement('div')
      footer.className = 'tm-typecho-settings-footer'

      const btnCancel = document.createElement('button')
      btnCancel.className = 'tm-typecho-btn'
      btnCancel.textContent = tmText('取消', 'Cancel')

      const btnOk = document.createElement('button')
      btnOk.className = 'tm-typecho-btn primary'
      btnOk.textContent = meta.cid ? tmText('更新文章', 'Update post') : tmText('发布文章', 'Publish post')

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
          title: rows.title.value || '',
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
    context.ui.notice(tmText('请先在“连接 / 下载设置”中配置 XML-RPC 地址、用户名和密码', 'Please configure XML-RPC endpoint, username and password in "Connection / download settings" first'), 'err', 2600)
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
    context.ui.notice(
      tmText('当前文档内容为空，已取消发布', 'Current document is empty, publish cancelled'),
      'err',
      2200,
    )
    return
  }
  const cid = meta.typechoId || meta.cid || meta.id

  // 获取标题：优先使用 meta.title，否则从文件名提取
  let title = String(meta.title || '').trim()
  if (!title) {
    try {
      const fn = typeof window !== 'undefined' ? window.flymdGetCurrentFilePath : null
      if (fn && typeof fn === 'function') {
        const filePath = fn()
        if (filePath && typeof filePath === 'string') {
          // 从文件路径中提取文件名（不含扩展名）
          const fileName = filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')
          if (fileName) title = fileName
        }
      }
    } catch {}
  }
  if (!title) title = tmText('(未命名)', '(Untitled)')
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
      if (uiOpts.title !== undefined) {
        const t = String(uiOpts.title || '').trim()
        if (t) title = t
      }
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
    // 同步一个顶层 thumb 字段，兼容部分 Typecho 主题
    // @ts-ignore
    postStruct.thumb = coverUrl
  }
  if (customFieldMap.size > 0) {
    postStruct.custom_fields = []
    for (const [k, v] of customFieldMap.entries()) {
      postStruct.custom_fields.push({ key: k, value: v })
    }
  }

  try {
    if (hasCid) {
      // 在更新前保存远端快照用于回滚
      if (remoteSnapshot && s) {
        try {
          const backups = s.backups && typeof s.backups === 'object' ? s.backups : {}
          const key = String(cid)
          const list = Array.isArray(backups[key]) ? backups[key] : []
          list.push({ ts: new Date().toISOString(), post: remoteSnapshot })
          while (list.length > 5) list.shift()
          backups[key] = list
          s.backups = backups
          sessionState.settings = await saveSettings(context, s)
        } catch (e) {
          console.error('[Typecho Manager] 保存回滚备份失败', e)
        }
      }
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
        try {
          const fn = typeof window !== 'undefined' ? window.flymdRenameCurrentFileForTypecho : null
          if (fn && typeof fn === 'function') {
            void fn(String(cid), title)
          }
        } catch {}
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
        try {
          const fn = typeof window !== 'undefined' ? window.flymdRenameCurrentFileForTypecho : null
          if (fn && typeof fn === 'function') {
            void fn(String(cidStr), title)
          }
        } catch {}
      } catch (e) {
        console.error('[Typecho Manager] 回写 Front Matter 失败（不影响远端新建）', e)
      }
      context.ui.notice(
        tmText('远端文章已创建（CID=', 'Remote post created (CID=') + cidStr + '）',
        'ok',
        2300,
      )
    }
  } catch (e) {
    console.error('[Typecho Manager] 发布当前文档失败', e)
    const msg = e && e.message ? e.message : String(e || '未知错误')
    context.ui.notice(
      tmText('发布/更新远端文章失败：', 'Failed to publish/update remote post: ') + msg,
      'err',
      3200,
    )
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
      tmText(
        `当前文档没有 typechoId，将使用列表中的文章 ID=${cidPost} 作为目标，是否继续？`,
        `Current document has no typechoId. Use the list post ID=${cidPost} as target and continue?`,
      ),
    )
    if (!ok) return
    meta.typechoId = String(cidPost)
  } else if (cidMeta && cidPost && String(cidMeta) !== String(cidPost)) {
    const ok = await context.ui.confirm(
      tmText(
        `当前文档的 typechoId=${cidMeta} 与列表中的 ID=${cidPost} 不一致。\n\n仍要使用当前文档覆盖列表所选远端文章吗？`,
        `Current document typechoId=${cidMeta} differs from list ID=${cidPost}.\n\nStill use current document to overwrite the selected remote post?`,
      ),
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
    header.textContent = tmText('Typecho 连接 / 下载设置', 'Typecho connection / download settings')
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
    addRow(tmText('XML-RPC 地址', 'XML-RPC endpoint'), inputEndpoint); rows.endpoint = inputEndpoint

    const inputUser = document.createElement('input')
    inputUser.type = 'text'
    inputUser.className = 'tm-typecho-settings-input'
    addRow(tmText('用户名', 'Username'), inputUser); rows.username = inputUser

    const inputPwd = document.createElement('input')
    inputPwd.type = 'password'
    inputPwd.className = 'tm-typecho-settings-input'
    addRow(tmText('密码', 'Password'), inputPwd); rows.password = inputPwd

    const inputBlogId = document.createElement('input')
    inputBlogId.type = 'text'
    inputBlogId.className = 'tm-typecho-settings-input'
    inputBlogId.placeholder = '通常为 0 或 1'
    addRow('Blog ID', inputBlogId); rows.blogId = inputBlogId

    const inputBaseUrl = document.createElement('input')
    inputBaseUrl.type = 'text'
    inputBaseUrl.className = 'tm-typecho-settings-input'
    inputBaseUrl.placeholder = 'https://blog.example.com（用于补全相对链接，可留空）'
    addRow(tmText('站点根地址', 'Site base URL'), inputBaseUrl); rows.baseUrl = inputBaseUrl

    const inputDefaultDir = document.createElement('input')
    inputDefaultDir.type = 'text'
    inputDefaultDir.className = 'tm-typecho-settings-input'
    inputDefaultDir.placeholder = tmText('typecho-import 或绝对路径', 'typecho-import or absolute path')
    const defaultDirRow = document.createElement('div')
    defaultDirRow.style.display = 'flex'
    defaultDirRow.style.gap = '8px'
    defaultDirRow.style.alignItems = 'center'
    defaultDirRow.appendChild(inputDefaultDir)
    const btnBrowseDir = document.createElement('button')
    btnBrowseDir.type = 'button'
    btnBrowseDir.className = 'tm-typecho-btn'
    btnBrowseDir.textContent = tmText('浏览...', 'Browse...')
    btnBrowseDir.addEventListener('click', async () => {
      try {
        if (context.pickDirectory && typeof context.pickDirectory === 'function') {
          const dir = await context.pickDirectory({ defaultPath: inputDefaultDir.value || undefined })
          if (dir) inputDefaultDir.value = String(dir || '')
          if (dir) return
        }
        // Android 兜底：直接走 SAF 选文件夹（避免移动端目录选择缺失导致只能选文件）
        try {
          const safDir = await safPickFolderForPlugin(context)
          if (safDir) {
            inputDefaultDir.value = String(safDir || '')
            return
          }
        } catch (e) {
          // 继续走后续兜底
        }
        if (context.pickDocFiles && typeof context.pickDocFiles === 'function') {
          const files = await context.pickDocFiles({ multiple: false })
          const first = Array.isArray(files) ? (files[0] || '') : (files || '')
          const p = String(first || '').trim()
          if (!p) return
          if (isContentUriPath(p)) {
            context.ui.notice(tmText('Android 外置库请使用“浏览...”选择文件夹（SAF），不要选文件。', 'On Android, please pick a folder (SAF) instead of a file.'), 'err', 2600)
            return
          }
          const dir = p.replace(/[\\/][^\\/]*$/, '')
          inputDefaultDir.value = dir
          return
        }
        context.ui.notice(tmText('当前环境不支持目录浏览，请在桌面版中使用。', 'Directory picker not supported in current environment, please use desktop version.'), 'err', 2600)
      } catch (e) {
        console.error('[Typecho Manager] 选择默认下载目录失败', e)
        try {
          const msg = e && e.message ? String(e.message) : String(e || '未知错误')
          context.ui.notice(tmText('选择默认下载目录失败：', 'Failed to choose default download directory: ') + msg, 'err', 2600)
        } catch {}
      }
    })
    defaultDirRow.appendChild(btnBrowseDir)
    addRow(tmText('默认下载目录', 'Default download directory'), defaultDirRow); rows.defaultDir = inputDefaultDir

    const cbWrap = document.createElement('label')
    cbWrap.className = 'tm-typecho-checkbox'
    const cbAlways = document.createElement('input')
    cbAlways.type = 'checkbox'
    const cbText = document.createElement('span')
    cbText.textContent = tmText('始终下载到默认目录（否则下载到当前文件所在目录）', 'Always download to default directory (otherwise use current file directory)')
    cbWrap.appendChild(cbAlways)
    cbWrap.appendChild(cbText)
    addRow(tmText('目录策略', 'Directory strategy'), cbWrap); rows.always = cbAlways

    dlg.appendChild(body)

    const footer = document.createElement('div')
    footer.className = 'tm-typecho-settings-footer'

    const btnCancel = document.createElement('button')
    btnCancel.className = 'tm-typecho-btn'
    btnCancel.textContent = tmText('取消', 'Cancel')
    btnCancel.addEventListener('click', () => { settingsOverlayEl.classList.add('hidden') })

    const btnTest = document.createElement('button')
    btnTest.className = 'tm-typecho-btn'
    btnTest.textContent = tmText('测试连接', 'Test connection')

    const btnSave = document.createElement('button')
    btnSave.className = 'tm-typecho-btn primary'
    btnSave.textContent = tmText('保存', 'Save')

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
      try { context.ui.notice(tmText('Typecho 设置已保存', 'Typecho settings saved'), 'ok', 2200) } catch {}

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
        context.ui.notice(tmText('请先填写完整的 XML-RPC 地址、用户名和密码', 'Please fill in XML-RPC endpoint, username and password'), 'err', 2600)
        return
      }
      try {
        await xmlRpcCall(context, tmp, 'metaWeblog.getRecentPosts', [
          String(tmp.blogId || '0'),
          tmp.username,
          tmp.password,
          1
        ])
        context.ui.notice(tmText('连接测试成功', 'Connection test succeeded'), 'ok', 2400)
      } catch (e) {
        console.error('[Typecho Manager] 连接测试失败', e)
        const msg = e && e.message ? e.message : String(e || '未知错误')
        context.ui.notice(tmText('连接测试失败：', 'Connection test failed: ') + msg, 'err', 3200)
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
let resizeTimer = null

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
        label: tmText('管理 Typecho 博文', 'Manage Typecho posts'),
        icon: '📖',
        onClick: () => { void openManager(globalContextRef) }
      })
      if (typeof disposeManage === 'function') ctxMenuDisposers.push(disposeManage)
    } catch {}
    try {
      const disposePublish = context.addContextMenuItem({
        label: tmText('发布到 Typecho', 'Publish to Typecho'),
        icon: '⬆️',
        onClick: () => { void publishCurrentDocument(globalContextRef) }
      })
      if (typeof disposePublish === 'function') ctxMenuDisposers.push(disposePublish)
    } catch {}
  }

  // 监听窗口尺寸变化（横竖屏切换适配）
  const handleResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      // 重新应用移动端样式
      if (overlayEl && !overlayEl.classList.contains('hidden')) {
        updateFiltersPanelVisibility()
        void renderPostTable() // 重绘表格以应用新的设备类型样式
      }
    }, 150)
  }

  window.addEventListener('resize', handleResize)
  window.addEventListener('orientationchange', handleResize)
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
