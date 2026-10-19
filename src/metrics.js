// Métricas puras sobre os registros normalizados. Nada aqui toca o DOM.
import { situacaoBoleto } from './reports.js';
import { daysBetween } from './parse.js';

export const sum = (list, fn) => list.reduce((acc, x) => acc + (fn(x) || 0), 0);

export function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/** Agrega `list` por chave e devolve linhas ordenadas por `valor` desc. */
export function aggregate(list, keyFn, valueFn, extra = {}) {
  const rows = [];
  for (const [key, items] of groupBy(list, keyFn)) {
    const row = { key, count: items.length, value: sum(items, valueFn) };
    for (const [name, fn] of Object.entries(extra)) row[name] = fn(items);
    rows.push(row);
  }
  return rows.sort((a, b) => b.value - a.value || String(a.key).localeCompare(String(b.key)));
}

// --- Filtros -----------------------------------------------------------------

export function inRange(date, { from, to }) {
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export function filterTransacoes(list, { from, to, pdxId } = {}) {
  return list.filter((t) => inRange(t.data, { from, to }) && (!pdxId || t.pdxId === pdxId));
}

export function filterProdutos(list, { from, to, pdxId } = {}) {
  return list.filter((p) => inRange(p.data, { from, to }) && (!pdxId || p.pdxId === pdxId));
}

/** Boletos não têm loja: só o período (data de geração) se aplica. */
export function filterBoletos(list, { from, to } = {}) {
  return list.filter((b) => inRange(b.data ?? b.vencimento, { from, to }));
}

export function dateBounds(records) {
  let min = null;
  let max = null;
  for (const r of records) {
    const d = r.data ?? r.vencimento;
    if (!d) continue;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }
  return { min, max };
}

export function listPdx(transacoes, produtos) {
  const map = new Map();
  for (const r of [...transacoes, ...produtos]) {
    if (r.pdxId && !map.has(r.pdxId)) map.set(r.pdxId, r.pdx);
  }
  return [...map.entries()]
    .map(([id, nome]) => ({ id, nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
}

// --- Vendas (transações) -----------------------------------------------------

export function vendasKpis(transacoes) {
  const compras = transacoes.filter((t) => t.compra);
  const abandonos = transacoes.filter((t) => !t.compra);
  const faturamento = sum(compras, (t) => t.totalCents);
  const clientes = new Set(compras.map((t) => t.clienteId).filter(Boolean));
  const novos = compras.filter((t) => t.comprasCliente <= 1).length;
  return {
    faturamentoCents: faturamento,
    compras: compras.length,
    ticketMedioCents: compras.length ? Math.round(faturamento / compras.length) : 0,
    itensPorCompra: compras.length ? sum(compras, (t) => t.qtdeProdutos) / compras.length : 0,
    carrinhosAbandonados: abandonos.length,
    taxaConversao: transacoes.length ? compras.length / transacoes.length : 0,
    clientesUnicos: clientes.size,
    clientesNovos: novos,
    descontosCents: sum(compras, (t) => t.descontoCents),
    estornosCents: sum(compras, (t) => t.estornoCents),
    cashbackCents: sum(compras, (t) => t.cashbackCents),
    nfceEmitidas: compras.filter((t) => t.nfce).length,
    cpfNaNota: compras.filter((t) => t.cpfNaNota).length,
  };
}

export const porLoja = (transacoes) =>
  aggregate(
    transacoes.filter((t) => t.compra),
    (t) => t.pdx,
    (t) => t.totalCents,
    { pdxId: (items) => items[0].pdxId },
  );

export const porVia = (transacoes) =>
  aggregate(
    transacoes.filter((t) => t.compra),
    (t) => t.via ?? '(sem via)',
    (t) => t.totalCents,
  );

export const porMeioPagamento = (transacoes) =>
  aggregate(
    transacoes.filter((t) => t.compra),
    (t) => t.meioPagamento ?? '(não informado)',
    (t) => t.totalCents,
  );

/** 24 posições (0h–23h) com faturamento e nº de compras. */
export function porHora(transacoes) {
  const slots = Array.from({ length: 24 }, (_, h) => ({ key: h, value: 0, count: 0 }));
  for (const t of transacoes) {
    if (!t.compra || t.hora == null) continue;
    slots[t.hora].value += t.totalCents;
    slots[t.hora].count += 1;
  }
  return slots;
}

/** Série diária contínua entre a primeira e a última data (dias sem venda = 0). */
export function porDia(transacoes) {
  const compras = transacoes.filter((t) => t.compra && t.data);
  if (compras.length === 0) return [];
  const byDay = aggregate(compras, (t) => t.data, (t) => t.totalCents);
  const map = new Map(byDay.map((r) => [r.key, r]));
  const dates = byDay.map((r) => r.key).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const out = [];
  const total = daysBetween(first, last);
  for (let i = 0; i <= total; i++) {
    const d = new Date(Date.UTC(+first.slice(0, 4), +first.slice(5, 7) - 1, +first.slice(8, 10) + i))
      .toISOString()
      .slice(0, 10);
    out.push(map.get(d) ?? { key: d, value: 0, count: 0 });
  }
  return out;
}

export const abandonosPorLoja = (transacoes) =>
  aggregate(
    transacoes.filter((t) => !t.compra),
    (t) => t.pdx,
    () => 1,
  );

// --- Produtos ----------------------------------------------------------------

export function produtosKpis(produtos) {
  const receita = sum(produtos, (p) => p.vendaCents);
  const custo = sum(produtos, (p) => p.custoCents);
  return {
    receitaCents: receita,
    custoCents: custo,
    margemCents: receita - custo,
    margemPct: receita ? (receita - custo) / receita : 0,
    itens: sum(produtos, (p) => p.quantidade),
    skus: new Set(produtos.map((p) => p.produtoId)).size,
  };
}

const margemExtras = {
  custo: (items) => sum(items, (p) => p.custoCents),
  margem: (items) => sum(items, (p) => p.margemCents),
  quantidade: (items) => sum(items, (p) => p.quantidade),
};

export const topProdutos = (produtos, limit = 10) =>
  aggregate(produtos, (p) => p.nome, (p) => p.vendaCents, {
    ...margemExtras,
    categoria: (items) => items[0].categoria,
  }).slice(0, limit);

export const porCategoria = (produtos) =>
  aggregate(produtos, (p) => p.categoria, (p) => p.vendaCents, margemExtras);

export const porFabricante = (produtos, limit = 10) =>
  aggregate(produtos, (p) => p.fabricante, (p) => p.vendaCents, margemExtras).slice(0, limit);

export const porSexo = (produtos) =>
  aggregate(produtos, (p) => p.sexo ?? '(não informado)', (p) => p.vendaCents);

export function faixaEtaria(idade) {
  if (idade == null) return '(não informada)';
  if (idade < 25) return 'até 24';
  if (idade < 35) return '25–34';
  if (idade < 45) return '35–44';
  if (idade < 55) return '45–54';
  return '55+';
}

export const FAIXAS = ['até 24', '25–34', '35–44', '45–54', '55+', '(não informada)'];

export function porFaixaEtaria(produtos) {
  const rows = aggregate(produtos, (p) => faixaEtaria(p.idade), (p) => p.vendaCents);
  return FAIXAS.map((f) => rows.find((r) => r.key === f) ?? { key: f, value: 0, count: 0 });
}

/** Produtos com margem abaixo de `limite` (ex.: 0.25) — candidatos a revisão de preço. */
export const margemBaixa = (produtos, limite = 0.3) =>
  porCategoria(produtos)
    .concat()
    .filter((r) => r.value > 0 && r.margem / r.value < limite);

// --- Boletos -----------------------------------------------------------------

export function boletosKpis(boletos, hoje) {
  const comSituacao = boletos.map((b) => ({ ...b, situacao: situacaoBoleto(b, hoje) }));
  const por = (s) => comSituacao.filter((b) => b.situacao === s);
  const abertos = comSituacao.filter((b) => b.situacao !== 'pago');
  const proximo = abertos
    .filter((b) => b.vencimento && b.vencimento >= hoje)
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento))[0];
  return {
    totalCents: sum(boletos, (b) => b.valorCents),
    quantidade: boletos.length,
    abertosCents: sum(abertos, (b) => b.valorCents),
    abertos: abertos.length,
    vencidosCents: sum(por('vencido'), (b) => b.valorCents),
    vencidos: por('vencido').length,
    venceEmBreveCents: sum(por('vence_em_breve'), (b) => b.valorCents),
    venceEmBreve: por('vence_em_breve').length,
    aVencerCents: sum(por('a_vencer'), (b) => b.valorCents),
    aVencer: por('a_vencer').length,
    pagosCents: sum(por('pago'), (b) => b.valorCents),
    pagos: por('pago').length,
    proximoVencimento: proximo ? { data: proximo.vencimento, valorCents: proximo.valorCents } : null,
    bloqueiaInadimplente: abertos.some((b) => b.bloqueiaInadimplente),
    comSituacao,
  };
}

/** Vencimentos agrupados por dia, com situação dominante para colorir. */
export function vencimentosPorDia(comSituacao) {
  return aggregate(
    comSituacao.filter((b) => b.vencimento),
    (b) => b.vencimento,
    (b) => b.valorCents,
    {
      situacao: (items) =>
        ['vencido', 'vence_em_breve', 'a_vencer', 'pago'].find((s) => items.some((b) => b.situacao === s)),
    },
  ).sort((a, b) => a.key.localeCompare(b.key));
}

/** Reposição (boletos gerados) por semana ISO, para comparar com vendas. */
export function reposicaoPorSemana(boletos) {
  return aggregate(
    boletos.filter((b) => b.data),
    (b) => isoWeek(b.data),
    (b) => b.valorCents,
  ).sort((a, b) => a.key.localeCompare(b.key));
}

export function isoWeek(date) {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-S${String(week).padStart(2, '0')}`;
}

/**
 * Cobertura: quanto do valor dos boletos gerados no período já foi recuperado
 * pelo faturamento do mesmo período. Só faz sentido com os dois relatórios cobrindo as mesmas datas.
 */
export function cobertura(faturamentoCents, boletosCents) {
  if (!boletosCents) return null;
  return faturamentoCents / boletosCents;
}
