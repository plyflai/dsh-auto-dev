/**
 * dsh-auto-dev — host half.
 *
 * look expresses read-only intent; do delivers with an optional plan.
 * Historical build records remain readable and use do submission semantics.
 *
 * The host owns five things and nothing else: the records, the tool surface, the
 * hooks that observe what actually ran, the mechanical gates on submission, and
 * the notices that keep a task from drifting silently. Everything a person
 * decides is recorded as a decision, so the ledger never has to ask again.
 */
import { Records } from './records.mjs'
import { collectObservations } from './session-log.mjs'
import { DEFAULT_PROTECTED_PREFIXES } from './risk.mjs'
import { registerBoard } from './projection.mjs'
import { chooseProject, observedDirectory, resolveProject } from './project.mjs'
import { installSkill } from './skill.mjs'
import { installWorkTools } from './tools.mjs'
import { childRegistry, readChildren } from './child-sessions.mjs'
import { registerHooks } from './hooks.mjs'
import { createViews } from './views.mjs'
import { createMailbox } from './mailbox.mjs'
import { createTaskOps } from './task-ops.mjs'
import { setupOptIn } from './optin.mjs'
import { registerCommand } from './command.mjs'
import { lossless } from './json.mjs'
import { createLookup } from './lookup.mjs'
import { detectVerifier } from './detect.mjs'
import path from 'node:path'
import { appendFileSync, statSync } from 'node:fs'

// Opt-in tracing: AUTO_DEV_V3_DIAG=1 writes apply() stages to /tmp for field
// diagnosis. Silent by default so a normal boot pays nothing.
const diag = stage => {
  if (process.env.AUTO_DEV_V3_DIAG !== '1') return
  try { appendFileSync('/tmp/dsh-auto-dev-diag.log', `${new Date().toISOString()} ${stage}\n`) } catch {}
}

export { lossless }

export const name = 'dsh-auto-dev'
export const inject = ['tools', 'storage', 'storage.backend.json', 'workingDirectory']

export const NAMESPACE = 'auto-dev-v3'

/**
 * The entry schema. DSH reads the settings dialog straight out of the plugin
 * entry's Config, so this is the only way a section appears in
 * Settings → Auto Dev; a runtime `settings.register` call does not exist and
 * registering one is what left the section missing from the dialog.
 *
 * Every field is `volatile()`, i.e. editable without remounting the plugin —
 * these are decisions about how strictly to grade, not wiring.
 */
// Keep the entry schema local to the bundle. Standalone host bundles may only
// import node built-ins and relative files, so this mirrors the small native
// Schemastery graph consumed by DSH without requiring a peer package at load
// time. The graph is deliberately data-only; validation and normalization stay
// in AUTO_DEV_V3_SCHEMA below, which is also used by the standard validator.
function schemaNode(type, meta = {}, extra = {}) {
  const node = { type, meta, ...extra }
  // The host settings consumer walks the graph and serialises child nodes
  // independently. Keep the same callable contract on every reachable node,
  // not only on the exported root Config object.
  Object.defineProperty(node, 'toJSON', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: () => serialiseSchema(node),
  })
  return node
}

const scopeAdvisorySchema = schemaNode('const', { required: true }, { value: 'advisory' })
const scopeBlockingSchema = schemaNode('const', { required: true }, { value: 'blocking' })
const configSchema = schemaNode('object', { default: {} }, { dict: {
  scopeEnforcement: schemaNode('union', {
    default: 'advisory', volatile: true,
    description: 'Whether out-of-scope writes are recorded or refused',
  }, { list: [scopeAdvisorySchema, scopeBlockingSchema] }),
  protectedPaths: schemaNode('array', {
    default: [...DEFAULT_PROTECTED_PREFIXES], volatile: true,
    description: 'Project-relative prefixes whose modification counts as irreversible',
  }, { inner: schemaNode('string') }),
  autoEnroll: schemaNode('boolean', {
    default: false, volatile: true,
    description: 'Record an unregistered task when a session writes before work_start',
  }),
  requireUserStart: schemaNode('boolean', {
    default: true, volatile: true,
    description: 'Require a person to authorize work_start',
  }),
  verificationNudgeAfter: schemaNode('number', {
    min: 2, max: 100, step: 1, default: 5, volatile: true,
    description: 'File-changing calls allowed without a verification check',
  }),
  narrationNudgeAfter: schemaNode('number', {
    min: 0, max: 500, step: 1, default: 30, volatile: true,
    description: 'Steps allowed without visible progress narration; 0 disables the reminder',
  }),
  checkpoints: schemaNode('boolean', {
    default: true, volatile: true,
    description: 'Write before/after checkpoint references for a task',
  }),
} })

function serialiseSchema(root) {
  const refs = {}
  const ids = new Map()
  let next = 0
  const visit = node => {
    if (ids.has(node)) return ids.get(node)
    const id = String(next++)
    ids.set(node, id)
    const ref = { type: node.type, meta: { ...node.meta } }
    refs[id] = ref
    if (node.dict) ref.dict = Object.fromEntries(Object.entries(node.dict).map(([key, child]) => [key, visit(child)]))
    if (node.inner) ref.inner = visit(node.inner)
    if (node.sKey) ref.sKey = visit(node.sKey)
    if (node.list) ref.list = node.list.map(visit)
    if (Object.hasOwn(node, 'value')) ref.value = node.value
    return id
  }
  return { uid: Number(visit(root)), refs }
}

function validateConfig(value) {
  try { return { value: AUTO_DEV_V3_SCHEMA(plain(value)) } } catch (error) {
    return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
  }
}

export const Config = Object.assign(configSchema, {
  [Symbol.for('schemastery')]: true,
  '~standard': { version: 1, vendor: 'dsh-auto-dev', validate: validateConfig },
  toJSON: () => serialiseSchema(configSchema),
})

/** Bound a notice summary the same way the host bounds its own context summaries. */

export const DEFAULT_CONFIG = {
  scopeEnforcement: 'advisory',
  protectedPaths: DEFAULT_PROTECTED_PREFIXES,
  autoEnroll: false,
  requireUserStart: true,
  verificationNudgeAfter: 5,
  narrationNudgeAfter: 30,
  checkpoints: true,
}

/**
 * The settings section. `scopeEnforcement` is the one field a person is likely
 * to change while working, so it is volatile (live); the rest describe how this
 * repository is treated and are read by the gates on every call.
 */
export function AUTO_DEV_V3_SCHEMA(value) {
  const raw = value === undefined || value === null ? {} : value
  if (Array.isArray(raw) || typeof raw !== 'object') throw new TypeError('dsh-auto-dev: expected an object')
  const scopeEnforcement = raw.scopeEnforcement ?? DEFAULT_CONFIG.scopeEnforcement
  if (!['advisory', 'blocking'].includes(scopeEnforcement)) throw new TypeError('dsh-auto-dev: scopeEnforcement must be "advisory" or "blocking"')
  const protectedPaths = raw.protectedPaths === undefined ? DEFAULT_CONFIG.protectedPaths : raw.protectedPaths
  if (!Array.isArray(protectedPaths) || protectedPaths.some(entry => typeof entry !== 'string')) throw new TypeError('dsh-auto-dev: protectedPaths must be an array of strings')
  const autoEnroll = raw.autoEnroll ?? DEFAULT_CONFIG.autoEnroll
  if (typeof autoEnroll !== 'boolean') throw new TypeError('dsh-auto-dev: autoEnroll must be boolean')
  const requireUserStart = raw.requireUserStart ?? DEFAULT_CONFIG.requireUserStart
  if (typeof requireUserStart !== 'boolean') throw new TypeError('dsh-auto-dev: requireUserStart must be boolean')
  const verificationNudgeAfter = raw.verificationNudgeAfter ?? DEFAULT_CONFIG.verificationNudgeAfter
  if (!Number.isInteger(verificationNudgeAfter) || verificationNudgeAfter < 2 || verificationNudgeAfter > 100) {
    throw new TypeError('dsh-auto-dev: verificationNudgeAfter must be an integer between 2 and 100')
  }
  const narrationNudgeAfter = raw.narrationNudgeAfter ?? DEFAULT_CONFIG.narrationNudgeAfter
  if (!Number.isInteger(narrationNudgeAfter) || narrationNudgeAfter < 0 || narrationNudgeAfter > 500) {
    throw new TypeError('dsh-auto-dev: narrationNudgeAfter must be an integer between 0 and 500')
  }
  const checkpoints = raw.checkpoints ?? DEFAULT_CONFIG.checkpoints
  if (typeof checkpoints !== 'boolean') throw new TypeError('dsh-auto-dev: checkpoints must be boolean')
  return { scopeEnforcement, protectedPaths, autoEnroll, requireUserStart, verificationNudgeAfter, narrationNudgeAfter, checkpoints }
}

AUTO_DEV_V3_SCHEMA.toJSON = () => ({
  type: 'object',
  properties: {
    scopeEnforcement: { type: 'string', enum: ['advisory', 'blocking'], default: DEFAULT_CONFIG.scopeEnforcement,
      description: 'advisory records writes outside the declared scope; blocking refuses the submission' },
    protectedPaths: { type: 'array', items: { type: 'string' }, default: DEFAULT_CONFIG.protectedPaths,
      description: 'Project-relative prefixes whose modification counts as an irreversible action' },
    autoEnroll: { type: 'boolean', default: DEFAULT_CONFIG.autoEnroll,
      description: 'Record an unregistered task when a session writes files before calling work_start' },
    requireUserStart: { type: 'boolean', default: DEFAULT_CONFIG.requireUserStart,
      description: 'Tasks may only be started by a person: work_start is refused until they issue /dsh-auto-dev start with their own words' },
    checkpoints: { type: 'boolean', default: DEFAULT_CONFIG.checkpoints,
      description: 'Write auto-dev-v3/ck/* snapshot refs before and after a task' },
    verificationNudgeAfter: { type: 'integer', minimum: 2, maximum: 100, default: DEFAULT_CONFIG.verificationNudgeAfter,
      description: 'How many file-changing calls may pass without a check before the host reminds the model' },
    narrationNudgeAfter: { type: 'integer', minimum: 0, maximum: 500, default: DEFAULT_CONFIG.narrationNudgeAfter,
      description: 'How many steps may pass without visible words to the user before the host reminds the model to report progress; 0 turns the reminder off' },
  },
})


/**
 * Unwrap schemastery `volatile()` values. A live config arrives as parsed
 * `Config`, whose volatile fields are wrappers with `get()` — validating the
 * wrapper instead of its payload silently drops every setting a person set.
 */
function plain(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function') {
    try { return plain(value.get()) } catch { /* not a wrapper after all */ }
  }
  if (Array.isArray(value)) return value.map(plain)
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]))
}


export function readConfig(value) {
  if (value === undefined || value === null) return { ...DEFAULT_CONFIG }
  return AUTO_DEV_V3_SCHEMA(plain(value))
}

export async function apply(ctx, config) {
  diag('apply:enter')
  try {
    return await applyInner(ctx, config)
  } catch (error) {
    try { appendFileSync('/tmp/dsh-auto-dev-diag.log', `${new Date().toISOString()} apply:threw ${(error && error.stack) || error}\n`) } catch {}
    throw error
  }
}

async function applyInner(ctx, config) {
  const settings = () => readConfig(config)
  diag('apply:settings')
  // The panel and the craft skill are registered further down, once storage is
  // open: both are conditioned on the conversation having asked for Auto Dev, and
  // that answer is a record. A projection registered before the record reader
  // exists would fold the first session with no way to say what the task is.
  //
  // The holder is replaced once the live child registry exists, and the view reads
  // it per call — never captured at registration time.
  let liveChildren = () => []
  // The craft skill is offered through the skills service, which some hosts only
  // expose through injection; hold the context it arrived on rather than assuming
  // it hangs off the plugin context.
  let skillScope = null
  ctx.inject(['skills'], skillCtx => { skillScope = skillCtx })

  diag('apply:storage')
  const records = await Records.open(ctx.storage.backend.get('json'))
  diag('apply:records-open')
  const sessions = new Map()
  const nudged = new Map()
  // The gate already refused these calls; repeating the same advice right after
  // the refusal teaches people to skip the notices that matter.
  const denied = new Set()

  // The host keeps every session, children included. Hold the service rather than
  // requiring it: a profile without it degrades to "the child's writes are unknown".
  let childSessions
  ctx.inject(['sessions'], sessionCtx => { childSessions = sessionCtx.sessions })

  const sessionState = agent => {
    const id = agent.id ?? 'unknown'
    if (!sessions.has(id)) sessions.set(id, { taskId: undefined, userTexts: [], hinted: false, resumeHinted: false, startGrant: undefined })
    return sessions.get(id)
  }
  const sessionId = agent => agent?.session?.id ?? agent?.session?.header?.id
  const seq = agent => agent?.session?.seq ?? 0
  const observationsOf = agent => collectObservations(agent?.session, 0)
  const { watchedTask, activeTask, stoppedTask, latestTask, planOf, taskForSession, timelineForProject, timelineForSession } =
    createLookup({ records, sessionState, sessionId })

  // The panel: a fold over this session's log, seeded from the task record. It is
  // registered here rather than before storage opened because the seed is a record
  // read, and the session id it keys on arrives with the state.
  ctx.inject(['sessionProjections'], projectionCtx => {
    registerBoard(projectionCtx, {
      children: state => liveChildren(state),
      store: {
        taskFor: sid => { try { return taskForSession(sid) } catch { return undefined } },
        timeline: sid => { try { return timelineForSession(sid) } catch { return [] } },
      },
    })
  })

  // The session's committed working directory is the only honest answer to
  // "which project is this?" — `agent.cwd` is not set for in-process
  // subagents, and falling back to the host's process.cwd() silently scoped a
  // delivery in /tmp to the harness checkout (found by the first end-to-end run).
  /**
   * What this session's own shell last worked in, when it can be observed. The
   * session metadata answers with the parent's directory inside a subagent, so the
   * commands that really ran are consulted first — and their `cd` targets only
   * survive this filter while the directory still exists.
   */
  const observedSoFar = agent => {
    const from = Math.max(0, (agent?.session?.seq ?? 0) - 400)
    try { return collectObservations(agent.session, from) } catch { return undefined }
  }
  /**
   * The root a new task should use. The metadata answer stands unless the shell
   * that actually ran is demonstrably more specific about the declared scope.
   */
  const projectOf = (agent, scope) => {
    const base = resolveProject(agent, ctx)
    let observed
    try { observed = observedDirectory(observedSoFar(agent)) } catch { observed = undefined }
    return chooseProject({ base, observed, scope })
  }

  /**
   * A directory the caller named, or a refusal. Silently falling back to the
   * session directory would put the task in a folder nobody asked for.
   */
  const assertDirectory = (value, where) => {
    const resolved = path.resolve(value)
    let isDirectory = false
    try { isDirectory = statSync(resolved).isDirectory() } catch { isDirectory = false }
    if (!isDirectory) throw new Error(`${where} "${value}" is not a directory (resolved to ${resolved})`)
    return resolved
  }

  const { checkpointView, gatesFor, assertPlan, compileReport, planView, assertLeaf, boardView, statusView } =
    createViews({ records, timelineForProject })
  const { notice, queueNotice, blockedOnce, takeOutbox, queueReceipt, takeReceipts, intake, takeIntake, grantStart, readStartGrant, consumeStartGrant } =
    createMailbox({ sessionState, sessionId })
  const { proposeOrganize, slugOf, snapshot, newId, exportSnapshot, importSnapshot, unfinishedElsewhere, adoptTask, requireTask, setUnits } =
    createTaskOps({ records, settings, sessionState, sessionId, seq, projectOf, planOf, latestTask, planView, checkpointView })

  // `agents` is not a declared dependency: cordis resolves an optional lookup
  // through `get`, and a host without it simply cannot name the child.
  const childAgent = id => {
    try { return ctx.get('agents')?.get(id) } catch { return undefined }
  }
  const children = childRegistry({ agentOf: childAgent })
  // The board asks for the live children of *its* session; the projection state
  // carries the id seeded by `init`, so this never needs the agent object.
  liveChildren = state => children.snapshot(state?.sessionId)
  // Scoped dispatch keys the carrier by the delegating parent, so an edge raised
  // inside one agent's scope is not guaranteed to reach a plugin-level listener.
  // The root context is an ancestor of every scope, which is where a
  // host-wide observer sees all of them; the registry dedupes by runId if both
  // registrations fire.
  const lifecycle = ctx.root ?? ctx
  lifecycle.on('subagent/start', (info, parent) => children.start(info, parent))
  lifecycle.on('subagent/end', (info, parent) => children.end(info, parent))

  // Each half gets what it reads and nothing else: the list is the contract, and a
  // member nobody names here is not reachable from a tool or a hook.
  const childWork = async (results, agent) => {
    // Prefer what the lifecycle registry saw: it holds the child's own
    // session, which is the only place the child's writes are recorded.
    const recorded = children.list(agent?.session?.id ?? sessionId)
    if (recorded.length) return recorded
    return readChildren(childSessions, results)
  }
  const toolApi = () => ({
    records, settings, sessionState, sessionId, seq, nudged, observationsOf, projectOf, assertDirectory, detectVerifier,
    planOf, activeTask, latestTask, watchedTask, requireTask,
    newId, slugOf, snapshot, checkpointView, setUnits, assertPlan, assertLeaf, gatesFor, compileReport,
    planView, boardView, statusView, proposeOrganize, adoptTask, exportSnapshot, importSnapshot,
    queueNotice, blockedOnce, consumeStartGrant, childWork,
  })

  const { optedIn, optIn, markUserSpoke } = await setupOptIn({
    ctx, settings, records, sessionState, sessionId, seq, activeTask, planOf, projectOf, toolApi, skillScope: () => skillScope, diag,
  })
  registerCommand(ctx, {
    records, sessionState, sessionId, projectOf, planOf, activeTask, latestTask,
    optIn, unfinishedElsewhere, adoptTask, proposeOrganize, statusView,
    notice, queueReceipt, intake, grantStart,
  })
  const hookApi = () => ({
    records, settings, sessionState, sessionId, seq, nudged, denied, observationsOf, projectOf, newId,
    planOf, activeTask, latestTask, stoppedTask, optedIn, markUserSpoke, unfinishedElsewhere,
    notice, takeOutbox, takeReceipts, takeIntake, grantStart, readStartGrant, blockedOnce,
  })

  // Registration happens last, once every helper above is initialised: the tool
  // table and the hooks only capture references, so order is free here and a
  // half-built api object would be the one way to get it wrong.
  //
  // The tools are handed out per conversation, on opt-in, by `install`. Only a
  // profile that dropped the ownership gate gets them everywhere — there, opting
  // in is not a thing and the old behaviour is the correct one.
  if (settings().requireUserStart === false) {
    installWorkTools(ctx, toolApi())
    try { installSkill(skillScope ?? ctx) } catch (error) { diag(`install:skill-failed ${error?.message ?? error}`) }
  }
  registerHooks(ctx, hookApi())

  ctx.effect(() => () => { sessions.clear(); nudged.clear(); records.close() })
  diag('apply:done')
}
