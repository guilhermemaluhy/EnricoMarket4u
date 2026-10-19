import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReport, detectReportType, classifyPayment, splitTipo, situacaoBoleto, mergeRecords } from '../src/reports.js';

const sample = (name) => new Uint8Array(readFileSync(new URL(`../data/sample/${name}`, import.meta.url)));

test('detecta o tipo de relatório pelo cabeçalho', () => {
  assert.equal(detectReportType(['ID', 'Code Session', 'Forma pagamento']), 'transacoes');
  assert.equal(detectReportType(['Valor total venda', 'Valor total custo']), 'produtos');
  assert.equal(detectReportType(['Vencimento', 'Picklist']), 'boletos');
  assert.equal(detectReportType(['Foo']), null);
});

test('classifyPayment separa meio e bandeira', () => {
  assert.deepEqual(classifyPayment('Pagbank_pos | POS Cartão de crédito (visa)'), { meio: 'Crédito', bandeira: 'visa' });
  assert.deepEqual(classifyPayment('Pagbank_pos | POS Pix (pix)'), { meio: 'Pix', bandeira: 'pix' });
  assert.deepEqual(classifyPayment('PagBank | PIX'), { meio: 'Pix', bandeira: null });
  assert.deepEqual(classifyPayment('Pagbank_pos | POS Débito (maestro)'), { meio: 'Débito', bandeira: 'maestro' });
  assert.deepEqual(classifyPayment('PagBank | MASTERCARD'), { meio: 'Cartão', bandeira: 'mastercard' });
  assert.deepEqual(classifyPayment('--'), { meio: null, bandeira: null });
});

test('splitTipo separa evento e categoria', () => {
  assert.deepEqual(splitTipo('Compra efetuada (Bebidas não alcoólicas)'), { evento: 'Compra efetuada', categoria: 'Bebidas não alcoólicas' });
  assert.deepEqual(splitTipo('No carrinho'), { evento: 'No carrinho', categoria: null });
});

test('transações: lê o export Latin-1 e normaliza', () => {
  const { type, records } = loadReport(sample('transacoes.csv'));
  assert.equal(type, 'transacoes');
  assert.equal(records.length, 20);
  const first = records[0];
  assert.equal(first.id, '73502437');
  assert.equal(first.pdx, 'CONDOMINIO ID JAUAPERI');
  assert.equal(first.compra, true);
  assert.equal(first.totalCents, 649);
  assert.equal(first.meioPagamento, 'Crédito');
  assert.equal(first.data, '2026-10-19');
  assert.equal(first.hora, 10);
  assert.equal(first.cpfNaNota, true);
  const carrinho = records.find((t) => t.evento === 'No carrinho');
  assert.equal(carrinho.compra, false);
  assert.equal(carrinho.totalCents, 0);
  assert.equal(records.filter((t) => t.compra).length, 14);
});

test('produtos: custo, venda e código Excel', () => {
  const { type, records } = loadReport(sample('produtos.csv'));
  assert.equal(type, 'produtos');
  assert.equal(records.length, 18);
  const r = records[0];
  assert.equal(r.nome, 'Agua Mineral Natural LINDOYA sem Gás 1,5L');
  assert.equal(r.codigo, '75505');
  assert.equal(r.ean, '7898650400171');
  assert.equal(r.vendaCents, 649);
  assert.equal(r.custoCents, 345);
  assert.equal(r.margemCents, 304);
  assert.equal(r.quantidade, 1);
  const cerveja = records.find((p) => p.nome.startsWith('Cerveja ANTARCTICA Pilsen'));
  assert.equal(cerveja.quantidade, 3);
  assert.equal(cerveja.categoria, 'BEBIDAS ALCOOLICAS');
});

test('boletos: ignora linha Total e calcula situação', () => {
  const { type, records } = loadReport(sample('boletos.csv'));
  assert.equal(type, 'boletos');
  assert.equal(records.length, 22);
  const b = records[0];
  assert.equal(b.id, '4635802');
  assert.equal(b.valorCents, 89544);
  assert.equal(b.vencimento, '2026-10-29');
  assert.equal(b.data, '2026-10-19');
  assert.equal(b.pago, null);
  assert.equal(b.bloqueiaInadimplente, true);
  assert.equal(situacaoBoleto(b, '2026-10-19'), 'a_vencer');
  assert.equal(situacaoBoleto(b, '2026-10-27'), 'vence_em_breve');
  assert.equal(situacaoBoleto(b, '2026-10-30'), 'vencido');
  assert.equal(situacaoBoleto({ ...b, pago: '2026-10-20' }, '2026-11-01'), 'pago');
  const total = records.reduce((a, x) => a + x.valorCents, 0);
  assert.equal(total, 2127652); // linha "Total" do relatório: 21.276,52
});

test('mergeRecords não duplica ao reimportar', () => {
  const { records } = loadReport(sample('transacoes.csv'));
  const merged = mergeRecords('transacoes', records, records.slice(0, 5));
  assert.equal(merged.length, records.length);
});

test('relatório desconhecido lança erro identificável', () => {
  assert.throws(() => loadReport('A;B\n1;2\n'), { code: 'UNKNOWN_REPORT' });
});
