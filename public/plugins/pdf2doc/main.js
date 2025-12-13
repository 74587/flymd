// PDF 解析插件（pdf2doc）

// 默认后端 API 根地址
const DEFAULT_API_BASE = 'https://flymd.llingfei.com/pdf/'
const PDF2DOC_STYLE_ID = 'pdf2doc-settings-style'

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


async function loadConfig(context) {
  const apiBaseUrl =
    (await context.storage.get('apiBaseUrl')) || DEFAULT_API_BASE
  const apiToken = (await context.storage.get('apiToken')) || ''
  const defaultOutput = (await context.storage.get('defaultOutput')) || 'markdown'
  const sendToAI = await context.storage.get('sendToAI')
  return {
    apiBaseUrl,
    apiToken,
    defaultOutput: defaultOutput === 'docx' ? 'docx' : 'markdown',
    sendToAI: sendToAI ?? true
  }
}


async function saveConfig(context, cfg) {
  await context.storage.set('apiBaseUrl', cfg.apiBaseUrl)
  await context.storage.set('apiToken', cfg.apiToken)
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


async function uploadAndParsePdfFile(context, cfg, file, output) {
  let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()
  
  if (apiUrl.endsWith('/pdf')) {
    apiUrl += '/'
  }

  const form = new FormData()
  form.append('file', file, file.name)
  const out = output === 'docx' ? 'docx' : (output === 'markdown' ? 'markdown' : (cfg.defaultOutput === 'docx' ? 'docx' : 'markdown'))
  form.append('output', out)

  const headers = {}
  if (cfg.apiToken) {
    headers['Authorization'] = 'Bearer ' + cfg.apiToken
  }

  let res
  try {
    res = await context.http.fetch(apiUrl, {
      method: 'POST',
      headers,
      body: form
    })
  } catch (e) {
    throw new Error(
      pdf2docText(
        '网络请求失败：' + (e && e.message ? e.message : String(e)),
        'Network request failed: ' + (e && e.message ? e.message : String(e))
      )
    )
  }

  let data = null
  try {
    data = await res.json()
  } catch (e) {
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
    throw new Error(pdf2docText(msgZh, msgEn))
  }

  return data // { ok, format, markdown?, docx_url?, pages, uid }
}

// 上传并解析图片文件，仅支持输出 Markdown
async function uploadAndParseImageFile(context, cfg, file) {
  let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()

  if (apiUrl.endsWith('/pdf')) {
    apiUrl += '/'
  }

  const form = new FormData()
  form.append('file', file, file.name)
  form.append('output', 'markdown')

  const headers = {}
  if (cfg.apiToken) {
    headers['Authorization'] = 'Bearer ' + cfg.apiToken
  }

  let res
  try {
    res = await context.http.fetch(apiUrl, {
      method: 'POST',
      headers,
      body: form
    })
  } catch (e) {
    throw new Error(
      pdf2docText(
        '网络请求失败：' + (e && e.message ? e.message : String(e)),
        'Network request failed: ' + (e && e.message ? e.message : String(e))
      )
    )
  }

  let data = null
  try {
    data = await res.json()
  } catch (e) {
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
    throw new Error(pdf2docText(msgZh, msgEn))
  }

  if (data.format !== 'markdown' || !data.markdown) {
    throw new Error(
      pdf2docText('解析成功，但返回格式不是 Markdown', 'Parse succeeded but returned format is not Markdown')
    )
  }

  return data // { ok, format: 'markdown', markdown, pages, uid }
}


async function parsePdfBytes(context, cfg, bytes, filename, output) {
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
    return await uploadAndParsePdfFile(context, cfg, file, output)
  }

// 解析图片二进制为 Markdown
async function parseImageBytes(context, cfg, bytes, filename) {
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
  return await uploadAndParseImageFile(context, cfg, file)
}

// 将 Markdown 中的远程图片下载到当前文档目录并改写为本地相对路径
// 依赖宿主提供的 context.downloadFileToCurrentFolder 能力；如果不可用则直接返回原文
async function localizeMarkdownImages(context, markdown, opt) {
  const text = typeof markdown === 'string' ? markdown : ''
  if (!text) return text
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
  let index = 0

  for (const [url] of urlMap.entries()) {
    if (index >= maxImages) break
    index += 1

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
    quotaLabel.textContent = pdf2docText('当前剩余可用解析页数：', 'Remaining parse pages: ')
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
        const res = await context.http.fetch(apiUrl, {
          method: 'GET',
          headers: {
            Authorization: 'Bearer ' + (cfg.apiToken || '')
          }
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
    '.pdf2doc-settings-order-btn:hover{background:#1d4ed8;border-color:#1d4ed8;}'
  ].join('\n')
  const style = document.createElement('style')
  style.id = PDF2DOC_STYLE_ID
  style.textContent = css
    document.head.appendChild(style)
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

    
  const rowToken = document.createElement('div')
  rowToken.className = 'pdf2doc-settings-row'
  const labToken = document.createElement('div')
  labToken.className = 'pdf2doc-settings-label'
  labToken.textContent = pdf2docText('密钥', 'Token')
  const boxToken = document.createElement('div')
    const inputToken = document.createElement('input')
    inputToken.type = 'text'
    inputToken.className = 'pdf2doc-settings-input'
  
  inputToken.placeholder = ''
  inputToken.value = cfg.apiToken || ''
      boxToken.appendChild(inputToken)
      const tipToken = document.createElement('div')
      tipToken.className = 'pdf2doc-settings-desc'
      tipToken.textContent = pdf2docText(
        '务必牢记密钥，丢失后可通过我的订单找回',
        'Keep this token safe; if you lose it, you can retrieve it from the order page.'
      )
      boxToken.appendChild(tipToken)

      const quotaInfo = document.createElement('div')
      quotaInfo.className = 'pdf2doc-settings-desc'
      quotaInfo.textContent = ''

      const btnQuota = document.createElement('button')
      btnQuota.type = 'button'
      btnQuota.className = 'pdf2doc-settings-btn'
      btnQuota.textContent = pdf2docText('查询剩余页数', 'Check remaining pages')
      btnQuota.style.marginTop = '6px'
      boxToken.appendChild(btnQuota)
      boxToken.appendChild(quotaInfo)
    
    inputToken.addEventListener('input', () => {
      quotaInfo.textContent = ''
    })

    rowToken.appendChild(labToken)
  rowToken.appendChild(boxToken)
  body.appendChild(rowToken)

   
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
      '⚠️请及时保存文档！重复解析也会扣除剩余页数。解析为Markdown后可另存为Docx',
      '⚠️ Save your documents in time! Re-parsing also consumes pages. After parsing to Markdown you can export to DOCX.'
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
      const apiToken = inputToken.value.trim()
      const defaultOutput =
        outSelect.value === 'docx' ? 'docx' : 'markdown'

      document.body.removeChild(overlay)
      resolve({
        apiBaseUrl: DEFAULT_API_BASE,
        apiToken,
        defaultOutput,
        sendToAI: cfg.sendToAI ?? true
      })
    })

    
    const fetchQuota = async () => {
      
      quotaInfo.textContent = ''

      const username = inputToken.value.trim()
      if (!username) {
        quotaInfo.textContent = pdf2docText('请先填写密钥', 'Please enter the token first')
        return
      }

      quotaInfo.textContent = pdf2docText('正在查询剩余页数...', 'Checking remaining pages...')

      let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()
      if (apiUrl.endsWith('/pdf')) {
        apiUrl += '/'
      }

      try {
        const res = await context.http.fetch(apiUrl, {
          method: 'GET',
          headers: {
            Authorization: 'Bearer ' + username
          }
        })

        const text = await res.text()

        
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch (parseErr) {
          quotaInfo.textContent = pdf2docText('查询失败：服务器响应格式错误', 'Query failed: invalid server response')
          return
        }

        
        if (res.status < 200 || res.status >= 300) {
          const msg =
            (data && (data.message || data.error)) ||
            text ||
            pdf2docText('请求失败（HTTP ' + res.status + '）', 'Request failed (HTTP ' + res.status + ')')
          quotaInfo.textContent = pdf2docText('查询失败：', 'Query failed: ') + msg
          return
        }

        
        if (!data || data.ok !== true) {
          const msg = (data && (data.message || data.error)) || pdf2docText('服务器返回错误', 'Server returned an error')
          quotaInfo.textContent = pdf2docText('查询失败：', 'Query failed: ') + msg
          return
        }

        
        const total = data.total_pages ?? 0
        const used = data.used_pages ?? 0
        const remain = data.remain_pages ?? Math.max(0, total - used)

        quotaInfo.textContent = pdf2docText(
          '当前剩余页数：' + remain + '（总 ' + total + ' 页，已用 ' + used + ' 页）',
          'Remaining pages: ' + remain + ' (total ' + total + ', used ' + used + ')'
        )

      } catch (e) {
        const msg = e && e.message ? e.message : String(e || pdf2docText('未知错误', 'unknown error'))
        quotaInfo.textContent = pdf2docText('查询失败：', 'Query failed: ') + msg
      }
    }
    btnQuota.addEventListener('click', fetchQuota)

    document.body.appendChild(overlay)

    
    if (cfg.apiToken) {
      fetchQuota()
    }
  })
}

export async function activate(context) {
  
  ;(async () => {
    try {
      const cfg = await loadConfig(context)
      if (!cfg.apiToken) {
        return // 未配置密钥，静默跳过
      }

      let apiUrl = (cfg.apiBaseUrl || DEFAULT_API_BASE).trim()
      if (apiUrl.endsWith('/pdf')) {
        apiUrl += '/'
      }

      const res = await context.http.fetch(apiUrl, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + cfg.apiToken
        }
      })

      const text = await res.text()
      const data = text ? JSON.parse(text) : null

      if (res.status >= 200 && res.status < 300 && data && data.ok === true) {
        const total = data.total_pages ?? 0
        const used = data.used_pages ?? 0
        const remain = data.remain_pages ?? Math.max(0, total - used)

        context.ui.notice(
          pdf2docText(
            'PDF2Doc 剩余页数：' + remain + ' 页（总 ' + total + ' 页）',
            'PDF2Doc remaining pages: ' + remain + ' (total ' + total + ')'
          ),
          'ok',
          5000
        )
      }
    } catch (e) {
      // 查询失败静默处理，不干扰用户
    }
  })()

    context.addMenuItem({
      label: pdf2docText('📄 PDF / 图片高精度解析', '📄 PDF / Image High-Precision OCR'),
      title: pdf2docText(
        '解析 PDF 或图片为 Markdown 或 docx（图片仅支持 Markdown）',
        'Parse PDF or images into Markdown or DOCX (images only support Markdown).'
      ),
      children: [
        {
          label: pdf2docText('选择文件', 'Choose file'),
        onClick: async () => {
          let loadingId = null
          try {
            const cfg = await loadConfig(context)
            if (!cfg.apiToken) {
              context.ui.notice(
                pdf2docText('请先在插件设置中配置密钥', 'Please configure the PDF2Doc token in plugin settings first'),
                'err'
              )
              return
            }

            const file = await pickPdfFile()

            if (context.ui.showNotification) {
              loadingId = context.ui.showNotification(
                pdf2docText('正在解析 PDF，请稍候...', 'Parsing PDF, please wait...'),
                {
                  type: 'info',
                  duration: 0
                }
              )
            } else {
              context.ui.notice(
                pdf2docText('正在解析 PDF，请稍候...', 'Parsing PDF, please wait...'),
                'ok',
                3000
              )
            }

            const result = await uploadAndParsePdfFile(context, cfg, file, cfg.defaultOutput)

            if (loadingId && context.ui.hideNotification) {
              context.ui.hideNotification(loadingId)
            }

            if (result.format === 'markdown' && result.markdown) {
              const baseName = file && file.name ? file.name.replace(/\.pdf$/i, '') : 'document'
              const localized = await localizeMarkdownImages(context, result.markdown, {
                baseName
              })

              // 解析 PDF（通过文件选择）时，同时：
              // 1. 在当前文档中插入解析结果
              // 2. 在当前库/当前文档目录下保存一份独立的 Markdown 文件，便于长期保存与同步
              let savedPath = ''
              if (typeof context.saveMarkdownToCurrentFolder === 'function') {
                try {
                  const mdFileName = baseName + ' (PDF 解析).md'
                  savedPath = await context.saveMarkdownToCurrentFolder({
                    fileName: mdFileName,
                    content: localized,
                    onConflict: 'renameAuto'
                  })
                } catch {}
              }

              const current = context.getEditorValue()
              const merged = current ? current + '\n\n' + localized : localized
              context.setEditorValue(merged)

              const pagesInfo = result.pages
                ? pdf2docText('（' + result.pages + ' 页）', ' (' + result.pages + ' pages)')
                : ''
              if (savedPath) {
                context.ui.notice(
                  pdf2docText(
                    'PDF 解析完成，已插入并保存为 Markdown 文件' + pagesInfo,
                    'PDF parsed and inserted; Markdown file saved' + pagesInfo
                  ),
                  'ok'
                )
              } else {
                context.ui.notice(
                  pdf2docText(
                    'PDF 解析完成，已插入 Markdown' + pagesInfo,
                    'PDF parsed and inserted as Markdown' + pagesInfo
                  ),
                  'ok'
                )
              }
            } else if (result.format === 'docx' && result.docx_url) {
              let docxFileName = 'document.docx'
              if (file && file.name) {
                docxFileName = file.name.replace(/\.pdf$/i, '') + '.docx'
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
                showDocxDownloadDialog(result.docx_url, result.pages || 0)
              }
            } else {
              context.ui.notice(
                pdf2docText('解析成功，但返回格式未知', 'Parse succeeded but returned unknown format'),
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
                  'PDF 解析失败：' + (err && err.message ? err.message : String(err)),
                  'PDF parse failed: ' + (err && err.message ? err.message : String(err))
                ),
                'err'
              )
            }
          }
        },
        {
          label: pdf2docText('选择图片 (To MD)', 'Choose image (To MD)'),
          onClick: async () => {
            let loadingId = null
            try {
              const cfg = await loadConfig(context)
              if (!cfg.apiToken) {
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
        label: pdf2docText('To MD', 'To MD'),
        onClick: async () => {
          let loadingId = null
          try {
            const cfg = await loadConfig(context)
            if (!cfg.apiToken) {
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

            if (context.ui.showNotification) {
              loadingId = context.ui.showNotification(
                pdf2docText('正在解析当前 PDF 为 Markdown...', 'Parsing current PDF to Markdown...'),
                {
                  type: 'info',
                  duration: 0
                }
              )
            } else {
              context.ui.notice(
                pdf2docText('正在解析当前 PDF 为 Markdown...', 'Parsing current PDF to Markdown...'),
                'ok',
                3000
              )
            }

            const bytes = await context.readFileBinary(path)
            const fileName = path.split(/[\\/]+/).pop() || 'document.pdf'
            const result = await parsePdfBytes(context, cfg, bytes, fileName, 'markdown')

            if (loadingId && context.ui.hideNotification) {
              context.ui.hideNotification(loadingId)
            }

            if (result.format === 'markdown' && result.markdown) {
              const baseName = fileName ? fileName.replace(/\.pdf$/i, '') : 'document'
              const localized = await localizeMarkdownImages(context, result.markdown, {
                baseName
              })
              let savedPath = ''
              if (typeof context.saveMarkdownToCurrentFolder === 'function') {
                try {
                  const mdFileName = baseName + ' (PDF 解析).md'
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
                'PDF 解析失败：' + (err && err.message ? err.message : String(err)),
                'PDF parse failed: ' + (err && err.message ? err.message : String(err))
              ),
              'err'
            )
          }
        }
      },
      {
        label: pdf2docText('To Docx', 'To Docx'),
        onClick: async () => {
          let loadingId = null
          try {
            const cfg = await loadConfig(context)
            if (!cfg.apiToken) {
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

            const bytes = await context.readFileBinary(path)
            const fileName = path.split(/[\\/]+/).pop() || 'document.pdf'
            const result = await parsePdfBytes(context, cfg, bytes, fileName, 'docx')

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
                showDocxDownloadDialog(result.docx_url, result.pages || 0)
              }
            } else {
              context.ui.notice(
                pdf2docText('解析成功，但返回格式不是 Docx', 'Parse succeeded but returned format is not DOCX'),
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
                'PDF 解析失败：' + (err && err.message ? err.message : String(err)),
                'PDF parse failed: ' + (err && err.message ? err.message : String(err))
              ),
              'err'
            )
          }
        }
      },
        {
        label: pdf2docText('翻译 PDF', 'Translate PDF'),
        onClick: async () => {
          let loadingId = null
          const loadingRef = { id: null }
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
            if (!cfg.apiToken) {
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

                const bytes = await context.readFileBinary(path)
                const result = await parsePdfBytes(
                  context,
                  cfg,
                  bytes,
                  fileName,
                  'markdown'
                )
                if (result.format === 'markdown' && result.markdown) {
                  const baseNameInner = fileName
                    ? fileName.replace(/\.pdf$/i, '')
                    : 'document'
                  markdown = await localizeMarkdownImages(
                    context,
                    result.markdown,
                    { baseName: baseNameInner }
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

              const result = await uploadAndParsePdfFile(
                context,
                cfg,
                file,
                'markdown'
              )
              if (result.format === 'markdown' && result.markdown) {
                const baseNameFile =
                  file && file.name
                    ? file.name.replace(/\.pdf$/i, '')
                    : 'document'
                markdown = await localizeMarkdownImages(
                  context,
                  result.markdown,
                  { baseName: baseNameFile }
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
  })

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
          if (!cfg.apiToken) {
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
          if (!cfg.apiToken) {
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
