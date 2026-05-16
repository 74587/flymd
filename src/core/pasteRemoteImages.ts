export const PASTE_REMOTE_IMAGES_LOCAL_KEY = 'flymd:paste:downloadRemoteImages'

export function getPasteRemoteImagesEnabled(): boolean {
  try {
    const v = localStorage.getItem(PASTE_REMOTE_IMAGES_LOCAL_KEY)
    return v !== 'false'
  } catch {
    return true
  }
}

export function setPasteRemoteImagesEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(PASTE_REMOTE_IMAGES_LOCAL_KEY, enabled ? 'true' : 'false')
    window.dispatchEvent(new CustomEvent('flymd:paste:downloadRemoteImages', { detail: { enabled } }))
  } catch {}
}
