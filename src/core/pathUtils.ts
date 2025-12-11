// 路径与 URL 相关的小工具函数

// 简单判断一个字符串是否更像本地路径（用于区分本地/远程安装）
export function isLikelyLocalPath(input: string): boolean {
  const v = (input || '').trim()
  if (!v) return false
  if (/^[A-Za-z]:[\\/]/.test(v)) return true
  if (/^\\\\/.test(v)) return true
  if (v.startsWith('/')) return true
  return false
}

