// 打印工具：把指定 DOM 克隆到隔离 iframe 再打印
// 目的：避免把整个应用 UI/通知一起打印，且确保打印完整内容（不受滚动容器限制）

export type PrintElementOptions = {
  title?: string
  baseHref?: string
  extraCss?: string
}

const PRINT_IFRAME_ID = 'flymd-print-frame'

function getOrCreatePrintIframe(): HTMLIFrameElement {
  const existed = document.getElementById(PRINT_IFRAME_ID) as HTMLIFrameElement | null
  if (existed && existed.contentDocument && existed.contentWindow) return existed

  const iframe = document.createElement('iframe')
  iframe.id = PRINT_IFRAME_ID
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  // 注意：不能 display:none，否则部分环境会打印空白
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '1px'
  iframe.style.height = '1px'
  iframe.style.border = '0'
  iframe.style.opacity = '0'
  iframe.style.pointerEvents = 'none'
  iframe.style.zIndex = '-1'
  document.body.appendChild(iframe)
  return iframe
}

function resetPrintDocument(doc: Document, title: string, baseHref: string): void {
  doc.open()
  doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
  doc.close()
  try { doc.title = title } catch {}
  try {
    const base = doc.createElement('base')
    base.href = baseHref
    doc.head.appendChild(base)
  } catch {}
}

function copyStyles(src: Document, dst: Document): void {
  // 外链样式：用解析后的绝对 href，避免 about:blank 相对路径失效
  const links = Array.from(src.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))
  for (const l of links) {
    try {
      const href = String(l.href || '').trim()
      if (!href) continue
      const link = dst.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      if (l.media) link.media = l.media
      dst.head.appendChild(link)
    } catch {}
  }

  // 内联样式：直接复制文本（不复制事件/引用）
  const styles = Array.from(src.querySelectorAll<HTMLStyleElement>('style'))
  for (const s of styles) {
    try {
      const style = dst.createElement('style')
      if (s.media) style.media = s.media
      style.textContent = s.textContent || ''
      dst.head.appendChild(style)
    } catch {}
  }
}

function appendPrintCss(doc: Document, extraCss?: string): void {
  const style = doc.createElement('style')
  style.textContent = `
    /* 打印隔离页：只渲染正文，不要 UI */
    html, body { margin: 0; padding: 0; height: auto; overflow: visible; }
    body {
      background: #ffffff;
      color: #1f2328;
      color-scheme: light;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* 禁用动画/过渡，避免打印捕捉中间态 */
    .flymd-print-preview, .flymd-print-preview * {
      animation: none !important;
      transition: none !important;
      box-sizing: border-box !important;
    }

    /* 强制使用浅色变量（深色模式下也能看清） */
    .flymd-print-preview {
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

    /* 让 .preview 从“应用布局”退化为“普通文档流” */
    .flymd-print-preview.preview {
      position: static !important;
      top: auto !important; left: auto !important; right: auto !important; bottom: auto !important;
      overflow: visible !important;
      padding: 0 !important;
      background: #ffffff !important;
      box-shadow: none !important;
    }

    .flymd-print-preview .preview-body {
      width: 100% !important;
      max-width: 100% !important;
      margin: 0 !important;
      padding: 10mm 10mm 12mm 10mm;
    }

    /* 不打印复制按钮/语言标签/模拟光标 */
    .flymd-print-preview .code-copy,
    .flymd-print-preview .code-lang,
    .flymd-print-preview .caret-dot {
      display: none !important;
    }

    /* 图片/图形：避免溢出 */
    .flymd-print-preview img,
    .flymd-print-preview .preview-body img {
      max-width: 100% !important;
      height: auto !important;
    }

    @page { margin: 10mm; }

    /* 断页保护：尽量别把块级元素切成两半 */
    @media print {
      .flymd-print-preview p,
      .flymd-print-preview blockquote,
      .flymd-print-preview pre,
      .flymd-print-preview table,
      .flymd-print-preview figure,
      .flymd-print-preview ul,
      .flymd-print-preview ol,
      .flymd-print-preview li,
      .flymd-print-preview hr,
      .flymd-print-preview img,
      .flymd-print-preview svg,
      .flymd-print-preview canvas {
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .flymd-print-preview h1,
      .flymd-print-preview h2,
      .flymd-print-preview h3,
      .flymd-print-preview h4,
      .flymd-print-preview h5,
      .flymd-print-preview h6 {
        break-after: avoid-page;
        page-break-after: avoid;
      }
    }

    ${extraCss || ''}
  `.trim()
  doc.head.appendChild(style)
}

async function waitForFonts(doc: Document): Promise<void> {
  try {
    if (doc.fonts && doc.fonts.ready) await doc.fonts.ready
  } catch {}
}

async function waitForImages(doc: Document): Promise<void> {
  const imgs = Array.from(doc.images)
  if (!imgs.length) return
  await Promise.all(imgs.map(async (img) => {
    try {
      if (img.complete && img.naturalWidth > 0) return
      if (typeof img.decode === 'function') {
        try { await img.decode() } catch {}
        return
      }
    } catch {}
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      img.addEventListener('load', done, { once: true })
      img.addEventListener('error', done, { once: true })
    })
  }))
}

export async function printElement(el: HTMLElement, opt?: PrintElementOptions): Promise<void> {
  if (!el) throw new Error('打印元素为空')

  const title = (opt?.title || document.title || '打印').toString()
  const baseHref = (opt?.baseHref || document.baseURI || location.href).toString()

  const iframe = getOrCreatePrintIframe()
  const doc = iframe.contentDocument
  const win = iframe.contentWindow
  if (!doc || !win) throw new Error('打印环境不可用')

  resetPrintDocument(doc, title, baseHref)
  copyStyles(document, doc)
  appendPrintCss(doc, opt?.extraCss)

  const root = doc.createElement('div')
  root.className = 'preview flymd-print-preview'
  const clone = el.cloneNode(true) as HTMLElement
  root.appendChild(clone)
  doc.body.appendChild(root)

  await waitForFonts(doc)
  await waitForImages(doc)

  // 某些环境需要下一帧再触发 print，避免空白
  await new Promise<void>((resolve) => { win.requestAnimationFrame(() => resolve()) })
  try { win.focus() } catch {}
  win.print()
}

