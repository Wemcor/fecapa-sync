import assert from 'node:assert/strict';
import test from 'node:test';
import { matchPlayer, normalizePlayerName } from '../dist/index.js';

test('normalizePlayerName strips accents, case and punctuation', () => {
  assert.equal(normalizePlayerName('Júlia Prova-Test'), 'JULIAPROVATEST');
  assert.equal(normalizePlayerName('  NIL  PROVA  TERCER '), 'NILPROVATERCER');
});

test('matches stable IDs or unique normalized full names, never partial names or ambiguous aliases', () => {
  const p = { fecapaId: 900012, name: 'JÚLIA PROVA TEST' };
  const player = { id: 'a', fecapaId: null, name: 'Julia Prova Test', aliases: [] };
  assert.equal(matchPlayer(p, [player]), player);
  assert.equal(matchPlayer(p, [player, { ...player, id: 'b' }]), null);
  assert.equal(matchPlayer(p, [{ ...player, name: 'Júlia Prova' }]), null);
  assert.equal(matchPlayer(p, [{ ...player, fecapaId: 900013 }]), null);
  const linked = { ...player, fecapaId: 900012, name: 'Old name' };
  assert.equal(matchPlayer(p, [linked]), linked);
});

test('matches through aliases and treats a missing fecapaId as unlinked', () => {
  const p = { fecapaId: 900012, name: 'JÚLIA PROVA TEST' };
  const renamed = { id: 'c', name: 'Júlia P.', aliases: ['julia prova test'] };
  assert.equal(matchPlayer(p, [renamed]), renamed);
});
