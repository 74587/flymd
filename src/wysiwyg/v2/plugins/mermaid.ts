// Milkdown Mermaid 插件：将 mermaid 代码块渲染为图表
// 同时为其他代码块提供语法高亮支持
import { $view } from '@milkdown/utils'
import { codeBlockSchema } from '@milkdown/preset-commonmark'
import type { Node } from '@milkdown/prose/model'
import type { EditorView, NodeView } from '@milkdown/prose/view'
import { HighlightCodeBlockNodeView } from './highlight'

// 检测当前是否为夜间模式
function isDarkMode(): boolean {
  return document.body.classList.contains('dark-mode') ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

// Mermaid 渲染函数
async function renderMermaid(container: HTMLElement, code: string) {
  try {
    const mod: any = await import('mermaid')
    const mermaid = mod?.default || mod

    // 静默错误
    try { (mermaid as any).parseError = () => {} } catch {}
    try { if ((mermaid as any).mermaidAPI) (mermaid as any).mermaidAPI.parseError = () => {} } catch {}

    // 根据夜间模式选择主题
    const dark = isDarkMode()
    const theme = dark ? 'dark' : 'default'

    try {
      mermaid.initialize?.({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: theme,
        logLevel: 'fatal' as any,
        fontSize: 16 as any,
        flowchart: { useMaxWidth: true } as any,
        themeVariables: dark ? {
          fontFamily: 'Segoe UI, Helvetica, Arial, sans-serif',
          fontSize: '16px',
          // VS Code Dark+ 风格配色
          primaryColor: '#3c3c3c',
          primaryTextColor: '#d4d4d4',
          primaryBorderColor: '#505050',
          lineColor: '#808080',
          secondaryColor: '#252526',
          tertiaryColor: '#1e1e1e',
          background: '#1e1e1e',
          mainBkg: '#252526',
          secondBkg: '#1e1e1e',
          border1: '#505050',
          border2: '#3c3c3c',
          arrowheadColor: '#d4d4d4',
          textColor: '#d4d4d4',
          nodeTextColor: '#d4d4d4',
        } : {
          fontFamily: 'Segoe UI, Helvetica, Arial, sans-serif',
          fontSize: '16px'
        },
      })
    } catch {}

    const id = 'mmd-' + Math.random().toString(36).slice(2)
    const { svg } = await mermaid.render(id, code || '')
    // 包装成带工具条的容器
    container.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.innerHTML = svg
    const svgEl = wrap.firstElementChild as SVGElement | null
    if (svgEl) {
      const fig = document.createElement('div')
      fig.className = 'mmd-figure'
      fig.appendChild(svgEl)
      try {
        const mk: any = (window as any).createMermaidToolsFor
        if (typeof mk === 'function') {
          const tools = mk(svgEl)
          if (tools) fig.appendChild(tools)
        }
      } catch {}
      container.appendChild(fig)
    }

    try {
      const svgEl = container.querySelector('svg') as SVGElement | null
      if (svgEl) {
        svgEl.style.display = 'block'
        svgEl.style.maxWidth = '100%'
        svgEl.style.height = 'auto'

        if (!svgEl.getAttribute('preserveAspectRatio')) {
          svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet')
        }

        const vb = svgEl.getAttribute('viewBox') || ''
        if (!/(\d|\s)\s*(\d|\s)/.test(vb)) {
          const w = parseFloat(svgEl.getAttribute('width') || '')
          const h = parseFloat(svgEl.getAttribute('height') || '')
          if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`)
          }
        }

        if (svgEl.hasAttribute('width')) svgEl.removeAttribute('width')
        if (svgEl.hasAttribute('height')) svgEl.removeAttribute('height')

        setTimeout(() => {
          try {
            const bb = (svgEl as any).getBBox ? (svgEl as any).getBBox() : null
            if (bb && bb.width > 0 && bb.height > 0) {
              const pad = Math.max(2, Math.min(24, Math.round(Math.max(bb.width, bb.height) * 0.02)))
              const vx = Math.floor(bb.x) - pad
              const vy = Math.floor(bb.y) - pad
              const vw = Math.ceil(bb.width) + pad * 2
              const vh = Math.ceil(bb.height) + pad * 2
              svgEl.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`)

              let scale = 0.75
              try {
                const sv = localStorage.getItem('flymd:mermaidScale')
                const n = sv ? parseFloat(sv) : NaN
                if (Number.isFinite(n) && n > 0) scale = n
              } catch {}

              const finalW = Math.max(10, Math.round(vw * scale))
              svgEl.style.width = finalW + 'px'
            }
          } catch {}
        }, 0)
      }
    } catch {}
  } catch (e) {
    container.innerHTML = ''
    console.error('[Mermaid Plugin] 渲染失败:', e)
  }
}

// Mermaid NodeView
class MermaidNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement | null
  private chartContainer: HTMLElement
  private preWrapper: HTMLElement
  private node: Node
  private view: EditorView
  private getPos: () => number | undefined
  private toolbar: HTMLElement
  private isEditing: boolean = false  // 编辑模式标志，编辑时跳过渲染
  private justEnteredEdit: number = 0  // 防止双击后 clickOutside 立即关闭

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    console.log('[Mermaid Plugin] 创建 NodeView, language:', node.attrs.language)

    this.node = node
    this.view = view
    this.getPos = getPos

    // 创建外层容器
    this.dom = document.createElement('div')
    this.dom.classList.add('mermaid-node-wrapper')
    this.dom.style.margin = '1em 0'
    this.dom.style.position = 'relative'

    // 创建源代码容器（保持可编辑）- 使用标准的 pre>code 结构
    this.preWrapper = document.createElement('pre')
    this.preWrapper.style.display = 'none' // 隐藏源代码
    this.preWrapper.style.whiteSpace = 'pre'
    this.contentDOM = document.createElement('code')
    this.preWrapper.appendChild(this.contentDOM)

    // 编辑工具条：仅在源码编辑时显示删除按钮
    this.toolbar = document.createElement('div')
    this.toolbar.style.display = 'none'
    this.toolbar.style.textAlign = 'right'
    this.toolbar.style.marginBottom = '4px'
    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.textContent = 'Delete'
    let deleteArmed = false
    delBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      // 第一次点击只进入“待确认”状态，第二次点击才真正删除
      if (!deleteArmed) {
        deleteArmed = true
        delBtn.textContent = '确认删除'
        return
      }
      this.deleteSelf()
    })
    this.toolbar.appendChild(delBtn)

    this.dom.appendChild(this.toolbar)
    this.dom.appendChild(this.preWrapper)

    // 创建图表容器
    this.chartContainer = document.createElement('div')
    this.chartContainer.classList.add('mermaid-chart-display')
    // 夜间模式使用透明背景，让 SVG 自适应
    this.chartContainer.style.background = 'transparent'
    this.chartContainer.style.borderRadius = '4px'
    this.chartContainer.style.padding = '8px'
    this.chartContainer.style.minHeight = '50px'
    this.chartContainer.style.cursor = 'pointer'
    this.chartContainer.textContent = '渲染中...'

    // 双击切换到源代码编辑
    this.chartContainer.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      e.preventDefault()
      this.enterEditMode()
    })

    // 按 Escape 键退出源码编辑模式
    const exitEditMode = () => {
      console.log('[Mermaid Plugin] 退出源码编辑模式')
      this.isEditing = false  // 标记退出编辑模式
      this.preWrapper.style.display = 'none'
      this.chartContainer.style.display = 'block'
      this.toolbar.style.display = 'none'
      // 强制重新渲染
      requestAnimationFrame(() => {
        this.renderChart()
      })
    }

    this.preWrapper.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        exitEditMode()
      }
    })

    // 点击外部区域时退出源码编辑模式
    document.addEventListener('click', this.handleClickOutside)

    this.dom.appendChild(this.chartContainer)

    // 初始渲染：空内容时自动进入编辑模式
    const code = this.node.textContent
    if (!code || !code.trim()) {
      // 空内容：直接设置编辑模式状态，避免显示"渲染中..."
      this.isEditing = true
      this.justEnteredEdit = Date.now()
      this.chartContainer.style.display = 'none'
      this.preWrapper.style.display = 'block'
      const dark = isDarkMode()
      this.preWrapper.style.border = dark ? '1px solid #3c3c3c' : '1px solid #ccc'
      this.preWrapper.style.padding = '8px'
      this.preWrapper.style.borderRadius = '4px'
      this.preWrapper.style.background = dark ? '#1e1e1e' : '#fff'
      this.preWrapper.style.color = dark ? '#d4d4d4' : '#1e1e1e'
      this.toolbar.style.display = 'block'
      // 延迟聚焦，确保 DOM 已挂载
      requestAnimationFrame(() => {
        try {
          const range = document.createRange()
          const sel = window.getSelection()
          if (this.contentDOM && sel) {
            range.selectNodeContents(this.contentDOM)
            range.collapse(false)
            sel.removeAllRanges()
            sel.addRange(range)
            ;(this.contentDOM as HTMLElement).focus()
          }
        } catch {}
      })
    } else {
      this.renderChart()
    }
  }

  private enterEditMode() {
    console.log('[Mermaid Plugin] 进入源代码编辑模式')
    this.isEditing = true  // 标记进入编辑模式
    this.justEnteredEdit = Date.now()  // 记录进入时间，防止 clickOutside 立即关闭
    // 显示源代码，隐藏图表
    this.preWrapper.style.display = 'block'
    // 根据夜间模式设置样式
    const dark = isDarkMode()
    this.preWrapper.style.border = dark ? '1px solid #3c3c3c' : '1px solid #ccc'
    this.preWrapper.style.padding = '8px'
    this.preWrapper.style.borderRadius = '4px'
    this.preWrapper.style.background = dark ? '#1e1e1e' : '#fff'
    this.preWrapper.style.color = dark ? '#d4d4d4' : '#1e1e1e'
    this.chartContainer.style.display = 'none'
    this.toolbar.style.display = 'block'
    // 聚焦到代码编辑区
    requestAnimationFrame(() => {
      try {
        const range = document.createRange()
        const sel = window.getSelection()
        if (this.contentDOM && sel) {
          range.selectNodeContents(this.contentDOM)
          range.collapse(false)
          sel.removeAllRanges()
          sel.addRange(range)
          // 强制聚焦
          ;(this.contentDOM as HTMLElement).focus()
        }
      } catch {}
    })
  }

  private async renderChart() {
    const code = this.node.textContent
    console.log('[Mermaid Plugin] 开始渲染，代码长度:', code.length)

    if (!code || !code.trim()) {
      this.chartContainer.textContent = '(空 mermaid 图表)'
      return
    }

    this.chartContainer.textContent = '渲染中...'
    try {
      await renderMermaid(this.chartContainer, code)
      console.log('[Mermaid Plugin] 渲染完成')
    } catch (e) {
      console.error('[Mermaid Plugin] 渲染出错:', e)
      this.chartContainer.textContent = '渲染失败'
    }
  }

  update(node: Node) {
    console.log('[Mermaid Plugin] update 被调用, isEditing:', this.isEditing)
    if (node.type !== this.node.type) return false

    this.node = node

    // 编辑模式下不渲染，等退出编辑模式后再渲染
    if (this.isEditing) {
      console.log('[Mermaid Plugin] 编辑模式中，跳过渲染')
      return true
    }

    return true
  }

  destroy() {
    console.log('[Mermaid Plugin] destroy 被调用')
    // 清理事件监听器
    try {
      document.removeEventListener('click', this.handleClickOutside)
    } catch {}
  }

  private handleClickOutside = (e: Event) => {
    // 防止刚进入编辑模式就被关闭（双击事件后的 click 事件）
    if (Date.now() - this.justEnteredEdit < 500) return

    if (this.preWrapper.style.display !== 'none') {
      const target = e.target as HTMLElement
      if (!this.dom.contains(target)) {
        this.isEditing = false  // 标记退出编辑模式
        this.preWrapper.style.display = 'none'
        this.chartContainer.style.display = 'block'
        this.toolbar.style.display = 'none'
        requestAnimationFrame(() => {
          this.renderChart()
        })
      }
    }
  }

  ignoreMutation(mutation: any) {
    // 忽略图表容器的任何变化
    if (mutation.target === this.chartContainer || this.chartContainer.contains(mutation.target as globalThis.Node)) {
      return true
    }
    // 忽略工具栏的任何变化
    if (mutation.target === this.toolbar || this.toolbar.contains(mutation.target as globalThis.Node)) {
      return true
    }
    // 忽略 preWrapper 的样式/属性变化（防止切换编辑模式时闪烁）
    if (mutation.target === this.preWrapper && mutation.type === 'attributes') {
      return true
    }
    // contentDOM (代码编辑区) 的内容变化需要通知 ProseMirror 以同步到文档
    return false
  }

  private deleteSelf() {
    try {
      const pos = this.getPos?.()
      if (typeof pos !== 'number') return
      const { state, dispatch } = this.view
      const from = pos
      const to = pos + this.node.nodeSize
      dispatch(state.tr.delete(from, to).scrollIntoView())
    } catch {}
  }
}

// 创建 mermaid 插件
export const mermaidPlugin = $view(codeBlockSchema.node, () => {
  return (node, view, getPos) => {
    // 只处理 language 为 mermaid 的代码块
    const lang = node.attrs.language
    console.log('[Mermaid Plugin] $view 回调, language:', lang)

    if (lang && lang.toLowerCase() === 'mermaid') {
      console.log('[Mermaid Plugin] 创建 MermaidNodeView')
      return new MermaidNodeView(node, view, getPos as () => number | undefined)
    }

    // 其他代码块使用高亮 NodeView
    return new HighlightCodeBlockNodeView(node, view, getPos as () => number | undefined)
  }
})
