import { effectiveMode } from './mode.mjs'
/**
 * Task semantics: what a task is, what a submission must prove, and what the
 * host computes for the model instead of asking it. Every function here is pure
 * so the validation rules can be tested without a harness.
 */
import { isDelegation } from './session-log.mjs'
import { leafUnits, normalizeUnits } from './plan.mjs'

/** A dropped unit counts as moved out of scope only for the definition it had when it was dropped. */
export function approvedReduction(task, plan, unit) {
  return unit.state === 'dropped' && (task.scopeReductions ?? []).some(change => change.unit === unit.id
    && JSON.stringify(change.taskAcceptance) === JSON.stringify(task.acceptance)
    && JSON.stringify(change.definition) === JSON.stringify({ goal: unit.goal, scope: unit.scope, acceptance: unit.acceptance, dependsOn: unit.dependsOn, parent: unit.parent })
    && !plan.units.some(other => (other.dependsOn ?? []).some(id => {
      let cursor = unit
      while (cursor) { if (cursor.id === id) return true; cursor = plan.units.find(parent => parent.id === cursor.parent) }
      return false
    })))
}

/** Facts shared by the tool board and the rendered board, from the task record. */
export function taskEvidenceView(task, plan) {
  const last = (task.ledger ?? []).at(-1)
  const unverified = [...(last?.residue ?? []), ...(last?.limitations ?? [])]
  // Units still to do are the step list's to show; only what was cut from the scope is a 「没做的」.
  for (const unit of leafUnits(plan?.units ?? [])) {
    if (unit.state !== 'dropped') continue
    const reduced = approvedReduction(task, plan, unit)
    unverified.push(`${unit.id} · ${unit.goal} · ${reduced ? '已批准移出范围，未完成' : unit.state ?? 'pending'}`)
  }
  return { acceptance: task.acceptance ?? [], unverified: [...new Set(unverified)] }
}

export const MODES = ['look', 'do', 'build']
export const OUTCOMES = ['complete', 'partial', 'blocked', 'failed']
export const TASK_STATES = ['active', 'paused', 'review_ready', 'cancelled', 'closed']
export const ACCEPTANCE_MODES = ['pm', 'auto']

/**
 * Who gets to say this task is done.
 *
 * "pm" means an answer is not a result until the person has used it, so the last
 * unit parks the task where it can be looked at. "auto" means the project's own
 * checks decide. A look task never writes, so it never waits for anybody.
 */
export function acceptanceModeOf(value, mode) {
  return ACCEPTANCE_MODES.includes(value) ? value : mode === 'look' ? 'auto' : 'pm'
}

/** look or do; anything else is read as do, the way `build` always was. */
export function modeOf(mode) {
  if (MODES.includes(mode)) return effectiveMode(mode)
  return /^(look|read|survey|只读|调研|看看)$/i.test(String(mode ?? '').trim()) ? 'look' : 'do'
}

// Words a model uses for an outcome; anything unrecognised reads as partial, which
// claims nothing and so cannot be a false delivery.
const OUTCOME_WORDS = [
  ['complete', /^(complete[ds]?|done|finished|success(ful)?|ok|pass(ed)?|完成|已完成|做完了?)$/i],
  ['blocked', /^(block(ed)?|stuck|waiting|卡住|受阻)$/i],
  ['failed', /^(fail(ed|ure)?|error|失败)$/i],
]
export function outcomeOf(value) {
  const word = String(value ?? '').trim()
  if (OUTCOMES.includes(word)) return word
  return OUTCOME_WORDS.find(([, pattern]) => pattern.test(word))?.[0] ?? 'partial'
}

/** One line of text out of whatever came, cut to `max`. Never refuses: a missing value is ''. */
export function text(value, max = 4000) {
  const body = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  return body.trim().slice(0, max)
}

/** Text items out of whatever came: a list, one string, or nothing. Never refuses. */
export function texts(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return list.map(entry => typeof entry === 'string' ? entry.trim() : '').filter(Boolean)
}

export function createTaskRecord({ id, project, sessionId, ownerId, request, goal, mode, acceptanceMode, program, scope, acceptance, deliverable, startedSeq, startedTurn, now }) {
  return {
    id, version: 1, project,
    sessionId, ...(ownerId ? { ownerId } : {}),
    // Every session that has held this task. `sessionId` is the one holding it
    // now; the list is what lets a board opened in an earlier conversation still
    // find the work after it was handed on (see `taskForSession`).
    sessions: sessionId ? [sessionId] : [],
    request, goal: goal ?? '', mode,
    acceptanceMode: acceptanceMode ?? (mode === 'look' ? 'auto' : 'pm'),
    scope: scope && scope.length ? scope : ['.'],
    acceptance, ...(deliverable ? { deliverable } : {}), ...(program ? { program } : {}),
    state: 'active', enrolled: true,
    startedSeq: startedSeq ?? 0, startedTurn: startedTurn ?? 0,
    units: [], ledger: [],
    createdAt: now, updatedAt: now,
  }
}

/**
 * The evidence window of a task: everything the session logged after the task
 * started. A resumed session keeps its window because `startedSeq` belongs to
 * that same session log.
 */
export function windowObservations(observations, task, unit) {
  const since = windowStart(task, unit)
  return { ...observations, results: observations.results.filter(row => row.seq >= since) }
}

/**
 * A unit the model never activated starts where the previous unit settled, not
 * at the task's start: otherwise u2 inherits every file u1 wrote and its scope
 * check reports u1's work as out of scope (observed live on a 3-unit task).
 */
export function windowStart(task, unit) {
  const opened = unit ? (unit.startedSeq ?? task.settledSeq ?? 0) : 0
  return Math.max(task.startedSeq ?? 0, opened)
}

/** Commands whose argv actually starts a browser, not sentences that name one. */
const BROWSER_BINARIES = /^(playwright|puppeteer|cypress|codeceptjs|selenium-standalone)$/i
const RUNNERS = /^(npx|pnpm|yarn|bunx|npm|node|deno|playwright|puppeteer|cypress)$/i



/**
 * Validate one submission. Errors block; warnings are recorded on the ledger and
 * shown on the board. Every rule here exists because the model can otherwise
 * claim something the session log cannot back.
 */
/**
 * What a delegation costs the ledger, before anyone has read the child sessions.
 * When the reader does have them the sentence changes — see `reconcileDelegation`,
 * because "opaque" stops being true once the child's writes are listed.
 */
export function opaqueDelegation(count) {
  return `delegated work is opaque: ${count} subagent call(s) — their writes are not in this task's log, so scope and staleness cover this session only`
}

/** The same warning, once the child sessions have actually been read. */
export function reconcileDelegation(warnings, children) {
  const readable = (children ?? []).filter(child => child && child.reachable)
  if (!readable.length) return warnings
  const kept = warnings.filter(warning => !/^delegated work is opaque:/.test(warning))
  kept.push(`delegated work ran in ${readable.length} subagent session(s): their writes are listed below, but scope and staleness still only cover this session — run the check yourself before claiming the result`)
  return kept
}

export function validateSubmission({ task, unit, args, observations }) {
  // Shape is the plugin's to absorb, never a reason to refuse. What the model says
  // it did is kept as its words; the plugin's own facts are checked at hand-in
  // (src/facts.mjs handInGate), not read out of these statements.
  const outcome = outcomeOf(args.outcome)
  const summary = (typeof args.summary === 'string' ? args.summary.trim() : '').slice(0, 4000) || String(unit?.goal ?? task.goal ?? '').trim()
  const next = typeof args.next === 'string' ? args.next.trim() : ''
  const residue = texts(args.residue)
  const claims = (Array.isArray(args.claims) ? args.claims : [])
    .map(claim => typeof claim === 'string' ? claim : claim?.statement)
    .filter(statement => typeof statement === 'string' && statement.trim())
    .map(statement => ({ statement: statement.trim().slice(0, 500) }))
  // A child session keeps its own log: say so, so the hand-in names it.
  const delegations = (observations?.results ?? []).filter(isDelegation).length
  const warnings = delegations ? [opaqueDelegation(delegations)] : []
  return { ok: true, warnings, outcome, summary, next, residue, claims, delegations }
}


export function planForTask(plan) { return plan ?? undefined }
export { normalizeUnits }
