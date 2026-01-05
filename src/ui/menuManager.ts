/**
 * 全局菜单管理器
 * 确保同一时间只有一个菜单显示
 */

// 菜单关闭函数注册表
const menuClosers: Map<string, () => void> = new Map()

/**
 * 注册菜单关闭函数
 * @param id 菜单唯一标识
 * @param closer 关闭函数
 */
export function registerMenuCloser(id: string, closer: () => void): void {
  menuClosers.set(id, closer)
}

/**
 * 关闭所有菜单
 * @param except 可选，排除的菜单 ID（不关闭该菜单）
 */
export function closeAllMenus(except?: string): void {
  menuClosers.forEach((closer, id) => {
    if (id !== except) {
      try {
        closer()
      } catch {}
    }
  })
}

/**
 * 关闭指定菜单
 * @param id 菜单唯一标识
 */
export function closeMenu(id: string): void {
  const closer = menuClosers.get(id)
  if (closer) {
    try {
      closer()
    } catch {}
  }
}
