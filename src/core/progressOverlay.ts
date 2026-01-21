/**
 * 导出/长任务进度遮罩（参考 public/plugins/pdf2doc 的样式与交互）
 * - 目标：让用户明确知道“程序还活着”，并能看到阶段/进度/耗时/失败日志
 * - 原则：不依赖外部 CSS 文件，避免加载顺序导致样式丢失
 */

const FLYMD_PROGRESS_STYLE_ID = 'flymd-progress-overlay-style'
const FLYMD_PROGRESS_Z_INDEX = 90030

type OverlayStage = 'working' | 'success' | 'failed' | 'cancelled'

export type ProgressOverlayApi = {
  setTitle(title: string): void
  setSub(sub: string): void
  setProgress(done: number, total: number): void
  appendLog(line: string): void
  markCancelled(): void
  fail(msg: string, detail?: string): void
  close(): void
}

export function openProgressOverlay(opt?: {
  title?: string
  sub?: string
  onCancel?: () => void
}): ProgressOverlayApi {
  if (typeof document === 'undefined') {
    // 非浏览器环境：返回空实现，避免上层崩溃
    return {
      setTitle() {},
      setSub() {},
      setProgress() {},
      appendLog() {},
      markCancelled() {},
      fail() {},
      close() {},
    }
  }

  ensureStyle()

  // 同一时间只允许一个遮罩：避免导出/解析叠加导致“无法点击/挡住全部 UI”
  try {
    const old = document.getElementById('flymd-progress-overlay-root')
    if (old && old.parentNode) old.parentNode.removeChild(old)
  } catch {}

  const state = {
    stage: 'working' as OverlayStage,
    closed: false,
    startedAt: Date.now(),
    timer: 0 as any,
    closable: false,
    progressDone: 0,
    progressTotal: 0,
    logs: [] as string[],
    maxLogLines: 200,
    cancelRequested: false,
  }

  const overlay = document.createElement('div')
  overlay.id = 'flymd-progress-overlay-root'
  overlay.className = 'flymd-progress-overlay'

  const dialog = document.createElement('div')
  dialog.className = 'flymd-progress-dialog'
  overlay.appendChild(dialog)

  const icon = document.createElement('div')
  icon.className = 'flymd-progress-icon'
  icon.innerHTML = `<div class="doc"></div>`
  dialog.appendChild(icon)

  const bars = document.createElement('div')
  bars.className = 'flymd-progress-bars'
  bars.innerHTML = `<span></span><span></span><span></span>`
  dialog.appendChild(bars)

  const title = document.createElement('div')
  title.className = 'flymd-progress-title'
  title.textContent = String(opt?.title || '处理中')
  dialog.appendChild(title)

  const sub = document.createElement('div')
  sub.className = 'flymd-progress-sub'
  sub.textContent = String(opt?.sub || '')
  dialog.appendChild(sub)

  const progress = document.createElement('div')
  progress.className = 'flymd-progress-meter'
  dialog.appendChild(progress)

  const logBox = document.createElement('div')
  logBox.className = 'flymd-progress-log'
  dialog.appendChild(logBox)

  const error = document.createElement('div')
  error.className = 'flymd-progress-error'
  dialog.appendChild(error)

  const actions = document.createElement('div')
  actions.className = 'flymd-progress-actions'
  dialog.appendChild(actions)

  const btnCancel = document.createElement('button')
  btnCancel.className = 'flymd-progress-btn danger'
  btnCancel.textContent = '终止'
  actions.appendChild(btnCancel)

  const btnClose = document.createElement('button')
  btnClose.className = 'flymd-progress-btn'
  btnClose.textContent = '关闭'
  actions.appendChild(btnClose)

  const fmtElapsed = () => {
    const ms = Math.max(0, Date.now() - state.startedAt)
    const s = Math.floor(ms / 1000)
    const mm = Math.floor(s / 60)
    const ss = s % 60
    if (mm <= 0) return `${ss}s`
    return `${mm}m ${ss}s`
  }

  const render = () => {
    if (state.closed) return

    const done = state.progressDone
    const total = state.progressTotal
    const progressText = total > 0 ? `${Math.min(done, total)}/${total}` : ''
    const stageText =
      state.stage === 'success' ? '已完成' :
      state.stage === 'failed' ? '已失败' :
      state.stage === 'cancelled' ? '已终止' :
      '处理中'
    const tail = (progressText || fmtElapsed()) ? `（${[progressText, fmtElapsed()].filter(Boolean).join(' · ')}）` : ''
    progress.textContent = `${stageText}${tail}`

    // 控制按钮状态
    if (state.stage === 'working') {
      actions.classList.remove('closable')
      btnCancel.style.display = opt?.onCancel ? '' : 'none'
      btnClose.style.display = 'none'
      bars.style.display = ''
    } else {
      actions.classList.add('closable')
      btnCancel.style.display = 'none'
      btnClose.style.display = ''
      bars.style.display = 'none'
    }

    // 日志渲染：只展示最后 N 行
    const showLines = state.logs.slice(-state.maxLogLines)
    logBox.textContent = showLines.join('\n')
    if (showLines.length > 0) {
      logBox.classList.add('show')
    } else {
      logBox.classList.remove('show')
    }
  }

  const cleanup = () => {
    if (state.closed) return
    state.closed = true
    try { if (state.timer) clearInterval(state.timer) } catch {}
    state.timer = 0 as any
    try { document.body.removeChild(overlay) } catch {}
  }

  // 不允许点背景关闭：避免用户误以为“关了就取消导出”
  overlay.addEventListener('click', (e) => {
    e.stopPropagation()
    e.preventDefault()
  })
  dialog.addEventListener('click', (e) => {
    e.stopPropagation()
  })

  btnClose.onclick = () => cleanup()
  btnCancel.onclick = () => {
    if (!opt?.onCancel) return
    if (state.cancelRequested) return
    state.cancelRequested = true
    state.stage = 'cancelled'
    title.textContent = '已终止'
    sub.textContent = '正在停止导出…'
    try { opt.onCancel() } catch {}
    render()
  }

  // ESC：仅在可关闭阶段生效
  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key || ''
    if (key !== 'Escape') return
    if (state.stage === 'working') {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    cleanup()
  }
  document.addEventListener('keydown', onKeyDown, true)

  // 关闭时移除 keydown
  const safeCleanup = () => {
    try { document.removeEventListener('keydown', onKeyDown, true) } catch {}
    cleanup()
  }
  btnClose.onclick = () => safeCleanup()

  document.body.appendChild(overlay)
  state.timer = setInterval(() => render(), 250)
  render()

  const api: ProgressOverlayApi = {
    setTitle(v) {
      if (state.closed) return
      title.textContent = String(v || '')
      render()
    },
    setSub(v) {
      if (state.closed) return
      sub.textContent = String(v || '')
      render()
    },
    setProgress(done, total) {
      if (state.closed) return
      state.progressDone = Math.max(0, Number(done) || 0)
      state.progressTotal = Math.max(0, Number(total) || 0)
      render()
    },
    appendLog(line) {
      if (state.closed) return
      const s = String(line || '').trim()
      if (!s) return
      state.logs.push(s)
      // 防止日志爆内存：超过 2000 行只保留最后 1200 行
      if (state.logs.length > 2000) state.logs = state.logs.slice(-1200)
      render()
    },
    markCancelled() {
      if (state.closed) return
      state.stage = 'cancelled'
      title.textContent = '已终止'
      sub.textContent = `已用时 ${fmtElapsed()}`
      render()
    },
    fail(msg, detail) {
      if (state.closed) return
      state.stage = 'failed'
      title.textContent = '导出失败'
      sub.textContent = `已用时 ${fmtElapsed()}`
      error.classList.add('show')
      const m = String(msg || '未知错误')
      const d = String(detail || '').trim()
      error.textContent = d ? (m + '\n' + d) : m
      render()
    },
    close() {
      safeCleanup()
    },
  }

  return api
}

function ensureStyle(): void {
  try {
    if (document.getElementById(FLYMD_PROGRESS_STYLE_ID)) return
  } catch {}

  const style = document.createElement('style')
  style.id = FLYMD_PROGRESS_STYLE_ID
  style.textContent = `
    .flymd-progress-overlay{
      position:fixed;inset:0;background:rgba(255,255,255,.86);
      display:flex;align-items:center;justify-content:center;z-index:${FLYMD_PROGRESS_Z_INDEX};
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    .flymd-progress-dialog{
      width:340px;max-width:calc(100% - 40px);
      background:rgba(255,255,255,.92);
      border-radius:14px;
      box-shadow:0 14px 40px rgba(0,0,0,.18);
      border:1px solid rgba(0,0,0,.08);
      padding:22px 18px 14px;
      color:#111827;
      font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;
    }
    .flymd-progress-icon{display:flex;align-items:center;justify-content:center;margin-bottom:10px;}
    .flymd-progress-icon .doc{
      width:24px;height:30px;border:2px solid #111827;border-radius:2px;position:relative;background:#fff;
    }
    .flymd-progress-icon .doc:before{
      content:"";position:absolute;top:0;right:0;width:8px;height:8px;border-left:2px solid #111827;border-bottom:2px solid #111827;background:#fff;
    }
    .flymd-progress-icon .doc:after{
      content:"";position:absolute;left:4px;right:4px;top:12px;height:2px;background:#3b82f6;
      animation:flymdProgressScan 1.2s ease-in-out infinite;
    }
    @keyframes flymdProgressScan{
      0%{transform:translateY(0);opacity:.9}
      50%{transform:translateY(9px);opacity:1}
      100%{transform:translateY(0);opacity:.9}
    }
    .flymd-progress-bars{display:flex;gap:10px;align-items:center;justify-content:center;margin:6px 0 12px;}
    .flymd-progress-bars span{width:26px;height:3px;background:#111827;border-radius:999px;opacity:.2;transform:translateY(0);animation:flymdProgressBars 1.1s infinite ease-in-out;}
    .flymd-progress-bars span:nth-child(2){animation-delay:.18s}
    .flymd-progress-bars span:nth-child(3){animation-delay:.36s}
    @keyframes flymdProgressBars{
      0%{opacity:.15;transform:translateY(0)}
      40%{opacity:.9;transform:translateY(-3px)}
      80%{opacity:.15;transform:translateY(0)}
      100%{opacity:.15;transform:translateY(0)}
    }
    .flymd-progress-title{text-align:center;font-weight:800;font-size:16px;letter-spacing:.2px;margin:0 0 6px;}
    .flymd-progress-sub{text-align:center;font-size:12px;color:#374151;line-height:1.4;margin:0 0 8px;white-space:pre-wrap;}
    .flymd-progress-meter{text-align:center;font-size:12px;color:#6b7280;line-height:1.4;margin:0 0 8px;}
    .flymd-progress-log{
      display:none;margin:8px 0 0;
      padding:8px 10px;border-radius:10px;border:1px solid rgba(0,0,0,.08);
      background:rgba(17,24,39,.04);color:#111827;
      font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;
      max-height:180px;overflow:auto;
      font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
    }
    .flymd-progress-log.show{display:block;}
    .flymd-progress-error{
      display:none;margin-top:10px;
      padding:8px 10px;border-radius:10px;
      border:1px solid rgba(185,28,28,.22);
      background:rgba(254,202,202,.45);
      color:#991b1b;font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word;
    }
    .flymd-progress-error.show{display:block;}
    .flymd-progress-actions{display:flex;justify-content:center;gap:10px;margin-top:12px;}
    .flymd-progress-actions.closable{justify-content:center;}
    .flymd-progress-btn{
      padding:7px 16px;border-radius:10px;border:1px solid rgba(0,0,0,.12);
      background:#fff;color:#111827;cursor:pointer;font-size:12px;font-weight:600;
    }
    .flymd-progress-btn:hover{background:rgba(127,127,127,.06)}
    .flymd-progress-btn.danger{
      background:linear-gradient(135deg,#fee2e2 0%,#fecaca 100%);
      color:#b91c1c;border-color:rgba(185,28,28,.22);
    }
    .flymd-progress-btn.danger:hover{
      background:linear-gradient(135deg,#fecaca 0%,#fca5a5 100%);
    }
  `
  document.head.appendChild(style)
}

