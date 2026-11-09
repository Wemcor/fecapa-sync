import assert from 'node:assert/strict';
import test from 'node:test';
import { sameFixture } from '../dist/index.js';

const base = { competitionId: 4811, homeId: 900101, awayId: 900102, date: '2026-11-14' };

test('same competition, same teams, same date is the same fixture', () => {
  assert.equal(sameFixture(base, { ...base }), true);
});

test('swapped home/away sides are still the same fixture', () => {
  assert.equal(sameFixture(base, { ...base, homeId: 900102, awayId: 900101 }), true);
});

test('a date moved by up to three days is the same fixture, four days is not', () => {
  assert.equal(sameFixture(base, { ...base, date: '2026-11-17' }), true);
  assert.equal(sameFixture(base, { ...base, date: '2026-11-11' }), true);
  assert.equal(sameFixture(base, { ...base, date: '2026-11-18' }), false);
  assert.equal(sameFixture(base, { ...base, date: '2026-11-10' }), false);
});

test('the window works across month and year boundaries and DST changes', () => {
  const a = { ...base, date: '2026-12-30' };
  assert.equal(sameFixture(a, { ...a, date: '2027-01-02' }), true);
  const b = { ...base, date: '2026-10-24' };
  assert.equal(sameFixture(b, { ...b, date: '2026-10-27' }), true);
});

test('a different competition or a different opponent is never the same fixture', () => {
  assert.equal(sameFixture(base, { ...base, competitionId: 4812 }), false);
  assert.equal(sameFixture(base, { ...base, awayId: 900103 }), false);
});

test('the window is configurable', () => {
  assert.equal(sameFixture(base, { ...base, date: '2026-11-15' }, { windowDays: 0 }), false);
});
