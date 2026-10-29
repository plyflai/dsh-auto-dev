/**
 * Where does this task actually live?
 *
 * A session has one recorded working directory, and a subagent started with a
 * `cwd` option does not always rewrite it: the shell honours the subagent's
 * directory while the session metadata still reports the parent's. A task
 * registered there then resolves every declared scope path one level too high,
 * and the submission warning "writes outside the declared scope" fires on work
 * that touched exactly the declared files — observed twice, in journey D and
 * journey E.
 *
 * The rule here is deliberately timid: adjust the root only when the declared
 * paths exist under exactly one immediate subdirectory and nowhere else. When
 * the evidence is ambiguous, the recorded root stands.
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'


/**
 * @param {string} project the resolved project root
 * @param {readonly string[]} scope declared scope entries, project-relative
 * @returns {{project: string, adjusted: boolean, reason?: string, candidates?: string[]}}
 */
export function resolveScopeRoot(project, scope) {
  const declared = (scope ?? []).filter(entry => typeof entry === 'string' && entry !== '' && entry !== '.' && entry !== './')
  if (declared.length === 0) return { project, adjusted: false }
  // A scope that resolves at the recorded root is right by definition.
  if (declared.some(entry => existsSync(path.join(project, entry)))) return { project, adjusted: false }

  let children
  try {
    children = readdirSync(project, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name)
  } catch {
    return { project, adjusted: false, reason: 'the project directory could not be read' }
  }

  const matches = children.filter(child => declared.every(entry => existsSync(path.join(project, child, entry))))
  if (matches.length === 1) {
    return {
      project: path.join(project, matches[0]),
      adjusted: true,
      reason: `scope paths exist under ${matches[0]}/, not at the recorded root`,
    }
  }
  if (matches.length > 1) {
    return {
      project, adjusted: false, candidates: matches,
      reason: `scope paths exist under ${matches.length} subdirectories (${matches.join(', ')}); declare the subdirectory in scope instead of relying on the recorded root`,
    }
  }
  return { project, adjusted: false, reason: 'no scope path exists yet, so the recorded root stands' }
}
