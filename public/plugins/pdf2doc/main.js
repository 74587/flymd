// PDF 解析插件（pdf2doc）

// 默认后端 API 根地址
const DEFAULT_API_BASE = 'https://flymd.llingfei.com/pdf/'
const PDF2DOC_STYLE_ID = 'pdf2doc-settings-style'


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
        reject(new Error('未选择文件'))
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
      '网络请求失败：' + (e && e.message ? e.message : String(e))
    )
  }

  let data = null
  try {
    data = await res.json()
  } catch (e) {
    const statusText = 'HTTP ' + res.status
    throw new Error(
      '解析响应 JSON 失败（' +
        statusText +
        '）：' +
        (e && e.message ? e.message : String(e))
    )
  }

  if (!data || typeof data !== 'object') {
    throw new Error('响应格式错误：不是 JSON 对象')
  }

  if (!data.ok) {
    const msg = data.message || data.error || '解析失败'
    throw new Error(msg)
  }

  return data // { ok, format, markdown?, docx_url?, pages, uid }
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



function showDocxDownloadDialog(docxUrl, pages) {
  if (typeof document === 'undefined') return

  
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:90020;'

  
  const dialog = document.createElement('div')
  dialog.style.cssText = 'width:460px;max-width:calc(100% - 40px);background:var(--bg,#fff);color:var(--fg,#333);border-radius:12px;border:1px solid var(--border,#e5e7eb);box-shadow:0 20px 50px rgba(0,0,0,.3);overflow:hidden;'

  
  const header = document.createElement('div')
  header.style.cssText = 'padding:16px 20px;border-bottom:1px solid var(--border,#e5e7eb);font-weight:600;font-size:16px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;'
  header.textContent = 'docx 文件已生成'

 
  const body = document.createElement('div')
  body.style.cssText = 'padding:20px;'

  const message = document.createElement('div')
  message.style.cssText = 'font-size:14px;color:var(--fg,#555);margin-bottom:16px;line-height:1.6;'
  message.innerHTML = `文件已成功转换为 docx 格式（<strong>${pages} 页</strong>）<br>请选择下载方式：`

  
  const linkDisplay = document.createElement('div')
  linkDisplay.style.cssText = 'background:var(--bg-muted,#f9fafb);border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:12px;color:var(--muted,#6b7280);word-break:break-all;max-height:60px;overflow-y:auto;'
  linkDisplay.textContent = docxUrl

  
  const buttonContainer = document.createElement('div')
  buttonContainer.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;'

 
  const downloadBtn = document.createElement('button')
  downloadBtn.style.cssText = 'padding:10px 16px;border-radius:8px;border:none;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;cursor:pointer;font-size:14px;font-weight:500;transition:transform 0.2s;'
  downloadBtn.textContent = '🔽 点击下载'
  downloadBtn.onmouseover = () => downloadBtn.style.transform = 'translateY(-2px)'
  downloadBtn.onmouseout = () => downloadBtn.style.transform = 'translateY(0)'
  downloadBtn.onclick = () => {
    try {
      const opened = window.open(docxUrl, '_blank')
      if (opened) {
        
        document.body.removeChild(overlay)
      } else {
        
        downloadBtn.textContent = '❌ 浏览器已拦截'
        downloadBtn.style.background = '#ef4444'
        message.innerHTML = `<span style="color:#ef4444;">⚠️ 浏览器阻止了弹窗</span><br>请点击"复制链接"按钮，然后粘贴到浏览器地址栏打开`
        setTimeout(() => {
          downloadBtn.textContent = '🔽 点击下载'
          downloadBtn.style.background = 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)'
        }, 3000)
      }
    } catch (e) {
      
      downloadBtn.textContent = '❌ 下载失败'
      downloadBtn.style.background = '#ef4444'
      message.innerHTML = `<span style="color:#ef4444;">⚠️ 无法打开下载链接</span><br>请点击"复制链接"按钮，然后粘贴到浏览器地址栏打开`
    }
  }

  
  const copyBtn = document.createElement('button')
  copyBtn.style.cssText = 'padding:10px 16px;border-radius:8px;border:1px solid var(--border,#d1d5db);background:var(--bg,#fff);color:var(--fg,#333);cursor:pointer;font-size:14px;font-weight:500;transition:all 0.2s;'
  copyBtn.textContent = '📋 复制链接'
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
        copyBtn.textContent = '✅ 已复制'
        copyBtn.style.background = '#10b981'
        copyBtn.style.color = '#fff'
        copyBtn.style.borderColor = '#10b981'
        setTimeout(() => {
          document.body.removeChild(overlay)
        }, 1000)
      }).catch(() => {
        copyBtn.textContent = '❌ 复制失败'
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
      copyBtn.textContent = '已选中，请按 Ctrl+C'
    }
  }

  
  const footer = document.createElement('div')
  footer.style.cssText = 'padding:12px 20px;border-top:1px solid var(--border,#e5e7eb);text-align:center;background:var(--bg-muted,#f9fafb);'

  const closeBtn = document.createElement('button')
  closeBtn.style.cssText = 'padding:6px 20px;border-radius:6px;border:1px solid var(--border,#d1d5db);background:var(--bg,#fff);color:var(--muted,#6b7280);cursor:pointer;font-size:13px;'
  closeBtn.textContent = '关闭'
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
    header.textContent = 'pdf2doc 设置'
    dialog.appendChild(header)

    const body = document.createElement('div')
    body.className = 'pdf2doc-settings-body'
    dialog.appendChild(body)

    
  const rowToken = document.createElement('div')
  rowToken.className = 'pdf2doc-settings-row'
  const labToken = document.createElement('div')
  labToken.className = 'pdf2doc-settings-label'
  labToken.textContent = '密钥'
  const boxToken = document.createElement('div')
    const inputToken = document.createElement('input')
    inputToken.type = 'text'
    inputToken.className = 'pdf2doc-settings-input'
  
  inputToken.placeholder = ''
  inputToken.value = cfg.apiToken || ''
      boxToken.appendChild(inputToken)
      const tipToken = document.createElement('div')
      tipToken.className = 'pdf2doc-settings-desc'
      tipToken.textContent = '务必牢记密钥，丢失后可通过我的订单找回'
      boxToken.appendChild(tipToken)

      const quotaInfo = document.createElement('div')
      quotaInfo.className = 'pdf2doc-settings-desc'
      quotaInfo.textContent = ''

      const btnQuota = document.createElement('button')
      btnQuota.type = 'button'
      btnQuota.className = 'pdf2doc-settings-btn'
      btnQuota.textContent = '查询剩余页数'
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
    purchaseTitle.textContent = '支付宝扫码购买解析页数'
    purchaseSection.appendChild(purchaseTitle)

    const purchaseDesc = document.createElement('div')
    purchaseDesc.className = 'pdf2doc-settings-purchase-desc'
    purchaseDesc.innerHTML = '100页PDF 3元 折合0.03元/页<br>200页PDF 5元 折合0.025元/页<br>500页PDF 12元 折合0.024元/页'
    purchaseSection.appendChild(purchaseDesc)

    
    const qrcodeContainer = document.createElement('div')
    qrcodeContainer.className = 'pdf2doc-settings-qrcode-container'

    const qrcodeImg = document.createElement('img')
    qrcodeImg.className = 'pdf2doc-settings-qrcode-img'
    qrcodeImg.src = 'https://flymd.llingfei.com/pdf/shop.png'
    qrcodeImg.alt = '支付宝扫码购买'
    qrcodeContainer.appendChild(qrcodeImg)

    purchaseSection.appendChild(qrcodeContainer)

    
    const orderBtn = document.createElement('button')
    orderBtn.type = 'button'
    orderBtn.className = 'pdf2doc-settings-order-btn'
    orderBtn.textContent = '查看我的订单'
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
    warnTip.textContent = '⚠️请及时保存文档！重复解析也会扣除剩余页数。解析为Markdown后可另存为Docx'
    body.appendChild(warnTip)

    
    const rowOut = document.createElement('div')
    rowOut.className = 'pdf2doc-settings-row'
    const labOut = document.createElement('div')
    labOut.className = 'pdf2doc-settings-label'
    labOut.textContent = '默认输出格式'
    const outSelect = document.createElement('select')
    outSelect.className = 'pdf2doc-settings-input'
    const optMd = document.createElement('option')
    optMd.value = 'markdown'
    optMd.textContent = 'Markdown'
    const optDocx = document.createElement('option')
    optDocx.value = 'docx'
    optDocx.textContent = 'docx（生成可下载的 Word 文件）'
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
    btnCancel.textContent = '取消'
    const btnSave = document.createElement('button')
    btnSave.className = 'pdf2doc-settings-btn primary'
    btnSave.textContent = '保存'
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
        quotaInfo.textContent = '请先填写密钥'
        return
      }

      quotaInfo.textContent = '正在查询剩余页数...'

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
          quotaInfo.textContent = '查询失败：服务器响应格式错误'
          return
        }

        
        if (res.status < 200 || res.status >= 300) {
          const msg = (data && (data.message || data.error)) || text || '请求失败（HTTP ' + res.status + '）'
          quotaInfo.textContent = '查询失败：' + msg
          return
        }

        
        if (!data || data.ok !== true) {
          const msg = (data && (data.message || data.error)) || '服务器返回错误'
          quotaInfo.textContent = '查询失败：' + msg
          return
        }

        
        const total = data.total_pages ?? 0
        const used = data.used_pages ?? 0
        const remain = data.remain_pages ?? Math.max(0, total - used)

        quotaInfo.textContent =
          '当前剩余页数：' +
          remain +
          '（总 ' +
          total +
          ' 页，已用 ' +
          used +
          ' 页）'

      } catch (e) {
        
        const msg = e && e.message ? e.message : String(e || '未知错误')
        quotaInfo.textContent = '查询失败：' + msg
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
          'PDF2Doc 剩余页数：' + remain + ' 页（总 ' + total + ' 页）',
          'ok',
          5000
        )
      }
    } catch (e) {
      // 查询失败静默处理，不干扰用户
    }
  })()

  context.addMenuItem({
    label: 'PDF 解析',
    title: '解析 PDF 为 Markdown 或 docx',
    children: [
      {
        label: '选择文件',
        onClick: async () => {
          let loadingId = null
          try {
            const cfg = await loadConfig(context)
            if (!cfg.apiToken) {
              context.ui.notice('请先在插件设置中配置密钥', 'err')
              return
            }

            const file = await pickPdfFile()

            if (context.ui.showNotification) {
              loadingId = context.ui.showNotification('正在解析 PDF，请稍候...', {
                type: 'info',
                duration: 0
              })
            } else {
              context.ui.notice('正在解析 PDF，请稍候...', 'ok', 3000)
            }

            const result = await uploadAndParsePdfFile(context, cfg, file, cfg.defaultOutput)

            if (loadingId && context.ui.hideNotification) {
              context.ui.hideNotification(loadingId)
            }

            if (result.format === 'markdown' && result.markdown) {
              const current = context.getEditorValue()
              const merged = current ? current + '\n\n' + result.markdown : result.markdown
              context.setEditorValue(merged)
              context.ui.notice(
                'PDF 解析完成，已插入 Markdown（' + (result.pages || '?') + ' 页）',
                'ok'
              )
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
                  'docx 文件已开始下载，请查看浏览器下载栏（' + (result.pages || '?') + ' 页）',
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
              context.ui.notice('解析成功，但返回格式未知', 'err')
            }
          } catch (err) {
            if (loadingId && context.ui.hideNotification) {
              try {
                context.ui.hideNotification(loadingId)
              } catch {}
            }
            context.ui.notice(
              'PDF 解析失败：' + (err && err.message ? err.message : String(err)),
              'err'
            )
          }
        }
      },
      {
        label: 'To MD',
        onClick: async () => {
          let loadingId = null
          try {
            const cfg = await loadConfig(context)
            if (!cfg.apiToken) {
              context.ui.notice('请先在插件设置中配置密钥', 'err')
              return
            }
            if (typeof context.getCurrentFilePath !== 'function' || typeof context.readFileBinary !== 'function') {
              context.ui.notice('当前版本不支持按路径解析 PDF', 'err')
              return
            }
            const path = context.getCurrentFilePath()
            if (!path || !/\.pdf$/i.test(path)) {
              context.ui.notice('当前没有打开 PDF 文件', 'err')
              return
            }

            if (context.ui.showNotification) {
              loadingId = context.ui.showNotification('正在解析当前 PDF 为 Markdown...', {
                type: 'info',
                duration: 0
              })
            } else {
              context.ui.notice('正在解析当前 PDF 为 Markdown...', 'ok', 3000)
            }

            const bytes = await context.readFileBinary(path)
            const fileName = path.split(/[\\/]+/).pop() || 'document.pdf'
            const result = await parsePdfBytes(context, cfg, bytes, fileName, 'markdown')

            if (loadingId && context.ui.hideNotification) {
              context.ui.hideNotification(loadingId)
            }

            if (result.format === 'markdown' && result.markdown) {
              const current = context.getEditorValue()
              const merged = current ? current + '\n\n' + result.markdown : result.markdown
              context.setEditorValue(merged)
              context.ui.notice(
                'PDF 解析完成，已插入 Markdown（' + (result.pages || '?') + ' 页）',
                'ok'
              )
            } else {
              context.ui.notice('解析成功，但返回格式不是 Markdown', 'err')
            }
          } catch (err) {
            if (loadingId && context.ui.hideNotification) {
              try {
                context.ui.hideNotification(loadingId)
              } catch {}
            }
            context.ui.notice(
              'PDF 解析失败：' + (err && err.message ? err.message : String(err)),
              'err'
            )
          }
        }
      },
      {
        label: 'To Docx',
        onClick: async () => {
          let loadingId = null
          try {
            const cfg = await loadConfig(context)
            if (!cfg.apiToken) {
              context.ui.notice('请先在插件设置中配置密钥', 'err')
              return
            }
            if (typeof context.getCurrentFilePath !== 'function' || typeof context.readFileBinary !== 'function') {
              context.ui.notice('当前版本不支持按路径解析 PDF', 'err')
              return
            }
            const path = context.getCurrentFilePath()
            if (!path || !/\.pdf$/i.test(path)) {
              context.ui.notice('当前没有打开 PDF 文件', 'err')
              return
            }

            if (context.ui.showNotification) {
              loadingId = context.ui.showNotification('正在解析当前 PDF 为 Docx...', {
                type: 'info',
                duration: 0
              })
            } else {
              context.ui.notice('正在解析当前 PDF 为 Docx...', 'ok', 3000)
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
                  'docx 文件已开始下载，请查看浏览器下载栏（' + (result.pages || '?') + ' 页）',
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
              context.ui.notice('解析成功，但返回格式不是 Docx', 'err')
            }
          } catch (err) {
            if (loadingId && context.ui.hideNotification) {
              try {
                context.ui.hideNotification(loadingId)
              } catch {}
            }
            context.ui.notice(
              'PDF 解析失败：' + (err && err.message ? err.message : String(err)),
              'err'
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
            throw new Error('path 不能为空')
          }
          if (!/\.pdf$/i.test(p)) {
            throw new Error('仅支持解析 .pdf 文件')
          }
          const cfg = await loadConfig(context)
          if (!cfg.apiToken) {
            throw new Error('未配置 pdf2doc 密钥')
          }
          if (typeof context.readFileBinary !== 'function') {
            throw new Error('当前版本不支持按路径读取二进制文件')
          }
          const bytes = await context.readFileBinary(p)
          const fileName = p.split(/[\\/]+/).pop() || 'document.pdf'
          const result = await parsePdfBytes(context, cfg, bytes, fileName, 'markdown')
          if (result.format !== 'markdown' || !result.markdown) {
            throw new Error('解析成功，但返回格式不是 Markdown')
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
  context.ui.notice('pdf2doc 插件配置已保存', 'ok')
}

export function deactivate() {
  // 当前插件没有需要清理的全局资源，预留接口以便将来扩展
}
