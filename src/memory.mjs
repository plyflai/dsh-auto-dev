/**
 * What the project has learned, kept next to the project.
 *
 * The task ledger lives in the host's storage, which is the right home for "who
 * claimed what" — but it travels with the profile, not with the repository. What a
 * project has learned (how it is built, what failed before) has to survive a
 * machine change, a reinstall and a different assistant, so it is written here as
 * plain JSON a person can read and a reviewer can diff.
 *
 * Two shapes, because they age differently:
 *  - a fact is stable ("tests run with `npm test` in the workspace root")
 *  - an incident is conditional ("this symptom meant that mechanism, fixed so")
 * A fact can be reused without context; an incident is a hypothesis to re-check,
 * never a rule to apply blindly.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const MEMORY_FILE = '.auto-dev/memory.json'
export const LEGACY_LEARNING_FILE = '.auto-dev/postmortem.md'
const MAX_FACTS = 60
const MAX_INCIDENTS = 60

export function memoryPath(project) {
  return join(project, MEMORY_FILE)
}

/** Read what the project knows. A missing or unreadable file is simply "nothing yet". */
export function readMemory(project) {
  const empty = { version: 1, facts: [], incidents: [] }
  if (typeof project !== 'string' || project === '') return empty
  let raw
  try { raw = readFileSync(memoryPath(project), 'utf8') } catch { return empty }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { ...empty, unreadable: true } }
  return {
    version: 1,
    facts: Array.isArray(parsed?.facts) ? parsed.facts.filter(row => typeof row?.text === 'string') : [],
    incidents: Array.isArray(parsed?.incidents) ? parsed.incidents.filter(row => typeof row?.symptom === 'string') : [],
  }
}

/** Historical notes remain accessible, with no migration or claim of verification. */
export function readLegacyLearning(project) {
  try { return { path: LEGACY_LEARNING_FILE, text: readFileSync(join(project, LEGACY_LEARNING_FILE), 'utf8'), status: 'legacy-unverified' } }
  catch { return null }
}

/** The part of the memory worth putting in front of a model starting work. */
export function relatedRows(rows, { query = '', limit, text = row => row.text } = {}) {
  const tokens = value => {
    const words = String(value).toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? []
    return new Set(words.flatMap(word => /[\p{Script=Han}]/u.test(word)
      ? Array.from({ length: Math.max(1, word.length - 1) }, (_, i) => word.slice(i, i + 2)) : [word]))
  }
  const wanted = tokens(query), seen = new Set()
  const unique = rows.filter(row => {
    const key = String(text(row)).trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (!wanted.size) return unique.slice(-limit)
  return unique.map((row, index) => ({ row, index, score: [...tokens(text(row))].filter(word => wanted.has(word)).length }))
    .sort((a, b) => b.score - a.score || b.index - a.index).slice(0, limit).map(item => item.row)
}

export function memoryBrief(memory, { facts = 5, incidents = 3, query = '' } = {}) {
  return {
    facts: relatedRows(memory.facts, { query, limit: facts }).map(row => row.text),
    incidents: relatedRows(memory.incidents, { query, limit: incidents, text: row => `${row.symptom} ${row.mechanism ?? ''} ${row.finding ?? ''}` }).map(row => ({
      symptom: row.symptom,
      ...(row.mechanism ? { mechanism: row.mechanism } : {}),
      ...(row.repair ? { repair: row.repair } : {}),
      ...(row.finding ? { finding: row.finding } : {}),
      ...(row.prevention ? { prevention: row.prevention } : {}),
      ...(row.hypothesis ? { hypothesis: row.hypothesis } : {}),
      status: row.mechanism ? 'recorded-mechanism' : 'observation',
    })),
    counts: { facts: memory.facts.length, incidents: memory.incidents.length },
  }
}

function write(project, memory) {
  const path = memoryPath(project)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, facts: memory.facts.slice(-MAX_FACTS), incidents: memory.incidents.slice(-MAX_INCIDENTS) }, null, 2) + '\n')
  // Rename last: a half-written memory file would be worse than none.
  renameSync(temporary, path)
  return path
}

function uncertainMechanism(cause) {
  // Explicitly resolved history does not make the newly confirmed cause unknown.
  const resolved = /(?:现(?:在)?已(?:经)?|目前已|最终|已经|\bnow\b|\bsubsequently\b|\bfinally\b)\s*(?:确认|证实|查明|confirmed|verified|established)\s*[:：]?\s*([\s\S]+)/i.exec(cause)
  const current = resolved?.[1] ?? cause
  return /未知|不明|不确定|尚未|未(?:能|经)?(?:确认|查明|证实)|未明|待(?:查|定|确认)|可能|疑似|假设|推测|怀疑|或许|\b(?:unknown|unclear|uncertain|unconfirmed|tbd|maybe|perhaps|suspect(?:ed)?|hypothes(?:is|ized)|may|might|could|not\s+(?:yet\s+)?(?:known|confirmed|verified|established|understood)|do\s+not\s+know|don't\s+know|not\s+sure)\b/i.test(current)
}

/** Record one project learning; identical entries are not stored twice. */
export function remember(project, input, { taskId, session } = {}) {
  const memory = readMemory(project)
  const at = new Date().toISOString()
  // A memory that only grows stops being read: at the ceiling the answer is
  // "merge two entries", not "raise the ceiling".
  const total = memory.facts.length + memory.incidents.length
  if (total >= MAX_FACTS + MAX_INCIDENTS) {
    throw new Error(`记忆已经 ${total} 条（上限 ${MAX_FACTS + MAX_INCIDENTS}）：把同类的合并一条、或者删掉过时的，再记新的。`)
  }
  const source = { session: typeof session === 'string' ? session : undefined, at }
  if (input.kind === 'fact') {
    const text = String(input.text ?? '').trim()
    if (text === '') throw new Error('a fact needs its text: state the reusable thing plainly, without a file path or a temporary decision')
    if (memory.facts.some(row => row.text === text)) return { stored: false, kind: 'fact', text, reason: 'the project already knows this fact' }
    memory.facts.push({ id: `fact-${randomUUID().slice(0, 8)}`, text, at, ...(taskId ? { taskId } : {}), ...(source.session ? { source } : {}) })
    return { stored: true, kind: 'fact', text, path: write(project, memory) }
  }
  const symptom = String(input.symptom ?? input.text ?? '').trim()
  const cause = String(input.mechanism ?? '').trim()
  const uncertain = uncertainMechanism(cause)
  const mechanism = uncertain ? '' : cause
  const repair = String(input.repair ?? '').trim()
  if (symptom === '') throw new Error('an incident needs a symptom: what was observed, in the words a person would use')
  const row = { symptom, ...(mechanism ? { mechanism } : {}), status: mechanism ? 'recorded-mechanism' : 'observation',
    ...(uncertain ? { hypothesis: cause } : {}),
    ...(repair ? { repair } : {}), ...(input.finding ? { finding: String(input.finding).trim() } : {}),
    ...(input.prevention ? { prevention: String(input.prevention).trim() } : {}) }
  const prior = memory.incidents.find(item => item.symptom === symptom && (item.mechanism ?? '') === mechanism)
  if (prior) {
    const changed = Object.entries(row).some(([key, value]) => prior[key] !== value)
    if (!changed) return { stored: false, kind: 'incident', ...row, reason: 'the project already knows this incident' }
    Object.assign(prior, row, { at, ...(taskId ? { taskId } : {}), ...(source.session ? { source } : {}) })
    return { stored: true, updated: true, kind: 'incident', ...row, path: write(project, memory) }
  }
  memory.incidents.push({ id: `incident-${randomUUID().slice(0, 8)}`, ...row, at, ...(taskId ? { taskId } : {}), ...(source.session ? { source } : {}) })
  return { stored: true, kind: 'incident', ...row, path: write(project, memory) }
}
