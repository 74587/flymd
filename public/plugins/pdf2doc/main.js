// PDF 解析插件（pdf2doc）

// 默认后端 API 根地址
const DEFAULT_API_BASE = 'https://flymd.llingfei.com/pdf/'
// 兼容标记（用于后端强制升级闸门；这不是插件真实版本号）
const PDF2DOC_COMPAT_VERSION = '1.2.0'
const PDF2DOC_STYLE_ID = 'pdf2doc-settings-style'
const PDF2DOC_PROGRESS_Z_INDEX = 90020
const PDF2DOC_SPLIT_THRESHOLD_PAGES = 300

// 轻量多语言：跟随宿主（flymd.locale），默认用系统语言
const PDF2DOC_LOCALE_LS_KEY = 'flymd.locale'
function pdf2docDetectLocale() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    const lang = (nav && (nav.language || nav.userLanguage)) || 'en'
    const lower = String(lang || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
  } catch {}
  return 'en'
}
function pdf2docGetLocale() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null
    const v = ls && ls.getItem(PDF2DOC_LOCALE_LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  return pdf2docDetectLocale()
}
function pdf2docText(zh, en) {
  return pdf2docGetLocale() === 'en' ? en : zh
}

function safeParseJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

function normalizeApiTokens(apiTokensLike, legacyApiToken) {
  const parsed = safeParseJson(apiTokensLike)
  const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(apiTokensLike) ? apiTokensLike : [])

  const tokenMap = new Map()
  for (const item of rawList) {
    if (typeof item === 'string') {
      const token = item.trim()
      if (!token) continue
      tokenMap.set(token, { token, enabled: true })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const token = String(item.token || '').trim()
    if (!token) continue
    const enabled = item.enabled === false ? false : true
    tokenMap.set(token, { token, enabled })
  }

  const legacy = String(legacyApiToken || '').trim()
  if (legacy && !tokenMap.has(legacy)) {
    tokenMap.set(legacy, { token: legacy, enabled: true })
  }

  return Array.from(tokenMap.values())
}

function getEnabledApiTokens(cfg) {
  const list = Array.isArray(cfg && cfg.apiTokens) ? cfg.apiTokens : []
  return list.filter(it => it && typeof it.token === 'string' && it.token.trim() && it.enabled !== false)
}

function getPrimaryApiToken(cfg) {
  const enabled = getEnabledApiTokens(cfg)
  if (enabled.length > 0) return enabled[0].token.trim()
  return String(cfg && cfg.apiToken ? cfg.apiToken : '').trim()
}

function hasAnyApiToken(cfg) {
  return !!getPrimaryApiToken(cfg)
}

function isLikelyTokenOrQuotaError(err) {
  const msg = err && err.message ? String(err.message) : String(err || '')
  const lower = msg.toLowerCase()
  const meta = err && typeof err === 'object' ? err._pdf2doc : null
  const status = meta && typeof meta.status === 'number' ? meta.status : 0
  const code = meta && typeof meta.code === 'string' ? meta.code : ''

  // 不对网络/解析类错误做自动换密钥：风险是重复请求导致重复扣费
  if (msg.startsWith('网络请求失败') || lower.startsWith('network request failed')) return false
  if (msg.includes('解析响应 JSON 失败') || lower.includes('failed to parse json response')) return false

  // 只在“确定未触发上游解析”的情况下自动换密钥
  // - 401/403：无效/停用 token
  // - 402 且提示“剩余页数额度不足”：服务端在解析前拦截（remain<=0）
  if (status === 401 || status === 403) return true
  if (status === 402) {
    // 服务端存在两种 402：
    // 1) 剩余页数额度不足（解析前拦截，安全可重试）
    // 2) 当前任务页数为 X，超过剩余额度 Y（解析后才发现，重试会重复扣费）
    return msg.includes('剩余页数额度不足') || lower.includes('remaining pages') || code === 'quota_exceeded_precheck'
  }

  // 兜底：没有状态码信息时，仅对“无效/停用”类错误做切换
  if (msg.includes('无效') || msg.includes('已停用')) return true
  if (lower.includes('unauthorized') || lower.includes('forbidden')) return true
  return false
}

// 用于界面展示，避免把完整密钥直接暴露在 UI 文案里
function maskApiTokenForDisplay(token) {
  const t = String(token || '').trim()
  if (!t) return ''
  if (t.length <= 8) return t[0] + '…' + t[t.length - 1]
  return t.slice(0, 4) + '…' + t.slice(-4)
}

// 解析取消：做“软取消”，保证 UI 能立刻停下来；网络请求若不支持中断，仍可能在后台继续跑。
function createPdf2DocCancelledError(message) {
  const e = new Error(message || pdf2docText('已终止解析', 'Parsing cancelled'))
  e._pdf2docCancelled = true
  return e
}

function isPdf2DocCancelledError(err) {
  return !!(err && typeof err === 'object' && err._pdf2docCancelled === true)
}

function isPdf2DocNetworkError(err) {
  const msg = err && err.message ? String(err.message) : String(err || '')
  const lower = msg.toLowerCase()
  return msg.startsWith('网络请求失败') || lower.startsWith('network request failed')
}

function pdf2docSleep(ms) {
  const t = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0
  return new Promise(resolve => setTimeout(resolve, Math.max(0, t)))
}

async function retryOnPdf2DocNetworkError(task, opt) {
  const maxAttemptsRaw = opt && typeof opt.maxAttempts === 'number' ? opt.maxAttempts : 3
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(maxAttemptsRaw)))
  const baseDelayMsRaw = opt && typeof opt.baseDelayMs === 'number' ? opt.baseDelayMs : 800
  const baseDelayMs = Math.max(200, Math.min(5000, Math.floor(baseDelayMsRaw)))
  const onRetry = opt && typeof opt.onRetry === 'function' ? opt.onRetry : null
  const cancelSource = opt && opt.cancelSource ? opt.cancelSource : null

  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (cancelSource && cancelSource.cancelled) throw createPdf2DocCancelledError()
      // eslint-disable-next-line no-await-in-loop
      return await task(attempt)
    } catch (e) {
      lastErr = e
      if (isPdf2DocCancelledError(e)) throw e
      if (!isPdf2DocNetworkError(e)) throw e
      if (attempt >= maxAttempts) throw e
      if (onRetry) {
        try { onRetry(attempt, maxAttempts, e) } catch {}
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1)
      // eslint-disable-next-line no-await-in-loop
      await pdf2docSleep(delay)
    }
  }
  throw lastErr || new Error(pdf2docText('网络请求失败', 'Network request failed'))
}

function createPdf2DocCancelSource() {
  let cancelled = false
  let resolveCancel = null
  const promise = new Promise(resolve => {
    resolveCancel = resolve
  })
  return {
    get cancelled() { return cancelled },
    cancel() {
      if (cancelled) return
      cancelled = true
      try { if (resolveCancel) resolveCancel(true) } catch {}
    },
    promise
  }
}

// 关键点：对“被 race 掉的 promise”提前加上 catch，避免取消后出现 unhandled rejection。
async function awaitPdf2DocWithCancel(promise, cancelSource) {
  if (!cancelSource) return await promise
  if (cancelSource.cancelled) throw createPdf2DocCancelledError()

  const guarded = Promise.resolve(promise).then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, e })
  )
  const winner = await Promise.race([
    guarded,
    cancelSource.promise.then(() => ({ cancelled: true }))
  ])
  if (winner && winner.cancelled) throw createPdf2DocCancelledError()
  if (!winner || winner.ok !== true) throw (winner && winner.e ? winner.e : new Error('未知错误'))
  return winner.v
}

async function fetchTotalRemainPages(context, cfg) {
  try {
    if (!context || !context.http || typeof context.http.fetch !== 'function') return null

    let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()
    if (apiUrl.endsWith('/pdf')) {
      apiUrl += '/'
    }

    const enabledTokens = getEnabledApiTokens(cfg).map(it => it.token).filter(Boolean)
    const primaryToken = getPrimaryApiToken(cfg)
    if (!primaryToken) return null

    const headers = {
      Authorization: 'Bearer ' + primaryToken,
      'X-PDF2DOC-Version': PDF2DOC_COMPAT_VERSION
    }
    if (enabledTokens.length > 1) {
      headers['X-Api-Tokens'] = JSON.stringify(enabledTokens)
    }

    const res = await context.http.fetch(apiUrl, {
      method: 'GET',
      headers
    })

    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res || res.status < 200 || res.status >= 300 || !data || data.ok !== true) return null

    const total = data.total_pages ?? 0
    const used = data.used_pages ?? 0
    const remain = data.remain_pages ?? Math.max(0, total - used)
    return typeof remain === 'number' ? remain : parseInt(String(remain || '0'), 10) || 0
  } catch {
    return null
  }
}

function showQuotaRiskDialog(context, pdfPages, remainPages, opt) {
  return new Promise(resolve => {
    if (typeof document === 'undefined') {
      resolve({ action: 'continue' })
      return
    }

    let pdfPagesValue =
      typeof pdfPages === 'number' && Number.isFinite(pdfPages) && pdfPages > 0
        ? pdfPages
        : null

    const hasPdfPages = () =>
      typeof pdfPagesValue === 'number' &&
      Number.isFinite(pdfPagesValue) &&
      pdfPagesValue > 0

    let requireLibrary = !!(opt && opt.requireLibrary)
    const canMoveToLibrary = !!(opt && opt.canMoveToLibrary)
    let requireSplit = !!(opt && opt.requireSplit)
    const canSplit = !!(opt && opt.canSplit)
    const enableAutoMergeAfterBatch = !!(opt && opt.enableAutoMergeAfterBatch)
    const defaultAutoMergeAfterBatch = !!(opt && opt.defaultAutoMergeAfterBatch)
    const shouldCheckLibrary = !!(opt && opt.shouldCheckLibrary)
    const inLib = opt && typeof opt.inLib === 'boolean' ? opt.inLib : true
    const requireLibraryReason = opt && opt.requireLibraryReason ? String(opt.requireLibraryReason) : ''
    const retryPdfPath = opt && opt.retryPdfPath ? String(opt.retryPdfPath) : ''
    const retryDirAbs = opt && opt.retryDirAbs ? String(opt.retryDirAbs) : ''

    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:90030;'

    const dialog = document.createElement('div')
    dialog.style.cssText =
      'width:520px;max-width:calc(100% - 40px);background:var(--bg,#fff);color:var(--fg,#333);border-radius:12px;border:1px solid var(--border,#e5e7eb);box-shadow:0 20px 50px rgba(0,0,0,.28);overflow:hidden;'

    const header = document.createElement('div')
    header.style.cssText =
      'padding:12px 16px;border-bottom:1px solid var(--border,#e5e7eb);font-weight:600;font-size:14px;background:rgba(127,127,127,.06);'
    header.textContent = pdf2docText('风险提示', 'Risk warning')

    const body = document.createElement('div')
    body.style.cssText = 'padding:14px 16px;font-size:13px;line-height:1.6;'

    const msg = document.createElement('div')

    // remainPages 可能查询失败（null/undefined/NaN），不要把它误当成 0 去吓用户。
    const hasRemain =
      typeof remainPages === 'number' &&
      Number.isFinite(remainPages) &&
      remainPages >= 0
    const safeRemain = hasRemain && remainPages > 0 ? remainPages : 0
    const remainText = hasRemain ? String(remainPages) : pdf2docText('未知', 'unknown')

    // 上游按“PDF 原页数”扣费：这里只在“确定不足”时提示，避免吓用户。
    const cacheHint = pdf2docText(
      '解析为 Markdown 支持缓存',
      'Markdown parsing supports resume with cache;'
    )
    const docxHint = pdf2docText(
      '多页数 PDF 建议先转换成 MD 再另存为 Docx，直接转换 Docx 的失败也会扣费。',
      'For multi-page PDFs, convert to Markdown first and then export to DOCX; failed DOCX conversion is still billed.'
    )
    body.appendChild(msg)

    const retryRow = document.createElement('div')
    retryRow.style.cssText =
      'display:none;align-items:center;gap:10px;margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--border,#e5e7eb);background:rgba(127,127,127,.04);'

    const btnRetryPages = document.createElement('button')
    btnRetryPages.type = 'button'
    btnRetryPages.style.cssText =
      'padding:6px 12px;border-radius:8px;border:1px solid #2563eb;background:#fff;color:#2563eb;cursor:pointer;font-size:12px;'
    btnRetryPages.textContent = pdf2docText('尝试获取页数', 'Retry page count')

    const retryHint = document.createElement('div')
    retryHint.style.cssText = 'font-size:12px;opacity:.85;'
    retryHint.textContent = pdf2docText(
      '未获取到当前 PDF 的页数，点击按钮重新尝试获取',
      'Failed to get PDF page count; click to retry'
    )

    retryRow.appendChild(btnRetryPages)
    retryRow.appendChild(retryHint)
    body.appendChild(retryRow)

    let autoMergeAfterBatch = defaultAutoMergeAfterBatch
    if (enableAutoMergeAfterBatch) {
      const row = document.createElement('label')
      row.style.cssText =
        'display:flex;align-items:flex-start;gap:10px;margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--border,#e5e7eb);background:rgba(127,127,127,.04);cursor:pointer;user-select:none;'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = !!autoMergeAfterBatch
      cb.style.cssText = 'margin-top:2px;'
      cb.onchange = () => { autoMergeAfterBatch = !!cb.checked }
      const text = document.createElement('div')
      text.style.cssText = 'font-size:12px;line-height:1.6;'
      text.innerHTML = pdf2docText(
        '批量解析完成后<strong>自动合并</strong>分割片段结果（生成“合并-xxx.md”）',
        'Auto-merge split parts after batch parsing (generate “合并-xxx.md”)'
      )
      row.appendChild(cb)
      row.appendChild(text)
      body.appendChild(row)
    }

    const splitTip = document.createElement('div')
    splitTip.style.cssText =
      'display:none;margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid #f59e0b;background:rgba(245,158,11,.08);color:var(--fg,#333);font-size:12px;line-height:1.6;'
    splitTip.innerHTML = pdf2docText(
      '当前 PDF 过大，需分割。分割文档会新建文件名文件夹，可通过“📁 同文件夹批量解析”进行解析，解析完成后可通过“🧩 分段解析结果合并”进行合并。',
      'This PDF is too large and must be split. A folder will be created; use “Parse all PDFs in this folder”, then use “Merge split parts”.'
    )
    body.appendChild(splitTip)

    const libraryTip = document.createElement('div')
    libraryTip.style.cssText =
      'display:none;margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid #f59e0b;background:rgba(245,158,11,.08);color:var(--fg,#333);font-size:12px;line-height:1.6;'
    libraryTip.innerHTML = pdf2docText(
      '检测到当前 PDF 不在库内，或无法获取页数。为保证解析稳定，请先使用复制到库内并打开。',
      'The current PDF is outside the library, or its page count is unavailable. Please use “Copy into library and open” first.'
    )
    body.appendChild(libraryTip)

    const footer = document.createElement('div')
    footer.style.cssText =
      'padding:10px 16px;border-top:1px solid var(--border,#e5e7eb);display:flex;justify-content:flex-end;gap:8px;background:rgba(127,127,127,.03);'

    const btnCancel = document.createElement('button')
    btnCancel.type = 'button'
    btnCancel.style.cssText =
      'padding:6px 12px;border-radius:8px;border:1px solid var(--border,#e5e7eb);background:var(--bg,#fff);color:var(--fg,#333);cursor:pointer;font-size:12px;'
    btnCancel.textContent = pdf2docText('取消', 'Cancel')

    const btnRecharge = document.createElement('button')
    btnRecharge.type = 'button'
    btnRecharge.style.cssText =
      'padding:6px 12px;border-radius:8px;border:1px solid #2563eb;background:#fff;color:#2563eb;cursor:pointer;font-size:12px;'
    btnRecharge.textContent = pdf2docText('充值/查询', 'Top up / Check')

    const btnOk = document.createElement('button')
    btnOk.type = 'button'
    btnOk.style.cssText =
      'padding:6px 14px;border-radius:8px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;font-weight:500;'
    btnOk.textContent = pdf2docText('确定继续解析', 'Continue')

    const btnMove = document.createElement('button')
    btnMove.type = 'button'
    btnMove.style.cssText =
      'padding:6px 12px;border-radius:8px;border:1px solid #16a34a;background:#fff;color:#16a34a;cursor:pointer;font-size:12px;'
    btnMove.textContent = pdf2docText('复制到库内并打开', 'Copy into library and open')

    const btnSplit = document.createElement('button')
    btnSplit.type = 'button'
    btnSplit.style.cssText =
      'padding:6px 12px;border-radius:8px;border:1px solid #f59e0b;background:#fff;color:#b45309;cursor:pointer;font-size:12px;'
    btnSplit.textContent = pdf2docText('分割并打开文件夹', 'Split and open folder')

    const setContinueEnabled = (enabled) => {
      const ok = !!enabled
      btnOk.disabled = !ok
      btnOk.style.opacity = ok ? '1' : '0.55'
      btnOk.style.cursor = ok ? 'pointer' : 'not-allowed'
    }

    const setButtonVisible = (btn, visible) => {
      btn.style.display = visible ? '' : 'none'
    }

    const render = () => {
      const hasPages = hasPdfPages()
      const pdfText = hasPages ? String(pdfPagesValue) : pdf2docText('未知', 'unknown')
      const n = hasPages && typeof pdfPagesValue === 'number' ? pdfPagesValue : 0

      const isInsufficient =
        hasPages && hasRemain && (safeRemain <= 0 || safeRemain < n)
      const warnText = isInsufficient
        ? (safeRemain <= 0
            ? pdf2docText('剩余解析页数为 0（不足以开始解析）', 'Remaining pages: 0 (not enough to start)')
            : pdf2docText('剩余解析页数不足以覆盖 PDF 页数，解析可能中断', 'Remaining pages are lower than PDF pages; parsing may stop early'))
        : ''

      msg.innerHTML = pdf2docText(
        `当前 PDF 页数：<strong>${pdfText}</strong> 页<br>剩余解析页数：<strong>${remainText}</strong> 页` +
          `<br><span style="color:#16a34a;font-weight:600;">${cacheHint}</span>` +
          `<br><span style="color:#dc2626;font-weight:600;">${docxHint}</span>` +
          (warnText ? `<br><span style="color:#dc2626;font-weight:600;">${warnText}</span>` : ''),
        `PDF pages: <strong>${pdfText}</strong><br>Remaining parse pages: <strong>${remainText}</strong>` +
          `<br><span style="color:#16a34a;font-weight:600;">${cacheHint}</span>` +
          `<br><span style="color:#dc2626;font-weight:600;">${docxHint}</span>` +
          (warnText ? `<br><span style="color:#dc2626;font-weight:600;">${warnText}</span>` : '')
      )

      const canRetryPages =
        !hasPages &&
        !!retryPdfPath &&
        !!retryDirAbs &&
        context &&
        typeof context.openFileByPath === 'function' &&
        typeof context.writeFileBinary === 'function' &&
        typeof context.removePath === 'function' &&
        typeof context.readFileBinary === 'function' &&
        typeof context.getPdfPageCount === 'function'

      retryRow.style.display = canRetryPages ? 'flex' : 'none'

      if (requireSplit) {
        splitTip.style.display = ''
        libraryTip.style.display = 'none'
      } else if (requireLibrary) {
        splitTip.style.display = 'none'
        // 页数未知但 PDF 已在库内：不再提示复制到库内（那只会制造重复文件）
        if (requireLibraryReason === 'pagesUnknown' && shouldCheckLibrary && inLib) {
          libraryTip.style.display = 'none'
        } else {
          libraryTip.style.display = ''
        }
      } else {
        splitTip.style.display = 'none'
        libraryTip.style.display = 'none'
      }

      setButtonVisible(btnSplit, requireSplit && canSplit)

      // 页数未知但 PDF 已在库内：不需要再复制一份，直接提示重试获取页数
      const showMove = requireLibrary && canMoveToLibrary && !(requireLibraryReason === 'pagesUnknown' && shouldCheckLibrary && inLib)
      setButtonVisible(btnMove, showMove)

      setContinueEnabled(!(requireLibrary || requireSplit))
    }

    const done = (action) => {
      try {
        document.body.removeChild(overlay)
      } catch {}
      resolve({ action, autoMergeAfterBatch: !!autoMergeAfterBatch })
    }

    btnCancel.onclick = () => done('cancel')
    btnRecharge.onclick = () => done('recharge')
    btnOk.onclick = () => done('continue')
    btnMove.onclick = () => done('move')
    btnSplit.onclick = () => done('split')
    overlay.onclick = (e) => {
      if (e.target === overlay) done('cancel')
    }
    dialog.onclick = (e) => e.stopPropagation()

    footer.appendChild(btnCancel)
    footer.appendChild(btnRecharge)
    footer.appendChild(btnSplit)
    footer.appendChild(btnMove)
    footer.appendChild(btnOk)

    dialog.appendChild(header)
    dialog.appendChild(body)
    dialog.appendChild(footer)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    btnRetryPages.onclick = async () => {
      const canRetry =
        !!retryPdfPath &&
        !!retryDirAbs &&
        context &&
        typeof context.openFileByPath === 'function' &&
        typeof context.writeFileBinary === 'function' &&
        typeof context.removePath === 'function' &&
        typeof context.readFileBinary === 'function' &&
        typeof context.getPdfPageCount === 'function'
      if (!canRetry) return

      btnRetryPages.disabled = true
      btnRetryPages.style.opacity = '0.7'
      btnRetryPages.style.cursor = 'not-allowed'
      retryHint.textContent = pdf2docText('正在尝试获取页数...', 'Retrying page count...')

      let tempPath = ''
      try {
        const tempName = '.pdf2doc-页数重试-' + String(Date.now()) + '.pdf'
        const abs = joinPath(retryDirAbs, tempName)
        tempPath = await writeFileBinaryRenameAuto(
          context,
          abs,
          createPdf2DocBlankPdfBytes()
        )

        try { await context.openFileByPath(tempPath) } catch {}
        await pdf2docSleep(300)
        try { await context.openFileByPath(retryPdfPath) } catch {}
        await pdf2docSleep(300)

        let bytes = null
        try {
          bytes = await context.readFileBinary(retryPdfPath)
        } catch {}

        if (bytes) {
          let copy = bytes
          try {
            if (bytes instanceof ArrayBuffer) copy = bytes.slice(0)
            else if (bytes instanceof Uint8Array) copy = bytes.slice(0)
          } catch {}
          const n = await context.getPdfPageCount(copy)
          const pages = typeof n === 'number' ? n : parseInt(String(n || '0'), 10) || 0
          if (Number.isFinite(pages) && pages > 0) {
            pdfPagesValue = pages

            // 页数恢复后，解除“页数未知”导致的库校验阻断；但如果文件本来就不在库内，仍保持阻断。
            if (requireLibraryReason === 'pagesUnknown') {
              requireLibrary = shouldCheckLibrary ? !inLib : false
            }
            requireSplit = pages > PDF2DOC_SPLIT_THRESHOLD_PAGES

            retryHint.textContent = pdf2docText('页数已更新', 'Page count updated')
            render()
            return
          }
        }

        retryHint.textContent = pdf2docText('获取失败，请稍后再试', 'Failed; please retry later')
      } catch {
        retryHint.textContent = pdf2docText('获取失败，请稍后再试', 'Failed; please retry later')
      } finally {
        if (tempPath) {
          try {
            const ok = await context.removePath(tempPath)
            if (!ok) {
              await pdf2docSleep(200)
              await context.removePath(tempPath)
            }
          } catch {}
        }
        btnRetryPages.disabled = false
        btnRetryPages.style.opacity = '1'
        btnRetryPages.style.cursor = 'pointer'
      }
    }

    render()
  })
}

// 截取页范围对话框：输入起止页（1-based）
// 返回 { confirmed: boolean, from: number, to: number }
function showExtractRangeDialog(fileName, pagesHint) {
  return new Promise(resolve => {
    if (typeof document === 'undefined') {
      resolve({ confirmed: false, from: 0, to: 0 })
      return
    }

    const totalPagesRaw =
      typeof pagesHint === 'number'
        ? pagesHint
        : parseInt(pagesHint || '', 10)
    const totalPages =
      Number.isFinite(totalPagesRaw) && totalPagesRaw > 0
        ? totalPagesRaw
        : 0

    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:90035;'

    const dialog = document.createElement('div')
    dialog.style.cssText =
      'width:460px;max-width:calc(100% - 40px);background:var(--bg,#fff);color:var(--fg,#333);border-radius:12px;border:1px solid var(--border,#e5e7eb);box-shadow:0 20px 50px rgba(0,0,0,.28);overflow:hidden;'

    const header = document.createElement('div')
    header.style.cssText =
      'padding:12px 16px;border-bottom:1px solid var(--border,#e5e7eb);font-weight:600;font-size:14px;background:rgba(127,127,127,.06);'
    header.textContent = pdf2docText('分离指定页面范围', 'Extract PDF page range')

    const body = document.createElement('div')
    body.style.cssText = 'padding:12px 16px;font-size:13px;line-height:1.6;'

    const nameRow = document.createElement('div')
    nameRow.style.marginBottom = '10px'
    nameRow.style.whiteSpace = 'nowrap'
    nameRow.style.overflow = 'hidden'
    nameRow.style.textOverflow = 'ellipsis'
    nameRow.innerHTML = pdf2docText(
      '当前PDF：<strong>' + (fileName || '未命名.pdf') + '</strong>',
      'Current PDF: <strong>' + (fileName || 'Untitled.pdf') + '</strong>'
    )

    const hintRow = document.createElement('div')
    hintRow.style.marginBottom = '10px'
    hintRow.style.color = 'var(--muted,#4b5563)'
    hintRow.style.fontSize = '12px'
    hintRow.textContent = totalPages > 0
      ? pdf2docText('总页数：' + totalPages + '（页码从 1 开始）', 'Total pages: ' + totalPages + ' (1-based)')
      : pdf2docText('页码从 1 开始（当前无法自动获取总页数）', 'Pages are 1-based (total pages unavailable)')

    const formRow = document.createElement('div')
    formRow.style.cssText = 'display:flex;gap:14px;align-items:center;flex-wrap:wrap;'

    const fromWrap = document.createElement('div')
    fromWrap.style.cssText = 'display:flex;gap:8px;align-items:center;'
    const toWrap = document.createElement('div')
    toWrap.style.cssText = 'display:flex;gap:8px;align-items:center;'

    const fromLabel = document.createElement('div')
    fromLabel.style.cssText = 'color:var(--muted,#4b5563);font-size:12px;'
    fromLabel.textContent = pdf2docText('起始页（from）', 'From page')
    const fromInput = document.createElement('input')
    fromInput.type = 'number'
    fromInput.min = '1'
    fromInput.step = '1'
    fromInput.placeholder = '1'
    fromInput.value = '1'
    fromInput.style.cssText =
      'width:92px;padding:5px 8px;border-radius:8px;border:1px solid var(--border,#e5e7eb);background:var(--bg,#fff);color:var(--fg,#111827);font-size:12px;'
    fromWrap.appendChild(fromLabel)
    fromWrap.appendChild(fromInput)

    const toLabel = document.createElement('div')
    toLabel.style.cssText = 'color:var(--muted,#4b5563);font-size:12px;'
    toLabel.textContent = pdf2docText('结束页（to）', 'To page')
    const toInput = document.createElement('input')
    toInput.type = 'number'
    toInput.min = '1'
    toInput.step = '1'
    toInput.placeholder = totalPages > 0 ? String(totalPages) : ''
    toInput.value = totalPages > 0 ? String(totalPages) : '1'
    toInput.style.cssText =
      'width:92px;padding:5px 8px;border-radius:8px;border:1px solid var(--border,#e5e7eb);background:var(--bg,#fff);color:var(--fg,#111827);font-size:12px;'
    toWrap.appendChild(toLabel)
    toWrap.appendChild(toInput)

    formRow.appendChild(fromWrap)
    formRow.appendChild(toWrap)

    const errRow = document.createElement('div')
    errRow.style.cssText = 'margin-top:8px;color:#dc2626;font-size:12px;min-height:18px;'

    const footer = document.createElement('div')
    footer.style.cssText =
      'padding:10px 16px;border-top:1px solid var(--border,#e5e7eb);display:flex;justify-content:flex-end;gap:8px;background:rgba(127,127,127,.03);'

    const btnCancel = document.createElement('button')
    btnCancel.type = 'button'
    btnCancel.style.cssText =
      'padding:6px 12px;border-radius:8px;border:1px solid var(--border,#e5e7eb);background:var(--bg,#fff);color:var(--fg,#333);cursor:pointer;font-size:12px;'
    btnCancel.textContent = pdf2docText('取消', 'Cancel')

    const btnOk = document.createElement('button')
    btnOk.type = 'button'
    btnOk.style.cssText =
      'padding:6px 14px;border-radius:8px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;font-weight:500;'
    btnOk.textContent = pdf2docText('截取', 'Extract')

    const done = (confirmed, from, to) => {
      try { document.body.removeChild(overlay) } catch {}
      resolve({ confirmed, from, to })
    }

    const validate = () => {
      const from = parseInt(String(fromInput.value || ''), 10) || 0
      const to = parseInt(String(toInput.value || ''), 10) || 0
      if (from <= 0 || to <= 0) {
        errRow.textContent = pdf2docText('请输入有效页码（>=1）', 'Please enter valid pages (>=1)')
        return null
      }
      if (to < from) {
        errRow.textContent = pdf2docText('结束页不能小于起始页', 'To page must be >= from page')
        return null
      }
      if (totalPages > 0 && (from > totalPages || to > totalPages)) {
        errRow.textContent = pdf2docText('页码超出总页数：' + totalPages, 'Page exceeds total: ' + totalPages)
        return null
      }
      errRow.textContent = ''
      return { from, to }
    }

    btnCancel.onclick = () => done(false, 0, 0)
    btnOk.onclick = () => {
      const v = validate()
      if (!v) return
      done(true, v.from, v.to)
    }
    overlay.onclick = (e) => {
      if (e.target === overlay) done(false, 0, 0)
    }
    dialog.onclick = (e) => e.stopPropagation()
    fromInput.oninput = () => validate()
    toInput.oninput = () => validate()

    footer.appendChild(btnCancel)
    footer.appendChild(btnOk)

    body.appendChild(nameRow)
    body.appendChild(hintRow)
    body.appendChild(formRow)
    body.appendChild(errRow)

    dialog.appendChild(header)
    dialog.appendChild(body)
    dialog.appendChild(footer)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    try { fromInput.focus() } catch {}
  })
}

function isPathInDir(filePath, dirPath) {
  const fp = String(filePath || '').replace(/\\/g, '/')
  const dp = String(dirPath || '').replace(/\\/g, '/')
  if (!fp || !dp) return false
  const f = fp.toLowerCase()
  let d = dp.toLowerCase()
  if (!d.endsWith('/')) d += '/'
  return f.startsWith(d)
}

function getBaseNameFromPath(p) {
  const s = String(p || '').replace(/\\/g, '/')
  const parts = s.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

function isAbsolutePath(p) {
  const s = String(p || '')
  if (!s) return false
  if (/^[A-Za-z]:[\\/]/.test(s)) return true
  if (s.startsWith('\\\\')) return true
  if (s.startsWith('/')) return true
  return false
}

function getSafeBaseNameForFile(name, fallback) {
  const base = String(name || fallback || 'document')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim()
  return base || String(fallback || 'document')
}

function joinPath(dir, name) {
  const d = String(dir || '')
  const n = String(name || '')
  if (!d) return n
  const sep = d.includes('\\') ? '\\' : '/'
  const dd = d.replace(/[\\/]+$/, '')
  return dd + sep + n
}

function hasParsedMdInDir(existingNamesLower, safeBaseName) {
  const base = ('解析' + String(safeBaseName || '') + '.md').toLowerCase()
  if (existingNamesLower && typeof existingNamesLower.has === 'function') {
    if (existingNamesLower.has(base)) return true
    for (let i = 1; i <= 50; i += 1) {
      const alt = ('解析' + String(safeBaseName || '') + '-' + i + '.md').toLowerCase()
      if (existingNamesLower.has(alt)) return true
    }
  }
  return false
}

function pad3(n) {
  const x = typeof n === 'number' ? n : parseInt(String(n || '0'), 10) || 0
  return String(Math.max(0, x)).padStart(3, '0')
}

async function requestSplitPdf(context, cfg, pdfBytes, fileName) {
  if (!context || !context.http || typeof context.http.fetch !== 'function') {
    throw new Error(pdf2docText('当前环境不支持网络请求', 'HTTP requests are not supported in this environment'))
  }

  let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()
  if (apiUrl.endsWith('/pdf')) {
    apiUrl += '/'
  }
  const splitUrl = apiUrl.replace(/\/+$/, '/') + 'split.php'

  const candidates = getEnabledApiTokens(cfg).map(it => it.token).filter(Boolean)
  const legacy = String(cfg.apiToken || '').trim()
  if (candidates.length === 0 && legacy) candidates.push(legacy)
  if (candidates.length === 0) {
    throw new Error(pdf2docText('未配置密钥', 'Token is not configured'))
  }

  const token = candidates[0]
  const xApiTokens = candidates.length > 1 ? JSON.stringify(candidates) : ''

  const arr = pdfBytes instanceof Uint8Array
    ? pdfBytes
    : (pdfBytes instanceof ArrayBuffer
      ? new Uint8Array(pdfBytes)
      : new Uint8Array(pdfBytes || []))

  const blob = new Blob([arr], { type: 'application/pdf' })
  const safeName = (String(fileName || '').trim() || 'document.pdf').replace(/[\\/:*?"<>|]+/g, '_')
  const finalName = /\.pdf$/i.test(safeName) ? safeName : (safeName + '.pdf')
  const file = new File([blob], finalName, { type: 'application/pdf' })

  const form = new FormData()
  form.append('file', file, file.name)
  // 分割片段页数由后端 .env 控制：前端不覆盖，避免本地改动导致线上配置失效

  const headers = {
    Authorization: 'Bearer ' + token,
    'X-PDF2DOC-Version': PDF2DOC_COMPAT_VERSION
  }
  if (xApiTokens) headers['X-Api-Tokens'] = xApiTokens

  let res
  try {
    res = await context.http.fetch(splitUrl, {
      method: 'POST',
      headers,
      body: form
    })
  } catch (e) {
    throw new Error(pdf2docText('网络请求失败：' + (e && e.message ? e.message : String(e)), 'Network request failed: ' + (e && e.message ? e.message : String(e))))
  }

  let data = null
  try {
    data = await res.json()
  } catch (e) {
    throw new Error(pdf2docText('响应格式错误', 'Invalid response format'))
  }

  if (!data || typeof data !== 'object') {
    throw new Error(pdf2docText('响应格式错误', 'Invalid response format'))
  }

  if (!res || res.status < 200 || res.status >= 300) {
    const msg = data && (data.message || data.error) ? String(data.message || data.error) : ''
    if (msg) throw new Error(msg)
    throw new Error(pdf2docText('请求失败（HTTP ' + (res ? res.status : '?') + '）', 'Request failed (HTTP ' + (res ? res.status : '?') + ')'))
  }
  if (!data.ok) {
    const msg = data.message || data.error || pdf2docText('分割失败', 'Split failed')
    throw new Error(String(msg))
  }

  return data
}

async function requestExtractPdfRange(context, cfg, pdfBytes, fileName, fromPage, toPage) {
  if (!context || !context.http || typeof context.http.fetch !== 'function') {
    throw new Error(pdf2docText('当前环境不支持网络请求', 'HTTP requests are not supported in this environment'))
  }

  const from = typeof fromPage === 'number' ? fromPage : parseInt(String(fromPage || '0'), 10) || 0
  const to = typeof toPage === 'number' ? toPage : parseInt(String(toPage || '0'), 10) || 0
  if (from <= 0 || to <= 0 || to < from) {
    throw new Error(pdf2docText('页范围参数错误', 'Invalid page range'))
  }

  let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()
  if (apiUrl.endsWith('/pdf')) {
    apiUrl += '/'
  }
  const extractUrl = apiUrl.replace(/\/+$/, '/') + 'extract.php'
  const cleanupUrl = apiUrl.replace(/\/+$/, '/') + 'extract_cleanup.php'

  const candidates = getEnabledApiTokens(cfg).map(it => it.token).filter(Boolean)
  const legacy = String(cfg.apiToken || '').trim()
  if (candidates.length === 0 && legacy) candidates.push(legacy)
  if (candidates.length === 0) {
    throw new Error(pdf2docText('未配置密钥', 'Token is not configured'))
  }

  const token = candidates[0]
  const xApiTokens = candidates.length > 1 ? JSON.stringify(candidates) : ''

  const arr = pdfBytes instanceof Uint8Array
    ? pdfBytes
    : (pdfBytes instanceof ArrayBuffer
      ? new Uint8Array(pdfBytes)
      : new Uint8Array(pdfBytes || []))

  const blob = new Blob([arr], { type: 'application/pdf' })
  const safeName = (String(fileName || '').trim() || 'document.pdf').replace(/[\\/:*?"<>|]+/g, '_')
  const finalName = /\.pdf$/i.test(safeName) ? safeName : (safeName + '.pdf')
  const file = new File([blob], finalName, { type: 'application/pdf' })

  const form = new FormData()
  form.append('file', file, file.name)
  form.append('from_page', String(from))
  form.append('to_page', String(to))

  const headers = {
    Authorization: 'Bearer ' + token,
    'X-PDF2DOC-Version': PDF2DOC_COMPAT_VERSION
  }
  if (xApiTokens) headers['X-Api-Tokens'] = xApiTokens

  let res
  try {
    res = await context.http.fetch(extractUrl, {
      method: 'POST',
      headers,
      body: form
    })
  } catch (e) {
    throw new Error(pdf2docText('网络请求失败：' + (e && e.message ? e.message : String(e)), 'Network request failed: ' + (e && e.message ? e.message : String(e))))
  }

  let data = null
  try {
    data = await res.json()
  } catch (e) {
    throw new Error(pdf2docText('响应格式错误', 'Invalid response format'))
  }

  if (!data || typeof data !== 'object') {
    throw new Error(pdf2docText('响应格式错误', 'Invalid response format'))
  }
  if (!res || res.status < 200 || res.status >= 300) {
    const msg = data && (data.message || data.error) ? String(data.message || data.error) : ''
    if (msg) throw new Error(msg)
    throw new Error(pdf2docText('请求失败（HTTP ' + (res ? res.status : '?') + '）', 'Request failed (HTTP ' + (res ? res.status : '?') + ')'))
  }
  if (!data.ok) {
    const msg = data.message || data.error || pdf2docText('截取失败', 'Extract failed')
    throw new Error(String(msg))
  }

  const job = data.job ? String(data.job) : ''
  const url = data.file && data.file.url ? String(data.file.url) : ''
  const suggested = data.file && data.file.suggested_name ? String(data.file.suggested_name) : ''
  if (!job || !url) {
    throw new Error(pdf2docText('截取结果为空', 'Empty extract result'))
  }

  return { job, url, suggestedName: suggested, cleanupUrl }
}

async function cleanupExtractJob(context, cfg, jobId, cleanupUrl) {
  if (!context || !context.http || typeof context.http.fetch !== 'function') return false

  const candidates = getEnabledApiTokens(cfg).map(it => it.token).filter(Boolean)
  const legacy = String(cfg.apiToken || '').trim()
  if (candidates.length === 0 && legacy) candidates.push(legacy)
  if (candidates.length === 0) return false

  const token = candidates[0]
  const xApiTokens = candidates.length > 1 ? JSON.stringify(candidates) : ''
  const headers = {
    Authorization: 'Bearer ' + token,
    'X-PDF2DOC-Version': PDF2DOC_COMPAT_VERSION
  }
  if (xApiTokens) headers['X-Api-Tokens'] = xApiTokens

  const form = new FormData()
  form.append('job', String(jobId || ''))

  try {
    const res = await context.http.fetch(String(cleanupUrl || ''), {
      method: 'POST',
      headers,
      body: form
    })
    const data = await res.json().catch(() => null)
    return !!(res && res.status >= 200 && res.status < 300 && data && data.ok === true)
  } catch {
    return false
  }
}

async function writeTextFileRenameAuto(context, absPath, content) {
  if (!context || typeof context.writeTextFile !== 'function') {
    throw new Error(pdf2docText('当前版本不支持写入文件', 'Writing files is not supported in this version'))
  }
  if (typeof context.exists !== 'function') {
    await context.writeTextFile(absPath, content)
    return absPath
  }

  const tryPath = async (p) => {
    const ok = await context.exists(p)
    if (!ok) {
      await context.writeTextFile(p, content)
      return p
    }
    return ''
  }

  const base = String(absPath || '')
  if (!base) {
    throw new Error(pdf2docText('路径错误', 'Invalid path'))
  }

  const dot = base.lastIndexOf('.')
  const prefix = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''

  const first = await tryPath(base)
  if (first) return first

  for (let i = 1; i <= 50; i += 1) {
    const p = prefix + '-' + i + ext
    const saved = await tryPath(p)
    if (saved) return saved
  }

  throw new Error(pdf2docText('文件名冲突过多', 'Too many file name conflicts'))
}

function createPdf2DocBlankPdfBytes() {
  // 最小 1 页空白 PDF，用于“切换到另一个 PDF 再切回来”刷新宿主状态
  // 由脚本生成并固定，确保 PDF.js 能稳定解析
  const b64 =
    'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCA+PiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDAgPj4Kc3RyZWFtCgplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDIxOSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDUgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjI2OAolJUVPRgo='
  try {
    const bin = typeof atob === 'function' ? atob(b64) : ''
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i) & 0xff
    return out
  } catch {
    return new Uint8Array([])
  }
}

async function writeFileBinaryRenameAuto(context, absPath, bytes) {
  if (!context || typeof context.writeFileBinary !== 'function') {
    throw new Error(pdf2docText('当前版本不支持写入文件', 'Writing files is not supported in this version'))
  }
  if (typeof context.exists !== 'function') {
    await context.writeFileBinary(absPath, bytes)
    return absPath
  }

  const tryPath = async (p) => {
    const ok = await context.exists(p)
    if (!ok) {
      await context.writeFileBinary(p, bytes)
      return p
    }
    return ''
  }

  const base = String(absPath || '')
  if (!base) {
    throw new Error(pdf2docText('路径错误', 'Invalid path'))
  }

  const dot = base.lastIndexOf('.')
  const prefix = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''

  const first = await tryPath(base)
  if (first) return first

  for (let i = 1; i <= 50; i += 1) {
    const p = prefix + '-' + i + ext
    const saved = await tryPath(p)
    if (saved) return saved
  }

  throw new Error(pdf2docText('文件名冲突过多', 'Too many file name conflicts'))
}

async function mergeSegmentedResultsInDir(context, fileDirAbs, relDir, opt) {
  const allowEmpty = !!(opt && opt.allowEmpty)
  if (
    !context ||
    typeof context.listLibraryFiles !== 'function' ||
    typeof context.readFileBinary !== 'function'
  ) {
    throw new Error(pdf2docText('当前版本不支持合并', 'Merge is not supported in this version'))
  }
  if (!fileDirAbs || !relDir) {
    throw new Error(pdf2docText('无法确定当前文件夹', 'Failed to determine the folder'))
  }

  const files = await context.listLibraryFiles({
    extensions: ['md', 'markdown'],
    maxDepth: 12,
    includeDirs: [relDir.endsWith('/') ? relDir : (relDir + '/')]
  })

  const parts = (Array.isArray(files) ? files : [])
    .filter(it => it && typeof it.relative === 'string' && typeof it.path === 'string')
    .filter(it => {
      const rr = String(it.relative || '')
      const dir = rr.split('/').slice(0, -1).join('/')
      if (dir !== relDir) return false
      const name = rr.split('/').pop() || ''
      return /^(?:解析)?分割片段\d{3,4}-.*\.(md|markdown)$/i.test(name)
    })
    .map(it => {
      const name = String(it.relative || '').split('/').pop() || ''
      const m = name.match(/^(?:解析)?分割片段(\d{3,4})-/i)
      const idx = m ? parseInt(m[1], 10) || 0 : 0
      return { idx, path: String(it.path), name }
    })
    .sort((a, b) => a.idx - b.idx)

  if (!parts.length) {
    if (allowEmpty) return ''
    throw new Error(pdf2docText('当前文件夹未找到分割片段的解析结果（.md）', 'No parsed markdown files found'))
  }

  const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null
  const mergedChunks = []
  for (const p of parts) {
    const bytes = await context.readFileBinary(p.path)
    const text = decoder ? decoder.decode(bytes) : String(bytes || '')
    mergedChunks.push(text)
  }

  const merged = mergedChunks.join('\n\n---\n\n')
  const folderName = String(fileDirAbs).replace(/\\/g, '/').split('/').filter(Boolean).pop() || '合并结果'
  const outName = '合并-' + getSafeBaseNameForFile(folderName, '合并结果') + '.md'
  const outAbs = joinPath(fileDirAbs, outName)
  const savedPath = await writeTextFileRenameAuto(context, outAbs, merged)
  return savedPath
}

async function splitPdfIntoLibraryFolder(context, cfg, pdfBytes, sourcePathOrName, opt) {
  if (!context || typeof context.saveBinaryToCurrentFolder !== 'function') {
    throw new Error(pdf2docText('当前版本不支持保存文件', 'Saving files is not supported in this version'))
  }
  if (!pdfBytes) {
    throw new Error(pdf2docText('无法读取 PDF 内容', 'Failed to read PDF content'))
  }

  const name = getBaseNameFromPath(sourcePathOrName) || String(sourcePathOrName || '') || 'document.pdf'
  const baseName = getSafeBaseNameForFile(name.replace(/\.pdf$/i, ''), 'PDF-分割')

  const resp = await requestSplitPdf(context, cfg, pdfBytes, name)
  const folderName = getSafeBaseNameForFile(resp.folder_name || baseName, baseName)
  const segments = Array.isArray(resp.segments) ? resp.segments : []
  if (segments.length === 0) {
    throw new Error(pdf2docText('分割结果为空', 'Split result is empty'))
  }

  const onProgress = opt && typeof opt.onProgress === 'function' ? opt.onProgress : null
  const report = (d, t) => {
    if (!onProgress) return
    try { onProgress(d, t) } catch {}
  }

  let firstSavedPath = ''
  const total = segments.length
  let done = 0
  report(0, total)
  for (const seg of segments) {
    const idx = typeof seg.index === 'number' ? seg.index : parseInt(String(seg.index || '0'), 10) || 0
    const url = seg && seg.url ? String(seg.url) : ''
    if (!url) continue

    const r = await context.http.fetch(url, { method: 'GET' })
    if (!r || r.status < 200 || r.status >= 300) {
      throw new Error(pdf2docText('下载分割片段失败（HTTP ' + (r ? r.status : '?') + '）', 'Failed to download split part (HTTP ' + (r ? r.status : '?') + ')'))
    }
    const buf = await r.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const fileName = '分割片段' + pad3(idx) + '-' + baseName + '.pdf'

    const saved = await context.saveBinaryToCurrentFolder({
      fileName,
      data: bytes,
      subDir: folderName,
      onConflict: 'renameAuto'
    })
    const savedPath = saved && saved.fullPath ? String(saved.fullPath) : ''
    if (!firstSavedPath && savedPath) {
      firstSavedPath = savedPath
    }

    done += 1
    report(done, total)
  }

  if (!firstSavedPath) {
    throw new Error(pdf2docText('保存分割片段失败', 'Failed to save split parts'))
  }

  if (typeof context.openFileByPath === 'function') {
    try {
      await context.openFileByPath(firstSavedPath)
    } catch {}
  }

  if (context && context.ui && typeof context.ui.notice === 'function') {
    context.ui.notice(
      pdf2docText('分割完成，已保存到库内并打开第一个片段。请按需解析/合并。', 'Split finished. The first part is opened. You can parse/merge when ready.'),
      'ok',
      4000
    )
  }

  return firstSavedPath
}

async function copyPdfIntoLibraryAndOpen(context, pdfBytes, sourcePath) {
  if (!context || typeof context.saveBinaryToCurrentFolder !== 'function') {
    throw new Error(pdf2docText('当前版本不支持保存文件', 'Saving files is not supported in this version'))
  }
  if (typeof context.openFileByPath !== 'function') {
    throw new Error(pdf2docText('当前版本不支持打开文件', 'Opening files is not supported in this version'))
  }
  if (!pdfBytes) {
    throw new Error(pdf2docText('无法读取 PDF 内容', 'Failed to read PDF content'))
  }

  let bytes = pdfBytes
  try {
    if (pdfBytes instanceof ArrayBuffer) {
      bytes = pdfBytes.slice(0)
    } else if (pdfBytes instanceof Uint8Array) {
      bytes = pdfBytes.slice(0)
    }
  } catch {
    bytes = pdfBytes
  }

  let name = getBaseNameFromPath(sourcePath) || 'document.pdf'
  if (!/\.pdf$/i.test(name)) name = name + '.pdf'
  name = String(name).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document.pdf'

  const saved = await context.saveBinaryToCurrentFolder({
    fileName: name,
    data: bytes,
    onConflict: 'renameAuto'
  })
  const fullPath = saved && saved.fullPath ? String(saved.fullPath) : ''
  if (!fullPath) {
    throw new Error(pdf2docText('保存失败', 'Save failed'))
  }
  await context.openFileByPath(fullPath)
  return fullPath
}

async function confirmQuotaRiskBeforeParse(context, cfg, pdfBytes, pdfPagesHint, pdfPath, opt) {
  // 这是“用户明确要求每次都弹一次”的确认框：即使查询失败也要尽量弹（弹不出来才放行）。
  const canShow = typeof document !== 'undefined'
  const wantDetail = !!(opt && opt.returnDetail)
  if (!canShow) {
    return wantDetail ? { ok: true, autoMergeAfterBatch: false } : true
  }

  let pdfPages = null
  const hint = typeof pdfPagesHint === 'number' ? pdfPagesHint : NaN
  if (Number.isFinite(hint) && hint > 0) {
    pdfPages = hint
  } else if (context && typeof context.getPdfPageCount === 'function') {
    try {
      // 注意：宿主实现可能会通过 IPC 传输 ArrayBuffer，导致原 buffer 被“转移/分离”变成 0 字节。
      // 这里用副本去取页数，避免影响后续真正上传解析的 bytes。
      let bytesForCount = pdfBytes
      try {
        if (pdfBytes instanceof ArrayBuffer) {
          bytesForCount = pdfBytes.slice(0)
        } else if (pdfBytes instanceof Uint8Array) {
          bytesForCount = pdfBytes.slice(0)
        }
      } catch {
        bytesForCount = pdfBytes
      }
      const n = await context.getPdfPageCount(bytesForCount)
      const pages = typeof n === 'number' ? n : parseInt(String(n || '0'), 10) || 0
      if (Number.isFinite(pages) && pages > 0) {
        pdfPages = pages
      }
    } catch {
      pdfPages = null
    }
  }

  let remain = null
  try {
    // 以前是“超过剩余额度 50% 才提示”，现在改成：每次解析前都提示一次（用户要求）。
    const remainRaw = await fetchTotalRemainPages(context, cfg)
    remain =
      typeof remainRaw === 'number' && Number.isFinite(remainRaw) && remainRaw >= 0
        ? remainRaw
        : null
  } catch {
    remain = null
  }

  try {
    const hasPdfPages =
      typeof pdfPages === 'number' &&
      Number.isFinite(pdfPages) &&
      pdfPages > 0

    let requireLibrary = false
    let canMoveToLibrary = false
    let requireSplit = false
    let canSplit = false
    let shouldCheckLibrary = false
    let inLib = true
    let requireLibraryReason = ''
    if (pdfPath && context) {
      try {
        const root = typeof context.getLibraryRoot === 'function' ? await context.getLibraryRoot() : null
        shouldCheckLibrary = !!root && isAbsolutePath(pdfPath)
        inLib = shouldCheckLibrary && root ? isPathInDir(pdfPath, root) : true
        requireLibrary = shouldCheckLibrary && (!inLib || !hasPdfPages)
        if (shouldCheckLibrary && !inLib) requireLibraryReason = 'notInLibrary'
        if (shouldCheckLibrary && inLib && !hasPdfPages) requireLibraryReason = 'pagesUnknown'
        canMoveToLibrary =
          shouldCheckLibrary &&
          !!root &&
          typeof context.saveBinaryToCurrentFolder === 'function' &&
          typeof context.openFileByPath === 'function' &&
          !!pdfBytes

        // 对于“选择文件”这类拿不到绝对路径的场景：如果连页数都拿不到，就要求用户先复制到库内再解析。
        if (!shouldCheckLibrary && !!root && !hasPdfPages) {
          requireLibrary = true
          requireLibraryReason = 'pagesUnknownNoPath'
          canMoveToLibrary =
            typeof context.saveBinaryToCurrentFolder === 'function' &&
            typeof context.openFileByPath === 'function' &&
            !!pdfBytes
        }
      } catch {
        requireLibrary = false
        canMoveToLibrary = false
      }
    }

    if (hasPdfPages && pdfPages > PDF2DOC_SPLIT_THRESHOLD_PAGES) {
      requireSplit = true
      canSplit =
        !!pdfBytes &&
        context &&
        context.http &&
        typeof context.http.fetch === 'function' &&
        typeof context.saveBinaryToCurrentFolder === 'function'
    }

    const ret = await showQuotaRiskDialog(context, pdfPages, remain, {
      requireLibrary,
      canMoveToLibrary,
      requireSplit,
      canSplit,
      shouldCheckLibrary,
      inLib,
      requireLibraryReason,
      retryPdfPath: requireLibraryReason === 'pagesUnknown' && shouldCheckLibrary && inLib ? String(pdfPath) : '',
      retryDirAbs: requireLibraryReason === 'pagesUnknown' && shouldCheckLibrary && inLib ? String(pdfPath).replace(/[\\/][^\\/]+$/, '') : '',
      enableAutoMergeAfterBatch: !!(opt && opt.enableAutoMergeAfterBatch),
      defaultAutoMergeAfterBatch: !!(opt && opt.defaultAutoMergeAfterBatch)
    })
    const action = ret && ret.action ? ret.action : 'cancel'
    const autoMergeAfterBatch = !!(ret && ret.autoMergeAfterBatch)
    if (action === 'recharge') {
      try { await openSettings(context) } catch {}
      return wantDetail ? { ok: false, autoMergeAfterBatch: false } : false
    }
    if (action === 'move') {
      try {
        await copyPdfIntoLibraryAndOpen(context, pdfBytes, pdfPath)
        if (context && context.ui && typeof context.ui.notice === 'function') {
          context.ui.notice(
            pdf2docText('已复制到库内并打开，请重新解析。', 'Copied into library and opened. Please parse again.'),
            'ok',
            3000
          )
        }
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e || '')
        if (context && context.ui && typeof context.ui.notice === 'function') {
          context.ui.notice(
            pdf2docText('复制失败：' + msg, 'Copy failed: ' + msg),
            'err',
            4000
          )
        }
      }
      return wantDetail ? { ok: false, autoMergeAfterBatch: false } : false
    }
    if (action === 'split') {
      let overlay = null
      try {
        overlay = openPdf2DocProgressOverlay({ output: 'markdown' })
        if (overlay && typeof overlay.setStage === 'function') {
          overlay.setStage('splitting')
        }
      } catch {}
      try {
        await splitPdfIntoLibraryFolder(context, cfg, pdfBytes, pdfPath, {
          onProgress: (done, total) => {
            if (overlay && typeof overlay.setSplitProgress === 'function') {
              overlay.setSplitProgress(done, total)
            }
          }
        })
        if (overlay && typeof overlay.close === 'function') {
          overlay.close()
          overlay = null
        }
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e || '')
        if (overlay && typeof overlay.fail === 'function') {
          overlay.fail(
            pdf2docText('分割失败：' + msg, 'Split failed: ' + msg),
            pdf2docText('分割失败', 'Split failed')
          )
          overlay = null
        } else if (context && context.ui && typeof context.ui.notice === 'function') {
          context.ui.notice(
            pdf2docText('分割失败：' + msg, 'Split failed: ' + msg),
            'err',
            5000
          )
        }
      }
      return wantDetail ? { ok: false, autoMergeAfterBatch: false } : false
    }
    if (action === 'cancel') {
      return wantDetail ? { ok: false, autoMergeAfterBatch: false } : false
    }
    return wantDetail ? { ok: true, autoMergeAfterBatch } : true
  } catch {
    // UI 弹窗失败不应阻断主流程
    return wantDetail ? { ok: true, autoMergeAfterBatch: false } : true
  }
}


async function loadConfig(context) {
  const apiBaseUrl =
    (await context.storage.get('apiBaseUrl')) || DEFAULT_API_BASE
  const legacyApiToken = (await context.storage.get('apiToken')) || ''
  const storedApiTokens = await context.storage.get('apiTokens')
  const apiTokens = normalizeApiTokens(storedApiTokens, legacyApiToken)
  const apiToken = getPrimaryApiToken({ apiTokens, apiToken: legacyApiToken })
  const mdJobUser = (await context.storage.get('mdJobUser')) || ''
  const defaultOutput = (await context.storage.get('defaultOutput')) || 'markdown'
  const sendToAI = await context.storage.get('sendToAI')
  return {
    apiBaseUrl,
    apiToken,
    apiTokens,
    mdJobUser: typeof mdJobUser === 'string' ? mdJobUser : String(mdJobUser || ''),
    defaultOutput: defaultOutput === 'docx' ? 'docx' : 'markdown',
    sendToAI: sendToAI ?? true
  }
}


async function saveConfig(context, cfg) {
  const apiTokens = normalizeApiTokens(cfg && cfg.apiTokens, cfg && cfg.apiToken)
  const apiToken = getPrimaryApiToken({ apiTokens, apiToken: cfg && cfg.apiToken })
  const mdJobUser = cfg && typeof cfg.mdJobUser === 'string' ? cfg.mdJobUser.trim() : String((cfg && cfg.mdJobUser) || '').trim()
  await context.storage.set('apiBaseUrl', cfg.apiBaseUrl)
  await context.storage.set('apiTokens', JSON.stringify(apiTokens))
  await context.storage.set('apiToken', apiToken)
  await context.storage.set('mdJobUser', mdJobUser)
  await context.storage.set('defaultOutput', cfg.defaultOutput)
  await context.storage.set('sendToAI', cfg.sendToAI)
}


function pickPdfFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/pdf'
    input.style.display = 'none'

    input.onchange = () => {
      const file = input.files && input.files[0]
      if (!file) {
        reject(new Error(pdf2docText('未选择文件', 'No file selected')))
      } else {
        resolve(file)
      }
      input.remove()
    }


    try {
      document.body.appendChild(input)
    } catch {

    }

    input.click()
  })
}

// 选择图片文件（仅限常见格式）
function pickImageFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/jpg,image/webp'
    input.style.display = 'none'

    input.onchange = () => {
      const file = input.files && input.files[0]
      if (!file) {
        reject(new Error(pdf2docText('未选择文件', 'No file selected')))
      } else {
        resolve(file)
      }
      input.remove()
    }

    try {
      document.body.appendChild(input)
    } catch {
      // 忽略挂载失败，后续点击会直接抛错
    }

    input.click()
  })
}


async function uploadAndParsePdfFile(context, cfg, file, output, cancelSource) {
  let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()
  
  if (apiUrl.endsWith('/pdf')) {
    apiUrl += '/'
  }

  const form = new FormData()
  form.append('file', file, file.name)
  const out = output === 'docx' ? 'docx' : (output === 'markdown' ? 'markdown' : (cfg.defaultOutput === 'docx' ? 'docx' : 'markdown'))
  form.append('output', out)

  const candidates = getEnabledApiTokens(cfg).map(it => it.token).filter(Boolean)
  const legacy = String(cfg.apiToken || '').trim()
  if (candidates.length === 0 && legacy) candidates.push(legacy)
  if (candidates.length === 0) {
    throw new Error(pdf2docText('未配置 pdf2doc 密钥', 'PDF2Doc token is not configured'))
  }

  // 多密钥合计余额：把全部启用密钥一起发给后端，后端可在一次解析里跨密钥扣费（后端不支持时会忽略该头）
  const xApiTokens = candidates.length > 1 ? JSON.stringify(candidates) : ''

  const requestOnce = async (token) => {
    if (cancelSource && cancelSource.cancelled) throw createPdf2DocCancelledError()
    const headers = {
      Authorization: 'Bearer ' + token,
      'X-PDF2DOC-Version': PDF2DOC_COMPAT_VERSION
    }
    if (xApiTokens) headers['X-Api-Tokens'] = xApiTokens
    // 仅用于 Markdown 分段解析的断点续跑：用“用户名”替代首 token 作为任务归属标识（不影响扣费 token）
    const mdJobUser = cfg && typeof cfg.mdJobUser === 'string' ? cfg.mdJobUser.trim() : ''
    if (out === 'markdown' && mdJobUser) headers['X-PDF2DOC-Job-User'] = mdJobUser

    let res
    try {
      res = await awaitPdf2DocWithCancel(context.http.fetch(apiUrl, {
        method: 'POST',
        headers,
        body: form
      }), cancelSource)
    } catch (e) {
      if (isPdf2DocCancelledError(e)) throw e
      throw new Error(
        pdf2docText(
          '网络请求失败：' + (e && e.message ? e.message : String(e)),
          'Network request failed: ' + (e && e.message ? e.message : String(e))
        )
      )
    }

    let data = null
    try {
      if (cancelSource && cancelSource.cancelled) throw createPdf2DocCancelledError()
      data = await awaitPdf2DocWithCancel(res.json(), cancelSource)
    } catch (e) {
      if (isPdf2DocCancelledError(e)) throw e
      const statusText = 'HTTP ' + res.status
      throw new Error(
        pdf2docText(
          '解析响应 JSON 失败（' + statusText + '）：' + (e && e.message ? e.message : String(e)),
          'Failed to parse JSON response (' + statusText + '): ' + (e && e.message ? e.message : String(e))
        )
      )
    }

    if (!data || typeof data !== 'object') {
      throw new Error(pdf2docText('响应格式错误：不是 JSON 对象', 'Invalid response format: not a JSON object'))
    }

    if (!data.ok) {
      const msgZh = data.message || data.error || '解析失败'
      const msgEn = data.message || data.error || 'Parse failed'
      const e = new Error(pdf2docText(msgZh, msgEn))
      e._pdf2doc = { status: res.status, code: String(data.error || '') }
      throw e
    }

    return data // { ok, format, markdown?, docx_url?, pages, uid }
  }

  let lastErr = null
  for (const token of candidates) {
    try {
      if (cancelSource && cancelSource.cancelled) throw createPdf2DocCancelledError()
      // eslint-disable-next-line no-await-in-loop
      return await requestOnce(token)
    } catch (e) {
      lastErr = e
      if (isPdf2DocCancelledError(e)) throw e
      if (!isLikelyTokenOrQuotaError(e)) throw e
    }
  }
  throw lastErr || new Error(pdf2docText('解析失败', 'Parse failed'))
}

// 上传并解析图片文件，仅支持输出 Markdown
async function uploadAndParseImageFile(context, cfg, file, cancelSource) {
  let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()

  if (apiUrl.endsWith('/pdf')) {
    apiUrl += '/'
  }

  const form = new FormData()
  form.append('file', file, file.name)
  form.append('output', 'markdown')

  const candidates = getEnabledApiTokens(cfg).map(it => it.token).filter(Boolean)
  const legacy = String(cfg.apiToken || '').trim()
  if (candidates.length === 0 && legacy) candidates.push(legacy)
  if (candidates.length === 0) {
    throw new Error(pdf2docText('未配置 pdf2doc 密钥', 'PDF2Doc token is not configured'))
  }

  const xApiTokens = candidates.length > 1 ? JSON.stringify(candidates) : ''

  const requestOnce = async (token) => {
    if (cancelSource && cancelSource.cancelled) throw createPdf2DocCancelledError()
    const headers = {
      Authorization: 'Bearer ' + token,
      'X-PDF2DOC-Version': PDF2DOC_COMPAT_VERSION
    }
    if (xApiTokens) headers['X-Api-Tokens'] = xApiTokens

    let res
    try {
      res = await awaitPdf2DocWithCancel(context.http.fetch(apiUrl, {
        method: 'POST',
        headers,
        body: form
      }), cancelSource)
    } catch (e) {
      if (isPdf2DocCancelledError(e)) throw e
      throw new Error(
        pdf2docText(
          '网络请求失败：' + (e && e.message ? e.message : String(e)),
          'Network request failed: ' + (e && e.message ? e.message : String(e))
        )
      )
    }

    let data = null
    try {
      if (cancelSource && cancelSource.cancelled) throw createPdf2DocCancelledError()
      data = await awaitPdf2DocWithCancel(res.json(), cancelSource)
    } catch (e) {
      if (isPdf2DocCancelledError(e)) throw e
      const statusText = 'HTTP ' + res.status
      throw new Error(
        pdf2docText(
          '解析响应 JSON 失败（' + statusText + '）：' + (e && e.message ? e.message : String(e)),
          'Failed to parse JSON response (' + statusText + '): ' + (e && e.message ? e.message : String(e))
        )
      )
    }

    if (!data || typeof data !== 'object') {
      throw new Error(pdf2docText('响应格式错误：不是 JSON 对象', 'Invalid response format: not a JSON object'))
    }

    if (!data.ok) {
      const msgZh = data.message || data.error || '图片解析失败'
      const msgEn = data.message || data.error || 'Image parse failed'
      const e = new Error(pdf2docText(msgZh, msgEn))
      e._pdf2doc = { status: res.status, code: String(data.error || '') }
      throw e
    }

    if (data.format !== 'markdown' || !data.markdown) {
      throw new Error(
        pdf2docText('解析成功，但返回格式不是 Markdown', 'Parse succeeded but returned format is not Markdown')
      )
    }

    return data // { ok, format: 'markdown', markdown, pages, uid }
  }

  let lastErr = null
  for (const token of candidates) {
    try {
      if (cancelSource && cancelSource.cancelled) throw createPdf2DocCancelledError()
      // eslint-disable-next-line no-await-in-loop
      return await requestOnce(token)
    } catch (e) {
      lastErr = e
      if (isPdf2DocCancelledError(e)) throw e
      if (!isLikelyTokenOrQuotaError(e)) throw e
    }
  }
  throw lastErr || new Error(pdf2docText('图片解析失败', 'Image parse failed'))
}


async function parsePdfBytes(context, cfg, bytes, filename, output, cancelSource) {
  // bytes: Uint8Array | ArrayBuffer | number[]
  const arr = bytes instanceof Uint8Array
    ? bytes
    : (bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes || []))
  const blob = new Blob([arr], { type: 'application/pdf' })
  const name = filename && typeof filename === 'string' && filename.trim()
    ? filename.trim()
    : 'document.pdf'
    const file = new File([blob], name, { type: 'application/pdf' })
    return await uploadAndParsePdfFile(context, cfg, file, output, cancelSource)
  }

// 解析图片二进制为 Markdown
async function parseImageBytes(context, cfg, bytes, filename, cancelSource) {
  const arr = bytes instanceof Uint8Array
    ? bytes
    : (bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes || []))

  // 简单根据扩展名推断 MIME 类型
  const lower = (filename || '').toLowerCase()
  let mime = 'image/jpeg'
  if (lower.endsWith('.png')) mime = 'image/png'
  else if (lower.endsWith('.webp')) mime = 'image/webp'

  const blob = new Blob([arr], { type: mime })
  const name = filename && typeof filename === 'string' && filename.trim()
    ? filename.trim()
    : 'image.jpg'
  const file = new File([blob], name, { type: mime })
  return await uploadAndParseImageFile(context, cfg, file, cancelSource)
}

// 将 Markdown 中的远程图片下载到当前文档目录并改写为本地相对路径
// 依赖宿主提供的 context.downloadFileToCurrentFolder 能力；如果不可用则直接返回原文
async function localizeMarkdownImages(context, markdown, opt) {
  const text = typeof markdown === 'string' ? markdown : ''
  if (!text) return text

  const onProgress = opt && typeof opt.onProgress === 'function' ? opt.onProgress : null
  const report = (done, total) => {
    if (!onProgress) return
    try {
      onProgress(done, total)
    } catch {}
  }

  if (!context || typeof context.downloadFileToCurrentFolder !== 'function') {
    // 宿主不支持本地下载时，仍然可以尝试将 HTML img 标签转换为 Markdown 语法，避免图片在预览中不可见
    let fallback = text
    const htmlToMdRe = /<img\b([^>]*?)\bsrc=['"]([^'"]+)['"]([^>]*)>/gi
    fallback = fallback.replace(htmlToMdRe, (full, before, src, after) => {
      const rest = String(before || '') + ' ' + String(after || '')
      const altMatch = rest.match(/\balt=['"]([^'"]*)['"]/i)
      const alt = altMatch ? altMatch[1] : ''
      const safeAlt = alt.replace(/]/g, '\\]')
      const needsAngle = /\s|\(|\)/.test(src)
      const wrappedSrc = needsAngle ? '<' + src + '>' : src
      return '![' + safeAlt + '](' + wrappedSrc + ')'
    })
    return fallback
  }

  // 收集所有 http(s) 图片 URL，避免重复下载
  // 映射结构：url => { fullPath?: string, relativePath?: string }
  const urlMap = new Map()

  // Markdown 图片语法 ![alt](url "title")
  const mdImgRe = /!\[[^\]]*]\(([^)\s]+)[^)]*\)/g
  let m
  while ((m = mdImgRe.exec(text)) !== null) {
    const raw = (m[1] || '').trim()
    if (!raw) continue
    if (!/^https?:\/\//i.test(raw)) continue
    if (!urlMap.has(raw)) {
      urlMap.set(raw, null)
    }
  }

  // HTML img 标签 <img src="url" ...>
  const htmlImgRe = /<img\b[^>]*\bsrc=['"]([^'"]+)['"][^>]*>/gi
  while ((m = htmlImgRe.exec(text)) !== null) {
    const raw = (m[1] || '').trim()
    if (!raw) continue
    if (!/^https?:\/\//i.test(raw)) continue
    if (!urlMap.has(raw)) {
      urlMap.set(raw, null)
    }
  }

  if (!urlMap.size) return text

  const baseName =
    opt && typeof opt.baseName === 'string' && opt.baseName.trim()
      ? opt.baseName.trim()
      : 'image'

  // 限制最多处理的图片数量，避免极端大文档导致卡顿
  const maxImages = 50
  const totalToProcess = Math.min(maxImages, urlMap.size)
  let index = 0

  if (totalToProcess > 0) {
    report(0, totalToProcess)
  }

  for (const [url] of urlMap.entries()) {
    if (index >= maxImages) break
    index += 1
    report(index, totalToProcess)

    let suggestedName = ''
    try {
      try {
        const u = new URL(url)
        const path = u.pathname || ''
        const parts = path.split('/').filter(Boolean)
        if (parts.length) {
          suggestedName = parts[parts.length - 1]
        }
      } catch {
        // 忽略 URL 解析失败，回退到简单切分
      }
      if (!suggestedName) {
        const withoutQuery = url.split(/[?#]/)[0]
        const segs = withoutQuery.split('/').filter(Boolean)
        if (segs.length) {
          suggestedName = segs[segs.length - 1]
        }
      }
      const safeBase =
        baseName.replace(/[\\/:*?"<>|]+/g, '_') || 'image'
      const idxStr = String(index).padStart(3, '0')

      let finalName = suggestedName || ''
      if (!finalName) {
        finalName = safeBase + '-' + idxStr + '.png'
      } else {
        finalName = String(finalName).replace(/[\\/:*?"<>|]+/g, '_')
        // 如果没有扩展名，为其补一个默认扩展名，避免部分查看器无法识别
        if (!/\.[A-Za-z0-9]{2,6}$/.test(finalName)) {
          finalName = finalName + '.png'
        }
      }

      try {
        const saved = await context.downloadFileToCurrentFolder({
          url,
          fileName: finalName,
          subDir: 'images',
          onConflict: 'renameAuto'
        })
        if (saved) {
          urlMap.set(url, {
            fullPath: saved.fullPath ? String(saved.fullPath) : '',
            relativePath: saved.relativePath ? String(saved.relativePath).replace(/\\/g, '/') : ''
          })
        }
      } catch {
        // 单个图片下载失败不影响整体流程，保留原始 URL
      }
    } catch {
      // 防御性兜底，出现异常时跳过该图片
    }
  }

  if (totalToProcess > 0) {
    report(totalToProcess, totalToProcess)
  }

  let result = text
  for (const [oldUrl, info] of urlMap.entries()) {
    if (!info) continue
    const fullPath = info.fullPath && String(info.fullPath).trim()
    const relPath = info.relativePath && String(info.relativePath).trim()
    // 优先使用绝对路径，满足需要“绝对路径图片引用”的场景
    const target = fullPath || relPath
    if (!target) continue
    const escaped = oldUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, 'g')
    result = result.replace(re, target)
  }

  // 最后一步：将 HTML img 标签统一转换为 Markdown 图片语法，保证在 Markdown 预览和编辑器中可见
  const htmlToMdRe = /<img\b([^>]*?)\bsrc=['"]([^'"]+)['"]([^>]*)>/gi
  result = result.replace(htmlToMdRe, (full, before, src, after) => {
    const rest = String(before || '') + ' ' + String(after || '')
    const altMatch = rest.match(/\balt=['"]([^'"]*)['"]/i)
    const alt = altMatch ? altMatch[1] : ''
    const safeAlt = alt.replace(/]/g, '\\]')
    const needsAngle = /\s|\(|\)/.test(src)
    const wrappedSrc = needsAngle ? '<' + src + '>' : src
    return '![' + safeAlt + '](' + wrappedSrc + ')'
  })

  return result
}

// 将长文分批翻译，避免单次调用超出模型上下文
// 返回 { completed, text, partial, translatedBatches, totalBatches, translatedPages }
// 若中途失败，尽量返回已翻译内容（partial）而不是直接抛错
async function translateMarkdownInBatches(ai, markdown, pages, onProgress) {
  if (!ai || typeof ai.translate !== 'function') return null
  const totalPagesRaw =
    typeof pages === 'number'
      ? pages
      : parseInt(pages || '', 10)
  const totalPages = Number.isFinite(totalPagesRaw) && totalPagesRaw > 0 ? totalPagesRaw : 0

  // 页数未知或不超过 2 页，直接一次性翻译，保持原有行为
  if (!totalPages || totalPages <= 2) {
    try {
      const single = await ai.translate(markdown)
      if (!single) {
        return {
          completed: false,
          text: '',
          partial: '',
          translatedBatches: 0,
          totalBatches: 1,
          translatedPages: 0
        }
      }
      return {
        completed: true,
        text: single,
        partial: single,
        translatedBatches: 1,
        totalBatches: 1,
        translatedPages: totalPages || 0
      }
    } catch (e) {
      return {
        completed: false,
        text: '',
        partial: '',
        translatedBatches: 0,
        totalBatches: 1,
        translatedPages: 0
      }
    }
  }

  // 粗略按页数估算每页字符数，再按 2 页一批拆分
  const perPageChars = Math.max(
    800,
    Math.floor(markdown.length / Math.max(totalPages, 1))
  )
  const batchChars = perPageChars * 2

  const chunks = []
  for (let i = 0; i < markdown.length; i += batchChars) {
    chunks.push(markdown.slice(i, i + batchChars))
  }

  const translatedChunks = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const fromPage = i * 2 + 1
    const toPage = Math.min((i + 1) * 2, totalPages)

    // 通知调用方当前批次，便于更新 UI 为“正在翻译第 X-Y 页”
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          batchIndex: i,
          batchCount: chunks.length,
          fromPage,
          toPage
        })
      } catch {}
    }

    // 在每批前加一小段提示，帮助模型保持上下文
    const prefix =
      chunks.length > 1
        ? `【PDF 文档分批翻译，第 ${i + 1}/${chunks.length} 批，约第 ${fromPage}-${toPage} 页】\n\n`
        : ''

    let result = ''
    try {
      result = await ai.translate(prefix + chunk)
    } catch (e) {
      // 中途出错，跳出循环，返回已完成部分
      break
    }

    if (!result) {
      // 返回空也视为失败，保留已翻译内容
      break
    }
    translatedChunks.push(result)
  }

  const joined = translatedChunks.join('\n\n')
  const completed = translatedChunks.length === chunks.length && chunks.length > 0
  const translatedPages = translatedChunks.length * 2 > totalPages
    ? totalPages
    : translatedChunks.length * 2

  return {
    completed,
    text: joined,
    partial: joined,
    translatedBatches: translatedChunks.length,
    totalBatches: chunks.length,
    translatedPages
  }
}



function showDocxDownloadDialog(docxUrl, pages) {
  if (typeof document === 'undefined') return

  
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:90020;'

  
  const dialog = document.createElement('div')
  dialog.style.cssText = 'width:460px;max-width:calc(100% - 40px);background:var(--bg,#fff);color:var(--fg,#333);border-radius:12px;border:1px solid var(--border,#e5e7eb);box-shadow:0 20px 50px rgba(0,0,0,.3);overflow:hidden;'

  
  const header = document.createElement('div')
  header.style.cssText = 'padding:16px 20px;border-bottom:1px solid var(--border,#e5e7eb);font-weight:600;font-size:16px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;'
  header.textContent = pdf2docText('docx 文件已生成', 'DOCX file is ready')

 
  const body = document.createElement('div')
  body.style.cssText = 'padding:20px;'

  const message = document.createElement('div')
  message.style.cssText = 'font-size:14px;color:var(--fg,#555);margin-bottom:16px;line-height:1.6;'
  message.innerHTML = pdf2docText(
    `文件已成功转换为 docx 格式（<strong>${pages} 页</strong>）<br>请选择下载方式：`,
    `The file has been converted to DOCX (<strong>${pages} pages</strong>).<br>Please choose a download method:`
  )

  
  const linkDisplay = document.createElement('div')
  linkDisplay.style.cssText = 'background:var(--bg-muted,#f9fafb);border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:12px;color:var(--muted,#6b7280);word-break:break-all;max-height:60px;overflow-y:auto;'
  linkDisplay.textContent = docxUrl

  
  const buttonContainer = document.createElement('div')
  buttonContainer.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;'

 
  const downloadBtn = document.createElement('button')
  downloadBtn.style.cssText = 'padding:10px 16px;border-radius:8px;border:none;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;cursor:pointer;font-size:14px;font-weight:500;transition:transform 0.2s;'
  downloadBtn.textContent = pdf2docText('🔽 点击下载', '🔽 Download')
  downloadBtn.onmouseover = () => downloadBtn.style.transform = 'translateY(-2px)'
  downloadBtn.onmouseout = () => downloadBtn.style.transform = 'translateY(0)'
  downloadBtn.onclick = () => {
    try {
      const opened = window.open(docxUrl, '_blank')
      if (opened) {
        
        document.body.removeChild(overlay)
      } else {
        downloadBtn.textContent = pdf2docText('❌ 浏览器已拦截', '❌ Blocked by browser')
        downloadBtn.style.background = '#ef4444'
        message.innerHTML = pdf2docText(
          `<span style="color:#ef4444;">⚠️ 浏览器阻止了弹窗</span><br>请点击\"复制链接\"按钮，然后粘贴到浏览器地址栏打开`,
          `<span style="color:#ef4444;">⚠️ Browser blocked the popup</span><br>Please click \"Copy link\" and paste it into your browser's address bar.`
        )
        setTimeout(() => {
          downloadBtn.textContent = pdf2docText('🔽 点击下载', '🔽 Download')
          downloadBtn.style.background = 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)'
        }, 3000)
      }
    } catch (e) {
      downloadBtn.textContent = pdf2docText('❌ 下载失败', '❌ Download failed')
      downloadBtn.style.background = '#ef4444'
      message.innerHTML = pdf2docText(
        `<span style="color:#ef4444;">⚠️ 无法打开下载链接</span><br>请点击\"复制链接\"按钮，然后粘贴到浏览器地址栏打开`,
        `<span style="color:#ef4444;">⚠️ Unable to open download link</span><br>Please click \"Copy link\" and paste it into your browser's address bar.`
      )
    }
  }

  
  const copyBtn = document.createElement('button')
  copyBtn.style.cssText = 'padding:10px 16px;border-radius:8px;border:1px solid var(--border,#d1d5db);background:var(--bg,#fff);color:var(--fg,#333);cursor:pointer;font-size:14px;font-weight:500;transition:all 0.2s;'
  copyBtn.textContent = pdf2docText('📋 复制链接', '📋 Copy link')
  copyBtn.onmouseover = () => {
    copyBtn.style.background = 'var(--bg-muted,#f9fafb)'
    copyBtn.style.transform = 'translateY(-2px)'
  }
  copyBtn.onmouseout = () => {
    copyBtn.style.background = 'var(--bg,#fff)'
    copyBtn.style.transform = 'translateY(0)'
  }
  copyBtn.onclick = () => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(docxUrl).then(() => {
        copyBtn.textContent = pdf2docText('✅ 已复制', '✅ Copied')
        copyBtn.style.background = '#10b981'
        copyBtn.style.color = '#fff'
        copyBtn.style.borderColor = '#10b981'
        setTimeout(() => {
          document.body.removeChild(overlay)
        }, 1000)
      }).catch(() => {
        copyBtn.textContent = pdf2docText('❌ 复制失败', '❌ Copy failed')
        copyBtn.style.background = '#ef4444'
        copyBtn.style.color = '#fff'
        copyBtn.style.borderColor = '#ef4444'
      })
    } else {
      
      linkDisplay.focus()
      const range = document.createRange()
      range.selectNodeContents(linkDisplay)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      copyBtn.textContent = pdf2docText('已选中，请按 Ctrl+C', 'Selected, press Ctrl+C')
    }
  }

  
  const footer = document.createElement('div')
  footer.style.cssText = 'padding:12px 20px;border-top:1px solid var(--border,#e5e7eb);text-align:center;background:var(--bg-muted,#f9fafb);'

  const closeBtn = document.createElement('button')
  closeBtn.style.cssText = 'padding:6px 20px;border-radius:6px;border:1px solid var(--border,#d1d5db);background:var(--bg,#fff);color:var(--muted,#6b7280);cursor:pointer;font-size:13px;'
  closeBtn.textContent = pdf2docText('关闭', 'Close')
  closeBtn.onclick = () => document.body.removeChild(overlay)

  
  buttonContainer.appendChild(downloadBtn)
  buttonContainer.appendChild(copyBtn)

  body.appendChild(message)
  body.appendChild(linkDisplay)
  body.appendChild(buttonContainer)

  dialog.appendChild(header)
  dialog.appendChild(body)
  dialog.appendChild(footer)
  footer.appendChild(closeBtn)

  overlay.appendChild(dialog)

  
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      document.body.removeChild(overlay)
    }
  }

  
  document.body.appendChild(overlay)
}


// PDF 翻译前确认对话框，提示模型配置与自动保存行为（不再支持按页选择）
// 返回 { confirmed: boolean }
async function showTranslateConfirmDialog(context, cfg, fileName, pages) {
  if (typeof document === 'undefined') {
    // 无法渲染对话框时直接放行，保持功能可用
    return { confirmed: true }
  }

  const totalPagesRaw =
    typeof pages === 'number'
      ? pages
      : parseInt(pages || '', 10)
  const totalPages =
    Number.isFinite(totalPagesRaw) && totalPagesRaw > 0
      ? totalPagesRaw
      : 0

  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:90025;'

    const dialog = document.createElement('div')
    dialog.style.cssText =
      'width:520px;max-width:calc(100% - 40px);background:var(--bg,#fff);color:var(--fg,#111827);border-radius:12px;border:1px solid var(--border,#e5e7eb);box-shadow:0 20px 50px rgba(0,0,0,.35);overflow:hidden;font-size:14px;'

    const header = document.createElement('div')
    header.style.cssText =
      'padding:14px 18px;border-bottom:1px solid var(--border,#e5e7eb);font-weight:600;font-size:15px;background:linear-gradient(135deg,#0ea5e9 0%,#6366f1 100%);color:#fff;'
    header.textContent = pdf2docText('确认翻译 PDF', 'Confirm PDF translation')

    const body = document.createElement('div')
    body.style.cssText = 'padding:18px 18px 6px 18px;line-height:1.7;'

    const nameRow = document.createElement('div')
    nameRow.style.marginBottom = '8px'
    nameRow.innerHTML = pdf2docText(
      '将翻译文档：<strong>' + (fileName || '未命名 PDF') + '</strong>',
      'File to translate: <strong>' + (fileName || 'Untitled PDF') + '</strong>'
    )

    const descRow = document.createElement('div')
    descRow.style.marginBottom = '8px'
    descRow.textContent = pdf2docText(
      '翻译将通过 AI 助手插件执行，默认使用当前配置的模型。如使用免费模型，可能因为超出速率限制失败，可再通过AI插件手动翻译',
      'Translation will be performed via the AI Assistant plugin using the current model. Free models may fail due to rate limits; you can always translate manually in the AI plugin.'
    )

    const modelRow = document.createElement('div')
    modelRow.style.marginBottom = '8px'
    modelRow.style.fontSize = '13px'
    modelRow.style.color = 'var(--muted,#4b5563)'
    modelRow.textContent = pdf2docText('当前模型：正在获取...', 'Current model: fetching...')

    const saveRow = document.createElement('div')
    saveRow.style.marginBottom = '8px'
    saveRow.style.fontSize = '13px'
    saveRow.style.color = 'var(--muted,#4b5563)'
    const baseNameRaw = (fileName || 'document.pdf').replace(/\.pdf$/i, '')
    const originFileName = baseNameRaw + ' (PDF 原文).md'
    const transFileName = baseNameRaw + ' (PDF 翻译).md'
    saveRow.textContent = pdf2docText(
      '解析成功后，将在当前文件所在目录自动保存 Markdown 文件：' +
        originFileName +
        ' 和 ' +
        transFileName +
        '。',
      'After parsing, two Markdown files will be saved in the current folder: ' +
        originFileName +
        ' and ' +
        transFileName +
        '.'
    )

    const batchRow = document.createElement('div')
    batchRow.style.marginBottom = '8px'
    batchRow.innerHTML = pdf2docText(
      '当前 PDF 文档超过 2 页，将按 <strong>2 页一批</strong>依次翻译。请确认所选模型的上下文长度和速率限制是否足够。',
      'If the PDF has more than 2 pages, it will be translated in <strong>batches of 2 pages</strong>. Make sure your model\'s context length and rate limits are sufficient.'
    )

    const quotaRow = document.createElement('div')
    quotaRow.style.cssText =
      'margin-top:4px;margin-bottom:4px;font-size:13px;color:var(--muted,#4b5563);'
    const quotaLabel = document.createElement('span')
    quotaLabel.textContent = pdf2docText('当前合计剩余可用解析页数：', 'Total remaining parse pages: ')
    const quotaValue = document.createElement('span')
    quotaValue.textContent = pdf2docText('正在查询...', 'Querying...')
    quotaRow.appendChild(quotaLabel)
    quotaRow.appendChild(quotaValue)

    const footer = document.createElement('div')
    footer.style.cssText =
      'padding:12px 18px;border-top:1px solid var(--border,#e5e7eb);display:flex;justify-content:flex-end;gap:10px;background:var(--bg-muted,#f9fafb);'

    const btnCancel = document.createElement('button')
    btnCancel.textContent = pdf2docText('取消', 'Cancel')
    btnCancel.style.cssText =
      'padding:6px 16px;border-radius:6px;border:1px solid var(--border,#d1d5db);background:var(--bg,#fff);color:var(--muted,#4b5563);cursor:pointer;font-size:13px;'

    const btnOk = document.createElement('button')
    btnOk.textContent = pdf2docText('确认', 'Confirm')
    btnOk.style.cssText =
      'padding:6px 18px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer;font-size:13px;font-weight:500;'

    btnCancel.onclick = () => {
      try {
        document.body.removeChild(overlay)
      } catch {}
      resolve({ confirmed: false })
    }

    btnOk.onclick = () => {
      try {
        document.body.removeChild(overlay)
      } catch {}
      resolve({
        confirmed: true
      })
    }

    overlay.onclick = (e) => {
      if (e.target === overlay) {
        try {
          document.body.removeChild(overlay)
        } catch {}
        resolve({ confirmed: false })
      }
    }

    body.appendChild(nameRow)
    body.appendChild(descRow)
    body.appendChild(modelRow)
    body.appendChild(saveRow)
    body.appendChild(batchRow)
    body.appendChild(quotaRow)

    footer.appendChild(btnCancel)
    footer.appendChild(btnOk)

    dialog.appendChild(header)
    dialog.appendChild(body)
    dialog.appendChild(footer)

    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    // 查询当前剩余页数，失败时仅更新文案，不中断流程
    ;(async () => {
      let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()
      if (apiUrl.endsWith('/pdf')) {
        apiUrl += '/'
      }
      try {
        const enabledTokens = getEnabledApiTokens(cfg).map(it => it.token).filter(Boolean)
        const primaryToken = getPrimaryApiToken(cfg)
        const headers = {
          Authorization: 'Bearer ' + (primaryToken || ''),
          'X-PDF2DOC-Version': PDF2DOC_COMPAT_VERSION
        }
        if (enabledTokens.length > 1) {
          headers['X-Api-Tokens'] = JSON.stringify(enabledTokens)
        }

        const res = await context.http.fetch(apiUrl, {
          method: 'GET',
          headers
        })

        const text = await res.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          quotaValue.textContent = pdf2docText('查询失败（响应格式错误）', 'Query failed: invalid response format')
          return
        }

        if (res.status < 200 || res.status >= 300 || !data || data.ok !== true) {
          const msg =
            (data && (data.message || data.error)) ||
            text ||
            pdf2docText('请求失败（HTTP ' + res.status + '）', 'Request failed (HTTP ' + res.status + ')')
          quotaValue.textContent = pdf2docText('查询失败：', 'Query failed: ') + msg
          return
        }

        const total = data.total_pages ?? 0
        const used = data.used_pages ?? 0
        const remain = data.remain_pages ?? Math.max(0, total - used)
        quotaValue.textContent = pdf2docText(
          String(remain) + ' 页（总 ' + total + ' 页，已用 ' + used + ' 页）',
          String(remain) + ' pages (total ' + total + ', used ' + used + ')'
        )
      } catch (e) {
        const msg = e && e.message ? e.message : String(e || pdf2docText('未知错误', 'unknown error'))
        quotaValue.textContent = pdf2docText('查询失败：', 'Query failed: ') + msg
      }
    })()

    // 查询 AI 助手当前模型配置，告知用户当前模型/是否免费模型
    ;(async () => {
      try {
        const ai =
          typeof context.getPluginAPI === 'function'
            ? context.getPluginAPI('ai-assistant')
            : null
        if (!ai || typeof ai.getConfig !== 'function') {
          modelRow.textContent = pdf2docText(
            '当前模型：未知（AI 助手插件未安装或版本过低）',
            'Current model: unknown (AI Assistant plugin not installed or too old)'
          )
          return
        }
        const aiCfg = await ai.getConfig()
        if (!aiCfg || typeof aiCfg !== 'object') {
          modelRow.textContent = pdf2docText('当前模型：获取失败', 'Current model: failed to fetch')
          return
        }

        const provider = aiCfg.provider || 'openai'
        const isFreeProvider = provider === 'free'
        const modelId = (aiCfg.model && String(aiCfg.model).trim()) || ''
        const freeKey = (aiCfg.freeModel && String(aiCfg.freeModel).trim()) || ''
        const alwaysFreeTrans = !!aiCfg.alwaysUseFreeTrans

        let detail = ''
        if (alwaysFreeTrans) {
          detail = pdf2docText(
            '已启用“翻译始终使用免费模型”，本次将使用免费模型' + (freeKey ? `（${freeKey}）` : ''),
            'Always-use-free-model is enabled; this translation uses the free model' + (freeKey ? ` (${freeKey})` : '')
          )
        } else if (isFreeProvider) {
          detail = pdf2docText(
            '当前处于免费模式，将使用免费模型' + (freeKey ? `（${freeKey}）` : ''),
            'Currently in free mode; the free model will be used' + (freeKey ? ` (${freeKey})` : '')
          )
        } else {
          detail = pdf2docText(
            '当前使用自定义模型' + (modelId ? `（${modelId}）` : ''),
            'Using custom model' + (modelId ? ` (${modelId})` : '')
          )
        }

        modelRow.textContent = pdf2docText('当前模型：', 'Current model: ') + detail
      } catch (e) {
        modelRow.textContent = pdf2docText('当前模型：获取失败', 'Current model: failed to fetch')
      }
    })()
  })
}



  function ensureSettingsStyle() {
    if (typeof document === 'undefined') return
    if (document.getElementById(PDF2DOC_STYLE_ID)) return
    const css = [
    '.pdf2doc-settings-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:90010;}',
    '.pdf2doc-settings-overlay.hidden{display:none;}',
    '.pdf2doc-settings-dialog{width:460px;max-width:calc(100% - 40px);max-height:80vh;background:var(--bg);color:var(--fg);border-radius:10px;border:1px solid var(--border);box-shadow:0 14px 36px rgba(0,0,0,.4);display:flex;flex-direction:column;overflow:hidden;font-size:13px;}',
    '.pdf2doc-settings-header{padding:9px 14px;border-bottom:1px solid var(--border);font-weight:600;font-size:14px;flex-shrink:0;}',
    '.pdf2doc-settings-body{padding:12px 14px;flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;}',
    '.pdf2doc-settings-row{display:grid;grid-template-columns:120px 1fr;gap:6px;align-items:flex-start;}',
    '.pdf2doc-settings-label{font-size:12px;color:var(--muted);padding-top:5px;}',
    '.pdf2doc-settings-input{border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:5px 8px;font-size:12px;width:100%;box-sizing:border-box;}',
    '.pdf2doc-settings-radio-group{display:flex;flex-direction:column;gap:4px;font-size:12px;}',
    '.pdf2doc-settings-radio{display:flex;align-items:center;gap:6px;}',
    '.pdf2doc-settings-radio input{margin:0;}',
      '.pdf2doc-settings-desc{font-size:11px;color:var(--muted);margin-top:2px;}',
      '.pdf2doc-settings-footer{padding:8px 14px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:rgba(127,127,127,.03);flex-shrink:0;}',
      '.pdf2doc-settings-btn{padding:4px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--fg);cursor:pointer;font-size:12px;}',
      '.pdf2doc-settings-btn.primary{background:#2563eb;color:#fff;border-color:#2563eb;}',
    '.pdf2doc-settings-section-title{font-size:12px;font-weight:600;margin-top:6px;margin-bottom:2px;}',
    '.pdf2doc-settings-section-muted{font-size:11px;color:var(--muted);margin-bottom:4px;}',
    '.pdf2doc-settings-purchase-section{background:var(--bg,#fff);border:1px solid var(--border,#e5e7eb);border-radius:6px;padding:14px;margin:10px 0;}',
    '.pdf2doc-settings-purchase-title{font-size:13px;font-weight:600;margin-bottom:6px;color:var(--fg,#333);}',
    '.pdf2doc-settings-purchase-desc{font-size:11px;color:var(--muted,#6b7280);margin-bottom:12px;line-height:1.5;}',
     '.pdf2doc-settings-qrcode-container{display:flex;justify-content:center;align-items:center;margin:12px 0;}',
     '.pdf2doc-settings-qrcode-img{max-width:200px;height:auto;border:1px solid var(--border,#e5e7eb);border-radius:6px;}',
     '.pdf2doc-settings-order-btn{width:100%;padding:9px 14px;border-radius:5px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;font-weight:500;transition:all 0.2s;text-align:center;margin-top:10px;}',
     '.pdf2doc-settings-order-btn:hover{background:#1d4ed8;border-color:#1d4ed8;}',
     '.pdf2doc-token-add{display:flex;gap:6px;align-items:center;}',
     '.pdf2doc-token-list{display:flex;flex-direction:column;gap:6px;margin-top:8px;}',
     '.pdf2doc-token-item{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
     '.pdf2doc-token-item .token{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;}',
     '.pdf2doc-token-item .quota{font-size:11px;color:var(--muted);margin-left:auto;}',
     '.pdf2doc-token-item .btn-mini{padding:3px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--fg);cursor:pointer;font-size:12px;}',
     // 解析进度遮罩（不可关闭；失败后才允许关闭）
     '.pdf2doc-progress-overlay{position:fixed;inset:0;background:rgba(255,255,255,.86);display:flex;align-items:center;justify-content:center;z-index:' +
       PDF2DOC_PROGRESS_Z_INDEX +
       ';}',
     '.pdf2doc-progress-dialog{width:320px;max-width:calc(100% - 40px);background:rgba(255,255,255,.92);border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.18);border:1px solid rgba(0,0,0,.08);padding:22px 18px 16px;color:#111827;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;}',
     '.pdf2doc-progress-icon{display:flex;align-items:center;justify-content:center;margin-bottom:10px;}',
     '.pdf2doc-progress-icon .doc{width:24px;height:30px;border:2px solid #111827;border-radius:2px;position:relative;background:#fff;}',
     '.pdf2doc-progress-icon .doc:before{content:\"\";position:absolute;top:0;right:0;width:8px;height:8px;border-left:2px solid #111827;border-bottom:2px solid #111827;background:#fff;}',
     '.pdf2doc-progress-icon .doc:after{content:\"\";position:absolute;left:4px;right:4px;top:12px;height:2px;background:#3b82f6;animation:pdf2docScan 1.2s ease-in-out infinite;}',
     '.pdf2doc-progress-bars{display:flex;gap:10px;align-items:center;justify-content:center;margin:6px 0 12px;}',
     '.pdf2doc-progress-bars span{width:26px;height:3px;background:#111827;border-radius:999px;opacity:.2;transform:translateY(0);animation:pdf2docBars 1.1s infinite ease-in-out;}',
     '.pdf2doc-progress-bars span:nth-child(2){animation-delay:.18s}',
     '.pdf2doc-progress-bars span:nth-child(3){animation-delay:.36s}',
     '@keyframes pdf2docBars{0%,100%{opacity:.15;transform:translateY(0)}50%{opacity:.9;transform:translateY(-3px)}}',
    '@keyframes pdf2docScan{0%{top:12px;opacity:1}50%{top:22px;opacity:1}51%{opacity:0}100%{top:12px;opacity:0}}',
     '.pdf2doc-progress-title{text-align:center;font-weight:700;font-size:16px;letter-spacing:.2px;margin:0 0 6px;}',
      '.pdf2doc-progress-sub{text-align:center;font-size:12px;color:#374151;line-height:1.4;margin:0 0 10px;}',
      '.pdf2doc-progress-error{display:none;margin-top:8px;font-size:12px;line-height:1.45;color:#b91c1c;word-break:break-word;white-space:pre-wrap;}',
      '.pdf2doc-progress-error.show{display:block;}',
      '.pdf2doc-progress-cancel{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:6px;}',
      '.pdf2doc-progress-cancel.hide{display:none;}',
      '.pdf2doc-progress-cancel-btn{padding:7px 18px;border-radius:8px;border:none;background:linear-gradient(135deg,#fee2e2 0%,#fecaca 100%);color:#b91c1c;cursor:pointer;font-size:12px;font-weight:500;box-shadow:0 1px 3px rgba(185,28,28,.15);transition:all .2s ease;}',
      '.pdf2doc-progress-cancel-btn:hover{background:linear-gradient(135deg,#fecaca 0%,#fca5a5 100%);box-shadow:0 2px 6px rgba(185,28,28,.25);transform:translateY(-1px);}',
      '.pdf2doc-progress-cancel-btn:active{transform:translateY(0);box-shadow:0 1px 2px rgba(185,28,28,.2);}',
      '.pdf2doc-progress-cancel-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none;}',
      '.pdf2doc-progress-cancel-tip{font-size:12px;color:#6b7280;line-height:1.4;text-align:center;max-width:360px;}',
      '.pdf2doc-progress-resume-tip{font-size:12px;color:#6b7280;line-height:1.4;text-align:center;max-width:360px;margin:8px auto 0;}',
      '.pdf2doc-progress-actions{display:none;justify-content:center;margin-top:12px;}',
      '.pdf2doc-progress-actions.show{display:flex;}',
      '.pdf2doc-progress-btn{padding:6px 16px;border-radius:10px;border:1px solid rgba(0,0,0,.12);background:#fff;color:#111827;cursor:pointer;font-size:12px;}'
    ].join('\n')
   const style = document.createElement('style')
   style.id = PDF2DOC_STYLE_ID
   style.textContent = css
    document.head.appendChild(style)
  }

  // 打开一个“不可关闭”的解析进度遮罩；成功自动关闭，失败显示错误并允许关闭。
  // 这不是“真进度”，只显示计时器，用来告诉用户“别急，程序还活着”。
  let __pdf2docActiveProgress__ = null
  function openPdf2DocProgressOverlay(opt) {
    if (typeof document === 'undefined') return null
    ensureSettingsStyle()

    // 同一时间只允许一个遮罩，避免重入导致屏幕被盖两层。
    try {
      if (__pdf2docActiveProgress__ && typeof __pdf2docActiveProgress__.close === 'function') {
        __pdf2docActiveProgress__.close()
      }
    } catch {}
    __pdf2docActiveProgress__ = null

    const output = opt && opt.output === 'docx' ? 'docx' : 'markdown'

    const overlay = document.createElement('div')
    overlay.className = 'pdf2doc-progress-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'pdf2doc-progress-dialog'
    overlay.appendChild(dialog)

    const icon = document.createElement('div')
    icon.className = 'pdf2doc-progress-icon'
    icon.innerHTML = '<div class="doc" aria-hidden="true"></div>'
    dialog.appendChild(icon)

    const bars = document.createElement('div')
    bars.className = 'pdf2doc-progress-bars'
    bars.innerHTML = '<span></span><span></span><span></span>'
    dialog.appendChild(bars)

    const title = document.createElement('div')
    title.className = 'pdf2doc-progress-title'
    dialog.appendChild(title)

    const sub = document.createElement('div')
    sub.className = 'pdf2doc-progress-sub'
    dialog.appendChild(sub)

    const error = document.createElement('div')
    error.className = 'pdf2doc-progress-error'
    dialog.appendChild(error)

    const cancelWrap = document.createElement('div')
    cancelWrap.className = 'pdf2doc-progress-cancel'
    const btnCancel = document.createElement('button')
    btnCancel.type = 'button'
    btnCancel.className = 'pdf2doc-progress-cancel-btn'
    btnCancel.textContent = pdf2docText('终止解析', 'Cancel parsing')
    const cancelTip = document.createElement('div')
    cancelTip.className = 'pdf2doc-progress-cancel-tip'
    cancelTip.textContent = pdf2docText('已解析的内容会正常扣除页数', 'Parsed content will still be billed')
    cancelWrap.appendChild(btnCancel)
    cancelWrap.appendChild(cancelTip)
    dialog.appendChild(cancelWrap)

    const resumeTip = document.createElement('div')
    resumeTip.className = 'pdf2doc-progress-resume-tip'
    resumeTip.textContent =
      output === 'markdown'
        ? pdf2docText(
            '如遇到失败，可重新解析。已完成解析的部分不会重复扣费。',
            'If parsing fails, you can retry. Completed parts will not be billed again.'
          )
        : pdf2docText(
            '如遇到失败，可重新解析。',
            'If parsing fails, you can retry.'
          )
    dialog.appendChild(resumeTip)

    const actions = document.createElement('div')
    actions.className = 'pdf2doc-progress-actions'
    const btnClose = document.createElement('button')
    btnClose.type = 'button'
    btnClose.className = 'pdf2doc-progress-btn'
    btnClose.textContent = pdf2docText('关闭', 'Close')
    actions.appendChild(btnClose)
    dialog.appendChild(actions)

    const state = {
      stage: 'parsing', // uploading|parsing|finalizing|post
      startedAt: Date.now(),
      closable: false,
      closed: false,
      cancelRequested: false,
      postDone: 0,
      postTotal: 0,
      splitDone: 0,
      splitTotal: 0,
      batchDone: 0,
      batchTotal: 0,
      batchName: '',
      timer: null,
      onKeyDown: null
    }

    const fmtElapsed = () => {
      const sec = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000))
      const mm = Math.floor(sec / 60)
      const ss = sec % 60
      const m2 = String(mm).padStart(2, '0')
      const s2 = String(ss).padStart(2, '0')
      return `${m2}:${s2}`
    }

    const render = () => {
      if (state.closed) return
      const st = String(state.stage || 'parsing')
      if (st === 'cancelled') {
        title.textContent = pdf2docText('已终止解析', 'Parsing cancelled')
        sub.textContent = pdf2docText(
          `已用时 ${fmtElapsed()}`,
          `Elapsed ${fmtElapsed()}`
        )
        return
      }
      if (st === 'uploading') {
        title.textContent = pdf2docText('上传中', 'Uploading')
        sub.textContent = pdf2docText(
          `正在上传文件（已用时 ${fmtElapsed()}）`,
          `Uploading file (elapsed ${fmtElapsed()})`
        )
        return
      }
      if (st === 'splitting') {
        title.textContent = pdf2docText('分割中', 'Splitting')
        const total = state.splitTotal || 0
        const done = state.splitDone || 0
        if (total > 0) {
          sub.textContent = pdf2docText(
            `正在保存分割片段 ${Math.min(done, total)}/${total}（已用时 ${fmtElapsed()}）`,
            `Saving split parts ${Math.min(done, total)}/${total} (elapsed ${fmtElapsed()})`
          )
        } else {
          sub.textContent = pdf2docText(
            `正在分割 PDF（已用时 ${fmtElapsed()}）`,
            `Splitting PDF (elapsed ${fmtElapsed()})`
          )
        }
        return
      }
      if (st === 'batch') {
        title.textContent = pdf2docText('批量解析中', 'Batch parsing')
        const total = state.batchTotal || 0
        const done = state.batchDone || 0
        const name = String(state.batchName || '')
        const countText = total > 0 ? `${Math.min(done, total)}/${total}` : pdf2docText('处理中', 'processing')
        const nameText = name ? ('：' + name) : ''
        sub.textContent = pdf2docText(
          `正在批量解析 ${countText}${nameText}（已用时 ${fmtElapsed()}）`,
          `Batch parsing ${countText}${nameText} (elapsed ${fmtElapsed()})`
        )
        return
      }
      if (st === 'post') {
        const total = state.postTotal || 0
        const done = state.postDone || 0
        if (total > 0) {
          title.textContent = pdf2docText('处理图片', 'Processing images')
          sub.textContent = pdf2docText(
            `正在处理图片 ${Math.min(done, total)}/${total}（已用时 ${fmtElapsed()}）`,
            `Processing images ${Math.min(done, total)}/${total} (elapsed ${fmtElapsed()})`
          )
        } else {
          title.textContent = pdf2docText('整理中', 'Finishing')
          sub.textContent = pdf2docText(
            `正在整理解析结果（已用时 ${fmtElapsed()}）`,
            `Finishing parsed result (elapsed ${fmtElapsed()})`
          )
        }
        return
      }
      if (st === 'finalizing') {
        title.textContent = pdf2docText('即将完成', 'Almost done')
        sub.textContent = pdf2docText(
          `正在收尾（已用时 ${fmtElapsed()}）`,
          `Finalizing (elapsed ${fmtElapsed()})`
        )
        return
      }

      // parsing
      title.textContent =
        output === 'docx'
          ? pdf2docText('解析中', 'Parsing')
          : pdf2docText('解析中', 'Parsing')
      sub.textContent = pdf2docText(
        `已用时 ${fmtElapsed()}`,
        `Elapsed ${fmtElapsed()}`
      )
    }

    const tick = () => {
      if (state.closed) return
      if (state.closable) return
      render()
    }

    const cleanup = () => {
      if (state.closed) return
      state.closed = true
      try {
        if (state.timer) clearInterval(state.timer)
      } catch {}
      state.timer = null
      try {
        if (state.onKeyDown) document.removeEventListener('keydown', state.onKeyDown, true)
      } catch {}
      state.onKeyDown = null
      try {
        document.body.removeChild(overlay)
      } catch {}
      __pdf2docActiveProgress__ = null
    }

    const allowClose = () => {
      state.closable = true
      actions.classList.add('show')
      cancelWrap.classList.add('hide')
    }

    btnClose.onclick = () => cleanup()

    const markCancelled = () => {
      if (state.closed) return
      if (state.cancelRequested) return
      state.cancelRequested = true
      state.stage = 'cancelled'
      bars.style.display = 'none'
      error.classList.remove('show')
      error.textContent = ''
      btnCancel.disabled = true
      allowClose()
      render()
    }

    const onCancel = opt && typeof opt.onCancel === 'function' ? opt.onCancel : null
    if (!onCancel) {
      // 没有取消能力时，不展示“终止解析”，避免误导用户。
      cancelWrap.classList.add('hide')
    }
    btnCancel.onclick = () => {
      if (!onCancel) return
      markCancelled()
      try { onCancel() } catch {}
    }

    // 不允许点背景关闭（解析中/成功前）。
    overlay.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
    })
    dialog.addEventListener('click', (e) => {
      e.stopPropagation()
    })

    state.onKeyDown = (e) => {
      if (!e) return
      const key = e.key || ''
      if (key !== 'Escape') return
      if (!state.closable) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      cleanup()
    }
    document.addEventListener('keydown', state.onKeyDown, true)

    document.body.appendChild(overlay)

    state.timer = setInterval(tick, 250)
    render()

    const api = {
      setStage(nextStage) {
        if (state.closed) return
        state.stage = String(nextStage || 'parsing')
        render()
      },
      setPostProgress(done, total) {
        if (state.closed) return
        const d = typeof done === 'number' && Number.isFinite(done) ? done : parseInt(done || '0', 10) || 0
        const t = typeof total === 'number' && Number.isFinite(total) ? total : parseInt(total || '0', 10) || 0
        state.postDone = Math.max(0, d)
        state.postTotal = Math.max(0, t)
        if (String(state.stage || '') === 'post') {
          render()
        }
      },
      setSplitProgress(done, total) {
        if (state.closed) return
        const d = typeof done === 'number' && Number.isFinite(done) ? done : parseInt(done || '0', 10) || 0
        const t = typeof total === 'number' && Number.isFinite(total) ? total : parseInt(total || '0', 10) || 0
        state.splitDone = Math.max(0, d)
        state.splitTotal = Math.max(0, t)
        if (String(state.stage || '') === 'splitting') {
          render()
        }
      },
      setBatchProgress(done, total, name) {
        if (state.closed) return
        const d = typeof done === 'number' && Number.isFinite(done) ? done : parseInt(done || '0', 10) || 0
        const t = typeof total === 'number' && Number.isFinite(total) ? total : parseInt(total || '0', 10) || 0
        state.batchDone = Math.max(0, d)
        state.batchTotal = Math.max(0, t)
        state.batchName = String(name || '')
        if (String(state.stage || '') === 'batch') {
          render()
        }
      },
      fail(message, titleOverride) {
        if (state.closed) return
        title.textContent = titleOverride ? String(titleOverride) : pdf2docText('解析失败', 'Parse failed')
        sub.textContent = pdf2docText(
          `已用时 ${fmtElapsed()}`,
          `Elapsed ${fmtElapsed()}`
        )
        bars.style.display = 'none'
        error.textContent = String(message || pdf2docText('解析失败', 'Parse failed'))
        error.classList.add('show')
        allowClose()
      },
      close() {
        cleanup()
      },
      cancelled() {
        markCancelled()
      }
    }

    __pdf2docActiveProgress__ = api
    return api
  }
  
  function openSettingsDialog(context, cfg) {
    return new Promise(resolve => {
    if (typeof document === 'undefined') {
      
      resolve(null)
      return
    }

    ensureSettingsStyle()

    const overlay = document.createElement('div')
    overlay.className = 'pdf2doc-settings-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'pdf2doc-settings-dialog'
    overlay.appendChild(dialog)

    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        document.body.removeChild(overlay)
        resolve(null)
      }
    })
    dialog.addEventListener('click', e => {
      e.stopPropagation()
    })

    const header = document.createElement('div')
    header.className = 'pdf2doc-settings-header'
    header.textContent = pdf2docText('pdf2doc 设置', 'pdf2doc Settings')
    dialog.appendChild(header)

    const body = document.createElement('div')
    body.className = 'pdf2doc-settings-body'
    dialog.appendChild(body)


    const tokenItems = normalizeApiTokens(cfg.apiTokens, cfg.apiToken)
    const quotaState = new Map() // token -> { ok, total, used, remain, msg }

    const rowToken = document.createElement('div')
    rowToken.className = 'pdf2doc-settings-row'
    const labToken = document.createElement('div')
    labToken.className = 'pdf2doc-settings-label'
    labToken.textContent = pdf2docText('密钥', 'Token')
    const boxToken = document.createElement('div')

    const addWrap = document.createElement('div')
    addWrap.className = 'pdf2doc-token-add'
    const inputAdd = document.createElement('input')
    inputAdd.type = 'text'
    inputAdd.className = 'pdf2doc-settings-input'
    inputAdd.placeholder = pdf2docText('粘贴密钥后回车或点“添加”', 'Paste token then press Enter or click Add')
    inputAdd.style.flex = '1'
    const btnAdd = document.createElement('button')
    btnAdd.type = 'button'
    btnAdd.className = 'pdf2doc-settings-btn'
    btnAdd.textContent = pdf2docText('添加', 'Add')
    addWrap.appendChild(inputAdd)
    addWrap.appendChild(btnAdd)
    boxToken.appendChild(addWrap)

    const tipToken = document.createElement('div')
    tipToken.className = 'pdf2doc-settings-desc'
    tipToken.textContent = pdf2docText(
      '可添加多个余额密钥，支持叠加：丢失密钥可通过我的订单找回',
      'Multiple balance keys can be added and stacked: lost keys can be retrieved through My Orders'
    )
    boxToken.appendChild(tipToken)

    const btnQuotaAll = document.createElement('button')
    btnQuotaAll.type = 'button'
    btnQuotaAll.className = 'pdf2doc-settings-btn'
    btnQuotaAll.textContent = pdf2docText('查询全部剩余页数', 'Check all remaining pages')
    btnQuotaAll.style.marginTop = '6px'
    boxToken.appendChild(btnQuotaAll)

    const quotaInfo = document.createElement('div')
    quotaInfo.className = 'pdf2doc-settings-desc'
    quotaInfo.textContent = ''
    boxToken.appendChild(quotaInfo)

    const tokenList = document.createElement('div')
    tokenList.className = 'pdf2doc-token-list'
    boxToken.appendChild(tokenList)

    // 仅自动保存密钥列表，不触碰其他配置；并且串行写入，避免并发覆盖
    let persistSeq = Promise.resolve()
    function queuePersistTokens() {
      persistSeq = persistSeq
        .then(async () => {
          const apiTokens = tokenItems
            .map(it => ({
              token: String(it && it.token ? it.token : '').trim(),
              enabled: it && it.enabled === false ? false : true
            }))
            .filter(it => it.token)
          const apiToken = getPrimaryApiToken({ apiTokens, apiToken: '' })
          await context.storage.set('apiTokens', JSON.stringify(apiTokens))
          await context.storage.set('apiToken', apiToken)
        })
        .catch(() => {})
    }

    function updateQuotaSummaryText() {
      const allCount = tokenItems.length
      const enabled = tokenItems.filter(it => it && it.enabled !== false)
      const enabledCount = enabled.length

      let knownEnabledRemain = 0
      let unknownEnabled = 0
      for (const it of enabled) {
        const state = quotaState.get(it.token)
        if (state && state.ok === true && typeof state.remain === 'number') {
          knownEnabledRemain += state.remain
        } else {
          unknownEnabled += 1
        }
      }

      const suffix =
        unknownEnabled > 0
          ? pdf2docText('（' + unknownEnabled + ' 个启用密钥未查询）', ' (' + unknownEnabled + ' enabled tokens not queried)')
          : ''

      quotaInfo.textContent = pdf2docText(
        '已配置 ' + allCount + ' 个密钥，启用 ' + enabledCount + ' 个；启用密钥合计剩余：' + knownEnabledRemain + ' 页' + suffix,
        'Configured ' + allCount + ' tokens; ' + enabledCount + ' enabled; total remaining (enabled): ' + knownEnabledRemain + ' pages' + suffix
      )
    }

    function renderTokenList() {
      tokenList.innerHTML = ''
      if (tokenItems.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'pdf2doc-settings-desc'
        empty.textContent = pdf2docText('尚未添加密钥', 'No tokens added yet')
        tokenList.appendChild(empty)
        updateQuotaSummaryText()
        return
      }

      tokenItems.forEach((it, index) => {
        const row = document.createElement('div')
        row.className = 'pdf2doc-token-item'

        const chk = document.createElement('input')
        chk.type = 'checkbox'
        chk.checked = it.enabled !== false
        chk.addEventListener('change', () => {
          it.enabled = chk.checked
          updateQuotaSummaryText()
          queuePersistTokens()
        })

        const tokenText = document.createElement('span')
        tokenText.className = 'token'
        tokenText.textContent = maskApiTokenForDisplay(it.token)

        const quotaText = document.createElement('span')
        quotaText.className = 'quota'
        const state = quotaState.get(it.token)
        if (!state) {
          quotaText.textContent = pdf2docText('未查询', 'Not checked')
        } else if (state.ok !== true) {
          quotaText.textContent = pdf2docText('查询失败', 'Failed')
          if (state.msg) quotaText.title = state.msg
        } else {
          quotaText.textContent = pdf2docText(
            '剩余 ' + state.remain + ' 页（总 ' + state.total + '，已用 ' + state.used + '）',
            'Remain ' + state.remain + ' (total ' + state.total + ', used ' + state.used + ')'
          )
        }

        const btnCheck = document.createElement('button')
        btnCheck.type = 'button'
        btnCheck.className = 'btn-mini'
        btnCheck.textContent = pdf2docText('查询', 'Check')
        btnCheck.addEventListener('click', () => {
          fetchQuotaForToken(it.token)
        })

        const btnRemove = document.createElement('button')
        btnRemove.type = 'button'
        btnRemove.className = 'btn-mini'
        btnRemove.textContent = pdf2docText('删除', 'Remove')
        btnRemove.addEventListener('click', () => {
          tokenItems.splice(index, 1)
          quotaState.delete(it.token)
          renderTokenList()
          queuePersistTokens()
        })

        row.appendChild(chk)
        row.appendChild(tokenText)
        row.appendChild(btnCheck)
        row.appendChild(btnRemove)
        row.appendChild(quotaText)
        tokenList.appendChild(row)
      })

      updateQuotaSummaryText()
    }

    const fetchQuotaForToken = async (token) => {
      const t = String(token || '').trim()
      if (!t) return

      quotaState.set(t, { ok: false, msg: pdf2docText('正在查询...', 'Checking...') })
      renderTokenList()

      let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()
      if (apiUrl.endsWith('/pdf')) {
        apiUrl += '/'
      }

      try {
        const res = await context.http.fetch(apiUrl, {
          method: 'GET',
          headers: {
            Authorization: 'Bearer ' + t,
            'X-PDF2DOC-Version': PDF2DOC_COMPAT_VERSION
          }
        })

        const text = await res.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          quotaState.set(t, { ok: false, msg: pdf2docText('服务器响应格式错误', 'Invalid server response') })
          renderTokenList()
          return
        }

        if (res.status < 200 || res.status >= 300) {
          const msg =
            (data && (data.message || data.error)) ||
            text ||
            pdf2docText('请求失败（HTTP ' + res.status + '）', 'Request failed (HTTP ' + res.status + ')')
          quotaState.set(t, { ok: false, msg })
          renderTokenList()
          return
        }

        if (!data || data.ok !== true) {
          const msg = (data && (data.message || data.error)) || pdf2docText('服务器返回错误', 'Server returned an error')
          quotaState.set(t, { ok: false, msg })
          renderTokenList()
          return
        }

        const total = data.total_pages ?? 0
        const used = data.used_pages ?? 0
        const remain = data.remain_pages ?? Math.max(0, total - used)
        quotaState.set(t, { ok: true, total, used, remain })
        renderTokenList()
      } catch (e) {
        const msg = e && e.message ? e.message : String(e || pdf2docText('未知错误', 'unknown error'))
        quotaState.set(t, { ok: false, msg })
        renderTokenList()
      }
    }

    const fetchQuotaAll = async () => {
      const enabled = tokenItems.filter(it => it && it.enabled !== false && String(it.token || '').trim())
      if (enabled.length === 0) {
        updateQuotaSummaryText()
        return
      }
      for (const it of enabled) {
        // 串行查询，避免短时间内打爆后端或触发限流
        // eslint-disable-next-line no-await-in-loop
        await fetchQuotaForToken(it.token)
      }
    }

    function addTokenFromInput() {
      const t = String(inputAdd.value || '').trim()
      if (!t) return
      const existed = tokenItems.find(it => it && it.token === t)
      if (existed) {
        existed.enabled = true
      } else {
        tokenItems.push({ token: t, enabled: true })
      }
      inputAdd.value = ''
      renderTokenList()
      queuePersistTokens()
    }

    btnAdd.addEventListener('click', addTokenFromInput)
    inputAdd.addEventListener('keydown', e => {
      if (e && e.key === 'Enter') {
        e.preventDefault()
        addTokenFromInput()
      }
    })
    btnQuotaAll.addEventListener('click', fetchQuotaAll)

    rowToken.appendChild(labToken)
    rowToken.appendChild(boxToken)
    body.appendChild(rowToken)

    // Markdown 分段解析断点续跑“任务用户名”：仅用于断点归属，不影响扣费（扣费仍按密钥 token）
    const rowJobUser = document.createElement('div')
    rowJobUser.className = 'pdf2doc-settings-row'
    const labJobUser = document.createElement('div')
    labJobUser.className = 'pdf2doc-settings-label'
    labJobUser.textContent = pdf2docText('用户名', 'Job user')
    const boxJobUser = document.createElement('div')
    const jobUserWrap = document.createElement('div')
    jobUserWrap.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;'
    const inputJobUser = document.createElement('input')
    inputJobUser.type = 'text'
    inputJobUser.className = 'pdf2doc-settings-input'
    inputJobUser.placeholder = pdf2docText('用于缓存/续传的用户名（可自定义）', 'A custom user id for cache/resume')
    inputJobUser.value = cfg && typeof cfg.mdJobUser === 'string' ? cfg.mdJobUser : ''
    // 让输入框更短一些，旁边放“保存”按钮
    inputJobUser.style.maxWidth = '240px'
    inputJobUser.style.flex = '0 1 240px'
    const btnSaveJobUser = document.createElement('button')
    btnSaveJobUser.type = 'button'
    btnSaveJobUser.className = 'pdf2doc-settings-btn'
    btnSaveJobUser.textContent = pdf2docText('保存', 'Save')
    jobUserWrap.appendChild(inputJobUser)
    jobUserWrap.appendChild(btnSaveJobUser)
    const tipJobUser = document.createElement('div')
    tipJobUser.className = 'pdf2doc-settings-desc'
    tipJobUser.textContent = pdf2docText(
      '用于解析为Markdown后的缓存和任务中断后继续的关键标识：修改后将丢失已解析缓存。一旦有任务中断，请不要修改此用户名。',
      'Key id for Markdown cache and resuming interrupted jobs. Changing it will lose cached results; do not change it if a job is interrupted.'
    )
    const jobUserSaved = document.createElement('div')
    jobUserSaved.className = 'pdf2doc-settings-desc'
    jobUserSaved.style.color = '#16a34a'
    jobUserSaved.style.display = 'none'
    jobUserSaved.textContent = pdf2docText('保存成功', 'Saved')
    btnSaveJobUser.addEventListener('click', async () => {
      try {
        const v = String(inputJobUser.value || '').trim()
        await context.storage.set('mdJobUser', v)
        jobUserSaved.style.display = 'block'
        setTimeout(() => {
          try { jobUserSaved.style.display = 'none' } catch {}
        }, 1500)
      } catch {
        // 保存失败不阻断主流程
      }
    })
    boxJobUser.appendChild(jobUserWrap)
    boxJobUser.appendChild(tipJobUser)
    boxJobUser.appendChild(jobUserSaved)
    rowJobUser.appendChild(labJobUser)
    rowJobUser.appendChild(boxJobUser)
    body.appendChild(rowJobUser)

    
    const purchaseSection = document.createElement('div')
    purchaseSection.className = 'pdf2doc-settings-purchase-section'

    const purchaseTitle = document.createElement('div')
    purchaseTitle.className = 'pdf2doc-settings-purchase-title'
    purchaseTitle.textContent = pdf2docText('支付宝扫码购买解析页数', 'Scan Alipay QR to buy pages')
    purchaseSection.appendChild(purchaseTitle)

    const purchaseDesc = document.createElement('div')
    purchaseDesc.className = 'pdf2doc-settings-purchase-desc'
    purchaseDesc.innerHTML = pdf2docText(
      '100页PDF 3元 折合0.03元/页<br>200页PDF 5元 折合0.025元/页<br>500页PDF 12元 折合0.024元/页',
      '100 pages: ¥3 (¥0.03/page)<br>200 pages: ¥5 (¥0.025/page)<br>500 pages: ¥12 (¥0.024/page)'
    )
    purchaseSection.appendChild(purchaseDesc)

    const qrcodeContainer = document.createElement('div')
    qrcodeContainer.className = 'pdf2doc-settings-qrcode-container'

    const qrcodeImg = document.createElement('img')
    qrcodeImg.className = 'pdf2doc-settings-qrcode-img'
    qrcodeImg.src = 'https://flymd.llingfei.com/pdf/shop.png'
    qrcodeImg.alt = pdf2docText('支付宝扫码购买', 'Scan with Alipay to purchase')
    qrcodeContainer.appendChild(qrcodeImg)

    purchaseSection.appendChild(qrcodeContainer)

    
    const orderBtn = document.createElement('button')
    orderBtn.type = 'button'
    orderBtn.className = 'pdf2doc-settings-order-btn'
    orderBtn.textContent = pdf2docText('查看我的订单', 'View my orders')
    orderBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      
      const link = document.createElement('a')
      link.href = 'https://www.ldxp.cn/order'
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
      setTimeout(() => document.body.removeChild(link), 100)
    })
    purchaseSection.appendChild(orderBtn)

    body.appendChild(purchaseSection)

    
    const warnTip = document.createElement('div')
    warnTip.className = 'pdf2doc-settings-desc'
    warnTip.style.color = '#b45309'
    warnTip.style.marginTop = '4px'
    warnTip.textContent = pdf2docText(
      'Docx没有缓存功能，重复解析会重复扣费，建议解析为Markdown后另存为Docx',
      'DOCX has no cache; re-parsing will be billed again. It is recommended to parse to Markdown first and then export to DOCX.'
    )
    body.appendChild(warnTip)

    
    const rowOut = document.createElement('div')
    rowOut.className = 'pdf2doc-settings-row'
    const labOut = document.createElement('div')
    labOut.className = 'pdf2doc-settings-label'
    labOut.textContent = pdf2docText('默认输出格式', 'Default output format')
    const outSelect = document.createElement('select')
    outSelect.className = 'pdf2doc-settings-input'
    const optMd = document.createElement('option')
    optMd.value = 'markdown'
    optMd.textContent = 'Markdown'
    const optDocx = document.createElement('option')
    optDocx.value = 'docx'
    optDocx.textContent = pdf2docText('docx（生成可下载的 Word 文件）', 'DOCX (downloadable Word file)')
    outSelect.appendChild(optMd)
    outSelect.appendChild(optDocx)
    outSelect.value = cfg.defaultOutput === 'docx' ? 'docx' : 'markdown'
    rowOut.appendChild(labOut)
    rowOut.appendChild(outSelect)
    body.appendChild(rowOut)

    const footer = document.createElement('div')
    footer.className = 'pdf2doc-settings-footer'
    const btnCancel = document.createElement('button')
    btnCancel.className = 'pdf2doc-settings-btn'
    btnCancel.textContent = pdf2docText('取消', 'Cancel')
    const btnSave = document.createElement('button')
    btnSave.className = 'pdf2doc-settings-btn primary'
    btnSave.textContent = pdf2docText('保存', 'Save')
    footer.appendChild(btnCancel)
    footer.appendChild(btnSave)
    dialog.appendChild(footer)

    
    btnCancel.addEventListener('click', () => {
      document.body.removeChild(overlay)
      resolve(null)
    })

    
    btnSave.addEventListener('click', () => {
      const apiTokens = tokenItems
        .map(it => ({
          token: String(it && it.token ? it.token : '').trim(),
          enabled: it && it.enabled === false ? false : true
        }))
        .filter(it => it.token)
      const apiToken = getPrimaryApiToken({ apiTokens, apiToken: '' })
      const defaultOutput =
        outSelect.value === 'docx' ? 'docx' : 'markdown'
      const mdJobUser = String(inputJobUser.value || '').trim()

      document.body.removeChild(overlay)
      resolve({
        apiBaseUrl: DEFAULT_API_BASE,
        apiToken,
        apiTokens,
        mdJobUser,
        defaultOutput,
        sendToAI: cfg.sendToAI ?? true
      })
    })

    document.body.appendChild(overlay)

    renderTokenList()
    if (tokenItems.length > 0 && tokenItems.length <= 5) {
      fetchQuotaAll()
    }
  })
}

export async function activate(context) {
  
  ;(async () => {
    try {
      const cfg = await loadConfig(context)
      if (!hasAnyApiToken(cfg)) {
        return // 未配置密钥，静默跳过
      }

      let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()
      if (apiUrl.endsWith('/pdf')) {
        apiUrl += '/'
      }

      const enabledTokens = getEnabledApiTokens(cfg).map(it => it.token).filter(Boolean)
      const primaryToken = getPrimaryApiToken(cfg)
      const headers = {
        Authorization: 'Bearer ' + (primaryToken || ''),
        'X-PDF2DOC-Version': PDF2DOC_COMPAT_VERSION
      }
      if (enabledTokens.length > 1) {
        headers['X-Api-Tokens'] = JSON.stringify(enabledTokens)
      }

      const res = await context.http.fetch(apiUrl, {
        method: 'GET',
        headers
      })

      const text = await res.text()
      const data = text ? JSON.parse(text) : null

      if (res.status >= 200 && res.status < 300 && data && data.ok === true) {
        const total = data.total_pages ?? 0
        const used = data.used_pages ?? 0
        const remain = data.remain_pages ?? Math.max(0, total - used)

        context.ui.notice(
          pdf2docText(
            'PDF2Doc 合计剩余页数：' + remain + ' 页（总 ' + total + ' 页）',
            'PDF2Doc total remaining pages: ' + remain + ' (total ' + total + ')'
          ),
          'ok',
          5000
        )
      }
    } catch (e) {
      // 查询失败静默处理，不干扰用户
    }
  })()

    // 定义菜单项数组（用于下拉菜单和 Ribbon 按钮复用）
    const pdf2docMenuChildren = [
        {
          label: pdf2docText('💳 余额/充值', '💳 Balance / Top-up'),
          order: 80,
          onClick: async () => {
            try {
              await openSettings(context)
            } catch {}
          }
        },
        {
          label: pdf2docText('🖼️ IMG→MD', '🖼️ IMG→MD'),
          order: 40,
          onClick: async () => {
            let loadingId = null
            try {
              const cfg = await loadConfig(context)
              if (!hasAnyApiToken(cfg)) {
                context.ui.notice(
                  pdf2docText('请先在插件设置中配置密钥', 'Please configure the PDF2Doc token in plugin settings first'),
                  'err'
                )
                return
              }

              const file = await pickImageFile()

              if (context.ui.showNotification) {
                loadingId = context.ui.showNotification(
                  pdf2docText('正在解析图片为 Markdown，请稍候...', 'Parsing image to Markdown, please wait...'),
                  {
                    type: 'info',
                    duration: 0
                  }
                )
              } else {
                context.ui.notice(
                  pdf2docText('正在解析图片为 Markdown，请稍候...', 'Parsing image to Markdown, please wait...'),
                  'ok',
                  3000
                )
              }

              const result = await uploadAndParseImageFile(context, cfg, file)

              if (loadingId && context.ui.hideNotification) {
                context.ui.hideNotification(loadingId)
              }

              if (result.format === 'markdown' && result.markdown) {
                const baseName = file && file.name ? file.name.replace(/\.[^.]+$/i, '') : 'image'
                const localized = await localizeMarkdownImages(context, result.markdown, {
                  baseName
                })
                const current = context.getEditorValue()
                const merged = current ? current + '\n\n' + localized : localized
                context.setEditorValue(merged)
                context.ui.notice(
                  pdf2docText(
                    '图片解析完成，已插入 Markdown（' + (result.pages || '?') + ' 页）',
                    'Image parsed and inserted as Markdown (' + (result.pages || '?') + ' pages)'
                  ),
                  'ok'
                )
              } else {
                context.ui.notice(
                  pdf2docText('解析成功，但返回格式不是 Markdown', 'Parse succeeded but returned format is not Markdown'),
                  'err'
                )
              }
            } catch (err) {
              if (loadingId && context.ui.hideNotification) {
                try {
                  context.ui.hideNotification(loadingId)
                } catch {}
              }
              context.ui.notice(
                pdf2docText(
                  '图片解析失败：' + (err && err.message ? err.message : String(err)),
                  'Image parse failed: ' + (err && err.message ? err.message : String(err))
                ),
                'err'
              )
            }
          }
        },
        {
          label: pdf2docText('✂️ 分离指定页面范围', '✂️ Extract page range'),
          order: 50,
          title: pdf2docText(
            '截取当前 PDF 的指定页范围并保存为新 PDF（不计费）',
            'Extract a page range from the current PDF and save as a new PDF (free).'
          ),
          onClick: async () => {
            let loadingId = null
            try {
              const cfg = await loadConfig(context)
              if (!hasAnyApiToken(cfg)) {
                context.ui.notice(
                  pdf2docText('请先在插件设置中配置密钥', 'Please configure the PDF2Doc token in plugin settings first'),
                  'err'
                )
                return
              }

              if (
                !context ||
                !context.http ||
                typeof context.http.fetch !== 'function' ||
                typeof context.getCurrentFilePath !== 'function' ||
                typeof context.readFileBinary !== 'function' ||
                typeof context.saveBinaryToCurrentFolder !== 'function'
              ) {
                context.ui.notice(
                  pdf2docText('当前版本不支持截取页范围', 'This version does not support extracting page ranges'),
                  'err'
                )
                return
              }

              // 刻意保持与“📝 PDF→MD”一致：只处理“当前打开的 PDF”。
              const path = context.getCurrentFilePath()
              // 这里必须匹配“.pdf”扩展名；别用 /\\.pdf/，那是匹配“\\pdf”这种鬼东西。
              if (!path || !/\.pdf$/i.test(String(path))) {
                context.ui.notice(
                  pdf2docText('当前没有打开 PDF 文件', 'No PDF file is currently open'),
                  'err'
                )
                return
              }
              const bytes = await context.readFileBinary(path)
              const fileName = String(path).split(/[\\\\/]+/).pop() || 'document.pdf'

              let pagesHint = null
              if (typeof context.getPdfPageCount === 'function') {
                try {
                  let copy = bytes
                  try {
                    if (bytes instanceof ArrayBuffer) copy = bytes.slice(0)
                    else if (bytes instanceof Uint8Array) copy = bytes.slice(0)
                  } catch {}
                  pagesHint = await context.getPdfPageCount(copy)
                } catch {}
              }

              const picked = await showExtractRangeDialog(fileName, pagesHint)
              if (!picked || !picked.confirmed) return

              if (context.ui.showNotification) {
                loadingId = context.ui.showNotification(
                  pdf2docText(
                    `正在截取 PDF 第 ${picked.from}-${picked.to} 页...`,
                    `Extracting PDF pages ${picked.from}-${picked.to}...`
                  ),
                  { type: 'info', duration: 0 }
                )
              }

              const info = await retryOnPdf2DocNetworkError(
                () => requestExtractPdfRange(context, cfg, bytes, fileName, picked.from, picked.to),
                { maxAttempts: 3, baseDelayMs: 800 }
              )

              const r = await context.http.fetch(info.url, { method: 'GET' })
              if (!r || r.status < 200 || r.status >= 300) {
                throw new Error(pdf2docText('下载截取结果失败', 'Failed to download extracted PDF'))
              }
              const buf = await r.arrayBuffer()
              const outBytes = new Uint8Array(buf)

              const outNameRaw = info.suggestedName || ('截取' + picked.from + '-' + picked.to + '-' + fileName)
              const outName = String(outNameRaw).replace(/[\\\\/:*?\"<>|]+/g, '_').trim() || 'extracted.pdf'
              const saved = await context.saveBinaryToCurrentFolder({
                fileName: /\.pdf$/i.test(outName) ? outName : (outName + '.pdf'),
                data: outBytes,
                onConflict: 'renameAuto'
              })
              const savedPath = saved && saved.fullPath ? String(saved.fullPath) : ''

              // 下载成功后清理服务器端临时文件（失败不影响用户本地结果）
              try {
                await cleanupExtractJob(context, cfg, info.job, info.cleanupUrl)
              } catch {}

              if (loadingId && context.ui.hideNotification) {
                try { context.ui.hideNotification(loadingId) } catch {}
                loadingId = null
              }

              if (savedPath && typeof context.openFileByPath === 'function') {
                try { await context.openFileByPath(savedPath) } catch {}
              }

              context.ui.notice(
                pdf2docText(
                  '截取完成，已保存为：' + (savedPath || outName),
                  'Extracted and saved as: ' + (savedPath || outName)
                ),
                'ok',
                4000
              )
            } catch (err) {
              if (loadingId && context.ui.hideNotification) {
                try { context.ui.hideNotification(loadingId) } catch {}
              }
              context.ui.notice(
                pdf2docText(
                  '截取失败：' + (err && err.message ? err.message : String(err)),
                  'Extract failed: ' + (err && err.message ? err.message : String(err))
                ),
                'err',
                5000
              )
            }
          }
        },
        {
        label: pdf2docText('📝 PDF→MD', '📝 PDF→MD'),
        order: 10,
        onClick: async () => {
          let loadingId = null
          let parseOverlay = null
          let cancelSource = null
          try {
            const cfg = await loadConfig(context)
            if (!hasAnyApiToken(cfg)) {
              context.ui.notice(
                pdf2docText('请先在插件设置中配置密钥', 'Please configure the PDF2Doc token in plugin settings first'),
                'err'
              )
              return
            }
            if (typeof context.getCurrentFilePath !== 'function' || typeof context.readFileBinary !== 'function') {
              context.ui.notice(
                pdf2docText('当前版本不支持按路径解析 PDF', 'This version does not support parsing PDF by path'),
                'err'
              )
              return
            }
            const path = context.getCurrentFilePath()
            if (!path || !/\.pdf$/i.test(path)) {
              context.ui.notice(
                pdf2docText('当前没有打开 PDF 文件', 'No PDF file is currently open'),
                'err'
              )
              return
            }

            const bytes = await context.readFileBinary(path)
            const fileName = path.split(/[\\/]+/).pop() || 'document.pdf'

            // 解析前额度风险提示：每次解析前都提示一次（用户要求）。
            const ok = await confirmQuotaRiskBeforeParse(context, cfg, bytes, null, path)
            if (!ok) return

            cancelSource = createPdf2DocCancelSource()
            parseOverlay = openPdf2DocProgressOverlay({
              output: 'markdown',
              onCancel: () => {
                try { if (cancelSource) cancelSource.cancel() } catch {}
              }
            })
            if (!parseOverlay) {
              if (context.ui.showNotification) {
                loadingId = context.ui.showNotification(
                  pdf2docText('正在解析为MD，中间可能闪烁，完成前请勿关闭程序！', 'Parsing to Markdown. The sidebar may flicker; please do not close the app until it finishes.'),
                  {
                    type: 'info',
                    duration: 0
                  }
                )
              } else {
                context.ui.notice(
                  pdf2docText('正在解析为MD，中间可能闪烁，完成前请勿关闭程序！', 'Parsing to Markdown. The sidebar may flicker; please do not close the app until it finishes.'),
                  'ok',
                  3000
                )
              }
            }

            const result = await parsePdfBytes(context, cfg, bytes, fileName, 'markdown', cancelSource)

            if (parseOverlay) parseOverlay.setStage('post')
            if (loadingId && context.ui.hideNotification) {
              context.ui.hideNotification(loadingId)
            }

            if (result.format === 'markdown' && result.markdown) {
              const baseName = fileName ? fileName.replace(/\.pdf$/i, '') : 'document'
              const safeBaseName = String(baseName || '')
                .replace(/[\\/:*?"<>|]+/g, '_')
                .trim() || 'document'
              const localized = await localizeMarkdownImages(context, result.markdown, {
                baseName: safeBaseName,
                onProgress: (done, total) => {
                  if (parseOverlay && typeof parseOverlay.setPostProgress === 'function') {
                    parseOverlay.setPostProgress(done, total)
                  }
                }
              })
              let savedPath = ''
              if (typeof context.saveMarkdownToCurrentFolder === 'function') {
                try {
                  const mdFileName = '解析' + safeBaseName + '.md'
                  savedPath = await context.saveMarkdownToCurrentFolder({
                    fileName: mdFileName,
                    content: localized,
                    onConflict: 'renameAuto'
                  })
                } catch {}
              }

              // 当前是 PDF 文件：不要覆盖 PDF 标签内容，而是新建并打开解析后的 Markdown 文档
              if (savedPath && typeof context.openFileByPath === 'function') {
                try {
                  await context.openFileByPath(savedPath)
                } catch {}
              } else {
                // 兼容旧环境：如果无法保存文件，则退回到直接插入当前文档的行为
                const current = context.getEditorValue()
                const merged = current ? current + '\n\n' + localized : localized
                context.setEditorValue(merged)
              }

              if (parseOverlay) {
                parseOverlay.close()
                parseOverlay = null
              }

              const pagesInfo = result.pages
                ? pdf2docText('（' + result.pages + ' 页）', ' (' + result.pages + ' pages)')
                : ''
              if (savedPath) {
                context.ui.notice(
                  pdf2docText(
                    'PDF 解析完成，已保存为 Markdown 文件并打开' + pagesInfo,
                    'PDF parsed; Markdown file saved and opened' + pagesInfo
                  ),
                  'ok'
                )
              } else {
                context.ui.notice(
                  pdf2docText(
                    'PDF 解析完成，已插入 Markdown（未能自动保存为单独文件）' + pagesInfo,
                    'PDF parsed and inserted as Markdown (could not save separate file)' + pagesInfo
                  ),
                  'ok'
                )
              }
            } else {
              if (parseOverlay) {
                parseOverlay.close()
                parseOverlay = null
              }
              context.ui.notice(
                pdf2docText('解析成功，但返回格式不是 Markdown', 'Parse succeeded but returned format is not Markdown'),
                'err'
              )
            }
          } catch (err) {
            if (isPdf2DocCancelledError(err)) {
              if (parseOverlay && typeof parseOverlay.cancelled === 'function') {
                parseOverlay.cancelled()
              }
              if (loadingId && context.ui.hideNotification) {
                try {
                  context.ui.hideNotification(loadingId)
                } catch {}
              }
              context.ui.notice(
                pdf2docText('已终止解析（已解析的内容会正常扣除页数）', 'Parsing cancelled (parsed content will still be billed)'),
                'info'
              )
              return
            }
            if (parseOverlay) {
              parseOverlay.fail(
                pdf2docText(
                  'PDF 解析失败：' + (err && err.message ? err.message : String(err)),
                  'PDF parse failed: ' + (err && err.message ? err.message : String(err))
                )
              )
            }
            if (loadingId && context.ui.hideNotification) {
              try {
                context.ui.hideNotification(loadingId)
              } catch {}
            }
            context.ui.notice(
              pdf2docText(
                'PDF 解析失败：' + (err && err.message ? err.message : String(err)),
                'PDF parse failed: ' + (err && err.message ? err.message : String(err))
              ),
              'err'
            )
          }
        }
      },
      {
        label: pdf2docText('📁 同文件夹批量解析', '📁 Batch parse (folder)'),
        order: 60,
        onClick: async () => {
          let loadingId = null
          let parseOverlay = null
          let cancelSource = null
          let autoMergeAfterBatch = false
          try {
            const cfg = await loadConfig(context)
            if (!hasAnyApiToken(cfg)) {
              context.ui.notice(
                pdf2docText('请先在插件设置中配置密钥', 'Please configure the token in plugin settings first'),
                'err'
              )
              return
            }
            if (
              typeof context.getCurrentFilePath !== 'function' ||
              typeof context.getLibraryRoot !== 'function' ||
              typeof context.listLibraryFiles !== 'function' ||
              typeof context.readFileBinary !== 'function'
            ) {
              context.ui.notice(
                pdf2docText('当前版本不支持批量解析', 'This version does not support batch parsing'),
                'err'
              )
              return
            }

            const currentPath = context.getCurrentFilePath()
            if (!currentPath || !/\.pdf$/i.test(String(currentPath))) {
              context.ui.notice(
                pdf2docText('请先打开目标文件夹内的任意 PDF', 'Open any PDF in the target folder first'),
                'err'
              )
              return
            }

            const root = await context.getLibraryRoot()
            if (!root || !isPathInDir(currentPath, root)) {
              context.ui.notice(
                pdf2docText('当前文件不在库内', 'The current file is not in the library'),
                'err'
              )
              return
            }

            const fileDirAbs = String(currentPath).replace(/[\\/][^\\/]+$/, '')
            const rootNorm = String(root).replace(/\\/g, '/').replace(/\/+$/, '') + '/'
            const fileNorm = String(currentPath).replace(/\\/g, '/')
            const rel = fileNorm.toLowerCase().startsWith(rootNorm.toLowerCase())
              ? fileNorm.slice(rootNorm.length)
              : ''
            const relDir = rel.split('/').slice(0, -1).join('/')
            if (!relDir) {
              context.ui.notice(
                pdf2docText('无法确定分割文件夹', 'Failed to determine the folder'),
                'err'
              )
              return
            }

            const files = await context.listLibraryFiles({
              extensions: ['pdf'],
              maxDepth: 12,
              includeDirs: [relDir.endsWith('/') ? relDir : (relDir + '/')]
            })

            const parts = (Array.isArray(files) ? files : [])
              .filter(it => it && typeof it.relative === 'string' && typeof it.path === 'string')
              .filter(it => {
                const rr = String(it.relative || '')
                const dir = rr.split('/').slice(0, -1).join('/')
                if (dir !== relDir) return false
                const name = rr.split('/').pop() || ''
                return /\.pdf$/i.test(name)
              })
              .map(it => {
                const name = String(it.relative || '').split('/').pop() || ''
                return { path: String(it.path), name }
              })
              .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

            if (!parts.length) {
              context.ui.notice(
                pdf2docText('当前文件夹未找到 PDF 文件', 'No PDF files found in this folder'),
                'err'
              )
              return
            }

            // 续跑：如果已存在“解析xxx.md”，就直接跳过该 PDF，避免失败后从头开始、重复请求/扣费。
            const existingMdNamesLower = new Set()
            try {
              const mdFiles = await context.listLibraryFiles({
                extensions: ['md'],
                maxDepth: 12,
                includeDirs: [relDir.endsWith('/') ? relDir : (relDir + '/')]
              })
              ;(Array.isArray(mdFiles) ? mdFiles : [])
                .filter(it => it && typeof it.relative === 'string')
                .forEach(it => {
                  const rr = String(it.relative || '')
                  const dir = rr.split('/').slice(0, -1).join('/')
                  if (dir !== relDir) return
                  const name = rr.split('/').pop() || ''
                  if (!/\.md$/i.test(name)) return
                  existingMdNamesLower.add(name.toLowerCase())
                })
            } catch {}

            // 解析前额度风险提示：只提示一次，避免批量弹窗
            try {
              const firstBytes = await context.readFileBinary(parts[0].path)
              const ret = await confirmQuotaRiskBeforeParse(context, cfg, firstBytes, null, parts[0].path, {
                returnDetail: true,
                enableAutoMergeAfterBatch: true,
                defaultAutoMergeAfterBatch: false
              })
              const ok = ret && typeof ret === 'object' ? !!ret.ok : !!ret
              autoMergeAfterBatch = !!(ret && typeof ret === 'object' && ret.autoMergeAfterBatch)
              if (!ok) return
            } catch {}

            cancelSource = createPdf2DocCancelSource()
            parseOverlay = openPdf2DocProgressOverlay({
              output: 'markdown',
              onCancel: () => {
                try { if (cancelSource) cancelSource.cancel() } catch {}
              }
            })
            if (parseOverlay) {
              parseOverlay.setStage('batch')
              if (typeof parseOverlay.setBatchProgress === 'function') {
                parseOverlay.setBatchProgress(0, parts.length, '')
              }
            }

            if (context.ui.showNotification) {
              loadingId = context.ui.showNotification(
                pdf2docText('正在批量解析 PDF，请稍候...', 'Batch parsing PDFs...'),
                { type: 'info', duration: 0 }
              )
            }

            for (let i = 0; i < parts.length; i += 1) {
              const p = parts[i]
              if (parseOverlay && typeof parseOverlay.setBatchProgress === 'function') {
                parseOverlay.setBatchProgress(i, parts.length, p.name)
              }
              const baseName = p.name.replace(/\.pdf$/i, '')
              const safeBaseName = getSafeBaseNameForFile(baseName, 'document')
              if (hasParsedMdInDir(existingMdNamesLower, safeBaseName)) {
                if (parseOverlay && typeof parseOverlay.setBatchProgress === 'function') {
                  const skipName = pdf2docText(
                    `${p.name}（已存在，跳过）`,
                    `${p.name} (exists; skipped)`
                  )
                  parseOverlay.setBatchProgress(i + 1, parts.length, skipName)
                }
                continue
              }

              const bytes = await context.readFileBinary(p.path)
              const result = await retryOnPdf2DocNetworkError(
                async (attempt) => {
                  if (cancelSource && cancelSource.cancelled) throw createPdf2DocCancelledError()
                  if (attempt > 1) {
                    const retryName = pdf2docText(
                      `${p.name}（网络异常，重试 ${attempt - 1}/${2}）`,
                      `${p.name} (network issue, retry ${attempt - 1}/${2})`
                    )
                    if (parseOverlay && typeof parseOverlay.setBatchProgress === 'function') {
                      parseOverlay.setBatchProgress(i, parts.length, retryName)
                    }
                  }
                  return await parsePdfBytes(context, cfg, bytes, p.name, 'markdown', cancelSource)
                },
                { maxAttempts: 3, baseDelayMs: 800, cancelSource }
              )
              if (!result || result.format !== 'markdown' || !result.markdown) {
                throw new Error(pdf2docText('解析成功但未获取到文本内容', 'Parsed but no text content was obtained'))
              }

              const localized = await localizeMarkdownImages(context, result.markdown, {
                baseName: safeBaseName
              })

              const mdName = '解析' + safeBaseName + '.md'
              const mdAbs = joinPath(fileDirAbs, mdName)
              const savedAbs = await writeTextFileRenameAuto(context, mdAbs, localized)
              try {
                const savedName = String(savedAbs || '').split(/[\\/]+/).pop() || ''
                if (savedName) existingMdNamesLower.add(savedName.toLowerCase())
              } catch {}

              if (context && context.ui && typeof context.ui.notice === 'function') {
                context.ui.notice(
                  pdf2docText(
                    '已完成：' + safeBaseName + '（' + (i + 1) + '/' + parts.length + '）',
                    'Done: ' + safeBaseName + ' (' + (i + 1) + '/' + parts.length + ')'
                  ),
                  'ok',
                  1600
                )
              }
            }

            if (parseOverlay && typeof parseOverlay.setBatchProgress === 'function') {
              parseOverlay.setBatchProgress(parts.length, parts.length, '')
            }

            if (loadingId && context.ui.hideNotification) {
              try { context.ui.hideNotification(loadingId) } catch {}
            }
            if (parseOverlay) {
              parseOverlay.close()
              parseOverlay = null
            }

            let mergedPath = ''
            if (autoMergeAfterBatch) {
              let mergeLoadingId = null
              try {
                if (context.ui.showNotification) {
                  mergeLoadingId = context.ui.showNotification(
                    pdf2docText('正在自动合并分割片段结果...', 'Auto-merging split parts...'),
                    { type: 'info', duration: 0 }
                  )
                }
                mergedPath = await mergeSegmentedResultsInDir(context, fileDirAbs, relDir, { allowEmpty: true })
              } catch (e) {
                const msg = e && e.message ? String(e.message) : String(e || '')
                context.ui.notice(
                  pdf2docText('自动合并失败：' + msg, 'Auto-merge failed: ' + msg),
                  'err',
                  5000
                )
              } finally {
                if (mergeLoadingId && context.ui.hideNotification) {
                  try { context.ui.hideNotification(mergeLoadingId) } catch {}
                }
              }
              if (mergedPath && typeof context.openFileByPath === 'function') {
                try { await context.openFileByPath(mergedPath) } catch {}
              }
            }

            context.ui.notice(
              pdf2docText(
                mergedPath
                  ? '批量解析完成，已自动合并分割片段结果'
                  : '批量解析完成，可通过菜单“🧩 分段解析结果合并”生成合并结果',
                mergedPath
                  ? 'Batch parsing finished. Split parts were auto-merged.'
                  : 'Batch parsing finished. Use “🧩 Merge segmented results”.'
              ),
              'ok',
              4000
            )
          } catch (e) {
            if (isPdf2DocCancelledError(e)) {
              if (parseOverlay && typeof parseOverlay.cancelled === 'function') {
                parseOverlay.cancelled()
              }
              if (loadingId && context.ui.hideNotification) {
                try { context.ui.hideNotification(loadingId) } catch {}
              }
              context.ui.notice(
                pdf2docText('已终止解析（已解析的内容会正常扣除页数）', 'Parsing cancelled (parsed content will still be billed)'),
                'info',
                3500
              )
              return
            }
            if (loadingId && context.ui.hideNotification) {
              try { context.ui.hideNotification(loadingId) } catch {}
            }
            const msg = e && e.message ? String(e.message) : String(e || '')
            if (parseOverlay && typeof parseOverlay.fail === 'function') {
              parseOverlay.fail(
                pdf2docText('批量解析失败：' + msg, 'Batch parsing failed: ' + msg),
                pdf2docText('批量解析失败', 'Batch parsing failed')
              )
              parseOverlay = null
              return
            }
            context.ui.notice(
              pdf2docText('批量解析失败：' + msg, 'Batch parsing failed: ' + msg),
              'err',
              5000
            )
          }
        }
      },
      {
        label: pdf2docText('🧩 分段解析结果合并', '🧩 Merge segmented results'),
        order: 70,
        onClick: async () => {
          let loadingId = null
          try {
            if (
              typeof context.getCurrentFilePath !== 'function' ||
              typeof context.getLibraryRoot !== 'function' ||
              typeof context.listLibraryFiles !== 'function' ||
              typeof context.readFileBinary !== 'function' ||
              typeof context.writeTextFile !== 'function'
            ) {
              context.ui.notice(
                pdf2docText('当前版本不支持合并', 'This version does not support merging'),
                'err'
              )
              return
            }

            const currentPath = context.getCurrentFilePath()
            if (!currentPath) {
              context.ui.notice(
                pdf2docText('请先打开分割文件夹内的任意文件', 'Open any file in the split folder first'),
                'err'
              )
              return
            }

            const root = await context.getLibraryRoot()
            if (!root || !isPathInDir(currentPath, root)) {
              context.ui.notice(
                pdf2docText('当前文件不在库内', 'The current file is not in the library'),
                'err'
              )
              return
            }

            const fileDirAbs = String(currentPath).replace(/[\\/][^\\/]+$/, '')
            const rootNorm = String(root).replace(/\\/g, '/').replace(/\/+$/, '') + '/'
            const fileNorm = String(currentPath).replace(/\\/g, '/')
            const rel = fileNorm.toLowerCase().startsWith(rootNorm.toLowerCase())
              ? fileNorm.slice(rootNorm.length)
              : ''
            const relDir = rel.split('/').slice(0, -1).join('/')
            if (!relDir) {
              context.ui.notice(
                pdf2docText('无法确定分割文件夹', 'Failed to determine the folder'),
                'err'
              )
              return
            }

            const files = await context.listLibraryFiles({
              extensions: ['md', 'markdown'],
              maxDepth: 12,
              includeDirs: [relDir.endsWith('/') ? relDir : (relDir + '/')]
            })

            const parts = (Array.isArray(files) ? files : [])
              .filter(it => it && typeof it.relative === 'string' && typeof it.path === 'string')
              .filter(it => {
                const rr = String(it.relative || '')
                const dir = rr.split('/').slice(0, -1).join('/')
                if (dir !== relDir) return false
                const name = rr.split('/').pop() || ''
                return /^(?:解析)?分割片段\d{3,4}-.*\.(md|markdown)$/i.test(name)
              })
              .map(it => {
                const name = String(it.relative || '').split('/').pop() || ''
                const m = name.match(/^(?:解析)?分割片段(\d{3,4})-/i)
                const idx = m ? parseInt(m[1], 10) || 0 : 0
                return { idx, path: String(it.path), name }
              })
              .sort((a, b) => a.idx - b.idx)

            if (!parts.length) {
              context.ui.notice(
                pdf2docText('当前文件夹未找到分割片段的解析结果（.md）', 'No parsed markdown files found'),
                'err'
              )
              return
            }

            if (context.ui.showNotification) {
              loadingId = context.ui.showNotification(
                pdf2docText('正在合并分段解析结果...', 'Merging segmented results...'),
                { type: 'info', duration: 0 }
              )
            }

            const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null
            const mergedChunks = []
            for (const p of parts) {
              const bytes = await context.readFileBinary(p.path)
              const text = decoder ? decoder.decode(bytes) : String(bytes || '')
              mergedChunks.push(text)
            }

            const merged = mergedChunks.join('\n\n---\n\n')
            const folderName = fileDirAbs.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '合并结果'
            const outName = '合并-' + getSafeBaseNameForFile(folderName, '合并结果') + '.md'
            const outAbs = joinPath(fileDirAbs, outName)
            const savedPath = await writeTextFileRenameAuto(context, outAbs, merged)

            if (loadingId && context.ui.hideNotification) {
              try { context.ui.hideNotification(loadingId) } catch {}
            }

            if (savedPath && typeof context.openFileByPath === 'function') {
              try { await context.openFileByPath(savedPath) } catch {}
            }
            context.ui.notice(
              pdf2docText('合并完成', 'Merge completed'),
              'ok',
              3000
            )
          } catch (e) {
            if (loadingId && context.ui.hideNotification) {
              try { context.ui.hideNotification(loadingId) } catch {}
            }
            const msg = e && e.message ? String(e.message) : String(e || '')
            context.ui.notice(
              pdf2docText('合并失败：' + msg, 'Merge failed: ' + msg),
              'err',
              5000
            )
          }
        }
      },
      {
        label: pdf2docText('📄 PDF→DOCX', '📄 PDF→DOCX'),
        order: 20,
        onClick: async () => {
          let loadingId = null
          let parseOverlay = null
          let cancelSource = null
          try {
            const cfg = await loadConfig(context)
            if (!hasAnyApiToken(cfg)) {
              context.ui.notice(
                pdf2docText('请先在插件设置中配置密钥', 'Please configure the PDF2Doc token in plugin settings first'),
                'err'
              )
              return
            }
            if (typeof context.getCurrentFilePath !== 'function' || typeof context.readFileBinary !== 'function') {
              context.ui.notice(
                pdf2docText('当前版本不支持按路径解析 PDF', 'This version does not support parsing PDF by path'),
                'err'
              )
              return
            }
            const path = context.getCurrentFilePath()
            if (!path || !/\.pdf$/i.test(path)) {
              context.ui.notice(
                pdf2docText('当前没有打开 PDF 文件', 'No PDF file is currently open'),
                'err'
              )
              return
            }

            const bytes = await context.readFileBinary(path)
            const fileName = path.split(/[\\/]+/).pop() || 'document.pdf'

            // 解析前额度风险提示：每次解析前都提示一次（用户要求）。
            const ok = await confirmQuotaRiskBeforeParse(context, cfg, bytes, null, path)
            if (!ok) return

            cancelSource = createPdf2DocCancelSource()
            parseOverlay = openPdf2DocProgressOverlay({
              output: 'docx',
              onCancel: () => {
                try { if (cancelSource) cancelSource.cancel() } catch {}
              }
            })
            if (!parseOverlay) {
              if (context.ui.showNotification) {
                loadingId = context.ui.showNotification(
                  pdf2docText('正在解析当前 PDF 为 Docx...', 'Parsing current PDF to DOCX...'),
                  {
                    type: 'info',
                    duration: 0
                  }
                )
              } else {
                context.ui.notice(
                  pdf2docText('正在解析当前 PDF 为 Docx...', 'Parsing current PDF to DOCX...'),
                  'ok',
                  3000
                )
              }
            }

            const result = await parsePdfBytes(context, cfg, bytes, fileName, 'docx', cancelSource)

            if (parseOverlay) parseOverlay.setStage('finalizing')
            if (loadingId && context.ui.hideNotification) {
              context.ui.hideNotification(loadingId)
            }

            if (result.format === 'docx' && result.docx_url) {
              let docxFileName = 'document.docx'
              if (fileName) {
                docxFileName = fileName.replace(/\.pdf$/i, '') + '.docx'
              }

              let downloadSuccess = false
              try {
                const downloadLink = document.createElement('a')
                downloadLink.href = result.docx_url
                downloadLink.target = '_blank'
                downloadLink.download = docxFileName
                downloadLink.style.display = 'none'
                document.body.appendChild(downloadLink)
                downloadLink.click()
                setTimeout(() => {
                  try {
                    document.body.removeChild(downloadLink)
                  } catch {}
                }, 100)
                downloadSuccess = true

                if (parseOverlay) {
                  parseOverlay.close()
                  parseOverlay = null
                }

                context.ui.notice(
                  pdf2docText(
                    'docx 文件已开始下载，请查看浏览器下载栏（' + (result.pages || '?') + ' 页）',
                    'DOCX download started; check your browser downloads (' +
                      (result.pages || '?') +
                      ' pages).'
                  ),
                  'ok',
                  5000
                )
              } catch (e) {
                downloadSuccess = false
              }

              if (!downloadSuccess) {
                if (parseOverlay) {
                  parseOverlay.close()
                  parseOverlay = null
                }
                showDocxDownloadDialog(result.docx_url, result.pages || 0)
              }
            } else {
              if (parseOverlay) {
                parseOverlay.close()
                parseOverlay = null
              }
              context.ui.notice(
                pdf2docText('解析成功，但返回格式不是 Docx', 'Parse succeeded but returned format is not DOCX'),
                'err'
              )
            }
          } catch (err) {
            if (isPdf2DocCancelledError(err)) {
              if (parseOverlay && typeof parseOverlay.cancelled === 'function') {
                parseOverlay.cancelled()
              }
              if (loadingId && context.ui.hideNotification) {
                try {
                  context.ui.hideNotification(loadingId)
                } catch {}
              }
              context.ui.notice(
                pdf2docText('已终止解析（已解析的内容会正常扣除页数）', 'Parsing cancelled (parsed content will still be billed)'),
                'info'
              )
              return
            }
            if (parseOverlay) {
              parseOverlay.fail(
                pdf2docText(
                  'PDF 解析失败：' + (err && err.message ? err.message : String(err)),
                  'PDF parse failed: ' + (err && err.message ? err.message : String(err))
                )
              )
            }
            if (loadingId && context.ui.hideNotification) {
              try {
                context.ui.hideNotification(loadingId)
              } catch {}
            }
            context.ui.notice(
              pdf2docText(
                'PDF 解析失败：' + (err && err.message ? err.message : String(err)),
                'PDF parse failed: ' + (err && err.message ? err.message : String(err))
              ),
              'err'
            )
          }
        }
      },
        {
        label: pdf2docText('🌐 PDF→翻译', '🌐 PDF→Translate'),
        order: 30,
        onClick: async () => {
          let loadingId = null
          const loadingRef = { id: null }
          let parseOverlay = null
          let cancelSource = null
          try {
            const ai =
              typeof context.getPluginAPI === 'function'
                ? context.getPluginAPI('ai-assistant')
                : null
            if (!ai) {
              context.ui.notice(
                pdf2docText('需要先安装并启用 AI 助手插件', 'Please install and enable the AI Assistant plugin first'),
                'err',
                3000
              )
              return
            }

            const ready =
              typeof ai.isConfigured === 'function'
                ? await ai.isConfigured()
                : true
            if (!ready) {
              context.ui.notice(
                pdf2docText(
                  '请先在 AI 助手插件中配置 API Key 或切换免费模式',
                  'Please configure an API key or switch to free mode in the AI Assistant plugin first'
                ),
                'err',
                4000
              )
              return
            }

            const cfg = await loadConfig(context)
            if (!hasAnyApiToken(cfg)) {
              context.ui.notice(
                pdf2docText(
                  '请先在 PDF2Doc 插件设置中配置密钥',
                  'Please configure the PDF2Doc token in plugin settings first'
                ),
                'err',
                3000
              )
              return
            }

            let markdown = ''
            let pages = '?'
            let fileName = ''
            let originSavedPath = ''
            let transSavedPath = ''

            const currentPath =
              typeof context.getCurrentFilePath === 'function'
                ? context.getCurrentFilePath()
                : null
            const isCurrentPdf =
              !!currentPath && /\.pdf$/i.test(String(currentPath || ''))

            const canUseCurrent =
              typeof context.getCurrentFilePath === 'function' &&
              typeof context.readFileBinary === 'function'

            if (canUseCurrent) {
              const path = context.getCurrentFilePath()
              if (path && /\.pdf$/i.test(path)) {
                fileName =
                  path.split(/[\\/]+/).pop() || 'document.pdf'

                // 解析前弹出确认窗口，用户确定是否翻译以及可选页范围
                const preConfirm = await showTranslateConfirmDialog(
                  context,
                  cfg,
                  fileName,
                  undefined
                )
                if (!preConfirm || !preConfirm.confirmed) {
                  context.ui.notice(
                    pdf2docText('已取消 PDF 翻译', 'PDF translation cancelled'),
                    'info',
                    3000
                  )
                  return
                }
                const bytes = await context.readFileBinary(path)

                // 解析前额度风险提示：每次解析前都提示一次（用户要求）。
                const ok = await confirmQuotaRiskBeforeParse(context, cfg, bytes, null, path)
                if (!ok) return

                cancelSource = createPdf2DocCancelSource()
                parseOverlay = openPdf2DocProgressOverlay({
                  output: 'markdown',
                  onCancel: () => {
                    try { if (cancelSource) cancelSource.cancel() } catch {}
                  }
                })
                if (!parseOverlay) {
                  if (context.ui.showNotification) {
                    loadingId = context.ui.showNotification(
                      pdf2docText('正在解析当前 PDF...', 'Parsing current PDF...'),
                      {
                        type: 'info',
                        duration: 0
                      }
                    )
                  } else {
                    context.ui.notice(
                      pdf2docText('正在解析当前 PDF...', 'Parsing current PDF...'),
                      'ok',
                      3000
                    )
                  }
                }

                const result = await parsePdfBytes(
                  context,
                  cfg,
                  bytes,
                  fileName,
                  'markdown',
                  cancelSource
                )
                if (parseOverlay) parseOverlay.setStage('post')
                if (result.format === 'markdown' && result.markdown) {
                  const baseNameInner = fileName
                    ? fileName.replace(/\.pdf$/i, '')
                    : 'document'
                  markdown = await localizeMarkdownImages(
                    context,
                    result.markdown,
                    {
                      baseName: baseNameInner,
                      onProgress: (done, total) => {
                        if (parseOverlay && typeof parseOverlay.setPostProgress === 'function') {
                          parseOverlay.setPostProgress(done, total)
                        }
                      }
                    }
                  )
                  pages = result.pages || '?'
                } else {
                  throw new Error(
                    pdf2docText('解析成功，但返回格式不是 Markdown', 'Parse succeeded but returned format is not Markdown')
                  )
                }
              }
            }

              if (!markdown) {
              const file = await pickPdfFile()
              fileName = file && file.name

              // 解析前弹出确认窗口，用户确定是否翻译以及可选页范围
              const preConfirm = await showTranslateConfirmDialog(
                context,
                cfg,
                fileName || '',
                undefined
              )
              if (!preConfirm || !preConfirm.confirmed) {
                context.ui.notice(
                  pdf2docText('已取消 PDF 翻译', 'PDF translation cancelled'),
                  'info',
                  3000
                )
                return
              }

               // 解析前额度风险提示：每次解析前都提示一次（用户要求）。
               try {
                 const buf = await file.arrayBuffer()
                 const ok = await confirmQuotaRiskBeforeParse(context, cfg, buf, null, file && file.name ? file.name : null)
                 if (!ok) return
               } catch {
                 const ok = await confirmQuotaRiskBeforeParse(context, cfg, null, null, file && file.name ? file.name : null)
                 if (!ok) return
               }

              cancelSource = createPdf2DocCancelSource()
              parseOverlay = openPdf2DocProgressOverlay({
                output: 'markdown',
                onCancel: () => {
                  try { if (cancelSource) cancelSource.cancel() } catch {}
                }
              })
              if (!parseOverlay) {
                if (context.ui.showNotification) {
                  if (loadingId && context.ui.hideNotification) {
                    try {
                      context.ui.hideNotification(loadingId)
                    } catch {}
                    loadingId = null
                  }
                  loadingId = context.ui.showNotification(
                    pdf2docText('正在解析选中的 PDF...', 'Parsing selected PDF...'),
                    {
                      type: 'info',
                      duration: 0
                    }
                  )
                } else {
                  context.ui.notice(
                    pdf2docText('正在解析选中的 PDF...', 'Parsing selected PDF...'),
                    'ok',
                    3000
                  )
                }
              }

              const result = await uploadAndParsePdfFile(
                context,
                cfg,
                file,
                'markdown',
                cancelSource
              )
              if (parseOverlay) parseOverlay.setStage('post')
              if (result.format === 'markdown' && result.markdown) {
                const baseNameFile =
                  file && file.name
                    ? file.name.replace(/\.pdf$/i, '')
                    : 'document'
                markdown = await localizeMarkdownImages(
                  context,
                  result.markdown,
                  {
                    baseName: baseNameFile,
                    onProgress: (done, total) => {
                      if (parseOverlay && typeof parseOverlay.setPostProgress === 'function') {
                        parseOverlay.setPostProgress(done, total)
                      }
                    }
                  }
                )
                pages = result.pages || '?'
              } else {
                throw new Error(
                  pdf2docText('解析成功，但返回格式不是 Markdown', 'Parse succeeded but returned format is not Markdown')
                )
              }
            }

            if (!markdown) {
              if (loadingId && context.ui.hideNotification) {
                try {
                  context.ui.hideNotification(loadingId)
                } catch {}
              }
              if (parseOverlay) {
                parseOverlay.close()
                parseOverlay = null
              }
              context.ui.notice(
                pdf2docText(
                  'PDF 解析成功但未获取到文本内容',
                  'PDF parsed but no text content was obtained'
                ),
                'err',
                4000
              )
              return
            }

            // 根据解析结果计算总页数（用于内部按 2 页一批拆分）
            const numericPages =
              typeof pages === 'number'
                ? pages
                : parseInt(pages || '', 10) || 0

            // 先将解析出的 PDF 原文保存为独立 Markdown 文件（不覆盖源文件），再在当前文档中插入一份，方便用户保存与查阅
            try {
              const baseNameRaw = (fileName || 'document.pdf').replace(/\.pdf$/i, '')
              const originFileName = baseNameRaw + ' (PDF 原文).md'
              if (typeof context.saveMarkdownToCurrentFolder === 'function') {
                try {
                  originSavedPath = await context.saveMarkdownToCurrentFolder({
                    fileName: originFileName,
                    content: markdown,
                    onConflict: 'renameAuto'
                  })
                } catch {}
              }

              // 仅在当前编辑的不是 PDF 文件时，才把原文插入当前文档，避免误改 PDF 源文件
              if (!isCurrentPdf) {
                const currentBefore = context.getEditorValue()
                const originTitle = fileName
                  ? pdf2docText('## PDF 原文：' + fileName, '## PDF original: ' + fileName)
                  : pdf2docText('## PDF 原文', '## PDF original')
                const originBlock =
                  '\n\n---\n\n' + originTitle + '\n\n' + markdown + '\n'
                const mergedOrigin = currentBefore
                  ? currentBefore + originBlock
                  : originBlock
                context.setEditorValue(mergedOrigin)
              }
            } catch {}

            if (parseOverlay) {
              parseOverlay.close()
              parseOverlay = null
            }

            if (context.ui.showNotification) {
              if (loadingId && context.ui.hideNotification) {
                try {
                  context.ui.hideNotification(loadingId)
                } catch {}
                loadingId = null
              }
            } else {
              context.ui.notice(
                pdf2docText('正在翻译 PDF 内容...', 'Translating PDF content...'),
                'ok',
                3000
              )
            }

            const result = await translateMarkdownInBatches(
              ai,
              markdown,
              numericPages,
              (info) => {
                const from = info && typeof info.fromPage === 'number' ? info.fromPage : 0
                const to = info && typeof info.toPage === 'number' ? info.toPage : 0
                const batchIndex =
                  info && typeof info.batchIndex === 'number' ? info.batchIndex : 0
                const batchCount =
                  info && typeof info.batchCount === 'number' ? info.batchCount : 0

                const msgPages =
                  from && to
                    ? pdf2docText(
                        `正在翻译 PDF 第 ${from}-${to} 页（第 ${batchIndex + 1}/${batchCount} 批）...`,
                        `Translating PDF pages ${from}-${to} (batch ${batchIndex + 1}/${batchCount})...`
                      )
                    : pdf2docText(
                        `正在翻译 PDF 内容（第 ${batchIndex + 1}/${batchCount} 批）...`,
                        `Translating PDF content (batch ${batchIndex + 1}/${batchCount})...`
                      )

                if (context.ui.showNotification) {
                  if (loadingRef.id && context.ui.hideNotification) {
                    try {
                      context.ui.hideNotification(loadingRef.id)
                    } catch {}
                    loadingRef.id = null
                  }
                  try {
                    loadingRef.id = context.ui.showNotification(msgPages, {
                      type: 'info',
                      duration: 0
                    })
                  } catch {}
                } else {
                  context.ui.notice(msgPages, 'ok', 2000)
                }
              }
            )

            if (!result || !result.partial) {
              if (loadingId && context.ui.hideNotification) {
                try {
                  context.ui.hideNotification(loadingId)
                } catch {}
              }
              context.ui.notice(
                pdf2docText('翻译失败：未获取到结果', 'Translation failed: no result received'),
                'err',
                4000
              )
              return
            }

            const translation = result.text || result.partial

            if (loadingId && context.ui.hideNotification) {
              try {
                context.ui.hideNotification(loadingId)
              } catch {}
            }
            if (loadingRef.id && context.ui.hideNotification) {
              try {
                context.ui.hideNotification(loadingRef.id)
              } catch {}
            }

            // 将翻译结果同时保存为单独 Markdown 文件，默认放在当前文件所在目录
            try {
              const baseNameRaw = (fileName || 'document.pdf').replace(/\.pdf$/i, '')
              const transFileName = baseNameRaw + ' (PDF 翻译).md'
              if (typeof context.saveMarkdownToCurrentFolder === 'function') {
                try {
                  transSavedPath = await context.saveMarkdownToCurrentFolder({
                    fileName: transFileName,
                    content: translation,
                    onConflict: 'renameAuto'
                  })
                } catch {}
              }
            } catch {}

            // 当前不是 PDF 文件时，在文档末尾插入翻译结果；
            // 若当前是 PDF，则避免修改该文件内容，改为通过打开翻译文件查看。
            if (!isCurrentPdf) {
              const current = context.getEditorValue()
              const title = fileName
                ? pdf2docText('## PDF 翻译：' + fileName, '## PDF translation: ' + fileName)
                : pdf2docText('## PDF 中文翻译', '## PDF translation (Chinese)')
              const block =
                '\n\n---\n\n' + title + '\n\n' + translation + '\n'
              const merged = current ? current + block : block
              context.setEditorValue(merged)
            }

            if (result.completed) {
              const suffixPages = pages
                ? pdf2docText('（' + pages + ' 页）', ' (' + pages + ' pages)')
                : ''
              context.ui.notice(
                pdf2docText('PDF 翻译完成' + suffixPages, 'PDF translation completed' + suffixPages),
                'ok',
                5000
              )
            } else {
              const donePages =
                typeof result.translatedPages === 'number'
                  ? result.translatedPages
                  : ''
              const suffix = donePages
                ? pdf2docText('，已插入前 ' + donePages + ' 页的翻译', ', inserted translation for first ' + donePages + ' pages')
                : pdf2docText('，已插入部分翻译结果', ', inserted partial translation')
              context.ui.notice(
                pdf2docText('PDF 翻译过程中断', 'PDF translation interrupted') + suffix,
                'err',
                6000
              )
            }

            // 如果当前是 PDF 文件，则翻译完成后自动打开翻译后的 Markdown 文件，避免用户误改 PDF 源文件
            if (
              isCurrentPdf &&
              transSavedPath &&
              typeof context.openFileByPath === 'function'
            ) {
              try {
                await context.openFileByPath(transSavedPath)
              } catch {}
            }
          } catch (err) {
            if (isPdf2DocCancelledError(err)) {
              if (parseOverlay && typeof parseOverlay.cancelled === 'function') {
                parseOverlay.cancelled()
              }
              if (loadingId && context.ui.hideNotification) {
                try {
                  context.ui.hideNotification(loadingId)
                } catch {}
              }
              context.ui.notice(
                pdf2docText('已终止解析（已解析的内容会正常扣除页数）', 'Parsing cancelled (parsed content will still be billed)'),
                'info',
                4000
              )
              return
            }
            if (parseOverlay) {
              parseOverlay.fail(
                pdf2docText(
                  'PDF 解析失败：' + (err && err.message ? err.message : String(err)),
                  'PDF parse failed: ' + (err && err.message ? err.message : String(err))
                )
              )
            }
            if (loadingId && context.ui.hideNotification) {
              try {
                context.ui.hideNotification(loadingId)
              } catch {}
            }
            context.ui.notice(
              pdf2docText(
                'PDF 翻译失败：' + (err && err.message ? err.message : String(err)),
                'PDF translation failed: ' + (err && err.message ? err.message : String(err))
              ),
              'err',
              5000
            )
          }
        }
      }
    ]

    // 菜单顺序：按 order 升序（无 order 的放最后）
    try {
      pdf2docMenuChildren.sort((a, b) => {
        const ao = a && typeof a === 'object' ? a.order : null
        const bo = b && typeof b === 'object' ? b.order : null
        const av = typeof ao === 'number' ? ao : Number.POSITIVE_INFINITY
        const bv = typeof bo === 'number' ? bo : Number.POSITIVE_INFINITY
        return av - bv
      })
    } catch {}

    // 注册菜单项
    context.addMenuItem({
      label: pdf2docText('PDF / 图片高精度解析', 'PDF / Image High-Precision OCR'),
      title: pdf2docText(
        '解析 PDF 或图片为 Markdown 或 docx（图片仅支持 Markdown）',
        'Parse PDF or images into Markdown or DOCX (images only support Markdown).'
      ),
      children: pdf2docMenuChildren
    })

    // Ribbon 按钮：PDF 高精度解析（点击显示下拉菜单）
    if (context.addRibbonButton && context.showDropdownMenu) {
      try {
        context.addRibbonButton({
          icon: 'PDF',
          iconType: 'text',
          title: pdf2docText('PDF 高精度解析', 'PDF High-Precision OCR'),
          onClick: (ev) => {
            const btn = ev.currentTarget || ev.target
            context.showDropdownMenu(btn, pdf2docMenuChildren)
          }
        })
      } catch (e) { console.error('[pdf2doc] addRibbonButton failed', e) }
    }

  // 向其他插件暴露 API：按路径解析为 Markdown
  if (typeof context.registerAPI === 'function') {
    try {
      context.registerAPI('pdf2doc', {
        // path: 绝对路径（应为 .pdf 文件）
        // 返回 { ok, markdown, pages, uid?, format }
        parsePdfToMarkdownByPath: async (path) => {
          const p = String(path || '').trim()
          if (!p) {
            throw new Error(pdf2docText('path 不能为空', 'path cannot be empty'))
          }
          if (!/\.pdf$/i.test(p)) {
            throw new Error(pdf2docText('仅支持解析 .pdf 文件', 'Only .pdf files are supported'))
          }
          const cfg = await loadConfig(context)
          if (!hasAnyApiToken(cfg)) {
            throw new Error(pdf2docText('未配置 pdf2doc 密钥', 'PDF2Doc token is not configured'))
          }
          if (typeof context.readFileBinary !== 'function') {
            throw new Error(
              pdf2docText('当前版本不支持按路径读取二进制文件', 'This version cannot read binary files by path')
            )
          }
          const bytes = await context.readFileBinary(p)
          const fileName = p.split(/[\\/]+/).pop() || 'document.pdf'
          const result = await parsePdfBytes(context, cfg, bytes, fileName, 'markdown')
          if (result.format !== 'markdown' || !result.markdown) {
            throw new Error(
              pdf2docText('解析成功，但返回格式不是 Markdown', 'Parse succeeded but returned format is not Markdown')
            )
          }
          return result
        },
        // path: 绝对路径（应为图片文件：png/jpg/webp 等）
        // 返回 { ok, markdown, pages, uid?, format }
        parseImageToMarkdownByPath: async (path) => {
          const p = String(path || '').trim()
          if (!p) {
            throw new Error(pdf2docText('path 不能为空', 'path cannot be empty'))
          }
          if (!/\.(png|jpe?g|webp)$/i.test(p)) {
            throw new Error(
              pdf2docText('仅支持解析图片文件（png/jpg/webp）', 'Only image files (png/jpg/webp) are supported')
            )
          }
          const cfg = await loadConfig(context)
          if (!hasAnyApiToken(cfg)) {
            throw new Error(pdf2docText('未配置 pdf2doc 密钥', 'PDF2Doc token is not configured'))
          }
          if (typeof context.readFileBinary !== 'function') {
            throw new Error(
              pdf2docText('当前版本不支持按路径读取二进制文件', 'This version cannot read binary files by path')
            )
          }
          const bytes = await context.readFileBinary(p)
          const fileName = p.split(/[\\/]+/).pop() || 'image.jpg'
          const result = await parseImageBytes(context, cfg, bytes, fileName)
          if (result.format !== 'markdown' || !result.markdown) {
            throw new Error(
              pdf2docText('解析成功，但返回格式不是 Markdown', 'Parse succeeded but returned format is not Markdown')
            )
          }
          return result
        }
      })
    } catch (e) {
      // 注册失败不影响主流程
      // eslint-disable-next-line no-console
      console.error('[pdf2doc] registerAPI 失败', e)
    }
  }

}

export async function openSettings(context) {
  const cfg = await loadConfig(context)
  const nextCfg = await openSettingsDialog(context, cfg)
  if (!nextCfg) return
  await saveConfig(context, nextCfg)
  context.ui.notice(
    pdf2docText('pdf2doc 插件配置已保存', 'pdf2doc settings saved'),
    'ok'
  )
}

export function deactivate() {
  // 当前插件没有需要清理的全局资源，预留接口以便将来扩展
}
