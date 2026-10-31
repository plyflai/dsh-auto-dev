/**
 * G2 破坏性操作: an exact list of commands that cannot be taken back
 * (设计约定「第三条路」). A command is matched by its program and its flags —
 * the words the shell runs — never by what its text seems to mean: quoted
 * strings and heredoc bodies are data and are blanked out first. Anything not
 * on the list runs; the checkpoints and the deleted card cover the rest.
 *
 * G3's protected files are matched only on a file tool's own path argument.
 */
export const DEFAULT_PROTECTED_PREFIXES = [
  '.auto-dev/', '.autodev/', '.dsh/', '.codex/', '.github/workflows/',
  '.git/config', '.git/hooks/',
]

// Each entry: the risk, the program, and words that must all appear among its
// arguments (any one of an inner array). Order of arguments does not matter.
const IRREVERSIBLE = [
  ['forced-git-reset', 'git', ['reset', '--hard']],
  ['forced-git-reset', 'git', ['clean', ['-f', '-fd', '-fdx', '-df', '-xdf', '--force']]],
  ['force-push', 'git', ['push', ['--force', '-f', '--force-with-lease', '--delete', '-d']]],
  ['forced-git-reset', 'git', ['branch', '-D']],
  ['forced-git-reset', 'git', ['stash', ['drop', 'clear']]],
  ['disk-or-package', 'npm', ['publish']],
  ['disk-or-package', 'pnpm', ['publish']],
  ['disk-or-package', 'yarn', ['publish']],
  ['disk-or-package', 'cargo', ['publish']],
  ['infrastructure', 'terraform', [['apply', 'destroy']]],
  ['infrastructure', 'kubectl', [['apply', 'delete', 'scale']]],
  ['infrastructure', 'helm', [['install', 'upgrade', 'uninstall']]],
  ['deploy', 'vercel', ['--prod']],
  ['deploy', 'fly', ['deploy']],
  ['deploy', 'gh', ['release', 'create']],
]

const blank = command => String(command)
  .replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?\n\s*\2\s*(?=\n|$)/g, ' ')
  .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
  .replace(/'(?:[^'\\]|\\.)*'/g, ' ')

/** The simple commands on a line, each as its words (env assignments dropped). */
export const commandsOf = command => blank(command).split(/&&|\|\||[;|\n]/)
  .map(part => part.trim().split(/\s+/).filter(Boolean))
  .map(words => { while (/^[A-Za-z_]\w*=/.test(words[0] ?? '')) words.shift(); return words })
  .map(words => words[0] === 'sudo' ? words.slice(1) : words)
  .filter(words => words.length)

/** The irreversible risks a shell line carries, from the exact list above. */
export function irreversibleIn(command) {
  if (typeof command !== 'string' || !command.trim()) return []
  const found = new Set()
  for (const [program, ...args] of commandsOf(command)) {
    const name = program.split('/').pop()
    for (const [risk, wanted, words] of IRREVERSIBLE) {
      if (name !== wanted) continue
      if (words.every(word => Array.isArray(word) ? word.some(one => args.includes(one)) : args.includes(word))) found.add(risk)
    }
  }
  return [...found]
}

// The files the plugin asks the model to write (G4 复盘、口径) are not the control plane.
const MODEL_WRITES = ['.auto-dev/incidents.md', '.auto-dev/project-domain.md']

const FILE_WRITE_TOOLS = new Set(['write', 'write_file', 'edit', 'edit_file', 'str_replace_editor', 'apply_patch'])

/** The path a file tool names, or '' — a structured argument, not shell text. */
export const filePathOf = call => {
  const args = call && typeof call.arguments === 'object' && call.arguments ? call.arguments : {}
  if (!FILE_WRITE_TOOLS.has(String(call?.name ?? ''))) return ''
  return typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : ''
}

/** Risks of the call about to run: the exact list, and a file tool writing a protected path. */
export function risksOfCall(call, { protectedPrefixes = DEFAULT_PROTECTED_PREFIXES } = {}) {
  const args = call && typeof call.arguments === 'object' && call.arguments ? call.arguments : {}
  const destructive = irreversibleIn(typeof args.command === 'string' ? args.command : '')
  const path = filePathOf(call)
  if (path && isProtectedPath(path, protectedPrefixes) && !MODEL_WRITES.some(file => normalizePath(path).endsWith(file))) destructive.push('control-plane')
  return { destructive, production: [] }
}

/**
 * A protected path is protected wherever it sits: the tools report absolute
 * paths while the setting is written the way a person says it. Containment is
 * decided at a segment boundary so `not.auto-dev/` does not sneak in.
 */
export function isProtectedPath(path, prefixes = DEFAULT_PROTECTED_PREFIXES) {
  const normalized = normalizePath(path)
  return prefixes.some(raw => {
    const prefix = normalizePath(raw).replace(/\/+$/, '')
    if (!prefix) return false
    return normalized === prefix || normalized.startsWith(`${prefix}/`) || normalized.includes(`/${prefix}/`) || normalized.endsWith(`/${prefix}`)
  })
}

export function normalizePath(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '')
}
