import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReport } from '../src/reports.js';
import {
  vendasKpis, funilEventos, porLoja, porHora, porDia, porMeioPagamento, produtosKpis, topProdutos, porCategoria,
  porFaixaEtaria, boletosKpis, vencimentosPorDia, filterTransacoes, listPdx, isoWeek, cobertura, dateBounds,
} from '../src/metrics.js';

const load = (name) => loadReport(new Uint8Array(readFileSync(new URL(`../data/sample/${name}`, import.meta.url)))).records;
const transacoes = load('transacoes.csv');
const produtos = load('produtos.csv');
const boletos = load('boletos.csv');

test('KPIs de vendas', () => {
  const k = vendasKpis(transacoes);
  assert.equal(k.compras, 1934);
  assert.equal(k.carrinhosAbandonados, 139);
  assert.equal(k.valorCarrinhosCents, 140748);
  assert.equal(k.comprasRemovidas, 244);
  assert.equal(k.estornos, 1);
  assert.equal(k.sessoes, 1934 + 139 + 244); // cobranças e estornos não entram no funil
  assert.equal(k.faturamentoCents, 4466806); // só "Compra efetuada"
  assert.equal(k.recuperadoCents, 2997); // cobranças pagas ficam fora do faturamento
  assert.equal(k.ticketMedioCents, Math.round(4466806 / 1934));
  assert.equal(k.clientesUnicos, 600);
  assert.equal(k.clientesNovos, 90);
  assert.equal(k.nfceEmitidas, 1929);
  assert.ok(k.taxaConversao > 0.83 && k.taxaConversao < 0.84);
});

test('funil de eventos na ordem e com valores', () => {
  const f = funilEventos(transacoes);
  assert.deepEqual(f.map((r) => r.key), ['compra', 'carrinho', 'removida', 'estornada', 'cobranca_pendente', 'cobranca_paga']);
  assert.equal(f[0].count, 1934);
  assert.equal(f[4].value, 83786);
});

test('por loja soma só compras efetuadas, ordenado por valor', () => {
  const rows = porLoja(transacoes);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].key, 'Calixt Pinheiros');
  assert.equal(rows[0].value, 1091046);
  assert.equal(rows[0].count, 545);
  assert.equal(rows.reduce((a, r) => a + r.value, 0), 4466806);
});

test('por hora tem 24 posições e por dia série contínua', () => {
  const h = porHora(transacoes);
  assert.equal(h.length, 24);
  assert.equal(h[0].count, 79);
  assert.equal(h.reduce((a, x) => a + x.count, 0), 1934);
  const d = porDia(transacoes);
  assert.equal(d.length, 19);
  assert.equal(d[0].key, '2026-10-01');
  assert.equal(d[18].key, '2026-10-19');
  assert.equal(d.reduce((a, x) => a + x.value, 0), 4466806);
});

test('meio de pagamento agrupa vouchers e boleto', () => {
  const rows = porMeioPagamento(transacoes);
  const keys = rows.map((r) => r.key);
  assert.deepEqual(keys, ['Crédito', 'Débito', 'Pix', 'Cartão', 'Voucher', 'Carteira']);
  assert.equal(rows.find((r) => r.key === 'Pix').count, 399);
  assert.equal(rows.find((r) => r.key === 'Voucher').count, 70 + 15 + 8);
});

test('KPIs de produtos e rankings', () => {
  const k = produtosKpis(produtos);
  assert.equal(k.receitaCents, 23478); // produtos vendidos cobre só 19/10
  assert.equal(k.itens, 22);
  assert.ok(k.margemPct > 0.4 && k.margemPct < 0.5);
  const top = topProdutos(produtos, 3);
  assert.equal(top.length, 3);
  assert.equal(top[0].key, 'Ovo Branco PINKY LIMÃO 6UN');
  const cat = porCategoria(produtos);
  assert.equal(cat[0].key, 'BEBIDAS NÃO ALCOOLICAS');
  const faixas = porFaixaEtaria(produtos);
  assert.equal(faixas.length, 6);
});

test('KPIs de boletos na data de referência', () => {
  const k = boletosKpis(boletos, '2026-10-19');
  assert.equal(k.quantidade, 22);
  assert.equal(k.totalCents, 2127652);
  assert.equal(k.vencidos, 8);
  assert.equal(k.venceEmBreve, 5); // vencem 19/10 (3) e 22/10 (2)
  assert.equal(k.pagos, 0);
  assert.equal(k.abertos, 22);
  assert.equal(k.proximoVencimento.data, '2026-10-19');
  assert.equal(k.bloqueiaInadimplente, true);
  const dias = vencimentosPorDia(k.comSituacao);
  assert.equal(dias[0].key, '2026-10-11');
  assert.equal(dias[0].situacao, 'vencido');
});

test('filtros, lojas, semana ISO, cobertura e limites', () => {
  assert.equal(filterTransacoes(transacoes, { from: '2026-10-20' }).length, 0);
  assert.equal(filterTransacoes(transacoes, { pdxId: '19860' }).length, 347);
  assert.equal(filterTransacoes(transacoes, { from: '2026-10-13', to: '2026-10-19' }).length, 824);
  const pdx = listPdx(transacoes, produtos);
  assert.equal(pdx.length, 6);
  assert.equal(isoWeek('2026-10-19'), '2026-S43');
  assert.equal(cobertura(500, 1000), 0.5);
  assert.equal(cobertura(500, 0), null);
  assert.deepEqual(dateBounds(boletos), { min: '2026-10-01', max: '2026-10-19' });
});
