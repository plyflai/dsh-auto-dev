import test from 'node:test'
import assert from 'node:assert/strict'
import { digestUnits, validateUnits, topologicalOrder, normalizeUnits, nextUnit, runnableUnits, groupsOf, flattenUnits, leafUnits } from '../src/plan.mjs'

test('a plan accepts a valid DAG and walks every unit', () => {
  const units = normalizeUnits([
    { id: 'a', goal: 'extract domain model', scope: ['src/domain'], acceptance: ['model compiles'] },
    { id: 'b', goal: 'migrate callers', scope: ['src'], acceptance: [], dependsOn: ['a'] },
  ])
  assert.deepEqual(topologicalOrder(units), ['a', 'b'])
  assert.deepEqual(runnableUnits(units).map(unit => unit.id), ['a'])
  assert.equal(nextUnit({ units }).id, 'a')
})

// A plan's shape is never a refusal (设计约定「门禁定义」): each of these used to
// throw, and each throw cost a round trip that verified nothing.
test('a duplicate id gets a suffix instead of a refusal', () => {
  const { units, fixed } = digestUnits([
    { id: 'a', goal: 'x', scope: ['src'], acceptance: [] },
    { id: 'a', goal: 'y', scope: ['src'], acceptance: [] },
  ])
  assert.deepEqual(units.map(unit => unit.id), ['a', 'a-2'])
  assert.match(fixed.join('\n'), /a 重复/)
})

test('dependencies that cannot be scheduled are dropped: unknown, itself, across its milestone', () => {
  assert.deepEqual(digestUnits([{ id: 'a', goal: 'x', dependsOn: ['ghost', 'a'] }]).units[0].dependsOn, [])
  const inside = digestUnits([{ id: 'm1', goal: 'x', dependsOn: ['leaf'], units: [{ id: 'leaf', goal: 'y' }] }]).units
  assert.deepEqual(inside.find(unit => unit.id === 'm1').dependsOn, [])
  const holder = digestUnits([{ id: 'm1', goal: 'x', units: [{ id: 'leaf', goal: 'y', dependsOn: ['m1'] }] }]).units
  assert.deepEqual(holder.find(unit => unit.id === 'leaf').dependsOn, [])
})

test('a cycle next to an independent unit is broken, not refused', () => {
  // The counterexample that a zero-in-degree check misses: `root` has no
  // dependency, so a walk can start, but b and c reference each other.
  const { fixed } = digestUnits([
    { id: 'root', goal: 'x', scope: ['src'], acceptance: [] },
    { id: 'b', goal: 'y', scope: ['src'], acceptance: [], dependsOn: ['c'] },
    { id: 'c', goal: 'z', scope: ['src'], acceptance: [], dependsOn: ['b'] },
  ])
  assert.match(fixed.join('\n'), /成环.*b, c/)
  assert.deepEqual(validateUnits([{ id: 'b', goal: 'y', dependsOn: ['c'] }, { id: 'c', goal: 'z', dependsOn: ['b'] }]).sort(), ['b', 'c'])
})

test('a unit only needs to say what it does; the rest has defaults', () => {
  const [unit] = normalizeUnits([{ id: 'a', title: '加关键词过滤' }])
  assert.equal(unit.goal, '加关键词过滤')
  assert.deepEqual(unit.scope, ['.'])
  assert.deepEqual(unit.acceptance, [])
  assert.deepEqual(normalizeUnits(['补测试', { goal: '改 usage' }]).map(row => [row.id, row.goal]), [['u1', '补测试'], ['u2', '改 usage']])
  assert.deepEqual(normalizeUnits([{ goal: 'x', scope: 'src', acceptance: 'npm test 通过', dependsOn: 'u0' }]).map(row => [row.scope, row.acceptance, row.dependsOn]), [[['src'], ['npm test 通过'], []]])
  assert.deepEqual(normalizeUnits([]), [])
  assert.deepEqual(normalizeUnits(undefined), [])
})

test('dependencies gate runnability and a done unit is released', () => {
  const units = normalizeUnits([
    { id: 'a', goal: 'x', scope: ['src'], acceptance: [], state: 'done' },
    { id: 'b', goal: 'y', scope: ['src'], acceptance: [], dependsOn: ['a'] },
    { id: 'c', goal: 'z', scope: ['src'], acceptance: [], dependsOn: ['b'] },
  ])
  assert.deepEqual(runnableUnits(units).map(unit => unit.id), ['b'])
})

test('a unit may contain units, and only the leaves are work', () => {
  const units = normalizeUnits([
    {
      id: 'm1', goal: 'ship the domain model', scope: ['src'], acceptance: [],
      units: [
        { id: 'm1-a', goal: 'extract the model', scope: ['src/domain'], acceptance: ['model compiles'] },
        { id: 'm1-b', goal: 'migrate callers', scope: ['src'], acceptance: [], dependsOn: ['m1-a'] },
      ],
    },
  ])
  assert.deepEqual(units.map(unit => [unit.id, unit.parent ?? null]), [['m1', null], ['m1-a', 'm1'], ['m1-b', 'm1']])
  assert.deepEqual(runnableUnits(units).map(unit => unit.id), ['m1-a'])
})

test('a milestone is done when its units are, and only then releases what depends on it', () => {
  const units = normalizeUnits([
    {
      id: 'm1', goal: 'model', scope: ['src'], acceptance: [],
      units: [
        { id: 'm1-a', goal: 'extract', scope: ['src/a'], acceptance: [], state: 'done' },
        { id: 'm1-b', goal: 'migrate', scope: ['src/b'], acceptance: [], state: 'pending' },
      ],
    },
    { id: 'm2', goal: 'cut over', scope: ['src'], acceptance: [], dependsOn: ['m1'] },
  ])
  assert.deepEqual(runnableUnits(units).map(unit => unit.id), ['m1-b'], 'm2 waits for the whole milestone')
  const finished = units.map(unit => unit.id === 'm1-b' ? { ...unit, state: 'done' } : unit)
  assert.deepEqual(runnableUnits(finished).map(unit => unit.id), ['m2'])
})

test('an empty milestone is a leaf, not a refusal', () => {
  const [unit] = normalizeUnits([{ id: 'm1', goal: 'x', units: [] }])
  assert.deepEqual(unit.scope, ['.'])
  assert.equal(unit.parent, undefined)
})

test('groups keep a flat plan readable and give a milestone one row', () => {
  const flat = normalizeUnits([{ id: 'a', goal: 'one', scope: ['src'], acceptance: [] }])
  assert.deepEqual(groupsOf(flat), [{ id: 'a', label: 'one', state: 'pending', units: [flat[0]] }])
  const nested = normalizeUnits([
    { id: 'm1', goal: 'model', scope: ['src'], acceptance: [],
      units: [
        { id: 'm1-a', goal: 'extract', scope: ['src/a'], acceptance: [], state: 'done' },
        { id: 'm1-b', goal: 'migrate', scope: ['src/b'], acceptance: [], state: 'done' },
      ] },
  ])
  const [group] = groupsOf(nested)
  assert.equal(group.id, 'm1')
  assert.equal(group.state, 'done', 'the milestone state is derived, never stored')
  assert.deepEqual(group.units.map(unit => unit.id), ['m1-a', 'm1-b'])
})

test('a milestone carries work, so its scope and acceptance come from its leaves', () => {
  // No scope or acceptance on the milestone: they come from the leaves that do
  // the work. `validateUnits` answers the unit ids it accepted, in walk order.
  const ids = validateUnits([
    { id: 'm1', goal: 'the helpers exist', units: [
      { id: 'a', goal: 'four() exists', scope: ['index.mjs'], acceptance: ['npm test passes'] },
      { id: 'b', goal: 'a test covers it', scope: ['test.mjs'], acceptance: [], dependsOn: ['a'] },
    ] },
  ])
  assert.deepEqual(ids.slice().sort(), ['a', 'b', 'm1'])
})

test('a milestone needs no scope of its own, even after normalising', () => {
  // `validateUnits` flattens its input, so re-validating normalized units used to
  // lose `parent` and judge a milestone as a leaf without a scope — which is the
  // path `assertPlan` walks on every `work_start` with a nested plan.
  const units = [
    { id: 'm1', goal: 'first', units: [{ id: 'u-a', goal: 'a', scope: ['a.mjs'], acceptance: [] }] },
    { id: 'm2', goal: 'second', units: [{ id: 'u-b', goal: 'b', scope: ['b.mjs'], acceptance: [], dependsOn: ['u-a'] }] },
  ]
  const normalized = normalizeUnits(units)
  assert.deepEqual(validateUnits(normalized), ['m1', 'u-a', 'm2', 'u-b'])
  assert.deepEqual(leafUnits(normalized).map(unit => unit.id), ['u-a', 'u-b'])
  assert.deepEqual(validateUnits(flattenUnits(units)), ['m1', 'u-a', 'm2', 'u-b'])
})

test('a plan rewrite keeps the progress notes already on a unit', () => {
  const first = normalizeUnits([{ id: 'u-a', goal: 'lexer', scope: ['src/lex.mjs'], acceptance: ['suite passes'], notes: [{ at: '2026-10-20T01:00:00Z', text: 'split the token table out' }] }])
  assert.equal(first[0].notes[0].text, 'split the token table out')
  // Appending a unit is the rewrite this protects: it re-normalizes the whole
  // plan, and used to drop every note with the old whitelist.
  const again = normalizeUnits([...first, { id: 'u-b', goal: 'parser', scope: ['src/parse.mjs'], acceptance: [] }])
  assert.equal(again.find(unit => unit.id === 'u-a').notes[0].text, 'split the token table out')
})

test('a plan written as steps, tasks or items is the same plan (v27: steps emptied it silently)', () => {
  for (const key of ['steps', 'tasks', 'items']) {
    const { units } = digestUnits({ [key]: [{ id: 'u1', title: '过滤' }, { id: 'u2', text: 'rm 报错', [key === 'steps' ? 'subtasks' : 'steps']: [{ goal: '子项' }] }] })
    assert.deepEqual(units.map(row => row.id), ['u1', 'u2', 'u3'], key)
    assert.equal(units[0].goal, '过滤')
    assert.equal(units[2].parent, 'u2')
  }
})
