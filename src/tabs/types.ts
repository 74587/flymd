/**
 * 多标签系统类型定义
 */

// 源码模式
export type EditorMode = 'edit' | 'preview'

// 标签文档状态
export interface TabDocument {
  id: string                          // 唯一标识符
  filePath: string | null             // 文件路径，null 表示未保存的新文档
  displayName?: string                // 显示名称（仅 filePath 为 null 时使用）
  content: string                     // 文档内容
  dirty: boolean                      // 是否有未保存的修改
  scrollTop: number                   // 滚动位置
  cursorLine: number                  // 光标所在行
  cursorCol: number                   // 光标所在列
  mode: EditorMode                    // 当前源码模式
  wysiwygEnabled: boolean             // 是否启用所见模式
  createdAt: number                   // 创建时间戳
  lastActiveAt: number                // 最后激活时间戳
  isPdf?: boolean                     // 是否是 PDF 文件
}

// 标签管理器事件
export type TabEvent =
  | { type: 'tab-created'; tab: TabDocument }
  | { type: 'tab-closed'; tabId: string }
  | { type: 'tab-switched'; fromTabId: string | null; toTabId: string }
  | { type: 'tab-updated'; tab: TabDocument }
  | { type: 'tabs-reordered'; tabs: TabDocument[] }

// 标签管理器事件监听器
export type TabEventListener = (event: TabEvent) => void

// 标签栏渲染选项
export interface TabBarOptions {
  container: HTMLElement              // 挂载容器
  onTabClick: (tabId: string) => void // 标签点击回调
  onTabClose: (tabId: string) => void // 标签关闭回调
  onNewTab: () => void                // 新建标签回调
  onTabReorder: (fromIndex: number, toIndex: number) => void // 拖拽排序回调
}

// 持久化的标签状态（用于应用重启恢复）
export interface PersistedTabState {
  tabs: Array<{
    filePath: string | null
    displayName?: string
    content: string
    dirty: boolean
    mode: EditorMode
    wysiwygEnabled: boolean
  }>
  activeTabId: string | null
}

// 生成唯一 ID
export function generateTabId(): string {
  return `tab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

// 创建新的空白标签文档
export function createEmptyTab(displayName?: string): TabDocument {
  const now = Date.now()
  return {
    id: generateTabId(),
    filePath: null,
    displayName,
    content: '',
    dirty: false,
    scrollTop: 0,
    cursorLine: 1,
    cursorCol: 1,
    mode: 'edit',
    wysiwygEnabled: false,
    createdAt: now,
    lastActiveAt: now,
  }
}

// 根据文件路径创建标签文档
export function createTabFromFile(filePath: string, content: string): TabDocument {
  const now = Date.now()
  return {
    id: generateTabId(),
    filePath,
    content,
    dirty: false,
    scrollTop: 0,
    cursorLine: 1,
    cursorCol: 1,
    mode: 'edit',
    wysiwygEnabled: false,
    createdAt: now,
    lastActiveAt: now,
  }
}

// 获取标签显示名称
export function getTabDisplayName(tab: TabDocument): string {
  if (tab.filePath) {
    // 从完整路径提取文件名
    const parts = tab.filePath.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || '未命名'
  }
  if (tab.displayName) return tab.displayName
  return '未命名'
}
