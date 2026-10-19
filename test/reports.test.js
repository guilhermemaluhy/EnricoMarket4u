import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReport, detectReportType, classifyPayment, splitTipo, situacaoBoleto, mergeRecords, classifyEvento } from '../src/reports.js';

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
  assert.equal(classifyPayment('Sodexo | Pluxee (Sodexo)').meio, 'Voucher');
  assert.equal(classifyPayment('VR').meio, 'Voucher');
  assert.equal(classifyPayment('Pagbank_pos | POS Voucher (elo)').meio, 'Voucher');
  assert.equal(classifyPayment('Gerencianet | Boleto').meio, 'Boleto');
});

test('splitTipo separa evento e categoria', () => {
  assert.deepEqual(splitTipo('Compra efetuada (Bebidas não alcoólicas)'), { evento: 'Compra efetuada', categoria: 'Bebidas não alcoólicas' });
  assert.deepEqual(splitTipo('No carrinho'), { evento: 'No carrinho', categoria: null });
});

test('transações: lê o export Latin-1 e normaliza', () => {
  const { type, records } = loadReport(sample('transacoes.csv'));
  assert.equal(type, 'transacoes');
  assert.equal(records.length, 2325);
  const first = records.find((t) => t.id === '73502437');
  assert.equal(first.pdx, 'Condominio ID Jauaperi');
  assert.equal(first.compra, true);
  assert.equal(first.totalCents, 649);
  assert.equal(first.meioPagamento, 'Crédito');
  assert.equal(first.data, '2026-10-19');
  assert.equal(first.hora, 10);
  assert.equal(first.cpfNaNota, true);
  const carrinho = records.find((t) => t.evento === 'No carrinho');
  assert.equal(carrinho.compra, false);
  assert.equal(carrinho.tipoEvento, 'carrinho');
  const porTipo = records.reduce((a, t) => ({ ...a, [t.tipoEvento]: (a[t.tipoEvento] ?? 0) + 1 }), {});
  assert.deepEqual(porTipo, { compra: 1934, carrinho: 139, removida: 244, cobranca_pendente: 5, cobranca_paga: 2, estornada: 1 });
});

test('transações: cobranças trazem link, taxa e forma', () => {
  const { records } = loadReport(sample('transacoes.csv'));
  const pend = records.find((t) => t.id === '73280051');
  assert.equal(pend.tipoEvento, 'cobranca_pendente');
  assert.equal(pend.cobranca, true);
  assert.equal(pend.compra, false);
  assert.equal(pend.totalCents, 37276);
  assert.equal(pend.taxaCobranca, true);
  assert.equal(pend.idLinkPagamento, '425442');
  assert.match(pend.linkPagamento, /^https:\/\/api\.market4u\.com\.br\/link-pagamento/);
  assert.equal(pend.meioPagamento, 'Boleto');
  const paga = records.find((t) => t.id === '72083740');
  assert.equal(paga.tipoEvento, 'cobranca_paga');
  assert.equal(paga.meioPagamento, 'Pix');
  assert.ok(paga.nfce);
  const removida = records.find((t) => t.evento === 'Compra removida');
  assert.equal(removida.tipoEvento, 'removida');
  assert.equal(records.find((t) => t.id === '73045002').tipoEvento, 'estornada');
});

test('classifyEvento cobre variações', () => {
  assert.equal(classifyEvento('Compra efetuada (Bebidas)'), 'compra');
  assert.equal(classifyEvento('No carrinho (ADEGA)'), 'carrinho');
  assert.equal(classifyEvento('Compra removida (Gôndola)'), 'removida');
  assert.equal(classifyEvento('Compra estornada'), 'estornada');
  assert.equal(classifyEvento('Cobrança pendente'), 'cobranca_pendente');
  assert.equal(classifyEvento('Pagamento efetuada (cobrança)'), 'cobranca_paga');
  assert.equal(classifyEvento('Cobrança paga'), 'cobranca_paga');
  assert.equal(classifyEvento('???'), 'outro');
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
