// 应用更新检测总开关：默认允许检测，只有用户显式关闭时才拦截。
export const UPDATE_CHECK_DISABLED_KEY = 'flymd:updateCheckDisabled'

export function getUpdateCheckDisabled(): boolean {
  try {
    return localStorage.getItem(UPDATE_CHECK_DISABLED_KEY) === 'true'
  } catch {
    return false
  }
}

export function setUpdateCheckDisabled(disabled: boolean): void {
  try {
    localStorage.setItem(UPDATE_CHECK_DISABLED_KEY, disabled ? 'true' : 'false')
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent('flymd:updateCheckDisabled:changed', { detail: { disabled } }))
  } catch {}
}
