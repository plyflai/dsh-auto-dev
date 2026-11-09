/**
 * The postmortems as a small knowledge base: this project's `.auto-dev/incidents.md`
 * and the copies other projects left in the team's place (src/team.mjs).
 *
 * An entry is a `## ` section; its first line is the title the model wrote so a later
 * model can tell at a glance what the entry is about. A file written without headings
 * is one entry titled by its first line — shape is never a reason to refuse.
 *
 * Nothing here reads meaning: the index is the titles as written, and a search keeps
 * the entries that contain the words the model chose, ranked by how many they contain.
 * No new storage (大原则 8): it reads files the hand-in already trims and shares.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INCIDENTS_FILE, MAX_INCIDENTS } from './facts.mjs'
import { teamFiles } from './team.mjs'

const TITLE_MAX = 60

/** `[{ title, text }]` oldest first; '' text gives []. */
export function entriesOf(text) {
  const body = String(text ?? '').trim()
  if (!body) return []
  const parts = body.split(/\n(?=## )/)
  const sections = parts[0].startsWith('## ') ? parts : parts.slice(1)
  const rows = sections.length ? sections : [body]
  return rows.map(part => {
    const first = part.trim().split('\n')[0].replace(/^#+\s*/, '').trim()
    const title = first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}…` : first
    return { title: title || '（没写标题）', text: part.trim() }
  })
}

const own = project => { try { return readFileSync(join(project, INCIDENTS_FILE), 'utf8') } catch { return '' } }

/** Every entry the model can reach, newest first: this project's, then each other project's. */
export function allIncidents(project) {
  const here = entriesOf(own(project)).reverse().map(row => ({ ...row, from: '本项目' }))
  const team = teamFiles(project).flatMap(file => entriesOf(file.text).slice(-MAX_INCIDENTS).reverse().map(row => ({ ...row, from: file.project })))
  return [...here, ...team]
}

/**
 * The titles, for a start brief: `{ here: [title], team: [{ project, path, titles }], total }`,
 * newest first, every title each file holds (the files are trimmed at hand-in already);
 * how many a card shows, and saying how many it left out, is the card's job.
 */
export function incidentIndex(project) {
  const here = entriesOf(own(project)).reverse().map(row => row.title)
  const team = teamFiles(project)
    .map(file => ({ project: file.project, path: file.path, titles: entriesOf(file.text).slice(-MAX_INCIDENTS).reverse().map(row => row.title) }))
    .filter(row => row.titles.length)
  return { here, team, total: here.length + team.reduce((sum, row) => sum + row.titles.length, 0) }
}

/**
 * Entries holding the model's words (case-insensitive, verbatim substrings), most words
 * first, newest first among equals. No words: every title, nothing ranked.
 */
export function searchIncidents(project, query, limit = 5) {
  const rows = allIncidents(project)
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return { total: rows.length, titles: rows.map(row => ({ from: row.from, title: row.title })) }
  const scored = rows
    .map((row, order) => ({ row, order, hits: words.filter(word => row.text.toLowerCase().includes(word)).length }))
    .filter(row => row.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.order - b.order)
  return {
    total: rows.length,
    matched: scored.length,
    hits: scored.slice(0, limit).map(({ row, hits }) => ({ from: row.from, title: row.title, words: `${hits}/${words.length}`, text: row.text.length > 2400 ? `${row.text.slice(0, 2400)}…` : row.text })),
  }
}
