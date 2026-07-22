// 兼容中文正文后紧跟标点开头的加粗：作**"卖出"** / 作**(买入)**。
// 根因是 CommonMark 认为“普通字符 + ** + 标点”不能打开强调。

const strongBoundaryGuard = '\u200B'

const guardedStrongOpeners = new Set([
  '"', "'", '“', '‘', '「', '『', '《', '〈',
  '(', '（', '[', '［', '【', '〔', '{', '｛',
  '<',
])

function isEscaped(src: string, pos: number): boolean {
  let n = 0
  for (let i = pos - 1; i >= 0 && src[i] === '\\'; i--) n++
  return (n & 1) === 1
}

function isSafeAngleStrongStart(line: string, openPos: number): boolean {
  const closePos = line.indexOf('>', openPos + 1)
  if (closePos < 0 || closePos - openPos > 80) return false

  const inner = line.slice(openPos + 1, closePos).trim()
  if (!inner) return false
  if (/[<>\s]/.test(inner)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(inner)) return false
  if (/^[a-z]:[\\/]/i.test(inner) || /[\\/]/.test(inner)) return false
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/i.test(inner)) return false
  if (/^\/?[a-z][a-z0-9-]*$/i.test(inner)) return false
  if (/[=@]/.test(inner)) return false
  return true
}

function shouldGuardStrongAt(line: string, pos: number): boolean {
  if (line.charCodeAt(pos) !== 0x2A || line.charCodeAt(pos + 1) !== 0x2A) return false
  if (line.charCodeAt(pos + 2) === 0x2A) return false
  if (isEscaped(line, pos)) return false

  const next = line[pos + 2]
  if (!next || next === strongBoundaryGuard || !guardedStrongOpeners.has(next)) return false
  if (next === '<') return isSafeAngleStrongStart(line, pos + 2)
  return true
}

function guardStrongBoundaryInLine(line: string): string {
  if (!line.includes('**')) return line

  let out = ''
  let pos = 0
  while (pos < line.length) {
    const ch = line[pos]

    if (ch === '`') {
      let endRun = pos + 1
      while (endRun < line.length && line[endRun] === '`') endRun++
      const marker = line.slice(pos, endRun)
      const close = line.indexOf(marker, endRun)
      if (close >= 0) {
        out += line.slice(pos, close + marker.length)
        pos = close + marker.length
        continue
      }
    }

    if (shouldGuardStrongAt(line, pos)) {
      out += '**' + strongBoundaryGuard
      pos += 2
      continue
    }

    out += ch
    pos++
  }
  return out
}

export function guardStrongBoundaryForCommonMark(markdown: string): string {
  const src = String(markdown || '')
  if (!src.includes('**')) return src

  const parts = src.split(/(\r\n|\n|\r)/)
  let inFence = false
  let fenceChar = ''
  let out = ''

  for (const part of parts) {
    if (part === '\r\n' || part === '\n' || part === '\r') {
      out += part
      continue
    }

    const fence = part.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      const ch = fence[1][0]
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (ch === fenceChar) {
        inFence = false
        fenceChar = ''
      }
      out += part
      continue
    }

    out += inFence ? part : guardStrongBoundaryInLine(part)
  }

  return out
}

export function stripStrongBoundaryGuard(value: string): string {
  return String(value || '').replace(/\u200B/g, '')
}
