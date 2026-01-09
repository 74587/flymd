// src/exporters/pdf.ts
// 使用 html2pdf.js 将指定 DOM 元素导出为 PDF 字节

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

async function waitForFonts(doc: Document, timeoutMs = 8000): Promise<void> {
  try {
    const ready = (doc as any).fonts?.ready
    if (!ready || typeof ready.then !== 'function') return
    await Promise.race([ready, waitMs(timeoutMs)])
  } catch {}
}

async function waitForImagesIn(root: ParentNode, timeoutMs = 20000): Promise<void> {
  const imgs = Array.from(root.querySelectorAll?.('img') || []) as HTMLImageElement[]
  if (!imgs.length) return

  const tasks = imgs.map(async (img) => {
    try {
      if (img.complete && img.naturalWidth > 0) {
        if (typeof (img as any).decode === 'function') {
          try { await (img as any).decode() } catch {}
        }
        return
      }
    } catch {}

    await new Promise<void>((resolve) => {
      const done = () => resolve()
      try {
        img.addEventListener('load', done, { once: true })
        img.addEventListener('error', done, { once: true })
      } catch {
        resolve()
      }
    })

    try {
      if (typeof (img as any).decode === 'function') {
        try { await (img as any).decode() } catch {}
      }
    } catch {}
  })

  await Promise.race([Promise.all(tasks), waitMs(timeoutMs)])
}

async function getHttpClient(): Promise<{ fetch: any } | null> {
  // 优先使用 tauri plugin-http（可绕过浏览器 CORS），否则回退到 window.fetch（仍会受 CORS 限制）
  try {
    const mod: any = await import('@tauri-apps/plugin-http')
    if (typeof mod?.fetch === 'function') return { fetch: mod.fetch }
  } catch {}
  try {
    if (typeof fetch === 'function') return { fetch: (input: string, init: any) => fetch(input, init) }
  } catch {}
  return null
}

function inferMimeByUrl(url: string): string {
  const m = (url || '').toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/)
  switch (m?.[1]) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'avif': return 'image/avif'
    case 'svg': return 'image/svg+xml'
    case 'ico': return 'image/x-icon'
    default: return 'application/octet-stream'
  }
}

async function fetchRemoteAsObjectUrl(url: string, timeoutMs = 20000): Promise<string> {
  const client = await getHttpClient()
  if (!client?.fetch) return ''

  const p = (async () => {
    const resp = await client.fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'image/*;q=0.9,*/*;q=0.1' },
    })
    const ok = resp && (resp.ok === true || (typeof resp.status === 'number' && resp.status >= 200 && resp.status < 300))
    if (!ok) return ''
    const ab: ArrayBuffer = await resp.arrayBuffer()
    let mime = ''
    try {
      const ct = resp.headers?.get?.('content-type') || resp.headers?.get?.('Content-Type')
      if (ct) mime = String(ct).split(';')[0].trim()
    } catch {}
    if (!/^image\//i.test(mime)) mime = inferMimeByUrl(url)
    const blob = new Blob([ab], { type: mime || 'application/octet-stream' })
    return URL.createObjectURL(blob)
  })()

  return await Promise.race([p, waitMs(timeoutMs).then(() => '')])
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const safeLimit = Math.max(1, Math.min(limit || 1, items.length || 1))
  let idx = 0
  const workers = Array.from({ length: safeLimit }, async () => {
    for (;;) {
      const i = idx++
      if (i >= items.length) return
      try { await fn(items[i]) } catch {}
    }
  })
  await Promise.all(workers)
}

async function inlineCrossOriginImages(root: ParentNode, timeoutMs = 20000): Promise<string[]> {
  // html2canvas 对“无 CORS 头的跨域图片”只能放弃，结果就是导出的 PDF 没图。
  // 解决办法：用 tauri plugin-http 把图片抓下来，替换成 blob: URL（同源），再让 html2canvas 渲染。
  const imgs = Array.from(root.querySelectorAll?.('img') || []) as HTMLImageElement[]
  if (!imgs.length) return []

  const origin = (() => { try { return new URL(document.baseURI || location.href).origin } catch { return '' } })()
  const targets = imgs.map((img) => {
    const src = String((img as any).currentSrc || img.getAttribute('src') || img.src || '').trim()
    return { img, src }
  }).filter(({ src }) => {
    if (!/^https?:\/\//i.test(src)) return false
    try { return origin ? (new URL(src).origin !== origin) : true } catch { return true }
  })
  if (!targets.length) return []

  const objectUrls: string[] = []
  await runWithConcurrency(targets, 4, async ({ img, src }) => {
    const u = await fetchRemoteAsObjectUrl(src, timeoutMs)
    if (!u) return
    try { img.setAttribute('src', u) } catch { try { (img as any).src = u } catch {} }
    objectUrls.push(u)
  })
  return objectUrls
}

function normalizeSvgSize(svgEl: SVGElement, targetWidth: number) {
  try {
    const vb = svgEl.getAttribute('viewBox')
    let w = 0, h = 0
    if (vb) {
      const p = vb.split(/\s+/).map(Number)
      if (p.length === 4) { w = p[2]; h = p[3] }
    }
    const hasWH = Number(svgEl.getAttribute('width')) || Number(svgEl.getAttribute('height'))
    if ((!w || !h) && hasWH) {
      w = Number(svgEl.getAttribute('width')) || 800
      h = Number(svgEl.getAttribute('height')) || 600
    }
    if (!w || !h) { w = 800; h = 600 }
    const ratio = targetWidth / w
    const targetHeight = Math.max(1, Math.round(h * ratio))
    svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    svgEl.setAttribute('width', String(targetWidth))
    svgEl.setAttribute('height', String(targetHeight))
    try { (svgEl.style as any).maxWidth = '100%'; (svgEl.style as any).height = 'auto' } catch {}
  } catch {}
}

export async function exportPdf(el: HTMLElement, opt?: any): Promise<Uint8Array> {
  // 先等“原页面”图片与字体稳定下来，否则 html2canvas 计算布局时会把未加载完的图片当成 0 高度，
  // 最终表现为：PDF 里图片缺失/只截了一半（典型就是图床慢的时候更容易触发）。
  try {
    const doc = el.ownerDocument || document
    await waitForFonts(doc)
    await waitForImagesIn(el)
    // 再等一帧，让布局把最终尺寸吃进去
    await nextFrame()
  } catch {}

  const mod: any = await import('html2pdf.js/dist/html2pdf.bundle.min.js')
  const html2pdf: any = (mod && (mod.default || mod)) || mod

  const options = {
    margin: 10, // 单位：mm
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', scrollX: 0, scrollY: 0 },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    // 断页策略：优先避免把段落/标题/表格等直接截断成两半（这会在 PDF 里表现为“半行被切掉”）
    pagebreak: {
      mode: ['avoid-all', 'css', 'legacy'],
      avoid: 'p,h1,h2,h3,h4,h5,h6,pre,blockquote,table,thead,tbody,tr,td,th,figure,img,svg,ul,ol,li,hr',
    },
    ...opt,
  }

  // html2pdf.js 内部会创建一个宽度等于“PDF 内容区宽度（A4 - margin）”的容器（单位 mm），
  // 这本质上就是“把导出宽度锁到 A4 可打印宽度”。我们只需要保证导出 DOM 不撑破它。
  try {
    const prevOnClone = (options as any)?.html2canvas?.onclone
    ;(options as any).html2canvas = {
      ...(options as any).html2canvas,
      onclone: (doc: Document) => {
        try { if (typeof prevOnClone === 'function') prevOnClone(doc) } catch {}
        // html2pdf 默认 overlay overflow:hidden，窗口尺寸/缩放不一致时容易把内容裁掉；这里强制放开。
        try {
          const overlay = doc.querySelector('.html2pdf__overlay') as HTMLElement | null
          if (overlay) overlay.style.overflow = 'visible'
        } catch {}
      },
    }
  } catch {}

  // 用 .preview 作为父作用域，复用现有 Markdown 样式（否则很多规则不会命中，表现为“格式丢了”）
  const exportRoot = document.createElement('div')
  exportRoot.className = 'preview flymd-export-preview'
  exportRoot.style.background = '#ffffff'
  exportRoot.style.position = 'static'
  exportRoot.style.overflow = 'visible'
  exportRoot.style.padding = '0'

  const clone = el.cloneNode(true) as HTMLElement

  // 把原图片的最终尺寸/选中的资源同步到克隆节点，消除“布局依赖图片加载”的特殊情况
  try {
    const origImgs = Array.from(el.querySelectorAll('img')) as HTMLImageElement[]
    const cloneImgs = Array.from(clone.querySelectorAll('img')) as HTMLImageElement[]
    const n = Math.min(origImgs.length, cloneImgs.length)
    for (let i = 0; i < n; i++) {
      try {
        const o = origImgs[i]
        const c = cloneImgs[i]
        const src = String((o as any).currentSrc || o.src || '').trim()
        if (src) c.src = src
        const nw = Number(o.naturalWidth || 0)
        const nh = Number(o.naturalHeight || 0)
        if (nw > 0 && nh > 0) {
          c.setAttribute('width', String(nw))
          c.setAttribute('height', String(nh))
        }
      } catch {}
    }
  } catch {}

  // 关键：让 preview-body 在容器内自适应，不要撑破 html2pdf 的 A4 宽度容器
  try {
    clone.style.width = '100%'
    clone.style.maxWidth = '100%'
    clone.style.boxSizing = 'border-box'
  } catch {}

  // 基础样式：保证图片不溢出 + KaTeX 关键样式
  const style = document.createElement('style')
  style.textContent = `
    /* 导出 PDF：禁用动画/过渡，避免 html2canvas 捕捉到中间态导致错位/截断 */
    .flymd-export-preview, .flymd-export-preview * { animation: none !important; transition: none !important; }

    /* 关键：统一为 border-box，彻底杜绝 padding 把宽度撑爆导致左右被裁 */
    .flymd-export-preview, .flymd-export-preview * { box-sizing: border-box !important; }
    .flymd-export-preview .preview-body { width: 100% !important; max-width: 100% !important; }

    /* 导出 PDF：强制使用浅色变量，避免深色模式下导出变成“白底浅字”几乎看不见 */
    .flymd-export-preview {
      color-scheme: light;
      --bg: #ffffff;
      --fg: #1f2328;
      --muted: #7a7a7a;
      --border: #e5e7eb;
      --border-strong: #cbd5e1;
      --code-bg: #f6f8fa;
      --code-border: #e5e7eb;
      --code-fg: #1f2328;
      --code-muted: #667085;
      --c-key: #7c3aed;
      --c-str: #2563eb;
      --c-num: #059669;
      --c-fn:  #db2777;
      --c-com: #9ca3af;
      --table-border: #cbd5e1;
      --table-header-bg: #f1f5f9;
      --table-header-fg: #1e293b;
      --table-row-hover: #f8fafc;
    }

    /* 导出容器：让 .preview 从“应用布局”退化为“普通文档流” */
    .flymd-export-preview.preview {
      position: static !important;
      top: auto !important; left: auto !important; right: auto !important; bottom: auto !important;
      overflow: visible !important;
      padding: 0 !important;
      background: #ffffff !important;
      box-shadow: none !important;
    }

    .flymd-export-preview .preview-body img,
    .flymd-export-preview img { max-width: 100% !important; height: auto !important; }
    .flymd-export-preview figure { max-width: 100% !important; }

    /* 断页保护：尽量别在块级元素内部断页（避免出现“半行在上一页、半行在下一页”） */
    .flymd-export-preview p,
    .flymd-export-preview blockquote,
    .flymd-export-preview pre,
    .flymd-export-preview table,
    .flymd-export-preview figure,
    .flymd-export-preview ul,
    .flymd-export-preview ol,
    .flymd-export-preview li,
    .flymd-export-preview hr,
    .flymd-export-preview img,
    .flymd-export-preview svg,
    .flymd-export-preview canvas {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .flymd-export-preview h1,
    .flymd-export-preview h2,
    .flymd-export-preview h3,
    .flymd-export-preview h4,
    .flymd-export-preview h5,
    .flymd-export-preview h6 { break-after: avoid-page; page-break-after: avoid; }

    /* KaTeX 关键样式（必需，确保 PDF 中根号等符号正确显示） */
    .flymd-export-preview .katex { font-size: 1em; text-indent: 0; text-rendering: auto; }
    .flymd-export-preview .katex svg { display: inline-block; position: relative; width: 100%; height: 100%; }
    .flymd-export-preview .katex svg path { fill: currentColor; }
    .flymd-export-preview .katex .hide-tail { overflow: hidden; }
    .flymd-export-preview .md-math-inline .katex { display: inline-block; }
    .flymd-export-preview .md-math-block .katex { display: block; text-align: center; }
  `
  exportRoot.appendChild(style)
  exportRoot.appendChild(clone)

  // 冻结 SVG 为屏幕显示尺寸（逐一读取原节点的像素尺寸）
  // 但完全跳过 KaTeX 的 SVG，因为它们需要特殊的 viewBox 处理
  try {
    const origSvgs = Array.from((el as HTMLElement).querySelectorAll('svg')) as SVGElement[]
    const cloneSvgs = Array.from(clone.querySelectorAll('svg')) as SVGElement[]
    const n = Math.min(origSvgs.length, cloneSvgs.length)
    for (let i = 0; i < n; i++) {
      try {
        // 跳过 KaTeX 的 SVG
        if (cloneSvgs[i].closest('.katex')) {
          // KaTeX SVG：读取实际屏幕像素尺寸并设置
          const r = (origSvgs[i] as any).getBoundingClientRect?.() || { width: 0, height: 0 }
          const w = Math.max(1, Math.round((r.width as number) || 0))
          const h = Math.max(1, Math.round((r.height as number) || 0))
          // 保留 viewBox 但设置实际像素尺寸
          cloneSvgs[i].setAttribute('width', String(w))
          cloneSvgs[i].setAttribute('height', String(h))
          cloneSvgs[i].style.width = w + 'px'
          cloneSvgs[i].style.height = h + 'px'
          continue
        }

        // 非 KaTeX SVG（mermaid、图表等）：使用原有逻辑
        const r = (origSvgs[i] as any).getBoundingClientRect?.() || { width: 0, height: 0 }
        const w = Math.max(1, Math.round((r.width as number) || 0))
        const h = Math.max(1, Math.round((r.height as number) || 0))
        cloneSvgs[i].setAttribute('preserveAspectRatio', 'xMidYMid meet')
        if (w) cloneSvgs[i].setAttribute('width', String(w))
        if (h) cloneSvgs[i].setAttribute('height', String(h))
        try { (cloneSvgs[i].style as any).width = w + 'px'; (cloneSvgs[i].style as any).height = 'auto' } catch {}
      } catch {}
    }
  } catch {}

  // 等克隆节点的图片也进入“可计算尺寸”的稳定态（多数情况下会命中缓存，成本很低）
  const blobUrls: string[] = []
  try {
    // 关键：跨域图床如果没给 CORS 头，html2canvas 会直接报错并跳过图片；这里把它们内联为 blob: 同源资源
    try { blobUrls.push(...(await inlineCrossOriginImages(clone, 20000))) } catch {}
    try {
      await waitForImagesIn(clone, 20000)
      await nextFrame()
    } catch {}

    const ab: ArrayBuffer = await html2pdf().set(options).from(exportRoot).toPdf().output('arraybuffer')
    return new Uint8Array(ab)
  } finally {
    // 释放 blob URL，避免长文档导出后内存涨不回来
    for (const u of blobUrls) {
      try { URL.revokeObjectURL(u) } catch {}
    }
  }
}
