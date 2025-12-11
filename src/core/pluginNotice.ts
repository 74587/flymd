// 插件与扩展统一通知入口（从 main.ts 拆分）
// 依赖 uiNotifications，但对外只暴露一个简单函数

import { NotificationManager } from './uiNotifications'
import type { NotificationType } from './uiNotifications'

export function pluginNotice(msg: string, level: 'ok' | 'err' = 'ok', ms?: number) {
  try {
    const type: NotificationType = level === 'ok' ? 'plugin-success' : 'plugin-error'
    NotificationManager.show(type, msg, ms)
  } catch (e) {
    // 降级：使用旧的状态栏
    try {
      const el = document.getElementById('status')
      if (el) {
        el.textContent = (level === 'ok' ? '✔ ' : '✖ ') + msg
        setTimeout(() => {
          try {
            el.textContent = ''
          } catch {}
        }, ms || 1600)
      }
    } catch {}
  }
}

