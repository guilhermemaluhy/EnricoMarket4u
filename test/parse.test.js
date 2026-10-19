import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyCents, parseNumber, parseCode, parseDateTime, parseDistanceKm, daysBetween, addDays } from '../src/parse.js';
import { parseCsv, toObjects, decodeBytes } from '../src/csv.js';

test('parseMoneyCents entende o formato brasileiro', () => {
  assert.equal(parseMoneyCents('R$ 6,49'), 649);
  assert.equal(parseMoneyCents('1.006,44'), 100644);
  assert.equal(parseMoneyCents('13.204,01'), 1320401);
  assert.equal(parseMoneyCents('R$ 0,00'), 0);
  assert.equal(parseMoneyCents('--'), 0);
  assert.equal(parseMoneyCents(''), 0);
  assert.equal(parseMoneyCents('-R$ 2,50'), -250);
});

test('parseNumber e parseCode', () => {
  assert.equal(parseNumber('1,000'), 1);
  assert.equal(parseNumber('3,000'), 3);
  assert.equal(parseNumber('--'), 0);
  assert.equal(parseCode('="75505"'), '75505');
  assert.equal(parseCode('="7898650400171"'), '7898650400171');
  assert.equal(parseCode('abc'), 'abc');
});

test('parseDateTime aceita data com e sem hora', () => {
  assert.equal(parseDateTime('2026-10-19 10:10:28'), '2026-10-19T10:10:28');
  assert.equal(parseDateTime('2026-10-29'), '2026-10-29T00:00:00');
  assert.equal(parseDateTime('--'), null);
  assert.equal(parseDateTime(''), null);
});

test('distância, dias e soma de dias', () => {
  assert.equal(parseDistanceKm('0,02 km Maps'), 0.02);
  assert.equal(parseDistanceKm('--'), null);
  assert.equal(daysBetween('2026-10-19', '2026-10-29'), 10);
  assert.equal(daysBetween('2026-10-19', '2026-10-18'), -1);
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
});

test('parseCsv trata aspas, aspas duplas e cabeçalhos repetidos', () => {
  const text = 'A;"B";C;C\n1;"x;y";"diz ""oi""";z\r\n2;;;\n';
  const parsed = parseCsv(text);
  assert.deepEqual(parsed.headers, ['A', 'B', 'C', 'C']);
  assert.deepEqual(parsed.rows[0], ['1', 'x;y', 'diz "oi"', 'z']);
  const objs = toObjects(parsed);
  assert.deepEqual(objs[0], { A: '1', B: 'x;y', C: 'diz "oi"', C_2: 'z' });
  assert.equal(objs.length, 2);
});

test('parseCsv ignora cabeçalho vazio nomeando coluna_N', () => {
  const objs = toObjects(parseCsv('A;;B\n1;2;3\n'));
  assert.deepEqual(objs[0], { A: '1', coluna_2: '2', B: '3' });
});

test('decodeBytes cai para Latin-1 quando não é UTF-8', () => {
  const latin1 = new Uint8Array([0x4e, 0xe3, 0x6f]); // "Não" em ISO-8859-1
  assert.equal(decodeBytes(latin1), 'Não');
  const utf8 = new TextEncoder().encode('Não');
  assert.equal(decodeBytes(utf8), 'Não');
});
