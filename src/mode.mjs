/** New tasks use do; historical build records retain their original value. */
export const effectiveMode = mode => mode === 'build' ? 'do' : mode ?? 'do'
export const modeLabel = mode => effectiveMode(mode) === 'look' ? '查看（只读意图）' : mode === 'build' ? '交付（历史 build）' : '交付'
