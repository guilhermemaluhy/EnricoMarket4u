import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReport } from '../src/reports.js';
import {
  periodoAnterior, variacao, mediaDiaria, comparativoLojas, produtosParaRevisar, contribuicaoMargem, recorrencia,
  topClientes, abandonosPorCategoria, abandonosPorCanal, heatmapLojaPeriodo, fluxoCaixa, recomendacoes, boletosKpis, vendasKpis,
} from '../src/metrics.js';

const load = (name) => loadReport(new Uint8Array(readFileSync(new URL(`../data/sample/${name}`, import.meta.url)))).records;
const transacoes = load('transacoes.csv');
const produtos = load('produtos.csv');
const boletos = load('boletos.csv');

test('período anterior e variação', () => {
  assert.deepEqual(periodoAnterior({ from: '2026-10-13', to: '2026-10-19' }), { from: '2026-10-06', to: '2026-10-12' });
  assert.equal(periodoAnterior({ from: null, to: null }), null);
  assert.equal(variacao(120, 100), 0.2);
  assert.equal(variacao(120, 0), null);
});

test('média diária e comparativo de lojas', () => {
  assert.equal(mediaDiaria(transacoes), 23478);
  const lojas = comparativoLojas(transacoes, produtos);
  assert.equal(lojas.length, 5);
  assert.equal(lojas[0].key, 'VIE PINHEIROS');
  const vie = lojas[0];
  assert.equal(vie.compras, 3);
  assert.equal(vie.sessoes, 4);
  assert.equal(vie.abandonos, 1);
  assert.ok(vie.margemPct > 0 && vie.margemPct < 1);
  assert.ok(Math.abs(lojas.reduce((a, l) => a + l.share, 0) - 1) < 1e-9);
});

test('produtos para revisar trazem preço sugerido para 30%', () => {
  const rows = produtosParaRevisar(produtos, 0.3);
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.ok(r.margemPct < 0.3);
    assert.ok(r.precoSugeridoCents > r.precoMedioCents);
    // preço sugerido atinge a margem alvo
    assert.ok((r.precoSugeridoCents - r.custoMedioCents) / r.precoSugeridoCents >= 0.3 - 1e-6);
  }
  const top = contribuicaoMargem(produtos, 3);
  assert.equal(top[0].key, 'Ovo Branco PINKY LIMÃO 6UN');
  assert.equal(top[0].value, 2198 - 980);
});

test('recorrência, top clientes e abandonos', () => {
  const rec = recorrencia(transacoes);
  assert.equal(rec.length, 4);
  assert.equal(rec.reduce((a, r) => a + r.value, 0), 23478);
  const top = topClientes(transacoes, 3);
  assert.equal(top.length, 3);
  assert.equal(top[0].value, 3445);
  assert.ok(top[0].historicoCents >= top[0].value);
  const cat = abandonosPorCategoria(transacoes);
  assert.equal(cat.reduce((a, r) => a + r.value, 0), 6);
  const canal = abandonosPorCanal(transacoes);
  assert.equal(canal[0].key, 'APP');
});

test('heatmap loja × período', () => {
  const h = heatmapLojaPeriodo(transacoes);
  assert.equal(h.rows.length, 5);
  assert.equal(h.periodos.length, 4);
  assert.equal(h.rows.reduce((a, r) => a + r.total, 0), 23478);
  assert.ok(h.max > 0);
});

test('fluxo de caixa dos próximos 14 dias', () => {
  const k = boletosKpis(boletos, '2026-10-19');
  const c = fluxoCaixa(k.comSituacao, 23478, '2026-10-19', 14);
  assert.equal(c.rows.length, 14);
  assert.equal(c.atrasados, 8);
  assert.equal(c.atrasadoCents, 780167);
  assert.equal(c.rows[0].key, '2026-10-19');
  assert.equal(c.rows[0].boletos, 3);
  assert.equal(c.rows[0].acumuladoCents, 780167 + 239421);
  assert.ok(c.saldo7dCents < 0);
  assert.equal(c.rows[13].acumuladoCents, 2127652); // tudo vence dentro de 14 dias
});

test('recomendações priorizam crítico > alerta > info', () => {
  const vendas = vendasKpis(transacoes);
  const b = boletosKpis(boletos, '2026-10-19');
  const caixa = fluxoCaixa(b.comSituacao, mediaDiaria(transacoes), '2026-10-19');
  const recs = recomendacoes({
    vendas, lojas: comparativoLojas(transacoes, produtos), boletos: b, caixa,
    revisar: produtosParaRevisar(produtos), fiscal: { semNfce: 0 }, abandonosCategoria: abandonosPorCategoria(transacoes), diasComDados: 1,
  });
  assert.ok(recs.length >= 3);
  assert.equal(recs[0].tone, 'critical');
  assert.match(recs[0].titulo, /vencido/);
  const ordem = recs.map((r) => ({ critical: 0, warning: 1, info: 2, good: 3 })[r.tone]);
  assert.deepEqual(ordem, [...ordem].sort());
  const calmo = recomendacoes({ vendas: { ...vendas, taxaConversao: 0.9, clientesNovos: 0 }, lojas: [], boletos: { vencidos: 0, venceEmBreve: 0 }, caixa: null, revisar: [], fiscal: { semNfce: 0 }, abandonosCategoria: [], diasComDados: 1 });
  assert.equal(calmo[0].tone, 'good');
});
