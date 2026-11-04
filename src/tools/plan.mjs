import { decisionSource } from '../decisions.mjs'
import { text } from '../task.mjs'
import { nextUnit, unitsIn } from '../plan.mjs'
import { workSubmit } from './submit.mjs'
import { string, containersOf, childrenOf, STEP_WORD, DAILY_UNIT, withDaily, dailyWarning, groupUnder, stepName } from './shared.mjs'

export const workPlan = api => (
  // ----------------------------------------------------------------- work_plan
  ['work_plan', `Read or edit the optional unit plan: set/add/group/organize/activate/state/list/note/ask. A unit needs only a goal; whatever else is missing is filled in. Marking a unit done hands it in. ask is a question for the user; note is one line of progress for the board.`, {
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
    const task = api.requireTask(api.activeTask(exec.agent) ?? api.latestTask(exec.agent), args.taskId)
    if (!task) return api.noTask(exec.agent)
    const operation = ['set', 'add', 'group', 'organize', 'activate', 'state', 'list', 'note', 'ask'].includes(args.operation)
      ? args.operation : unitsIn(args) ? 'set' : args.state ? 'state' : args.text && args.unit ? 'note' : 'list'
    // Reading a closed task's plan is useful; changing it is not: the units of a
    // finished task must not be re-opened behind the owner's back. It is an answer, not a refusal.
    if (['closed', 'cancelled', 'review_ready'].includes(task.state) && operation !== 'list') {
      return { ...api.planView(task, api.planOf(task)), unchanged: true,
        tellUser: task.state === 'review_ready' ? '已经交付、在等用户看：计划不动，停下等他回话。'
          : `任务 ${task.id} 已经${task.state === 'closed' ? '收尾' : '取消'}，计划不再改；要接着做，请用户 /dsh-auto-dev adopt ${task.id}。` }
    }
    if (operation === 'list') return api.planView(task, api.planOf(task))
    const rowsNow = api.planOf(task)?.units ?? []
    const known = new Set(rowsNow.map(row => row.id))
    // What exists, said back instead of an error when the call names nothing usable.
    const existing = line => ({ ...api.planView(task, api.planOf(task)), unchanged: true, answer: `${line}${rowsNow.length ? `。现有单元：${rowsNow.map(row => `${row.id}（${row.goal}）`).join('、')}` : '。还没有计划。'}` })
    if (operation === 'group') {
      const label = typeof args.text === 'string' ? args.text.trim() : ''
      let themeId = typeof args.unit === 'string' && args.unit.trim() !== '' ? args.unit.trim() : `t${containersOf(rowsNow).length + 1}`
      while (known.has(themeId)) themeId = `${themeId}-2`
      const members = (Array.isArray(args.members) ? args.members : []).map(id => typeof id === 'string' ? id.trim() : '').filter(id => known.has(id))
      if (members.length === 0) return existing('没有可以收进主题的单元')
      const rows = rowsNow
      const theme = { id: themeId, goal: label || `主题 ${themeId}`, state: 'pending', scope: [], acceptance: [] }
      const written = await api.setUnits(task.id, groupUnder(rows, theme, members))
      const insideUnits = childrenOf(written.units ?? [], themeId)
      api.queueNotice(exec.agent,
        `**新主题 · ${theme.goal}** — ${insideUnits.length} 个单元`,
        `dsh-auto-dev theme ${themeId}`,
        { form: 'theme-open', data: { unit: themeId, label: theme.goal, line: `${insideUnits.length} 步：${insideUnits.map(unit => unit.goal).join(' → ')}`, tone: 'neutral' } })
      return { ...written, unit: themeId, grouped: members }
    }
    if (operation === 'organize') {
      const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'propose'
      if (action === 'propose') {
        if (!api.planOf(task)) return existing('没有计划可整理')
        const proposal = await api.proposeOrganize(task, exec.agent)
        api.queueNotice(exec.agent,
          `**整理提案** — 日需 ${proposal.daily.length} 件；${proposal.themes.length} 个主题可以收拢。等用户点头再动计划。`,
          'dsh-auto-dev organize propose',
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
      // The proposal on file is the one the user saw; an id that does not match it still means it.
      // Expiry and re-apply are answers: the user's nod has to be to what they were shown.
      if (!proposal || proposal.applied || Date.now() - Date.parse(proposal.at) > 30 * 60 * 1000) {
        return { ...api.planView(task, currentPlan), unchanged: true,
          answer: !proposal ? '还没有给用户看过整理提案：先 propose，用户点头后再 apply。'
            : proposal.applied ? '这份整理已经做过了。' : '这份提案超过 30 分钟了：重新 propose 一份给用户看。' }
      }
      // The person's reply after the proposal decides; no reply yet, or a no, changes nothing.
      const source = decisionSource({ agent: exec.agent, task, after: proposal.atSeq ?? task.startedSeq, subject: proposal.id })
      if (!source) {
        return { ...api.planView(task, currentPlan), unchanged: true, answer: '用户还没回话：等他对提案点头再整理。' }
      }
      let rows = (currentPlan.units ?? []).map(row => ({ ...row }))
      // Each step the user agreed to is applied when it names something real; the rest are skipped and said.
      const steps = []
      const skipped = []
      for (const step of Array.isArray(args.steps) ? args.steps : []) {
        const kind = step?.kind
        const id = String(step?.unit ?? step?.theme ?? '').trim()
        const label = String(step?.label ?? '').trim()
        const ids = new Set(rows.map(row => row.id))
        if (kind === 'group') {
          const members = (Array.isArray(step.members) ? step.members : []).map(member => String(member).trim()).filter(member => ids.has(member))
          if (id === '' || id === DAILY_UNIT.id || ids.has(id) || members.length === 0) { skipped.push(step); continue }
          rows = groupUnder(rows, { id, goal: label || `主题 ${id}`, state: 'pending', scope: [], acceptance: [] }, members)
        } else if (kind === 'rename') {
          if (label === '' || id === DAILY_UNIT.id || !ids.has(id)) { skipped.push(step); continue }
          rows = rows.map(row => (row.id === id ? { ...row, goal: label } : row))
        } else if (kind === 'ungroup') {
          if (id === DAILY_UNIT.id || !rows.some(row => row.parent === id)) { skipped.push(step); continue }
          rows = rows.filter(row => row.id !== id).map(row => (row.parent === id ? { ...row, parent: undefined } : row))
        } else { skipped.push(step); continue }
        steps.push(step)
      }
      if (steps.length === 0) return { ...api.planView(task, currentPlan), unchanged: true, answer: '这些步骤没有一条对得上现在的计划，计划没动。', skipped }
      const written = await api.setUnits(task.id, withDaily(rows))
      const appliedAt = new Date().toISOString()
      await api.records.change('plans', currentPlan.id, current => ({
        ...current,
        proposal: { ...current.proposal, applied: { at: appliedAt, approval: source.quote.slice(0, 200), source, steps: steps.length } },
        updatedAt: appliedAt,
      }))
      api.queueNotice(exec.agent,
        `**已整理 · ${steps.length} 步**`,
        `dsh-auto-dev organize done`,
        { form: 'organize-done', data: { title: '已整理', line: `${steps.length} 步：${steps.map(step => STEP_WORD[step.kind] ?? step.kind).join('、')}`, tag: '已存档', tone: 'neutral' } })
      return { ...written, applied: { at: appliedAt, steps: steps.length }, ...(skipped.length ? { skipped } : {}) }
    }
    if (operation === 'set' || operation === 'add') {
      const before = new Set(containersOf(api.planOf(task)?.units ?? []).map(unit => unit.id))
      // Whatever key the units came under; organize's `steps` are not units, but organize never gets here.
      const given = unitsIn(args)
      const incoming = operation === 'set'
        ? given
        : [...(api.planOf(task)?.units ?? []), ...(Array.isArray(given) ? given : [])]
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
          `dsh-auto-dev theme ${theme.id}`,
          { form: 'theme-open', data: { unit: theme.id, label: theme.goal, line: `${inside} 步：${insideUnits.map(unit => unit.goal).join(' → ')}`, tone: 'neutral' } })
      }
      const warning = dailyWarning(written)
      return warning ? { ...written, warning } : written
    }
    const plan = api.planOf(task)
    if (!plan) return existing('没有计划，这一步不用记')
    // No unit, or one that does not exist, means the unit in hand; a milestone means
    // the leaf inside it that is next — its own state comes from its units.
    const named = known.has(args.unit) ? args.unit : (plan.units.find(unit => unit.state === 'active') ?? nextUnit(plan))?.id
    if (!named) return existing(args.unit ? `没有单元 ${args.unit}` : '没有在做的单元')
    args = { ...args, unit: api.leafOf(plan, named).id }
    // A unit can stop on a question only a person can answer: the card says who
    // is waiting and for what, and the unit stays active.
    if (operation === 'ask') {
      const question = text(args.text, 240)
      if (question === '') return existing('没有问题要问，计划没动')
      const askedAt = new Date().toISOString()
      const updated = await api.records.change('plans', plan.id, current => ({
        ...current,
        units: current.units.map(row => row.id === args.unit ? { ...row, asked: { at: askedAt, question } } : row),
        updatedAt: askedAt,
      }))
      api.queueNotice(exec.agent,
        `**${args.unit} 需要你** — ${question}`,
        `dsh-auto-dev ask ${args.unit}`,
        { form: 'ask', data: { unit: args.unit, title: `${stepName(plan.units, args.unit)}要问你`, line: question, tag: '回一句即可', tone: 'ask' } })
      return { planId: updated.id, unit: args.unit, asked: question }
    }
    // The progress note: the least gated call in this tool. It verifies nothing
    // and refuses nothing — an append of one trimmed line so an intermittent
    // "here is what moved" outlives the chat scroll. The board shows the newest.
    if (operation === 'note') {
      const noteText = text(args.text, 200)
      if (noteText === '') return { planId: plan.id, unit: args.unit, recorded: false }
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
          `dsh-auto-dev unit-start ${args.unit}`,
          { form: 'unit-start', data: { unit: args.unit, title: `开始${stepName(updated.units, args.unit)}`, line: deliverable, tag: before?.ref ? `已存档 #${before.seq}` : '未存档', tone: 'open' } })
      } else {
        // A unit starting is a visible event even when nobody wrote down what it
        // hands over. Without this, a plan where no unit names a deliverable
        // (every task adopted from an older build) stays silent until its first
        // submission — the person cannot tell work is happening at all. It is a
        // bar, not a card: the card is earned by a deliverable worth watching.
        api.queueNotice(exec.agent,
          `**${args.unit} 开始** — ${started?.goal ?? args.unit}`,
          `dsh-auto-dev unit-open ${args.unit}`,
          { form: 'unit-open', data: { unit: args.unit, title: `开始${stepName(updated.units, args.unit)}`, line: String(started?.goal ?? args.unit).slice(0, 40), tone: 'open' } })
      }
      return {
        planId: updated.id, unit: updated.units.find(unit => unit.id === args.unit), nextUnit: nextUnit(updated),
        ...(before ? { checkpoint: before } : {}),
        tellUser: '顺手给用户一句：现在开始哪个单元、为什么。工具调用不算对用户说话。',
      }
    }
    // Done is a hand-in, so it goes through the one place that can say no (G1). A milestone
    // marked done is every open leaf under it done, one card each (v52: only the first leaf closed).
    if (args.state === 'done') {
      const under = id => plan.units.filter(row => row.parent === id).flatMap(row => plan.units.some(kid => kid.parent === row.id) ? under(row.id) : [row])
      const leaves = plan.units.some(row => row.parent === named) ? under(named).filter(row => !['done', 'dropped'].includes(row.state)) : []
      let handed
      for (const leaf of leaves.length ? leaves : [{ id: args.unit }]) {
        handed = await workSubmit(api)[4]({ taskId: task.id, unit: leaf.id, outcome: 'complete', summary: args.text }, exec)
      }
      return handed
    }
    let reduction
    // Dropping a unit is the model's call; it is recorded with whatever the person last said, and the model tells them.
    if (args.state === 'dropped') {
      const source = decisionSource({ agent: exec.agent, task, subject: args.unit })
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
        `dsh-auto-dev unit-${args.state === 'done' ? 'done' : 'blocked'} ${args.unit}`,
        {
          form: args.state === 'done' ? 'unit-done' : 'unit-blocked',
          data: {
            unit: args.unit,
            title: `${stepName(updated.units, args.unit)}${args.state === 'done' ? '完成' : '没通过'}`,
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
        : args.state === 'dropped'
          ? `${args.unit} 记为不做了——给用户一句为什么不做，砍范围要让他知道。`
          : '这个单元的状态变了——给用户一句它做到什么程度、接下来是什么。工具调用不算对用户说话。',
    }
  }]
)
