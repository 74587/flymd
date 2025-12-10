// PicList 图床插件：仅依赖插件 API，无需修改宿主
// 功能：在源码编辑模式中，右键选中本地图片路径或 Markdown 图片语法，调用本地 PicList HTTP Server 上传，并用图床链接替换选中内容

const STORAGE_KEY = 'piclistUploaderConfig_v1'
let _settingsRoot = null
let _globalContext = null
const DEBUG = true

function debugLog(...args) {
  if (!DEBUG) return
  try {
    // 统一前缀，方便在控制台过滤
    // eslint-disable-next-line no-console
    console.log('[piclist-uploader]', ...args)
  } catch {}
}

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
    // 是否在粘贴后自动上传到 PicList（默认关闭，只在用户显式开启时生效）
    autoUploadEnabled: false,
  }
}

// 安全加载配置
async function loadConfig(context) {
  try {
    debugLog('loadConfig: start')
    const raw = await context.storage.get(STORAGE_KEY)
    if (!raw || typeof raw !== 'object') {
      debugLog('loadConfig: no stored config, use default')
      return getDefaultConfig()
    }
    const def = getDefaultConfig()
    const cfg = {
      host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : def.host,
      key: typeof raw.key === 'string' ? raw.key.trim() : '',
      picbed: typeof raw.picbed === 'string' ? raw.picbed.trim() : '',
      configName: typeof raw.configName === 'string' ? raw.configName.trim() : '',
      autoUploadEnabled: !!raw.autoUploadEnabled,
    }
    debugLog('loadConfig: resolved config =', cfg)
    return cfg
  } catch {
    debugLog('loadConfig: failed, fallback default')
    return getDefaultConfig()
  }
}

// 保存配置
async function saveConfig(context, cfg) {
  try {
    const next = Object.assign(getDefaultConfig(), cfg || {})
    debugLog('saveConfig: saving', next)
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
  debugLog('extractImageInfoFromSelection: raw =', raw)
  if (!text) return null

  // 1) Markdown 语法：![alt](path "title")
  const mMd = text.match(/^!\[([^\]]*)]\(([^)]+)\)/)
  if (mMd) {
    const alt = (mMd[1] || '').trim()
    let inner = (mMd[2] || '').trim()
    let path = inner
    let title = ''

    // 支持形如 ![alt](<path with spaces> "title") 的语法
    if (inner.startsWith('<')) {
      const closeIdx = inner.indexOf('>')
      if (closeIdx >= 0) {
        path = inner.slice(0, closeIdx + 1)
        title = inner.slice(closeIdx + 1).trim()
      }
    } else {
      // 只取第一个空白前的部分作为路径，其余当作 title
      const firstSpace = inner.search(/\s/)
      if (firstSpace > 0) {
        path = inner.slice(0, firstSpace)
        title = inner.slice(firstSpace).trim()
      }
    }

    // 去掉包裹的尖括号和引号
    path = path.replace(/^<|>$/g, '')
    path = path.replace(/^['"]|['"]$/g, '')
    const info = {
      mode: 'markdown',
      alt,
      title,
      path,
    }
    debugLog('extractImageInfoFromSelection: markdown parsed =', info)
    return info
  }

  // 2) Obsidian 风格：![[file.png]] 或 ![[file|alias]]
  const mOb = text.match(/^!\[\[([^\]]+)]]/)
  if (mOb) {
    const inner = (mOb[1] || '').trim()
    const pipeIdx = inner.indexOf('|')
    const core = pipeIdx >= 0 ? inner.slice(0, pipeIdx).trim() : inner
    const info = {
      mode: 'wikilink',
      alt: inner,
      title: '',
      path: core,
    }
    debugLog('extractImageInfoFromSelection: wikilink parsed =', info)
    return info
  }

  // 3) 直接当作路径
  let p = text.replace(/^['"]|['"]$/g, '')
  p = p.split(/[?#]/)[0]
  if (!p) return null

  const info = {
    mode: 'path',
    alt: '',
    title: '',
    path: p,
  }
  debugLog('extractImageInfoFromSelection: path parsed =', info)
  return info
}

// 基于当前文件路径与图片相对路径，拼出一个尽量可用的本地绝对路径
function resolveImageAbsolutePath(imagePath, filePath) {
  if (!imagePath) return null
  let p = String(imagePath).trim()
  debugLog('resolveImageAbsolutePath: input =', imagePath, 'filePath =', filePath)
  if (!p) return null

  // 已经是绝对路径（Windows / UNC / *nix）
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')) {
    debugLog('resolveImageAbsolutePath: already absolute =', p)
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
  const full = dir + sep + normalizedRel
  debugLog('resolveImageAbsolutePath: resolved =', full)
  return full
}

// 调用 PicList HTTP Server 上传指定本地路径的图片
async function uploadViaPicList(context, absPath) {
  if (!absPath) {
    throw new Error('图片路径为空')
  }

  const cfg = await loadConfig(context)
  const base = (cfg.host || '').trim() || 'http://127.0.0.1:36677'

  // 优先走后端命令，避免前端 HTTP scope 限制
  if (typeof context.invoke === 'function') {
    try {
      debugLog('uploadViaPicList: using backend command flymd_piclist_upload')
      const urlFromCmd = await context.invoke('flymd_piclist_upload', {
        req: {
          host: base,
          key: cfg.key || '',
          picbed: cfg.picbed || '',
          configName: cfg.configName || '',
          path: absPath,
        },
      })
      if (typeof urlFromCmd === 'string' && urlFromCmd.trim()) {
        const finalUrl = urlFromCmd.trim()
        debugLog('uploadViaPicList: backend returned url =', finalUrl)
        return finalUrl
      }
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e || '')
      debugLog('uploadViaPicList: backend command failed =', msg)
      // 后端命令执行失败（例如老版本未实现、PicList 返回错误等），统一抛给上层处理
      throw new Error(msg || 'PicList 后端上传失败')
    }
  }

  // 理论上不会走到这里（仅在极旧版本或非常规环境下），简单兜底一个错误
  throw new Error('当前 FlyMD 版本不支持 PicList 后端上传命令')
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

// 自动粘贴上传相关状态
const _autoProcessedPaths = new Set()
let _autoUploading = false

// 判断是否是“粘贴生成的本地图片路径”，尽量避免误伤用户手动写的本地图片引用
function isPastedLocalImage(info) {
  if (!info || !info.path) return false
  const raw = String(info.path || '').trim()
  debugLog('isPastedLocalImage: path =', raw)
  if (!raw) return false
  if (/^https?:\/\//i.test(raw)) return false
  if (/^data:/i.test(raw)) return false
  if (!/\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(raw)) return false
  // flyMD 默认的粘贴命名中包含 pasted-，仅对这类路径自动上传，避免动到用户已有本地图片
  if (!raw.toLowerCase().includes('pasted-')) return false
  return true
}

// 在整篇 Markdown 源码里，查找最后一个“pasted- 本地图片”对应的 Markdown 片段
function findLastPastedImageInSource(context) {
  try {
    const full =
      (typeof context.getSourceText === 'function' && context.getSourceText()) ||
      (typeof context.getEditorValue === 'function' && context.getEditorValue()) ||
      ''
    const text = String(full || '')
    if (!text) return null

    const re = /!\[[^\]]*]\(([^)]+)\)/g
    let m
    let last = null
    while ((m = re.exec(text)) != null) {
      const fullMatch = m[0]
      const start = m.index >>> 0
      const end = start + fullMatch.length
      const info = extractImageInfoFromSelection(fullMatch)
      if (!info || !info.path) continue
      if (!isPastedLocalImage(info)) continue
      last = { text: fullMatch, start, end, info }
    }
    debugLog('findLastPastedImageInSource: result =', last)
    return last
  } catch (e) {
    debugLog('findLastPastedImageInSource: error', e)
    return null
  }
}

async function autoUploadOnePastedImage(context) {
  if (!context || typeof context.getEditorValue !== 'function') return false
  const text = String(context.getEditorValue() || '')
  debugLog('autoUploadOnePastedImage: editor text length =', text.length)
  if (!text) return false

  const re = /!\[[^\]]*]\(([^)]+)\)/g
  let m
  while ((m = re.exec(text)) != null) {
    const full = m[0]
    const start = m.index
    const end = start + full.length
    debugLog('autoUploadOnePastedImage: candidate =', full, 'range =', start, end)
    const info = extractImageInfoFromSelection(full)
    if (!info || !info.path) continue
    if (!isPastedLocalImage(info)) continue

    const key = String(info.path)
    if (_autoProcessedPaths.has(key)) {
      debugLog('autoUploadOnePastedImage: already processed path =', key)
      continue
    }

    const filePath =
      (typeof context.getCurrentFilePath === 'function' && context.getCurrentFilePath()) || null
    const absPath = resolveImageAbsolutePath(info.path, filePath)
    debugLog('autoUploadOnePastedImage: will upload absPath =', absPath, 'filePath =', filePath)

    try {
      const url = await uploadViaPicList(context, absPath)
      const replacement = buildReplacementMarkdown(info, url)
      if (!replacement) {
        _autoProcessedPaths.add(key)
        debugLog('autoUploadOnePastedImage: replacement empty, skip')
        return false
      }

      if (typeof context.replaceRange === 'function') {
        context.replaceRange(start, end, replacement)
      } else if (typeof context.setEditorValue === 'function') {
        const before = text.slice(0, start)
        const after = text.slice(end)
        context.setEditorValue(before + replacement + after)
      }

      if (context.ui && typeof context.ui.notice === 'function') {
        context.ui.notice('图片已自动上传至 PicList', 'ok', 2000)
      }

      _autoProcessedPaths.add(key)
      debugLog('autoUploadOnePastedImage: success for', key)
      return true
    } catch (e) {
      const msg = e && e.message ? e.message : String(e || '未知错误')
      if (context.ui && typeof context.ui.notice === 'function') {
        context.ui.notice('PicList 自动上传失败：' + msg, 'err', 3200)
      }
      _autoProcessedPaths.add(key)
      debugLog('autoUploadOnePastedImage: failed for', info.path, 'error =', e)
      return false
    }
  }

  return false
}

async function autoUploadNewPastedImages(context) {
  if (_autoUploading) return
  _autoUploading = true
  debugLog('autoUploadNewPastedImages: start')
  try {
    // 单次最多处理少量图片，避免长时间阻塞
    for (let i = 0; i < 4; i++) {
      // eslint-disable-next-line no-await-in-loop
      const handled = await autoUploadOnePastedImage(context)
      if (!handled) break
    }
  } finally {
    debugLog('autoUploadNewPastedImages: end')
    _autoUploading = false
  }
}

async function triggerAutoUploadIfEnabled(context) {
  try {
    const cfg = await loadConfig(context)
    if (!cfg.autoUploadEnabled) {
      debugLog('triggerAutoUploadIfEnabled: autoUpload disabled in config')
      return
    }
    await autoUploadNewPastedImages(context)
  } catch (e) {
    debugLog('triggerAutoUploadIfEnabled: error', e)
  }
}

function bindAutoUploadOnPaste(context) {
  if (typeof document === 'undefined') return
  try {
    const bindSourceEditor = () => {
      const editor =
        document.getElementById('editor') || document.querySelector('textarea.editor')
      if (!editor) return false
      const anyEditor = /** @type {any} */ (editor)
      if (anyEditor._piclistAutoPasteBound) return true

      const handler = () => {
        debugLog('paste event captured on source editor, scheduling auto upload')
        // 等宿主完成粘贴插入，再扫描并替换
        setTimeout(() => {
          triggerAutoUploadIfEnabled(context).catch(() => {})
        }, 160)
      }

      editor.addEventListener('paste', handler, true)
      anyEditor._piclistAutoPasteBound = true
      debugLog('bindAutoUploadOnPaste: bound on source editor', editor)
      return true
    }

    const bindWysiwyg = () => {
      // 所见模式下的 ProseMirror 根节点
      const pm =
        document.querySelector('.container.wysiwyg-v2 .ProseMirror') ||
        document.querySelector('#md-wysiwyg-root .ProseMirror')
      if (!pm) return false
      const anyPm = /** @type {any} */ (pm)
      if (anyPm._piclistAutoPasteBound) return true

      const handler = () => {
        debugLog('paste event captured on ProseMirror, scheduling auto upload')
        setTimeout(() => {
          triggerAutoUploadIfEnabled(context).catch(() => {})
        }, 200)
      }

      pm.addEventListener('paste', handler, true)
      anyPm._piclistAutoPasteBound = true
      debugLog('bindAutoUploadOnPaste: bound on ProseMirror', pm)
      return true
    }

    const tryBind = () => {
      const a = bindSourceEditor()
      const b = bindWysiwyg()
      return a || b
    }

    if (!tryBind()) {
      debugLog('bindAutoUploadOnPaste: editor/ProseMirror not ready, will retry')
      const timer = setInterval(() => {
        if (tryBind()) {
          debugLog('bindAutoUploadOnPaste: bind success after retry')
          clearInterval(timer)
        }
      }, 600)
    }
  } catch {}
}

export async function activate(context) {
  _globalContext = context
  try {
    if (typeof window !== 'undefined') {
      // 提供给宿主（所见模式）调用的全局钩子：在 WYSIWYG 每次写回 Markdown 后触发自动上传
      const anyWin = /** @type {any} */ (window)
      anyWin.flymdPiclistAutoUpload = () => {
        if (_globalContext) {
          triggerAutoUploadIfEnabled(_globalContext).catch(() => {})
        }
      }
    }
  } catch {}

  debugLog('activate: PicList uploader plugin activated')
  context.ui.notice && context.ui.notice('PicList 图床插件已激活', 'ok', 2000)

  // 绑定粘贴事件：检测由粘贴生成的本地 pasted- 图片路径，并自动上传到 PicList
  bindAutoUploadOnPaste(context)

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
              debugLog('menu.uploadSelected: clicked')
              const sel = context.getSelection ? context.getSelection() : null
              const full = context.getEditorValue ? context.getEditorValue() : ''
              if (!sel || typeof sel.start !== 'number' || typeof sel.end !== 'number' || sel.end <= sel.start) {
                context.ui.notice('请先在源码模式中选中图片路径或 Markdown 图片语法', 'err', 2600)
                return
              }
              const raw = String(full || '').slice(sel.start, sel.end)
              debugLog('menu.uploadSelected: selected raw =', raw)
              if (!looksLikeImageText(raw)) {
                context.ui.notice('选中文本不像是图片路径或 Markdown 图片语法', 'err', 2600)
                return
              }

              const info = extractImageInfoFromSelection(raw)
              debugLog('menu.uploadSelected: parsed info =', info)
              if (!info || !info.path) {
                context.ui.notice('无法从选中文本解析出图片路径', 'err', 2600)
                return
              }

              const filePath =
                (typeof context.getCurrentFilePath === 'function' && context.getCurrentFilePath()) || null
              const absPath = resolveImageAbsolutePath(info.path, filePath)
              debugLog('menu.uploadSelected: absPath =', absPath, 'filePath =', filePath)
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
      condition: (ctx) => {
        if (!ctx) return false
        const s = (ctx.selectedText || '').trim()
        // 源码模式：有选中文本且像图片语法时显示
        if (s && looksLikeImageText(s)) return true
        // 所见模式：即便选中文本为空，也允许显示菜单，由点击逻辑去解析最近的图片
        if (ctx.mode === 'wysiwyg') return true
        return false
      },
      onClick: async (ctx) => {
        try {
          debugLog('contextMenu.uploadSelected: clicked ctx =', ctx)
          if (!ctx) return
          let selected = (ctx.selectedText || '').trim()
          debugLog('contextMenu.uploadSelected: selected =', selected, 'mode =', ctx.mode)

          const fullSource =
            (typeof context.getSourceText === 'function' && context.getSourceText()) ||
            (typeof context.getEditorValue === 'function' && context.getEditorValue()) ||
            ''
          const full = String(fullSource || '')

          let info = null
          let range = null

          if (selected && looksLikeImageText(selected)) {
            info = extractImageInfoFromSelection(selected)
            debugLog('contextMenu.uploadSelected: parsed from selection =', info)
            if (!info || !info.path) {
              context.ui.notice('无法从选中文本解析出图片路径', 'err', 2600)
              return
            }
            const idx = full.indexOf(selected)
            if (idx >= 0) {
              range = { start: idx, end: idx + selected.length }
            }
          } else {
            // 所见模式或选中文本为空：回退为使用文档中最后一个 pasted- 本地图片
            const found = findLastPastedImageInSource(context)
            if (!found || !found.info || !found.info.path) {
              context.ui.notice('未找到可上传的本地图片，请先粘贴图片或在源码模式中选中图片语法', 'err', 3200)
              return
            }
            info = found.info
            selected = found.text
            range = { start: found.start, end: found.end }
            debugLog('contextMenu.uploadSelected: fallback to last pasted image =', found)
          }

          if (!info || !info.path) {
            context.ui.notice('无法解析图片路径', 'err', 2600)
            return
          }

          const filePath =
            ctx.filePath ||
            (typeof context.getCurrentFilePath === 'function' && context.getCurrentFilePath()) ||
            null
          const absPath = resolveImageAbsolutePath(info.path, filePath)
          debugLog('contextMenu.uploadSelected: absPath =', absPath, 'filePath =', filePath)
          const url = await uploadViaPicList(context, absPath)

          const replacement = buildReplacementMarkdown(info, url)
          if (!replacement) {
            context.ui.notice('上传成功，但生成替换内容失败', 'err', 2600)
            return
          }

          if (range && typeof context.replaceRange === 'function') {
            context.replaceRange(range.start, range.end, replacement)
          } else {
            const sel = context.getSelection ? context.getSelection() : null
            if (!sel || typeof sel.start !== 'number' || typeof sel.end !== 'number' || sel.end <= sel.start) {
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

    // 自动上传开关
    const autoRow = document.createElement('div')
    autoRow.style.display = 'flex'
    autoRow.style.alignItems = 'center'
    autoRow.style.marginTop = '4px'

    const autoChk = document.createElement('input')
    autoChk.type = 'checkbox'
    autoChk.id = 'piclist-auto-upload'
    autoChk.style.marginRight = '6px'

    const autoLab = document.createElement('label')
    autoLab.htmlFor = 'piclist-auto-upload'
    autoLab.textContent = '启用自动上传（粘贴图片后自动上传到 PicList）'

    autoRow.appendChild(autoChk)
    autoRow.appendChild(autoLab)
    form.appendChild(autoRow)

    inputs.autoUploadEnabled = autoChk

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
          autoUploadEnabled: !!inputs.autoUploadEnabled.checked,
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
  if (inputs.autoUploadEnabled) {
    inputs.autoUploadEnabled.checked = !!cfg.autoUploadEnabled
  }

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
