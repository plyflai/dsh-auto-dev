/**
 * The team's experience across projects (D2): each project's postmortems, copied
 * verbatim into ~/.dsh-auto-dev at hand-in, and read back at another project's
 * start — listed by project path, newest first. Which one applies is the model's
 * call; the plugin does no similarity reading.
 *
 * Retirement (大原则 8): one file per project, holding at most MAX_INCIDENTS
 * entries (the project's own file is trimmed to that already); at most
 * MAX_PROJECTS files, the least recently handed-in removed at every copy.
 */
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INCIDENTS_FILE } from './facts.mjs'

export const MAX_PROJECTS = 20
// The team's conventions file is the person's own (the plugin never writes it);
// a start card carries at most this many lines of it.
export const MAX_CONVENTION_LINES = 60
const HEAD = '<!-- dsh-auto-dev: '

const homeDir = () => process.env.DSH_AUTO_DEV_HOME || join(homedir(), '.dsh-auto-dev')

/** Where the team's files live; DSH_AUTO_DEV_HOME moves it (tests, a shared drive). */
export const teamDir = () => join(homeDir(), 'incidents')

/** Path of the team's conventions, written by the person, read at every start. */
export const conventionsPath = () => join(homeDir(), 'conventions.md')

/** The team's conventions verbatim, cut at MAX_CONVENTION_LINES; '' when there are none. */
export function teamConventions() {
  let text = ''
  try { text = readFileSync(conventionsPath(), 'utf8').trim() } catch { return '' }
  const lines = text.split('\n')
  return lines.length > MAX_CONVENTION_LINES ? `${lines.slice(0, MAX_CONVENTION_LINES).join('\n')}\n…（后面还有 ${lines.length - MAX_CONVENTION_LINES} 行没带出）` : text
}

const slugOf = project => String(project).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'

const sectionsOf = text => {
  const parts = text.split(/\n(?=## )/)
  return parts[0].startsWith('## ') ? parts : parts.slice(1)
}

/** Copy this project's incidents file into the team's place. Returns the path written, or ''. */
export function shareIncidents(project) {
  let text = ''
  try { text = readFileSync(join(project, INCIDENTS_FILE), 'utf8').trim() } catch { return '' }
  if (!text) return ''
  try {
    const dir = teamDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${slugOf(project)}.md`)
    writeFileSync(path, `${HEAD}${project} -->\n${text}\n`)
    const files = readdirSync(dir).filter(name => name.endsWith('.md'))
      .map(name => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const old of files.slice(MAX_PROJECTS)) rmSync(old.path, { force: true })
    return path
  } catch { return '' }
}

/**
 * The newest entries other projects left, verbatim, newest project first:
 * `[{ project, text }]`, at most `count` entries in all and `max` characters each.
 */
export function teamIncidents(project, count = 3, max = 800) {
  const dir = teamDir()
  if (!existsSync(dir)) return []
  const own = `${slugOf(project)}.md`
  let files = []
  try {
    files = readdirSync(dir).filter(name => name.endsWith('.md') && name !== own)
      .map(name => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
  } catch { return [] }
  const out = []
  for (const file of files) {
    if (out.length >= count) break
    let text = ''
    try { text = readFileSync(file.path, 'utf8') } catch { continue }
    const from = text.startsWith(HEAD) ? text.slice(HEAD.length, text.indexOf(' -->')) : file.path
    const last = sectionsOf(text.slice(text.indexOf('\n') + 1)).at(-1)?.trim()
    if (last) out.push({ project: from, text: last.length > max ? `${last.slice(0, max)}…` : last })
  }
  return out
}
