import assert from 'node:assert/strict';
import test from 'node:test';
import { currentSeason, toStartsAt } from '../dist/index.js';

test('stores a summer FECAPA kickoff as Europe/Madrid', () => {
  // 11 Oct 2026 is still CEST (UTC+2). 18:00 in Barcelona is 16:00Z.
  assert.equal(toStartsAt('2026-10-11', '18:00'), '2026-10-11T16:00:00.000Z');
  assert.equal(toStartsAt('2026-10-11', '9:30'), '2026-10-11T07:30:00.000Z');
});

test('stores a winter FECAPA kickoff as Europe/Madrid', () => {
  // After the last Sunday of October, Spain is CET (UTC+1).
  assert.equal(toStartsAt('2026-11-08', '18:00'), '2026-11-08T17:00:00.000Z');
  // 18:00 on the changeover Sunday (25 Oct 2026) is already winter time.
  assert.equal(toStartsAt('2026-10-25', '18:00'), '2026-10-25T17:00:00.000Z');
});

test('a missing FECAPA time is midnight in Europe/Madrid', () => {
  assert.equal(toStartsAt('2026-10-11', null), '2026-10-10T22:00:00.000Z');
  assert.equal(toStartsAt('2026-11-08', null), '2026-11-07T23:00:00.000Z');
});

test('toStartsAt still accepts the legacy YYYYMMDD form and rejects garbage', () => {
  assert.equal(toStartsAt('20261011', '18:00'), '2026-10-11T16:00:00.000Z');
  assert.throws(() => toStartsAt('11/10/2026', '18:00'), { code: 'INVALID_ARGUMENT', argument: 'date' });
  assert.throws(() => toStartsAt('2026-10-11', '18h'), { code: 'INVALID_ARGUMENT', argument: 'time' });
});

test('current season uses Madrid time at the July boundary', () => {
  assert.equal(currentSeason(new Date('2026-06-30T21:59:59Z')), '2025/2026');
  assert.equal(currentSeason(new Date('2026-06-30T22:00:00Z')), '2026/2027');
  assert.equal(currentSeason(new Date('2027-01-15T12:00:00Z')), '2026/2027');
});
