// Estado, importação dos relatórios e renderização do dashboard (por abas).
import { loadReport, mergeRecords, REPORT_TYPES, SITUACOES, EVENTOS, classifyEvento } from './reports.js';
import * as M from './metrics.js';
import { hbar, columns, stacked, legend, table, heatmap, emptyChart } from './charts.js';
import { money, moneyShort, number, percent, shortDate, longDate, dateTime, weekday, hourLabel, days, escapeHtml as esc } from './format.js';
import { todayLocal, addDays } from './parse.js';

const STORAGE_KEY = 'enrico-market4u:v1';
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];
const PRESETS = [
  { id: 'hoje', label: 'Hoje', days: 0 },
  { id: '7d', label: '7 dias', days: 6 },
  { id: '30d', label: '30 dias', days: 29 },
  { id: 'tudo', label: 'Tudo', days: null },
  { id: 'custom', label: 'Personalizado', days: undefined },
];
const EMPTY = () => ({ transacoes: [], produtos: [], boletos: [], retornos: [], inventario: [] });

const TABS = [
  { id: 'visao', label: 'Visão geral' },
  { id: 'financeiro', label: 'Financeiro' },
  { id: 'cobrancas', label: 'Cobranças' },
  { id: 'operacao', label: 'Operação' },
  { id: 'vendas', label: 'Vendas' },
  { id: 'produtos', label: 'Produtos' },
  { id: 'lojas', label: 'Lojas' },
  { id: 'clientes', label: 'Clientes' },
  { id: 'dados', label: 'Dados' },
];

const state = {
  data: EMPTY(),
  sources: EMPTY(),
  sample: false,
  filter: { preset: 'tudo', from: null, to: null, pdxId: '' },
  tab: 'visao',
  hoje: todayLocal(),
  notice: null,
  firstSeen: {}, // ID link de pagamento → primeira data em que apareceu pendente
  feito: {}, // ID link → data em que o dono marcou a cobrança como tratada hoje
  verificado: {}, // ID da transação candidata → true
  limites: { transacoes: null, reposicao: 10, candidatos: 15, carteira: 12 },
};

// --- persistência --------------------------------------------------------------
function save() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ data: state.data, sources: state.sources, sample: state.sample, filter: state.filter, tab: state.tab, firstSeen: state.firstSeen, feito: state.feito, verificado: state.verificado }),
    );
  } catch {
    /* armazenamento indisponível: segue só em memória */
  }
}
function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved?.data) return false;
    state.data = { ...EMPTY(), ...saved.data };
    state.sources = { ...EMPTY(), ...(saved.sources ?? {}) };
    state.sample = Boolean(saved.sample);
    state.filter = { ...state.filter, ...(saved.filter ?? {}) };
    state.firstSeen = saved.firstSeen ?? {};
    state.feito = saved.feito ?? {};
    state.verificado = saved.verificado ?? {};
    if (saved.tab && TABS.some((t) => t.id === saved.tab)) state.tab = saved.tab;
    // dados guardados por uma versão anterior: reclassifica o evento com a regra atual
    for (const t of state.data.transacoes) {
      const tipoEvento = classifyEvento(t.evento);
      Object.assign(t, { tipoEvento, compra: tipoEvento === 'compra', cobranca: tipoEvento === 'cobranca_pendente' || tipoEvento === 'cobranca_paga' });
    }
    return hasData();
  } catch {
    return false;
  }
}
const hasData = () => Object.values(state.data).some((l) => l.length > 0);

// --- importação ------------------------------------------------------------------
export function ingest(name, bytesOrText) {
  const { type, records } = loadReport(bytesOrText);
  if (state.sample) {
    state.data = EMPTY();
    state.sources = EMPTY();
    state.sample = false;
    state.firstSeen = {};
    state.feito = {};
    state.verificado = {};
  }
  if (type === 'transacoes') {
    for (const t of records) if (t.tipoEvento === 'cobranca_pendente' && t.idLinkPagamento && t.data && !state.firstSeen[t.idLinkPagamento]) state.firstSeen[t.idLinkPagamento] = t.data;
  }
  state.data[type] = mergeRecords(type, state.data[type], records);
  state.sources[type].push({ name, rows: records.length, at: new Date().toISOString() });
  return { type, rows: records.length };
}

async function ingestFiles(files) {
  const ok = [];
  const errors = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      ok.push({ name: file.name, ...ingest(file.name, bytes) });
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }
  if (ok.length) {
    state.filter.preset = 'tudo';
    state.tab = 'visao';
  }
  state.notice = errors.length
    ? { tone: 'error', text: `Não consegui ler ${errors.length === 1 ? 'um arquivo' : `${errors.length} arquivos`}. ${errors.join(' · ')}` }
    : ok.length
      ? { tone: 'ok', text: `Importado: ${ok.map((o) => `${REPORT_TYPES[o.type].label} (${o.rows} linhas)`).join(', ')}.` }
      : null;
  save();
  render();
}

async function loadSample() {
  const base = window.EM4U_SAMPLE;
  if (!base) return false;
  for (const [type, text] of Object.entries(base)) {
    const { records } = loadReport(text);
    state.data[type] = records;
    state.sources[type] = [{ name: `exemplo-${type}.csv`, rows: records.length, at: new Date().toISOString() }];
    if (type === 'transacoes') for (const t of records) if (t.tipoEvento === 'cobranca_pendente' && t.idLinkPagamento && t.data) state.firstSeen[t.idLinkPagamento] ??= t.data;
  }
  state.sample = true;
  return true;
}

// --- filtros ---------------------------------------------------------------------
function currentRange() {
  const { preset, from, to } = state.filter;
  const p = PRESETS.find((x) => x.id === preset) ?? PRESETS[3];
  if (p.id === 'custom') return { from: from || null, to: to || null };
  if (p.days == null) return { from: null, to: null };
  return { from: addDays(state.hoje, -p.days), to: state.hoje };
}

function filtered() {
  const range = currentRange();
  const pdxId = state.filter.pdxId || null;
  const pdxNome = pdxId ? M.listPdx(state.data.transacoes, state.data.produtos).find((l) => l.id === pdxId)?.nome : null;
  return {
    range,
    pdxId,
    pdxNome,
    transacoes: M.filterTransacoes(state.data.transacoes, { ...range, pdxId }),
    transacoesLoja: M.filterTransacoes(state.data.transacoes, { pdxId }), // sem período: saldos (cobranças pendentes)
    produtos: M.filterProdutos(state.data.produtos, { ...range, pdxId }),
    boletos: M.filterBoletos(state.data.boletos, range),
    retornos: M.filterRetornos(state.data.retornos, { ...range, pdxId }),
    // posição de estoque é uma foto: usa o último inventário de cada loja, sem filtro de período
    inventario: M.filterInventario(state.data.inventario, { pdxId, pdxNome }, M.mapaCodigoPdx(state.data.produtos)),
  };
}

const filtroAtivo = () => state.filter.preset !== 'tudo' || Boolean(state.filter.pdxId);

function scopeLabel(range) {
  if (!filtroAtivo()) return '';
  const loja = state.filter.pdxId ? M.listPdx(state.data.transacoes, state.data.produtos).find((l) => l.id === state.filter.pdxId)?.nome : null;
  const p = PRESETS.find((x) => x.id === state.filter.preset);
  const periodo = p?.id === 'custom' ? `${range.from ? longDate(range.from) : '…'} a ${range.to ? longDate(range.to) : '…'}` : p?.id === 'tudo' ? '' : p?.label.toLowerCase();
  return [periodo, loja].filter(Boolean).join(' · ');
}

function storeColors() {
  const lojas = M.listPdx(state.data.transacoes, state.data.produtos);
  for (const r of [...state.data.retornos, ...state.data.inventario]) if (!lojas.some((l) => l.nome === r.pdx)) lojas.push({ id: r.pdxId ?? r.codigoPdx, nome: r.pdx });
  lojas.sort((a, b) => a.nome.localeCompare(b.nome));
  const map = new Map();
  lojas.forEach((l, i) => map.set(l.nome, SERIES[Math.min(i, SERIES.length - 1)]));
  return (row) => map.get(row.key) ?? 'var(--series-1)';
}

// --- componentes -----------------------------------------------------------------
const innerW = () => (typeof window !== 'undefined' ? window.innerWidth : 1280);
/** Largura real (px) dos gráficos: um cartão da grade de 2 colunas, ou a tela toda no celular. */
const chartWidth = () => (innerW() <= 560 ? Math.max(300, innerW() - 64) : 560);
const wideChartWidth = () => (innerW() > 760 ? 1120 : chartWidth());
const isMobile = () => innerW() <= 560;

const tile = (label, value, detail = '', tone = '', extra = '') =>
  `<div class="tile ${tone}"${extra ? ` title="${esc(extra)}"` : ''}><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${detail ? `<div class="detail">${detail}</div>` : ''}</div>`;

const TONE_ORDER = { critical: 0, warning: 1, '': 2, good: 3 };
/** Tiles ordenados por urgência (crítico → alerta → neutro → ok). Cada item: { label, value, detail, tone, extra }. */
function tiles(list, limit = 8) {
  return `<div class="tiles">${list
    .filter(Boolean)
    .sort((a, b) => TONE_ORDER[a.tone ?? ''] - TONE_ORDER[b.tone ?? ''])
    .slice(0, limit)
    .map((t) => tile(t.label, t.value, t.detail, t.tone ?? '', t.extra))
    .join('')}</div>`;
}

let cardSeq = 0;
/** Cartão com alternância de vistas. `views`: [{ label, html }], a primeira é a padrão; ou `chart` + `tableHtml`. */
function card({ title, desc, chart, tableHtml, legendHtml = '', span = false, views, titleHint }) {
  const id = `card-${++cardSeq}`;
  const vs = views ?? [{ label: 'Gráfico', html: chart + legendHtml }, { label: 'Tabela', html: tableHtml }];
  return `<div class="card ${span ? 'span-2' : ''}" data-card="${id}">
    <div class="card-head"><h3${titleHint ? ` title="${esc(titleHint)}"` : ''}>${esc(title)}</h3>${desc ? `<span class="desc">${esc(desc)}</span>` : ''}
      ${vs.length > 1 ? `<div class="seg toggle" role="group" aria-label="Visualização">${vs.map((v, i) => `<button type="button" data-view="${i}" aria-pressed="${i === 0}">${esc(v.label)}</button>`).join('')}</div>` : ''}</div>
    ${vs.map((v, i) => `<div data-view-panel="${i}" ${i === 0 ? '' : 'hidden'}>${v.html}</div>`).join('')}
  </div>`;
}

const pill = (situacao) => `<span class="pill ${SITUACOES[situacao].tone}">${SITUACOES[situacao].label}</span>`;
const money0 = (c, axis) => (axis ? moneyShort(c) : money(c));
const colsValor = (keyLabel) => [
  { label: keyLabel, get: (r) => r.key },
  { label: 'Valor', num: true, get: (r) => money(r.value) },
  { label: 'Qtd.', num: true, get: (r) => number(r.count) },
];
const statusPill = (st) => `<span class="pill ${/bloquead/i.test(st ?? '') ? 'critical' : /desativ/i.test(st ?? '') ? '' : 'good'}">${esc(st ?? '—')}</span>`;
const emptyTab = (texto) => `<section><p class="empty">${texto}</p></section>`;
const moreButton = (key, restantes, passo) => (restantes > 0 ? `<p style="margin:8px 0 0"><button type="button" class="btn btn-small" data-more="${key}" data-step="${passo}">Mostrar mais ${Math.min(passo, restantes)} (${restantes} restantes)</button></p>` : '');

function delta(atual, anterior, { invert = false, fmt = percent } = {}) {
  const d = M.variacao(atual, anterior);
  if (d == null) return '';
  const good = invert ? d < 0 : d > 0;
  const sign = d > 0 ? '+' : '';
  return `<div class="delta-row"><span class="delta ${d === 0 ? '' : good ? 'up' : 'down'}">${sign}${esc(percent(d))}</span> vs ${esc(fmt(anterior))} no período anterior</div>`;
}

// --- Dados (importação) ----------------------------------------------------------
function sectionImport() {
  const chips = Object.entries(REPORT_TYPES)
    .map(([type, { label }]) => {
      const srcs = state.sources[type];
      const rows = state.data[type].length;
      const bounds = M.dateBounds(state.data[type]);
      const meta = rows ? `${number(rows)} linhas · ${shortDate(bounds.min)}–${shortDate(bounds.max)}${srcs.length ? ` · ${esc(srcs[srcs.length - 1].name)}` : ''}` : 'não carregado';
      return `<span class="source ${rows ? 'loaded' : ''}"><span class="dot"></span><b>${esc(label)}</b><span class="meta">${meta}</span></span>`;
    })
    .join('');
  const notice = state.notice ? `<p class="notice ${state.notice.tone === 'error' ? 'error' : 'info'}"><span class="stripe"></span><span>${esc(state.notice.text)}</span></p>` : '';
  const sample = state.sample ? `<p class="notice"><span class="stripe"></span><span>Mostrando <b>dados de exemplo</b> (1 a 19 de outubro, nomes anonimizados). Importe seus relatórios para substituir.</span></p>` : '';
  const guia = `<div class="card"><div class="card-head"><h3>Como exportar do painel Market4u</h3></div><ol class="guide">
    <li><b>Transações</b> — Clientes › Transações › exportar CSV. Alimenta Vendas, Cobranças, Lojas, Clientes e a média diária do caixa.</li>
    <li><b>Produtos vendidos</b> — Relatórios › Produtos vendidos. Alimenta Produtos (margem) e cruza com o inventário.</li>
    <li><b>Boletos de reabastecimento</b> — Vendas de mercadorias do CD › Boletos. Alimenta Financeiro.</li>
    <li><b>Inventário</b> — Sistema PDV › Inventário. Posição de estoque, perdas e rupturas por loja.</li>
    <li><b>Remessas de retorno</b> — Sistema PDV › Retorno PDV. Produtos vencidos e avariados devolvidos ao CD.</li>
  </ol><p class="kicker">Exporte sempre o maior período possível: com 30 dias de transações a média diária, a tendência e a comparação com o período anterior ficam confiáveis. Reimportar o mesmo período não duplica registros.</p></div>`;
  return `<section>
    <div class="dropzone" id="dropzone">
      <p><b>Arraste os CSV exportados do painel Market4u</b> ou <label class="btn" for="file-input" style="cursor:pointer">escolher arquivos</label>
      <input id="file-input" type="file" accept=".csv,text/csv" multiple class="sr-only"></p>
      <span class="hint">O tipo de relatório é reconhecido pelo cabeçalho.</span>
      <div class="sources">${chips}</div>
      ${hasData() ? `<button type="button" class="btn btn-ghost" id="clear-data">Limpar dados</button>` : ''}
    </div>${sample}${notice}${guia}
  </section>`;
}

// --- contexto comum (calculado uma vez por render) --------------------------------
function contexto(f) {
  const temT = state.data.transacoes.length > 0;
  const temP = state.data.produtos.length > 0;
  const temB = state.data.boletos.length > 0;
  const vendas = temT ? M.vendasKpis(f.transacoes) : null;
  const produtos = temP ? M.produtosKpis(f.produtos) : null;
  const boletos = temB ? M.boletosKpis(state.data.boletos, state.hoje) : null; // caixa olha todos os boletos abertos
  const boletosPeriodo = temB ? M.boletosKpis(f.boletos, state.hoje) : null;
  const lojas = temT ? M.comparativoLojas(f.transacoes, f.produtos) : [];
  const media = temT ? M.mediaDiaria(f.transacoes) : 0;
  const diasComDados = temT ? new Set(f.transacoes.filter((t) => t.compra).map((t) => t.data)).size : 0;
  const caixa = boletos ? M.fluxoCaixa(boletos.comSituacao, media, state.hoje, 14) : null;
  const revisar = M.produtosParaRevisar(f.produtos, 0.3);
  const estoqueLojas = M.ultimoInventarioPorLoja(f.inventario).map((l) => ({ ...l, kpis: M.estoqueKpis(l.itens) }));
  const operadores = M.nomesOperadores(state.data.inventario, state.data.retornos);
  const candidatos = temT ? M.candidatosCobranca(f.transacoes, state.data.transacoes) : null;
  const panel = temT
    ? M.cobrancasPanel({ saldo: f.transacoesLoja, fluxo: f.transacoes, todas: state.data.transacoes, hoje: state.hoje, operadores, firstSeen: state.firstSeen, faturamentoCents: vendas.faturamentoCents, margemPct: produtos?.receitaCents ? produtos.margemPct : null, mediaDiariaCents: media })
    : null;
  if (panel) {
    panel.listaPendentes = panel.listaPendentes.map((t) => ({ ...t, feito: Boolean(t.idLinkPagamento && state.feito[t.idLinkPagamento] === state.hoje) }));
    panel.agirHoje = panel.listaPendentes.filter((t) => t.agirHoje && !t.feito).length;
  }
  const cobrancasLoja = temT ? M.cobrancasPorLoja({ saldo: f.transacoesLoja, fluxo: f.transacoes, todas: state.data.transacoes, hoje: state.hoje, candidatos, estoquePorLoja: estoqueLojas }) : [];
  return { temT, temP, temB, vendas, produtos, boletos, boletosPeriodo, lojas, media, diasComDados, caixa, revisar, estoqueLojas, operadores, candidatos, panel, cobrancasLoja };
}

function prioridades(f, c) {
  const recs = M.recomendacoes({
    vendas: c.vendas,
    lojas: c.lojas,
    boletos: c.boletos,
    caixa: c.caixa,
    revisar: c.revisar,
    fiscal: c.vendas ? { semNfce: c.vendas.compras - c.vendas.nfceEmitidas } : null,
    abandonosCategoria: c.temT ? M.abandonosPorCategoria(f.transacoes) : [],
    cobrancas: c.panel,
    diasComDados: c.diasComDados,
  })
    .concat(M.recomendacoesOperacao({ estoquePorLoja: c.estoqueLojas, retornos: f.retornos.length ? M.retornosKpis(f.retornos) : null, retornosTop: M.retornosTopProdutos(f.retornos, 1) }))
    .concat(M.recomendacoesCobranca({ panel: c.panel, candidatos: c.candidatos, porLoja: c.cobrancasLoja }).filter((r) => /inventário sem cobrança|carrinhos com valor/.test(r.titulo)));
  const ordem = { critical: 0, warning: 1, info: 2, good: 3 };
  recs.sort((a, b) => ordem[a.tone] - ordem[b.tone] || (b.valorCents ?? 0) - (a.valorCents ?? 0));
  if (recs.length > 1) {
    const i = recs.findIndex((r) => r.tone === 'good');
    if (i >= 0) recs.splice(i, 1);
  }
  return recs;
}

function actionsList(recs, { groups = true } = {}) {
  if (!recs.length) return `<p class="empty">Nada a recomendar com os dados carregados.</p>`;
  const nomes = { critical: 'Hoje', warning: 'Esta semana', info: 'Para olhar', good: 'Em dia' };
  let last = null;
  let html = '<ul class="actions">';
  for (const r of recs) {
    if (groups && r.tone !== last) {
      html += `<li class="group">${nomes[r.tone]}</li>`;
      last = r.tone;
    }
    html += `<li class="action ${r.tone}"><span class="stripe"></span><div><div class="title-row"><span class="title">${esc(r.titulo)}</span>${r.valorCents != null ? `<span class="amount">${esc(money(r.valorCents))}</span>` : ''}</div><div class="detail">${esc(r.detalhe)}</div><div class="todo">${esc(r.acao)}</div></div></li>`;
  }
  return `${html}</ul>`;
}

// --- Visão geral -----------------------------------------------------------------
function sectionOverview(f, c) {
  const { vendas: v, produtos: p, boletos: b } = c;
  const ant = M.periodoAnterior(f.range);
  const pdxId = state.filter.pdxId || null;
  const vAnt = ant && c.temT ? M.vendasKpis(M.filterTransacoes(state.data.transacoes, { ...ant, pdxId })) : null;
  const pAnt = ant && c.temP ? M.produtosKpis(M.filterProdutos(state.data.produtos, { ...ant, pdxId })) : null;
  const list = [];
  if (v) {
    list.push({ label: 'Faturamento', value: money(v.faturamentoCents), detail: `${number(v.compras)} compras · ticket ${money(v.ticketMedioCents)} · ${number(v.clientesUnicos)} clientes${vAnt ? delta(v.faturamentoCents, vAnt.faturamentoCents, { fmt: money }) : ''}`, extra: `${number(v.clientesNovos)} clientes na primeira compra${v.recuperadoCents ? ` · ${money(v.recuperadoCents)} recuperados em cobranças` : ''}` });
    list.push({ label: 'Conversão de sessões', value: percent(v.taxaConversao), detail: `${number(v.carrinhosAbandonados)} carrinhos abandonados (${money(v.valorCarrinhosCents)})${vAnt ? delta(v.taxaConversao, vAnt.taxaConversao) : ''}`, tone: v.taxaConversao < 0.6 ? 'warning' : '', extra: `${number(v.comprasRemovidas)} compras removidas · compras ÷ (compras + carrinhos + removidas)` });
    const cob = c.panel;
    list.push({ label: 'Cobranças pendentes', value: money(cob.pendentesCents), detail: cob.pendentes ? `${number(cob.pendentes)} cobranças · mais antiga há ${days(cob.maisAntigaDias)} · ${number(cob.agirHoje)} para agir hoje` : `nenhuma pendente · ${money(cob.pagasCents)} recuperados no período`, tone: cob.pendentes ? (cob.maisAntigaDias > 7 ? 'critical' : 'warning') : 'good' });
  }
  if (p) list.push({ label: 'Margem bruta', value: percent(p.margemPct), detail: `${money(p.margemCents)} em ${number(p.itens)} itens${pAnt ? delta(p.margemCents, pAnt.margemCents, { fmt: money }) : ''}`, tone: p.margemPct < 0.3 ? 'warning' : 'good', extra: `receita ${money(p.receitaCents)} no relatório de produtos vendidos` });
  if (b) {
    list.push({ label: 'Boletos vencidos', value: money(b.vencidosCents), detail: `${b.vencidos ? `${number(b.vencidos)} boletos${b.bloqueiaInadimplente ? ' · bloqueio por inadimplência' : ''}` : 'nenhum vencido'} · ${money(b.abertosCents)} em aberto (${number(b.abertos)})`, tone: b.vencidos ? 'critical' : 'good', extra: `próximo vencimento ${b.proximoVencimento ? `${longDate(b.proximoVencimento.data)} (${money(b.proximoVencimento.valorCents)})` : '—'}` });
  }
  const recs = prioridades(f, c);
  const contagem = ['critical', 'warning', 'info'].map((t) => recs.filter((r) => r.tone === t).length);
  const scope = scopeLabel(f.range);
  return `<section><h2>Visão geral ${scope ? `<span class="scope">${esc(scope)}</span>` : ''}</h2>${tiles(list, 6)}</section>
    <section><h2>Prioridades <span class="scope">${contagem[0]} para hoje · ${contagem[1]} para a semana · ${contagem[2]} para olhar</span></h2>${actionsList(recs)}</section>`;
}

// --- Financeiro ------------------------------------------------------------------
function cardCaixa(f, c) {
  const { caixa, media, diasComDados } = c;
  if (!caixa) return '';
  const toneColor = { vencido: 'var(--critical)', vence_em_breve: 'var(--warning)', a_vencer: 'var(--series-1)', pago: 'var(--good)' };
  const rows = caixa.rows.map((r) => ({ ...r, value: r.aPagarCents }));
  const sit = (r) => (r.key <= addDays(state.hoje, 3) ? 'vence_em_breve' : 'a_vencer');
  const chart = columns(rows, {
    fmt: money0,
    width: wideChartWidth(),
    labelFn: (d, i, full) => (full ? `${weekday(d)} ${longDate(d)}` : shortDate(d)),
    color: (r) => toneColor[sit(r)],
    highlight: (r) => r.saldoCents < 0,
    tipLines: (r) => [`vence ${money(r.aPagarCents)} (${r.boletos} boletos)`, `acumulado a pagar ${money(r.acumuladoCents)}`, `receita projetada ${money(r.receitaProjetadaCents)}`, `saldo ${money(r.saldoCents)}`],
  });
  const tab = table(
    [
      { label: 'Dia', get: (r) => `${weekday(r.key)} ${longDate(r.key)}` },
      { label: 'Vence no dia', num: true, get: (r) => (r.aPagarCents ? `${money(r.aPagarCents)} (${r.boletos})` : '—') },
      { label: 'Acumulado a pagar', num: true, get: (r) => money(r.acumuladoCents) },
      { label: 'Receita projetada', num: true, get: (r) => money(r.receitaProjetadaCents), mobile: false },
      { label: 'Saldo', num: true, html: true, get: (r) => `<span class="${r.saldoCents < 0 ? 'neg' : 'pos'}">${esc(money(r.saldoCents))}</span>` },
    ],
    caixa.rows,
  );
  const kv = `<dl class="kv"><dt>Atrasados</dt><dd>${esc(money(caixa.atrasadoCents))} <span class="desc">(${caixa.atrasados})</span></dd><dt>Vence em 7 dias</dt><dd>${esc(money(caixa.aPagar7dCents))}</dd><dt>Receita projetada 7 dias</dt><dd>${esc(money(caixa.receita7dCents))} <span class="desc">(${esc(money(media))}/dia${diasComDados ? ` · ${diasComDados} dias` : ''})</span></dd><dt>Saldo em 7 dias</dt><dd class="${caixa.saldo7dCents < 0 ? 'neg' : 'pos'}">${esc(money(caixa.saldo7dCents))}</dd></dl>${caixa.diasParaCobrir ? `<p class="kicker">Seriam necessários ${caixa.diasParaCobrir} dias de venda para cobrir tudo o que vence em 7 dias, atrasados incluídos.</p>` : ''}`;
  return card({ title: 'Caixa: próximos 14 dias', desc: 'esmaecido = receita projetada já cobre', chart: kv + chart, legendHtml: legend([{ label: 'vence em até 3 dias', color: 'var(--warning)' }, { label: 'a vencer', color: 'var(--series-1)' }]), tableHtml: kv + tab, span: true });
}

function sectionBoletos(f, c) {
  if (!c.temB) return '';
  const k = c.boletosPeriodo;
  const lista = [...k.comSituacao].sort((a, b) => (a.vencimento ?? '').localeCompare(b.vencimento ?? '') || a.id.localeCompare(b.id));
  const dias = M.vencimentosPorDia(k.comSituacao);
  const list = [
    { label: 'Vencidos', value: money(k.vencidosCents), detail: `${number(k.vencidos)} boletos`, tone: k.vencidos ? 'critical' : 'good' },
    { label: 'Vencem em até 3 dias', value: money(k.venceEmBreveCents), detail: `${number(k.venceEmBreve)} boletos`, tone: k.venceEmBreve ? 'warning' : '' },
    { label: 'A vencer', value: money(k.aVencerCents), detail: `${number(k.aVencer)} boletos` },
    { label: 'Pagos', value: money(k.pagosCents), detail: `${number(k.pagos)} boletos`, tone: k.pagos ? 'good' : '' },
    { label: 'Total no período', value: money(k.totalCents), detail: `${number(k.quantidade)} boletos gerados` },
  ];
  const listaHtml = table(
    [
      { label: 'Vencimento', get: (b) => `${weekday(b.vencimento)} ${longDate(b.vencimento)}` },
      { label: 'Situação', html: true, get: (b) => pill(b.situacao) },
      { label: 'Valor', num: true, get: (b) => money(b.valorCents) },
      { label: 'Boleto', html: true, get: (b) => (b.link ? `<a href="${esc(b.link)}" target="_blank" rel="noopener">abrir</a>` : '—') },
      { label: 'Nº cobrança', get: (b) => b.numeroCobranca ?? '—', mobile: false },
      { label: 'Nota fiscal', get: (b) => (b.nota ? `${b.nota} (${shortDate(b.emissaoNota)})` : 'não emitida'), mobile: false },
      { label: 'Picklist', get: (b) => `${b.picklist ?? '—'}${b.dataPicklist ? ` · ${shortDate(b.dataPicklist)}` : ''}`, mobile: false },
      { label: 'Gerado em', get: (b) => dateTime(b.geradoEm), mobile: false },
    ],
    lista,
  );
  const porDiaHtml = table([{ label: 'Vencimento', get: (r) => longDate(r.key) }, { label: 'Situação', html: true, get: (r) => pill(r.situacao) }, { label: 'Valor', num: true, get: (r) => money(r.value) }, { label: 'Boletos', num: true, get: (r) => number(r.count) }], dias);
  const scope = scopeLabel(f.range);
  return `<section><h2>Boletos de reabastecimento <span class="scope">${esc(scope || 'CD · sem filtro de loja')}</span></h2>
    ${tiles(list)}
    <div class="grid" style="margin-top:12px">${card({ title: 'Boletos', desc: 'por vencimento', views: [{ label: 'Lista', html: listaHtml }, { label: 'Por dia', html: porDiaHtml }], span: true })}</div></section>`;
}

function sectionReposicao(f, c) {
  if (!c.temB || !c.temT) return '';
  const semanasB = M.reposicaoPorSemana(f.boletos);
  const compras = f.transacoes.filter((t) => t.compra && t.data);
  const semanasV = M.aggregate(compras, (t) => M.isoWeek(t.data), (t) => t.totalCents);
  const keys = [...new Set([...semanasB.map((r) => r.key), ...semanasV.map((r) => r.key)])].sort();
  if (keys.length === 0) return '';
  const rows = keys.map((k) => {
    const b = semanasB.find((r) => r.key === k)?.value ?? 0;
    const v = semanasV.find((r) => r.key === k)?.value ?? 0;
    return { key: k, boletos: b, vendas: v, cobertura: M.cobertura(v, b) };
  });
  const html = table(
    [
      { label: 'Semana', get: (r) => r.key.replace('-S', ' · sem. ') },
      { label: 'Boletos gerados', num: true, get: (r) => money(r.boletos) },
      { label: 'Faturamento', num: true, get: (r) => money(r.vendas) },
      { label: 'Vendas ÷ reposição', num: true, get: (r) => (r.cobertura == null ? '—' : percent(r.cobertura)) },
    ],
    rows,
  );
  return `<section><h2>Reposição × vendas <span class="scope">por semana</span></h2><div class="card">${html}<p class="kicker" style="margin:8px 0 0">Só compara bem quando os dois relatórios cobrem as mesmas datas.</p></div></section>`;
}

// --- Cobranças -------------------------------------------------------------------
function sectionCobrancas(f, c) {
  if (!c.temT) return emptyTab('Importe o relatório de <b>transações</b> na aba Dados. As cobranças vêm dele (eventos "Cobrança pendente" e "Pagamento efetuada (cobrança)").');
  const p = c.panel;
  const cand = c.candidatos;
  const carteira = M.carteiraClientes({ saldo: f.transacoesLoja, fluxo: f.transacoes, todas: state.data.transacoes, hoje: state.hoje, candidatos: cand, operadores: c.operadores });
  const porLoja = c.cobrancasLoja;
  const semanas = M.cobrancasPorSemana(f.transacoes);
  const colorLoja = storeColors();
  const scope = scopeLabel(f.range);
  const toneRegua = { neutral: 'var(--series-1)', warning: 'var(--warning)', critical: 'var(--critical)', muted: 'var(--ink-3)' };
  const agingPill = (t) => `<span class="pill ${t.dias <= 2 ? 'neutral' : t.dias <= 6 ? 'warning' : 'critical'}" title="${esc(`pontuação de urgência ${t.score}`)}">${esc(days(t.dias))}</span>`;
  const pior = porLoja.find((l) => l.pctFaturamento != null && l.pctFaturamento > 0);

  const list = [
    { label: 'Em aberto', value: money(p.pendentesCents), detail: p.pendentes ? `${number(p.pendentes)} cobranças · ${number(p.itensPendentes)} itens · mais antiga há ${days(p.maisAntigaDias)}` : 'nenhuma cobrança em aberto', tone: p.pendentes ? (p.maisAntigaDias > 7 ? 'critical' : 'warning') : 'good', extra: `${p.comTaxa} com taxa de cobrança (${money(p.comTaxaCents)}) · ${p.comBoleto} com boleto gerado · saldo de todo o histórico importado, só o filtro de loja se aplica` },
    { label: 'Vencido há mais de 7 dias', value: money(p.vencidasCents), detail: p.vencidas ? `${number(p.vencidas)} cobranças · ${number(p.aBloquear)} a bloquear · ${number(p.jaBloqueados)} já bloqueados${p.maisDe30Cents ? ` · mais de 30 dias: ${money(p.maisDe30Cents)}` : ''}` : 'nenhuma passou de 7 dias', tone: p.vencidas ? 'critical' : p.listaPendentes.some((t) => t.dias >= 3) ? 'warning' : 'good' },
    { label: 'Agir hoje', value: number(p.agirHoje), detail: p.agirHoje ? `${p.agirResumo || 'ver a fila'} · some ao marcar como feito` : 'fila do dia concluída', tone: p.agirHoje ? 'critical' : 'good' },
    cand ? { label: 'Candidatos a cobrança', value: money(cand.totalCents), detail: cand.lista.length ? `${number(cand.lista.length)} para conferir na câmera · maior ${money(cand.lista[0].totalCents)} (${cand.lista[0].pdx})` : 'nenhum carrinho com valor sem compra', tone: cand.lista.some((t) => t.totalCents >= 20000) ? 'critical' : cand.lista.some((t) => t.totalCents >= 5000) ? 'warning' : '', extra: 'carrinhos com valor sem compra do mesmo cliente na mesma loja em 60 min, e compras removidas com valor · respeita o período' } : null,
    { label: 'Recuperado no período', value: money(p.pagasCents), detail: p.emitidas ? `${number(p.pagas)} de ${number(p.emitidas)} pagas${p.emitidas >= 10 ? ` · ${percent(p.taxaRecuperacaoQtd)} em quantidade` : ''}${p.meioPagas[0] ? ` · ${esc(p.meioPagas[0].key)}` : ''}` : 'sem cobranças no período', tone: p.pagas ? 'good' : '' },
    { label: 'Peso no faturamento', value: p.pesoFaturamento == null ? '—' : percent(p.pesoFaturamento), detail: `${pior ? `${esc(pior.key)} ${percent(pior.pctFaturamento)}${pior.diasDeVenda ? ` · ${number(pior.diasDeVenda)} dia de venda` : ''}` : 'cobranças geradas no período ÷ faturamento'}${p.custoEmRiscoCents != null ? ` · custo em risco ${money(p.custoEmRiscoCents)} (margem ${percent(p.margemUsada)})` : ''}`, tone: (p.pesoFaturamento ?? 0) >= 0.03 || (p.diasDeVenda ?? 0) >= 1 ? 'warning' : '' },
  ];
  const foot = `<p class="tiles-foot">Idade calculada até ${longDate(state.hoje)} · último registro do relatório em ${dateTime(p.ultimoRegistro)}${p.exportDias > 2 ? ` · <b>export com ${p.exportDias} dias</b>: as idades podem estar infladas` : ''}.</p>`;

  const recs = M.recomendacoesCobranca({ panel: p, candidatos: cand, porLoja });
  const ordem = { critical: 0, warning: 1, info: 2 };
  recs.sort((a, b) => ordem[a.tone] - ordem[b.tone] || (b.valorCents ?? 0) - (a.valorCents ?? 0));

  // fila
  const filaRows = p.listaPendentes;
  const filaHtml = filaRows.length
    ? table(
        [
          { label: 'Valor', num: true, html: true, get: (t) => `<b>${esc(money(t.totalCents))}</b><div class="desc">${number(t.qtdeProdutos)} itens${t.taxaCobranca ? ' · inclui taxa' : ''}</div>` },
          { label: 'Em aberto', html: true, get: (t) => `${agingPill(t)}<div class="desc">${esc(t.etapa.key.split(' · ')[1])}</div>` },
          { label: 'Cliente', html: true, get: (t) => `${esc(t.cliente ?? t.clienteId ?? '—')} ${statusPill(t.statusCliente)}<div class="desc">${esc(t.pdx)}</div>` },
          { label: 'Histórico', num: true, html: true, get: (t) => `${esc(money(t.totalGastoCliente))}<div class="desc">${number(t.comprasCliente)} compras · ${esc(percent(t.indice))} sem compra</div>`, mobile: false, title: 'gasto acumulado, compras e proporção de sessões sem compra que o painel informa' },
          { label: 'Sinais', html: true, get: (t) => `<div class="wrap">${esc([t.boleto ? 'boleto gerado' : t.semInteracao ? 'sem interação com o link' : null, ...t.sinais].filter(Boolean).join(' · ')) || '—'}</div>`, mobile: false },
          { label: 'Próxima ação', html: true, get: (t) => `<div class="wrap"><b>${esc(t.acao)}</b> <span class="desc">· ${esc(t.canal)}</span></div><div class="btns">${t.linkPagamento ? `<a href="${esc(t.linkPagamento)}" target="_blank" rel="noopener">abrir link</a>` : ''}<button type="button" class="btn btn-small" data-copy="${esc(M.mensagemCobranca(t.etapa.etapa, t))}">copiar mensagem</button>${t.idLinkPagamento ? `<button type="button" class="btn btn-small ${t.feito ? 'btn-primary' : ''}" data-done="${esc(t.idLinkPagamento)}">${t.feito ? 'feito hoje' : 'marcar feito'}</button>` : ''}</div>` },
        ],
        filaRows,
        { rowAttrs: (t) => (t.feito ? 'style="opacity:.55"' : t.dias > 7 ? 'class="neg-row"' : '') },
      )
    : `<p class="empty">Nenhuma cobrança pendente${state.filter.pdxId ? ' nesta loja' : ''}.</p>`;

  // régua
  const reguaRows = p.regua.map((r) => ({ ...r }));
  const reguaChart = hbar(reguaRows, { fmt: money, labelW: 210, width: chartWidth(), color: (r) => toneRegua[r.tone], sub: (r) => `· ${r.count} cobr.${r.soLink ? ` · ${r.soLink} só link` : ''}`, tipLines: (r) => [money(r.value), `${r.count} cobranças · ${r.boleto} com boleto · ${r.comTaxa} com taxa`, r.maior ? `maior: ${r.maior}` : ''] });
  const reguaTable = table([{ label: 'Etapa', get: (r) => r.key }, { label: 'Valor', num: true, get: (r) => money(r.value) }, { label: 'Cobranças', num: true, get: (r) => number(r.count) }, { label: 'Com boleto', num: true, get: (r) => number(r.boleto) }, { label: 'Com taxa', num: true, get: (r) => number(r.comTaxa) }, { label: 'Maior', get: (r) => r.maior || '—', mobile: false }], reguaRows);

  // candidatos
  const candLimit = state.limites.candidatos;
  const candRows = cand ? cand.lista.slice(0, candLimit) : [];
  const candHtml = candRows.length
    ? table(
        [
          { label: 'Valor', num: true, html: true, get: (t) => `<b>${esc(money(t.totalCents))}</b>` },
          { label: 'Quando', get: (t) => dateTime(t.dataHora) },
          { label: 'Loja', get: (t) => t.pdx },
          { label: 'Evento', html: true, get: (t) => `<span class="pill ${t.tipoEvento === 'carrinho' ? 'warning' : ''}">${t.tipoEvento === 'carrinho' ? 'carrinho' : 'removida'}</span>${t.categoriaEvento ? ` <span class="desc">${esc(t.categoriaEvento)}</span>` : ''}` },
          { label: 'Cliente', html: true, get: (t) => `${esc(t.cliente ?? 'sem cadastro')} ${t.statusCliente ? statusPill(t.statusCliente) : ''}` },
          { label: 'Itens', num: true, get: (t) => number(t.qtdeProdutos), mobile: false },
          { label: 'Histórico', num: true, get: (t) => `${money(t.totalGastoCliente)} · ${number(t.comprasCliente)} compras · ${percent(t.indice)} sem compra`, mobile: false },
          { label: 'Comprou depois?', get: (t) => (t.compraMesmoDia ? `${money(t.compraMesmoDia.valorCents)} ${t.compraMesmoDia.minutos} min depois` : 'não no mesmo dia'), mobile: false },
          { label: 'Ação', get: (t) => t.acao },
          { label: 'Verificado', html: true, get: (t) => `<input type="checkbox" data-verified="${esc(t.id)}" ${state.verificado[t.id] ? 'checked' : ''} aria-label="verificado">` },
        ],
        candRows,
        { rowAttrs: (t) => (state.verificado[t.id] ? 'style="opacity:.55"' : t.nivel === 'critical' ? 'class="neg-row"' : '') },
      ) + moreButton('candidatos', (cand?.lista.length ?? 0) - candRows.length, 15)
    : `<p class="empty">Nenhum carrinho com valor sem compra nem compra removida com valor no período.</p>`;
  const candFoot = cand ? `<p class="kicker" style="margin:8px 0 0">${number(cand.viraramCompra)} de ${number(cand.carrinhosComValor)} carrinhos com valor viraram compra em 60 min e ficaram de fora. Lista para conferir, não para contabilizar.</p>` : '';

  // carteira
  const sinalPill = (s) => `<span class="pill ${s === 'BLOQUEAR' ? 'critical' : s === 'VIGIAR' ? 'warning' : s === 'LIBERAR' ? 'neutral' : 'good'}">${s}</span>`;
  const timeline = (cli) =>
    cli.eventos.length
      ? `<details><summary>${number(cli.eventos.length)} eventos</summary><ul class="timeline">${cli.eventos
          .slice(-40)
          .map((e) => `<li>${esc(dateTime(e.dataHora))} · <span class="pill ${EVENTOS[e.tipoEvento]?.tone ?? ''}">${esc(EVENTOS[e.tipoEvento]?.label ?? e.tipoEvento)}</span> ${esc(e.pdx)} · ${esc(e.via ?? '')}${e.qtdeProdutos ? ` · ${e.qtdeProdutos} itens` : ''}${e.totalCents ? ` · ${esc(money(e.totalCents))}` : ''}${e.meioPagamento ? ` · ${esc(e.meioPagamento)}` : ''}</li>`)
          .join('')}</ul></details>`
      : '—';
  const carteiraRows = carteira.slice(0, state.limites.carteira);
  const carteiraHtml = carteira.length
    ? table(
        [
          { label: 'Sinal', html: true, get: (r) => `${sinalPill(r.sinal)}${r.motivo ? `<div class="desc wrap">${esc(r.motivo)}</div>` : ''}` },
          { label: 'Cliente', html: true, get: (r) => `${esc(r.nome)} ${statusPill(r.status)}` },
          { label: 'Lojas', get: (r) => r.lojas, mobile: false },
          { label: 'Pendente', num: true, get: (r) => (r.pendentes ? `${money(r.pendentesCents)} (${r.pendentes})` : '—') },
          { label: 'Pago', num: true, get: (r) => (r.pagas ? `${money(r.pagasCents)} (${r.pagas})` : '—'), mobile: false },
          { label: 'Histórico', num: true, get: (r) => `${money(r.historicoCents)} · ${number(r.comprasHistorico)} compras · ${percent(r.indice)} sem compra`, mobile: false, title: 'mediana de sessões sem compra entre os clientes: cerca de 7%' },
          { label: 'Removidas', num: true, get: (r) => `${number(r.removidas7d)} em 7 dias · ${number(r.removidasPeriodo)} no período`, mobile: false },
          { label: 'Carrinhos s/ compra', num: true, get: (r) => (r.candidatosCents ? money(r.candidatosCents) : '—'), mobile: false },
          { label: 'Peso da cobrança', num: true, get: (r) => (r.peso ? (r.peso === Infinity ? '∞' : percent(r.peso)) : '—'), mobile: false, title: 'maior cobrança ÷ gasto histórico' },
          { label: 'Último evento', get: (r) => dateTime(r.ultimo), mobile: false },
          { label: 'Ação', get: (r) => r.acao || '—' },
          { label: 'Linha do tempo', html: true, get: (r) => timeline(r), mobile: false },
        ],
        carteiraRows,
        { rowAttrs: (r) => (r.sinal === 'BLOQUEAR' ? 'class="neg-row"' : '') },
      ) + moreButton('carteira', carteira.length - carteiraRows.length, 20)
    : `<p class="empty">Nenhum cliente com sinal no período.</p>`;

  // por loja
  const lojaTable = table(
    [
      { label: 'Loja', get: (r) => r.key },
      { label: 'Pendente', num: true, get: (r) => (r.pendentes ? `${money(r.pendentesCents)} (${r.pendentes})` : '—') },
      { label: '> 7 dias', num: true, get: (r) => (r.vencidasCents ? money(r.vencidasCents) : '—'), mobile: false },
      { label: 'Recuperado', num: true, get: (r) => (r.pagas ? `${money(r.pagasCents)} (${r.pagas})` : '—') },
      { label: '% do faturamento', num: true, get: (r) => (r.pctFaturamento == null ? '—' : percent(r.pctFaturamento)), title: 'cobranças geradas no período ÷ faturamento do período' },
      { label: 'Dias de venda', num: true, get: (r) => (r.diasDeVenda == null ? '—' : number(r.diasDeVenda)), mobile: false, title: 'pendente ÷ faturamento médio por dia da loja' },
      { label: 'Candidatos', num: true, get: (r) => (r.candidatos ? `${money(r.candidatosCents)} (${r.candidatos})` : '—'), mobile: false },
      { label: 'Removidas', num: true, get: (r) => `${number(r.removidas)} (${number(r.removidasPos)} POS)`, mobile: false },
      { label: 'Perda de inventário', num: true, get: (r) => (r.perdaVendaCents == null ? '—' : money(r.perdaVendaCents)), mobile: false, title: 'faltas na contagem a preço de venda (último inventário)' },
      { label: 'Cobertura', num: true, get: (r) => (r.cobertura == null ? '—' : percent(r.cobertura)), title: 'cobranças ÷ (cobranças + perda de inventário): quanto da perda tem rosto' },
    ],
    porLoja,
    { rowAttrs: (r) => (r.alerta ? 'class="neg-row"' : '') },
  );
  const lojaChart = hbar(porLoja.filter((r) => r.pendentesCents || r.pagasCents), { fmt: money, labelW: 190, width: chartWidth(), color: colorLoja, sub: (r) => `· ${r.pendentes} pend. · ${money(r.pagasCents)} pagas`, tipLines: (r) => [`pendente ${money(r.pendentesCents)} (${r.pendentes})`, `recuperado ${money(r.pagasCents)} (${r.pagas})`, r.pctFaturamento == null ? '' : `${percent(r.pctFaturamento)} do faturamento`] });

  // semanal
  const semTable = table(
    [
      { label: 'Semana', get: (r) => r.key.replace('-S', ' · sem. ') },
      { label: 'Geradas', num: true, get: (r) => `${money(r.pendentesCents)} (${r.pendentes})` },
      { label: 'Pagas', num: true, get: (r) => `${money(r.pagasCents)} (${r.pagas})` },
      { label: 'Saldo líquido', num: true, html: true, get: (r) => `<span class="${r.saldoCents > 0 ? 'neg' : 'pos'}">${esc(money(r.saldoCents))}</span>` },
      { label: 'Acumulado em aberto', num: true, get: (r) => money(r.acumuladoCents), mobile: false },
    ],
    semanas,
  );
  const semMax = Math.max(1, ...semanas.map((r) => Math.max(r.pendentesCents, r.pagasCents)));
  const semChart = semanas.length
    ? `<p class="kicker">Geradas</p>${columns(semanas.map((r) => ({ ...r, value: r.pendentesCents })), { fmt: money0, width: chartWidth(), height: 160, max: semMax, labelFn: (w) => w.replace('-S', ' s'), color: () => 'var(--critical)', tipLines: (r) => [`geradas ${money(r.pendentesCents)} (${r.pendentes})`] })}<p class="kicker">Pagas</p>${columns(semanas.map((r) => ({ ...r, value: r.pagasCents })), { fmt: money0, width: chartWidth(), height: 160, max: semMax, labelFn: (w) => w.replace('-S', ' s'), color: () => 'var(--good)', tipLines: (r) => [`pagas ${money(r.pagasCents)} (${r.pagas})`] })}`
    : emptyChart();

  // recuperadas
  const pagasHtml = p.listaPagas.length
    ? table(
        [
          { label: 'Pagamento', get: (t) => dateTime(t.dataHora) },
          { label: 'Loja', get: (t) => t.pdx },
          { label: 'Cliente', html: true, get: (t) => `${esc(t.cliente ?? t.clienteId ?? '—')} ${statusPill(t.statusCliente)}` },
          { label: 'Itens', num: true, get: (t) => number(t.qtdeProdutos), mobile: false },
          { label: 'Valor', num: true, get: (t) => money(t.totalCents) },
          { label: 'Forma', get: (t) => (t.meioPagamento ? `${t.meioPagamento}${t.bandeira ? ` · ${t.bandeira}` : ''}` : '—') },
          { label: 'NFC-e', html: true, get: (t) => (t.nfce ? esc(t.nfce) : '<span class="neg">não emitida</span>'), mobile: false },
          { label: 'Link', get: (t) => (t.idLinkPagamento ? `#${t.idLinkPagamento}` : '—'), mobile: false },
          { label: 'Dias para pagar', num: true, get: (t) => (t.diasParaPagar == null ? '—' : days(t.diasParaPagar)), mobile: false, title: 'só quando a cobrança apareceu pendente numa importação anterior' },
          { label: 'Continuou comprando?', get: (t) => (t.continuouComprando ? `sim · ${number(t.continuouComprando)} compras` : 'ainda não'), mobile: false },
        ],
        p.listaPagas,
      )
    : `<p class="empty">Nenhuma cobrança paga no período.</p>`;

  // mensagens prontas
  const modelo = p.listaPendentes[0] ?? { cliente: '{nome}', pdx: '{loja}', qtdeProdutos: 2, totalCents: 0, data: null, linkPagamento: '{link}' };
  const msgs = [['D+1', 'amigável, com o link'], ['D+3', 'firme, 48 h e Pix sem taxa'], ['D+7', 'bloqueio e como reativar']]
    .map(([etapa, nome]) => {
      const txt = M.mensagemCobranca(etapa, modelo);
      return `<div class="msg-head"><b>${etapa} · ${esc(nome)}</b><button type="button" class="btn btn-small" data-copy="${esc(txt)}">copiar</button></div><div class="msg">${esc(txt)}</div>`;
    })
    .join('');

  return `<section><h2>Cobranças <span class="scope">${esc(scope || 'itens levados sem pagamento')}</span></h2>
    ${tiles(list)}${foot}
    <h3 style="margin:14px 0 8px;font-size:14px">Prioridades de cobrança</h3>${actionsList(recs, { groups: false })}
    <div class="grid" style="margin-top:12px">
      <div class="card span-2"><div class="card-head"><h3>Fila de cobrança</h3><span class="desc">todo o saldo, por urgência</span></div>${filaHtml}
        <details class="more"><summary>Mensagens prontas (preenchidas com a primeira da fila)</summary>${msgs}<p class="kicker">O relatório não traz telefone: copie e cole no WhatsApp ou envie pelo contato do condomínio.</p></details></div>
      ${card({ title: 'Régua de cobrança', desc: 'valor em aberto por etapa', chart: reguaChart, legendHtml: `<p class="kicker" style="margin:4px 0 0">Boleto gerado congela a régua por 3 dias úteis.</p>`, tableHtml: reguaTable })}
      ${card({ title: 'Fluxo semanal', desc: 'geradas × pagas', views: [{ label: 'Tabela', html: semTable }, { label: 'Gráfico', html: semChart }] })}
      ${card({ title: 'Por loja', desc: 'vermelho = cobranças ≥ 3% do faturamento ou cobertura < 20%', views: [{ label: 'Tabela', html: lojaTable }, { label: 'Gráfico', html: lojaChart }], span: true })}
      <div class="card span-2"><div class="card-head"><h3>Candidatos a cobrança</h3><span class="desc">conferir câmera e gerar no painel</span></div>${candHtml}${candFoot}</div>
      <div class="card span-2"><div class="card-head"><h3>Carteira de clientes</h3><span class="desc">quem tem sinal: cobrança, removidas repetidas, carrinho sem compra ou bloqueio</span></div>${carteiraHtml}</div>
      <div class="card span-2"><div class="card-head"><h3>Recuperadas</h3><span class="desc">pagamentos de cobrança no período</span></div>${pagasHtml}</div>
    </div>
    <p class="kicker" style="margin-top:10px">Como ler: a cobrança paga aparece na data do pagamento, não na da cobrança original. Com poucas cobranças, olhe o valor e os clientes, não a porcentagem. Só o status Bloqueado é tratado como ação de gestão; Desativado não é inadimplência.</p>
  </section>`;
}

// --- Operação --------------------------------------------------------------------
function sectionOperacao(f, c) {
  const temI = state.data.inventario.length > 0;
  const temR = state.data.retornos.length > 0;
  if (!temI && !temR) return emptyTab('Importe o <b>inventário</b> e as <b>remessas de retorno</b> (Sistema PDV) na aba Dados para ver estoque, perdas e devoluções.');
  const colorLoja = storeColors();
  let html = '';
  if (temI) {
    const lojas = c.estoqueLojas;
    const itens = lojas.flatMap((l) => l.itens);
    const k = M.estoqueKpis(itens);
    const datas = [...new Set(lojas.map((l) => l.data))].sort();
    const scope = `último inventário ${datas.length > 1 ? `de ${shortDate(datas[0])} a ${shortDate(datas[datas.length - 1])}` : shortDate(datas[0])} · ${lojas.length} loja${lojas.length > 1 ? 's' : ''}`;
    const detalhe = lojas.map((l) => `${l.pdx}: inventário #${l.inventario} de ${longDate(l.data)}`).join(' · ');
    const list = [
      { label: 'Estoque a custo', value: money(k.custoCents), detail: `${number(k.unidades)} unidades em ${number(k.skus)} SKUs`, extra: `${money(k.vendaCents)} a preço de venda` },
      { label: 'Perda no inventário', value: money(k.perdaCustoCents), detail: `${percent(k.perdaPct)} do estoque · ${number(k.perdaUnidades)} unidades em ${number(k.skusComFalta)} produtos`, tone: k.perdaPct >= 0.05 ? 'critical' : k.perdaCustoCents ? 'warning' : 'good', extra: `${money(k.perdaVendaCents)} em venda perdida` },
      { label: 'Acuracidade', value: percent(k.acuracidade), detail: `itens contados iguais ao sistema · sobras ${number(k.sobraUnidades)} un`, tone: k.acuracidade < 0.8 ? 'warning' : 'good' },
      { label: 'Rupturas', value: number(k.rupturas), detail: `produtos zerados · mais ${number(k.estoqueBaixo)} com 1 unidade`, tone: k.rupturas ? 'warning' : 'good' },
    ];
    const perdasCat = M.perdasPorCategoria(itens);
    const perdasTop = M.perdasTopProdutos(itens, 10);
    const estCat = M.estoquePorCategoria(itens);
    const repAll = M.reposicaoPrioritaria(itens, f.produtos, 500);
    const rep = repAll.slice(0, state.limites.reposicao);
    const cards = [
      card({
        title: 'Perdas por categoria', desc: 'custo do que faltou',
        chart: hbar(perdasCat, { fmt: money, labelW: 180, width: chartWidth(), color: () => 'var(--critical)', sub: (r) => `· ${number(r.unidades)} un` }),
        tableHtml: table([{ label: 'Categoria', get: (r) => r.key }, { label: 'Perda (custo)', num: true, get: (r) => money(r.value) }, { label: 'Unid.', num: true, get: (r) => number(r.unidades) }, { label: 'Produtos', num: true, get: (r) => number(r.count) }], perdasCat),
      }),
      card({
        title: 'Estoque por categoria', desc: 'valor a custo',
        chart: hbar(estCat, { fmt: money, labelW: 180, width: chartWidth(), sub: (r) => `· ${number(r.unidades)} un · ${r.rupturas} zerados` }),
        tableHtml: table([{ label: 'Categoria', get: (r) => r.key }, { label: 'Custo', num: true, get: (r) => money(r.value) }, { label: 'Unid.', num: true, get: (r) => number(r.unidades) }, { label: 'SKUs', num: true, get: (r) => number(r.skus) }, { label: 'Zerados', num: true, get: (r) => number(r.rupturas) }], estCat),
      }),
    ];
    const perdasHtml = table(
      [
        { label: '#', html: true, get: (r) => `<span class="rank">${perdasTop.indexOf(r) + 1}</span>` },
        { label: 'Produto', get: (r) => r.key },
        { label: 'Categoria', get: (r) => r.categoria, mobile: false },
        { label: 'Loja', get: (r) => r.loja, hideIfUniform: true },
        { label: 'Faltaram', num: true, get: (r) => `${number(r.unidades)} un` },
        { label: 'Perda (custo)', num: true, get: (r) => money(r.value) },
      ],
      perdasTop,
    );
    const repHtml = rep.length
      ? table(
          [
            { label: 'Produto', get: (r) => r.produto },
            { label: 'Em estoque', num: true, html: true, get: (r) => `<span class="${r.posicaoAjustada <= 0 ? 'neg' : ''}">${number(r.posicaoAjustada)}</span>` },
            { label: 'Preço', num: true, get: (r) => money(r.vendaUnitCents) },
            { label: 'Vendidos no período', num: true, get: (r) => number(r.vendidos) },
            { label: 'Categoria', get: (r) => r.categoria, mobile: false },
            { label: 'Custo', num: true, get: (r) => money(r.custoUnitCents), mobile: false },
            { label: 'Loja', get: (r) => r.pdx, hideIfUniform: true, mobile: false },
          ],
          rep,
        ) + moreButton('reposicao', repAll.length - rep.length, 20)
      : `<p class="empty">Nenhum produto zerado ou com 1 unidade.</p>`;
    html += `<section><h2 title="${esc(detalhe)}">Estoque <span class="scope">${esc(scope)} · foto, sem filtro de período</span></h2>
      ${tiles(list)}
      <div class="grid" style="margin-top:12px">${cards.join('')}
        <div class="card span-2"><div class="card-head"><h3>Maiores perdas no inventário</h3><span class="desc">candidatos a furto, quebra ou erro de registro</span></div>${perdasHtml}</div>
        <div class="card span-2"><div class="card-head"><h3>Reposição prioritária</h3><span class="desc">zerados ou com 1 unidade, os que mais vendem primeiro</span></div>${repHtml}</div>
      </div></section>`;
  }
  if (temR) {
    const k = M.retornosKpis(f.retornos);
    const porLoja = M.retornosPorLoja(f.retornos);
    const semanas = M.retornosPorSemana(f.retornos);
    const top = M.retornosTopProdutos(f.retornos, 10);
    const tipoColors = ['var(--warning)', 'var(--series-4)', 'var(--series-6)'];
    const list = [
      { label: 'Devolvido ao CD', value: money(k.custoCents), detail: `${number(k.unidades)} unidades em ${number(k.remessas)} remessas`, tone: k.custoCents ? 'warning' : 'good' },
      { label: 'Vencidos', value: money(k.vencidosCents), detail: 'passaram da validade na gôndola', tone: k.vencidosCents ? 'warning' : '' },
      { label: 'Avarias', value: money(k.avariasCents), detail: 'embalagem danificada ou produto impróprio' },
    ];
    const cards = [
      card({
        title: 'Devoluções por loja', desc: 'custo',
        chart: hbar(porLoja, { fmt: money, labelW: 190, width: chartWidth(), color: colorLoja, sub: (r) => `· ${number(r.unidades)} un` }),
        tableHtml: table([{ label: 'Loja', get: (r) => r.key }, { label: 'Custo', num: true, get: (r) => money(r.value) }, { label: 'Unid.', num: true, get: (r) => number(r.unidades) }], porLoja),
      }),
      card({
        title: 'Devoluções por semana', desc: 'vencidos + avarias',
        chart: columns(semanas, { fmt: money0, width: chartWidth(), labelFn: (k2) => k2.replace('-S', ' s'), tipLines: (r) => [money(r.value), `${number(r.unidades)} unidades`] }) + stacked(k.porTipo, { fmt: money, colors: tipoColors, width: chartWidth() }),
        legendHtml: legend(k.porTipo.map((r, i) => ({ label: `${r.key} · ${money(r.value)} · ${number(r.unidades)} un`, color: tipoColors[i % tipoColors.length] }))),
        tableHtml: table([{ label: 'Semana', get: (r) => r.key.replace('-S', ' · sem. ') }, { label: 'Custo', num: true, get: (r) => money(r.value) }, { label: 'Unid.', num: true, get: (r) => number(r.unidades) }], semanas),
      }),
    ];
    const topHtml = table(
      [
        { label: '#', html: true, get: (r) => `<span class="rank">${top.indexOf(r) + 1}</span>` },
        { label: 'Produto', get: (r) => r.key },
        { label: 'Motivo', get: (r) => r.tipo },
        { label: 'Lojas', get: (r) => r.lojas, mobile: false },
        { label: 'Unid.', num: true, get: (r) => number(r.unidades) },
        { label: 'Custo', num: true, get: (r) => money(r.value) },
      ],
      top,
    );
    const scope = scopeLabel(f.range);
    html += `<section><h2>Devoluções ao CD <span class="scope">${esc(scope || 'remessas de retorno')}</span></h2>
      ${tiles(list)}
      <div class="grid" style="margin-top:12px">${cards.join('')}<div class="card span-2"><div class="card-head"><h3>Produtos mais devolvidos</h3><span class="desc">reduzir o pedido ou girar a validade</span></div>${topHtml}</div></div></section>`;
  }
  return html;
}

// --- Vendas ----------------------------------------------------------------------
function sectionVendas(f, c) {
  if (!c.temT) return emptyTab('Importe o relatório de <b>transações</b> na aba Dados.');
  const t = f.transacoes;
  const horas = M.porHora(t);
  const dias = M.porDia(t);
  const meios = M.porMeioPagamento(t);
  const vias = M.porVia(t);
  const viaColors = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
  const funil = M.funilEventos(t).map((r) => ({ ...r, label: EVENTOS[r.key]?.label ?? r.key }));
  const funilColor = { compra: 'var(--series-1)', carrinho: 'var(--warning)', removida: 'var(--ink-3)', estornada: 'var(--critical)', cobranca_pendente: 'var(--critical)', cobranca_paga: 'var(--good)' };
  const w = chartWidth();
  const cards = [
    card({
      title: 'Funil de sessões', desc: 'o que aconteceu em cada sessão',
      chart: hbar(funil.map((r) => ({ ...r, key: r.label, value: r.count, tipo: r.key, valor: r.value })), { fmt: (v) => number(v), labelW: 170, width: w, color: (r) => funilColor[r.tipo] ?? 'var(--series-1)', sub: (r) => (r.valor ? `· ${money(r.valor)}` : ''), tipLines: (r) => [`${number(r.value)} sessões`, r.valor ? `valor ${money(r.valor)}` : 'sem valor'] }),
      tableHtml: table([{ label: 'Evento', get: (r) => r.label }, { label: 'Sessões', num: true, get: (r) => number(r.count) }, { label: 'Valor', num: true, get: (r) => money(r.value) }], funil),
    }),
    card({
      title: 'Vendas por hora do dia', desc: 'faturamento acumulado',
      chart: columns(horas, { fmt: money0, width: w, labelFn: (h) => hourLabel(h), every: 3, tipLines: (r) => [money(r.value), `${r.count} compras`] }),
      tableHtml: table([{ label: 'Hora', get: (r) => hourLabel(r.key) }, { label: 'Faturamento', num: true, get: (r) => money(r.value) }, { label: 'Compras', num: true, get: (r) => number(r.count) }], horas.filter((h) => h.count)),
    }),
    card({
      title: 'Faturamento por dia', desc: dias.length <= 1 ? 'importe mais dias para ver a tendência' : `${dias.length} dias`,
      chart: columns(dias, { fmt: money0, width: w, labelFn: (d, i, full) => (full ? `${weekday(d)} ${longDate(d)}` : shortDate(d)), every: Math.max(1, Math.ceil(dias.length / 10)), tipLines: (r) => [money(r.value), `${r.count} compras`] }),
      tableHtml: table([{ label: 'Dia', get: (r) => `${weekday(r.key)} ${longDate(r.key)}` }, { label: 'Faturamento', num: true, get: (r) => money(r.value) }, { label: 'Compras', num: true, get: (r) => number(r.count) }], dias),
    }),
    card({
      title: 'Meio de pagamento', desc: 'por valor',
      chart: hbar(meios, { fmt: money, width: w, sub: (r) => `· ${r.count}` }),
      tableHtml: table(colsValor('Meio'), meios),
    }),
    card({
      title: 'Canal de compra', desc: 'APP (celular) × POS (totem)',
      chart: stacked(vias, { fmt: money, colors: viaColors, width: w }),
      legendHtml: legend(vias.map((r, i) => ({ label: `${r.key} · ${money(r.value)} · ${r.count} compras`, color: viaColors[i % viaColors.length] }))),
      tableHtml: table(colsValor('Canal'), vias),
    }),
  ];
  const scope = scopeLabel(f.range);
  return `<section><h2 class="h2-tab">Vendas ${scope ? `<span class="scope">${esc(scope)}</span>` : ''}</h2><div class="grid">${cards.join('')}</div></section>${sectionTransacoes(f)}`;
}

function sectionTransacoes(f) {
  const limite = state.limites.transacoes ?? (isMobile() ? 25 : 100);
  const todas = [...f.transacoes].sort((a, b) => (b.dataHora ?? '').localeCompare(a.dataHora ?? ''));
  const rows = todas.slice(0, limite);
  const html = table(
    [
      { label: 'Data', get: (t) => dateTime(t.dataHora) },
      { label: 'Loja', get: (t) => t.pdx },
      { label: 'Evento', html: true, get: (t) => { const e = EVENTOS[t.tipoEvento] ?? EVENTOS.outro; return `<span class="pill ${e.tone}">${esc(e.label)}</span>${t.categoriaEvento ? ` <span class="desc">${esc(t.categoriaEvento)}</span>` : ''}`; } },
      { label: 'Total', num: true, html: true, get: (t) => (t.totalCents ? `<span title="${esc(t.nfce ? `NFC-e ${t.nfce}` : 'sem NFC-e')}">${esc(money(t.totalCents))}</span>` : '—') },
      { label: 'Cliente', get: (t) => `${t.cliente ?? '—'}${t.comprasCliente ? ` (${t.comprasCliente}ª compra)` : ''}`, mobile: false },
      { label: 'Canal', get: (t) => t.via ?? '—', mobile: false },
      { label: 'Pagamento', get: (t) => (t.meioPagamento ? `${t.meioPagamento}${t.bandeira ? ` · ${t.bandeira}` : ''}` : '—'), mobile: false },
      { label: 'Itens', num: true, get: (t) => number(t.qtdeProdutos), mobile: false },
    ],
    rows,
  );
  return `<section><h2>Últimas transações <span class="scope">${rows.length} de ${number(f.transacoes.length)}</span></h2><div class="card">${html}${moreButton('transacoes', todas.length - rows.length, 25)}</div></section>`;
}

// --- Produtos --------------------------------------------------------------------
function sectionProdutos(f, c) {
  if (!c.temP) return emptyTab('Importe o relatório de <b>produtos vendidos</b> na aba Dados.');
  const p = f.produtos;
  const top = M.topProdutos(p, 10);
  const contrib = M.contribuicaoMargem(p, 10);
  const cats = M.porCategoria(p);
  const fabs = M.porFabricante(p, 10);
  const sexo = M.porSexo(p);
  const faixas = M.porFaixaEtaria(p);
  const revisar = c.revisar;
  const w = chartWidth();
  const margemPct = (r) => (r.value ? r.margem / r.value : 0);
  const colsMargem = (keyLabel) => [
    { label: keyLabel, get: (r) => r.key },
    { label: 'Receita', num: true, get: (r) => money(r.value) },
    { label: 'Custo', num: true, get: (r) => money(r.custo), mobile: false },
    { label: 'Margem', num: true, get: (r) => `${money(r.margem)} (${percent(margemPct(r))})` },
    { label: 'Unid.', num: true, get: (r) => number(r.quantidade), mobile: false },
  ];
  const margemColor = (r) => (margemPct(r) < 0.3 ? 'var(--warning)' : 'var(--series-1)');
  const sexoColors = ['var(--series-1)', 'var(--series-5)', 'var(--series-3)'];
  const revisarHtml = revisar.length
    ? table(
        [
          { label: 'Produto', get: (r) => r.key },
          { label: 'Margem', num: true, html: true, get: (r) => `<span class="neg">${esc(percent(r.margemPct))}</span>` },
          { label: 'Preço médio', num: true, get: (r) => money(r.precoMedioCents) },
          { label: 'Custo', num: true, get: (r) => money(r.custoMedioCents), mobile: false },
          { label: 'Preço p/ 30%', num: true, get: (r) => money(r.precoSugeridoCents) },
          { label: 'Margem perdida', num: true, get: (r) => money(r.margemPerdidaCents), mobile: false, title: 'quanto faltou para 30% no período' },
          { label: 'Unid.', num: true, get: (r) => number(r.quantidade), mobile: false },
          { label: 'Categoria', get: (r) => r.categoria, mobile: false },
        ],
        revisar,
      )
    : `<p class="empty">Todos os produtos vendidos no período têm margem de 30% ou mais.</p>`;
  const cards = [
    `<div class="card span-2"><div class="card-head"><h3>Produtos com margem a revisar</h3><span class="desc">abaixo de 30% · preço sugerido com o custo atual</span></div>${revisarHtml}</div>`,
    card({
      title: 'Top 10 produtos', desc: 'amarelo = margem abaixo de 30%',
      views: [
        { label: 'Receita', html: hbar(top, { fmt: money, width: w, color: margemColor, labelW: 230, sub: (r) => `· ${percent(margemPct(r))} · ${number(r.quantidade)} un`, tipLines: (r) => [money(r.value), `margem ${money(r.margem)} (${percent(margemPct(r))})`, `${number(r.quantidade)} unidades · ${r.categoria}`] }) },
        { label: 'Margem R$', html: hbar(contrib, { fmt: money, width: w, labelW: 230, sub: (r) => `· ${number(r.quantidade)} un`, tipLines: (r) => [`margem ${money(r.value)}`, `receita ${money(r.receita)}`, `${number(r.quantidade)} unidades`] }) },
        { label: 'Tabela', html: table(colsMargem('Produto'), top) },
      ],
    }),
    card({
      title: 'Categorias', desc: 'amarelo = margem abaixo de 30%',
      chart: hbar(cats, { fmt: money, width: w, color: margemColor, labelW: 170, sub: (r) => `· ${percent(margemPct(r))}`, tipLines: (r) => [money(r.value), `margem ${money(r.margem)} (${percent(margemPct(r))})`, `${number(r.quantidade)} unidades`] }),
      tableHtml: table(colsMargem('Categoria'), cats),
    }),
    card({
      title: 'Fabricantes', desc: 'top 10 por receita',
      chart: hbar(fabs, { fmt: money, width: w, color: margemColor, sub: (r) => `· ${percent(margemPct(r))}`, tipLines: (r) => [money(r.value), `margem ${percent(margemPct(r))}`, `${number(r.quantidade)} unidades`] }),
      tableHtml: table(colsMargem('Fabricante'), fabs),
    }),
    card({
      title: 'Quem compra', desc: 'por sexo e faixa etária',
      chart: stacked(sexo, { fmt: money, colors: sexoColors, width: w }) + columns(faixas, { fmt: money0, width: w, tipLines: (r) => [money(r.value), `${r.count} itens`] }),
      legendHtml: legend(sexo.map((r, i) => ({ label: `${r.key} · ${money(r.value)}`, color: sexoColors[i % sexoColors.length] }))),
      tableHtml: table(colsValor('Sexo'), sexo) + table(colsValor('Faixa etária'), faixas),
    }),
  ];
  const scope = scopeLabel(f.range);
  return `<section><h2 class="h2-tab">Produtos ${scope ? `<span class="scope">${esc(scope)}</span>` : ''}</h2><div class="grid">${cards.join('')}</div></section>`;
}

// --- Lojas -----------------------------------------------------------------------
function sectionLojas(f, c) {
  if (!c.temT) return emptyTab('Importe o relatório de <b>transações</b> na aba Dados.');
  const lojas = c.lojas;
  if (lojas.length === 0) return emptyTab('Sem compras no período.');
  const colorLoja = storeColors();
  const fat = M.porLoja(f.transacoes);
  const abandonos = M.abandonosPorLoja(f.transacoes);
  const w = chartWidth();
  const cols = [
    { label: '#', html: true, get: (r) => `<span class="rank">${lojas.indexOf(r) + 1}</span>` },
    { label: 'Loja', get: (r) => r.key },
    { label: 'Faturamento', num: true, get: (r) => money(r.faturamentoCents) },
    { label: 'Share', num: true, get: (r) => percent(r.share), mobile: false },
    { label: 'Compras', num: true, get: (r) => number(r.compras) },
    { label: 'Ticket', num: true, get: (r) => money(r.ticketCents) },
    { label: 'Itens/compra', num: true, get: (r) => number(r.itensPorCompra), mobile: false },
    { label: 'Conversão', num: true, html: true, get: (r) => `<span class="${r.sessoes >= 5 && r.conversao < 0.6 ? 'neg' : ''}">${esc(percent(r.conversao))}</span> <span class="desc">(${r.carrinhos} carrinhos · ${r.removidas} removidas)</span>` },
    { label: 'Cobranças', num: true, html: true, get: (r) => (r.cobrancasPendentes ? `<span class="neg">${r.cobrancasPendentes} · ${esc(money(r.cobrancasPendentesCents))}</span>` : '—') },
    { label: '% app', num: true, get: (r) => percent(r.pctApp), mobile: false },
    { label: 'Clientes', num: true, get: (r) => number(r.clientes), mobile: false },
  ];
  if (c.temP) cols.push({ label: 'Margem', num: true, html: true, get: (r) => (r.margemPct == null ? '—' : `<span class="${r.margemPct < 0.3 ? 'neg' : ''}">${esc(percent(r.margemPct))}</span>`) });
  const heat = M.heatmapLojaPeriodo(f.transacoes);
  const scope = scopeLabel(f.range);
  return `<section><h2 class="h2-tab">Lojas ${scope ? `<span class="scope">${esc(scope)}</span>` : ''}</h2>
    <div class="grid">
    ${card({ title: 'Faturamento por loja', desc: 'compras efetuadas', chart: hbar(fat, { fmt: money, color: colorLoja, labelW: 190, width: w, sub: (r) => `· ${r.count} compras` }), tableHtml: table(colsValor('Loja'), fat) })}
    ${card({ title: 'Carrinhos abandonados por loja', desc: 'e o valor que ficou no carrinho', chart: abandonos.length ? hbar(abandonos, { fmt: (v) => `${number(v)}`, color: colorLoja, labelW: 190, width: w, sub: (r) => (r.valor ? `· ${money(r.valor)}` : ''), tipLines: (r) => [`${number(r.value)} carrinhos`, `valor nos carrinhos ${money(r.valor)}`] }) : emptyChart(), tableHtml: table([{ label: 'Loja', get: (r) => r.key }, { label: 'Carrinhos', num: true, get: (r) => number(r.value) }, { label: 'Valor', num: true, get: (r) => money(r.valor) }], abandonos) })}
    <div class="card span-2"><div class="card-head"><h3>Comparativo de lojas</h3><span class="desc">vermelho = conversão abaixo de 60% ou margem abaixo de 30%</span></div>${table(cols, lojas)}</div>
    <div class="card span-2"><div class="card-head"><h3>Faturamento por loja e período do dia</h3><span class="desc">orienta reposição e visitas</span></div>${heatmap(heat, { fmt: money })}</div></div></section>`;
}

// --- Clientes --------------------------------------------------------------------
function sectionClientes(f, c) {
  if (!c.temT) return emptyTab('Importe o relatório de <b>transações</b> na aba Dados.');
  const rec = M.recorrencia(f.transacoes);
  const top = M.topClientes(f.transacoes, 10);
  const cat = M.abandonosPorCategoria(f.transacoes);
  const canal = M.abandonosPorCanal(f.transacoes);
  const recColors = ['var(--series-6)', 'var(--series-1)', 'var(--series-3)', 'var(--series-4)'];
  const w = chartWidth();
  const cards = [
    card({
      title: 'Fidelidade', desc: 'faturamento por histórico do cliente',
      chart: stacked(rec.filter((r) => r.value), { fmt: money, colors: rec.filter((r) => r.value).map((r) => recColors[M.FAIXAS_RECORRENCIA.indexOf(r.key)]), width: w }),
      legendHtml: legend(rec.map((r, i) => ({ label: `${r.key} · ${money(r.value)} · ${r.count}`, color: recColors[i] }))),
      tableHtml: table(colsValor('Histórico do cliente'), rec),
    }),
    card({
      title: 'Carrinhos abandonados', desc: 'por categoria e canal',
      chart: (cat.length ? hbar(cat, { fmt: (v) => `${number(v)}`, labelW: 190, width: w }) : emptyChart()) + (canal.length ? stacked(canal, { fmt: (v) => `${number(v)} carrinhos`, colors: ['var(--series-1)', 'var(--series-2)'], width: w }) : ''),
      legendHtml: legend(canal.map((r, i) => ({ label: `${r.key} · ${number(r.value)}`, color: ['var(--series-1)', 'var(--series-2)'][i % 2] }))),
      tableHtml: table([{ label: 'Categoria', get: (r) => r.key }, { label: 'Carrinhos', num: true, get: (r) => number(r.value) }], cat) + table([{ label: 'Canal', get: (r) => r.key }, { label: 'Carrinhos', num: true, get: (r) => number(r.value) }], canal),
    }),
  ];
  const topHtml = table(
    [
      { label: '#', html: true, get: (r) => `<span class="rank">${top.indexOf(r) + 1}</span>` },
      { label: 'Cliente', get: (r) => r.nome },
      { label: 'Loja', get: (r) => r.loja, mobile: false },
      { label: 'Gasto no período', num: true, get: (r) => money(r.value) },
      { label: 'Compras', num: true, get: (r) => number(r.count) },
      { label: 'Histórico', num: true, get: (r) => `${money(r.historicoCents)} em ${number(r.comprasHistorico)} compras`, mobile: false },
      { label: 'Última compra', get: (r) => dateTime(r.ultima), mobile: false },
    ],
    top,
  );
  const scope = scopeLabel(f.range);
  return `<section><h2 class="h2-tab">Clientes ${scope ? `<span class="scope">${esc(scope)}</span>` : ''}</h2><div class="grid">${cards.join('')}<div class="card span-2"><div class="card-head"><h3>Top 10 clientes</h3><span class="desc">no período</span></div>${topHtml}</div></div></section>`;
}

// --- cabeçalho: filtros e abas ---------------------------------------------------
function renderFilters() {
  const lojas = M.listPdx(state.data.transacoes, state.data.produtos);
  const custom = state.filter.preset === 'custom';
  document.getElementById('filters').innerHTML = `
    <label for="preset">Período</label>
    <div class="seg" id="preset" role="group">${PRESETS.map((p) => `<button type="button" data-preset="${p.id}" aria-pressed="${state.filter.preset === p.id}">${p.label}</button>`).join('')}</div>
    <span class="range" ${custom ? '' : 'hidden'}><input type="date" id="from" value="${state.filter.from ?? ''}" aria-label="De"> – <input type="date" id="to" value="${state.filter.to ?? ''}" aria-label="Até"></span>
    <label for="pdx">Loja</label>
    <select id="pdx"><option value="">Todas as lojas</option>${lojas.map((l) => `<option value="${l.id}" ${state.filter.pdxId === l.id ? 'selected' : ''}>${esc(l.nome)}</option>`).join('')}</select>`;
}

function renderTabs(c) {
  const loaded = Object.values(state.data).filter((l) => l.length > 0).length;
  const total = Object.keys(REPORT_TYPES).length;
  const badge = (id) => {
    if (id === 'dados') return `<span class="badge ${loaded === total ? 'good' : ''}">${loaded}/${total}</span>`;
    if (id === 'financeiro' && c?.boletos?.vencidos) return `<span class="badge critical">${c.boletos.vencidos}</span>`;
    if (id === 'cobrancas' && c?.panel?.agirHoje) return `<span class="badge critical">${c.panel.agirHoje}</span>`;
    if (id === 'operacao' && c?.estoqueLojas?.some((l) => l.kpis.perdaPct >= 0.05 || l.kpis.rupturas > 0)) return `<span class="badge warning">${c.estoqueLojas.filter((l) => l.kpis.perdaPct >= 0.05 || l.kpis.rupturas > 0).length}</span>`;
    return '';
  };
  document.getElementById('tabs').innerHTML = TABS.map((t) => `<button type="button" role="tab" data-tab="${t.id}" aria-selected="${state.tab === t.id}">${t.label}${badge(t.id)}</button>`).join('');
  document.querySelector('[data-tab][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  const tabs = document.getElementById('tabs');
  const bar = tabs.parentElement;
  const update = () => bar.classList.toggle('at-end', tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 2);
  tabs.addEventListener('scroll', update, { passive: true });
  update();
}

// --- render ----------------------------------------------------------------------
export function render() {
  cardSeq = 0;
  if (!hasData()) state.tab = 'dados';
  renderFilters();
  const main = document.getElementById('main');
  if (!hasData()) {
    renderTabs(null);
    main.innerHTML = sectionImport() + `<section><p class="empty">Nenhum relatório carregado ainda. Exporte do painel Market4u os relatórios e arraste aqui.</p></section>`;
    bind();
    return;
  }
  const f = filtered();
  const c = contexto(f);
  renderTabs(c);
  const content = {
    visao: () => sectionOverview(f, c),
    financeiro: () => (c.temB ? `<section><h2>Caixa <span class="scope">boletos abertos × receita projetada</span></h2><div class="grid">${cardCaixa(f, c)}</div></section>` + sectionBoletos(f, c) + sectionReposicao(f, c) : emptyTab('Importe os <b>boletos de reabastecimento</b> na aba Dados para ver caixa, vencimentos e reposição × vendas.')),
    cobrancas: () => sectionCobrancas(f, c),
    operacao: () => sectionOperacao(f, c),
    vendas: () => sectionVendas(f, c),
    produtos: () => sectionProdutos(f, c),
    lojas: () => sectionLojas(f, c),
    clientes: () => sectionClientes(f, c),
    dados: () => sectionImport(),
  };
  main.innerHTML = (content[state.tab] ?? content.visao)();
  bind();
}

function bind() {
  const input = document.getElementById('file-input');
  input?.addEventListener('change', () => ingestFiles([...input.files]));
  const dz = document.getElementById('dropzone');
  if (dz) {
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); ingestFiles([...e.dataTransfer.files]); });
  }
  document.getElementById('clear-data')?.addEventListener('click', () => {
    state.data = EMPTY();
    state.sources = EMPTY();
    state.sample = false;
    state.notice = null;
    state.firstSeen = {};
    state.feito = {};
    state.verificado = {};
    save();
    render();
  });
  for (const btn of document.querySelectorAll('[data-tab]')) {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      try { history.replaceState(null, '', `#${state.tab}`); } catch { /* sem histórico */ }
      save();
      render();
      window.scrollTo({ top: 0 });
    });
  }
  for (const btn of document.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => { state.filter.preset = btn.dataset.preset; save(); render(); });
  }
  document.getElementById('from')?.addEventListener('change', (e) => { state.filter.from = e.target.value || null; save(); render(); });
  document.getElementById('to')?.addEventListener('change', (e) => { state.filter.to = e.target.value || null; save(); render(); });
  document.getElementById('pdx')?.addEventListener('change', (e) => { state.filter.pdxId = e.target.value; save(); render(); });
  for (const btn of document.querySelectorAll('[data-view]')) {
    btn.addEventListener('click', () => {
      const cardEl = btn.closest('[data-card]');
      for (const b of cardEl.querySelectorAll(':scope > .card-head [data-view]')) b.setAttribute('aria-pressed', String(b === btn));
      for (const panel of cardEl.querySelectorAll(':scope > [data-view-panel]')) panel.hidden = panel.dataset.viewPanel !== btn.dataset.view;
    });
  }
  for (const btn of document.querySelectorAll('[data-more]')) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.more;
      const step = Number(btn.dataset.step) || 25;
      const atual = state.limites[key] ?? (key === 'transacoes' ? (isMobile() ? 25 : 100) : 10);
      state.limites[key] = atual + step;
      render();
    });
  }
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      const ok = await copyText(text);
      const old = btn.textContent;
      btn.textContent = ok ? 'copiado' : 'selecione e copie';
      setTimeout(() => { btn.textContent = old; }, 1500);
    });
  }
  for (const btn of document.querySelectorAll('[data-done]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.done;
      if (state.feito[id] === state.hoje) delete state.feito[id];
      else state.feito[id] = state.hoje;
      save();
      render();
    });
  }
  for (const cb of document.querySelectorAll('[data-verified]')) {
    cb.addEventListener('change', () => {
      const id = cb.dataset.verified;
      if (cb.checked) state.verificado[id] = true;
      else delete state.verificado[id];
      save();
      render();
    });
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// tooltip global (mouse, teclado e toque)
function setupTooltip() {
  const tip = document.getElementById('tooltip');
  const touch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
  let atual = null;
  const show = (el, x, y) => {
    let data;
    try { data = JSON.parse(el.getAttribute('data-tip')); } catch { return; }
    tip.innerHTML = `<b>${esc(data.label)}</b>${data.lines.map((l) => esc(l)).join('<br>')}`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - r.width - 8))}px`;
    const above = y - r.height - 12;
    tip.style.top = `${above < 8 ? y + 16 : above}px`;
  };
  document.addEventListener('mousemove', (e) => {
    if (touch) return;
    const el = e.target.closest?.('[data-tip]');
    if (el) show(el, e.clientX, e.clientY); else tip.hidden = true;
  });
  document.addEventListener('click', (e) => {
    if (!touch) return;
    const el = e.target.closest?.('[data-tip]');
    if (el && el !== atual) {
      atual = el;
      const r = el.getBoundingClientRect();
      show(el, r.left + r.width / 2, r.top);
    } else {
      atual = null;
      tip.hidden = true;
    }
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.top);
  });
  document.addEventListener('focusout', () => { tip.hidden = true; });
}

export async function start() {
  setupTooltip();
  const hash = (location.hash || '').replace('#', '');
  if (TABS.some((t) => t.id === hash)) state.tab = hash;
  let lastW = `${chartWidth()}|${wideChartWidth()}|${isMobile()}`;
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = `${chartWidth()}|${wideChartWidth()}|${isMobile()}`;
      if (now !== lastW) { lastW = now; render(); }
    }, 150);
  });
  if (!restore()) await loadSample();
  render();
}
