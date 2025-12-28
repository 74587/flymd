// 桌面端：自动语音笔记（流式 ASR，经由自建 /asr + /asr/ws 网关）
// 目标：边说边出字 + 计费/余额/充值/登录，全流程独立模块化，不污染 main.ts。

import type { Store } from '@tauri-apps/plugin-store'
import { addToPluginsMenu } from './pluginMenu'
import { getHttpClient } from './runtime'
import { acquireMic, getActiveMicOwner, type MicLease } from './micManager'

const FEATURE_ID = 'asr-note'

const ASR_BACKEND_BASE_DEFAULT = 'https://flymd.llingfei.com/asr'
const ASR_SAMPLE_RATE = 16000

const ASR_CHUNK_MS = 200
const ASR_CHUNK_BYTES = (ASR_SAMPLE_RATE * 2 * ASR_CHUNK_MS) / 1000 // 16k * 2B * 200ms = 6400

type AsrStoreState = {
  token?: string
  username?: string
}

type ActiveAsrNote = {
  token: string
  wsUrl: string
  startedAt: number
  running: boolean
  paused: boolean
  ending: 'pause' | 'stop' | ''

  wsStarted: boolean
  wsReady: boolean
  ws: WebSocket | null

  reconnectTries: number
  reconnectTimer: number | null
  pingTimer: number | null
  lastPongAt: number

  draftStart: number
  draftLen: number
  lastPartial: string

  lease: MicLease | null
  stream: MediaStream | null
  audioCtx: AudioContext | null
  sourceNode: MediaStreamAudioSourceNode | null
  processor: ScriptProcessorNode | null
  zeroGain: GainNode | null

  q: Uint8Array[]
  qLen: number

  stopTimeout: number | null
}

export type AsrNoteDeps = {
  appVersion: string
  getStore(): Store | null
  getEditor(): HTMLTextAreaElement | null
  isPreviewMode(): boolean
  isWysiwyg(): boolean
  renderPreview(): void | Promise<void>
  scheduleWysiwygRender(): void
  markDirtyAndRefresh(): void
  pluginNotice(msg: string, level?: 'ok' | 'err', ms?: number): void
  openInBrowser(url: string): void | Promise<void>
}

let _initialized = false
let _deps: AsrNoteDeps | null = null
let _active: ActiveAsrNote | null = null

export function initAsrNoteFeature(deps: AsrNoteDeps): void {
  if (_initialized) return
  _initialized = true
  _deps = deps
  updateMenu()
}

const ASR_UI_OVERLAY_ID = 'flymd-asr-ui-overlay'

type AsrLoginMode = 'login' | 'register'

function ensureAsrUiOverlay(): HTMLDivElement | null {
  try {
    const container = document.querySelector('.container') as HTMLDivElement | null
    if (!container) return null

    let ov = document.getElementById(ASR_UI_OVERLAY_ID) as HTMLDivElement | null
    if (ov) return ov

    ov = document.createElement('div')
    ov.id = ASR_UI_OVERLAY_ID
    ov.className = 'link-overlay hidden'
    ov.innerHTML = `
      <div class="link-dialog" role="dialog" aria-modal="true" aria-labelledby="flymd-asr-ui-title">
        <div class="link-header">
          <div id="flymd-asr-ui-title">自动语音笔记</div>
          <button id="flymd-asr-ui-close" class="about-close" title="关闭">×</button>
        </div>
        <div class="link-body" id="flymd-asr-ui-body"></div>
        <div class="link-actions" id="flymd-asr-ui-actions"></div>
      </div>
    `
    container.appendChild(ov)

    const close = () => {
      try { ov!.classList.add('hidden') } catch {}
      try { (ov!.querySelector('#flymd-asr-ui-body') as HTMLDivElement | null)!.innerHTML = '' } catch {}
      try { (ov!.querySelector('#flymd-asr-ui-actions') as HTMLDivElement | null)!.innerHTML = '' } catch {}
    }

    const btn = ov.querySelector('#flymd-asr-ui-close') as HTMLButtonElement | null
    if (btn) btn.addEventListener('click', close)
    ov.addEventListener('click', (e) => { if (e.target === ov) close() })

    return ov
  } catch {
    return null
  }
}

function showAsrUi(htmlBody: string, htmlActions: string, onBind: (ov: HTMLDivElement) => void): void {
  const ov = ensureAsrUiOverlay()
  if (!ov) return
  const body = ov.querySelector('#flymd-asr-ui-body') as HTMLDivElement | null
  const actions = ov.querySelector('#flymd-asr-ui-actions') as HTMLDivElement | null
  if (!body || !actions) return
  body.innerHTML = htmlBody
  actions.innerHTML = htmlActions
  ov.classList.remove('hidden')
  try { onBind(ov) } catch {}
}

async function showAsrLoginDialog(): Promise<string | null> {
  const deps = _deps
  if (!deps) return null

  return await new Promise((resolve) => {
    const htmlBody = `
      <div style="font-size:13px;line-height:1.6;">
        <div style="margin-bottom:10px;color:var(--muted);">登录后才能使用自动语音笔记（计费/余额/充值）。</div>
        <div style="display:flex;gap:12px;margin-bottom:10px;">
          <label style="display:flex;gap:6px;align-items:center;">
            <input type="radio" name="asr-login-mode" value="login" checked>
            <span>登录</span>
          </label>
          <label style="display:flex;gap:6px;align-items:center;">
            <input type="radio" name="asr-login-mode" value="register">
            <span>注册</span>
          </label>
        </div>
        <div style="display:grid;grid-template-columns:110px 1fr;gap:8px 10px;align-items:center;">
          <div>用户名</div>
          <input id="asr-username" class="input" placeholder="3~32" autocomplete="username">
          <div>密码</div>
          <input id="asr-password" class="input" placeholder="6~64" type="password" autocomplete="current-password">
        </div>
        <div id="asr-login-msg" style="margin-top:10px;color:var(--muted);"></div>
      </div>
    `
    const htmlActions = `
      <button id="asr-login-submit">确定</button>
      <button id="asr-login-cancel">取消</button>
    `

    showAsrUi(htmlBody, htmlActions, (ov) => {
      const close = () => { try { ov.classList.add('hidden') } catch {}; resolve(null) }

      const btnCancel = ov.querySelector('#asr-login-cancel') as HTMLButtonElement | null
      if (btnCancel) btnCancel.addEventListener('click', close)

      const btnOk = ov.querySelector('#asr-login-submit') as HTMLButtonElement | null
      const msgEl = ov.querySelector('#asr-login-msg') as HTMLDivElement | null
      const uEl = ov.querySelector('#asr-username') as HTMLInputElement | null
      const pEl = ov.querySelector('#asr-password') as HTMLInputElement | null

      const setMsg = (s: string, isErr: boolean) => {
        if (!msgEl) return
        msgEl.textContent = s
        msgEl.style.color = isErr ? 'var(--err, #d33)' : 'var(--muted)'
      }

      const submit = async () => {
        try {
          const mode: AsrLoginMode = (() => {
            const v = (ov.querySelector('input[name="asr-login-mode"]:checked') as HTMLInputElement | null)?.value || 'login'
            return v === 'register' ? 'register' : 'login'
          })()
          const username = String(uEl?.value || '').trim()
          const password = String(pEl?.value || '')
          if (!username || username.length < 3 || username.length > 32) {
            setMsg('用户名长度需为 3~32', true); return
          }
          if (!password || password.length < 6 || password.length > 64) {
            setMsg('密码长度需为 6~64', true); return
          }

          setMsg('处理中…', false)
          if (btnOk) btnOk.disabled = true
          if (btnCancel) btnCancel.disabled = true

          const apiPath = mode === 'login' ? '/api/auth/login/' : '/api/auth/register/'
          const resp = await asrApi(apiPath, { method: 'POST', body: { username, password } })
          const tok = String(resp?.token || '').trim()
          if (!tok) throw new Error('token 为空')
          await asrStoreSet({ token: tok, username })
          try { ov.classList.add('hidden') } catch {}
          resolve(tok)
        } catch (e) {
          setMsg('失败：' + String((e as any)?.message || e || ''), true)
          if (btnOk) btnOk.disabled = false
          if (btnCancel) btnCancel.disabled = false
        }
      }

      if (btnOk) btnOk.addEventListener('click', () => { void submit() })
      try { uEl?.focus() } catch {}
      ov.addEventListener('keydown', (ev) => {
        if ((ev as any).key === 'Escape') close()
        if ((ev as any).key === 'Enter') { void submit() }
      }, { capture: true, once: true } as any)
    })
  })
}

async function showAsrRedeemDialog(token: string): Promise<void> {
  const deps = _deps
  if (!deps) return

  await new Promise<void>((resolve) => {
    const htmlBody = `
      <div style="font-size:13px;line-height:1.6;">
        <div style="margin-bottom:10px;color:var(--muted);">输入充值卡密后兑换。</div>
        <div style="display:grid;grid-template-columns:110px 1fr;gap:8px 10px;align-items:center;">
          <div>卡密</div>
          <input id="asr-redeem-token" class="input" placeholder="例如：XXXX-XXXX-XXXX">
        </div>
        <div id="asr-redeem-msg" style="margin-top:10px;color:var(--muted);"></div>
      </div>
    `
    const htmlActions = `
      <button id="asr-redeem-submit">兑换</button>
      <button id="asr-redeem-cancel">取消</button>
    `

    showAsrUi(htmlBody, htmlActions, (ov) => {
      const close = () => { try { ov.classList.add('hidden') } catch {}; resolve() }
      const btnCancel = ov.querySelector('#asr-redeem-cancel') as HTMLButtonElement | null
      const btnOk = ov.querySelector('#asr-redeem-submit') as HTMLButtonElement | null
      const input = ov.querySelector('#asr-redeem-token') as HTMLInputElement | null
      const msgEl = ov.querySelector('#asr-redeem-msg') as HTMLDivElement | null

      const setMsg = (s: string, isErr: boolean) => {
        if (!msgEl) return
        msgEl.textContent = s
        msgEl.style.color = isErr ? 'var(--err, #d33)' : 'var(--muted)'
      }

      const submit = async () => {
        try {
          const key = String(input?.value || '').trim()
          if (!key) { setMsg('请输入卡密', true); return }
          setMsg('处理中…', false)
          if (btnOk) btnOk.disabled = true
          if (btnCancel) btnCancel.disabled = true
          const r = await asrApi('/api/billing/redeem/', { method: 'POST', token, body: { token: key } })
          const nextMin = String(r?.balance_min || r?.billing?.balance_min || '').trim()
          deps.pluginNotice('兑换成功，余额 ' + (nextMin || '已更新'), 'ok', 2600)
          close()
        } catch (e) {
          setMsg('兑换失败：' + String((e as any)?.message || e || ''), true)
          if (btnOk) btnOk.disabled = false
          if (btnCancel) btnCancel.disabled = false
        }
      }

      if (btnCancel) btnCancel.addEventListener('click', close)
      if (btnOk) btnOk.addEventListener('click', () => { void submit() })
      try { input?.focus() } catch {}
      ov.addEventListener('keydown', (ev) => {
        if ((ev as any).key === 'Escape') close()
        if ((ev as any).key === 'Enter') { void submit() }
      }, { capture: true, once: true } as any)
    })
  })
}

async function showAsrBillingDialog(token: string): Promise<void> {
  const deps = _deps
  if (!deps) return

  const refresh = async () => {
    let status: any = null
    try {
      status = await asrApi('/api/billing/status/', { method: 'GET', token })
    } catch (e) {
      deps.pluginNotice('获取余额失败：' + String((e as any)?.message || e || ''), 'err', 3200)
      return
    }

    const balMs = Number(status?.billing?.balance_ms || 0) || 0
    const balMinStr = String(status?.billing?.balance_min || '').trim()
    const wsUrl = String(status?.billing?.ws?.url || '').trim()
    const payUrl = String(status?.billing?.pay?.url || '').trim()

    const balMinDisplay = (() => {
      if (balMinStr) return balMinStr
      const mins = Math.max(0, Number(balMs) / 60000)
      if (!Number.isFinite(mins)) return '0'
      // 显示“剩余分钟数”：保留两位小数并去掉末尾 0
      return mins
        .toFixed(2)
        .replace(/\.0+$/, '')
        .replace(/(\.\d*[1-9])0+$/, '$1')
    })()

    const htmlBody = `
      <div style="font-size:13px;line-height:1.6;">
        <div style="margin-bottom:8px;">余额：<b>${balMinDisplay} 分钟</b></div>
      </div>
    `
    const htmlActions = `
      <button id="asr-billing-open">打开充值页</button>
      <button id="asr-billing-redeem">兑换卡密</button>
      <button id="asr-billing-refresh">刷新</button>
      <button id="asr-billing-close">关闭</button>
    `

    showAsrUi(htmlBody, htmlActions, (ov) => {
      const close = () => { try { ov.classList.add('hidden') } catch {} }
      const btnClose = ov.querySelector('#asr-billing-close') as HTMLButtonElement | null
      const btnOpen = ov.querySelector('#asr-billing-open') as HTMLButtonElement | null
      const btnRedeem = ov.querySelector('#asr-billing-redeem') as HTMLButtonElement | null
      const btnRefresh = ov.querySelector('#asr-billing-refresh') as HTMLButtonElement | null

      if (btnClose) btnClose.addEventListener('click', close)
      if (btnRefresh) btnRefresh.addEventListener('click', () => { void refresh() })
      if (btnOpen) btnOpen.addEventListener('click', () => {
        if (!payUrl) {
          deps.pluginNotice('未配置充值页面', 'err', 2400)
          return
        }
        try { void deps.openInBrowser(payUrl) } catch {}
      })
      if (btnRedeem) btnRedeem.addEventListener('click', () => { void showAsrRedeemDialog(token) })
    })
  }

  await refresh()
}

async function asrGetBaseUrl(): Promise<string> {
  return ASR_BACKEND_BASE_DEFAULT
}

async function asrStoreGet(): Promise<AsrStoreState> {
  try {
    const store = _deps?.getStore?.() || null
    if (!store) return {}
    const raw = (await store.get('asr')) as any
    if (raw && typeof raw === 'object') return raw as any
  } catch {}
  return {}
}

async function asrStoreSet(patch: Partial<AsrStoreState>): Promise<void> {
  try {
    const store = _deps?.getStore?.() || null
    if (!store) return
    const prev = await asrStoreGet()
    const next = { ...(prev || {}), ...(patch || {}) }
    await store.set('asr', next as any)
    await store.save()
  } catch {}
}

async function asrApi(
  path: string,
  opt?: { method?: string; token?: string; body?: any },
): Promise<any> {
  const base = await asrGetBaseUrl()
  const url = base.replace(/\/+$/, '') + String(path || '')
  const method = String(opt?.method || 'GET').toUpperCase()
  const headers: Record<string, string> = {}
  if (opt?.token) headers.Authorization = 'Bearer ' + String(opt.token)
  const bodyObj = opt?.body || {}

  let body: any = undefined
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    body = JSON.stringify(bodyObj)
  }

  let text = ''
  let status = 0
  try {
    const http = await getHttpClient()
    if (http && typeof http.fetch === 'function') {
      const req: any = { method, headers, responseType: http.ResponseType?.Text }
      if (body != null) {
        req.body =
          http.Body && typeof http.Body.text === 'function'
            ? http.Body.text(String(body))
            : String(body)
      }
      const resp: any = await http.fetch(url, req)
      status = Number(resp?.status || 0) || 0
      const ok = resp?.ok === true || (status >= 200 && status < 300)
      text =
        typeof resp?.text === 'function'
          ? String(await resp.text())
          : String(resp?.data || '')
      if (!ok) throw new Error(`HTTP ${status || 0}：${text || 'unknown'}`)
    } else {
      throw new Error('no http client')
    }
  } catch {
    const resp2 = await fetch(url, { method, headers, body })
    status = resp2.status
    text = await resp2.text()
    if (!resp2.ok) throw new Error(`HTTP ${status}：${text || 'unknown'}`)
  }

  return (() => {
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text }
    }
  })()
}

async function asrEnsureTokenInteractive(): Promise<string | null> {
  const deps = _deps
  if (!deps) return null

  // 1) 先用已保存 token 试一下
  try {
    const saved = await asrStoreGet()
    const tok = String(saved?.token || '').trim()
    if (tok) {
      try {
        await asrApi('/api/auth/me/', { method: 'GET', token: tok })
        return tok
      } catch {
        await asrStoreSet({ token: '' })
      }
    }
  } catch {}

  // 2) 走 JS 自绘登录/注册窗口
  try {
    return await showAsrLoginDialog()
  } catch {
    return null
  }
}

function updateMenu(): void {
  try {
    const deps = _deps
    const note = _active
    const running = !!(note && note.running && !note.ending)
    const paused = !!(note && note.paused)

    const children: any[] = []
    children.push({
      label: running ? '暂停自动语音笔记' : (paused ? '继续自动语音笔记' : '开始自动语音笔记'),
      disabled: !!(note && note.ending),
      onClick: () => { void toggleAsrNoteFromMenu() },
    })
    children.push({
      label: '停止并结算',
      disabled: !note || !!note.ending,
      onClick: () => { void stopAsrNoteFromMenu() },
    })
    children.push({ type: 'divider' })
    children.push({
      label: '余额/充值…',
      onClick: () => { void openAsrBillingEntry() },
    })
    children.push({
      label: '登录/切换账号…',
      onClick: () => { void loginOrSwitchAccount() },
    })
    children.push({
      label: '退出登录',
      onClick: () => { void logoutAsrAccount() },
    })

    addToPluginsMenu(FEATURE_ID, { label: '自动语音笔记', children })
  } catch {}
}

async function loginOrSwitchAccount(): Promise<void> {
  const deps = _deps
  if (!deps) return
  if (_active && (_active.running || _active.paused)) {
    deps.pluginNotice('自动语音笔记进行中：请先停止后再切换账号', 'err', 3200)
    return
  }
  await asrStoreSet({ token: '' })
  const tok = await asrEnsureTokenInteractive()
  if (tok) deps.pluginNotice('登录成功', 'ok', 1600)
}

async function logoutAsrAccount(): Promise<void> {
  const deps = _deps
  if (!deps) return
  if (_active && (_active.running || _active.paused)) {
    deps.pluginNotice('自动语音笔记进行中：请先停止后再退出', 'err', 3200)
    return
  }
  try {
    const saved = await asrStoreGet()
    const tok = String(saved?.token || '').trim()
    if (tok) {
      try { await asrApi('/api/auth/logout/', { method: 'POST', token: tok }) } catch {}
    }
    await asrStoreSet({ token: '', username: '' })
    deps.pluginNotice('已退出登录', 'ok', 1600)
  } catch (e) {
    deps.pluginNotice('退出失败：' + String((e as any)?.message || e || ''), 'err', 2400)
  }
}

async function openAsrBillingEntry(): Promise<void> {
  const deps = _deps
  if (!deps) return
  try {
    const token = await asrEnsureTokenInteractive()
    if (!token) return
    await showAsrBillingDialog(token)
  } catch (e) {
    deps.pluginNotice('操作失败：' + String((e as any)?.message || e || ''), 'err', 3200)
  }
}

async function toggleAsrNoteFromMenu(): Promise<void> {
  const deps = _deps
  if (!deps) return
  try {
    const note = _active
    if (!note) {
      await startAsrNote(true)
      return
    }
    if (note.ending) return
    if (note.running) {
      await pauseAsrNote(true)
      return
    }
    if (note.paused) {
      await resumeAsrNote(true)
    }
  } catch {}
}

async function stopAsrNoteFromMenu(): Promise<void> {
  const deps = _deps
  if (!deps) return
  try {
    const note = _active
    if (!note) return
    if (note.ending) return
    await stopAsrNote(true)
  } catch {}
}

function floatToInt16Pcm(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length)
  for (let i = 0; i < src.length; i++) {
    let v = src[i]
    if (v > 1) v = 1
    else if (v < -1) v = -1
    out[i] = v < 0 ? (v * 0x8000) : (v * 0x7fff)
  }
  return out
}

function resampleTo16kInt16(src: Float32Array, srcRate: number): Int16Array {
  const inRate = Number(srcRate) || ASR_SAMPLE_RATE
  if (inRate === ASR_SAMPLE_RATE) return floatToInt16Pcm(src)
  if (!src.length) return new Int16Array(0)

  const ratio = inRate / ASR_SAMPLE_RATE
  const outLen = Math.max(0, Math.floor(src.length / ratio))
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const s1 = src[idx] ?? 0
    const s2 = src[idx + 1] ?? s1
    let v = s1 + (s2 - s1) * frac
    if (v > 1) v = 1
    else if (v < -1) v = -1
    out[i] = v < 0 ? (v * 0x8000) : (v * 0x7fff)
  }
  return out
}

function replaceRangeInTextarea(ed: HTMLTextAreaElement, start: number, end: number, text: string): void {
  const s = Math.max(0, Math.min(ed.value.length, start >>> 0))
  const e = Math.max(s, Math.min(ed.value.length, end >>> 0))
  const v = String(ed.value || '')
  ed.value = v.slice(0, s) + text + v.slice(e)
  const pos = s + text.length
  try { ed.selectionStart = ed.selectionEnd = pos } catch {}
}

function asrNoteUpdateDraft(note: ActiveAsrNote, text: string): void {
  const deps = _deps
  if (!deps) return
  try {
    const ed = deps.getEditor()
    if (!ed) return
    const t = String(text || '')
    note.lastPartial = t

    const start = Math.max(0, Math.min(ed.value.length, note.draftStart))
    const end = Math.max(start, Math.min(ed.value.length, start + Math.max(0, note.draftLen)))
    replaceRangeInTextarea(ed, start, end, t)
    note.draftStart = start
    note.draftLen = t.length

    deps.markDirtyAndRefresh()
    if (deps.isPreviewMode()) {
      try { void deps.renderPreview() } catch {}
    } else if (deps.isWysiwyg()) {
      try { deps.scheduleWysiwygRender() } catch {}
    }
  } catch {}
}

function asrNoteClearTimers(note: ActiveAsrNote): void {
  try { if (note.reconnectTimer != null) window.clearTimeout(note.reconnectTimer) } catch {}
  note.reconnectTimer = null
  try { if (note.pingTimer != null) window.clearInterval(note.pingTimer) } catch {}
  note.pingTimer = null
  try { if (note.stopTimeout != null) window.clearTimeout(note.stopTimeout) } catch {}
  note.stopTimeout = null
}

function asrNoteCloseWs(note: ActiveAsrNote): void {
  try { note.wsReady = false } catch {}
  try { note.wsStarted = false } catch {}
  try {
    const ws = note.ws
    note.ws = null
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
  } catch {}
}

function asrNoteStopAudioCapture(note: ActiveAsrNote): void {
  try {
    const p = note.processor
    note.processor = null
    if (p) {
      try { p.onaudioprocess = null as any } catch {}
      try { p.disconnect() } catch {}
    }
  } catch {}
  try { note.sourceNode?.disconnect?.() } catch {}
  note.sourceNode = null
  try { note.zeroGain?.disconnect?.() } catch {}
  note.zeroGain = null
  try { note.audioCtx?.close?.() } catch {}
  note.audioCtx = null
  note.stream = null
  try { note.lease?.release?.() } catch {}
  note.lease = null
}

function asrNoteQueuePush(note: ActiveAsrNote, bytes: Uint8Array): void {
  if (!bytes.length) return
  note.q.push(bytes)
  note.qLen += bytes.length
  asrNoteQueueFlush(note)
}

function asrNoteQueueFlush(note: ActiveAsrNote): void {
  const ws = note.ws
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (!note.wsReady) return

  while (note.qLen >= ASR_CHUNK_BYTES) {
    const chunk = new Uint8Array(ASR_CHUNK_BYTES)
    let off = 0
    while (off < ASR_CHUNK_BYTES && note.q.length) {
      const head = note.q[0]
      const need = ASR_CHUNK_BYTES - off
      if (head.length <= need) {
        chunk.set(head, off)
        off += head.length
        note.q.shift()
      } else {
        chunk.set(head.subarray(0, need), off)
        off += need
        note.q[0] = head.subarray(need)
      }
    }
    note.qLen -= ASR_CHUNK_BYTES
    try { ws.send(chunk) } catch { break }
  }
}

function asrNoteQueueFlushFinal(note: ActiveAsrNote): void {
  const ws = note.ws
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (!note.wsReady) return

  asrNoteQueueFlush(note)
  if (!note.qLen) return

  const chunk = new Uint8Array(note.qLen)
  let off = 0
  while (note.q.length) {
    const head = note.q.shift()!
    chunk.set(head, off)
    off += head.length
  }
  note.qLen = 0
  try { ws.send(chunk) } catch {}
}

function asrNoteStartPing(note: ActiveAsrNote): void {
  if (note.pingTimer != null) return
  note.lastPongAt = Date.now()
  note.pingTimer = window.setInterval(() => {
    try {
      if (!_active || _active !== note) return
      if (!note.running || note.ending) return
      const ws = note.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (!note.wsReady) return
      ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
      const now = Date.now()
      if (now - (note.lastPongAt || 0) > 60000) {
        asrNoteScheduleReconnect(note, 'pong_timeout')
      }
    } catch {}
  }, 20000)
}

function asrNoteScheduleReconnect(note: ActiveAsrNote, reason: string): void {
  const deps = _deps
  if (!deps) return
  if (!_active || _active !== note) return
  if (!note.running || note.ending) return
  if (note.reconnectTimer != null) return

  const maxTries = 5
  if ((note.reconnectTries || 0) >= maxTries) {
    deps.pluginNotice('语音笔记连接已断开：请点击继续重试', 'err', 3200)
    note.ending = note.ending || 'pause'
    void finishAsrNoteSession(note, true)
    return
  }

  note.reconnectTries = (note.reconnectTries || 0) + 1
  const base = 500
  const delay = Math.min(8000, base * Math.pow(2, note.reconnectTries - 1))
  note.reconnectTimer = window.setTimeout(() => {
    note.reconnectTimer = null
    void asrNoteReconnectNow(note, reason)
  }, delay)
}

async function asrNoteReconnectNow(note: ActiveAsrNote, reason: string): Promise<void> {
  if (!_active || _active !== note) return
  if (!note.running || note.ending) return

  asrNoteClearTimers(note)
  asrNoteCloseWs(note)

  const deps = _deps
  if (!deps) return

  const ws = new WebSocket(note.wsUrl)
  note.ws = ws
  note.wsStarted = false
  note.wsReady = false

  ws.onopen = () => {
    let started = false
    try {
      const client = {
        platform: 'desktop',
        ver: deps.appVersion,
        device: String(navigator.userAgent || '').slice(0, 120),
        reconnect: { tries: note.reconnectTries, reason: String(reason || '') },
      }
      ws.send(JSON.stringify({ type: 'start', token: note.token, hold_ms: 120000, client, volc: { language: 'zh' } }))
      started = true
    } catch {}
    note.wsStarted = started
  }

  ws.onmessage = (ev) => handleWsMessage(note, ev)
  ws.onerror = () => { asrNoteScheduleReconnect(note, 'ws_error') }
  ws.onclose = () => { asrNoteScheduleReconnect(note, 'ws_close') }
}

function handleWsMessage(note: ActiveAsrNote, ev: MessageEvent): void {
  const deps = _deps
  if (!deps) return
  try {
    if (typeof (ev as any).data !== 'string') return
    const msg = (() => { try { return JSON.parse(String((ev as any).data || '')) } catch { return null } })()
    if (!msg || typeof msg !== 'object') return
    const t = String((msg as any).type || '')

    if (t === 'ready') {
      note.wsReady = true
      note.reconnectTries = 0
      asrNoteQueueFlush(note)
      asrNoteStartPing(note)
      deps.pluginNotice('语音笔记：请开始说话…', 'ok', 1400)
      updateMenu()
      return
    }
    if (t === 'pong') {
      note.lastPongAt = Date.now()
      return
    }
    if (t === 'partial') {
      const text = String((msg as any).text || '')
      if (text) asrNoteUpdateDraft(note, text)
      return
    }
    if (t === 'final') {
      const text = String((msg as any).text || '')
      if (text) asrNoteUpdateDraft(note, text)
      return
    }
    if (t === 'billing') {
      return
    }
    if (t === 'end') {
      void finishAsrNoteSession(note, true)
      return
    }
    if (t === 'error') {
      const err = String((msg as any).error || '')
      deps.pluginNotice('语音笔记失败：' + (err || 'unknown'), 'err', 3200)
      void finishAsrNoteSession(note, true)
    }
  } catch {}
}

async function startAsrNote(fromMenu: boolean): Promise<void> {
  const deps = _deps
  if (!deps) return

  if (_active) {
    if (_active.ending) return
    if (_active.running || _active.paused) return
  }

  // 与其它麦克风功能互斥
  try {
    const owner = getActiveMicOwner()
    if (owner === 'speech-transcribe') {
      deps.pluginNotice('正在录音转写中：请先停止录音再开始自动语音笔记', 'err', 3600)
      return
    }
  } catch {}

  const token = await asrEnsureTokenInteractive()
  if (!token) return

  let status: any = null
  try {
    status = await asrApi('/api/billing/status/', { method: 'GET', token })
  } catch (e) {
    deps.pluginNotice('获取余额失败：' + String((e as any)?.message || e || ''), 'err', 3200)
    return
  }

  const balMs = Number(status?.billing?.balance_ms || 0) || 0
  const wsUrl = String(status?.billing?.ws?.url || '').trim()
  if (!wsUrl) {
    deps.pluginNotice('语音网关地址为空：请检查后端配置', 'err', 3200)
    return
  }
  if (balMs <= 0) {
    deps.pluginNotice('余额不足：请先充值', 'err', 2400)
    if (fromMenu) await openAsrBillingEntry()
    return
  }

  const ed = deps.getEditor()
  if (!ed) {
    deps.pluginNotice('找不到编辑器', 'err', 2400)
    return
  }

  let lease: MicLease
  try {
    lease = await acquireMic('asr-note')
  } catch (e) {
    const msg = String((e as any)?.message || e || '')
    const owner = getActiveMicOwner()
    if (owner === 'speech-transcribe') {
      deps.pluginNotice('麦克风正在被“录音转写”占用：请先停止录音再开始语音笔记', 'err', 3600)
    } else if (msg) {
      deps.pluginNotice('获取麦克风失败：' + msg, 'err', 3200)
    } else {
      deps.pluginNotice('获取麦克风失败', 'err', 3200)
    }
    return
  }

  const startedAt = Date.now()
  const draftStart = (() => { try { return ed.selectionStart >>> 0 } catch { return ed.value.length >>> 0 } })()

  const note: ActiveAsrNote = {
    token,
    wsUrl,
    startedAt,
    running: true,
    paused: false,
    ending: '',

    wsStarted: false,
    wsReady: false,
    ws: null,

    reconnectTries: 0,
    reconnectTimer: null,
    pingTimer: null,
    lastPongAt: Date.now(),

    draftStart,
    draftLen: 0,
    lastPartial: '',

    lease,
    stream: lease.stream,
    audioCtx: null,
    sourceNode: null,
    processor: null,
    zeroGain: null,

    q: [],
    qLen: 0,

    stopTimeout: null,
  }
  _active = note
  updateMenu()

  try {
    // 建连 WS
    const ws = new WebSocket(wsUrl)
    note.ws = ws
    note.wsStarted = false
    note.wsReady = false

    ws.onopen = () => {
      let started = false
      try {
        const client = {
          platform: 'desktop',
          ver: deps.appVersion,
          device: String(navigator.userAgent || '').slice(0, 120),
        }
        ws.send(JSON.stringify({ type: 'start', token, hold_ms: 120000, client, volc: { language: 'zh' } }))
        started = true
      } catch {}
      note.wsStarted = started
    }

    ws.onmessage = (ev) => handleWsMessage(note, ev)
    ws.onerror = () => { asrNoteScheduleReconnect(note, 'ws_error') }
    ws.onclose = () => { asrNoteScheduleReconnect(note, 'ws_close') }

    // 开始采集 PCM 并送入队列
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
    if (!Ctx) throw new Error('当前环境不支持音频处理（缺少 AudioContext）')
    const audioCtx: AudioContext = new Ctx()
    note.audioCtx = audioCtx
    const src = audioCtx.createMediaStreamSource(lease.stream)
    note.sourceNode = src

    // ScriptProcessorNode 虽然老，但够用且稳定；别在这里引入 AudioWorklet 的复杂度。
    const processor = audioCtx.createScriptProcessor(4096, 1, 1)
    note.processor = processor

    const zero = audioCtx.createGain()
    zero.gain.value = 0
    note.zeroGain = zero

    src.connect(processor)
    processor.connect(zero)
    zero.connect(audioCtx.destination)

    processor.onaudioprocess = (ev: AudioProcessingEvent) => {
      try {
        if (!_active || _active !== note) return
        if (!note.running || note.paused || note.ending) return
        const input = ev.inputBuffer.getChannelData(0)
        if (!input || !input.length) return
        const pcm16 = resampleTo16kInt16(input, audioCtx.sampleRate)
        if (!pcm16.length) return
        const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
        asrNoteQueuePush(note, bytes)
      } catch {}
    }

    deps.pluginNotice('自动语音笔记：连接中…', 'ok', 1600)
  } catch (e) {
    deps.pluginNotice('启动失败：' + String((e as any)?.message || e || ''), 'err', 3200)
    await finishAsrNoteSession(note, true)
  }
}

async function pauseAsrNote(fromMenu: boolean): Promise<void> {
  const deps = _deps
  if (!deps) return
  const note = _active
  if (!note || !note.running || note.ending) return

  note.ending = 'pause'
  updateMenu()
  try { asrNoteQueueFlushFinal(note) } catch {}
  try { if (note.ws && note.ws.readyState === WebSocket.OPEN) note.ws.send(JSON.stringify({ type: 'stop' })) } catch {}

  // 给服务端一点时间结算/回 final，再强制清理
  note.stopTimeout = window.setTimeout(() => { void finishAsrNoteSession(note, true) }, 8000)
  if (fromMenu) deps.pluginNotice('自动语音笔记已暂停', 'ok', 1200)
}

async function resumeAsrNote(fromMenu: boolean): Promise<void> {
  const deps = _deps
  if (!deps) return
  const note = _active
  if (!note || !note.paused || note.ending) {
    await startAsrNote(fromMenu)
    return
  }

  // 继续写：把光标移动到上次草稿段末尾，并插入换行，再开始新段
  try {
    const ed = deps.getEditor()
    if (ed) {
      const pos = Math.max(0, Math.min(ed.value.length, (note.draftStart + note.draftLen) >>> 0))
      replaceRangeInTextarea(ed, pos, pos, '\n')
      note.draftStart = pos + 1
      note.draftLen = 0
      note.lastPartial = ''
      deps.markDirtyAndRefresh()
    }
  } catch {}

  // 清理旧会话残留
  await finishAsrNoteSession(note, false)
  await startAsrNote(fromMenu)
}

async function stopAsrNote(fromMenu: boolean): Promise<void> {
  const deps = _deps
  if (!deps) return
  const note = _active
  if (!note || note.ending) return

  note.ending = 'stop'
  updateMenu()
  try { asrNoteQueueFlushFinal(note) } catch {}
  try { if (note.ws && note.ws.readyState === WebSocket.OPEN) note.ws.send(JSON.stringify({ type: 'stop' })) } catch {}
  note.stopTimeout = window.setTimeout(() => { void finishAsrNoteSession(note, true) }, 8000)
  if (fromMenu) deps.pluginNotice('自动语音笔记：正在结束并结算…', 'ok', 1600)
}

async function finishAsrNoteSession(note: ActiveAsrNote, forceStopWs: boolean): Promise<void> {
  const deps = _deps
  if (!deps) return

  if (!_active || _active !== note) return
  asrNoteClearTimers(note)

  note.running = false
  note.wsReady = false
  note.wsStarted = false

  try { asrNoteStopAudioCapture(note) } catch {}
  if (forceStopWs) {
    try {
      if (note.ws && note.ws.readyState === WebSocket.OPEN) note.ws.close()
    } catch {}
  }
  try { asrNoteCloseWs(note) } catch {}

  // pause/stop：都释放麦克风（否则“暂停”就变成占着资源不放，垃圾体验）
  const paused = note.ending === 'pause'
  const stopped = note.ending === 'stop'

  note.paused = paused
  note.ending = ''

  if (stopped) {
    _active = null
    deps.pluginNotice('自动语音笔记已结束', 'ok', 1400)
  } else if (paused) {
    deps.pluginNotice('自动语音笔记已暂停', 'ok', 1200)
  } else {
    // 其他异常：归零，别留半死状态
    _active = null
  }

  updateMenu()
}
