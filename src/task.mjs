import { grantsAction } from './decisions.mjs'
import { effectiveMode } from './mode.mjs'
/**
 * Task semantics: what a task is, what a submission must prove, and what the
 * host computes for the model instead of asking it. Every function here is pure
 * so the validation rules can be tested without a harness.
 */
import { classifyCommand, inScope, isProtectedPath, normalizePath, scopeViolations, DEFAULT_PROTECTED_PREFIXES } from './risk.mjs'
import { evidenceCommand, executionFailed, executionSummary, findExecution, isDelegation, isWriteExecution, perRow, wasRefused, writesAfter } from './session-log.mjs'
import { leafUnits, normalizeUnits } from './plan.mjs'

/** A scope reduction is valid only for the definition the person actually approved. */
export function approvedReduction(task, plan, unit) {
  return unit.state === 'dropped' && (task.scopeReductions ?? []).some(change => change.unit === unit.id && change.source?.taskId === task.id
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
  for (const unit of leafUnits(plan?.units ?? [])) {
    if (unit.state === 'done') continue
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
export function assertAcceptanceMode(value, mode) {
  if (value === undefined || value === null) return mode === 'look' ? 'auto' : 'pm'
  if (!ACCEPTANCE_MODES.includes(value)) {
    throw new Error(`acceptanceMode must be "pm" (the person judges the result) or "auto" (the checks judge it); got "${value}". Leave it out to get the default for the mode.`)
  }
  return value
}

export function assertMode(mode) {
  if (mode === undefined) return 'do'
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}": use "look" for read-only intent or "do" to deliver; legacy "build" is an alias of "do"`)
  return effectiveMode(mode)
}

export function assertOutcome(outcome) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(', ')}`)
  return outcome
}

export function text(value, where, { max = 4000, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${where} is required`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`${where} must be text`)
  const trimmed = value.trim()
  if (required && trimmed === '') throw new Error(`${where} is required`)
  if (trimmed.length > max) throw new Error(`${where} exceeds ${max} characters`)
  return trimmed
}

export function stringArray(value, where) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${where} must be an array of strings`)
  return value.map(entry => {
    if (typeof entry !== 'string') throw new Error(`${where} must contain only strings`)
    return entry.trim()
  }).filter(Boolean)
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
  const since = Math.max(task.startedSeq ?? 0, unit?.startedSeq ?? 0)
  return { ...observations, results: observations.results.filter(row => row.seq >= since) }
}

/** Commands whose argv actually starts a browser, not sentences that name one. */
const BROWSER_BINARIES = /^(playwright|puppeteer|cypress|codeceptjs|selenium-standalone)$/i
const RUNNERS = /^(npx|pnpm|yarn|bunx|npm|node|deno|playwright|puppeteer|cypress)$/i

/**
 * Did this observation really open a browser?
 *
 * `echo "npx playwright test --headed"` printed a sentence; counting it as a run
 * makes the whole promise cheap to fake. So the command has to start with a
 * runner (or the browser binary itself) and the binary has to be one of its words.
 */
export const browserRunOf = perRow(row => {
  const command = String(row?.command ?? '').trim()
  if (command === '') return false
  const words = command.split(/[\s;&|()]+/).map(word => word.replace(/^['"]|['"]$/g, '')).filter(Boolean)
  const first = (words[0] ?? '').toLowerCase()
  if (!RUNNERS.test(first) && !first.includes('node_modules/.bin/')) return false
  return words.some(word => BROWSER_BINARIES.test(word.split('/').pop()))
})

/** Split observed actions into the buckets the gates care about. */
export function classifyObservations(observations, { protectedPrefixes = DEFAULT_PROTECTED_PREFIXES } = {}) {
  const writes = []
  const destructive = []
  const production = []
  const delegations = []
  for (const row of observations.results) {
    // A call the gate refused never ran: counting it as a write or as an executed
    // irreversible action makes an honest submission look unauthorized (observed live:
    // a blocked control-plane write made the very next work_submit fail).
    if (wasRefused(row)) continue
    // The plugin's own tools are bookkeeping, not work. `work_control remember`
    // reports the path it wrote, and harvesting that path made the plugin's own
    // memory file look like the model reaching into the control plane — an
    // honest submission was refused for a write the gate itself performed.
    if (/^work_/.test(row.name ?? '')) continue
    // A delegation that failed handed the work to nobody: the runtime refuses
    // `subagent_medium` at depth 2, and counting that refusal made a parent that
    // merely tried get flagged as opaque for the rest of its unit.
    if (isDelegation(row)) {
      if (!row.isError) delegations.push({ callId: row.callId, seq: row.seq, name: row.name })
      continue
    }
    const targets = writeTargets(row)
    if (isWriteExecution(row)) {
      for (const path of targets) writes.push({ path, callId: row.callId, seq: row.seq })
    }
    // A control-plane write is irreversible whatever tool performed it: the
    // record itself is what the next session trusts.
    for (const path of targets) {
      if (isProtectedPath(path, protectedPrefixes)) {
        destructive.push({ ...executionSummary(row), risk: ['control-plane'], paths: [path] })
      }
    }
    const command = row.command ?? ''
    if (!command) continue
    const verdict = classifyCommand(command)
    if (verdict.destructive.length) destructive.push({ ...executionSummary(row), risk: verdict.destructive })
    if (verdict.production.length) production.push({ ...executionSummary(row), risk: verdict.production })
  }
  return { writes, destructive, production, delegations }
}

/**
 * The project-relative view of a path, which is the only view scope is written in.
 *
 * Tools report absolute paths (`/repo/src/calc.mjs`) while a person declares
 * `src/calc.mjs`; comparing the two literally flags every in-scope write as a
 * violation, which is how journey E produced a warning on a clean task.
 * A path outside the project stays absolute, so it still counts as outside.
 */
export function relativeTo(path, project) {
  const normalized = normalizePath(path)
  const root = typeof project === 'string' ? normalizePath(project).replace(/\/+$/, '') : ''
  if (!root) return normalized
  if (normalized === root) return '.'
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1)
  return normalized
}

function writeTargets(row) {
  const paths = []
  if (Array.isArray(row.paths)) paths.push(...row.paths)
  if (typeof row.path === 'string') paths.push(row.path)
  const value = row.value
  if (value && typeof value === 'object') {
    if (typeof value.path === 'string') paths.push(value.path)
    if (typeof value.file_path === 'string') paths.push(value.file_path)
  }
  if (row.name === 'bash' || row.name === 'pwsh' || row.name === 'shell') {
    // A redirection target is the only path a shell command names reliably.
    const match = /(?:^|\s)>{1,2}\s*([^\s;|&]+)/.exec(row.command ?? '')
    if (match) paths.push(match[1])
  }
  return [...new Set(paths.filter(path => typeof path === 'string' && path !== ''))]
}

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

export function validateSubmission({ task, unit, args, observations, config = {} }) {
  const errors = []
  const warnings = []
  const claims = []

  const outcome = (() => { try { return assertOutcome(args.outcome) } catch (error) { errors.push(error.message); return undefined } })()
  const summary = (() => { try { return text(args.summary, 'summary') } catch (error) { errors.push(error.message); return '' } })()
  const next = (() => { try { return text(args.next, 'next') } catch (error) { errors.push(error.message); return '' } })()
  const residue = stringArray(args.residue, 'residue')
  const declaredFiles = stringArray(args.files, 'files')

  if (task.state && task.state !== 'active') errors.push(`this task is ${task.state}: only active tasks accept submissions; resume a paused task or explicitly adopt closed work before running fresh checks`)

  const claimList = Array.isArray(args.claims) ? args.claims : []
  let manualCheck = false
  for (const [index, claim] of claimList.entries()) {
    const where = `claims[${index}]`
    let statement = ''
    try { statement = text(claim?.statement, `${where}.statement`, { max: 500 }) } catch (error) { errors.push(error.message) }
    // A manual check is the way out when nothing can be executed here (a remote
    // box, a screen a person has to look at). It still has to be checkable: at
    // most three steps someone can follow, and the submission has to say what
    // they should see.
    if (claim?.case === 'manual') {
      const steps = stringArray(claim?.steps, `${where}.steps`)
      if (steps.length === 0) { errors.push(`${where}: a manual check needs steps — up to three things a person does, in order`); continue }
      if (steps.length > 3) { errors.push(`${where}: a manual check takes at most 3 steps — put the rest in residue`); continue }
      claims.push({ statement, manual: { steps } })
      manualCheck = true
      continue
    }
    const resolved = findExecution(observations, claim?.execution)
    if (!resolved.ok) { errors.push(`${where}: ${resolved.reason}`); continue }
    const row = resolved.row
    if (executionFailed(row)) {
      errors.push(`${where}: execution ${row.callId} (${row.command ?? row.name ?? 'call'}) failed — a failed run can be reported as a failure, not as evidence of success`)
      continue
    }
    if (row.command && !evidenceCommand(row.command)) {
      errors.push(`${where}: execution ${row.callId} can mask a check's failure — rerun the check as a separate command (or an && chain), without a pipeline, fallback or trailing shell command`)
      continue
    }
    const named = typeof claim?.command === 'string' && claim.command.trim() !== ''
      ? claim.command.trim()
      : statementCommand(statement)
    if (named && row.command && !namesCommand(row.command, named)) {
      // A claim is a statement, and a statement can name a command that never
      // ran while still pointing at a genuine passing call ("tsc passes" on an
      // npm test execution). Checking only the optional `command` field lets
      // every such claim through, so read the statement too.
      errors.push(`${where}: the claim names "${named}" but the cited execution ran "${String(row.command).slice(0, 120)}" — apply evidence to the command it proves, or run the command you are claiming`)
      continue
    }
    const stale = writesAfter(observations, row.seq)
    if (stale.length) {
      errors.push(`${where}: execution ${row.callId} is stale — ${stale.length} file-changing call(s) ran after it (${stale.slice(0, 3).map(entry => entry.command ?? entry.name).join('; ')}). Re-run the check after the last change`)
      continue
    }
    claims.push({ statement, execution: executionSummary(row) })
  }

  if (manualCheck) {
    warnings.push('manual check: nothing was executed for it — name in `next` what the person should look at, in their own words')
    // "I looked at it and it passes" is a claim about a person's eyes. A manual
    // check that reads like a machine result is the one pattern worth flagging:
    // it is how an unverified result gets sold as a verified one.
    const asserted = claims.filter(row => row.manual && /通过|修好|已上线|绿了|全绿|pass(ed)?|works?/i.test(row.statement))
    if (asserted.length) {
      warnings.push(`manual check "${asserted[0].statement.slice(0, 60)}" is phrased as a passing result, but nothing was executed — say what a person should SEE, not that it passed`)
    }
  }

  // What this unit is: delivery, a refactor with behaviour to keep, or a check
  // somebody asked for. The label is what lets the host ask for the one thing that
  // kind of work cannot skip — nothing more.
  const kind = unit?.kind === 'refactor' || unit?.kind === 'verification' ? unit.kind : 'delivery'
  const preserve = stringArray(args.preserve, 'preserve')
  if (kind === 'refactor' && outcome === 'complete' && preserve.length === 0) {
    errors.push('a refactor unit completes with preserve[]: at least one sentence naming behaviour that must not change (and how you checked it)')
  }
  if (kind === 'verification' && outcome === 'complete' && claims.every(claim => claim.manual)) {
    errors.push('a verification unit needs at least one executed check — a manual look is a fine extra, not the evidence')
  }

  // A number in the conclusion is a claim about a measurement. It can be wrong,
  // but it cannot be unmeasured: name the run that produced it, or drop the number.
  const measured = /\d+(\.\d+)?\s*(%|ms\b|s\b|sec\b|秒|毫秒|倍|分钟)/i.test(summary)
  if (measured && claims.length === 0) {
    errors.push('the summary states a measured result but nothing was executed: cite the run that produced the number, or state the outcome without the number')
  }

  const mode = task.mode
  if (mode !== 'look') {
    const acceptance = [...(task.acceptance ?? []), ...(unit?.acceptance ?? [])]
    if (outcome === 'complete' && acceptance.length > 0 && claims.length === 0) {
      errors.push('complete needs at least one executed check: pass claims [{ statement, execution: { callId } }] with the call id of a real run this session made after its last change — only a shell call the host recorded in this session counts; a command you ran somewhere else is not evidence (work_status view "executions" lists what it has)')
    }
  }

  // Scope: declared files plus everything the session actually wrote, compared in
  // the same coordinate system the scope is written in.
  const classified = classifyObservations(observations)
  const writes = classified.writes.map(entry => ({ raw: entry.path, path: relativeTo(entry.path, config.project) }))
  const touched = [...new Set([...declaredFiles.map(file => relativeTo(file, config.project)), ...writes.map(entry => entry.path)])]
  const scope = unit?.scope?.length ? unit.scope : task.scope
  // The same file arrives twice — once as a project-relative path from the scope
  // comparison, once as the absolute path the tool reported. Keying by absolute
  // path keeps one entry per file; the project-relative spelling is the one a
  // reader can act on, so it wins.
  const seenOutside = new Map()
  const absoluteOf = value => (/^\//.test(value) ? value : (config.project ?? '').replace(/\/+$/, '') + '/' + value.replace(/^\.\//, ''))
  for (const entry of scopeViolations(touched, scope)) seenOutside.set(absoluteOf(entry), { show: entry, absolute: absoluteOf(entry) })
  for (const entry of writes.filter(item => !inScope(item.path, scope))) {
    const key = absoluteOf(entry.raw)
    if (!seenOutside.has(key)) seenOutside.set(key, { show: entry.raw, absolute: key })
  }
  const outsideRows = [...seenOutside.values()]
  const outside = outsideRows.map(row => row.show)
  if (outside.length) {
    const line = `writes outside the declared scope (${scope.join(', ')}): ${outside.slice(0, 6).join(', ')}${outside.length > 6 ? ' …' : ''}`
    if ((config.scopeEnforcement ?? 'advisory') === 'blocking') errors.push(line)
    else warnings.push(line)
  }
  // Scope paths are project-relative by contract. When a session works in a
  // subdirectory of the project, a plainly written scope ("calc.mjs") matches
  // nothing and every write looks out of scope. Say what probably happened
  // instead of leaving the reader to decode absolute paths.
  const prefix = typeof config.project === 'string' && config.project ? config.project.replace(/\/+$/, '') + '/' : ''
  if (outsideRows.length && prefix) {
    for (const path of outsideRows.map(row => row.absolute)) {
      if (!path.startsWith(prefix)) continue
      const inner = path.slice(prefix.length)
      for (const entry of scope) {
        const wanted = entry === '.' ? '' : entry.replace(/^\.\//, '')
        if (!wanted || wanted === inner) continue
        if (inner.endsWith('/' + wanted)) {
          const folder = inner.slice(0, inner.length - wanted.length).replace(/\/+$/, '')
          warnings.push(`scope "${entry}" only matches at ${folder}/${wanted} — scope paths are relative to the project root (${config.project}); start the task in ${folder} or declare "${folder}/${wanted}"`)
          break
        }
      }
    }
  }

  // Authorization: an irreversible action needs a decision recorded first.
  for (const row of classified.destructive) {
    for (const risk of row.risk ?? []) {
      if (!grantsAction(task, risk, row.command, { agent: config.agent, beforeSeq: row.callSeq ?? row.seq })) {
        errors.push(`irreversible action recorded without authorization: ${row.risk?.join('/')} at ${row.callId}${row.command ? ` (${row.command.slice(0, 120)})` : ''} — ask the user and record the answer with work_extend before it runs, not after`)
        break
      }
    }
  }

  // Delegation: a child session keeps its own log, so this window cannot see what it
  // wrote. Where the work went through a subagent, only a check the parent ran itself
  // can speak for the result — otherwise "I handed it to a subagent" would be a way
  // around the evidence gate.
  const delegations = classified.delegations
  if (delegations.length) {
    warnings.push(opaqueDelegation(delegations.length))
    if (outcome === 'complete') {
      const latest = delegations[delegations.length - 1]
      const checkedAfter = claims.some(claim => typeof claim.execution?.seq === 'number' && claim.execution.seq > latest.seq)
      if (!checkedAfter) {
        errors.push(`the task handed work to a subagent and then claimed completion: run the check yourself after the last delegation (${latest.callId} at seq ${latest.seq}) and cite that run — a child's passing tests are not in this task's log`)
      }
    }
  }

  const evidence = claims.map(claim => ({ kind: claim.manual ? 'manual' : 'execution', ...claim }))
  return { ok: errors.length === 0, errors, warnings, evidence, outcome, summary, next, residue, claims, delegations: delegations.length, outside }
}


const COMMAND_WORDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'python', 'python3', 'pytest', 'go', 'cargo',
  'mvn', 'gradle', 'gradlew', 'tsc', 'make', 'git', 'curl', 'wget', 'docker', 'kubectl', 'terraform',
  'bash', 'sh', 'zsh', 'rm', 'cp', 'mv', 'ls', 'cat', 'sed', 'awk', 'find', 'grep', 'rg', 'tar', 'zip',
])
// Words that follow a command in prose but are not part of it.
const PROSE_TAIL = new Set([
  'passes', 'passed', 'pass', 'succeeds', 'succeeded', 'fails', 'failed', 'returns', 'return', 'runs',
  'ran', 'shows', 'show', 'works', 'worked', 'is', 'are', 'and', 'with', 'gives', 'outputs', 'prints',
  'reports', 'exits', 'no', 'errors', 'in', 'on', 'for', 'the', 'a', 'an', 'cleanly', 'again', 'now',
])

/**
 * The command a claim statement names, if it names one at all. `undefined`
 * means the statement is a behaviour statement ("subtract(5,2) returns 3"),
 * not a command, so there is nothing to cross-check.
 */
export function statementCommand(statement) {
  if (typeof statement !== 'string') return undefined
  const tokens = statement.trim().split(/\s+/)
  const first = (tokens[0] ?? '').replace(/^[`"'"(]+/, '').toLowerCase()
  if (!COMMAND_WORDS.has(first)) return undefined
  const kept = []
  for (const raw of tokens) {
    const token = raw.replace(/^[`"'(]+|[`"'),.;:]+$/g, '')
    if (!token) continue
    if (kept.length && PROSE_TAIL.has(token.toLowerCase())) break
    kept.push(token)
    if (kept.length >= 8) break
  }
  return kept.join(' ') || undefined
}

/** Match the command at an executable position, not text passed to echo or another tool. */
export function namesCommand(observed, claimed) {
  if (typeof observed !== 'string' || typeof claimed !== 'string') return false
  const command = evidenceCommand(observed)
  const named = evidenceCommand(claimed)
  if (!command || !named) return false
  if (/["']/.test(claimed) && !commandMatches(observed, claimed)) return false
  if (command === named) return true
  return command.split('&&').some(run => run.trim() === named || run.trim().startsWith(`${named} `))
}

export function commandMatches(observed, claimed) {
  if (typeof observed !== 'string') return false
  const clean = value => value.replace(/\s+/g, ' ').trim()
  const left = clean(observed)
  const right = clean(claimed)
  if (!right) return true
  return left === right || left.includes(right)
}

export function planForTask(plan) { return plan ?? undefined }
export { normalizeUnits }
