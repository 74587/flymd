// 图床（S3/R2）设置对话框 UI 模块
// 从 main.ts 拆分：负责图床设置弹窗的 DOM 操作与交互逻辑

import type { Store } from '@tauri-apps/plugin-store'

export type UploaderDialogDeps = {
  getStore(): Store | null
  showError(msg: string, err?: unknown): void
  setUploaderEnabledSnapshot(enabled: boolean): void
}

// 图床设置弹窗显隐控制
export function showUploaderOverlay(show: boolean): void {
  const overlay = document.getElementById('uploader-overlay') as HTMLDivElement | null
  if (!overlay) return
  if (show) overlay.classList.remove('hidden')
  else overlay.classList.add('hidden')
}

// 简单的连通性测试：只验证 Endpoint 可达性（不进行真实上传）
export async function testUploaderConnectivity(endpoint: string): Promise<{ ok: boolean; status: number; note: string }> {
  try {
    const ep = (endpoint || '').trim()
    if (!ep) return { ok: false, status: 0, note: '请填写 Endpoint' }
    let u: URL
    try { u = new URL(ep) } catch { return { ok: false, status: 0, note: 'Endpoint 非法 URL' } }
    const origin = u.origin
    try {
      const mod: any = await import('@tauri-apps/plugin-http')
      if (mod && typeof mod.fetch === 'function') {
        const r = await mod.fetch(origin, { method: 'HEAD' })
        const ok = r && (r.ok === true || (typeof r.status === 'number' && r.status >= 200 && r.status < 500))
        return { ok, status: (r as any)?.status ?? 0, note: ok ? '可访问' : '不可访问' }
      }
    } catch {}
    try {
      const r2 = await fetch(origin as any, { method: 'HEAD' as any, mode: 'no-cors' as any } as any)
      void r2
      return { ok: true, status: 0, note: '已发起网络请求' }
    } catch (e: any) {
      return { ok: false, status: 0, note: e?.message || '网络失败' }
    }
  } catch (e: any) {
    return { ok: false, status: 0, note: e?.message || '异常' }
  }
}

// 打开图床设置对话框：读取配置并绑定交互
export async function openUploaderDialog(deps: UploaderDialogDeps): Promise<void> {
  const overlay = document.getElementById('uploader-overlay') as HTMLDivElement | null
  const form = overlay?.querySelector('#upl-form') as HTMLFormElement | null
  if (!overlay || !form) return

  const inputEnabled = overlay.querySelector('#upl-enabled') as HTMLInputElement
  const inputAlwaysLocal = overlay.querySelector('#upl-always-local') as HTMLInputElement
  const inputAk = overlay.querySelector('#upl-ak') as HTMLInputElement
  const inputSk = overlay.querySelector('#upl-sk') as HTMLInputElement
  const inputBucket = overlay.querySelector('#upl-bucket') as HTMLInputElement
  const inputEndpoint = overlay.querySelector('#upl-endpoint') as HTMLInputElement
  const inputRegion = overlay.querySelector('#upl-region') as HTMLInputElement
  const inputDomain = overlay.querySelector('#upl-domain') as HTMLInputElement
  const inputTpl = overlay.querySelector('#upl-template') as HTMLInputElement
  const inputPathStyle = overlay.querySelector('#upl-pathstyle') as HTMLInputElement
  const inputAcl = overlay.querySelector('#upl-acl') as HTMLInputElement
  const inputWebpEnable = overlay.querySelector('#upl-webp-enable') as HTMLInputElement
  const inputWebpQuality = overlay.querySelector('#upl-webp-quality') as HTMLInputElement
  const labelWebpQualityVal = overlay.querySelector('#upl-webp-quality-val') as HTMLSpanElement
  const inputWebpLocal = overlay.querySelector('#upl-webp-local') as HTMLInputElement
  const btnCancel = overlay.querySelector('#upl-cancel') as HTMLButtonElement
  const btnClose = overlay.querySelector('#upl-close') as HTMLButtonElement
  const btnTest = overlay.querySelector('#upl-test') as HTMLButtonElement
  const testRes = overlay.querySelector('#upl-test-result') as HTMLDivElement

  const store = deps.getStore()

  // 预填
  try {
    if (store) {
      const up = (await store.get('uploader')) as any
      inputEnabled.checked = !!up?.enabled
      inputAlwaysLocal.checked = !!up?.alwaysLocal
      inputAk.value = up?.accessKeyId || ''
      inputSk.value = up?.secretAccessKey || ''
      inputBucket.value = up?.bucket || ''
      inputEndpoint.value = up?.endpoint || ''
      inputRegion.value = up?.region || ''
      inputDomain.value = up?.customDomain || ''
      inputTpl.value = up?.keyTemplate || '{year}/{month}{fileName}{md5}.{extName}'
      inputPathStyle.checked = up?.forcePathStyle !== false
      inputAcl.checked = up?.aclPublicRead !== false
      inputWebpEnable.checked = !!up?.convertToWebp
      const q = typeof up?.webpQuality === 'number' ? up.webpQuality : 0.85
      inputWebpQuality.value = String(q)
      if (labelWebpQualityVal) labelWebpQualityVal.textContent = String(Number(q).toFixed(2))
      inputWebpLocal.checked = !!up?.saveLocalAsWebp
    }
  } catch {}

  showUploaderOverlay(true)

  // 开关即时生效：切换启用时立即写入（仅在必填项齐全时生效）
  try {
    const applyImmediate = async () => {
      try {
        const cfg = {
          enabled: !!inputEnabled.checked,
          alwaysLocal: !!inputAlwaysLocal.checked,
          accessKeyId: inputAk.value.trim(),
          secretAccessKey: inputSk.value.trim(),
          bucket: inputBucket.value.trim(),
          endpoint: inputEndpoint.value.trim() || undefined,
          region: inputRegion.value.trim() || undefined,
          customDomain: inputDomain.value.trim() || undefined,
          keyTemplate: inputTpl.value.trim() || '{year}/{month}{fileName}{md5}.{extName}',
          forcePathStyle: !!inputPathStyle.checked,
          aclPublicRead: !!inputAcl.checked,
          convertToWebp: !!inputWebpEnable.checked,
          webpQuality: (() => { const n = parseFloat(inputWebpQuality.value); return Number.isFinite(n) ? n : 0.85 })(),
          saveLocalAsWebp: !!inputWebpLocal.checked,
        }
        if (cfg.enabled && !cfg.alwaysLocal) {
          if (!cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
            // 直接使用 alert，避免额外依赖
            alert('启用上传需要 AccessKeyId、SecretAccessKey、Bucket')
            inputEnabled.checked = false
            return
          }
        }
        if (store) {
          await store.set('uploader', cfg)
          await store.save()
          deps.setUploaderEnabledSnapshot(!!cfg.enabled)
        }
      } catch (e) {
        console.warn('即时应用图床开关失败', e)
      }
    }
    inputEnabled.addEventListener('change', () => { void applyImmediate() })
    inputAlwaysLocal.addEventListener('change', () => { void applyImmediate() })
    inputWebpEnable.addEventListener('change', () => { void applyImmediate() })
    inputWebpQuality.addEventListener('input', () => {
      try {
        if (labelWebpQualityVal) {
          labelWebpQualityVal.textContent = String(Number(parseFloat(inputWebpQuality.value)).toFixed(2))
        }
      } catch {}
    })
    inputWebpQuality.addEventListener('change', () => { void applyImmediate() })
    inputWebpLocal.addEventListener('change', () => { void applyImmediate() })
  } catch {}

  const onCancel = () => { showUploaderOverlay(false) }

  const onSubmit = async (e: Event) => {
    e.preventDefault()
    try {
      const cfg = {
        enabled: !!inputEnabled.checked,
        alwaysLocal: !!inputAlwaysLocal.checked,
        accessKeyId: inputAk.value.trim(),
        secretAccessKey: inputSk.value.trim(),
        bucket: inputBucket.value.trim(),
        endpoint: inputEndpoint.value.trim() || undefined,
        region: inputRegion.value.trim() || undefined,
        customDomain: inputDomain.value.trim() || undefined,
        keyTemplate: inputTpl.value.trim() || '{year}/{month}{fileName}{md5}.{extName}',
        forcePathStyle: !!inputPathStyle.checked,
        aclPublicRead: !!inputAcl.checked,
        convertToWebp: !!inputWebpEnable.checked,
        webpQuality: (() => { const n = parseFloat(inputWebpQuality.value); return Number.isFinite(n) ? n : 0.85 })(),
        saveLocalAsWebp: !!inputWebpLocal.checked,
      }
      if (cfg.enabled && !cfg.alwaysLocal) {
        if (!cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
          alert('启用直传时 AccessKeyId、SecretAccessKey、Bucket 为必填')
          return
        }
      }
      if (store) {
        await store.set('uploader', cfg)
        await store.save()
        deps.setUploaderEnabledSnapshot(!!cfg.enabled)
      }
      showUploaderOverlay(false)
    } catch (err) {
      deps.showError('保存图床设置失败', err)
    } finally {
      try { form.removeEventListener('submit', onSubmit) } catch {}
      try { btnCancel?.removeEventListener('click', onCancel) } catch {}
      try { btnClose?.removeEventListener('click', onCancel) } catch {}
      try { overlay.removeEventListener('click', onOverlayClick) } catch {}
      try { btnTest?.removeEventListener('click', onTestClick) } catch {}
    }
  }

  const onOverlayClick = (e: MouseEvent) => { if (e.target === overlay) onCancel() }

  const onTestClick = async (ev: MouseEvent) => {
    ev.preventDefault()
    try {
      if (!testRes) return
      const ep = (inputEndpoint?.value || '').trim()
      testRes.textContent = '测试中...'
      ;(testRes as any).className = ''
      testRes.id = 'upl-test-result'
      const res = await testUploaderConnectivity(ep)
      testRes.textContent = res.ok ? '可达' : '不可达'
      ;(testRes as any).className = res.ok ? 'ok' : 'err'
    } catch {
      if (testRes) {
        testRes.textContent = '测试失败'
        ;(testRes as any).className = 'err'
      }
    }
  }

  form.addEventListener('submit', onSubmit)
  btnCancel.addEventListener('click', onCancel)
  btnClose.addEventListener('click', onCancel)
  overlay.addEventListener('click', onOverlayClick)
  if (btnTest) btnTest.addEventListener('click', onTestClick)
}

