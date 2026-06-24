// 符号自动补全总开关：源码模式与所见模式共用同一配置
export const SYMBOL_AUTO_COMPLETION_KEY = 'flymd:symbolAutoCompletion:enabled'

export function getSymbolAutoCompletionEnabled(): boolean {
  try {
    return localStorage.getItem(SYMBOL_AUTO_COMPLETION_KEY) !== 'false'
  } catch {
    return true
  }
}

export function setSymbolAutoCompletionEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SYMBOL_AUTO_COMPLETION_KEY, enabled ? 'true' : 'false')
  } catch {}
  try {
    const ev = new CustomEvent('flymd:symbolAutoCompletion:changed', { detail: { enabled } })
    window.dispatchEvent(ev)
  } catch {}
}
