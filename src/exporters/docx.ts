// src/exporters/docx.ts
// 使用 html-docx-js（UMD 全局）将 HTML/Element 导出为 DOCX 字节，动态加载 public/vendor/html-docx.js，避免打包器兼容问题

async function ensureHtmlDocx(): Promise<any> {
  const g: any = (globalThis as any)
  if (g.htmlDocx && typeof g.htmlDocx.asBlob === 'function') return g.htmlDocx
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/vendor/html-docx.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('加载 html-docx.js 失败'))
    document.head.appendChild(script)
  })
  const g2: any = (globalThis as any)
  if (!g2.htmlDocx || typeof g2.htmlDocx.asBlob !== 'function') throw new Error('htmlDocx 未就绪')
  return g2.htmlDocx
}

// 从 Tauri 读取本地文件为 dataURL
async function readLocalAsDataUrl(absPath: string): Promise<string> {
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    const bytes = await readFile(absPath as any)
    const mime = (() => {
      const m = (absPath || '').toLowerCase().match(/\.([a-z0-9]+)$/)
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
    })()
    const blob = new Blob([bytes], { type: mime })
    const dataUrl = await new Promise<string>((resolve, reject) => {
      try {
        const fr = new FileReader()
        fr.onerror = () => reject(fr.error || new Error('读取失败'))
        fr.onload = () => resolve(String(fr.result || ''))
        fr.readAsDataURL(blob)
      } catch (e) { reject(e as any) }
    })
    return dataUrl
  } catch (e) {
    console.warn('readLocalAsDataUrl 失败', e)
    return ''
  }
}

// 通过 Tauri HTTP 客户端抓取远程图片（避免 CORS），必要时转为 PNG
async function fetchRemoteAsDataUrl(url: string): Promise<string> {
  // 1) 优先使用 Tauri v2 http 插件（不受浏览器 CORS 限制）
  try {
    const mod: any = await import('@tauri-apps/plugin-http')
    if (mod?.fetch) {
      const resp = await mod.fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'image/*;q=0.9,*/*;q=0.1' },
      })
      const ab: ArrayBuffer = await resp.arrayBuffer()
      let mime = 'application/octet-stream'
      try {
        const ct = resp.headers?.get?.('content-type') || resp.headers?.get?.('Content-Type')
        if (ct) mime = String(ct).split(';')[0].trim()
      } catch {}
      if (!/^image\//i.test(mime)) {
        const m = (url || '').toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/)
        switch (m?.[1]) {
          case 'jpg':
          case 'jpeg': mime = 'image/jpeg'; break
          case 'png': mime = 'image/png'; break
          case 'gif': mime = 'image/gif'; break
          case 'webp': mime = 'image/webp'; break
          case 'bmp': mime = 'image/bmp'; break
          case 'avif': mime = 'image/avif'; break
          case 'svg': mime = 'image/svg+xml'; break
          case 'ico': mime = 'image/x-icon'; break
        }
      }
      let blob = new Blob([ab], { type: mime })
      // Word 兼容性：将 webp/avif/svg 转为 PNG
      if (/^(image\/webp|image\/avif|image\/svg\+xml)$/i.test(mime)) {
        try {
          const url2 = URL.createObjectURL(blob)
          try {
            const pngUrl: string = await new Promise((resolve, reject) => {
              const img = new Image()
              img.onload = () => {
                try {
                  const canvas = document.createElement('canvas')
                  canvas.width = img.naturalWidth || img.width || 1
                  canvas.height = img.naturalHeight || img.height || 1
                  const ctx = canvas.getContext('2d')!
                  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height)
                  ctx.drawImage(img, 0, 0)
                  resolve(canvas.toDataURL('image/png'))
                } catch (e) { reject(e) }
              }
              img.onerror = () => reject(new Error('图片加载失败'))
              img.src = url2
            })
            return pngUrl
          } finally { URL.revokeObjectURL(url2) }
        } catch (e) { console.warn('转 PNG 失败，使用原格式', e) }
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        try {
          const fr = new FileReader()
          fr.onerror = () => reject(fr.error || new Error('读取失败'))
          fr.onload = () => resolve(String(fr.result || ''))
          fr.readAsDataURL(blob)
        } catch (e) { reject(e as any) }
      })
      return dataUrl
    }
  } catch (e) {
    console.warn('plugin-http 不可用，回退 window.fetch', e)
  }
  // 2) 回退：window.fetch（需要后端允许 CORS）
  try {
    const r = await fetch(url, { mode: 'cors' })
    const blob = await r.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onerror = () => reject(fr.error || new Error('读取失败'))
      fr.onload = () => resolve(String(fr.result || ''))
      fr.readAsDataURL(blob)
    })
    return dataUrl
  } catch (e2) {
    console.error('window.fetch 回退也失败', e2)
    return ''
  }
}

async function svgToPngDataUrl(svgEl: SVGElement): Promise<string> {
  try {
    console.log('[DOCX导出] 开始转换SVG:', svgEl.id || svgEl.className)

    // 克隆SVG，避免修改原始DOM
    const clone = svgEl.cloneNode(true) as SVGElement

    // 确保SVG有xmlns属性
    if (!clone.getAttribute('xmlns')) {
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    }
    if (!clone.getAttribute('xmlns:xlink')) {
      clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
    }

    // 获取尺寸
    const viewBox = clone.getAttribute('viewBox')
    let width = 0
    let height = 0

    // 辅助函数：解析CSS尺寸值（支持px、em、pt等单位）
    const parseCssSize = (val: string | null): number => {
      if (!val) return 0
      const str = String(val).trim()
      const match = str.match(/^([\d.]+)(px|em|pt|%)?$/i)
      if (!match) return Number(str) || 0

      const num = parseFloat(match[1])
      const unit = (match[2] || 'px').toLowerCase()

      // 转换为像素（假设1em=16px，1pt=1.333px）
      switch (unit) {
        case 'em': return num * 16
        case 'pt': return num * 1.333
        case '%': return num // 百分比先保持原值，后续根据viewBox调整
        default: return num // px或无单位
      }
    }

    const widthAttr = clone.getAttribute('width')
    const heightAttr = clone.getAttribute('height')

    // 优先级1：从viewBox获取尺寸（最准确）
    if (viewBox) {
      const parts = viewBox.split(/\s+/).map(Number)
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        width = parts[2]
        height = parts[3]
      }
    }

    // 优先级2：从实际渲染尺寸获取
    if (!width || !height) {
      try {
        const rect = svgEl.getBoundingClientRect()
        if (rect.width > 0) width = rect.width
        if (rect.height > 0) height = rect.height
      } catch {}
    }

    // 优先级3：从属性获取（需要解析单位）
    if (!width && widthAttr) width = parseCssSize(widthAttr)
    if (!height && heightAttr) height = parseCssSize(heightAttr)

    // 最终回退：使用默认值
    if (!width || width <= 0) width = 800
    if (!height || height <= 0) height = 600

    // 设置明确的宽高属性（确保是像素值）
    clone.setAttribute('width', String(Math.round(width)))
    clone.setAttribute('height', String(Math.round(height)))

    console.log('[DOCX导出] SVG尺寸:', { width, height, viewBox, widthAttr, heightAttr })

    // 序列化SVG
    const serializer = new XMLSerializer()
    let svgStr = serializer.serializeToString(clone)

    // 清理可能导致Canvas污染的外部引用
    try {
      // 移除 xlink:href 指向外部URL的引用（支持http和https）
      svgStr = svgStr.replace(/xlink:href="https?:\/\/[^"]*"/gi, '')
      // 移除 href 指向外部URL的引用（但不影响锚点链接）
      svgStr = svgStr.replace(/\shref="https?:\/\/[^"]*"/gi, '')
      // 清理 style 标签中的外部引用（但保留内部样式）
      svgStr = svgStr.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, content) => {
        // 移除 @import 和 url() 中的外部HTTP引用，但保留其他CSS规则
        const cleaned = content
          .replace(/@import\s+url\(https?:\/\/[^)]+\);?/gi, '')
          .replace(/url\(https?:\/\/[^)]+\)/gi, '')
        return `<style>${cleaned}</style>`
      })
      // 移除 style 属性中的外部 url() 引用
      svgStr = svgStr.replace(/\sstyle="([^"]*)"/gi, (match, content) => {
        if (content.includes('url(http')) {
          const cleaned = content.replace(/url\(https?:\/\/[^)]+\)/gi, '')
          return ` style="${cleaned}"`
        }
        return match
      })
      // 清理 foreignObject 内部的外部资源，但保留文字内容
      // Mermaid使用foreignObject来渲染文字
      svgStr = svgStr.replace(/<foreignObject([^>]*)>([\s\S]*?)<\/foreignObject>/gi, (_match, attrs, content) => {
        // 只移除外部图片和样式表链接，保留文字和HTML结构
        const cleanedContent = content
          .replace(/<img[^>]*\ssrc="https?:\/\/[^"]*"[^>]*>/gi, '')
          .replace(/<link[^>]*\shref="https?:\/\/[^"]*"[^>]*>/gi, '')
          .replace(/<script[^>]*\ssrc="https?:\/\/[^"]*"[^>]*>/gi, '')
          .replace(/<iframe[^>]*\ssrc="https?:\/\/[^"]*"[^>]*>/gi, '')
        return `<foreignObject${attrs}>${cleanedContent}</foreignObject>`
      })
      // 移除 <image> 标签的外部引用
      svgStr = svgStr.replace(/<image[^>]*\shref="https?:\/\/[^"]*"[^>]*>/gi, '')
    } catch (e) {
      console.warn('[DOCX导出] 清理外部引用失败', e)
    }

    console.log('[DOCX导出] 清理后SVG预览:', svgStr.substring(0, 500))

    // 内联样式：从当前页面的样式中提取与SVG相关的规则
    try {
      const styles: string[] = []
      // 提取body上可能影响SVG的字体等样式
      const computedStyle = getComputedStyle(document.body)
      const fontFamily = computedStyle.fontFamily
      if (fontFamily) {
        styles.push(`svg { font-family: ${fontFamily}; }`)
      }

      if (styles.length > 0) {
        const styleEl = `<style>${styles.join('\n')}</style>`
        svgStr = svgStr.replace('>', '>' + styleEl)
      }
    } catch (e) {
      console.warn('[DOCX导出] 内联样式失败', e)
    }

    console.log('[DOCX导出] SVG字符串长度:', svgStr.length)

    // 方法1：使用html2canvas直接渲染SVG元素（避免跨域问题）
    const tempContainer = document.createElement('div')
    tempContainer.style.position = 'fixed'
    tempContainer.style.left = '-10000px'
    tempContainer.style.top = '0'
    tempContainer.style.width = width + 'px'
    tempContainer.style.height = height + 'px'
    tempContainer.style.backgroundColor = '#fff'

    try {
      tempContainer.innerHTML = svgStr
      document.body.appendChild(tempContainer)
      const tempSvg = tempContainer.querySelector('svg') as SVGElement | null

      if (!tempSvg) {
        throw new Error('无法在临时容器中创建SVG')
      }

      // 等待SVG渲染
      await new Promise(resolve => setTimeout(resolve, 100))

      try {
        // 尝试使用html2canvas（通过html2pdf.js获取）
        // @ts-ignore - 动态加载，运行时可用
        const html2pdfMod: any = await import('html2pdf.js/dist/html2pdf.bundle.min.js')
        const html2pdf: any = (html2pdfMod && (html2pdfMod.default || html2pdfMod)) || html2pdfMod

        console.log('[DOCX导出] 使用html2canvas渲染SVG')

        // html2canvas通常作为全局变量被html2pdf.js加载
        const html2canvas: any = (window as any).html2canvas

        if (html2canvas) {
          console.log('[DOCX导出] html2canvas可用，开始渲染...')
          try {
            const canvas = await html2canvas(tempContainer, {
              scale: 2,
              useCORS: true,
              backgroundColor: '#ffffff',
              logging: true, // 启用日志来诊断
              foreignObjectRendering: true, // 启用foreignObject渲染（Mermaid文字需要）
            })

            console.log('[DOCX导出] html2canvas渲染完成:', { width: canvas.width, height: canvas.height })

            // 约束尺寸
            let targetWidth = canvas.width
            let targetHeight = canvas.height
            const maxSize = 2000

            if (targetWidth > maxSize || targetHeight > maxSize) {
              const ratio = Math.min(maxSize / targetWidth, maxSize / targetHeight)
              const resultCanvas = document.createElement('canvas')
              resultCanvas.width = Math.round(targetWidth * ratio)
              resultCanvas.height = Math.round(targetHeight * ratio)
              const ctx = resultCanvas.getContext('2d')!
              ctx.drawImage(canvas, 0, 0, resultCanvas.width, resultCanvas.height)
              const pngDataUrl = resultCanvas.toDataURL('image/png')
              console.log('[DOCX导出] PNG生成成功（html2canvas+resize），长度:', pngDataUrl.length)
              return pngDataUrl
            }

            const pngDataUrl = canvas.toDataURL('image/png')
            console.log('[DOCX导出] PNG生成成功（html2canvas），长度:', pngDataUrl.length)
            return pngDataUrl
          } catch (h2cError) {
            console.error('[DOCX导出] html2canvas渲染失败:', h2cError)
            throw h2cError
          }
        } else {
          console.warn('[DOCX导出] html2canvas未找到')
        }
      } catch (e) {
        console.warn('[DOCX导出] html2canvas不可用，回退到Image方法', e)
      }

      // 方法2：回退到Image方法（可能失败）
      return await new Promise<string>((resolve, reject) => {
        try {
          console.log('[DOCX导出] 使用Image方法渲染SVG')

          let targetWidth = width
          let targetHeight = height

          // 约束到最大2000px
          const maxSize = 2000
          const minSize = 50
          if (targetWidth > maxSize || targetHeight > maxSize) {
            const ratio = Math.min(maxSize / targetWidth, maxSize / targetHeight)
            targetWidth *= ratio
            targetHeight *= ratio
          }

          targetWidth = Math.max(minSize, Math.round(targetWidth))
          targetHeight = Math.max(minSize, Math.round(targetHeight))

          // 使用data URL而不是Blob URL（避免跨域问题）
          const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr)
          console.log('[DOCX导出] SVG data URL长度:', svgDataUrl.length)

          const img = new Image()
          img.onload = () => {
            try {
              console.log('[DOCX导出] Image加载成功，准备绘制到Canvas')
              const canvas = document.createElement('canvas')
              canvas.width = targetWidth
              canvas.height = targetHeight
              const ctx = canvas.getContext('2d')!
              ctx.fillStyle = '#fff'
              ctx.fillRect(0, 0, targetWidth, targetHeight)
              ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
              const pngDataUrl = canvas.toDataURL('image/png')
              console.log('[DOCX导出] PNG生成成功（Image方法），长度:', pngDataUrl.length)
              resolve(pngDataUrl)
            } catch (e) {
              console.error('[DOCX导出] Canvas绘制失败', e)
              reject(e)
            }
          }
          img.onerror = (e) => {
            console.error('[DOCX导出] Image加载失败', e)
            reject(new Error('SVG Image加载失败'))
          }
          img.src = svgDataUrl
        } catch (e) {
          reject(e)
        }
      })
    } catch (e) {
      console.error('[DOCX导出] 文档内渲染失败，回退到SVG dataURL', e)
      // 回退：返回SVG的dataURL
      try {
        const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr)
        console.log('[DOCX导出] 使用SVG dataURL作为回退')
        return svgDataUrl
      } catch (e2) {
        console.error('[DOCX导出] SVG dataURL也失败', e2)
        return ''
      }
    } finally {
      try {
        if (tempContainer.parentNode) {
          document.body.removeChild(tempContainer)
        }
      } catch {}
    }
  } catch (e) {
    console.error('[DOCX导出] svgToPngDataUrl完全失败', e)
    return ''
  }
}

async function preprocessElementForDocx(el: HTMLElement): Promise<string> {
  const clone = el.cloneNode(true) as HTMLElement

  console.log('[DOCX导出] 开始预处理HTML')

  // 1) SVG -> PNG IMG（失败则用 SVG dataURL）
  try {
    const svgsSrc = Array.from(el.querySelectorAll('svg')) as SVGElement[]
    console.log('[DOCX导出] 找到', svgsSrc.length, '个SVG元素')

    if (svgsSrc.length > 0) {
      const dataList = await Promise.all(svgsSrc.map((svg, i) => {
        console.log(`[DOCX导出] 转换SVG ${i + 1}/${svgsSrc.length}`)
        return svgToPngDataUrl(svg)
      }))

      const svgsClone = Array.from(clone.querySelectorAll('svg')) as Element[]
      for (let i = 0; i < svgsClone.length && i < dataList.length; i++) {
        const url = dataList[i]
        if (!url) {
          console.warn(`[DOCX导出] SVG ${i + 1} 转换失败，跳过`)
          continue
        }

        const img = document.createElement('img')
        img.src = url

        const srcSvg = svgsClone[i] as SVGElement
        const vb = srcSvg.getAttribute('viewBox') || ''
        const w = srcSvg.getAttribute('width')
        const h = srcSvg.getAttribute('height')

        if (w) img.setAttribute('width', w)
        if (h) img.setAttribute('height', h)

        // 从viewBox获取尺寸
        if (!w && vb) {
          const parts = vb.split(/\s+/)
          if (parts.length === 4) {
            img.setAttribute('width', parts[2])
            img.setAttribute('height', parts[3])
          }
        }

        // 保持样式
        const style = srcSvg.getAttribute('style')
        if (style) img.setAttribute('style', style)

        console.log(`[DOCX导出] 替换SVG ${i + 1} 为IMG，尺寸:`, { width: img.getAttribute('width'), height: img.getAttribute('height') })
        srcSvg.replaceWith(img)
      }
    }
  } catch (e) {
    console.error('[DOCX导出] SVG转换失败', e)
  }

  // 2) IMG src -> dataURL，设置宽高约束
  const imgs = Array.from(clone.querySelectorAll('img')) as HTMLImageElement[]
  for (const img of imgs) {
    try {
      const cur = img.getAttribute('src') || ''
      if (!/^data:/i.test(cur)) {
        const abs = img.getAttribute('data-abs-path') || ''
        const raw = img.getAttribute('data-raw-src') || cur
        let dataUrl = ''
        if (abs) dataUrl = await readLocalAsDataUrl(abs)
        if (!dataUrl && /^https?:/i.test(raw)) dataUrl = await fetchRemoteAsDataUrl(raw)
        if (!dataUrl && !/^data:/i.test(cur)) {
          try {
            const r = await fetch(cur, { mode: 'cors' })
            const blob = await r.blob()
            dataUrl = await new Promise<string>((resolve, reject) => {
              const fr = new FileReader()
              fr.onerror = () => reject(fr.error || new Error('读取失败'))
              fr.onload = () => resolve(String(fr.result || ''))
              fr.readAsDataURL(blob)
            })
          } catch {}
        }
        if (dataUrl) img.src = dataUrl
      }
      // 计算尺寸并约束到页宽内（约 700px）
      const maxPx = 700
      await new Promise<void>((resolve) => {
        try {
          const temp = new Image()
          temp.onload = () => {
            try {
              const w = temp.naturalWidth || temp.width || 1
              const h = temp.naturalHeight || temp.height || 1
              const ratio = w > 0 ? Math.min(1, maxPx / w) : 1
              const nw = Math.max(1, Math.round(w * ratio))
              const nh = Math.max(1, Math.round(h * ratio))
              img.setAttribute('width', String(nw))
              img.setAttribute('height', String(nh))
            } catch {}
            resolve()
          }
          temp.onerror = () => resolve()
          temp.src = img.getAttribute('src') || ''
        } catch { resolve() }
      })
    } catch (e) { console.warn('处理 IMG 失败', e) }
  }

  // 3) 注入基础样式（html-docx-js 对 style 支持有限，仍保留以兼容）
  const style = document.createElement('style')
  style.textContent = `
    .preview-body img, img { max-width: 100% !important; height: auto !important; }
    pre { white-space: pre-wrap; word-break: break-word; }
    code { word-break: break-word; }
  `
  clone.prepend(style)

  return clone.outerHTML
}

export async function exportDocx(htmlOrEl: string | HTMLElement, opt?: any): Promise<Uint8Array> {
  const htmlDocx = await ensureHtmlDocx()
  const html = typeof htmlOrEl === 'string' ? htmlOrEl : await preprocessElementForDocx(htmlOrEl)
  const blob: Blob = htmlDocx.asBlob(html, {
    orientation: 'portrait',
    margins: { top: 720, bottom: 720, left: 720, right: 720 },
    ...opt,
  })
  const ab = await blob.arrayBuffer()
  return new Uint8Array(ab)
}

