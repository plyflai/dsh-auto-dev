/**
 * The project's business facts, kept next to the code.
 *
 * A term, a rule that must hold, a decision that was made and the alternative
 * that was rejected. The point is the second conversation: it should not have to
 * ask what "对账" means again. These live in the repository (`.auto-dev/`) so a
 * reinstall, a machine change or a different assistant still finds them.
 *
 * Written by the model through `work_control remember target:"domain"`, with the
 * person's own words attached. A line without a source is not a fact, it is a
 * guess that outlived its author.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DOMAIN_FILE = '.auto-dev/project-domain.md'

export const DOMAIN_SECTIONS = { term: '术语', rule: '业务不变量', decision: '耐久决策' }

const TITLE = '# 项目业务事实'
const ORDER = ['term', 'rule', 'decision']
const TITLES = { term: '## 术语', rule: '## 业务不变量', decision: '## 耐久决策' }

export function domainPath(project) {
  return join(project, DOMAIN_FILE)
}

export function domainExists(project) {
  return typeof project === 'string' && project !== '' && existsSync(domainPath(project))
}

/** Parse the file into `{ kind, key, text }` rows; anything else is left alone. */
export function readDomain(project) {
  const path = domainPath(project)
  if (!domainExists(project)) return { path, exists: false, entries: {} }
  const entries = {}
  let kind = null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line.trim())
    if (heading) {
      kind = ORDER.find(key => DOMAIN_SECTIONS[key] === heading[1].trim()) ?? null
      if (kind && !entries[kind]) entries[kind] = []
      continue
    }
    if (!kind || !line.startsWith('- ')) continue
    const body = line.slice(2).trim()
    const keyed = /^\*\*(.+?)\*\*\s+—\s+(.*)$/.exec(body)
    entries[kind].push(keyed ? { key: keyed[1].trim(), text: keyed[2].trim() } : { text: body })
  }
  return { path, exists: true, entries }
}

/** One line, one fact: `- **词** — 一句话。来源：会话 · 原话：「…」` */
function formatEntry({ key, text, quote, session }) {
  const head = key ? `- **${key}** — ${text}` : `- ${text}`
  const source = `来源：${session}`
  return `${head}。${quote ? `原话：「${quote}」。` : ''}${source}`
}

export function rememberDomain(project, { kind = 'term', key = '', text = '', quote = '', session = 'this session' } = {}) {
  const section = DOMAIN_SECTIONS[kind] ? kind : 'term'
  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '') throw new Error('remember target:"domain" needs text: the term, rule or decision in one sentence.')
  const label = typeof key === 'string' ? key.trim() : ''
  if (section !== 'decision' && label === '') {
    throw new Error(`remember target:"domain" kind:"${section}" needs key: the word or rule name this line is about.`)
  }
  const path = domainPath(project)
  const current = domainExists(project) ? readFileSync(path, 'utf8') : ''
  const line = formatEntry({ key: label, text: body, quote, session })
  // The title is ours to write, never part of what the file holds: strip it so a
  // second remember does not stack a second heading on top of the first.
  const lines = current === '' ? [] : current.split('\n').filter(line => line.trim() !== TITLE)
  // Keep the three headings in a fixed order; a file without them gets them now.
  const withHeadings = ORDER.reduce((acc, name) => {
    if (acc.some(existing => existing.trim() === TITLES[name])) return acc
    return [...acc, TITLES[name], '']
  }, lines)
  const headingIndex = withHeadings.findIndex(existing => existing.trim() === TITLES[section])
  let replaced = false
  if (label !== '') {
    const marker = `- **${label}** — `
    for (let index = headingIndex + 1; index < withHeadings.length; index += 1) {
      if (/^##\s/.test(withHeadings[index])) break
      if (withHeadings[index].startsWith(marker)) { withHeadings[index] = line; replaced = true; break }
    }
  }
  if (!replaced) {
    let insertAt = headingIndex + 1
    while (insertAt < withHeadings.length && withHeadings[insertAt].startsWith('- ')) insertAt += 1
    withHeadings.splice(insertAt, 0, line)
  }
  // One blank between sections, none at the edges: the file is meant to be read.
  const tidy = withHeadings.reduce((acc, line) => {
    if (line.trim() === '' && (acc.length === 0 || acc[acc.length - 1].trim() === '')) return acc
    if (/^##\s/.test(line) && acc.length && acc[acc.length - 1].trim() !== '') acc.push('')
    return [...acc, line]
  }, [])
  while (tidy.length && tidy[tidy.length - 1].trim() === '') tidy.pop()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${[TITLE, '', ...tidy].join('\n')}\n`, 'utf8')
  return { path, kind: section, key: label, text: body, replaced, entries: readDomain(project).entries }
}
