export const TAB_INDENT = '\u00A0\u00A0\u00A0\u00A0'

const LEGACY_TAB_INDENTS = ['\u3000\u3000', '\u00A0\u00A0', '&emsp;&emsp;', '\u2003\u2003'] as const
const ALL_TAB_INDENTS = [TAB_INDENT, ...LEGACY_TAB_INDENTS] as const

export function normalizeTabIndentText(input: string): string {
  let out = String(input || '')
  for (const token of LEGACY_TAB_INDENTS) {
    out = out.split(token).join(TAB_INDENT)
  }
  return out
}

export function getLeadingTabIndentLength(input: string): number {
  const text = String(input || '')
  for (const token of ALL_TAB_INDENTS) {
    if (text.startsWith(token)) return token.length
  }
  return 0
}

export function ensureLeadingTabIndent(input: string): string {
  const text = String(input || '')
  const len = getLeadingTabIndentLength(text)
  if (len > 0) return TAB_INDENT + text.slice(len)
  return TAB_INDENT + text
}

export function removeLeadingTabIndent(input: string): string {
  const text = String(input || '')
  const len = getLeadingTabIndentLength(text)
  return len > 0 ? text.slice(len) : text
}

export function getTabIndentLengthEndingAt(input: string, end: number): number {
  const text = String(input || '')
  const safeEnd = Math.max(0, Math.min(end >>> 0, text.length))
  for (const token of ALL_TAB_INDENTS) {
    if (safeEnd >= token.length && text.slice(safeEnd - token.length, safeEnd) === token) {
      return token.length
    }
  }
  return 0
}
