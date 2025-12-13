// MinerU 解析插件（直接调用 MinerU 官方 API，不经过自建后端）
// 功能定位：
// - 支持选择本地 PDF / 图片文件，上传到 MinerU 解析
// - 支持对当前打开的 PDF / 图片文件发起解析
// - 解析结果以 MinerU 提供的 zip 下载链接形式返回（非高精度逐页 Markdown）
// - 用户自行在 zip 中使用 MinerU 默认导出的 markdown/json/docx 等文件

// 固定的 MinerU 接口（按官方文档写死）
const MINERU_BASE_URL = 'https://mineru.net'
const MINERU_FILE_URLS_BATCH = '/api/v4/file-urls/batch'
const MINERU_BATCH_RESULTS_PREFIX = '/api/v4/extract-results/batch/'

// 设置对话框样式 id
const MINERU_SETTINGS_STYLE_ID = 'mineru-settings-style'

// 轻量多语言：跟随宿主（flymd.locale），默认用系统语言
const MINERU_LOCALE_LS_KEY = 'flymd.locale'
function mineruDetectLocale() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    const lang = (nav && (nav.language || nav.userLanguage)) || 'en'
    const lower = String(lang || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
  } catch {}
  return 'en'
}
function mineruGetLocale() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null
    const v = ls && ls.getItem(MINERU_LOCALE_LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  return mineruDetectLocale()
}
function mineruText(zh, en) {
  return mineruGetLocale() === 'en' ? en : zh
}

// 读取配置：仅需要 Token 和模型版本
async function mineruLoadConfig(context) {
  const apiToken = (await context.storage.get('apiToken')) || ''
  const modelVersion = (await context.storage.get('modelVersion')) || 'vlm'
  return {
    apiToken,
    modelVersion
  }
}

// 保存配置
async function mineruSaveConfig(context, cfg) {
  await context.storage.set('apiToken', cfg.apiToken)
  await context.storage.set('modelVersion', cfg.modelVersion)
}

// 创建或更新设置样式
function mineruEnsureSettingsStyle() {
  if (typeof document === 'undefined') return
  let style = document.getElementById(MINERU_SETTINGS_STYLE_ID)
  if (style) return
  style = document.createElement('style')
  style.id = MINERU_SETTINGS_STYLE_ID
  style.textContent =
    '.mineru-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:90010;}' +
    '.mineru-dialog{width:420px;max-width:calc(100% - 40px);background:var(--bg,#fff);color:var(--fg,#111);border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,.3);border:1px solid var(--border,#e5e7eb);overflow:hidden;font-size:14px;}' +
    '.mineru-header{padding:14px 18px;border-bottom:1px solid var(--border,#e5e7eb);font-weight:600;font-size:15px;background:linear-gradient(135deg,#0f172a,#1d4ed8);color:#fff;display:flex;align-items:center;justify-content:space-between;}' +
    '.mineru-body{padding:16px 18px;max-height:65vh;overflow:auto;}' +
    '.mineru-footer{padding:10px 18px 14px;border-top:1px solid var(--border,#e5e7eb);text-align:right;}' +
    '.mineru-row{margin-bottom:12px;}' +
    '.mineru-row label{display:block;font-size:12px;color:#6b7280;margin-bottom:4px;}' +
    '.mineru-input{width:100%;box-sizing:border-box;font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#d1d5db);background:var(--bg,#fff);color:inherit;}' +
    '.mineru-input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 1px rgba(37,99,235,.3);}' +
    '.mineru-tip{font-size:12px;color:#6b7280;margin-top:4px;line-height:1.5;}' +
    '.mineru-footer button{min-width:80px;font-size:13px;padding:6px 12px;border-radius:6px;border:none;cursor:pointer;margin-left:8px;}' +
    '.mineru-btn-primary{background:#2563eb;color:#fff;}' +
    '.mineru-btn-secondary{background:#e5e7eb;color:#111;}' +
    '.mineru-footer button:disabled{opacity:.6;cursor:not-allowed;}'
  document.head.appendChild(style)
}

// 打开设置窗口：只配置 Token 和模型版本
async function mineruOpenSettingsDialog(context, cfg) {
  if (typeof document === 'undefined') return null
  mineruEnsureSettingsStyle()

  return await new Promise(function (resolve) {
    const overlay = document.createElement('div')
    overlay.className = 'mineru-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'mineru-dialog'

    const header = document.createElement('div')
    header.className = 'mineru-header'
    const title = document.createElement('div')
    title.textContent = mineruText('MinerU 解析 - 设置', 'MinerU Parser - Settings')
    const closeBtn = document.createElement('button')
    closeBtn.textContent = '×'
    closeBtn.style.cssText =
      'background:transparent;border:none;color:inherit;font-size:18px;cursor:pointer;padding:0 4px;margin:0;'
    header.appendChild(title)
    header.appendChild(closeBtn)

    const body = document.createElement('div')
    body.className = 'mineru-body'

    // Token
    const rowToken = document.createElement('div')
    rowToken.className = 'mineru-row'
    const labelToken = document.createElement('label')
    labelToken.textContent = 'API Token'
    const inputToken = document.createElement('input')
    inputToken.className = 'mineru-input'
    inputToken.type = 'password'
    inputToken.value = cfg.apiToken || ''
    inputToken.placeholder = mineruText('在 MinerU 官网申请的 API Token', 'API token obtained from MinerU official site')
    const tipToken = document.createElement('div')
    tipToken.className = 'mineru-tip'
    tipToken.textContent = mineruText(
      '调用所有 v4 接口都需要在请求头中携带 Authorization: Bearer <Token>',
      'All v4 endpoints require Authorization: Bearer <Token> in the request headers.'
    )
    rowToken.appendChild(labelToken)
    rowToken.appendChild(inputToken)
    rowToken.appendChild(tipToken)

    // 模型版本
    const rowModel = document.createElement('div')
    rowModel.className = 'mineru-row'
    const labelModel = document.createElement('label')
    labelModel.textContent = mineruText('模型版本（model_version）', 'Model version (model_version)')
    const inputModel = document.createElement('input')
    inputModel.className = 'mineru-input'
    inputModel.value = cfg.modelVersion || 'vlm'
    inputModel.placeholder = mineruText('例如：vlm 或 pipeline，默认 vlm', 'e.g. vlm or pipeline, default is vlm')
    const tipModel = document.createElement('div')
    tipModel.className = 'mineru-tip'
    tipModel.textContent = mineruText(
      'MinerU 当前文档模型版本：pipeline / vlm，推荐使用默认值即可',
      'MinerU document models: pipeline / vlm. Using the default is recommended.'
    )
    rowModel.appendChild(labelModel)
    rowModel.appendChild(inputModel)
    rowModel.appendChild(tipModel)

    const rowInfo = document.createElement('div')
    rowInfo.className = 'mineru-row'
    const tipInfo = document.createElement('div')
    tipInfo.className = 'mineru-tip'
    tipInfo.innerHTML = mineruText(
      '说明：本插件通过 MinerU 的批量上传接口 <code>/api/v4/file-urls/batch</code> 申请上传链接并上传本地文件，' +
        '再通过 <code>/api/v4/extract-results/batch/{batch_id}</code> 轮询解析结果，最终返回一个结果 zip 下载链接。',
      'Note: this plugin calls MinerU\'s batch upload API <code>/api/v4/file-urls/batch</code> to obtain an upload URL,' +
        ' then polls <code>/api/v4/extract-results/batch/{batch_id}</code> for results, finally returning a result ZIP link.'
    )
    rowInfo.appendChild(tipInfo)

    body.appendChild(rowToken)
    body.appendChild(rowModel)
    body.appendChild(rowInfo)

    const footer = document.createElement('div')
    footer.className = 'mineru-footer'

    const btnCancel = document.createElement('button')
    btnCancel.className = 'mineru-btn-secondary'
    btnCancel.textContent = mineruText('取消', 'Cancel')

    const btnOk = document.createElement('button')
    btnOk.className = 'mineru-btn-primary'
    btnOk.textContent = mineruText('保存', 'Save')

    footer.appendChild(btnCancel)
    footer.appendChild(btnOk)

    dialog.appendChild(header)
    dialog.appendChild(body)
    dialog.appendChild(footer)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    function close(v) {
      try {
        overlay.remove()
      } catch (e) {}
      resolve(v)
    }

    closeBtn.onclick = function () {
      close(null)
    }
    btnCancel.onclick = function () {
      close(null)
    }
    overlay.onclick = function (e) {
      if (e.target === overlay) close(null)
    }

    btnOk.onclick = function () {
      const next = {
        apiToken: inputToken.value.trim(),
        modelVersion: inputModel.value.trim() || 'vlm'
      }
      close(next)
    }
  })
}

// 选择本地文件（PDF / 图片）
function mineruPickFile() {
  return new Promise(function (resolve, reject) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/pdf,image/*'
    input.style.display = 'none'

    input.onchange = function () {
      const file = input.files && input.files[0]
      if (!file) {
        reject(new Error(mineruText('未选择文件', 'No file selected')))
      } else {
        resolve(file)
      }
      input.remove()
    }

    try {
      document.body.appendChild(input)
    } catch (e) {}

    input.click()
  })
}

// 将字节数组转换为 File（用于当前文件场景）
function mineruBytesToFile(bytes, name, mime) {
  const arr =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes || [])
  const blob = new Blob([arr], { type: mime || 'application/octet-stream' })
  const safeName = name && typeof name === 'string' && name.trim() ? name.trim() : 'document.bin'
  try {
    return new File([blob], safeName, { type: blob.type })
  } catch (e) {
    // 旧环境不支持 File 构造函数时退化为 Blob，但 MinerU 上传 PUT 不依赖文件名
    return blob
  }
}

// 请求 MinerU 批量上传接口，申请上传链接
async function mineruApplyUploadUrl(context, cfg, fileName) {
  const http = context.http
  if (!http || typeof http.fetch !== 'function') {
    throw new Error(mineruText('当前环境不支持 HTTP 请求', 'HTTP requests are not supported in this environment'))
  }
  if (!cfg.apiToken) {
    throw new Error(mineruText('未配置 MinerU API Token', 'MinerU API token is not configured'))
  }

  const url = MINERU_BASE_URL + MINERU_FILE_URLS_BATCH

  const body = {
    files: [{ name: fileName || 'document.pdf', data_id: '' }],
    model_version: cfg.modelVersion || 'vlm'
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + cfg.apiToken
  }

  let res
  try {
    res = await http.fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    })
  } catch (e) {
    throw new Error(
      mineruText(
        '申请 MinerU 上传链接失败：' + (e && e.message ? e.message : String(e)),
        'Failed to request MinerU upload URL: ' + (e && e.message ? e.message : String(e))
      )
    )
  }

  let data
  try {
    data = await res.json()
  } catch (e) {
    throw new Error(
      mineruText(
        '解析 MinerU 上传链接响应失败：HTTP ' +
          res.status +
          '，' +
          (e && e.message ? e.message : String(e)),
        'Failed to parse MinerU upload response: HTTP ' +
          res.status +
          ', ' +
          (e && e.message ? e.message : String(e))
      )
    )
  }

  if (!data || typeof data !== 'object') {
    throw new Error(mineruText('MinerU 上传链接响应格式错误', 'MinerU upload response has invalid format'))
  }
  if (data.code !== 0) {
    throw new Error(
      mineruText(
        '申请上传链接失败：' + (data.msg || '未知错误'),
        'Failed to request upload URL: ' + (data.msg || 'unknown error')
      )
    )
  }

  const d = data.data || {}
  const batchId = d.batch_id || d.batchId
  const urls = d.file_urls || d.files || []
  const uploadUrl = urls && urls.length > 0 ? urls[0] : null

  if (!batchId || !uploadUrl) {
    throw new Error(
      mineruText('MinerU 返回的上传链接信息不完整', 'MinerU returned incomplete upload URL information')
    )
  }

  return {
    batchId: batchId,
    uploadUrl: uploadUrl
  }
}

// 上传文件到 MinerU 提供的临时 URL（PUT）
async function mineruUploadFileToUrl(context, file, uploadUrl) {
  const http = context.http
  if (!http || typeof http.fetch !== 'function') {
    throw new Error(mineruText('当前环境不支持 HTTP 请求', 'HTTP requests are not supported in this environment'))
  }

  // 根据 MinerU 文档，上传时“无须设置 Content-Type”，
  // 某些存储的签名 URL 对 Content-Type 敏感，因此这里显式避免设置该头，
  // 并使用裸的二进制数据作为请求体。
  let body = file
  try {
    if (file && typeof file.arrayBuffer === 'function') {
      const buf = await file.arrayBuffer()
      body = new Uint8Array(buf)
    }
  } catch (e) {
    // 读取失败时退化为原始对象
    body = file
  }

  let res
  try {
    res = await http.fetch(uploadUrl, {
      method: 'PUT',
      body: body
    })
  } catch (e) {
    throw new Error(
      mineruText(
        '上传文件到 MinerU 失败：' + (e && e.message ? e.message : String(e)),
        'Failed to upload file to MinerU: ' + (e && e.message ? e.message : String(e))
      )
    )
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      mineruText(
        '上传文件到 MinerU 失败：HTTP ' + res.status,
        'Failed to upload file to MinerU: HTTP ' + res.status
      )
    )
  }
}

// 轮询批量结果接口，直到完成或失败
async function mineruWaitBatchResult(context, cfg, batchId) {
  const http = context.http
  if (!http || typeof http.fetch !== 'function') {
    throw new Error(mineruText('当前环境不支持 HTTP 请求', 'HTTP requests are not supported in this environment'))
  }

  const url = MINERU_BASE_URL + MINERU_BATCH_RESULTS_PREFIX + encodeURIComponent(batchId)

  const headers = {
    Authorization: 'Bearer ' + cfg.apiToken,
    Accept: 'application/json'
  }

  const maxTries = 40 // 最多轮询 40 次
  const intervalMs = 3000

  let lastState = ''
  let lastErr = ''

  for (let i = 0; i < maxTries; i++) {
    let res
    try {
      res = await http.fetch(url, { method: 'GET', headers: headers })
    } catch (e) {
      lastErr =
        mineruText(
          '查询 MinerU 解析结果失败：' + (e && e.message ? e.message : String(e)),
          'Failed to query MinerU result: ' + (e && e.message ? e.message : String(e))
        )
      await new Promise(function (r) {
        setTimeout(r, intervalMs)
      })
      continue
    }

    let data
    try {
      data = await res.json()
    } catch (e) {
      lastErr = mineruText(
        '解析 MinerU 结果响应失败：HTTP ' +
          res.status +
          '，' +
          (e && e.message ? e.message : String(e)),
        'Failed to parse MinerU result response: HTTP ' +
          res.status +
          ', ' +
          (e && e.message ? e.message : String(e))
      )
      await new Promise(function (r) {
        setTimeout(r, intervalMs)
      })
      continue
    }

    if (!data || typeof data !== 'object') {
      lastErr = mineruText('MinerU 结果响应格式错误', 'MinerU result response has invalid format')
      await new Promise(function (r) {
        setTimeout(r, intervalMs)
      })
      continue
    }

    if (data.code !== 0) {
      lastErr = mineruText(
        '查询 MinerU 解析结果失败：' + (data.msg || '未知错误'),
        'Failed to query MinerU result: ' + (data.msg || 'unknown error')
      )
      await new Promise(function (r) {
        setTimeout(r, intervalMs)
      })
      continue
    }

    const d = data.data || {}
    const list = d.extract_result || d.extract_results || []
    const results = Array.isArray(list) ? list : list ? [list] : []
    const first = results[0]

    if (!first) {
      lastErr = mineruText('MinerU 返回结果为空', 'MinerU returned empty result')
      await new Promise(function (r) {
        setTimeout(r, intervalMs)
      })
      continue
    }

    const state = String(first.state || '').toLowerCase()
    lastState = state
    lastErr = first.err_msg || first.errMsg || ''

    if (state === 'done') {
      const fullZipUrl = first.full_zip_url || first.fullZipUrl || ''
      return {
        state: 'done',
        fullZipUrl: fullZipUrl
      }
    }

    if (state === 'failed') {
      throw new Error(
        mineruText('MinerU 解析失败：' + (lastErr || '未知错误'), 'MinerU parsing failed: ' + (lastErr || 'unknown error'))
      )
    }

    // waiting-file / pending / running 等状态继续轮询
    await new Promise(function (r) {
      setTimeout(r, intervalMs)
    })
  }

  throw new Error(
    mineruText(
      'MinerU 解析超时，最后状态：' + (lastState || '未知') + (lastErr ? '，原因：' + lastErr : ''),
      'MinerU parsing timed out, last state: ' +
        (lastState || 'unknown') +
        (lastErr ? ', reason: ' + lastErr : '')
    )
  )
}

// 结果 zip 下载对话框（参考 pdf2doc 的 docx 处理方式）
function showMineruZipDownloadDialog(zipUrl, fileName) {
  if (typeof document === 'undefined') return
  const overlay = document.createElement('div')
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:90020;'

  const dialog = document.createElement('div')
  dialog.style.cssText =
    'width:460px;max-width:calc(100% - 40px);background:var(--bg,#fff);color:var(--fg,#333);border-radius:12px;border:1px solid var(--border,#e5e7eb);box-shadow:0 20px 50px rgba(0,0,0,.3);overflow:hidden;'

  const header = document.createElement('div')
  header.style.cssText =
    'padding:16px 20px;border-bottom:1px solid var(--border,#e5e7eb);font-weight:600;font-size:16px;background:linear-gradient(135deg,#0f172a,#1d4ed8);color:#fff;display:flex;align-items:center;justify-content:space-between;'
  header.textContent = mineruText('MinerU 结果压缩包已生成', 'MinerU result ZIP is ready')
  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cssText =
    'background:transparent;border:none;color:inherit;font-size:18px;cursor:pointer;padding:0 4px;margin:0;'
  closeBtn.onclick = function () {
    try {
      document.body.removeChild(overlay)
    } catch (e) {}
  }
  header.appendChild(closeBtn)

  const body = document.createElement('div')
  body.style.cssText = 'padding:20px;'

  const message = document.createElement('div')
  message.style.cssText =
    'font-size:14px;color:var(--fg,#555);margin-bottom:16px;line-height:1.6;'
  message.innerHTML = mineruText(
    'MinerU 已完成解析，并生成结果压缩包。你可以直接下载，或复制链接到浏览器中打开。',
    'MinerU has finished parsing and generated a result ZIP. You can download it directly or copy the link to open in your browser.'
  )

  const linkDisplay = document.createElement('div')
  linkDisplay.style.cssText =
    'background:var(--bg-muted,#f9fafb);border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:12px;color:var(--muted,#6b7280);word-break:break-all;max-height:90px;overflow-y:auto;'
  linkDisplay.textContent = zipUrl

  const buttonContainer = document.createElement('div')
  buttonContainer.style.cssText =
    'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:4px;'

  const downloadBtn = document.createElement('button')
  downloadBtn.style.cssText =
    'padding:10px 16px;border-radius:8px;border:none;background:linear-gradient(135deg,#2563eb 0%,#1d4ed8 100%);color:#fff;cursor:pointer;font-size:14px;font-weight:500;transition:transform 0.2s;'
  downloadBtn.textContent = mineruText('🔽 下载压缩包', '🔽 Download ZIP')
  downloadBtn.onmouseover = function () {
    downloadBtn.style.transform = 'translateY(-2px)'
  }
  downloadBtn.onmouseout = function () {
    downloadBtn.style.transform = 'translateY(0)'
  }
  downloadBtn.onclick = function () {
    try {
      const a = document.createElement('a')
      a.href = zipUrl
      if (fileName) a.download = fileName
      a.target = '_blank'
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      setTimeout(function () {
        try {
          document.body.removeChild(a)
        } catch (e) {}
      }, 100)
    } catch (e) {
      downloadBtn.textContent = mineruText('❌ 下载失败', '❌ Download failed')
      downloadBtn.style.background = '#ef4444'
    }
  }

  const copyBtn = document.createElement('button')
  copyBtn.style.cssText =
    'padding:10px 16px;border-radius:8px;border:1px solid var(--border,#d1d5db);background:var(--bg,#fff);color:var(--fg,#333);cursor:pointer;font-size:14px;font-weight:500;transition:all 0.2s;'
  copyBtn.textContent = mineruText('📋 复制链接', '📋 Copy link')
  copyBtn.onmouseover = function () {
    copyBtn.style.background = 'var(--bg-muted,#f9fafb)'
    copyBtn.style.transform = 'translateY(-2px)'
  }
  copyBtn.onmouseout = function () {
    copyBtn.style.background = 'var(--bg,#fff)'
    copyBtn.style.transform = 'translateY(0)'
  }
  copyBtn.onclick = function () {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(zipUrl)
      } else {
        const ta = document.createElement('textarea')
        ta.value = zipUrl
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        try {
          document.execCommand('copy')
        } catch (e) {}
        document.body.removeChild(ta)
      }
      copyBtn.textContent = mineruText('✅ 已复制', '✅ Copied')
      setTimeout(function () {
        copyBtn.textContent = mineruText('📋 复制链接', '📋 Copy link')
      }, 2000)
    } catch (e) {
      copyBtn.textContent = mineruText('❌ 复制失败', '❌ Copy failed')
      copyBtn.style.borderColor = '#ef4444'
      copyBtn.style.color = '#ef4444'
    }
  }

  buttonContainer.appendChild(downloadBtn)
  buttonContainer.appendChild(copyBtn)

  body.appendChild(message)
  body.appendChild(linkDisplay)
  body.appendChild(buttonContainer)

  dialog.appendChild(header)
  dialog.appendChild(body)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
}

// 主流程：上传本地文件并等待 MinerU 解析完成，返回 full_zip_url
async function mineruParseLocalFile(context, cfg, file, sourceLabel) {
  const name = (file && file.name) || 'document'

  const stepLabel = sourceLabel || mineruText('文件', 'file')

  let notifyId = null
  try {
    if (context.ui && context.ui.showNotification) {
      notifyId = context.ui.showNotification(mineruText('MinerU：正在申请上传链接（' + stepLabel + '）...', 'MinerU: requesting upload URL (' + stepLabel + ')...'), {
        type: 'info',
        duration: 0
      })
    } else if (context.ui && context.ui.notice) {
      context.ui.notice(mineruText('MinerU：正在申请上传链接（' + stepLabel + '）...', 'MinerU: requesting upload URL (' + stepLabel + ')...'), 'ok', 2500)
    }

    const applied = await mineruApplyUploadUrl(context, cfg, name)

    if (notifyId && context.ui && context.ui.showNotification) {
      try {
        context.ui.hideNotification(notifyId)
      } catch (e) {}
    }

    if (context.ui && context.ui.showNotification) {
      notifyId = context.ui.showNotification(mineruText('MinerU：正在上传文件...', 'MinerU: uploading file...'), {
        type: 'info',
        duration: 0
      })
    } else if (context.ui && context.ui.notice) {
      context.ui.notice(mineruText('MinerU：正在上传文件...', 'MinerU: uploading file...'), 'ok', 2500)
    }

    await mineruUploadFileToUrl(context, file, applied.uploadUrl)

    if (notifyId && context.ui && context.ui.showNotification) {
      try {
        context.ui.hideNotification(notifyId)
      } catch (e) {}
    }

    if (context.ui && context.ui.showNotification) {
      notifyId = context.ui.showNotification(mineruText('MinerU：正在解析，请稍候...', 'MinerU: parsing, please wait...'), {
        type: 'info',
        duration: 0
      })
    } else if (context.ui && context.ui.notice) {
      context.ui.notice(mineruText('MinerU：正在解析，请稍候...', 'MinerU: parsing, please wait...'), 'ok', 2500)
    }

    const result = await mineruWaitBatchResult(context, cfg, applied.batchId)

    if (notifyId && context.ui && context.ui.showNotification) {
      try {
        context.ui.hideNotification(notifyId)
      } catch (e) {}
    }

    const fullZipUrl = result.fullZipUrl || ''
    if (!fullZipUrl) {
      throw new Error(
        mineruText('解析完成但未返回结果压缩包地址', 'Parsing finished but no result ZIP URL was returned')
      )
    }

    // 尝试使用隐藏 a 标签自动触发下载
    let autoDownloadOk = false
    const baseName = String(name || 'result').replace(/\\.[^\\.]+$/, '')
    const zipName = baseName + '.zip'
    if (typeof document !== 'undefined') {
      try {
        const a = document.createElement('a')
        a.href = fullZipUrl
        a.download = zipName
        a.target = '_blank'
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        setTimeout(function () {
          try {
            document.body.removeChild(a)
          } catch (e) {}
        }, 100)
        autoDownloadOk = true
      } catch (e) {
        autoDownloadOk = false
      }
    }

    if (!autoDownloadOk) {
      showMineruZipDownloadDialog(fullZipUrl, zipName)
    }

    if (context.ui && context.ui.notice) {
      context.ui.notice(
        mineruText(
          'MinerU 解析完成，结果压缩包下载已开始：' + zipName,
          'MinerU parsing finished; ZIP download started: ' + zipName
        ),
        'ok',
        6000
      )
    }
  } catch (err) {
    if (notifyId && context.ui && context.ui.showNotification) {
      try {
        context.ui.hideNotification(notifyId)
      } catch (e) {}
    }
    const msg = err && err.message ? err.message : String(err)
    if (context.ui && context.ui.notice) {
      context.ui.notice(
        mineruText('MinerU 解析失败：' + msg, 'MinerU parsing failed: ' + msg),
        'err',
        6000
      )
    }
  }
}

export async function activate(context) {
  // 启动时简单检查配置
  try {
    const cfg = await mineruLoadConfig(context)
    if (!cfg.apiToken) {
      if (context.ui && context.ui.notice) {
        context.ui.notice(
          mineruText(
            'MinerU 插件未配置 Token，请先在设置中填写 API Token',
            'MinerU plugin has no token configured; please set the API token in settings.'
          ),
          'err',
          5000
        )
      }
    }
  } catch (e) {}

  if (typeof context.addMenuItem === 'function') {
    context.addMenuItem({
      label: mineruText('📂 MinerU PDF/图片解析', '📂 MinerU PDF/Image Parser'),
      title: mineruText(
        '使用 MinerU 官方 API 解析本地 PDF / 图片（非高精度逐页解析，返回结果 zip）',
        'Use the official MinerU API to parse local PDF/images (non per-page high-precision, returns result ZIP).'
      ),
      children: [
        {
          label: mineruText('选择文件', 'Choose file'),
          onClick: async function () {
            const cfg = await mineruLoadConfig(context)
            if (!cfg.apiToken) {
              context.ui.notice(
                mineruText('请先在 MinerU 设置中填写 API Token', 'Please set MinerU API token in settings first'),
                'err',
                5000
              )
              return
            }
            let file
            try {
              file = await mineruPickFile()
            } catch (e) {
              const msg = e && e.message ? e.message : String(e)
              context.ui.notice(
                mineruText('选择文件失败：' + msg, 'Failed to choose file: ' + msg),
                'err',
                4000
              )
              return
            }
            await mineruParseLocalFile(context, cfg, file, mineruText('选择文件', 'chosen file'))
          }
        },
        {
          label: mineruText('解析当前', 'Parse current file'),
          onClick: async function () {
            const cfg = await mineruLoadConfig(context)
            if (!cfg.apiToken) {
              context.ui.notice(
                mineruText('请先在 MinerU 设置中填写 API Token', 'Please set MinerU API token in settings first'),
                'err',
                5000
              )
              return
            }
            if (
              typeof context.getCurrentFilePath !== 'function' ||
              typeof context.readFileBinary !== 'function'
            ) {
              context.ui.notice(
                mineruText('当前环境不支持按路径读取当前文件', 'Current environment cannot read current file by path'),
                'err',
                4000
              )
              return
            }
            const path = context.getCurrentFilePath()
            if (!path) {
              context.ui.notice(
                mineruText('当前没有打开任何文件', 'No file is currently open'),
                'err',
                4000
              )
              return
            }
            const lower = String(path).toLowerCase()
            const isSupported =
              lower.endsWith('.pdf') ||
              lower.endsWith('.png') ||
              lower.endsWith('.jpg') ||
              lower.endsWith('.jpeg')
            if (!isSupported) {
              context.ui.notice(
                mineruText('当前文件不是支持的 PDF/图片 类型', 'Current file is not a supported PDF/image type'),
                'err',
                4000
              )
              return
            }
            let bytes
            try {
              bytes = await context.readFileBinary(path)
            } catch (e) {
              const msg = e && e.message ? e.message : String(e)
              context.ui.notice(
                mineruText('读取当前文件失败：' + msg, 'Failed to read current file: ' + msg),
                'err',
                4000
              )
              return
            }
            const fileName = path.split(/[\\/]+/).pop() || 'document.pdf'
            const mime = lower.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'
            const file = mineruBytesToFile(bytes, fileName, mime)
            await mineruParseLocalFile(context, cfg, file, mineruText('当前文件', 'current file'))
          }
        }
      ]
    })
  }
}

export async function openSettings(context) {
  const cfg = await mineruLoadConfig(context)
  const next = await mineruOpenSettingsDialog(context, cfg)
  if (!next) return
  await mineruSaveConfig(context, next)
  if (context.ui && context.ui.notice) {
    context.ui.notice(mineruText('MinerU 配置已保存', 'MinerU settings saved'), 'ok')
  }
}

export function deactivate() {
  // 当前插件没有需要清理的全局资源，预留接口
}
