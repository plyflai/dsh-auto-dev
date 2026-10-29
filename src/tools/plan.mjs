import { decisionSource } from '../decisions.mjs'
import { text } from '../task.mjs'
import { nextUnit } from '../plan.mjs'
import { craftHints } from '../craft.mjs'
import { UI_CHECKS, uiNeed } from '../uicheck.mjs'
import { string, containersOf, childrenOf, CRAFT_MODES, STEP_WORD, DAILY_UNIT, withDaily, dailyWarning, groupUnder } from './shared.mjs'

export const workPlan = api => (
  // ----------------------------------------------------------------- work_plan
  ['work_plan', `Read or edit the optional unit plan: set/add/group/organize/activate/state/list/note/ask. Leaves need id/goal/scope/acceptance; dependencies and milestones are validated; only verified work_submit owns done. ask uses unit + text; organize apply needs the approved proposal; note is human-readable progress.`, {
    taskId: string, operation: { type: 'string', enum: ['set', 'add', 'group', 'organize', 'activate', 'state', 'list', 'note', 'ask'] },
    units: { type: 'array', items: { type: 'object', additionalProperties: true } },
    members: { type: 'array', items: { type: 'string' } },
    action: { type: 'string', enum: ['propose', 'apply'] },
    proposalId: { type: 'string' },
    approval: { type: 'string' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
    unit: string, state: { type: 'string', enum: ['pending', 'active', 'done', 'blocked', 'dropped'] },
    text: { type: 'string' },
  }, ['operation'],
  async (args, exec) => {
    const task = api.requireTask(api.activeTask(exec.agent) ?? api.latestTask(exec.agent), args.taskId, { agent: exec.agent })
    const operation = args.operation
    // Reading a closed task's plan is useful; changing it is not: the units of a
    // finished task must not be re-opened behind the owner's back.
    if (['closed', 'cancelled', 'review_ready'].includes(task.state) && operation !== 'list') {
      const remedy = task.state === 'closed' ? 'explicitly adopt it for a new evidence window' : task.state === 'review_ready' ? 'use accept/rework before changing its plan' : 'start a new task after cancellation'
      throw new Error(`task ${task.id} is ${task.state} — ${remedy}`)
    }
    if (operation === 'list') return api.planView(task, api.planOf(task))
    if (operation === 'group') {
      const themeId = typeof args.unit === 'string' ? args.unit.trim() : ''
      const label = typeof args.text === 'string' ? args.text.trim() : ''
      const members = Array.isArray(args.members)
        ? args.members.map(id => typeof id === 'string' ? id.trim() : '').filter(id => id !== '')
        : []
      if (themeId === '' || label === '') throw new Error('group 需要 unit（主题 id）与 text（主题名，一句话）')
      if (members.length === 0) throw new Error('group 需要 members：要挂到这个主题下的单元 id')
      const current = api.planOf(task)
      if (!current) throw new Error(`task ${task.id} has no plan: nothing to group`)
      const rows = current.units ?? []
      if (rows.some(row => row.id === themeId)) throw new Error(`unit "${themeId}" already exists in this plan`)
      const known = new Set(rows.map(row => row.id))
      const unknown = members.filter(id => !known.has(id))
      if (unknown.length) throw new Error(`not in this plan: ${unknown.join(', ')}`)
      const theme = { id: themeId, goal: label, state: 'pending', scope: [], acceptance: [] }
      const written = await api.setUnits(task.id, groupUnder(rows, theme, members))
      const insideUnits = childrenOf(written.units ?? [], themeId)
      api.queueNotice(exec.agent,
        `**新主题 · ${label}** — ${insideUnits.length} 个单元`,
        `auto-dev-v3 theme ${themeId}`,
        { form: 'theme-open', data: { unit: themeId, label, line: `${insideUnits.length} 个单元：${insideUnits.map(unit => unit.id).join(' → ')}`, tone: 'neutral' } })
      return { ...written, unit: themeId, grouped: members }
    }
    if (operation === 'organize') {
      const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'propose'
      if (action === 'propose') {
        if (!api.planOf(task)) throw new Error(`task ${task.id} has no plan yet — write units with operation "set" first`)
        const proposal = await api.proposeOrganize(task, exec.agent)
        api.queueNotice(exec.agent,
          `**整理提案** — 日需 ${proposal.daily.length} 件；${proposal.themes.length} 个主题可以收拢。等用户点头再动计划。`,
          'auto-dev-v3 organize propose',
          { form: 'organize-proposed', data: { unit: task.id, title: '整理提案', line: `待办 ${proposal.daily.length} 件${proposal.themes.length ? `，${proposal.themes.length} 个主题可以收拢` : ''}`, tag: '等你点头', tone: 'ask' } })
        return {
          proposalId: proposal.id,
          daily: proposal.daily,
          themes: proposal.themes,
          instruction: '把这份体检结果用 ask_user_question 给用户看：先问是否按这个整理，再问不满意想怎么改。用户点头之前不要 apply，也不要自己改计划。',
        }
      }
      const currentPlan = api.planOf(task)
      const proposal = currentPlan?.proposal
      if (!proposal) throw new Error('this plan has no organize proposal — call operation "organize" action "propose" first')
      if (typeof args.proposalId !== 'string' || args.proposalId !== proposal.id) {
        throw new Error(`proposal id does not match: the proposal on file is ${proposal.id}`)
      }
      if (proposal.applied) throw new Error('that proposal was already applied')
      if (Date.now() - Date.parse(proposal.at) > 30 * 60 * 1000) throw new Error('that proposal is older than 30 minutes — propose again')
      const source = decisionSource({ agent: exec.agent, task, quote: args.approval, after: proposal.atSeq ?? task.startedSeq, subject: proposal.id, intent: 'grant' })
      const steps = Array.isArray(args.steps) ? args.steps : []
      if (steps.length === 0) throw new Error('apply needs steps — the exact edits the person agreed to')
      let rows = (currentPlan.units ?? []).map(row => ({ ...row }))
      for (const step of steps) {
        const kind = step?.kind
        if (kind === 'group') {
          const themeId = String(step.theme ?? '').trim()
          const label = String(step.label ?? '').trim()
          const members = Array.isArray(step.members) ? step.members.map(id => String(id).trim()).filter(id => id !== '') : []
          if (themeId === '' || label === '' || members.length === 0) throw new Error('a group step needs theme, label and members')
          if (themeId === DAILY_UNIT.id) throw new Error('日需 is not a campaign theme — group into a new id')
          if (rows.some(row => row.id === themeId)) throw new Error(`theme "${themeId}" already exists`)
          const known = new Set(rows.map(row => row.id))
          const unknown = members.filter(id => !known.has(id))
          if (unknown.length) throw new Error(`not in this plan: ${unknown.join(', ')}`)
          rows = groupUnder(rows, { id: themeId, goal: label, state: 'pending', scope: [], acceptance: [] }, members)
        } else if (kind === 'rename') {
          const id = String(step.unit ?? '').trim()
          const label = String(step.label ?? '').trim()
          if (label === '') throw new Error('a rename step needs a label')
          if (!rows.some(row => row.id === id)) throw new Error(`unit "${id}" is not in this plan`)
          if (id === DAILY_UNIT.id) throw new Error('日需 is the bucket — rename a campaign theme instead')
          rows = rows.map(row => (row.id === id ? { ...row, goal: label } : row))
        } else if (kind === 'ungroup') {
          const id = String(step.unit ?? '').trim()
          if (id === DAILY_UNIT.id) throw new Error('日需 is not removable')
          const inside = rows.filter(row => row.parent === id)
          if (inside.length === 0) throw new Error(`"${id}" holds no units`)
          rows = rows.filter(row => row.id !== id).map(row => (row.parent === id ? { ...row, parent: undefined } : row))
        } else {
          throw new Error(`unknown step "${kind}" — use group, rename or ungroup`)
        }
      }
      const written = await api.setUnits(task.id, withDaily(rows))
      const appliedAt = new Date().toISOString()
      await api.records.change('plans', currentPlan.id, current => ({
        ...current,
        proposal: { ...current.proposal, applied: { at: appliedAt, approval: String(args.approval ?? '').slice(0, 200), source, steps: steps.length } },
        updatedAt: appliedAt,
      }))
      api.queueNotice(exec.agent,
        `**已整理 · ${steps.length} 步**`,
        `auto-dev-v3 organize done`,
        { form: 'organize-done', data: { title: '已整理', line: `${steps.length} 步：${steps.map(step => STEP_WORD[step.kind] ?? step.kind).join('、')}`, tag: '已存档', tone: 'neutral' } })
      return { ...written, applied: { at: appliedAt, steps: steps.length } }
    }
    if (operation === 'set' || operation === 'add') {
      const before = new Set(containersOf(api.planOf(task)?.units ?? []).map(unit => unit.id))
      const incoming = operation === 'set'
        ? args.units
        : [...(api.planOf(task)?.units ?? []), ...(args.units ?? [])]
      const written = await api.setUnits(task.id, withDaily(incoming))
      // A new theme is a state change a person should see: it is the moment the
      // work stops being one long list. One line to the model, one card to them.
      for (const theme of containersOf(written.units ?? [])) {
        if (before.has(theme.id)) continue
        // The bucket is created silently: announcing it as a new theme would
        // make every task open with a card saying nothing happened.
        if (theme.id === DAILY_UNIT.id || theme.role === 'daily') continue
        const inside = childrenOf(written.units ?? [], theme.id).length
        const insideUnits = childrenOf(written.units ?? [], theme.id)
        api.queueNotice(exec.agent,
          `**新主题 · ${theme.goal}** — ${inside} 个单元`,
          `auto-dev-v3 theme ${theme.id}`,
          { form: 'theme-open', data: { unit: theme.id, label: theme.goal, line: `${inside} 个单元：${insideUnits.map(unit => unit.id).join(' → ')}`, tone: 'neutral' } })
      }
      const warning = dailyWarning(written)
      return warning ? { ...written, warning } : written
    }
    if (!args.unit) throw new Error('unit is required')
    const plan = api.planOf(task)
    if (!plan) throw new Error(`task ${task.id} has no plan: add units with work_plan operation "set" first`)
    if (!plan.units.some(unit => unit.id === args.unit)) throw new Error(`unit "${args.unit}" is not in this plan`)
    // A milestone is a container: the host refuses to activate it or to write a
    // state onto it, because its state is derived from the units inside it.
    api.assertLeaf(plan, args.unit)
    // A unit can stop on a question only a person can answer: the card says who
    // is waiting and for what, and the unit stays active.
    if (operation === 'ask') {
      if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('ask requires text — the question a person has to answer')
      const question = args.text.trim().slice(0, 240)
      const askedAt = new Date().toISOString()
      const updated = await api.records.change('plans', plan.id, current => ({
        ...current,
        units: current.units.map(row => row.id === args.unit ? { ...row, asked: { at: askedAt, question } } : row),
        updatedAt: askedAt,
      }))
      api.queueNotice(exec.agent,
        `**${args.unit} 需要你** — ${question}`,
        `auto-dev-v3 ask ${args.unit}`,
        { form: 'ask', data: { unit: args.unit, title: `${args.unit} 需要你`, line: question, tag: '回一句即可', tone: 'ask' } })
      return { planId: updated.id, unit: args.unit, asked: question }
    }
    // The progress note: the least gated call in this tool. It verifies nothing
    // and refuses nothing — an append of one trimmed line so an intermittent
    // "here is what moved" outlives the chat scroll. The board shows the newest.
    if (operation === 'note') {
      if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('note requires text — one line of progress')
      // The note is for the person reading the board, not for the log. `probe` or
      // `step2` tells an owner who never saw the code nothing, so a bare token is
      // refused and the model is asked for a sentence instead.
      const noteText = args.text.trim()
      if (!/\s/.test(noteText) && /^[A-Za-z0-9_$./\\-]+$/.test(noteText)) {
        throw new Error('note 是写给人看的一句话，不是变量名或代号：用一句人话说清这一步做到哪、卡在哪、下一步做什么，例如「日志已按会话拆开，正在看第 3 次失败」。')
      }
      const noteAt = new Date().toISOString()
      const updatedNote = await api.records.change('plans', plan.id, current => ({
        ...current,
        units: current.units.map(row => row.id === args.unit
          ? { ...row, notes: [...(row.notes ?? []).slice(-7), { at: noteAt, text: noteText.slice(0, 200) }] }
          : row),
        updatedAt: noteAt,
      }))
      // The note is itself a progress mark: the reminder clock restarts here.
      api.sessionState(exec.agent).unitNoteSeq = api.seq(exec.agent)
      return { planId: updatedNote.id, unit: args.unit, recorded: true }
    }
    if (operation === 'activate') {
      const updated = await api.records.change('plans', plan.id, current => ({
        ...current,
        units: current.units.map(unit => unit.id === args.unit
          ? { ...unit, state: 'active', startedSeq: api.seq(exec.agent), startedAt: new Date().toISOString(), asked: undefined }
          : unit),
        updatedAt: new Date().toISOString(),
      }))
      // A unit that promises something a person can look at leaves a checkpoint
      // before the work starts: the pair is only worth having if the "before"
      // exists even when the work goes wrong.
      const started = updated.units.find(unit => unit.id === args.unit)
      const deliverable = typeof started?.deliverable === 'string' ? started.deliverable.trim() : ''
      const before = deliverable === ''
        ? undefined
        : await api.snapshot(api.records.get('tasks', task.id), 'before', { unit: args.unit, label: deliverable })
      if (deliverable !== '') {
        api.queueNotice(exec.agent,
          `**${args.unit} 开始** — ${deliverable}`,
          `auto-dev-v3 unit-start ${args.unit}`,
          { form: 'unit-start', data: { unit: args.unit, title: `${args.unit} 开始`, line: deliverable, tag: before?.ref ? `已存档 #${before.seq}` : '未存档', tone: 'open' } })
      } else {
        // A unit starting is a visible event even when nobody wrote down what it
        // hands over. Without this, a plan where no unit names a deliverable
        // (every task adopted from an older build) stays silent until its first
        // submission — the person cannot tell work is happening at all. It is a
        // bar, not a card: the card is earned by a deliverable worth watching.
        api.queueNotice(exec.agent,
          `**${args.unit} 开始** — ${started?.goal ?? args.unit}`,
          `auto-dev-v3 unit-open ${args.unit}`,
          { form: 'unit-open', data: { unit: args.unit, title: `${args.unit} 开始`, line: String(started?.goal ?? args.unit).slice(0, 40), tone: 'open' } })
      }
      // The page worth reading at this exact moment. One line each, once per session.
      const state = api.sessionState(exec.agent)
      if (!(state.craftSeen instanceof Set)) state.craftSeen = new Set()
      const pages = craftHints({ task, unit: started, seen: state.craftSeen })
      for (const page of pages) {
        state.craftSeen.add(page.identity)
        // 文档是"我现在该读哪份"，人看不见模型读了什么，所以留一行。
        const mode = CRAFT_MODES[page.doc]
        api.queueNotice(exec.agent,
          `事实：${started.goal}\n方法：${page.line}\n参考：${page.doc}`,
          'auto-dev-v3 read-doc',
          { form: 'read-doc', data: { unit: args.unit, title: `方法提示 · ${mode ?? page.doc}`, line: page.line, ...(page.doc === 'references/craft/impact.md' ? { tag: 'codegraph blast_radius' } : {}), tone: 'info' } })
      }
      const uiNeedOfUnit = uiNeed(started, task.project)
      if (uiNeedOfUnit) {
        const check = UI_CHECKS[uiNeedOfUnit.tier]
        api.queueNotice(exec.agent,
          `**这个单元要测界面（${uiNeedOfUnit.tier}）** — ${check.name}用 ${check.command}，跑完在 claims 里带上它的 callId。${uiNeedOfUnit.tier === 'browser' ? '起服务后用非 headless 的浏览器点一遍，截图留档。' : ''}`,
          `auto-dev-v3 ui-plan ${args.unit}`,
          { form: 'ui-plan', data: { unit: args.unit, title: `要测界面 · ${uiNeedOfUnit.tier}`, line: `${check.name}：${check.command}`, tone: 'info' } })
      }
      if (started?.kind === 'verification') {
        api.queueNotice(exec.agent,
          `**待验证** — ${started.goal ?? args.unit}：交证据前先跑一遍，人工检查也要留一条 claim。`,
          'auto-dev-v3 verify-start',
          { form: 'verify-start', data: { unit: args.unit, title: '待验证', line: String(started.goal ?? args.unit).slice(0, 40), tone: 'info' } })
      }
      return {
        planId: updated.id, unit: updated.units.find(unit => unit.id === args.unit), nextUnit: nextUnit(updated),
        ...(before ? { checkpoint: before } : {}),
        ...(pages.length
          ? { craft: pages.map(page => ({ doc: page.doc, line: page.line })), hint: pages.map(page => `${page.line}（${page.doc}）`).join('；') }
          : {}),
        ...(uiNeedOfUnit ? { ui: { tier: uiNeedOfUnit.tier, command: UI_CHECKS[uiNeedOfUnit.tier].command } } : {}),
        tellUser: '顺手给用户一句：现在开始哪个单元、为什么。工具调用不算对用户说话。',
        noteHint: `到了一个阶段（跑通、发现一个坑、卡住）就 work_plan operation="note" unit="${args.unit}" text="一句人话" 留一行——写给人看的进度，例如「日志已按会话拆开，正在看第 3 次失败」，不要写变量名或代号。`,
      }
    }
    if (args.state === 'done') throw new Error(`work_plan cannot mark ${args.unit} done: use work_submit with unit="${args.unit}", outcome="complete", summary, next and claims from work_status view="executions"`)
    let reduction
    if (args.state === 'dropped' && args.approval) {
      if (!/(?:取消|放弃|不做|移除|缩减|drop|remove|cancel)/i.test(args.approval)) throw new Error('scope reduction must cite the person explicitly dropping this unit')
      const source = decisionSource({ agent: exec.agent, task, quote: args.approval, subject: args.unit, intent: 'rework', allowShort: false })
      const dropped = plan.units.find(row => row.id === args.unit)
      reduction = { unit: args.unit, source, definition: { goal: dropped.goal, scope: dropped.scope, acceptance: dropped.acceptance, dependsOn: dropped.dependsOn, parent: dropped.parent }, taskAcceptance: task.acceptance }
    }
    const updated = await api.records.change('plans', plan.id, current => ({
      ...current,
      units: current.units.map(unit => unit.id === args.unit ? { ...unit, state: args.state ?? unit.state, asked: undefined } : unit),
      updatedAt: new Date().toISOString(),
    }))
    if (reduction) await api.records.change('tasks', task.id, current => ({ ...current,
      scopeReductions: [...(current.scopeReductions ?? []).filter(row => row.unit !== args.unit), reduction], updatedAt: new Date().toISOString() }))
    const closed = updated.units.find(unit => unit.id === args.unit)
    const finish = typeof closed?.deliverable === 'string' ? closed.deliverable.trim() : ''
    let finishMark
    if (finish !== '' && (args.state === 'done' || args.state === 'blocked')) {
      finishMark = await api.snapshot(api.records.get('tasks', task.id), 'after', {
        unit: args.unit, label: finish, outcome: args.state === 'done' ? 'done' : 'blocked',
      })
      api.queueNotice(exec.agent,
        `**${args.unit} ${args.state === 'done' ? '完成' : '没通过'}** — ${finish}`,
        `auto-dev-v3 unit-${args.state === 'done' ? 'done' : 'blocked'} ${args.unit}`,
        {
          form: args.state === 'done' ? 'unit-done' : 'unit-blocked',
          data: {
            unit: args.unit,
            title: `${args.unit} ${args.state === 'done' ? '完成' : '没通过'}`,
            line: finish,
            tag: finishMark?.ref ? `已存档 #${finishMark.seq}` : '未存档',
            tone: args.state === 'done' ? 'done' : 'blocked',
          },
        })
    }
    return {
      planId: updated.id, unit: updated.units.find(unit => unit.id === args.unit), nextUnit: nextUnit(updated),
      ...(finishMark ? { checkpoint: finishMark } : {}),
      tellUser: args.state === 'blocked'
        ? '这个单元卡住了——直接告诉用户卡在哪、需要他做什么决定或补什么信息。一句话就够。'
        : args.state === 'done'
          ? '这个单元完成了——给用户一句它现在能做到什么（是结果，不是「改完了」）。'
          : '这个单元的状态变了——给用户一句它做到什么程度、接下来是什么。工具调用不算对用户说话。',
    }
  }]
)
