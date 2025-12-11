// 预览消毒策略与开关（从 main.ts 拆分）

// 预览消毒开关：允许在发行版关闭预览消毒（定位构建差异问题），
// 并支持用 localStorage 覆盖（flymd:sanitizePreview = '0'/'false' 关闭；'1'/'true' 开启）。
export function shouldSanitizePreview(): boolean {
  try {
    const v = localStorage.getItem('flymd:sanitizePreview')
    if (v != null) {
      const s = String(v).toLowerCase()
      if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false
      if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true
    }
  } catch {}
  // 默认策略：开发环境开启，发行版关闭（仅针对预览渲染，粘贴/更新弹窗仍保留基础消毒）
  try {
    return !!((import.meta as any).env?.DEV)
  } catch {
    return false
  }
}

