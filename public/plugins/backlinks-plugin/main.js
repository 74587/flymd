// 简单的双向链接插件：基于 [[名称]] 语法建立文档之间的引用关系
// 设计目标：
// 1. 完全只读：不修改任何用户文档内容
// 2. 不依赖元数据：文件名/正文标题即可参与链接
// 3. 先实现“可用”的反向链接列表，性能优化以后再说

// 内部状态：全部放内存里，必要时用 storage 做简单缓存
let indexState = {
  // 文档基本信息：key 为绝对路径
  // 注意：Map 的 key 使用“规范化路径”（统一斜杠），值里再保存真实路径
  docs: new Map(), // normPath -> { path, name, title }
  // 正向链接：A -> Set<B>
  forward: new Map(), // normPath -> Set<normPath>
  // 反向链接：B -> Set<A>
  backward: new Map(), // normPath -> Set<normPath>
  // 用于简单判断索引是否可用
  builtAt: 0,
  vaultRoot: '',
}

// 周期刷新定时器与 Panel 根节点引用
let _pollTimer = null
let _panelRoot = null
let _panelHandle = null
// AI 推荐缓存：normPath -> [{ path, title, name }]
const _aiRelatedCache = new Map()
// 文档内容签名缓存：normPath -> hash，用于增量更新当前文档索引
const _docHashCache = new Map()
// 内联链接补全状态与编辑器监听
let _linkSuggestBox = null
let _linkSuggestState = {
  active: false,
  from: 0,
  to: 0,
  items: [],
  index: 0,
}
let _editorKeydownHandler = null
let _editorKeyupHandler = null

// 规范化路径：统一为 / 分隔，去掉多余空白，避免 Windows 与 Tauri 不同风格导致匹配失败
function normalizePath(path) {
  if (!path) return ''
  const s = String(path).trim()
  if (!s) return ''
  return s.replace(/\\/g, '/')
}

// 名称规范化：用于匹配 [[Name]] / [[Name#Heading]]
function normalizeNameForMatch(name) {
  if (!name) return ''
  let s = String(name).trim().toLowerCase()
  // 去掉成对括号内的附加说明（如 (PDF 原文)）
  s = s.replace(/[（(].*?[)）]/g, '')
  // 替换分隔符为单空格
  s = s.replace(/[_\-\/\\]+/g, ' ')
  // 折叠多余空白
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

// 简单字符串哈希：用于检测文档内容是否变化（不追求安全性）
function hashText(str) {
  try {
    let h = 0
    const s = String(str || '')
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0
    }
    return h.toString(16)
  } catch {
    return ''
  }
}

// 创建/获取链接补全下拉框 DOM
function ensureLinkSuggestBox() {
  if (_linkSuggestBox) return _linkSuggestBox
  const box = document.createElement('div')
  box.id = 'backlinks-link-suggest'
  box.style.position = 'absolute'
  // 提示框层级要压过库侧栏/预览浮层
  box.style.zIndex = '99999'
  box.style.minWidth = '220px'
  box.style.maxHeight = '260px'
  box.style.overflowY = 'auto'
  box.style.background = 'var(--bg, #fff)'
  box.style.border = '1px solid rgba(0,0,0,0.15)'
  box.style.borderRadius = '4px'
  box.style.boxShadow = '0 4px 12px rgba(0,0,0,0.12)'
  box.style.fontSize = '13px'
  box.style.display = 'none'

  const container = document.querySelector('.container')
  if (container) container.appendChild(box)
  else document.body.appendChild(box)

  _linkSuggestBox = box
  return box
}

function hideLinkSuggest() {
  _linkSuggestState.active = false
  _linkSuggestState.items = []
  const box = _linkSuggestBox
  if (box) box.style.display = 'none'
}

// 将 Map/Set 转为可序列化对象，用于 storage
function serializeIndexState(state) {
  const serializeMapSet = (m) => {
    const obj = {}
    for (const [k, v] of m.entries()) {
      if (v instanceof Set) {
        obj[k] = Array.from(v)
      } else {
        obj[k] = v
      }
    }
    return obj
  }
  return {
    docs: serializeMapSet(state.docs),
    forward: serializeMapSet(state.forward),
    backward: serializeMapSet(state.backward),
    builtAt: state.builtAt,
    vaultRoot: state.vaultRoot,
  }
}

function deserializeIndexState(raw) {
  const next = {
    docs: new Map(),
    forward: new Map(),
    backward: new Map(),
    builtAt: 0,
    vaultRoot: '',
  }
  if (!raw || typeof raw !== 'object') return next
  try {
    if (raw.docs && typeof raw.docs === 'object') {
      for (const k of Object.keys(raw.docs)) {
        next.docs.set(k, raw.docs[k])
      }
    }
    if (raw.forward && typeof raw.forward === 'object') {
      for (const k of Object.keys(raw.forward)) {
        const arr = raw.forward[k]
        next.forward.set(k, new Set(Array.isArray(arr) ? arr : []))
      }
    }
    if (raw.backward && typeof raw.backward === 'object') {
      for (const k of Object.keys(raw.backward)) {
        const arr = raw.backward[k]
        next.backward.set(k, new Set(Array.isArray(arr) ? arr : []))
      }
    }
    if (raw.builtAt && typeof raw.builtAt === 'number') {
      next.builtAt = raw.builtAt
    }
    if (raw.vaultRoot && typeof raw.vaultRoot === 'string') {
      next.vaultRoot = raw.vaultRoot
    }
  } catch {
    // 反序列化失败就丢弃，走空索引
  }
  return next
}

// 从正文里猜标题：找首个一级标题
function guessTitleFromBody(body) {
  if (!body || typeof body !== 'string') return ''
  const m = body.match(/^#\s+(.+)$/m)
  return (m && m[1] && String(m[1]).trim()) || ''
}

// 根据路径得到文件名（不含扩展名）
function getDocNameFromPath(path) {
  if (!path) return ''
  const parts = String(path).split(/[\\/]/)
  const name = parts[parts.length - 1] || ''
  return name.replace(/\.[^.]+$/, '')
}

// 从一篇文档的文本里解析所有 [[名称]] 链接
function extractWikiLinks(text) {
  const links = []
  if (!text || typeof text !== 'string') return links
  const re = /\[\[([^\]]+)\]\]/g
  let m
  while ((m = re.exec(text)) != null) {
    let raw = (m[1] || '').trim()
    if (!raw) continue

    // 处理管道：[[Name|显示名]]
    const pipeIdx = raw.indexOf('|')
    if (pipeIdx >= 0) {
      raw = raw.slice(0, pipeIdx).trim()
    }

    // 仅锚点：[[#Heading]] 或 [[^block-id]]，视为“当前文档内部跳转”，不参与跨文档链接
    if (raw.startsWith('#') || raw.startsWith('^')) continue

    // Obsidian 风格：[[Name#Heading]] / [[Name#^block-id]]
    const hashIdx = raw.indexOf('#')
    if (hashIdx >= 0) {
      raw = raw.slice(0, hashIdx).trim()
    }

    // 块引用：[[Name^block-id]]
    const caretIdx = raw.indexOf('^')
    if (caretIdx >= 0) {
      raw = raw.slice(0, caretIdx).trim()
    }

    if (!raw) continue
    links.push(raw)
  }
  return links
}

// 在 docs 列表中，对一个“名称”解析成目标文档路径
// 匹配策略（按优先级）：
// 1) 文件名完全匹配（规范化后）
// 2) 标题完全匹配（规范化后）
// 3) 文件名去括号部分匹配（规范化后）
// 4) 标题去括号部分匹配（规范化后）
function resolveLinkTarget(name, docsMap) {
  const raw = String(name || '').trim()
  if (!raw) return null

  const targetA = normalizeNameForMatch(raw)
  if (!targetA) return null

  let bestPath = null
  let bestScore = 0

  for (const [normPath, info] of docsMap.entries()) {
    const docName = info.name || ''
    const title = info.title || ''

    const nameNorm = normalizeNameForMatch(docName)
    const titleNorm = normalizeNameForMatch(title)

    // 1) 文件名完全匹配
    if (nameNorm && nameNorm === targetA) {
      return normPath
    }

    // 2) 标题完全匹配
    if (titleNorm && titleNorm === targetA && bestScore < 3) {
      bestScore = 3
      bestPath = normPath
      continue
    }

    // 3/4) 去掉括号后的匹配
    const nameCore = normalizeNameForMatch(docName.replace(/[（(].*?[)）]/g, ''))
    const titleCore = normalizeNameForMatch(title.replace(/[（(].*?[)）]/g, ''))

    if (nameCore && nameCore === targetA && bestScore < 2) {
      bestScore = 2
      bestPath = normPath
      continue
    }
    if (titleCore && titleCore === targetA && bestScore < 1) {
      bestScore = 1
      bestPath = normPath
    }
  }

  return bestPath
}

// 工具：安全地调用 context.storage.get
async function loadIndexFromStorage(context) {
  try {
    const raw = await context.storage.get('backlinksIndex_v1')
    indexState = deserializeIndexState(raw)
  } catch {
    indexState = deserializeIndexState(null)
  }
}

// 工具：安全地调用 context.storage.set
async function saveIndexToStorage(context) {
  try {
    const data = serializeIndexState(indexState)
    await context.storage.set('backlinksIndex_v1', data)
  } catch {
    // 存储失败不影响正常使用
  }
}

// 获取 AI 助手插件的 API（若不可用则返回 null）
async function getAiApi(context) {
  try {
    if (!context || typeof context.getPluginAPI !== 'function') return null
    const api = context.getPluginAPI('ai-assistant')
    if (!api || typeof api.callAI !== 'function') return null
    if (typeof api.isConfigured === 'function') {
      const ok = await api.isConfigured()
      if (!ok) return null
    }
    return api
  } catch {
    return null
  }
}

// 从大模型返回的文本里尽量提取出一个 id（字符串）
function extractIdFromAiReply(text) {
  if (!text || typeof text !== 'string') return null
  const raw = text.trim()
  if (!raw) return null
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s)
      if (typeof v === 'string') return v
      if (Array.isArray(v)) {
        if (typeof v[0] === 'string') return v[0]
        if (v[0] && typeof v[0].id === 'string') return v[0].id
      }
      if (v && typeof v.id === 'string') return v.id
    } catch {}
    return null
  }
  let id = tryParse(raw)
  if (id) return String(id).trim() || null
  const mObj = raw.match(/\{[\s\S]*?\}/)
  if (mObj) {
    id = tryParse(mObj[0])
    if (id) return String(id).trim() || null
  }
  const mArr = raw.match(/\[[\s\S]*?\]/)
  if (mArr) {
    id = tryParse(mArr[0])
    if (id) return String(id).trim() || null
  }
  return null
}

// 核心：重建索引
async function rebuildIndex(context) {
  const root = await context.getLibraryRoot()
  if (!root) {
    context.ui.notice('当前未打开任何库，无法建立链接索引', 'err')
    return
  }

  // 通过后端列出库内所有 markdown 文件
  // 这里调用的是宿主侧命令，名字需要在 Tauri 中实现；
  // 如果当前版本没有这个命令，你可以先人为约定：只在插件菜单里对“当前文件”做局部索引。
  let files = []
  try {
    files = await context.invoke('flymd_list_markdown_files', { root })
    if (!Array.isArray(files)) files = []
  } catch (e) {
    // 如果后端命令未实现，退化为让用户手动选择需要索引的文件
    context.ui.showNotification(
      '未找到全库扫描命令，请手动选择需要索引的文档',
      { type: 'info', duration: 5000 },
    )
    try {
      const picked = await context.pickDocFiles({ multiple: true })
      if (picked && Array.isArray(picked) && picked.length > 0) {
        files = picked
        context.ui.notice(
          '已选择 ' + picked.length + ' 个文档用于建立链接索引',
          'ok',
          2500,
        )
      } else {
        context.ui.notice('未选择任何文档，索引为空', 'err', 2500)
        return
      }
    } catch {
      const cur = context.getCurrentFilePath()
      if (cur) {
        files = [cur]
        context.ui.showNotification(
          '回退为仅对当前文件建立索引（无法自动扫描库）',
          { type: 'info', duration: 5000 },
        )
      } else {
        context.ui.showNotification(
          '无法获得文档列表，且当前文件未保存，索引失败',
          { type: 'error', duration: 4000 },
        )
        return
      }
    }
  }

  if (!files || !files.length) {
    context.ui.notice('没有可索引的文档', 'err', 2500)
    return
  }

  // 第一步：收集所有文档的基本信息和全文内容（两遍算法，避免“后出现的文档无法被前面的链接解析”）
  const docs = new Map()
  const texts = new Map()
  const groups = new Map() // 额外分组：当前用于 PDF 原文/翻译成对识别

  for (const path of files) {
    if (!path || typeof path !== 'string') continue
    const norm = normalizePath(path)
    if (!norm) continue

    let text = ''
    try {
      const cur = context.getCurrentFilePath && context.getCurrentFilePath()
      if (cur && normalizePath(cur) === norm) {
        text = context.getSourceText()
      } else {
        const bytes = await context.readFileBinary(path)
        const decoder = new TextDecoder('utf-8')
        text = decoder.decode(bytes)
      }
    } catch {
      continue
    }

    const docName = getDocNameFromPath(path)
    const titleFromBody = guessTitleFromBody(text)
    const title = titleFromBody || docName
    const info = { path, name: docName, title }

    // 特判：PDF 原文 / PDF 翻译 成对文档，自动建立“兄弟关系”
    // 例如：deepseek (PDF 原文).md / deepseek (PDF 翻译).md
    const mPdf = docName.match(/^(.*)\s*\(PDF\s*(原文|翻译)\)\s*$/)
    if (mPdf && mPdf[1]) {
      info.pdfGroupKey = mPdf[1].trim()
      const k = 'pdf:' + info.pdfGroupKey
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(norm)
    }

    docs.set(norm, info)
    texts.set(norm, text)
  }

  // 第二步：基于完整 docs 列表解析双向链接关系
  const forward = new Map()
  const backward = new Map()
  const unresolved = [] // { from: normPath, name: string }

  for (const path of files) {
    if (!path || typeof path !== 'string') continue
    const norm = normalizePath(path)
    if (!norm) continue
    const text = texts.get(norm)
    if (typeof text !== 'string') continue

    const links = extractWikiLinks(text)
    if (!links.length) continue

    const outSet = new Set()
    for (const lk of links) {
      const targetPath = resolveLinkTarget(lk, docs)
      if (!targetPath) {
        // 无法直接解析的链接，留给 AI 兜底
        unresolved.push({ from: norm, name: lk })
        continue
      }
      if (targetPath === norm) continue
      outSet.add(targetPath)
      // 反向表
      if (!backward.has(targetPath)) {
        backward.set(targetPath, new Set())
      }
      backward.get(targetPath).add(norm)
    }
    if (outSet.size > 0) {
      forward.set(norm, outSet)
    }
  }

  // 第三步：为 PDF 原文/翻译这类“兄弟文档”自动加上互相链接（无需 [[...]]）
  for (const paths of groups.values()) {
    if (!paths || paths.length < 2) continue
    for (let i = 0; i < paths.length; i++) {
      for (let j = 0; j < paths.length; j++) {
        if (i === j) continue
        const src = paths[i]
        const dst = paths[j]
        if (!forward.has(src)) forward.set(src, new Set())
        forward.get(src).add(dst)
        if (!backward.has(dst)) backward.set(dst, new Set())
        backward.get(dst).add(src)
      }
    }
  }

  // 第四步：使用 AI 对无法解析的 [[Name]] 链接进行兜底匹配（使用免费 Qwen 模型）
  await tryAiResolveUnmatchedLinks(context, docs, forward, backward, unresolved)

  indexState.docs = docs
  indexState.forward = forward
  indexState.backward = backward
  indexState.builtAt = Date.now()
  indexState.vaultRoot = root

  await saveIndexToStorage(context)
  context.ui.showNotification('双向链接索引已重建', {
    type: 'success',
    duration: 2500,
  })
}

// 使用 AI（Qwen 免费模型）为无法解析的 [[Name]] 链接做兜底匹配
async function tryAiResolveUnmatchedLinks(context, docs, forward, backward, unresolved) {
  try {
    if (!unresolved || !unresolved.length) return

    const ai = await getAiApi(context)
    if (!ai) return

    // 按名称归组，避免对同一个 [[Name]] 反复调用
    const groups = new Map() // key -> { display: string, froms: Set<normPath> }
    for (const item of unresolved) {
      if (!item || !item.name || !item.from) continue
      const key = normalizeNameForMatch(item.name)
      if (!key) continue
      let g = groups.get(key)
      if (!g) {
        g = { display: item.name, froms: new Set() }
        groups.set(key, g)
      }
      g.froms.add(item.from)
    }
    if (!groups.size) return

    const allGroups = Array.from(groups.values())
    const MAX_GROUPS = 8 // 防止一次性 AI 调用过多

    for (let idx = 0; idx < allGroups.length && idx < MAX_GROUPS; idx++) {
      const g = allGroups[idx]
      const nameRaw = g.display
      const nameNorm = normalizeNameForMatch(nameRaw)
      if (!nameNorm) continue

      // 构造候选文档：只取与名称有一定相似度的文档，最多 24 个
      const candidates = []
      for (const [id, info] of docs.entries()) {
        const fn = normalizeNameForMatch(info.name || '')
        const tt = normalizeNameForMatch(info.title || '')
        let score = 0
        if (fn && fn === nameNorm) score += 3
        if (tt && tt === nameNorm) score += 3
        if (!score && fn && (fn.includes(nameNorm) || nameNorm.includes(fn))) score += 2
        if (!score && tt && (tt.includes(nameNorm) || nameNorm.includes(tt))) score += 2
        if (!score && fn && tt && (fn.includes(tt) || tt.includes(fn))) score += 1
        if (score > 0) {
          candidates.push({
            id,
            score,
            name: info.name || '',
            title: info.title || info.name || '',
          })
        }
      }

      if (!candidates.length) continue
      candidates.sort((a, b) => b.score - a.score)
      const limited = candidates.slice(0, 24)

      const prompt = [
        '你是一个 Markdown 知识库的链接解析助手。',
        '用户在多篇笔记中写了形如 [[Name]] 的内部链接，这里的 Name 是："' + nameRaw + '"。',
        '下面是候选目标文档列表，请从中选出最有可能被 [[Name]] 指向的那一篇。',
        '如果所有候选看起来都不合适，就返回 null。',
        '',
        '候选文档列表（JSON 数组）：',
        JSON.stringify(
          limited.map((c) => ({
            id: c.id,
            fileName: c.name,
            title: c.title,
          })),
          null,
          2,
        ),
        '',
        '请严格返回一个 JSON 对象，格式如下：',
        '{"id": "候选文档 id"} 或 {"id": null}，不要输出任何其它文字。',
      ].join('\n')

      let reply = ''
      try {
        reply = await ai.callAI(prompt, {
          system: '你是严谨的中文知识库链接解析助手，只输出 JSON。',
          cfgOverride: { provider: 'free', freeModel: 'qwen' },
        })
      } catch (err) {
        console.error('[backlinks] AI 解析 [[', nameRaw, ']] 失败:', err)
        continue
      }

      const pickedId = extractIdFromAiReply(reply)
      if (!pickedId) continue
      if (!docs.has(pickedId)) continue

      // 把 AI 选择的目标加入链接图
      for (const from of g.froms.values()) {
        if (!from || from === pickedId) continue
        if (!forward.has(from)) forward.set(from, new Set())
        forward.get(from).add(pickedId)
        if (!backward.has(pickedId)) backward.set(pickedId, new Set())
        backward.get(pickedId).add(from)
      }
    }
  } catch (e) {
    console.error('[backlinks] tryAiResolveUnmatchedLinks error:', e)
  }
}

// 获取当前文档的反向链接列表
function getBacklinksForCurrent(context) {
  // 增量更新当前文档的出链索引（基于编辑器内容）
  try {
    updateIndexForCurrentDocIfNeeded(context)
  } catch (e) {
    console.error('[backlinks] 增量更新当前文档索引失败:', e)
  }

  const path = context.getCurrentFilePath && context.getCurrentFilePath()
  const norm = normalizePath(path)
  if (!norm) return []

  const fromSet = indexState.backward.get(norm)
  if (!fromSet || !fromSet.size) return []
  const items = []
  for (const srcKey of fromSet.values()) {
    const info = indexState.docs.get(srcKey) || {}
    const realPath = info.path || srcKey
    items.push({
      path: realPath,
      title: info.title || getDocNameFromPath(realPath),
      name: info.name || getDocNameFromPath(realPath),
    })
  }
  items.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
  return items
}

// 若当前文档内容发生变化，则仅重建该文档的正/反向链接索引
function updateIndexForCurrentDocIfNeeded(context) {
  if (!context || typeof context.getCurrentFilePath !== 'function') return
  const path = context.getCurrentFilePath()
  const norm = normalizePath(path)
  if (!norm) return
  if (typeof context.getSourceText !== 'function') return
  const text = context.getSourceText()
  if (typeof text !== 'string') return

  const newHash = hashText(text)
  const oldHash = _docHashCache.get(norm)
  if (oldHash && oldHash === newHash) return
  _docHashCache.set(norm, newHash)

  // 若索引尚未建立（docs 为空），不做任何操作，避免误报
  if (!indexState || !indexState.docs || !indexState.docs.size) return

  const docs = indexState.docs
  const forward = indexState.forward
  const backward = indexState.backward

  // 更新当前文档的基本信息
  const docName = getDocNameFromPath(path)
  const titleFromBody = guessTitleFromBody(text)
  const title = titleFromBody || docName
  const info = { path, name: docName, title }
  docs.set(norm, info)

  // 清理旧的出链和对应的反向链接
  const oldTargets = forward.get(norm)
  if (oldTargets && oldTargets.size) {
    for (const t of oldTargets.values()) {
      const set = backward.get(t)
      if (set) {
        set.delete(norm)
        if (!set.size) {
          backward.delete(t)
        }
      }
    }
  }
  forward.delete(norm)

  // 重新解析当前文档的 [[...]] 链接
  const links = extractWikiLinks(text)
  if (!links || !links.length) return

  const outSet = new Set()
  for (const lk of links) {
    const targetPath = resolveLinkTarget(lk, docs)
    if (!targetPath || targetPath === norm) continue
    outSet.add(targetPath)
    if (!backward.has(targetPath)) {
      backward.set(targetPath, new Set())
    }
    backward.get(targetPath).add(norm)
  }
  if (outSet.size > 0) {
    forward.set(norm, outSet)
  }
}

// 绑定源码编辑器事件，实现 [[标题]] 自动补全
function bindEditorForLinkSuggest(context) {
  try {
    const ed =
      document.getElementById('editor') ||
      document.querySelector('textarea.editor')
    if (!ed) return

    const editor = ed
    const box = ensureLinkSuggestBox()

    _editorKeydownHandler = (e) => {
      if (!_linkSuggestState.active) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
      } else {
        return
      }

      if (!_linkSuggestState.items.length) {
        hideLinkSuggest()
        return
      }

      if (e.key === 'ArrowDown') {
        _linkSuggestState.index =
          (_linkSuggestState.index + 1) % _linkSuggestState.items.length
        renderLinkSuggestBox(editor)
      } else if (e.key === 'ArrowUp') {
        _linkSuggestState.index =
          (_linkSuggestState.index - 1 + _linkSuggestState.items.length) %
          _linkSuggestState.items.length
        renderLinkSuggestBox(editor)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        applyLinkSuggestion(context)
      } else if (e.key === 'Escape') {
        hideLinkSuggest()
      }
    }

    _editorKeyupHandler = () => {
      // 所见模式下不处理
      if (document.body.classList.contains('wysiwyg-v2')) {
        hideLinkSuggest()
        return
      }
      updateLinkSuggestForEditor(context, editor)
    }

    editor.addEventListener('keydown', _editorKeydownHandler, true)
    editor.addEventListener('keyup', _editorKeyupHandler, true)

    editor.addEventListener(
      'blur',
      () => {
        hideLinkSuggest()
      },
      true,
    )
  } catch (e) {
    console.error('[backlinks] 绑定编辑器补全事件失败', e)
  }
}

// 计算当前光标是否处于 [[...]] 内部，并更新补全列表
function updateLinkSuggestForEditor(context, editor) {
  try {
    if (!editor || typeof editor.value !== 'string') {
      hideLinkSuggest()
      return
    }
    const text = editor.value
    const caret = editor.selectionStart >>> 0
  const before = text.slice(0, caret)
  const openIdx = before.lastIndexOf('[[')
  if (openIdx < 0) {
    hideLinkSuggest()
    return
  }
  // 若 [[ 之前是转义符号 \，视为字面量，忽略补全
  if (openIdx > 0 && before.charAt(openIdx - 1) === '\\') {
    hideLinkSuggest()
    return
  }
    // [[ 与光标之间不能已有 ]]
    if (before.indexOf(']]', openIdx + 2) !== -1) {
      hideLinkSuggest()
      return
    }
    const query = before.slice(openIdx + 2)
    if (!query || /\n/.test(query)) {
      hideLinkSuggest()
      return
    }

    // 构造候选：从 docs 中按名称匹配
    if (!indexState.docs || !indexState.docs.size) {
      hideLinkSuggest()
      return
    }

    const qNorm = normalizeNameForMatch(query)
    if (!qNorm) {
      hideLinkSuggest()
      return
    }

    const items = []
    for (const [, info] of indexState.docs.entries()) {
      const nameNorm = normalizeNameForMatch(info.name || '')
      const titleNorm = normalizeNameForMatch(info.title || '')
      let score = 0
      if (nameNorm === qNorm) score += 5
      if (titleNorm === qNorm) score += 5
      if (!score && nameNorm && nameNorm.includes(qNorm)) score += 3
      if (!score && titleNorm && titleNorm.includes(qNorm)) score += 3
      if (!score && qNorm && (qNorm.includes(nameNorm) || qNorm.includes(titleNorm))) score += 1
      if (score > 0) {
        items.push({
          score,
          title: info.title || info.name || '',
          name: info.name || '',
        })
      }
    }

    if (!items.length) {
      hideLinkSuggest()
      return
    }

    items.sort((a, b) => b.score - a.score)
    _linkSuggestState.active = true
    _linkSuggestState.from = openIdx
    _linkSuggestState.to = caret
    _linkSuggestState.items = items.slice(0, 20)
    _linkSuggestState.index = 0
    renderLinkSuggestBox(editor)
  } catch (e) {
    console.error('[backlinks] updateLinkSuggestForEditor error', e)
    hideLinkSuggest()
  }
}

// 渲染下拉框 UI
function renderLinkSuggestBox(editor) {
  const box = ensureLinkSuggestBox()
  const { items, index } = _linkSuggestState
  if (!items || !items.length) {
    box.style.display = 'none'
    return
  }

  box.innerHTML = ''
  items.forEach((item, i) => {
    const row = document.createElement('div')
    row.style.padding = '4px 8px'
    row.style.cursor = 'pointer'
    row.style.whiteSpace = 'nowrap'
    if (i === index) {
      row.style.background = 'rgba(56, 189, 248, 0.12)'
    }
    const t = document.createElement('div')
    t.textContent = item.title
    t.style.fontWeight = '500'
    const n = document.createElement('div')
    n.textContent = item.name
    n.style.fontSize = '11px'
    n.style.color = '#888'
    row.appendChild(t)
    row.appendChild(n)
    row.addEventListener('mouseenter', () => {
      _linkSuggestState.index = i
      renderLinkSuggestBox(editor)
    })
    row.addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      _linkSuggestState.index = i
      applyLinkSuggestionForEditor(editor, window.__backlinksContext || null)
    })
    box.appendChild(row)
  })

  const rect = editor.getBoundingClientRect()
  // 简单放在编辑器左上角偏下一点，避免过于突兀
  box.style.left = rect.left + 24 + 'px'
  box.style.top = rect.top + 32 + 'px'
  box.style.display = 'block'
}

// 将当前选中的补全项写回编辑器/文档
function applyLinkSuggestion(context) {
  try {
    const ed =
      document.getElementById('editor') ||
      document.querySelector('textarea.editor')
    if (!ed) {
      hideLinkSuggest()
      return
    }
    applyLinkSuggestionForEditor(ed, context)
  } catch (e) {
    console.error('[backlinks] applyLinkSuggestion error', e)
    hideLinkSuggest()
  }
}

function applyLinkSuggestionForEditor(editor, context) {
  const state = _linkSuggestState
  if (!state.active || !state.items || !state.items.length) {
    hideLinkSuggest()
    return
  }
  const item = state.items[state.index] || state.items[0]
  if (!item) {
    hideLinkSuggest()
    return
  }
  const label = item.title || item.name
  if (!label) {
    hideLinkSuggest()
    return
  }
  const from = state.from >>> 0
  const text = String(editor.value || '')
  const beforeWhole = text.slice(0, from)
  const sub = text.slice(from)
  const closeRel = sub.indexOf(']]')

  let newValue = ''
  let caret = 0
  const wrapped = '[[' + label + ']]'

  if (closeRel >= 0) {
    // 已经存在 ]]，只替换 [[ 和 ]] 之间的内容
    const after = sub.slice(closeRel + 2)
    newValue = beforeWhole + wrapped + after
    caret = beforeWhole.length + wrapped.length
  } else {
    // 没有现成的 ]]，直接在光标处插入完整 [[title]]
    const to = state.to >>> 0
    const before = text.slice(0, from)
    const after = text.slice(to)
    newValue = before + wrapped + after
    caret = before.length + wrapped.length
  }

  editor.value = newValue
  editor.selectionStart = caret
  editor.selectionEnd = caret
  if (context && typeof context.setEditorValue === 'function') {
    context.setEditorValue(editor.value)
  }
  hideLinkSuggest()
}

// 在 Panel 中渲染一个极简的反向链接列表
function renderBacklinksPanel(context, panelRoot) {
  const container = panelRoot
  container.innerHTML = ''

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.alignItems = 'center'
  header.style.justifyContent = 'space-between'
  header.style.fontWeight = 'bold'
  header.style.fontSize = '13px'
  header.style.margin = '4px 6px'

  const titleEl = document.createElement('span')
  titleEl.textContent = '反向链接'
  header.appendChild(titleEl)

  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.title = '关闭反向链接面板'
  closeBtn.style.border = 'none'
  closeBtn.style.background = 'transparent'
  closeBtn.style.cursor = 'pointer'
  closeBtn.style.fontSize = '14px'
  closeBtn.style.lineHeight = '1'
  closeBtn.style.padding = '0 4px'
  closeBtn.style.color = '#999'
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.color = '#333'
  })
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.color = '#999'
  })
  closeBtn.onclick = () => {
    try {
      panelRoot.style.display = 'none'
      if (_panelHandle && typeof _panelHandle.setVisible === 'function') {
        _panelHandle.setVisible(false)
      }
    } catch {
      // 忽略关闭异常
    }
  }
  header.appendChild(closeBtn)

  container.appendChild(header)

  const sub = document.createElement('div')
  sub.style.fontSize = '11px'
  sub.style.color = '#888'
  sub.style.margin = '0 6px 4px'
  if (!indexState.builtAt) {
    sub.textContent = '尚未建立索引，请在“插件/双向链接”中手动重建索引'
  } else {
    const d = new Date(indexState.builtAt)
    sub.textContent = '索引时间：' + d.toLocaleString()
  }
  container.appendChild(sub)

  const listWrap = document.createElement('div')
  listWrap.style.overflowY = 'auto'
  listWrap.style.fontSize = '13px'
  listWrap.style.padding = '4px 6px 8px'
  listWrap.style.borderTop = '1px solid rgba(0,0,0,0.06)'
  container.appendChild(listWrap)

  const items = getBacklinksForCurrent(context)
  if (!items.length) {
    const empty = document.createElement('div')
    empty.style.color = '#999'
    empty.style.padding = '4px 0'
    empty.textContent = '没有文档链接到当前笔记'
    listWrap.appendChild(empty)
  } else {
    for (const item of items) {
      const row = document.createElement('div')
      row.style.cursor = 'pointer'
      row.style.padding = '4px 0'
      row.style.borderBottom = '1px solid rgba(0,0,0,0.04)'

      const titleEl = document.createElement('div')
      titleEl.textContent = item.title
      titleEl.style.fontWeight = '500'
      titleEl.style.fontSize = '13px'

      const pathEl = document.createElement('div')
      pathEl.textContent = item.name
      pathEl.style.fontSize = '11px'
      pathEl.style.color = '#999'

      row.appendChild(titleEl)
      row.appendChild(pathEl)

      row.addEventListener('click', () => {
        context.openFileByPath(item.path).catch(() => {
          context.ui.notice('打开文档失败：' + item.title, 'err')
        })
      })

      listWrap.appendChild(row)
    }
  }

  // AI 语义关联文档（Qwen 免费），即使没有任何反向链接也始终可用
  const aiRoot = document.createElement('div')
  aiRoot.style.fontSize = '12px'
  aiRoot.style.padding = '4px 6px 8px'
  aiRoot.style.borderTop = '1px dashed rgba(0,0,0,0.06)'
  aiRoot.style.marginTop = '4px'
  container.appendChild(aiRoot)
  renderAiRelatedSection(context, aiRoot)
}

// 渲染 AI 语义关联文档区域
function renderAiRelatedSection(context, root) {
  const currentPath = context.getCurrentFilePath && context.getCurrentFilePath()
  const norm = normalizePath(currentPath)
  root.innerHTML = ''

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.alignItems = 'center'
  header.style.justifyContent = 'space-between'
  header.style.marginBottom = '4px'

  const title = document.createElement('span')
  title.textContent = 'AI 关联文档 (Qwen 免费)'
  header.appendChild(title)

  const btn = document.createElement('button')
  btn.textContent = '分析'
  btn.style.fontSize = '11px';
  btn.style.padding = '0 6px'
  btn.style.borderRadius = '4px'
  btn.style.border = '1px solid rgba(0,0,0,0.12)'
  btn.style.background = 'transparent'
  btn.style.cursor = 'pointer'

  if (!norm) {
    btn.disabled = true
    btn.textContent = '无当前文档'
  }

  header.appendChild(btn)
  root.appendChild(header)

  const body = document.createElement('div')
  body.style.color = '#666'
  root.appendChild(body)

  const cached = norm && _aiRelatedCache.get(norm)
  if (cached && cached.length) {
    body.innerHTML = ''
    for (const item of cached) {
      const row = document.createElement('div')
      row.style.cursor = 'pointer'
      row.style.padding = '2px 0'

      const t = document.createElement('div')
      t.textContent = item.title
      t.style.fontSize = '12px'
      t.style.fontWeight = '500'

      const n = document.createElement('div')
      n.textContent = item.name
      n.style.fontSize = '11px'
      n.style.color = '#999'

      row.appendChild(t)
      row.appendChild(n)
      // 左键：跳转到该文档
      row.addEventListener('click', () => {
        context.openFileByPath(item.path).catch(() => {
          context.ui.notice('打开文档失败：' + item.title, 'err')
        })
      })
      // 右键：在当前编辑位置插入 [[链接]]
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        const label = item.title || item.name || getDocNameFromPath(item.path)
        if (!label) return
        try {
          context.insertAtCursor(`[[${label}]]`)
          context.ui.notice('已插入链接：[[ ' + label + ' ]]', 'ok', 1600)
        } catch (e) {
          console.error('[backlinks] 插入链接失败', e)
          context.ui.notice('插入链接失败，请切换到编辑模式重试', 'err', 2000)
        }
      })
      body.appendChild(row)
    }
  } else {
    body.textContent = '点击“分析”使用 Qwen 为当前文档推荐相关笔记'
  }

  if (norm) {
    btn.onclick = async () => {
      try {
        btn.disabled = true
        btn.textContent = '分析中...'
        body.textContent = 'AI 正在分析当前文档与其它笔记的关系...'
        await loadAiRelatedDocs(context, norm)
      } finally {
        btn.disabled = false
        btn.textContent = '重新分析'
        // 重新渲染一次，展示最新结果
        renderAiRelatedSection(context, root)
      }
    }
  }
}

// 使用 Qwen 免费模型为当前文档推荐语义相关的笔记
async function loadAiRelatedDocs(context, currentNorm) {
  try {
    const ai = await getAiApi(context)
    if (!ai) {
      context.ui.notice('AI 助手未启用或未配置，无法推荐关联文档', 'err', 3000)
      return
    }
    if (!indexState || !indexState.docs || !indexState.docs.size) {
      context.ui.notice('索引为空，请先重建双向链接索引', 'err', 2500)
      return
    }

    const docs = indexState.docs
    const currentInfo = docs.get(currentNorm)
    const candidates = []
    for (const [id, info] of docs.entries()) {
      if (id === currentNorm) continue
      candidates.push({
        id,
        name: info.name || '',
        title: info.title || info.name || '',
      })
    }
    if (!candidates.length) {
      context.ui.notice('没有可用于推荐的其它文档', 'err', 2500)
      return
    }

    // 限制候选数量，避免 prompt 过长
    const limited = candidates.slice(0, 60)

    const currentMeta = {
      id: currentNorm,
      name: currentInfo ? currentInfo.name || '' : '',
      title: currentInfo ? currentInfo.title || currentInfo.name || '' : '',
    }

    const prompt = [
      '你是一个个人知识库的 AI 助手，需要根据语义相关性推荐关联笔记。',
      '当前笔记信息如下（JSON 对象）：',
      JSON.stringify(currentMeta, null, 2),
      '',
      '下面是同一知识库中的其它候选笔记列表（JSON 数组，每项含 id、name、title）：',
      JSON.stringify(limited, null, 2),
      '',
      '请从候选列表中选出最多 5 篇与你认为最相关的笔记，按相关度从高到低排序。',
      '只在这些候选中选择，不要编造新的 id。',
      '',
      '请严格返回一个只包含 id 字符串的 JSON 数组，例如：',
      '["id1", "id2"]',
      '不要输出任何额外文字。',
    ].join('\n')

    let reply = ''
    try {
      reply = await ai.callAI(prompt, {
        system: '你是中文知识库的关联推荐助手，只输出 JSON 数组。',
        cfgOverride: { provider: 'free', freeModel: 'qwen' },
      })
    } catch (err) {
      console.error('[backlinks] loadAiRelatedDocs 调用 AI 失败:', err)
      context.ui.notice('AI 推荐关联文档失败', 'err', 3000)
      return
    }

    let ids = []
    try {
      const raw = reply && String(reply).trim()
      const m = raw && raw.match(/\[[\s\S]*\]/)
      const json = m ? m[0] : raw
      const parsed = JSON.parse(json)
      if (Array.isArray(parsed)) {
        ids = parsed
          .map((x) =>
            typeof x === 'string' ? x : x && typeof x.id === 'string' ? x.id : null,
          )
          .filter(Boolean)
      }
    } catch (e) {
      console.error('[backlinks] 解析 AI 推荐结果失败:', e, reply)
      context.ui.notice('解析 AI 推荐结果失败', 'err', 3000)
      return
    }

    const items = []
    for (const id of ids) {
      const info = docs.get(id)
      if (!info) continue
      items.push({
        path: info.path || id,
        name: info.name || '',
        title: info.title || info.name || '',
      })
    }
    _aiRelatedCache.set(currentNorm, items)
  } catch (e) {
    console.error('[backlinks] loadAiRelatedDocs error:', e)
  }
}

export async function activate(context) {
  // 启动时先尝试加载已有索引
  await loadIndexFromStorage(context)

  // 注册布局 Panel：放在右侧，宽度固定 260px
  const panelSize = 260
  const panelHandle = context.layout.registerPanel('backlinks', {
    side: 'right',
    size: panelSize,
    visible: true,
  })

  // 在工作区容器右侧追加一个绝对定位 Panel，不依赖是否处于阅读模式
  const container = document.querySelector('.container')
  const panelRoot = document.createElement('div')
  panelRoot.style.position = 'absolute'
  panelRoot.style.top = '0'
  panelRoot.style.right = '0'
  panelRoot.style.bottom = 'var(--workspace-bottom-gap, 0px)'
  panelRoot.style.width = panelSize + 'px'
  panelRoot.style.height = 'auto'
  panelRoot.style.overflow = 'hidden'
  panelRoot.style.borderLeft = '1px solid rgba(0,0,0,0.08)'
  panelRoot.style.background = 'var(--bg-color, #fafafa)'
  panelRoot.style.display = 'flex'
  panelRoot.style.flexDirection = 'column'
  panelRoot.style.zIndex = '8'

  if (container) {
    container.appendChild(panelRoot)
    _panelRoot = panelRoot
    _panelHandle = panelHandle
  } else {
    context.ui.notice('未找到工作区容器，双向链接面板无法挂载', 'err', 2500)
  }

  // 初始渲染
  renderBacklinksPanel(context, panelRoot)

  // 绑定编辑器 [[标题]] 补全
  try {
    // 暴露 context 给内部补全逻辑使用
    window.__backlinksContext = context
    bindEditorForLinkSuggest(context)
  } catch (e) {
    console.error('[backlinks] 初始化链接补全失败', e)
  }

  // 文档切换自动刷新：定期检查当前文件路径变化
  try {
    if (_pollTimer) {
      clearInterval(_pollTimer)
      _pollTimer = null
    }
    let lastPath = normalizePath(
      context.getCurrentFilePath && context.getCurrentFilePath(),
    )
    _pollTimer = window.setInterval(() => {
      try {
        // 始终尝试增量更新当前文档的出链索引
        try {
          updateIndexForCurrentDocIfNeeded(context)
        } catch {}

        const cur = normalizePath(
          context.getCurrentFilePath && context.getCurrentFilePath(),
        )
        // 文档切换：更新 lastPath 并重绘
        if (cur && cur !== lastPath) {
          lastPath = cur
          renderBacklinksPanel(context, panelRoot)
          return
        }
        // 同一文档：也定期重绘，以反映刚编辑完的链接变化
        if (cur) {
          renderBacklinksPanel(context, panelRoot)
        }
      } catch {
        // 忽略刷新过程中的任何异常
      }
    }, 1200)
  } catch {
    // 忽略定时器初始化失败
  }

  // 在“插件”菜单中增加入口：重建索引 + 手动刷新当前反向链接
  context.addMenuItem({
    label: '双向链接',
    children: [
      {
        label: '重建双向链接索引',
        note: '扫描库内所有 Markdown',
        onClick: async () => {
          await rebuildIndex(context)
          renderBacklinksPanel(context, panelRoot)
        },
      },
      {
        label: '刷新当前文档反向链接',
        onClick: () => {
          renderBacklinksPanel(context, panelRoot)
          context.ui.notice('已刷新反向链接列表', 'ok', 1200)
        },
      },
      {
        label: '隐藏/显示反向链接面板',
        onClick: () => {
          const visible = !panelRoot.style.display || panelRoot.style.display !== 'none'
          if (visible) {
            panelRoot.style.display = 'none'
            panelHandle.setVisible(false)
          } else {
            panelRoot.style.display = 'flex'
            panelHandle.setVisible(true)
          }
        },
      },
    ],
  })

  // 编辑器右键菜单：根据选中文本插入 [[双向链接]]
  try {
    context.addContextMenuItem({
      label: '插入双向链接',
      icon: '🔗',
      condition: (ctx) => {
        return ctx.mode === 'edit' && !!ctx.selectedText && ctx.selectedText.trim().length > 0
      },
      onClick: () => {
        try {
          const sel = context.getSelection()
          const raw = (sel && sel.text) || ''
          const label = String(raw).trim()
          if (!label) return
          const wrapped = `[[${label}]]`
          context.replaceRange(sel.start, sel.end, wrapped)
          context.ui.notice('已插入双向链接：' + wrapped, 'ok', 1600)
        } catch (e) {
          console.error('[backlinks] 插入双向链接失败', e)
          context.ui.notice('插入双向链接失败，请在源码模式下重试', 'err', 2000)
        }
      },
    })
  } catch (e) {
    console.error('[backlinks] 注册右键“插入双向链接”失败', e)
  }

  // 选区变化时轻量刷新（用于当前文件切换时手动触发）
  context.onSelectionChange &&
    context.onSelectionChange(() => {
      // 这里不用每次都重建，只重渲染当前文档对应的反向链接
      renderBacklinksPanel(context, panelRoot)
    })
}

export function deactivate() {
  // 清理定时器与 Panel DOM，避免内存泄漏
  try {
    if (_pollTimer) {
      clearInterval(_pollTimer)
      _pollTimer = null
    }
    if (_panelRoot && _panelRoot.parentNode) {
      _panelRoot.parentNode.removeChild(_panelRoot)
    }
    const ed =
      document.getElementById('editor') ||
      document.querySelector('textarea.editor')
    if (ed) {
      if (_editorKeydownHandler) {
        ed.removeEventListener('keydown', _editorKeydownHandler, true)
      }
      if (_editorKeyupHandler) {
        ed.removeEventListener('keyup', _editorKeyupHandler, true)
      }
    }
  } catch {
    // 忽略清理错误
  }
  _panelRoot = null
  _panelHandle = null
  _editorKeydownHandler = null
  _editorKeyupHandler = null
  hideLinkSuggest()
}
