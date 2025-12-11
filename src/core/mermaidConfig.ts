// mermaid 配置：从 main.ts 拆分，仅负责根据当前主题生成初始化配置

export function getMermaidConfig(): any {
  const isDark =
    document.body.classList.contains('dark-mode') ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark ? 'dark' : 'default',
    logLevel: 'fatal' as any,
    fontSize: 16 as any,
    flowchart: { useMaxWidth: true } as any,
    themeVariables: isDark
      ? {
          fontFamily: 'Segoe UI, Helvetica, Arial, sans-serif',
          fontSize: '16px',
          // 夜间模式配色
          primaryColor: '#3c3c3c',
          primaryTextColor: '#d4d4d4',
          primaryBorderColor: '#505050',
          lineColor: '#808080',
          secondaryColor: '#252526',
          tertiaryColor: '#1e1e1e',
          background: '#1e1e1e',
          mainBkg: '#252526',
          secondBkg: '#1e1e1e',
          border1: '#505050',
          border2: '#3c3c3c',
          arrowheadColor: '#d4d4d4',
          textColor: '#d4d4d4',
          nodeTextColor: '#d4d4d4',
        }
      : {
          fontFamily: 'Segoe UI, Helvetica, Arial, sans-serif',
          fontSize: '16px',
        },
  }
}

