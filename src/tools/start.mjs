import { startLines } from '../craft.mjs'
import { markStart, storedPrint } from '../disk.mjs'
import { noteTrail } from '../trail.mjs'
import { domainExists, domainPath } from '../domain.mjs'
import { ACCEPTANCE_MODES, MODES, acceptanceModeOf, modeOf, createTaskRecord, texts, text } from '../task.mjs'
import { nextUnit } from '../plan.mjs'
import { ENV_FILE, envDigest, envLine, readEnv } from '../env.mjs'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolveScopeRoot } from '../scope-root.mjs'
import { memoryBrief, readLegacyLearning, readMemory } from '../memory.mjs'
import { string, strings, planUnits } from './shared.mjs'

export const workStart = api => (
  // ---------------------------------------------------------------- work_start
  ['work_start', `Open the task the user started with /dsh-auto-dev start. Only request matters; everything else is optional and the plugin fills it from the repository (scope defaults to the whole project).`, {
    request: string, goal: string, program: string, mode: { type: 'string', enum: MODES },
    // Who declares the result done. Stated at start because it decides what the
    // last delivery does: park for a person, or close on the checks.
    acceptanceMode: { type: 'string', enum: ACCEPTANCE_MODES },
    scope: strings, acceptance: strings, project: string, deliverable: { type: 'object', additionalProperties: true },
    // Any shape: a list, {units}, or one line. The plugin digests it (plan.mjs digestUnits).
    plan: {},
  }, [],
  async (args, exec) => {
    const agent = exec.agent
    // User-started only (the default). A person types `/dsh-auto-dev start <their
    // own words>` and that command leaves one short-lived grant; without it this
    // call is refused. This is not a safety gate, it is ownership: the board must
    // show work a person asked for, not work a model decided to book on its own.
    const config = api.settings()
    const startGrant = config.requireUserStart ? api.consumeStartGrant(agent) : undefined
    // The user's start already opened the task (hooks register it before the model's
    // turn and use the grant). A second call must hear that fact, not "nobody started".
    const open = config.requireUserStart && !startGrant?.ok ? api.activeTask(agent) : undefined
    if (open) return { started: true, taskId: open.id, project: open.project, already: true,
      tellUser: `任务 ${open.id} 已经在跑（用户开工时就登记了），不用再开；直接干活。` }
    if (config.requireUserStart && !startGrant?.ok) {
      return { started: false, waiting: 'user-start',
        tellUser: `这里的任务由用户自己开：没开就照常干活，不用登记；要追踪的话请用户输入 /dsh-auto-dev start <要做的事>。（${startGrant?.reason ?? '这次对话没有开工授权'}）` }
    }
    const grantedWords = startGrant && typeof startGrant.text === 'string' && startGrant.text.trim() !== ''
      ? startGrant.text.trim() : undefined
    // The user's own words win over the model's retelling of them.
    const request = grantedWords ?? (text(args.request, 20000) || text(args.goal) || '（没写需求）')
    // The user's words decide a look task; the model's mode only when it names one.
    const mode = args.mode ? modeOf(args.mode) : 'do'
    const acceptanceMode = acceptanceModeOf(args.acceptanceMode, mode)
    const scope = texts(args.scope)
    const acceptance = texts(args.acceptance)
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
    // The tree the task starts from: what 删除 and 收尾 compare to.
    const startPrint = await markStart(root.project, id)
    // The same tree on the record, for a window that picks the task up later (交接).
    await noteTrail(api.records, id, () => ({ start: storedPrint(startPrint) }))
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
    // An empty scope is the whole project and an empty acceptance is "the project's
    // checks pass": both are defaults, not omissions to report (门禁定义 ②).
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
      // 开工是插件开口的三个时刻之一：约定原样跑检查、条件句、这个项目的复盘与口径原文。
      // 哪一句适用由模型对着用户原话判断（设计约定「第三条路」）。
      brief: startLines(task.project, api.detectVerifier(task.project)),
      domainFile: domainExists(task.project) ? domainPath(task.project) : null,
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
