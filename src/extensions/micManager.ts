// 统一麦克风管理：保证同一时间只有一个功能占用麦克风。
// 原则：数据结构简单；失败就明确告诉用户“谁在占用”。

export type MicOwnerId = 'speech-transcribe' | 'asr-note'

export type MicLease = {
  owner: MicOwnerId
  stream: MediaStream
  release(): void
}

type ActiveMic = {
  owner: MicOwnerId
  stream: MediaStream
}

let _active: ActiveMic | null = null

export function getActiveMicOwner(): MicOwnerId | null {
  return _active?.owner || null
}

export function forceReleaseMic(): void {
  try {
    const cur = _active
    _active = null
    try { cur?.stream?.getTracks?.().forEach((t) => { try { t.stop() } catch {} }) } catch {}
  } catch {}
}

export async function acquireMic(owner: MicOwnerId): Promise<MicLease> {
  const cur = _active
  if (cur) {
    if (cur.owner === owner) {
      throw new Error('麦克风已被当前功能占用')
    }
    throw new Error(`麦克风正在被占用：${cur.owner}`)
  }

  if (!(navigator as any)?.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持麦克风（缺少 getUserMedia）')
  }

  const stream = await (navigator as any).mediaDevices.getUserMedia({ audio: true })
  _active = { owner, stream }

  let released = false
  const lease: MicLease = {
    owner,
    stream,
    release() {
      if (released) return
      released = true
      if (_active && _active.owner === owner && _active.stream === stream) {
        _active = null
      }
      try { stream.getTracks().forEach((t) => { try { t.stop() } catch {} }) } catch {}
    },
  }
  return lease
}

