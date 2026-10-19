// Métricas puras sobre os registros normalizados. Nada aqui toca o DOM.
import { situacaoBoleto } from './reports.js';
import { daysBetween, addDays } from './parse.js';

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

export function filterRetornos(list, { from, to, pdxId } = {}) {
  return list.filter((r) => inRange(r.data, { from, to }) && (!pdxId || r.pdxId === pdxId));
}

/** O inventário identifica a loja pelo "Código PDX"; o mapa código→id vem do relatório de produtos. */
export function mapaCodigoPdx(produtos) {
  const map = new Map();
  for (const p of produtos) if (p.codigoPdx && p.pdxId && !map.has(p.codigoPdx)) map.set(p.codigoPdx, p.pdxId);
  return map;
}

export function filterInventario(list, { from, to, pdxId, pdxNome } = {}, mapa = new Map()) {
  return list.filter((i) => {
    if (!inRange(i.data, { from, to })) return false;
    if (!pdxId) return true;
    const id = mapa.get(i.codigoPdx);
    return id ? id === pdxId : pdxNome != null && i.pdx === pdxNome;
  });
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

/** Sessões que contam no funil de conversão: compra, carrinho abandonado e compra removida. */
const noFunil = (t) => t.tipoEvento === 'compra' || t.tipoEvento === 'carrinho' || t.tipoEvento === 'removida';

export function vendasKpis(transacoes) {
  const compras = transacoes.filter((t) => t.compra);
  const carrinhos = transacoes.filter((t) => t.tipoEvento === 'carrinho');
  const removidas = transacoes.filter((t) => t.tipoEvento === 'removida');
  const estornadas = transacoes.filter((t) => t.tipoEvento === 'estornada');
  const cobrancasPagas = transacoes.filter((t) => t.tipoEvento === 'cobranca_paga');
  const sessoes = transacoes.filter(noFunil);
  const faturamento = sum(compras, (t) => t.totalCents);
  const clientes = new Set(compras.map((t) => t.clienteId).filter(Boolean));
  const novos = compras.filter((t) => t.comprasCliente <= 1).length;
  return {
    faturamentoCents: faturamento,
    recuperadoCents: sum(cobrancasPagas, (t) => t.totalCents),
    compras: compras.length,
    ticketMedioCents: compras.length ? Math.round(faturamento / compras.length) : 0,
    itensPorCompra: compras.length ? sum(compras, (t) => t.qtdeProdutos) / compras.length : 0,
    carrinhosAbandonados: carrinhos.length,
    valorCarrinhosCents: sum(carrinhos, (t) => t.totalCents),
    comprasRemovidas: removidas.length,
    estornos: estornadas.length,
    estornosValorCents: sum(estornadas, (t) => t.totalCents),
    sessoes: sessoes.length,
    taxaConversao: sessoes.length ? compras.length / sessoes.length : 0,
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
    transacoes.filter((t) => t.tipoEvento === 'carrinho'),
    (t) => t.pdx,
    () => 1,
    { valor: (items) => sum(items, (t) => t.totalCents) },
  );

export const ORDEM_FUNIL = ['compra', 'carrinho', 'removida', 'estornada', 'cobranca_pendente', 'cobranca_paga'];

/** Contagem e valor por tipo de evento, na ordem do funil. */
export function funilEventos(transacoes) {
  const rows = aggregate(transacoes, (t) => t.tipoEvento, (t) => t.totalCents);
  return ORDEM_FUNIL.map((k) => rows.find((r) => r.key === k) ?? { key: k, value: 0, count: 0 }).filter((r) => r.count > 0 || ['compra', 'carrinho', 'removida'].includes(r.key));
}

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

// =============================================================================
// Métricas para decisão
// =============================================================================

/** Janela anterior de mesmo tamanho (para comparar "vs período anterior"). */
export function periodoAnterior({ from, to }) {
  if (!from || !to) return null;
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

/** Variação relativa; null quando não há base. */
export function variacao(atual, anterior) {
  if (!anterior) return null;
  return (atual - anterior) / anterior;
}

/** Faturamento médio por dia com venda. */
export function mediaDiaria(transacoes) {
  const compras = transacoes.filter((t) => t.compra && t.data);
  const dias = new Set(compras.map((t) => t.data)).size;
  return dias ? Math.round(sum(compras, (t) => t.totalCents) / dias) : 0;
}

/** Uma linha por loja com os indicadores que separam loja boa de loja com problema. */
export function comparativoLojas(transacoes, produtos) {
  const porPdx = groupBy(transacoes, (t) => t.pdx);
  const prodPorPdx = groupBy(produtos, (p) => p.pdx);
  const total = sum(transacoes.filter((t) => t.compra), (t) => t.totalCents);
  const rows = [];
  for (const [pdx, items] of porPdx) {
    const compras = items.filter((t) => t.compra);
    const sessoes = items.filter(noFunil);
    const fat = sum(compras, (t) => t.totalCents);
    const prods = prodPorPdx.get(pdx) ?? [];
    const receita = sum(prods, (p) => p.vendaCents);
    const custo = sum(prods, (p) => p.custoCents);
    const pendentes = items.filter((t) => t.tipoEvento === 'cobranca_pendente');
    rows.push({
      key: pdx,
      pdxId: items[0].pdxId,
      faturamentoCents: fat,
      share: total ? fat / total : 0,
      compras: compras.length,
      ticketCents: compras.length ? Math.round(fat / compras.length) : 0,
      itensPorCompra: compras.length ? sum(compras, (t) => t.qtdeProdutos) / compras.length : 0,
      sessoes: sessoes.length,
      abandonos: sessoes.length - compras.length,
      carrinhos: items.filter((t) => t.tipoEvento === 'carrinho').length,
      removidas: items.filter((t) => t.tipoEvento === 'removida').length,
      cobrancasPendentes: pendentes.length,
      cobrancasPendentesCents: sum(pendentes, (t) => t.totalCents),
      conversao: sessoes.length ? compras.length / sessoes.length : 0,
      pctApp: compras.length ? compras.filter((t) => t.via === 'APP').length / compras.length : 0,
      clientes: new Set(compras.map((t) => t.clienteId)).size,
      margemPct: receita ? (receita - custo) / receita : null,
    });
  }
  return rows.sort((a, b) => b.faturamentoCents - a.faturamentoCents);
}

/** Produtos vendidos com margem abaixo do alvo e o preço unitário que atingiria o alvo. */
export function produtosParaRevisar(produtos, alvo = 0.3, limit = 15) {
  const rows = aggregate(produtos, (p) => p.nome, (p) => p.vendaCents, {
    custo: (items) => sum(items, (p) => p.custoCents),
    quantidade: (items) => sum(items, (p) => p.quantidade),
    categoria: (items) => items[0].categoria,
    codigo: (items) => items[0].codigo,
  });
  return rows
    .map((r) => {
      const precoMedio = r.quantidade ? r.value / r.quantidade : 0;
      const custoMedio = r.quantidade ? r.custo / r.quantidade : 0;
      const margemPct = r.value ? (r.value - r.custo) / r.value : 0;
      return {
        ...r,
        precoMedioCents: Math.round(precoMedio),
        custoMedioCents: Math.round(custoMedio),
        margemPct,
        precoSugeridoCents: Math.ceil(custoMedio / (1 - alvo)),
        margemPerdidaCents: Math.max(0, Math.round(r.value * alvo - (r.value - r.custo))),
      };
    })
    .filter((r) => r.value > 0 && r.margemPct < alvo)
    .sort((a, b) => b.margemPerdidaCents - a.margemPerdidaCents)
    .slice(0, limit);
}

/** Quem realmente paga a conta: produtos ordenados pela margem em R$. */
export const contribuicaoMargem = (produtos, limit = 10) =>
  aggregate(produtos, (p) => p.nome, (p) => p.margemCents, {
    receita: (items) => sum(items, (p) => p.vendaCents),
    quantidade: (items) => sum(items, (p) => p.quantidade),
  }).slice(0, limit);

export const FAIXAS_RECORRENCIA = ['1ª compra', '2–5 compras', '6–20 compras', '21+ compras'];

export function faixaRecorrencia(n) {
  if (n <= 1) return FAIXAS_RECORRENCIA[0];
  if (n <= 5) return FAIXAS_RECORRENCIA[1];
  if (n <= 20) return FAIXAS_RECORRENCIA[2];
  return FAIXAS_RECORRENCIA[3];
}

/** Faturamento por faixa de recorrência do cliente (histórico de compras que o painel informa). */
export function recorrencia(transacoes) {
  const compras = transacoes.filter((t) => t.compra);
  const rows = aggregate(compras, (t) => faixaRecorrencia(t.comprasCliente), (t) => t.totalCents);
  return FAIXAS_RECORRENCIA.map((f) => rows.find((r) => r.key === f) ?? { key: f, value: 0, count: 0 });
}

export function topClientes(transacoes, limit = 10) {
  const compras = transacoes.filter((t) => t.compra && t.clienteId);
  return aggregate(compras, (t) => t.clienteId, (t) => t.totalCents, {
    nome: (items) => items[0].cliente ?? items[0].clienteId,
    loja: (items) => items[0].pdx,
    historicoCents: (items) => Math.max(...items.map((t) => t.totalGastoCliente)),
    comprasHistorico: (items) => Math.max(...items.map((t) => t.comprasCliente)),
    ultima: (items) => items.map((t) => t.dataHora).sort().pop(),
  }).slice(0, limit);
}

export const abandonosPorCategoria = (transacoes) =>
  aggregate(
    transacoes.filter((t) => t.tipoEvento === 'carrinho'),
    (t) => t.categoriaEvento ?? '(sem categoria)',
    () => 1,
  );

export const abandonosPorCanal = (transacoes) =>
  aggregate(
    transacoes.filter((t) => t.tipoEvento === 'carrinho'),
    (t) => t.via ?? '(sem canal)',
    () => 1,
  );

export const PERIODOS_DIA = [
  { key: 'Madrugada (0–6h)', from: 0, to: 6 },
  { key: 'Manhã (6–12h)', from: 6, to: 12 },
  { key: 'Tarde (12–18h)', from: 12, to: 18 },
  { key: 'Noite (18–24h)', from: 18, to: 24 },
];

/** Matriz loja × período do dia (faturamento), para planejar reposição e visitas. */
export function heatmapLojaPeriodo(transacoes) {
  const compras = transacoes.filter((t) => t.compra && t.hora != null);
  const lojas = [...new Set(compras.map((t) => t.pdx))].sort();
  const max = { value: 0 };
  const rows = lojas.map((loja) => {
    const cells = PERIODOS_DIA.map((p) => {
      const items = compras.filter((t) => t.pdx === loja && t.hora >= p.from && t.hora < p.to);
      const value = sum(items, (t) => t.totalCents);
      if (value > max.value) max.value = value;
      return { key: p.key, value, count: items.length };
    });
    return { key: loja, cells, total: sum(cells, (c) => c.value) };
  });
  return { rows, max: max.value, periodos: PERIODOS_DIA.map((p) => p.key) };
}

/**
 * Caixa dos próximos dias: o que vence em cada dia (boletos abertos), o acumulado
 * e a receita projetada pela média diária. Saldo negativo = precisa de caixa extra.
 */
export function fluxoCaixa(comSituacao, mediaDiariaCents, hoje, dias = 14) {
  const abertos = comSituacao.filter((b) => b.situacao !== 'pago' && b.vencimento);
  const atrasados = abertos.filter((b) => b.vencimento < hoje);
  const atrasadoCents = sum(atrasados, (b) => b.valorCents);
  const rows = [];
  let acumulado = atrasadoCents;
  for (let i = 0; i < dias; i++) {
    const data = addDays(hoje, i);
    const doDia = abertos.filter((b) => b.vencimento === data);
    const aPagar = sum(doDia, (b) => b.valorCents);
    acumulado += aPagar;
    const receitaProjetada = mediaDiariaCents * (i + 1);
    rows.push({ key: data, aPagarCents: aPagar, boletos: doDia.length, acumuladoCents: acumulado, receitaProjetadaCents: receitaProjetada, saldoCents: receitaProjetada - acumulado });
  }
  const semana = rows[Math.min(6, rows.length - 1)];
  return {
    atrasadoCents,
    atrasados: atrasados.length,
    rows,
    aPagar7dCents: semana ? semana.acumuladoCents - atrasadoCents : 0,
    receita7dCents: semana ? semana.receitaProjetadaCents : 0,
    saldo7dCents: semana ? semana.saldoCents : 0,
    diasParaCobrir: mediaDiariaCents ? Math.ceil((semana ? semana.acumuladoCents : atrasadoCents) / mediaDiariaCents) : null,
  };
}

/**
 * Lista priorizada do que fazer. Cada item: { tone: critical|warning|info|good, titulo, detalhe, acao }.
 * Regras simples e explícitas; o gestor decide.
 */
export function recomendacoes({ vendas, lojas, boletos, caixa, revisar, fiscal, abandonosCategoria, cobrancas, diasComDados }) {
  const out = [];
  if (boletos && boletos.vencidos > 0) {
    out.push({
      tone: 'critical',
      titulo: `Pagar ${boletos.vencidos} boleto${boletos.vencidos > 1 ? 's' : ''} vencido${boletos.vencidos > 1 ? 's' : ''}`,
      valorCents: boletos.vencidosCents,
      detalhe: boletos.bloqueiaInadimplente ? 'Boletos com bloqueio por inadimplência: o CD pode travar novos pedidos de reposição.' : 'Boletos vencidos acumulam juros e multa.',
      acao: 'Quitar hoje, começando pelos mais antigos.',
    });
  }
  if (boletos && boletos.venceEmBreve > 0) {
    out.push({
      tone: 'warning',
      titulo: `${boletos.venceEmBreve} boleto${boletos.venceEmBreve > 1 ? 's vencem' : ' vence'} em até 3 dias`,
      valorCents: boletos.venceEmBreveCents,
      detalhe: 'Programar o pagamento evita cair em inadimplência.',
      acao: 'Agendar o pagamento no banco.',
    });
  }
  if (caixa && caixa.saldo7dCents < 0 && diasComDados > 0) {
    out.push({
      tone: 'warning',
      titulo: 'Caixa dos próximos 7 dias não cobre os boletos',
      valorCents: -caixa.saldo7dCents,
      detalhe: `Vencem ${fmtMoney(caixa.aPagar7dCents + caixa.atrasadoCents)} (inclui atrasados) e a receita projetada pela média diária é ${fmtMoney(caixa.receita7dCents)}.`,
      acao: caixa.diasParaCobrir ? `Reservar caixa extra ou negociar prazo: seriam ${caixa.diasParaCobrir} dias de venda para cobrir.` : 'Reservar caixa extra ou negociar prazo com o CD.',
    });
  }
  if (cobrancas && cobrancas.pendentes > 0) {
    const antiga = cobrancas.maisAntigaDias ?? 0;
    const agir = cobrancas.agirHoje ?? 0;
    out.push({
      tone: antiga > 7 || cobrancas.pendentesCents >= 30000 ? 'critical' : 'warning',
      titulo: `${cobrancas.pendentes} cobrança${cobrancas.pendentes > 1 ? 's' : ''} pendente${cobrancas.pendentes > 1 ? 's' : ''} de itens levados sem pagar`,
      valorCents: cobrancas.pendentesCents,
      detalhe: `A mais antiga está aberta há ${antiga} dia${antiga === 1 ? '' : 's'}${agir ? ` · ${agir} para agir hoje${cobrancas.agirResumo ? ` (${cobrancas.agirResumo})` : ''}` : ''}${cobrancas.jaBloqueados ? ` · ${cobrancas.jaBloqueados} de cliente já bloqueado` : ''}.`,
      acao: 'Seguir a fila da aba Cobranças: cada pendência tem a próxima ação e o canal.',
    });
  }
  if (fiscal && fiscal.semNfce > 0) {
    out.push({
      tone: 'critical',
      titulo: `${fiscal.semNfce} compra${fiscal.semNfce > 1 ? 's' : ''} sem NFC-e emitida`,
      detalhe: 'Venda sem nota é risco fiscal.',
      acao: 'Verificar a emissão no painel Market4u e reemitir.',
    });
  }
  for (const loja of lojas ?? []) {
    if (loja.sessoes >= 5 && loja.conversao < 0.6) {
      out.push({
        tone: 'warning',
        titulo: `${loja.key} converte só ${Math.round(loja.conversao * 100)}% dos carrinhos`,
        detalhe: `${loja.abandonos} de ${loja.sessoes} sessões terminaram sem compra.`,
        acao: 'Checar totem/app, leitura de código de barras, falta de produto na gôndola e preços.',
      });
    }
  }
  if (lojas && lojas.length >= 2) {
    const media = lojas.reduce((a, l) => a + l.faturamentoCents, 0) / lojas.length;
    const fraca = lojas[lojas.length - 1];
    if (fraca.faturamentoCents < media * 0.5) {
      out.push({
        tone: 'info',
        titulo: `${fraca.key} fatura ${fraca.faturamentoCents / media < 0.01 ? 'menos de 1%' : `${Math.round((fraca.faturamentoCents / media) * 100)}%`} da média das lojas`,
        valorCents: fraca.faturamentoCents,
        detalhe: `${fraca.compras} compras e ticket ${fmtMoney(fraca.ticketCents)} no período.`,
        acao: 'Avaliar mix, visibilidade no condomínio e campanhas de cashback para essa loja.',
      });
    }
  }
  if (revisar && revisar.length > 0 && revisar.reduce((a, r) => a + r.margemPerdidaCents, 0) >= 2000) {
    const perdido = revisar.reduce((a, r) => a + r.margemPerdidaCents, 0);
    out.push({
      tone: 'warning',
      titulo: `${revisar.length} produto${revisar.length > 1 ? 's' : ''} vendendo com margem abaixo de 30%`,
      valorCents: perdido,
      detalhe: `Margem deixada na mesa no período: ${fmtMoney(perdido)}. Maior impacto: ${revisar[0].key}.`,
      acao: 'Revisar preços com a tabela "Produtos com margem a revisar" (aba Produtos).',
    });
  }
  if (abandonosCategoria && abandonosCategoria.length > 0 && abandonosCategoria[0].key !== '(sem categoria)' && abandonosCategoria[0].value >= 2) {
    out.push({
      tone: 'info',
      titulo: `Carrinhos abandonados concentrados em ${abandonosCategoria[0].key}`,
      detalhe: `${abandonosCategoria[0].value} carrinhos dessa categoria ficaram sem compra.`,
      acao: 'Conferir preço e disponibilidade dos itens dessa categoria.',
    });
  }
  if (vendas && vendas.compras > 0 && vendas.clientesNovos / Math.max(1, vendas.clientesUnicos) >= 0.3) {
    out.push({
      tone: 'info',
      titulo: `${Math.round((vendas.clientesNovos / vendas.clientesUnicos) * 100)}% dos clientes estão na primeira compra`,
      detalhe: 'Boa entrada de clientes novos; o desafio é fazê-los voltar.',
      acao: 'Ativar cashback ou voucher de segunda compra no app.',
    });
  }
  if (vendas && vendas.taxaConversao >= 0.8 && (boletos?.vencidos ?? 0) === 0 && out.length === 0) {
    out.push({ tone: 'good', titulo: 'Nenhum alerta no período', detalhe: 'Conversão alta e boletos em dia.', acao: 'Seguir acompanhando.' });
  }
  const ordem = { critical: 0, warning: 1, info: 2, good: 3 };
  return out.sort((a, b) => ordem[a.tone] - ordem[b.tone]);
}

const fmtMoney = (c) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((c ?? 0) / 100);


// =============================================================================
// Operação: inventário e remessas de retorno
// =============================================================================

/** Último inventário de cada loja (posição de estoque é uma foto; vale a mais recente). */
export function ultimoInventarioPorLoja(inventario) {
  const porLoja = groupBy(inventario, (i) => i.pdx);
  const out = [];
  for (const [pdx, items] of porLoja) {
    const ultimo = items.reduce((a, i) => (i.dataHora > a ? i.dataHora : a), '');
    const inv = items.filter((i) => i.dataHora === ultimo);
    out.push({ pdx, inventario: inv[0].inventario, data: inv[0].data, itens: inv });
  }
  return out.sort((a, b) => a.pdx.localeCompare(b.pdx));
}

export function estoqueKpis(itens) {
  const custo = sum(itens, (i) => i.posicaoAjustada * i.custoUnitCents);
  const venda = sum(itens, (i) => i.posicaoAjustada * i.vendaUnitCents);
  const faltas = itens.filter((i) => i.diferenca < 0);
  const sobras = itens.filter((i) => i.diferenca > 0);
  const perdaCusto = -sum(faltas, (i) => i.custoDiferencaCents);
  const custoAnterior = sum(itens, (i) => i.posicaoAnterior * i.custoUnitCents);
  return {
    skus: itens.length,
    unidades: sum(itens, (i) => i.posicaoAjustada),
    custoCents: custo,
    vendaCents: venda,
    margemPotencialCents: venda - custo,
    perdaUnidades: -sum(faltas, (i) => i.diferenca),
    perdaCustoCents: perdaCusto,
    perdaVendaCents: -sum(faltas, (i) => i.vendaDiferencaCents),
    perdaPct: custoAnterior ? perdaCusto / custoAnterior : 0,
    sobraUnidades: sum(sobras, (i) => i.diferenca),
    sobraCustoCents: sum(sobras, (i) => i.custoDiferencaCents),
    skusComFalta: faltas.length,
    acuracidade: itens.length ? itens.filter((i) => i.diferenca === 0).length / itens.length : 0,
    rupturas: itens.filter((i) => i.posicaoAjustada <= 0).length,
    estoqueBaixo: itens.filter((i) => i.posicaoAjustada > 0 && i.posicaoAjustada <= 1).length,
  };
}

export const perdasPorCategoria = (itens) =>
  aggregate(
    itens.filter((i) => i.diferenca < 0),
    (i) => i.categoria,
    (i) => -i.custoDiferencaCents,
    { unidades: (items) => -sum(items, (i) => i.diferenca) },
  );

export const perdasTopProdutos = (itens, limit = 10) =>
  aggregate(
    itens.filter((i) => i.diferenca < 0),
    (i) => i.produto,
    (i) => -i.custoDiferencaCents,
    { unidades: (items) => -sum(items, (i) => i.diferenca), categoria: (items) => items[0].categoria, loja: (items) => items[0].pdx },
  ).slice(0, limit);

export const estoquePorCategoria = (itens) =>
  aggregate(itens, (i) => i.categoria, (i) => i.posicaoAjustada * i.custoUnitCents, {
    unidades: (items) => sum(items, (i) => i.posicaoAjustada),
    skus: (items) => items.length,
    rupturas: (items) => items.filter((i) => i.posicaoAjustada <= 0).length,
  });

/**
 * Itens zerados ou com 1 unidade, cruzados com o que vendeu no período (relatório de
 * produtos) para priorizar reposição: o que vende e está acabando vem primeiro.
 */
export function reposicaoPrioritaria(itens, produtos, limit = 20) {
  const vendidos = new Map();
  for (const p of produtos) {
    const k = p.ean || p.codigo;
    vendidos.set(k, (vendidos.get(k) ?? 0) + p.quantidade);
  }
  return itens
    .filter((i) => i.posicaoAjustada <= 1)
    .map((i) => ({ ...i, vendidos: vendidos.get(i.ean) ?? vendidos.get(i.codigo) ?? 0 }))
    .sort((a, b) => b.vendidos - a.vendidos || a.posicaoAjustada - b.posicaoAjustada || b.vendaUnitCents - a.vendaUnitCents)
    .slice(0, limit);
}

export function retornosKpis(retornos) {
  const porTipo = aggregate(retornos, (r) => r.tipo, (r) => r.custoTotalCents, { unidades: (items) => sum(items, (r) => r.quantidade) });
  return {
    custoCents: sum(retornos, (r) => r.custoTotalCents),
    unidades: sum(retornos, (r) => r.quantidade),
    remessas: new Set(retornos.map((r) => r.remessa)).size,
    porTipo,
    vencidosCents: porTipo.find((r) => /vencid/i.test(r.key))?.value ?? 0,
    avariasCents: porTipo.find((r) => /avaria/i.test(r.key))?.value ?? 0,
  };
}

export const retornosPorLoja = (retornos) =>
  aggregate(retornos, (r) => r.pdx, (r) => r.custoTotalCents, { unidades: (items) => sum(items, (r) => r.quantidade) });

export const retornosTopProdutos = (retornos, limit = 10) =>
  aggregate(retornos, (r) => r.produto, (r) => r.custoTotalCents, {
    unidades: (items) => sum(items, (r) => r.quantidade),
    tipo: (items) => [...new Set(items.map((r) => r.tipo))].join(' / '),
    lojas: (items) => [...new Set(items.map((r) => r.pdx))].join(', '),
  }).slice(0, limit);

export const retornosPorSemana = (retornos) =>
  aggregate(retornos, (r) => isoWeek(r.data), (r) => r.custoTotalCents, { unidades: (items) => sum(items, (r) => r.quantidade) }).sort((a, b) => a.key.localeCompare(b.key));

/** Recomendações de operação (anexadas às demais). */
export function recomendacoesOperacao({ estoquePorLoja, retornos, retornosTop }) {
  const out = [];
  for (const loja of estoquePorLoja ?? []) {
    const k = loja.kpis;
    if (k.perdaCustoCents > 0 && (k.perdaPct >= 0.03 || k.perdaCustoCents >= 20000)) {
      out.push({
        tone: k.perdaPct >= 0.05 ? 'critical' : 'warning',
        titulo: `${loja.pdx}: ${new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 }).format(k.perdaPct)} do estoque sumiu no inventário`,
        valorCents: k.perdaCustoCents,
        detalhe: `${k.perdaUnidades} unidades em ${k.skusComFalta} produtos faltaram na contagem de ${loja.data.slice(8, 10)}/${loja.data.slice(5, 7)} (acuracidade ${Math.round(k.acuracidade * 100)}%).`,
        acao: 'Conferir câmeras nos horários de pico, checar leitura de código de barras e produtos sem registro; revisar a frequência de inventário.',
      });
    }
    if (k.rupturas > 0) {
      out.push({
        tone: 'warning',
        titulo: `${loja.pdx}: ${k.rupturas} produto${k.rupturas > 1 ? 's' : ''} zerado${k.rupturas > 1 ? 's' : ''} na gôndola`,
        detalhe: `Mais ${k.estoqueBaixo} com apenas 1 unidade. Produto que falta é venda que não acontece e carrinho abandonado.`,
        acao: 'Usar a lista "Reposição prioritária" (aba Operação) no próximo pedido ao CD.',
      });
    }
  }
  if (retornos && retornos.custoCents > 0) {
    const top = retornosTop?.[0];
    out.push({
      tone: retornos.vencidosCents >= 20000 ? 'warning' : 'info',
      titulo: `${fmtMoney(retornos.custoCents)} devolvidos ao CD por vencimento e avaria`,
      valorCents: retornos.custoCents,
      detalhe: `${retornos.unidades} unidades em ${retornos.remessas} remessas · vencidos ${fmtMoney(retornos.vencidosCents)}, avarias ${fmtMoney(retornos.avariasCents)}${top ? ` · maior perda: ${top.key}` : ''}.`,
      acao: 'Reduzir o pedido dos itens que vencem sem girar e conferir a validade na reposição (PVPS: primeiro que vence, primeiro que sai).',
    });
  }
  return out;
}


// =============================================================================
// Cobranças: recuperação de itens levados sem pagamento
// =============================================================================

/** Régua de cobrança: etapa por dias em aberto. */
export const REGUA = [
  { key: 'D0–2 · link e mensagem', min: 0, max: 2, tone: 'neutral', etapa: 'D+1' },
  { key: 'D3–6 · ligar e oferecer Pix', min: 3, max: 6, tone: 'warning', etapa: 'D+3' },
  { key: 'D7–13 · bloquear no app', min: 7, max: 13, tone: 'critical', etapa: 'D+7' },
  { key: 'D14–29 · escalar ao síndico', min: 14, max: 29, tone: 'critical', etapa: 'D+7' },
  { key: '≥ D30 · perda provável', min: 30, max: Infinity, tone: 'muted', etapa: 'D+7' },
];

export const etapaRegua = (dias) => REGUA.find((r) => dias <= r.max);

// mantidos por compatibilidade (faixas simples de envelhecimento)
export const AGING = [
  { key: 'até 3 dias', max: 3 },
  { key: '4–7 dias', max: 7 },
  { key: '8–15 dias', max: 15 },
  { key: '16–30 dias', max: 30 },
  { key: 'mais de 30 dias', max: Infinity },
];
export function faixaAging(dias) {
  return AGING.find((a) => dias <= a.max).key;
}

const bloqueado = (t) => /bloquead/i.test(t.statusCliente ?? '');
const ativo = (t) => /^ativo/i.test(t.statusCliente ?? '');
const idValido = (t) => Boolean(t.clienteId && t.clienteId !== '--');
const minutos = (a, b) => (new Date(b) - new Date(a)) / 60_000;

/** Índice de não compra do cliente (histórico que o painel informa). */
export const indiceNaoCompra = (t) => (t.comprasCliente + t.naoComprasCliente ? t.naoComprasCliente / (t.comprasCliente + t.naoComprasCliente) : 0);

/** Nomes de operadores/responsáveis (inventário e retornos) para tirar das listas de clientes. */
export function nomesOperadores(inventario = [], retornos = []) {
  const set = new Set();
  for (const r of [...inventario, ...retornos]) {
    if (r.responsavel) set.add(r.responsavel.trim().toLowerCase());
    if (r.operador) set.add(r.operador.trim().toLowerCase());
  }
  return set;
}

/** Enriquece uma cobrança pendente com dias, sinais, pontuação de urgência e próxima ação. */
export function avaliarPendente(t, todas, hoje) {
  const dias = t.data ? Math.max(0, daysBetween(t.data, hoje)) : 0;
  const doCliente = idValido(t) ? todas.filter((x) => x.clienteId === t.clienteId) : [];
  const depois = doCliente.filter((x) => (x.tipoEvento === 'compra' || x.tipoEvento === 'carrinho') && x.dataHora > t.dataHora);
  const comprouDepois = depois.find((x) => x.tipoEvento === 'compra') ?? depois[0] ?? null;
  const removidas7d = doCliente.filter((x) => x.tipoEvento === 'removida' && x.dataHora < t.dataHora && x.data && daysBetween(x.data, t.data) <= 7).length;
  const cobrancasCliente = doCliente.filter((x) => x.cobranca).length;
  const peso = t.totalGastoCliente > 0 ? t.totalCents / t.totalGastoCliente : Infinity;
  const indice = indiceNaoCompra(t);
  const boleto = t.meioPagamento === 'Boleto';
  const semInteracao = !t.formaPagamento;
  let score = 0;
  if (dias > 7) score += 3;
  else if (dias >= 3) score += 2;
  if (t.totalCents >= 20000) score += 3;
  else if (t.totalCents >= 10000) score += 2;
  else if (t.totalCents >= 5000) score += 1;
  if (peso >= 1) score += 3;
  else if (peso >= 0.5) score += 2;
  if (indice >= 0.5) score += 2;
  if (removidas7d >= 3) score += 2;
  if (semInteracao && dias >= 2) score += 1;
  if (boleto) score -= 1;
  if (bloqueado(t)) score += 1;
  if (comprouDepois) score += 2;

  const sinais = [];
  if (cobrancasCliente >= 2) sinais.push('reincidente');
  if (removidas7d >= 3) sinais.push(`${removidas7d} compras removidas nos 7 dias antes`);
  if (peso >= 1) sinais.push('cobrança maior que o histórico de compras');
  if (indice >= 0.5) sinais.push(`${Math.round(indice * 100)}% de sessões sem compra`);
  if (comprouDepois) sinais.push(`voltou à loja ${comprouDepois.tipoEvento === 'compra' ? 'e comprou' : '(carrinho)'} ${Math.round(minutos(t.dataHora, comprouDepois.dataHora))} min depois`);
  if (bloqueado(t)) sinais.push('já bloqueado no app');

  let acao;
  let canal;
  const congelado = boleto && dias <= 4 && !comprouDepois && !bloqueado(t);
  if (comprouDepois) [acao, canal] = ['Abordar na loja (portaria/zelador) e bloquear hoje', 'portaria'];
  else if (bloqueado(t)) [acao, canal] = ['Cobrar por telefone ou pelo condomínio; manter o bloqueio até pagar', 'telefone'];
  else if (dias >= 14) [acao, canal] = ['Escalar ao síndico ou administradora; manter bloqueio', 'síndico'];
  else if (dias >= 7 && ativo(t)) [acao, canal] = ['Bloquear no app hoje e enviar a mensagem D+7', 'app + bloqueio'];
  else if (peso >= 1 || indice >= 0.5) [acao, canal] = ['Risco alto: bloquear já e ligar oferecendo Pix', 'telefone + bloqueio'];
  else if (congelado) [acao, canal] = ['Aguardar a compensação do boleto (até 3 dias úteis)', 'boleto'];
  else if (t.totalCents >= 10000) [acao, canal] = ['Ligar hoje, oferecer Pix e retirar a taxa se pagar hoje', 'telefone'];
  else if (dias >= 3) [acao, canal] = ['Ligar, pedir Pix ou emitir boleto com vencimento curto', 'telefone'];
  else if (dias >= 2 && semInteracao) [acao, canal] = ['Reenviar o link com a mensagem D+1', 'app/WhatsApp'];
  else [acao, canal] = ['Enviar mensagem amigável com o link', 'app/WhatsApp'];

  const agirHoje = Boolean(comprouDepois || bloqueado(t) || (!congelado && ((dias >= 2 && semInteracao) || (dias >= 3 && !boleto) || (dias >= 7 && ativo(t)) || peso >= 1)));
  return { ...t, dias, etapa: etapaRegua(dias), score, sinais, acao, canal, agirHoje, comprouDepois, removidas7d, peso, indice, boleto, semInteracao, bloqueado: bloqueado(t), congelado };
}

/**
 * Painel de cobranças.
 *  - saldo: transações filtradas só por loja (pendentes são uma foto, ignoram o período)
 *  - fluxo: transações do período (pagas e geradas)
 *  - todas: todas as transações (contexto do cliente)
 */
export function cobrancasPanel({ saldo, fluxo, todas, hoje, operadores = new Set(), firstSeen = {}, faturamentoCents = 0, margemPct = null, mediaDiariaCents = 0 }) {
  const pendentes = saldo
    .filter((t) => t.tipoEvento === 'cobranca_pendente')
    .map((t) => avaliarPendente(t, todas, hoje))
    .sort((a, b) => b.score - a.score || b.dias - a.dias || b.totalCents - a.totalCents);
  const pagas = fluxo
    .filter((t) => t.tipoEvento === 'cobranca_paga')
    .map((t) => {
      const doCliente = idValido(t) ? todas.filter((x) => x.clienteId === t.clienteId) : [];
      const depois = doCliente.filter((x) => x.tipoEvento === 'compra' && x.dataHora > t.dataHora);
      const primeira = t.idLinkPagamento ? firstSeen[t.idLinkPagamento] : null;
      return { ...t, continuouComprando: depois.length, diasParaPagar: primeira && t.data ? Math.max(0, daysBetween(primeira, t.data)) : null };
    })
    .sort((a, b) => (b.dataHora ?? '').localeCompare(a.dataHora ?? ''));
  const geradas = fluxo.filter((t) => t.tipoEvento === 'cobranca_pendente');
  const pendentesCents = sum(pendentes, (t) => t.totalCents);
  const pagasCents = sum(pagas, (t) => t.totalCents);
  const geradasCents = sum(geradas, (t) => t.totalCents);
  const vencidas = pendentes.filter((t) => t.dias > 7);
  const agir = pendentes.filter((t) => t.agirHoje);
  const regua = REGUA.map((r) => {
    const items = pendentes.filter((t) => t.etapa.key === r.key);
    return { ...r, value: sum(items, (t) => t.totalCents), count: items.length, soLink: items.filter((t) => !t.boleto).length, boleto: items.filter((t) => t.boleto).length, comTaxa: items.filter((t) => t.taxaCobranca).length, maior: items[0] ? `${items[0].cliente ?? items[0].clienteId} · ${items[0].pdx}` : '' };
  });
  const emitidas = geradas.length + pagas.length;
  const ultimoRegistro = todas.reduce((a, t) => (t.dataHora > a ? t.dataHora : a), '');
  return {
    pendentes: pendentes.length,
    pendentesCents,
    itensPendentes: sum(pendentes, (t) => t.qtdeProdutos),
    maisAntigaDias: pendentes.length ? Math.max(...pendentes.map((t) => t.dias)) : null,
    comTaxa: pendentes.filter((t) => t.taxaCobranca).length,
    comTaxaCents: sum(pendentes.filter((t) => t.taxaCobranca), (t) => t.totalCents),
    comBoleto: pendentes.filter((t) => t.boleto).length,
    vencidas: vencidas.length,
    vencidasCents: sum(vencidas, (t) => t.totalCents),
    aBloquear: vencidas.filter((t) => ativo(t)).length,
    jaBloqueados: pendentes.filter((t) => t.bloqueado).length,
    maisDe30Cents: sum(pendentes.filter((t) => t.dias > 30), (t) => t.totalCents),
    agirHoje: agir.length,
    agirResumo: resumoAcoes(agir),
    pagas: pagas.length,
    pagasCents,
    geradas: geradas.length,
    geradasCents,
    emitidas,
    taxaRecuperacaoQtd: emitidas ? pagas.length / emitidas : null,
    taxaRecuperacaoValor: geradasCents + pagasCents ? pagasCents / (geradasCents + pagasCents) : null,
    meioPagas: aggregate(pagas, (t) => t.meioPagamento ?? '—', (t) => t.totalCents),
    pesoFaturamento: faturamentoCents ? geradasCents / faturamentoCents : null,
    diasDeVenda: mediaDiariaCents ? pendentesCents / mediaDiariaCents : null,
    custoEmRiscoCents: margemPct == null ? null : Math.round(pendentesCents * (1 - margemPct)),
    margemUsada: margemPct,
    reincidentes: [...groupBy(saldo.filter((t) => t.cobranca && idValido(t)), (t) => t.clienteId).values()].filter((l) => l.length >= 2).length,
    regua,
    listaPendentes: pendentes,
    listaPagas: pagas,
    ultimoRegistro,
    exportDias: ultimoRegistro ? daysBetween(ultimoRegistro.slice(0, 10), hoje) : null,
    operadores,
  };
}

function resumoAcoes(agir) {
  const n = (re) => agir.filter((t) => re.test(t.canal)).length;
  const partes = [];
  const bloq = n(/bloqueio|portaria|síndico/);
  const lig = n(/^telefone$/);
  const msg = n(/app\/WhatsApp/);
  if (bloq) partes.push(`bloquear ${bloq}`);
  if (lig) partes.push(`ligar ${lig}`);
  if (msg) partes.push(`reenviar ${msg}`);
  return partes.join(' · ');
}

/** Compatibilidade: versão simples usada nos testes antigos e na visão geral. */
export function cobrancasKpis(transacoes, hoje) {
  const p = cobrancasPanel({ saldo: transacoes, fluxo: transacoes, todas: transacoes, hoje });
  const aging = AGING.map((a) => {
    const items = p.listaPendentes.filter((t) => faixaAging(t.dias) === a.key);
    return { key: a.key, value: sum(items, (t) => t.totalCents), count: items.length };
  });
  return {
    ...p,
    emitidasCents: p.geradasCents + p.pagasCents,
    ticketPendenteCents: p.pendentes ? Math.round(p.pendentesCents / p.pendentes) : 0,
    idadeMediaDias: p.pendentes ? sum(p.listaPendentes, (t) => t.dias) / p.pendentes : 0,
    pendentesBloqueados: p.jaBloqueados,
    aging,
    listaPendentes: [...p.listaPendentes].sort((a, b) => b.dias - a.dias || b.totalCents - a.totalCents),
  };
}

/**
 * Candidatos a cobrança: carrinhos com valor sem compra do mesmo cliente na mesma loja em até
 * 60 minutos, e compras removidas com valor. Lista para conferir câmera, não para contabilizar.
 */
export function candidatosCobranca(periodo, todas, { janelaMin = 60 } = {}) {
  const out = [];
  for (const t of periodo) {
    if (!((t.tipoEvento === 'carrinho' || t.tipoEvento === 'removida') && t.totalCents > 0)) continue;
    const compraDepois = idValido(t)
      ? todas.find((x) => x.tipoEvento === 'compra' && x.clienteId === t.clienteId && x.pdxId === t.pdxId && x.dataHora > t.dataHora && minutos(t.dataHora, x.dataHora) <= janelaMin)
      : null;
    if (t.tipoEvento === 'carrinho' && compraDepois) continue;
    const compraMesmoDia = idValido(t) ? todas.find((x) => x.tipoEvento === 'compra' && x.clienteId === t.clienteId && x.dataHora > t.dataHora && x.data === t.data) : null;
    const nivel = t.totalCents >= 20000 ? 'critical' : t.totalCents >= 5000 ? 'warning' : 'info';
    let acao;
    if (!idValido(t)) acao = 'Sem cadastro: conferir câmera; não dá para cobrar pelo app';
    else if (t.comprasCliente === 0) acao = 'Cliente sem compras na vida: conferir câmera, gerar cobrança e bloquear preventivamente';
    else if (t.comprasCliente >= 30) acao = 'Cliente antigo: ligar antes de cobrar';
    else acao = 'Conferir câmera em até 48 h e gerar a cobrança no painel';
    out.push({ ...t, nivel, acao, compraMesmoDia: compraMesmoDia ? { valorCents: compraMesmoDia.totalCents, minutos: Math.round(minutos(t.dataHora, compraMesmoDia.dataHora)) } : null, indice: indiceNaoCompra(t) });
  }
  const viraramCompra = periodo.filter((t) => t.tipoEvento === 'carrinho' && t.totalCents > 0).length - out.filter((t) => t.tipoEvento === 'carrinho').length;
  return { lista: out.sort((a, b) => b.totalCents - a.totalCents), totalCents: sum(out, (t) => t.totalCents), carrinhosComValor: periodo.filter((t) => t.tipoEvento === 'carrinho' && t.totalCents > 0).length, viraramCompra };
}

/**
 * Carteira de clientes com sinal: cobrança pendente/paga, ≥ 3 removidas em 7 dias na mesma loja,
 * carrinho com valor sem compra, ou status Bloqueado. Sinal: BLOQUEAR / VIGIAR / LIBERAR / OK.
 */
export function carteiraClientes({ saldo, fluxo, todas, hoje, candidatos, operadores = new Set() }) {
  const pendMap = new Map();
  for (const t of saldo.filter((t) => t.tipoEvento === 'cobranca_pendente' && idValido(t))) pendMap.set(t.clienteId, [...(pendMap.get(t.clienteId) ?? []), avaliarPendente(t, todas, hoje)]);
  const pagasMap = groupBy(fluxo.filter((t) => t.tipoEvento === 'cobranca_paga' && idValido(t)), (t) => t.clienteId);
  const candMap = groupBy((candidatos?.lista ?? []).filter((t) => idValido(t) && t.totalCents >= 5000), (t) => t.clienteId);
  const ids = new Set([...pendMap.keys(), ...pagasMap.keys(), ...candMap.keys()]);
  const porCliente = groupBy(fluxo.filter(idValido), (t) => t.clienteId);
  for (const [id, items] of porCliente) {
    if (items.some(bloqueado)) ids.add(id);
    const rem = items.filter((t) => t.tipoEvento === 'removida');
    if (rem.length >= 3 && removidasEm7Dias(rem) >= 3) ids.add(id);
  }
  const rows = [];
  for (const id of ids) {
    const items = todas.filter((t) => t.clienteId === id);
    if (items.length === 0) continue;
    const ref = items.reduce((a, t) => (t.dataHora > a.dataHora ? t : a));
    if (operadores.has((ref.cliente ?? '').trim().toLowerCase())) continue;
    const pend = pendMap.get(id) ?? [];
    const pagas = pagasMap.get(id) ?? [];
    const cand = candMap.get(id) ?? [];
    const rem = items.filter((t) => t.tipoEvento === 'removida');
    const rem7 = removidasEm7Dias(rem);
    const indice = indiceNaoCompra(ref);
    const sessoes = ref.comprasCliente + ref.naoComprasCliente;
    const pesoMaior = pend.length ? Math.max(...pend.map((p) => p.peso)) : 0;
    const comprouDepois = pend.some((p) => p.comprouDepois);
    const todasPagas = pend.length === 0 && pagas.length > 0;
    let sinal;
    let motivo;
    if (pend.some((p) => p.dias > 7 && ativo(p))) [sinal, motivo] = ['BLOQUEAR', 'pendente há mais de 7 dias'];
    else if (pend.length + pagas.length >= 2) [sinal, motivo] = ['BLOQUEAR', 'reincidente'];
    else if (pesoMaior >= 1) [sinal, motivo] = ['BLOQUEAR', 'cobrança maior que o histórico'];
    else if (pend.length && indice >= 0.5) [sinal, motivo] = ['BLOQUEAR', `${Math.round(indice * 100)}% de sessões sem compra`];
    else if (pend.length && comprouDepois) [sinal, motivo] = ['BLOQUEAR', 'voltou à loja com pendência'];
    else if (bloqueado(ref) && todasPagas) [sinal, motivo] = ['LIBERAR', 'bloqueado com tudo pago'];
    else if (pend.length && bloqueado(ref)) [sinal, motivo] = ['BLOQUEAR', 'já bloqueado, pendência aberta'];
    else if (pend.length) [sinal, motivo] = ['VIGIAR', 'cobrança em aberto'];
    else if (rem7 >= 3) [sinal, motivo] = ['VIGIAR', `${rem7} compras removidas em 7 dias`];
    else if (cand.length) [sinal, motivo] = ['VIGIAR', 'carrinho com valor sem compra'];
    else if (indice >= 0.3 && sessoes >= 10) [sinal, motivo] = ['VIGIAR', `${Math.round(indice * 100)}% de sessões sem compra`];
    else if (bloqueado(ref)) [sinal, motivo] = ['VIGIAR', 'bloqueado sem cobrança registrada'];
    else [sinal, motivo] = ['OK', pagas.length ? 'pagou a cobrança' : ''];
    rows.push({
      key: id,
      nome: ref.cliente ?? id,
      status: ref.statusCliente,
      lojas: [...new Set([...pend, ...pagas, ...cand].map((t) => t.pdx))].join(', ') || ref.pdx,
      sinal,
      motivo,
      pendentes: pend.length,
      pendentesCents: sum(pend, (t) => t.totalCents),
      pagas: pagas.length,
      pagasCents: sum(pagas, (t) => t.totalCents),
      historicoCents: ref.totalGastoCliente,
      comprasHistorico: ref.comprasCliente,
      naoCompras: ref.naoComprasCliente,
      indice,
      removidas7d: rem7,
      removidasPeriodo: rem.length,
      candidatosCents: sum(cand, (t) => t.totalCents),
      peso: pesoMaior,
      ultimo: ref.dataHora,
      comprouDepois,
      acao: pend[0]?.acao ?? (sinal === 'LIBERAR' ? 'Liberar no painel' : sinal === 'VIGIAR' ? 'Conferir câmera nos horários dos eventos' : ''),
      eventos: [...items].sort((a, b) => (a.dataHora ?? '').localeCompare(b.dataHora ?? '')),
    });
  }
  const ordem = { BLOQUEAR: 0, VIGIAR: 1, LIBERAR: 2, OK: 3 };
  return rows.sort((a, b) => ordem[a.sinal] - ordem[b.sinal] || b.pendentesCents - a.pendentesCents || b.candidatosCents - a.candidatosCents);
}

function removidasEm7Dias(rem) {
  const datas = rem.map((t) => t.data).filter(Boolean).sort();
  let best = 0;
  for (let i = 0; i < datas.length; i++) {
    let j = i;
    while (j < datas.length && daysBetween(datas[i], datas[j]) <= 7) j++;
    best = Math.max(best, j - i);
  }
  return best;
}

/** Por loja: saldo, vencido, recuperado, peso, candidatos, removidas e cobertura da perda de inventário. */
export function cobrancasPorLoja({ saldo, fluxo, todas, hoje, candidatos, estoquePorLoja = [] }) {
  const lojas = [...new Set([...saldo, ...fluxo].map((t) => t.pdx))].sort();
  const rows = [];
  for (const pdx of lojas) {
    const pend = saldo.filter((t) => t.tipoEvento === 'cobranca_pendente' && t.pdx === pdx).map((t) => avaliarPendente(t, todas, hoje));
    const pagas = fluxo.filter((t) => t.tipoEvento === 'cobranca_paga' && t.pdx === pdx);
    const geradas = fluxo.filter((t) => t.tipoEvento === 'cobranca_pendente' && t.pdx === pdx);
    const compras = fluxo.filter((t) => t.compra && t.pdx === pdx);
    const fat = sum(compras, (t) => t.totalCents);
    const dias = new Set(compras.map((t) => t.data)).size;
    const media = dias ? fat / dias : 0;
    const cand = (candidatos?.lista ?? []).filter((t) => t.pdx === pdx);
    const rem = fluxo.filter((t) => t.tipoEvento === 'removida' && t.pdx === pdx);
    const pendCents = sum(pend, (t) => t.totalCents);
    const pagasCents = sum(pagas, (t) => t.totalCents);
    const geradasCents = sum(geradas, (t) => t.totalCents);
    const inv = estoquePorLoja.find((l) => l.pdx === pdx);
    const perdaVenda = inv ? inv.kpis.perdaVendaCents : null;
    if (pend.length + pagas.length + cand.length === 0 && !inv) continue;
    rows.push({
      key: pdx,
      value: pendCents,
      count: pend.length,
      pendentes: pend.length,
      pendentesCents: pendCents,
      vencidasCents: sum(pend.filter((t) => t.dias > 7), (t) => t.totalCents),
      pagas: pagas.length,
      pagasCents,
      pctFaturamento: fat ? geradasCents / fat : null,
      diasDeVenda: media ? pendCents / media : null,
      candidatos: cand.length,
      candidatosCents: sum(cand, (t) => t.totalCents),
      removidas: rem.length,
      removidasPos: rem.filter((t) => t.via === 'POS').length,
      perdaVendaCents: perdaVenda,
      cobertura: perdaVenda != null && perdaVenda + pendCents + pagasCents > 0 ? (pendCents + pagasCents) / (perdaVenda + pendCents + pagasCents) : null,
      alerta: (fat && geradasCents / fat >= 0.03) || (perdaVenda != null && perdaVenda > 0 && (pendCents + pagasCents) / (perdaVenda + pendCents + pagasCents) < 0.2),
    });
  }
  return rows.sort((a, b) => b.pendentesCents - a.pendentesCents || b.pagasCents - a.pagasCents || b.candidatosCents - a.candidatosCents);
}

/** Geradas × pagas por semana, com saldo líquido e acumulado em aberto. */
export function cobrancasPorSemana(transacoes) {
  const cob = transacoes.filter((t) => t.cobranca && t.data);
  const semanas = [...new Set(cob.map((t) => isoWeek(t.data)))].sort();
  let acumulado = 0;
  return semanas.map((w) => {
    const items = cob.filter((t) => isoWeek(t.data) === w);
    const pend = items.filter((t) => t.tipoEvento === 'cobranca_pendente');
    const pagas = items.filter((t) => t.tipoEvento === 'cobranca_paga');
    const pendentesCents = sum(pend, (t) => t.totalCents);
    const pagasCents = sum(pagas, (t) => t.totalCents);
    acumulado += pendentesCents;
    return { key: w, pendentes: pend.length, pendentesCents, pagas: pagas.length, pagasCents, saldoCents: pendentesCents - pagasCents, acumuladoCents: acumulado, value: pendentesCents + pagasCents, count: items.length };
  });
}

/** Compatibilidade com a versão anterior (lista simples de clientes em cobrança). */
export function clientesEmCobranca(transacoes) {
  const cob = transacoes.filter((t) => t.cobranca);
  const rows = [];
  for (const [id, items] of groupBy(cob, (t) => t.clienteId ?? t.cliente)) {
    const pend = items.filter((t) => t.tipoEvento === 'cobranca_pendente');
    const pagas = items.filter((t) => t.tipoEvento === 'cobranca_paga');
    const ultimo = items.map((t) => t.dataHora).sort().pop();
    const ref = items.find((t) => t.dataHora === ultimo);
    rows.push({
      key: id,
      nome: ref.cliente ?? id,
      status: ref.statusCliente,
      lojas: [...new Set(items.map((t) => t.pdx))].join(', '),
      pendentes: pend.length,
      pendentesCents: sum(pend, (t) => t.totalCents),
      pagas: pagas.length,
      pagasCents: sum(pagas, (t) => t.totalCents),
      historicoCents: Math.max(...items.map((t) => t.totalGastoCliente)),
      comprasHistorico: Math.max(...items.map((t) => t.comprasCliente)),
      ultima: ultimo,
      risco: pend.length >= 2 || (pend.length > 0 && bloqueado(ref)) ? 'alto' : pend.length > 0 ? 'medio' : 'baixo',
    });
  }
  return rows.sort((a, b) => b.pendentesCents - a.pendentesCents || b.pagasCents - a.pagasCents);
}

/** Mensagens prontas por etapa da régua, com os dados da cobrança. */
export function mensagemCobranca(etapa, t) {
  const nome = (t.cliente ?? 'cliente').split(' ')[0];
  const valor = fmtMoney(t.totalCents);
  const data = t.data ? `${t.data.slice(8, 10)}/${t.data.slice(5, 7)}` : '';
  const link = t.linkPagamento ?? '(link de pagamento no painel)';
  if (etapa === 'D+1')
    return `Oi, ${nome}! Aqui é da ${t.pdx}. Ficou pendente o pagamento de ${t.qtdeProdutos} ${t.qtdeProdutos === 1 ? 'item' : 'itens'} (${valor}) do dia ${data}. Dá para pagar pelo link: ${link}. Qualquer dúvida, é só responder. Obrigado!`;
  if (etapa === 'D+3')
    return `${nome}, o pagamento de ${valor} (${t.pdx}, ${data}) continua em aberto. Pedimos a quitação em até 48 horas. Se preferir, pode pagar por Pix sem a taxa de cobrança: responda esta mensagem que enviamos a chave. Link: ${link}`;
  return `${nome}, como o pagamento de ${valor} (${t.pdx}, ${data}) não foi feito, o acesso ao app foi bloqueado. Para reativar, basta pagar pelo link ${link} ou por Pix e nos avisar. Estamos à disposição.`;
}

/** Recomendações de cobrança (anexadas às demais). */
export function recomendacoesCobranca({ panel, candidatos, porLoja }) {
  const out = [];
  if (!panel) return out;
  const p = panel;
  for (const t of p.listaPendentes) {
    const nome = t.cliente ?? t.clienteId ?? 'cliente';
    if (t.comprouDepois) out.push({ tone: 'critical', titulo: `${nome} voltou à loja com cobrança em aberto`, valorCents: t.totalCents, detalhe: `${t.pdx} · cobrança de ${t.dias} dias · ${t.sinais.join(' · ')}.`, acao: 'Abordar na loja (portaria/zelador) e bloquear no app hoje.' });
    else if (t.dias > 7 && ativo(t)) out.push({ tone: 'critical', titulo: `Bloquear ${nome}: cobrança há ${t.dias} dias sem pagar`, valorCents: t.totalCents, detalhe: `${t.pdx} · ${t.semInteracao ? 'nunca abriu o link' : t.boleto ? 'boleto gerado' : 'link enviado'}${t.sinais.length ? ` · ${t.sinais.join(' · ')}` : ''}.`, acao: t.dias >= 14 ? 'Bloquear no app, enviar a mensagem D+7 e escalar ao síndico.' : 'Bloquear no app e enviar a mensagem D+7; se não pagar em 7 dias, síndico.' });
    else if (t.bloqueado) out.push({ tone: 'warning', titulo: `${nome} está bloqueado e ainda deve`, valorCents: t.totalCents, detalhe: `${t.pdx} · o link pelo app não chega a quem está bloqueado${t.boleto ? ' · boleto gerado' : ''}.`, acao: 'Telefone ou WhatsApp pessoal e contato do condomínio; liberar só depois de pagar.' });
    else if (t.peso >= 1) out.push({ tone: 'critical', titulo: `${nome}: cobrança maior que tudo o que já comprou`, valorCents: t.totalCents, detalhe: `${t.pdx} · histórico de ${fmtMoney(t.totalGastoCliente)} em ${t.comprasCliente} compras.`, acao: 'Risco alto de cliente novo: bloquear já e ligar; síndico em 7 dias em vez de 14.' });
    else if (t.totalCents >= 10000) out.push({ tone: 'warning', titulo: `Ligar para ${nome} hoje: cobrança de ${fmtMoney(t.totalCents)}`, valorCents: t.totalCents, detalhe: `${t.pdx} · ${t.dias} dia${t.dias === 1 ? '' : 's'} em aberto · ${t.boleto ? 'boleto gerado' : t.semInteracao ? 'sem interação com o link' : 'link enviado'}${t.taxaCobranca ? ' · com taxa' : ''}.`, acao: 'Não depender do link: oferecer Pix e retirar a taxa se pagar hoje; bloquear se não pagar até a data combinada.' });
    else if (t.dias >= 2 && t.semInteracao) out.push({ tone: 'info', titulo: `Reenviar o link para ${nome}`, valorCents: t.totalCents, detalhe: `${t.pdx} · ${t.dias} dias sem interação.`, acao: 'Mensagem D+1 pelo app ou WhatsApp.' });
  }
  if (candidatos && candidatos.lista.length) {
    const top = candidatos.lista[0];
    const grandes = candidatos.lista.filter((t) => t.totalCents >= 5000);
    if (grandes.length) out.push({ tone: top.totalCents >= 20000 ? 'critical' : 'warning', titulo: `${grandes.length} carrinho${grandes.length > 1 ? 's' : ''} com valor sem compra para conferir na câmera`, valorCents: sum(grandes, (t) => t.totalCents), detalhe: `Maior: ${fmtMoney(top.totalCents)} em ${top.pdx} (${top.cliente ?? 'sem cadastro'}, ${top.comprasCliente} compras na vida).`, acao: 'Conferir a gravação em até 48 h e gerar a cobrança no painel ou descartar; ligar antes se o cliente é antigo.' });
    const semGeradas = p.geradas === 0 && grandes.some((t) => t.totalCents >= 10000);
    if (semGeradas) out.push({ tone: 'info', titulo: 'Nenhuma cobrança gerada no período, mas há candidatos acima de R$ 100', detalhe: 'A revisão de câmeras pode ter parado.', acao: 'Fixar um horário diário para revisar e limpar a fila de candidatos.' });
  }
  for (const l of porLoja ?? []) {
    if (l.pctFaturamento != null && l.pctFaturamento >= 0.03) out.push({ tone: 'warning', titulo: `${l.key}: cobranças somam ${Math.round(l.pctFaturamento * 1000) / 10}% do faturamento`, valorCents: l.pendentesCents, detalhe: `${l.removidas} compras removidas (${l.removidasPos} no POS) · ${l.candidatos} candidatos a cobrança.`, acao: 'Câmeras, portaria, fechamento de geladeira/gôndola e conversa com o síndico.' });
    if (l.cobertura != null && l.cobertura < 0.2 && l.perdaVendaCents > 0) out.push({ tone: 'warning', titulo: `${l.key}: ${Math.round((1 - l.cobertura) * 100)}% da perda de inventário sem cobrança`, valorCents: l.perdaVendaCents, detalhe: `Perda a preço de venda ${fmtMoney(l.perdaVendaCents)} contra ${fmtMoney(l.pendentesCents + l.pagasCents)} em cobranças.`, acao: 'Furto sem rosto: auditar câmeras nos horários de pico e encurtar o intervalo entre inventários.' });
  }
  for (const t of p.listaPagas) if (!t.nfce) out.push({ tone: 'warning', titulo: `Cobrança paga sem NFC-e (${t.cliente ?? t.clienteId})`, valorCents: t.totalCents, detalhe: `${t.pdx} · paga em ${t.data}.`, acao: 'Emitir a nota no painel.' });
  if (p.maisDe30Cents > 0) out.push({ tone: 'info', titulo: 'Cobranças com mais de 30 dias: perda provável', valorCents: p.maisDe30Cents, detalhe: 'Dificilmente serão pagas pelo link.', acao: 'Registrar como baixa, manter o bloqueio e avaliar negativação acima de R$ 100.' });
  if (p.emitidas >= 10 && p.taxaRecuperacaoQtd != null && p.taxaRecuperacaoQtd < 0.5) out.push({ tone: 'warning', titulo: `Recuperação de ${Math.round(p.taxaRecuperacaoQtd * 100)}% das cobranças emitidas`, detalhe: `${p.pagas} de ${p.emitidas} pagas.`, acao: 'Revisar a régua: ligação em D+2, Pix em vez de boleto no link, cartão cadastrado no app.' });
  return out;
}

