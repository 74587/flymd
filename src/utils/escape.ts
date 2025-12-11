// 通用 HTML 属性转义函数（从 main.ts / contextMenus 拆分统一）

export function escapeAttrValue(input: string): string {
  try {
    return String(input)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  } catch {
    return ''
  }
}

