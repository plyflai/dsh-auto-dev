import test from 'node:test'
import assert from 'node:assert/strict'
import { validateUnits, topologicalOrder, normalizeUnits, nextUnit, runnableUnits, groupsOf, flattenUnits, leafUnits } from '../src/plan.mjs'

test('a plan accepts a valid DAG and walks every unit', () => {
  const units = normalizeUnits([
    { id: 'a', goal: 'extract domain model', scope: ['src/domain'], acceptance: ['model compiles'] },
    { id: 'b', goal: 'migrate callers', scope: ['src'], acceptance: [], dependsOn: ['a'] },
  ])
  assert.deepEqual(topologicalOrder(units), ['a', 'b'])
  assert.deepEqual(runnableUnits(units).map(unit => unit.id), ['a'])
  assert.equal(nextUnit({ units }).id, 'a')
})

test('duplicate unit ids are refused', () => {
  assert.throws(() => validateUnits([
    { id: 'a', goal: 'x', scope: ['src'], acceptance: [] },
    { id: 'a', goal: 'y', scope: ['src'], acceptance: [] },
  ]), /used twice/)
})

test('an unknown dependency is refused', () => {
  assert.throws(() => validateUnits([
    { id: 'a', goal: 'x', scope: ['src'], acceptance: [], dependsOn: ['ghost'] },
  ]), /unknown unit "ghost"/)
})

test('a unit cannot depend on itself', () => {
  assert.throws(() => validateUnits([
    { id: 'a', goal: 'x', scope: ['src'], acceptance: [], dependsOn: ['a'] },
  ]), /depends on itself/)
})

test('a cycle next to an independent unit is still a cycle', () => {
  // The counterexample that a zero-in-degree check misses: `root` has no
  // dependency, so a walk can start, but b and c reference each other.
  assert.throws(() => validateUnits([
    { id: 'root', goal: 'x', scope: ['src'], acceptance: [] },
    { id: 'b', goal: 'y', scope: ['src'], acceptance: [], dependsOn: ['c'] },
    { id: 'c', goal: 'z', scope: ['src'], acceptance: [], dependsOn: ['b'] },
  ]), /dependency cycle among: b, c/)
})

test('a unit needs a goal, a scope and an acceptance array', () => {
  assert.throws(() => validateUnits([{ id: 'a', scope: ['src'], acceptance: [] }]), /needs a goal/)
  assert.throws(() => validateUnits([{ id: 'a', goal: 'x', scope: [], acceptance: [] }]), /non-empty scope/)
  assert.throws(() => validateUnits([{ id: 'a', goal: 'x', scope: ['src'] }]), /acceptance array/)
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

test('a dependency cycle that crosses a milestone boundary is still refused', () => {
  assert.throws(() => validateUnits([
    { id: 'm1', goal: 'x', scope: ['src'], acceptance: [], dependsOn: ['leaf'],
      units: [{ id: 'leaf', goal: 'y', scope: ['src'], acceptance: [] }] },
  ]), /which is inside it/)
})

test('a unit that waits for the milestone holding it is refused, not left stuck', () => {
  assert.throws(() => validateUnits([
    { id: 'm1', goal: 'x', scope: ['src'], acceptance: [],
      units: [{ id: 'leaf', goal: 'y', scope: ['src'], acceptance: [], dependsOn: ['m1'] }] },
  ]), /which contains it/)
})

test('an empty milestone is refused instead of silently vanishing', () => {
  assert.throws(() => validateUnits([{ id: 'm1', goal: 'x', scope: ['src'], acceptance: [], units: [] }]),
    /contains no units/)
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
  assert.throws(() => validateUnits([{ id: 'm1', goal: 'empty milestone', units: [] }]), /contains no units/)
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
