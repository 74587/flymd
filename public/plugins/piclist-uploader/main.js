// PicList 图床插件：仅依赖插件 API，无需修改宿主
// 功能：在源码编辑模式中，右键选中本地图片路径或 Markdown 图片语法，调用本地 PicList HTTP Server 上传，并用图床链接替换选中内容

const STORAGE_KEY = 'piclistUploaderConfig_v1'
let _settingsRoot = null

// 默认配置：尽量贴合 PicList 内置 Server 文档
function getDefaultConfig() {
  return {
    // PicList 监听地址（不含路径）
    host: 'http://127.0.0.1:36677',
    // 可选：接口鉴权 key，未开启可留空
    key: '',
    // 可选：PicList 中的图床标识（picbed），留空走 PicList 默认
    picbed: '',
    // 可选：PicList 中的配置名（configName），留空走当前默认配置
    configName: '',
  }
}

// 安全加载配置
async function loadConfig(context) {
  try {
    const raw = await context.storage.get(STORAGE_KEY)
    if (!raw || typeof raw !== 'object') {
      return getDefaultConfig()
    }
    const def = getDefaultConfig()
    return {
      host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : def.host,
      key: typeof raw.key === 'string' ? raw.key.trim() : '',
      picbed: typeof raw.picbed === 'string' ? raw.picbed.trim() : '',
      configName: typeof raw.configName === 'string' ? raw.configName.trim() : '',
    }
  } catch {
    return getDefaultConfig()
  }
}

// 保存配置
async function saveConfig(context, cfg) {
  try {
    const next = Object.assign(getDefaultConfig(), cfg || {})
    await context.storage.set(STORAGE_KEY, next)
    return next
  } catch {
    context.ui && context.ui.notice && context.ui.notice('保存 PicList 图床配置失败', 'err', 2600)
    return cfg
  }
}

// 判断一段文本是否“看起来像”图片路径或 Markdown 图片语法
function looksLikeImageText(text) {
  if (!text) return false
  const s = String(text).trim()
  if (!s) return false

  // 完整 Markdown 图片语法：![alt](path "title")
  if (/!\[[^\]]*]\([^()]+\)/.test(s)) return true
  // Obsidian 风格：![[xxx]]
  if (/!\[\[[^\]]+]]/.test(s)) return true

  // 去掉包裹的引号后判断扩展名
  let p = s.replace(/^['"]|['"]$/g, '')
  // 去掉查询参数/锚点
  p = p.split(/[?#]/)[0]
  if (!p) return false

  return /\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(p)
}

// 从 Markdown 图片语法或原始文本中提取图片相对/绝对路径，以及原始 alt/title
function extractImageInfoFromSelection(raw) {
  const text = String(raw || '').trim()
  if (!text) return null

  // 1) Markdown 语法：![alt](path "title")
  const mMd = text.match(/^!\[([^\]]*)]\(([^)]+)\)/)
  if (mMd) {
    const alt = (mMd[1] || '').trim()
    let inner = (mMd[2] || '').trim()
    // 只取第一个空白前的部分作为路径，其余当作 title
    const firstSpace = inner.search(/\s/)
    let path = inner
    let title = ''
    if (firstSpace > 0) {
      path = inner.slice(0, firstSpace)
      title = inner.slice(firstSpace).trim()
    }
    path = path.replace(/^['"]|['"]$/g, '')
    return {
      mode: 'markdown',
      alt,
      title,
      path,
    }
  }

  // 2) Obsidian 风格：![[file.png]] 或 ![[file|alias]]
  const mOb = text.match(/^!\[\[([^\]]+)]]/)
  if (mOb) {
    const inner = (mOb[1] || '').trim()
    const pipeIdx = inner.indexOf('|')
    const core = pipeIdx >= 0 ? inner.slice(0, pipeIdx).trim() : inner
    return {
      mode: 'wikilink',
      alt: inner,
      title: '',
      path: core,
    }
  }

  // 3) 直接当作路径
  let p = text.replace(/^['"]|['"]$/g, '')
  p = p.split(/[?#]/)[0]
  if (!p) return null

  return {
    mode: 'path',
    alt: '',
    title: '',
    path: p,
  }
}

// 基于当前文件路径与图片相对路径，拼出一个尽量可用的本地绝对路径
function resolveImageAbsolutePath(imagePath, filePath) {
  if (!imagePath) return null
  let p = String(imagePath).trim()
  if (!p) return null

  // 已经是绝对路径（Windows / UNC / *nix）
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')) {
    return p
  }

  if (!filePath) {
    // 没有当前文件路径，只能返回原始相对路径，让 PicList 自己去解析
    return p
  }

  const fp = String(filePath)
  const sep = fp.includes('\\') ? '\\' : '/'
  const idx = fp.lastIndexOf(sep)
  if (idx < 0) return p
  const dir = fp.slice(0, idx)

  // 粗暴拼接：不做规范化，让底层系统自己处理 .. 等
  const normalizedRel = p.replace(/[\\/]/g, sep)
  return dir + sep + normalizedRel
}

// 调用 PicList HTTP Server 上传指定本地路径的图片
async function uploadViaPicList(context, absPath) {
  if (!absPath) {
    throw new Error('图片路径为空')
  }

  const cfg = await loadConfig(context)
  const base = (cfg.host || '').trim() || 'http://127.0.0.1:36677'
  const urlBase = base.replace(/\/+$/, '')

  const searchParams = []
  if (cfg.key) searchParams.push('key=' + encodeURIComponent(cfg.key))
  if (cfg.picbed) searchParams.push('picbed=' + encodeURIComponent(cfg.picbed))
  if (cfg.configName) searchParams.push('configName=' + encodeURIComponent(cfg.configName))
  const qs = searchParams.length ? '?' + searchParams.join('&') : ''

  const url = urlBase + '/upload' + qs

  // 按 PicList 文档要求：POST JSON { list: ['xxx.jpg'] }
  const resp = await context.http.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ list: [absPath] }),
  })

  let data = null
  try {
    data = await resp.json()
  } catch (e) {
    throw new Error('解析 PicList 返回数据失败：' + (e && e.message ? e.message : String(e || '未知错误')))
  }

  if (!data || data.success !== true || !Array.isArray(data.result) || !data.result[0]) {
    throw new Error('PicList 返回失败：' + JSON.stringify(data || {}, null, 2))
  }

  return String(data.result[0])
}

// 将选中的文本替换为带图床 URL 的 Markdown 语法，尽量保留原来的 alt/title
function buildReplacementMarkdown(info, remoteUrl) {
  const url = String(remoteUrl || '').trim()
  if (!url) return null

  if (!info || typeof info !== 'object') {
    return url
  }

  const mode = info.mode || 'path'
  const alt = info.alt || ''
  const title = info.title || ''

  if (mode === 'markdown') {
    const titlePart = title ? ' ' + title : ''
    return '![' + alt + '](' + url + titlePart + ')'
  }

  if (mode === 'wikilink') {
    // 将 wikilink 形态替换为标准 Markdown 图片语法，alt 保留原文本
    return '![' + alt + '](' + url + ')'
  }

  // 纯路径：用远程 URL 替换
  return url
}

export async function activate(context) {
  context.ui.notice && context.ui.notice('PicList 图床插件已激活', 'ok', 2000)

  // 顶部菜单：仅做一个简单入口，方便用户测试是否能成功上传
  context.addMenuItem &&
    context.addMenuItem({
      label: 'PicList 图床',
      title: '使用 PicList HTTP Server 上传图片',
      children: [
        {
          label: '上传选中文本对应的图片',
          note: '仅源码模式，选中图片路径或 Markdown 语法',
          onClick: async () => {
            try {
              const sel = context.getSelection ? context.getSelection() : null
              const full = context.getEditorValue ? context.getEditorValue() : ''
              if (!sel || typeof sel.start !== 'number' || typeof sel.end !== 'number' || sel.end <= sel.start) {
                context.ui.notice('请先在源码模式中选中图片路径或 Markdown 图片语法', 'err', 2600)
                return
              }
              const raw = String(full || '').slice(sel.start, sel.end)
              if (!looksLikeImageText(raw)) {
                context.ui.notice('选中文本不像是图片路径或 Markdown 图片语法', 'err', 2600)
                return
              }

              const info = extractImageInfoFromSelection(raw)
              if (!info || !info.path) {
                context.ui.notice('无法从选中文本解析出图片路径', 'err', 2600)
                return
              }

              const filePath =
                (typeof context.getCurrentFilePath === 'function' && context.getCurrentFilePath()) || null
              const absPath = resolveImageAbsolutePath(info.path, filePath)
              const url = await uploadViaPicList(context, absPath)

              const replacement = buildReplacementMarkdown(info, url)
              if (!replacement) {
                context.ui.notice('上传成功，但生成替换内容失败', 'err', 2600)
                return
              }

              if (typeof context.replaceRange === 'function') {
                context.replaceRange(sel.start, sel.end, replacement)
              } else if (typeof context.setEditorValue === 'function') {
                const before = String(full || '').slice(0, sel.start)
                const after = String(full || '').slice(sel.end)
                context.setEditorValue(before + replacement + after)
              }

              context.ui.notice('图片已上传至 PicList', 'ok', 2600)
            } catch (e) {
              const msg = e && e.message ? e.message : String(e || '未知错误')
              context.ui.notice('PicList 上传失败：' + msg, 'err', 4000)
            }
          },
        },
      ],
    })

  // 编辑区域右键菜单：仅使用插件端即可，不需要改宿主
  if (typeof context.addContextMenuItem === 'function') {
    context.addContextMenuItem({
      label: '使用 PicList 上传图片',
      note: '选中图片路径或 Markdown 图片语法',
      condition: (ctx) => {
        // 仅在源码模式有效
        if (!ctx || ctx.mode !== 'edit') return false
        const s = (ctx.selectedText || '').trim()
        if (!s) return false
        return looksLikeImageText(s)
      },
      onClick: async (ctx) => {
        try {
          if (!ctx) return
          const selected = (ctx.selectedText || '').trim()
          if (!selected) {
            context.ui.notice('请先选中图片路径或 Markdown 图片语法', 'err', 2400)
            return
          }
          if (!looksLikeImageText(selected)) {
            context.ui.notice('选中文本不像是图片路径或 Markdown 图片语法', 'err', 2600)
            return
          }

          const info = extractImageInfoFromSelection(selected)
          if (!info || !info.path) {
            context.ui.notice('无法从选中文本解析出图片路径', 'err', 2600)
            return
          }

          const filePath = ctx.filePath || (typeof context.getCurrentFilePath === 'function' && context.getCurrentFilePath()) || null
          const absPath = resolveImageAbsolutePath(info.path, filePath)
          const url = await uploadViaPicList(context, absPath)

          const replacement = buildReplacementMarkdown(info, url)
          if (!replacement) {
            context.ui.notice('上传成功，但生成替换内容失败', 'err', 2600)
            return
          }

          const sel = context.getSelection ? context.getSelection() : null
          const full = context.getEditorValue ? context.getEditorValue() : ''
          if (!sel || typeof sel.start !== 'number' || typeof sel.end !== 'number' || sel.end <= sel.start) {
            // 回退方案：直接在光标处插入
            if (typeof context.insertAtCursor === 'function') {
              context.insertAtCursor(replacement)
            }
          } else if (typeof context.replaceRange === 'function') {
            context.replaceRange(sel.start, sel.end, replacement)
          } else if (typeof context.setEditorValue === 'function') {
            const before = String(full || '').slice(0, sel.start)
            const after = String(full || '').slice(sel.end)
            context.setEditorValue(before + replacement + after)
          }

          context.ui.notice('图片已上传至 PicList', 'ok', 2600)
        } catch (e) {
          const msg = e && e.message ? e.message : String(e || '未知错误')
          context.ui.notice('PicList 上传失败：' + msg, 'err', 4000)
        }
      },
    })
  }
}

function ensureSettingsDialog(context, cfg) {
  if (typeof document === 'undefined') {
    return null
  }

  if (!_settingsRoot) {
    const overlay = document.createElement('div')
    overlay.id = 'piclist-settings-overlay'
    overlay.style.position = 'fixed'
    overlay.style.left = '0'
    overlay.style.top = '0'
    overlay.style.right = '0'
    overlay.style.bottom = '0'
    overlay.style.display = 'none'
    overlay.style.alignItems = 'center'
    overlay.style.justifyContent = 'center'
    overlay.style.background = 'rgba(0,0,0,0.35)'
    overlay.style.zIndex = '999999'

    const panel = document.createElement('div')
    panel.style.minWidth = '420px'
    panel.style.maxWidth = '520px'
    panel.style.background = 'var(--bg, #fff)'
    panel.style.borderRadius = '8px'
    panel.style.boxShadow = '0 18px 45px rgba(0,0,0,0.25)'
    panel.style.padding = '18px 20px 16px'
    panel.style.fontSize = '13px'
    panel.style.color = 'var(--fg, #111)'

    const title = document.createElement('div')
    title.textContent = 'PicList 图床设置'
    title.style.fontSize = '15px'
    title.style.fontWeight = '600'
    title.style.marginBottom = '4px'

    const desc = document.createElement('div')
    desc.textContent = '配置 PicList 内置 HTTP 服务器参数，用于上传本地图片并替换为图床链接。'
    desc.style.fontSize = '12px'
    desc.style.opacity = '0.8'
    desc.style.marginBottom = '12px'

    const form = document.createElement('div')
    form.style.display = 'flex'
    form.style.flexDirection = 'column'
    form.style.gap = '8px'

    const fields = [
      { key: 'host', label: '服务器地址（含端口，不含路径）', placeholder: '例如：http://127.0.0.1:36677' },
      { key: 'key', label: '接口鉴权 key（未启用可留空）', placeholder: '' },
      { key: 'picbed', label: '图床标识 picbed（留空使用默认）', placeholder: '例如：aws-s3' },
      { key: 'configName', label: '配置名 configName（留空使用默认）', placeholder: '例如：piclist-test' },
    ]

    const inputs = {}

    fields.forEach((f) => {
      const row = document.createElement('div')
      row.style.display = 'flex'
      row.style.flexDirection = 'column'

      const lab = document.createElement('label')
      lab.textContent = f.label
      lab.style.marginBottom = '2px'

      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = f.placeholder
      input.style.padding = '6px 8px'
      input.style.borderRadius = '4px'
      input.style.border = '1px solid rgba(0,0,0,0.18)'
      input.style.fontSize = '13px'
      input.style.outline = 'none'

      input.addEventListener('focus', () => {
        input.style.borderColor = '#2563eb'
        input.style.boxShadow = '0 0 0 1px rgba(37,99,235,0.18)'
      })
      input.addEventListener('blur', () => {
        input.style.borderColor = 'rgba(0,0,0,0.18)'
        input.style.boxShadow = 'none'
      })

      row.appendChild(lab)
      row.appendChild(input)
      form.appendChild(row)

      inputs[f.key] = input
    })

    const buttons = document.createElement('div')
    buttons.style.display = 'flex'
    buttons.style.justifyContent = 'flex-end'
    buttons.style.gap = '8px'
    buttons.style.marginTop = '14px'

    const btnCancel = document.createElement('button')
    btnCancel.textContent = '取消'
    btnCancel.style.padding = '6px 14px'
    btnCancel.style.fontSize = '13px'
    btnCancel.style.borderRadius = '4px'
    btnCancel.style.border = '1px solid rgba(0,0,0,0.12)'
    btnCancel.style.background = 'var(--bg-muted, #f5f5f5)'
    btnCancel.style.cursor = 'pointer'

    const btnOk = document.createElement('button')
    btnOk.textContent = '保存'
    btnOk.style.padding = '6px 16px'
    btnOk.style.fontSize = '13px'
    btnOk.style.borderRadius = '4px'
    btnOk.style.border = 'none'
    btnOk.style.background = '#2563eb'
    btnOk.style.color = '#fff'
    btnOk.style.cursor = 'pointer'

    btnCancel.addEventListener('click', () => {
      overlay.style.display = 'none'
    })

    btnOk.addEventListener('click', async () => {
      try {
        const next = {
          host: inputs.host.value.trim() || cfg.host || getDefaultConfig().host,
          key: inputs.key.value.trim(),
          picbed: inputs.picbed.value.trim(),
          configName: inputs.configName.value.trim(),
        }
        await saveConfig(context, next)
        overlay.style.display = 'none'
        if (context.ui && typeof context.ui.notice === 'function') {
          context.ui.notice('PicList 图床配置已更新', 'ok', 2200)
        }
      } catch (e) {
        const msg = e && e.message ? e.message : String(e || '未知错误')
        if (context.ui && typeof context.ui.notice === 'function') {
          context.ui.notice('更新 PicList 配置失败：' + msg, 'err', 3200)
        }
      }
    })

    buttons.appendChild(btnCancel)
    buttons.appendChild(btnOk)

    panel.appendChild(title)
    panel.appendChild(desc)
    panel.appendChild(form)
    panel.appendChild(buttons)

    overlay.appendChild(panel)

    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) {
        overlay.style.display = 'none'
      }
    })

    const root = document.querySelector('.container') || document.body
    root.appendChild(overlay)

    overlay._piclistInputs = inputs
    _settingsRoot = overlay
  }

  const inputs = _settingsRoot._piclistInputs || {}
  inputs.host && (inputs.host.value = cfg.host || '')
  inputs.key && (inputs.key.value = cfg.key || '')
  inputs.picbed && (inputs.picbed.value = cfg.picbed || '')
  inputs.configName && (inputs.configName.value = cfg.configName || '')

  _settingsRoot.style.display = 'flex'
  if (inputs.host) {
    try {
      inputs.host.focus()
      inputs.host.select()
    } catch {}
  }

  return _settingsRoot
}

export async function openSettings(context) {
  try {
    const cfg = await loadConfig(context)
    const root = ensureSettingsDialog(context, cfg)
    if (!root) {
      if (context.ui && typeof context.ui.notice === 'function') {
        context.ui.notice('当前环境不支持图形设置窗口', 'err', 2600)
      }
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e || '未知错误')
    context.ui.notice('更新 PicList 配置失败：' + msg, 'err', 3200)
  }
}

export function deactivate() {
  // 当前插件未注册全局事件，无需特殊清理
}
