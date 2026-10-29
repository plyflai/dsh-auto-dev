import { clarifyBrief, needsClarify } from '../clarify.mjs'
import { domainExists, domainPath } from '../domain.mjs'
import { ACCEPTANCE_MODES, MODES, assertAcceptanceMode, assertMode, createTaskRecord, stringArray, text } from '../task.mjs'
import { nextUnit } from '../plan.mjs'
import { ENV_FILE, envDigest, envLine, readEnv } from '../env.mjs'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolveScopeRoot } from '../scope-root.mjs'
import { memoryBrief, readLegacyLearning, readMemory } from '../memory.mjs'
import { string, strings, domainBrief, uiTestLine, looksLikeScreen, planUnits } from './shared.mjs'

export const workStart = api => (
  // ---------------------------------------------------------------- work_start
  ['work_start', `Register the authorized request verbatim, scope and acceptance; no renewed approval after /dsh-auto-dev start/new. mode defaults to do with an optional plan; build aliases do, look expresses read-only intent (not a complete sandbox); acceptanceMode auto/pm is independent. project sets the scope root; plan accepts an array or {units}.`, {
    request: string, goal: string, program: string, mode: { type: 'string', enum: MODES },
    // Who declares the result done. Stated at start because it decides what the
    // last delivery does: park for a person, or close on the checks.
    acceptanceMode: { type: 'string', enum: ACCEPTANCE_MODES },
    scope: strings, acceptance: strings, project: string, deliverable: { type: 'object', additionalProperties: true },
    plan: { oneOf: [{ type: 'array', items: { type: 'object', additionalProperties: true } }, { type: 'object', properties: { units: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['units'], additionalProperties: false }] },
  }, ['request'],
  async (args, exec) => {
    const agent = exec.agent
    // User-started only (the default). A person types `/dsh-auto-dev start <their
    // own words>` and that command leaves one short-lived grant; without it this
    // call is refused. This is not a safety gate, it is ownership: the board must
    // show work a person asked for, not work a model decided to book on its own.
    const config = api.settings()
    const startGrant = config.requireUserStart ? api.consumeStartGrant(agent) : undefined
    if (config.requireUserStart && !startGrant?.ok) {
      throw new Error(`auto-dev-v3: tasks are user-started only in this profile. Do not register one yourself — hand the request back and ask the user to run \`/dsh-auto-dev start <their own words>\`; that command grants one start and you may retry this call immediately. If the user did not ask for tracking, nothing needs registering. (${startGrant?.reason ?? 'no grant for this conversation'})`)
    }
    const grantedWords = startGrant && typeof startGrant.text === 'string' && startGrant.text.trim() !== ''
      ? startGrant.text.trim() : undefined
    // The user's own words win over the model's retelling of them.
    const request = grantedWords ?? text(args.request, 'request (the user\'s own words, verbatim)', { max: 20000 })
    const mode = assertMode(args.mode)
    const acceptanceMode = assertAcceptanceMode(args.acceptanceMode, mode)
    const scope = stringArray(args.scope, 'scope')
    const acceptance = stringArray(args.acceptance, 'acceptance')
    const now = new Date().toISOString()
    const id = api.newId('task')
    // Validate a plan before anything is written. The first version created the
    // record and validated second, so every refused `work_start` (a unit without a
    // scope, a milestone holding nothing) left an *active* task with no units
    // behind — and `activeTask` then handed that orphan to the next call. Found
    // live: a taskId-less `work_status` reported a task nobody was working on.
    const units = planUnits(args.plan)
    if (units) api.assertPlan(units)
    // The session's recorded directory is not always the directory the agent
    // works in (a subagent's cwd can differ), so let the declared paths confirm it.
    // An explicit root wins over every inference: a subagent inherits its parent's
    // directory in the session header, so a child working in another repo had no way
    // to say so — the task was rooted in the parent's folder and every write came
    // back "outside the declared scope".
    const declared = typeof args.project === 'string' ? args.project.trim() : ''
    const root = declared
      ? { project: api.assertDirectory(declared, 'project') }
      : resolveScopeRoot(api.projectOf(agent, scope), scope)
    const record = createTaskRecord({
      id, project: root.project, sessionId: api.sessionId(agent), ownerId: agent.id,
      request, goal: typeof args.goal === 'string' ? args.goal.trim() : '', mode, acceptanceMode,
      program: typeof args.program === 'string' ? args.program.trim() : '',
      scope, acceptance, deliverable: args.deliverable,
      startedSeq: api.seq(agent), startedTurn: exec.turn ?? 0, now,
    })
    await api.records.change('tasks', id, () => record)
    const state = api.sessionState(agent)
    state.taskId = id
    // A new task gets its own chance to be told about a browser; whether this
    // conversation ever drove one is a session fact and stays as it is.
    state.uiNudged = false
    // A plan that arrives in a shape we cannot read used to be dropped in silence: the
    // task came back looking like a normal build task with no units, and the next call
    // said "this task has no plan". Accept both spellings, and refuse anything else.
    if (units) await api.setUnits(id, units)
    // Compiling is deterministic: the units come from the plan, and the command
    // that proves each one comes from the repository, not from a guess.
    const compiled = units ? api.compileReport(root.project, units) : undefined
    let task = api.records.get('tasks', id)
    const before = mode === 'look' ? { snapshot: 'skipped', reason: 'look does not write' } : await api.snapshot(task, 'before')
    task = api.records.get('tasks', id)
    // What this project has already learned goes out with the task: a memory that
    // has to be asked for is a memory nobody reads.
    const memory = memoryBrief(readMemory(task.project), { query: `${request} ${task.goal ?? ''}` })
    const legacy = readLegacyLearning(task.project)
    // Declaring a scope that exists nowhere under the resolved project is a
    // coherent request answered by the wrong root: every write will land outside
    // the scope and the task will look like a discipline problem instead of a
    // path problem. Say which root it read.
    // An absolute entry is already rooted where it means to be; joining it onto
    // the project turns a real file into a missing one and reads as out of scope.
    const missing = scope.filter(entry => entry !== '.' && !(isAbsolute(entry) ? existsSync(entry) : existsSync(join(root.project, entry))))
    const warnings = scope.length && missing.length === scope.length
      ? [`none of the declared scope exists under ${root.project} (${missing.slice(0, 4).join(', ')}) — that is normal for a file you are about to create, and a wrong root reads as out of scope, so pass project if the work lives elsewhere`]
      : []
    // Three defaults used to be silent: an empty scope means the whole project,
    // an empty acceptance means nobody wrote down what counts as done, and a
    // request that the person's own words replaced. Silence here reads as consent.
    if (Array.isArray(args.scope) && args.scope.length === 0) {
      warnings.push('scope 传了空数组：记录里落成了 ["."]，也就是整个项目。把这次真要动的路径列出来，别让"整个仓库"变成默认范围。')
    }
    if (acceptance.length === 0) {
      warnings.push('acceptance 是空的：提交时只能靠 evidence 说话，没人写"什么算成"。补一句验收样本（谁、做什么、看到什么）。')
    }
    const modelWords = typeof args.request === 'string' ? args.request.trim() : ''
    const replacedRequest = Boolean(grantedWords) && modelWords !== '' && modelWords !== grantedWords
    const env = envDigest(await readEnv(task.project))
    return {
      taskId: id, mode, project: task.project,
      // The reporting contract ships with the task. The board can prove the
      // session is moving, but only the model can say what the moving means —
      // so the rule is stated at the one moment the model is guaranteed to read.
      tellUser: '约定：开始一个单元、完成一个单元、遇到阻塞时，各给用户一句结论。工具调用不算对用户说话。',
      acceptanceMode,
      // Thin request: say what to ask before the model starts guessing.
      ...(needsClarify({ request, mode }).needed
        ? { needsClarify: { ...needsClarify({ request, mode }), ...clarifyBrief(task) } }
        : {}),
      // The default the product promised: a request that touches a screen gets a
      // real browser run before it is called done. Said once at the top, because
      // by the time a model is deep in a unit it is no longer reading hints.
      ...(looksLikeScreen({ goal: `${request} ${task.goal ?? ''}`, scope: task.scope })
        ? { uiTest: uiTestLine(env) }
        : {}),
      // Where this project's business facts live, if it already has them: the
      // second conversation should not have to ask the first one's questions.
      // The path alone asked the model to go read a file it was never told was
      // worth reading; three lines of what it says do more than the path.
      ...(domainExists(task.project)
        ? { domainFile: domainPath(task.project), ...domainBrief(task.project, `${request} ${task.goal ?? ''}`) }
        : { domainFile: null }),
      // The same idea for runtime facts: a start command somebody confirmed is
      // worth more than ten guesses, and it costs one line to hand over.
      ...(env.confirmed ? { env: { path: ENV_FILE, ...env }, envLine: envLine(env) } : {}),
      ...(task.program ? { program: task.program } : {}),
      scope: task.scope, acceptance: task.acceptance,
      // Say which words became the record when both were on the table.
      ...(grantedWords ? { requestSource: replacedRequest ? 'person (model wording dropped)' : 'person' } : {}),
      ...(warnings.length ? { warnings } : {}),
      gates: api.gatesFor(mode),
      checkpoint: before,
      ...(memory.counts.facts || memory.counts.incidents || legacy ? { memory: { ...memory, ...(legacy ? { legacy: { path: legacy.path, status: legacy.status } } : {}) } } : {}),
      ...(root.adjusted || root.candidates !== undefined
        ? { projectRoot: { project: root.project, adjusted: root.adjusted, reason: root.reason, ...(root.candidates ? { candidates: root.candidates } : {}) } }
        : {}),
      ...(task.planId ? { planId: task.planId, nextUnit: nextUnit(api.planOf(task)) } : {}),
      ...(compiled ? { compiled } : {}),
      ...(warnings.length ? { warnings } : {}),
    }
  }]
)
