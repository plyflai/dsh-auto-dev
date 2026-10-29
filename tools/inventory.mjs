/**
 * The control plane's inventory, read from the source rather than remembered.
 *
 * The bench's coverage gate is only as good as the list it checks against. A
 * hand-kept list rots the moment a path is added, so this module derives the
 * list from the code that ships: receipt forms (`form: '…'`, read as text), and
 * from imports — command verbs (`COMMAND_VERBS`), tool names (`WORK_TOOLS`) and
 * every enum a tool call can carry (`operation`, `view`, `action`).
 *
 * Anything derived here that no scenario produces is a gap, and the gate fails
 * the run — that is what makes "add a business path, add a bench scenario" a
 * rule instead of a hope.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMMAND_VERBS } from '../src/command.mjs'
import { WORK_TOOLS } from '../src/tools.mjs'

const SRC = 'src'

// Receipt forms are string literals spread through the host half, so they are
// the one list still read as text — from every module, however deep.
function sourceTexts(dir = SRC) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sourceTexts(join(dir, entry.name))
    : entry.name.endsWith('.mjs') ? [{ name: join(dir, entry.name), text: readFileSync(join(dir, entry.name), 'utf8') }] : [])
}

function unique(values) {
  return [...new Set(values)].sort()
}

/** Every `form: '…'` a receipt or badge may carry. */
function forms() {
  const found = []
  for (const { text } of sourceTexts()) {
    for (const match of text.matchAll(/form:\s*'([a-z][a-z0-9-]*)'/g)) found.push(match[1])
  }
  return unique(found)
}

/** Every verb the `/dsh-auto-dev` dispatcher accepts. */
function verbs() {
  return unique([...COMMAND_VERBS])
}

// The tool table as the host registers it. Building an entry only describes the
// tool; nothing runs until `execute` is called, so no api is needed here.
const table = () => WORK_TOOLS.map(entry => entry({}))

/** Every tool this plugin registers. */
function tools() {
  return unique(table().map(([name]) => name))
}

/**
 * Every enum value a tool call can carry, namespaced by the tool whose schema
 * declares it: `work_plan:set`, `work_control:adopt`, `work_status:view:board`.
 * A new branch is new behaviour a person can hit, so it is a business path.
 */
function operations() {
  const found = []
  for (const [tool, , properties] of table()) {
    for (const key of ['operation', 'view', 'action']) {
      for (const value of properties?.[key]?.enum ?? []) {
        found.push(`${tool}:${key === 'view' ? 'view:' : ''}${value}`)
      }
    }
  }
  return unique(found)
}

export function inventory() {
  return { forms: forms(), verbs: verbs(), tools: tools(), operations: operations() }
}

/** Panel keys the board must expose; the gate also fails on undeclared new ones. */
export const PANEL_KEYS = [
  'task', 'progress', 'pending', 'units', 'milestones', 'marks', 'waiting', 'current',
  'lastLedger', 'hint', 'readOnly', 'timeline',
]
