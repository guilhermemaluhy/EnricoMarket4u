// Estado, importação dos relatórios e renderização do dashboard.
import { loadReport, mergeRecords, REPORT_TYPES, SITUACOES, EVENTOS } from './reports.js';
import * as M from './metrics.js';
import { hbar, columns, stacked, legend, table, heatmap, emptyChart } from './charts.js';
import { money, moneyShort, number, percent, shortDate, longDate, dateTime, weekday, hourLabel, escapeHtml as esc } from './format.js';
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
  { id: 'vendas', label: 'Vendas' },
  { id: 'produtos', label: 'Produtos' },
  { id: 'operacao', label: 'Operação' },
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
};

// --- persistência --------------------------------------------------------------
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ data: state.data, sources: state.sources, sample: state.sample, filter: state.filter, tab: state.tab }));
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
    if (saved.tab && TABS.some((t) => t.id === saved.tab)) state.tab = saved.tab;
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
    state.data[type] = loadReport(text).records;
    state.sources[type] = [{ name: `exemplo-${type}.csv`, rows: state.data[type].length, at: new Date().toISOString() }];
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
    produtos: M.filterProdutos(state.data.produtos, { ...range, pdxId }),
    boletos: M.filterBoletos(state.data.boletos, range),
    retornos: M.filterRetornos(state.data.retornos, { ...range, pdxId }),
    // posição de estoque é uma foto: usa o último inventário de cada loja, sem filtro de período
    inventario: M.filterInventario(state.data.inventario, { pdxId, pdxNome }, M.mapaCodigoPdx(state.data.produtos)),
  };
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
const tile = (label, value, detail = '', tone = '') =>
  `<div class="tile ${tone}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${detail ? `<div class="detail">${detail}</div>` : ''}</div>`;

let cardSeq = 0;
function card({ title, desc, chart, tableHtml, legendHtml = '', span = false }) {
  const id = `card-${++cardSeq}`;
  return `<div class="card ${span ? 'span-2' : ''}" data-card="${id}">
    <div class="card-head"><h3>${esc(title)}</h3>${desc ? `<span class="desc">${esc(desc)}</span>` : ''}
      <div class="seg toggle" role="group" aria-label="Visualização">
        <button type="button" data-view="chart" aria-pressed="true">Gráfico</button>
        <button type="button" data-view="table" aria-pressed="false">Tabela</button>
      </div></div>
    <div data-view-panel="chart">${chart}${legendHtml}</div>
    <div data-view-panel="table" hidden>${tableHtml}</div>
  </div>`;
}

const wideChartWidth = () => (typeof window !== 'undefined' && window.innerWidth > 760 ? 1120 : 560);
const pill = (situacao) => `<span class="pill ${SITUACOES[situacao].tone}">${SITUACOES[situacao].label}</span>`;
const money0 = (c, axis) => (axis ? moneyShort(c) : money(c));
const colsValor = (keyLabel) => [
  { label: keyLabel, get: (r) => r.key },
  { label: 'Valor', num: true, get: (r) => money(r.value) },
  { label: 'Qtd.', num: true, get: (r) => number(r.count) },
];

// --- seções ----------------------------------------------------------------------
function sectionImport() {
  const chips = Object.entries(REPORT_TYPES)
    .map(([type, { label }]) => {
      const srcs = state.sources[type];
      const rows = state.data[type].length;
      const bounds = M.dateBounds(state.data[type]);
      const meta = rows ? `${number(rows)} linhas · ${shortDate(bounds.min)}–${shortDate(bounds.max)}` : 'não carregado';
      return `<span class="source ${rows ? 'loaded' : ''}" title="${esc(srcs.map((s) => s.name).join(', '))}"><span class="dot"></span><b>${esc(label)}</b><span class="meta">${esc(meta)}</span></span>`;
    })
    .join('');
  const notice = state.notice ? `<p class="notice ${state.notice.tone === 'error' ? 'error' : ''}">${esc(state.notice.text)}</p>` : '';
  const sample = state.sample ? `<p class="notice">Mostrando <b>dados de exemplo</b> (um dia de operação). Importe seus relatórios para substituir.</p>` : '';
  const guia = `<div class="card"><div class="card-head"><h3>Como exportar do painel Market4u</h3></div><ol class="guide">
    <li><b>Transações</b> — Clientes › Transações › exportar CSV. Alimenta Vendas, Lojas, Clientes e a média diária do caixa.</li>
    <li><b>Produtos vendidos</b> — Relatórios › Produtos vendidos. Alimenta Produtos (margem) e cruza com o inventário.</li>
    <li><b>Boletos de reabastecimento</b> — Vendas de mercadorias do CD › Boletos. Alimenta Financeiro.</li>
    <li><b>Inventário</b> — Sistema PDV › Inventário. Posição de estoque, perdas e rupturas por loja.</li>
    <li><b>Remessas de retorno</b> — Sistema PDV › Retorno PDV. Produtos vencidos e avariados devolvidos ao CD.</li>
  </ol><p class="kicker">Exporte sempre o maior período possível: com 30 dias de transações a média diária, a tendência e a comparação com o período anterior ficam confiáveis.</p></div>`;
  return `<section>
    <div class="dropzone" id="dropzone">
      <p><b>Arraste os CSV exportados do painel Market4u</b> ou <label class="btn" for="file-input" style="cursor:pointer">escolher arquivos</label>
      <input id="file-input" type="file" accept=".csv,text/csv" multiple class="sr-only"></p>
      <span class="hint">Transações · Produtos vendidos · Boletos · Inventário · Remessas de retorno. O tipo é reconhecido pelo cabeçalho; reimportar o mesmo período não duplica registros.</span>
      <div class="sources">${chips}</div>
      ${hasData() ? `<button type="button" class="btn btn-ghost" id="clear-data">Limpar dados</button>` : ''}
    </div>${sample}${notice}${guia}
  </section>`;
}

function delta(atual, anterior, { invert = false, fmt = percent } = {}) {
  const d = M.variacao(atual, anterior);
  if (d == null) return '';
  const good = invert ? d < 0 : d > 0;
  const sign = d > 0 ? '+' : '';
  return ` · <span class="delta ${d === 0 ? '' : good ? 'up' : 'down'}" title="Período anterior: ${esc(fmt(anterior))}">${sign}${esc(percent(d))}</span> vs período anterior`;
}

function sectionOverview(f) {
  const v = M.vendasKpis(f.transacoes);
  const p = M.produtosKpis(f.produtos);
  const b = M.boletosKpis(f.boletos, state.hoje);
  const temT = state.data.transacoes.length > 0;
  const temP = state.data.produtos.length > 0;
  const temB = state.data.boletos.length > 0;
  // período anterior de mesmo tamanho, quando o filtro tem início e fim
  const ant = M.periodoAnterior(f.range);
  const pdxId = state.filter.pdxId || null;
  const vAnt = ant ? M.vendasKpis(M.filterTransacoes(state.data.transacoes, { ...ant, pdxId })) : null;
  const pAnt = ant ? M.produtosKpis(M.filterProdutos(state.data.produtos, { ...ant, pdxId })) : null;
  const tiles = [];
  if (temT) {
    const cob = M.cobrancasKpis(f.transacoes, state.hoje);
    tiles.push(tile('Faturamento', money(v.faturamentoCents), `${number(v.compras)} compras · ticket ${money(v.ticketMedioCents)}${v.recuperadoCents ? ` · +${money(v.recuperadoCents)} recuperados` : ''}${vAnt ? delta(v.faturamentoCents, vAnt.faturamentoCents, { fmt: money }) : ''}`));
    tiles.push(tile('Conversão de sessões', percent(v.taxaConversao), `${number(v.carrinhosAbandonados)} carrinhos abandonados (${money(v.valorCarrinhosCents)}) · ${number(v.comprasRemovidas)} compras removidas${vAnt ? delta(v.taxaConversao, vAnt.taxaConversao) : ''}`, v.taxaConversao < 0.6 ? 'warning' : ''));
    tiles.push(tile('Cobranças pendentes', money(cob.pendentesCents), cob.pendentes ? `${number(cob.pendentes)} cobranças · mais antiga há ${cob.maisAntigaDias} dias · ${money(cob.pagasCents)} recuperados no período` : `nenhuma pendente · ${money(cob.pagasCents)} recuperados no período`, cob.pendentes ? (cob.maisAntigaDias > 7 ? 'critical' : 'warning') : 'good'));
    tiles.push(tile('Clientes', number(v.clientesUnicos), `${number(v.clientesNovos)} na primeira compra${vAnt ? delta(v.clientesUnicos, vAnt.clientesUnicos, { fmt: number }) : ''}`));
  }
  if (temP) tiles.push(tile('Margem bruta', percent(p.margemPct), `${money(p.margemCents)} sobre ${money(p.receitaCents)} em ${number(p.itens)} itens${pAnt ? delta(p.margemCents, pAnt.margemCents, { fmt: money }) : ''}`, p.margemPct < 0.3 ? 'warning' : 'good'));
  if (temB) {
    tiles.push(tile('Boletos em aberto', money(b.abertosCents), `${number(b.abertos)} boletos · próximo ${b.proximoVencimento ? `${shortDate(b.proximoVencimento.data)} (${money(b.proximoVencimento.valorCents)})` : '—'}`));
    tiles.push(tile('Vencidos', money(b.vencidosCents), b.vencidos ? `${number(b.vencidos)} boletos${b.bloqueiaInadimplente ? ' · bloqueio por inadimplência ativo' : ''}` : 'nenhum boleto vencido', b.vencidos ? 'critical' : 'good'));
  }
  if (temT && temB) {
    const cob = M.cobertura(v.faturamentoCents, M.sum(f.boletos, (x) => x.valorCents));
    if (cob != null) tiles.push(tile('Vendas ÷ reposição', percent(cob), `faturamento sobre ${money(M.sum(f.boletos, (x) => x.valorCents))} em boletos gerados no período`, cob < 1 ? 'warning' : 'good'));
  }
  return `<section><h2>Visão geral <span class="scope">${esc(scopeLabel(f.range))}</span></h2><div class="tiles">${tiles.join('')}</div></section>`;
}

function scopeLabel(range) {
  const loja = state.filter.pdxId ? M.listPdx(state.data.transacoes, state.data.produtos).find((l) => l.id === state.filter.pdxId)?.nome : 'todas as lojas';
  const periodo = range.from || range.to ? `${range.from ? longDate(range.from) : '…'} a ${range.to ? longDate(range.to) : '…'}` : 'todo o período importado';
  return `${periodo} · ${loja}`;
}

function sectionDecisao(f) {
  if (!hasData()) return '';
  const temT = state.data.transacoes.length > 0;
  const temB = state.data.boletos.length > 0;
  const vendas = temT ? M.vendasKpis(f.transacoes) : null;
  const lojas = temT ? M.comparativoLojas(f.transacoes, f.produtos) : [];
  const b = temB ? M.boletosKpis(state.data.boletos, state.hoje) : null; // caixa olha todos os boletos abertos, não só o período
  const media = temT ? M.mediaDiaria(f.transacoes) : 0;
  const diasComDados = temT ? new Set(f.transacoes.filter((t) => t.compra).map((t) => t.data)).size : 0;
  const caixa = b ? M.fluxoCaixa(b.comSituacao, media, state.hoje, 14) : null;
  const revisar = M.produtosParaRevisar(f.produtos, 0.3);
  const estoqueLojas = M.ultimoInventarioPorLoja(f.inventario).map((l) => ({ ...l, kpis: M.estoqueKpis(l.itens) }));
  const recs = M.recomendacoes({
    vendas, lojas, boletos: b, caixa, revisar,
    fiscal: vendas ? { semNfce: vendas.compras - vendas.nfceEmitidas } : null,
    abandonosCategoria: temT ? M.abandonosPorCategoria(f.transacoes) : [],
    cobrancas: temT ? M.cobrancasKpis(f.transacoes, state.hoje) : null,
    diasComDados,
  }).concat(
    M.recomendacoesOperacao({
      estoquePorLoja: estoqueLojas,
      retornos: f.retornos.length ? M.retornosKpis(f.retornos) : null,
      retornosTop: M.retornosTopProdutos(f.retornos, 1),
    }),
  );
  const ordem = { critical: 0, warning: 1, info: 2, good: 3 };
  recs.sort((a, b) => ordem[a.tone] - ordem[b.tone]);
  if (recs.length > 1) {
    const i = recs.findIndex((r) => r.tone === 'good');
    if (i >= 0) recs.splice(i, 1);
  }
  const lista = recs.length
    ? `<ul class="actions">${recs.map((r) => `<li class="action ${r.tone}"><span class="stripe"></span><div><div class="title">${esc(r.titulo)}</div><div class="detail">${esc(r.detalhe)}</div><div class="todo"><b>O que fazer:</b> ${esc(r.acao)}</div></div>${r.valorCents != null ? `<div class="amount">${esc(money(r.valorCents))}</div>` : '<span></span>'}</li>`).join('')}</ul>`
    : `<p class="empty">Nada a recomendar com os dados carregados.</p>`;

  let caixaHtml = '';
  if (caixa) {
    const rows = caixa.rows;
    const chart = columns(rows.map((r) => ({ ...r, value: r.aPagarCents })), {
      fmt: money0, width: wideChartWidth(),
      labelFn: (d, i, full) => (full ? `${weekday(d)} ${longDate(d)}` : shortDate(d)),
      every: 1,
      color: (r) => (r.saldoCents < 0 ? 'var(--critical)' : 'var(--series-1)'),
      tipLines: (r) => [`vence ${money(r.aPagarCents)} (${r.boletos} boletos)`, `acumulado a pagar ${money(r.acumuladoCents)}`, `receita projetada ${money(r.receitaProjetadaCents)}`, `saldo ${money(r.saldoCents)}`],
    });
    const tab = table(
      [
        { label: 'Dia', get: (r) => `${weekday(r.key)} ${longDate(r.key)}` },
        { label: 'Vence no dia', num: true, get: (r) => (r.aPagarCents ? `${money(r.aPagarCents)} (${r.boletos})` : '—') },
        { label: 'Acumulado a pagar', num: true, get: (r) => money(r.acumuladoCents) },
        { label: 'Receita projetada', num: true, get: (r) => money(r.receitaProjetadaCents) },
        { label: 'Saldo', num: true, html: true, get: (r) => `<span class="${r.saldoCents < 0 ? 'neg' : 'pos'}">${esc(money(r.saldoCents))}</span>` },
      ],
      rows,
    ).replace(/<td class="num">(<span class="(neg|pos)">)/g, '<td class="num $2">$1');
    const resumo = `<p class="kicker">Atrasados <b>${esc(money(caixa.atrasadoCents))}</b> (${caixa.atrasados}) · vence em 7 dias <b>${esc(money(caixa.aPagar7dCents))}</b> · receita projetada em 7 dias <b>${esc(money(caixa.receita7dCents))}</b> (média de ${esc(money(media))}/dia${diasComDados ? ` em ${diasComDados} dia${diasComDados > 1 ? 's' : ''} com venda` : ''}) · saldo <b class="${caixa.saldo7dCents < 0 ? 'delta down' : 'delta up'}">${esc(money(caixa.saldo7dCents))}</b>${caixa.diasParaCobrir ? ` · seriam necessários ${caixa.diasParaCobrir} dias de venda para cobrir tudo o que vence até lá` : ''}</p>`;
    caixaHtml = card({
      title: 'Caixa: próximos 14 dias', desc: 'boletos abertos por vencimento (vermelho = acumulado maior que a receita projetada)',
      chart: resumo + chart,
      tableHtml: resumo + tab,
      span: true,
    });
  }
  return { acoes: `<section><h2>O que fazer <span class="scope">prioridades calculadas a partir dos relatórios · ${esc(scopeLabel(f.range))}</span></h2>${lista}</section>`, caixa: caixaHtml ? `<section><h2>Caixa <span class="scope">boletos abertos × receita projetada</span></h2><div class="grid">${caixaHtml}</div></section>` : '' };
}

function sectionOperacao(f) {
  const temI = state.data.inventario.length > 0;
  const temR = state.data.retornos.length > 0;
  if (!temI && !temR) return `<section><p class="empty">Importe o <b>inventário</b> e as <b>remessas de retorno</b> (Sistema PDV) na aba Dados para ver estoque, perdas e devoluções.</p></section>`;
  const colorLoja = storeColors();
  let html = '';
  if (temI) {
    const lojas = M.ultimoInventarioPorLoja(f.inventario);
    const itens = lojas.flatMap((l) => l.itens);
    const k = M.estoqueKpis(itens);
    const tiles = [
      tile('Estoque a custo', money(k.custoCents), `${number(k.unidades)} unidades em ${number(k.skus)} SKUs · ${money(k.vendaCents)} a preço de venda`),
      tile('Perda no inventário', money(k.perdaCustoCents), `${number(k.perdaUnidades)} unidades em ${number(k.skusComFalta)} produtos · ${percent(k.perdaPct)} do estoque · ${money(k.perdaVendaCents)} em venda perdida`, k.perdaPct >= 0.05 ? 'critical' : k.perdaCustoCents ? 'warning' : 'good'),
      tile('Acuracidade', percent(k.acuracidade), `itens contados iguais ao sistema · sobras ${number(k.sobraUnidades)} un (${money(k.sobraCustoCents)})`, k.acuracidade < 0.8 ? 'warning' : 'good'),
      tile('Rupturas', number(k.rupturas), `produtos zerados · mais ${number(k.estoqueBaixo)} com 1 unidade`, k.rupturas ? 'warning' : 'good'),
    ];
    const invDesc = lojas.map((l) => `${l.pdx}: inventário #${l.inventario} de ${longDate(l.data)}`).join(' · ');
    const perdasCat = M.perdasPorCategoria(itens);
    const perdasTop = M.perdasTopProdutos(itens, 10);
    const estCat = M.estoquePorCategoria(itens);
    const rep = M.reposicaoPrioritaria(itens, f.produtos, 20);
    const cards = [
      card({
        title: 'Perdas por categoria', desc: 'custo do que faltou na contagem',
        chart: hbar(perdasCat, { fmt: money, labelW: 180, color: () => 'var(--critical)', sub: (r) => `· ${number(r.unidades)} un` }),
        tableHtml: table([{ label: 'Categoria', get: (r) => r.key }, { label: 'Perda (custo)', num: true, get: (r) => money(r.value) }, { label: 'Unid.', num: true, get: (r) => number(r.unidades) }, { label: 'Produtos', num: true, get: (r) => number(r.count) }], perdasCat),
      }),
      card({
        title: 'Estoque por categoria', desc: 'valor a custo · onde o dinheiro está parado',
        chart: hbar(estCat, { fmt: money, labelW: 180, sub: (r) => `· ${number(r.unidades)} un · ${r.rupturas} zerados` }),
        tableHtml: table([{ label: 'Categoria', get: (r) => r.key }, { label: 'Custo', num: true, get: (r) => money(r.value) }, { label: 'Unid.', num: true, get: (r) => number(r.unidades) }, { label: 'SKUs', num: true, get: (r) => number(r.skus) }, { label: 'Zerados', num: true, get: (r) => number(r.rupturas) }], estCat),
      }),
    ];
    const perdasHtml = table(
      [
        { label: '#', html: true, get: (r) => `<span class="rank">${perdasTop.indexOf(r) + 1}</span>` },
        { label: 'Produto', get: (r) => r.key },
        { label: 'Categoria', get: (r) => r.categoria },
        { label: 'Loja', get: (r) => r.loja },
        { label: 'Faltaram', num: true, get: (r) => `${number(r.unidades)} un` },
        { label: 'Perda (custo)', num: true, get: (r) => money(r.value) },
      ],
      perdasTop,
    );
    const repHtml = rep.length
      ? table(
          [
            { label: 'Produto', get: (r) => r.produto },
            { label: 'Categoria', get: (r) => r.categoria },
            { label: 'Loja', get: (r) => r.pdx },
            { label: 'Em estoque', num: true, html: true, get: (r) => `<span class="${r.posicaoAjustada <= 0 ? 'neg' : ''}">${number(r.posicaoAjustada)}</span>` },
            { label: 'Vendidos no período', num: true, get: (r) => number(r.vendidos) },
            { label: 'Preço', num: true, get: (r) => money(r.vendaUnitCents) },
            { label: 'Custo', num: true, get: (r) => money(r.custoUnitCents) },
          ],
          rep,
        )
      : `<p class="empty">Nenhum produto zerado ou com 1 unidade.</p>`;
    html += `<section><h2>Estoque <span class="scope">${esc(invDesc)} · foto do último inventário, sem filtro de período</span></h2>
      <div class="tiles" style="margin-bottom:12px">${tiles.join('')}</div>
      <div class="grid">${cards.join('')}
        <div class="card span-2"><div class="card-head"><h3>Maiores perdas no inventário</h3><span class="desc">produtos que mais faltaram na contagem · candidatos a furto, quebra ou erro de registro</span></div>${perdasHtml}</div>
        <div class="card span-2"><div class="card-head"><h3>Reposição prioritária</h3><span class="desc">zerados ou com 1 unidade, primeiro os que mais venderam no período</span></div>${repHtml}</div>
      </div></section>`;
  }
  if (temR) {
    const k = M.retornosKpis(f.retornos);
    const porLoja = M.retornosPorLoja(f.retornos);
    const semanas = M.retornosPorSemana(f.retornos);
    const top = M.retornosTopProdutos(f.retornos, 10);
    const tipoColors = ['var(--series-2)', 'var(--series-7)', 'var(--series-4)'];
    const tiles = [
      tile('Devolvido ao CD', money(k.custoCents), `${number(k.unidades)} unidades em ${number(k.remessas)} remessas`, k.custoCents ? 'warning' : 'good'),
      tile('Vencidos', money(k.vencidosCents), 'produtos que passaram da validade na gôndola', k.vencidosCents ? 'warning' : ''),
      tile('Avarias', money(k.avariasCents), 'embalagem danificada ou produto impróprio'),
    ];
    const cards = [
      card({
        title: 'Devoluções por loja', desc: 'custo dos produtos devolvidos',
        chart: hbar(porLoja, { fmt: money, labelW: 190, color: colorLoja, sub: (r) => `· ${number(r.unidades)} un` }),
        tableHtml: table([{ label: 'Loja', get: (r) => r.key }, { label: 'Custo', num: true, get: (r) => money(r.value) }, { label: 'Unid.', num: true, get: (r) => number(r.unidades) }], porLoja),
      }),
      card({
        title: 'Devoluções por semana', desc: 'vencidos + avarias',
        chart: columns(semanas, { fmt: money0, labelFn: (k2) => k2.replace('-S', ' s'), tipLines: (r) => [money(r.value), `${number(r.unidades)} unidades`] }) + stacked(k.porTipo, { fmt: money, colors: tipoColors }),
        legendHtml: legend(k.porTipo.map((r, i) => ({ label: `${r.key} · ${money(r.value)} · ${number(r.unidades)} un`, color: tipoColors[i % tipoColors.length] }))),
        tableHtml: table([{ label: 'Semana', get: (r) => r.key.replace('-S', ' · sem. ') }, { label: 'Custo', num: true, get: (r) => money(r.value) }, { label: 'Unid.', num: true, get: (r) => number(r.unidades) }], semanas),
      }),
    ];
    const topHtml = table(
      [
        { label: '#', html: true, get: (r) => `<span class="rank">${top.indexOf(r) + 1}</span>` },
        { label: 'Produto', get: (r) => r.key },
        { label: 'Motivo', get: (r) => r.tipo },
        { label: 'Lojas', get: (r) => r.lojas },
        { label: 'Unid.', num: true, get: (r) => number(r.unidades) },
        { label: 'Custo', num: true, get: (r) => money(r.value) },
      ],
      top,
    );
    html += `<section><h2>Devoluções ao CD <span class="scope">remessas de retorno · ${esc(scopeLabel(f.range))}</span></h2>
      <div class="tiles" style="margin-bottom:12px">${tiles.join('')}</div>
      <div class="grid">${cards.join('')}<div class="card span-2"><div class="card-head"><h3>Produtos mais devolvidos</h3><span class="desc">reduzir o pedido destes itens ou girar melhor a validade</span></div>${topHtml}</div></div></section>`;
  }
  return html;
}

function sectionLojas(f) {
  if (state.data.transacoes.length === 0) return '';
  const lojas = M.comparativoLojas(f.transacoes, f.produtos);
  if (lojas.length === 0) return '';
  const temP = state.data.produtos.length > 0;
  const cols = [
    { label: '#', html: true, get: (r) => `<span class="rank">${lojas.indexOf(r) + 1}</span>` },
    { label: 'Loja', get: (r) => r.key },
    { label: 'Faturamento', num: true, get: (r) => money(r.faturamentoCents) },
    { label: 'Share', num: true, get: (r) => percent(r.share) },
    { label: 'Compras', num: true, get: (r) => number(r.compras) },
    { label: 'Ticket', num: true, get: (r) => money(r.ticketCents) },
    { label: 'Itens/compra', num: true, get: (r) => number(r.itensPorCompra) },
    { label: 'Conversão', num: true, html: true, get: (r) => `<span class="${r.sessoes >= 5 && r.conversao < 0.6 ? 'neg' : ''}">${esc(percent(r.conversao))}</span> <span class="desc">(${r.carrinhos} carrinhos · ${r.removidas} removidas)</span>` },
    { label: 'Cobranças', num: true, html: true, get: (r) => (r.cobrancasPendentes ? `<span class="neg">${r.cobrancasPendentes} · ${esc(money(r.cobrancasPendentesCents))}</span>` : '—') },
    { label: '% app', num: true, get: (r) => percent(r.pctApp) },
    { label: 'Clientes', num: true, get: (r) => number(r.clientes) },
  ];
  if (temP) cols.push({ label: 'Margem', num: true, html: true, get: (r) => (r.margemPct == null ? '—' : `<span class="${r.margemPct < 0.3 ? 'neg' : ''}">${esc(percent(r.margemPct))}</span>`) });
  const heat = M.heatmapLojaPeriodo(f.transacoes);
  return `<section><h2>Lojas <span class="scope">comparativo e horário de pico</span></h2>
    <div class="grid"><div class="card span-2"><div class="card-head"><h3>Comparativo de lojas</h3><span class="desc">ordenado por faturamento · vermelho = conversão abaixo de 60% ou margem abaixo de 30%</span></div>${table(cols, lojas)}</div>
    <div class="card span-2"><div class="card-head"><h3>Faturamento por loja e período do dia</h3><span class="desc">quando cada loja vende: orienta reposição e visitas</span></div>${heatmap(heat, { fmt: money })}</div></div></section>`;
}

function sectionClientes(f) {
  if (state.data.transacoes.length === 0) return '';
  const rec = M.recorrencia(f.transacoes);
  const top = M.topClientes(f.transacoes, 10);
  const cat = M.abandonosPorCategoria(f.transacoes);
  const canal = M.abandonosPorCanal(f.transacoes);
  const recColors = ['var(--series-4)', 'var(--series-1)', 'var(--series-3)', 'var(--series-7)'];
  const cards = [
    card({
      title: 'Fidelidade', desc: 'faturamento por histórico de compras do cliente',
      chart: stacked(rec.filter((r) => r.value), { fmt: money, colors: rec.filter((r) => r.value).map((r) => recColors[M.FAIXAS_RECORRENCIA.indexOf(r.key)]) }),
      legendHtml: legend(rec.map((r, i) => ({ label: `${r.key} · ${money(r.value)} · ${r.count}`, color: recColors[i] }))),
      tableHtml: table(colsValor('Histórico do cliente'), rec),
    }),
    card({
      title: 'Carrinhos abandonados', desc: 'por categoria e por canal',
      chart: (cat.length ? hbar(cat, { fmt: (v) => `${number(v)}`, labelW: 190 }) : emptyChart()) + (canal.length ? stacked(canal, { fmt: (v) => `${number(v)} carrinhos`, colors: ['var(--series-1)', 'var(--series-2)'] }) : ''),
      legendHtml: legend(canal.map((r, i) => ({ label: `${r.key} · ${number(r.value)}`, color: ['var(--series-1)', 'var(--series-2)'][i % 2] }))),
      tableHtml: table([{ label: 'Categoria', get: (r) => r.key }, { label: 'Carrinhos', num: true, get: (r) => number(r.value) }], cat) + table([{ label: 'Canal', get: (r) => r.key }, { label: 'Carrinhos', num: true, get: (r) => number(r.value) }], canal),
    }),
  ];
  const topHtml = table(
    [
      { label: '#', html: true, get: (r) => `<span class="rank">${top.indexOf(r) + 1}</span>` },
      { label: 'Cliente', get: (r) => r.nome },
      { label: 'Loja', get: (r) => r.loja },
      { label: 'Gasto no período', num: true, get: (r) => money(r.value) },
      { label: 'Compras no período', num: true, get: (r) => number(r.count) },
      { label: 'Histórico', num: true, get: (r) => `${money(r.historicoCents)} em ${number(r.comprasHistorico)} compras` },
      { label: 'Última compra', get: (r) => dateTime(r.ultima) },
    ],
    top,
  );
  return `<section><h2>Clientes <span class="scope">quem compra e quem desiste</span></h2><div class="grid">${cards.join('')}<div class="card span-2"><div class="card-head"><h3>Top 10 clientes</h3><span class="desc">no período, com o histórico que o painel informa</span></div>${topHtml}</div></div></section>`;
}

function sectionCobrancas(f) {
  if (state.data.transacoes.length === 0) return `<section><p class="empty">Importe o relatório de <b>transações</b> na aba Dados. As cobranças vêm dele (eventos "Cobrança pendente" e "Pagamento efetuada (cobrança)").</p></section>`;
  const k = M.cobrancasKpis(f.transacoes, state.hoje);
  const porLoja = M.cobrancasPorLoja(f.transacoes);
  const semanas = M.cobrancasPorSemana(f.transacoes);
  const clientes = M.clientesEmCobranca(f.transacoes);
  const colorLoja = storeColors();
  const agingColor = (r) => (/até 3/.test(r.key) ? 'var(--series-1)' : /4–7/.test(r.key) ? 'var(--warning)' : 'var(--critical)');
  const agingPill = (dias) => `<span class="pill ${dias <= 3 ? 'neutral' : dias <= 7 ? 'warning' : 'critical'}">${dias} dia${dias === 1 ? '' : 's'}</span>`;
  const statusPill = (st) => `<span class="pill ${/bloquead/i.test(st ?? '') ? 'critical' : /desativ/i.test(st ?? '') ? 'warning' : 'good'}">${esc(st ?? '—')}</span>`;
  const riscoPill = (r) => `<span class="pill ${r === 'alto' ? 'critical' : r === 'medio' ? 'warning' : 'good'}">${r === 'alto' ? 'Alto' : r === 'medio' ? 'Médio' : 'Baixo'}</span>`;
  const tiles = [
    tile('Pendente', money(k.pendentesCents), k.pendentes ? `${number(k.pendentes)} cobranças · ${number(k.itensPendentes)} itens · ticket ${money(k.ticketPendenteCents)}` : 'nenhuma cobrança em aberto', k.pendentes ? 'critical' : 'good'),
    tile('Recuperado no período', money(k.pagasCents), `${number(k.pagas)} cobranças pagas`, k.pagas ? 'good' : ''),
    tile('Taxa de recuperação', k.taxaRecuperacaoValor == null ? '—' : percent(k.taxaRecuperacaoValor), k.emitidas ? `em valor · ${percent(k.taxaRecuperacaoQtd)} em quantidade (${number(k.pagas)} de ${number(k.emitidas)})` : 'sem cobranças no período', k.taxaRecuperacaoValor == null ? '' : k.taxaRecuperacaoValor < 0.5 ? 'warning' : 'good'),
    tile('Mais antiga em aberto', k.maisAntigaDias == null ? '—' : `${k.maisAntigaDias} dias`, k.pendentes ? `idade média ${number(k.idadeMediaDias)} dias · ${number(k.comTaxa)} com taxa de cobrança` : '', k.maisAntigaDias > 7 ? 'critical' : k.maisAntigaDias > 3 ? 'warning' : ''),
    tile('Clientes de risco', number(clientes.filter((c) => c.risco === 'alto').length), `${number(k.reincidentes)} reincidentes · ${number(k.pendentesBloqueados)} pendências de cliente bloqueado ou desativado`, clientes.some((c) => c.risco === 'alto') ? 'critical' : 'good'),
  ];
  const cards = [
    card({
      title: 'Envelhecimento das pendências', desc: 'valor em aberto por tempo desde a cobrança',
      chart: columns(k.aging, { fmt: money0, labelFn: (x) => x, color: agingColor, tipLines: (r) => [money(r.value), `${r.count} cobranças`] }),
      legendHtml: legend([{ label: 'até 3 dias', color: 'var(--series-1)' }, { label: '4–7 dias', color: 'var(--warning)' }, { label: '8 dias ou mais', color: 'var(--critical)' }]),
      tableHtml: table([{ label: 'Faixa', get: (r) => r.key }, { label: 'Valor', num: true, get: (r) => money(r.value) }, { label: 'Cobranças', num: true, get: (r) => number(r.count) }], k.aging),
    }),
    card({
      title: 'Por semana', desc: 'valor das cobranças geradas (pendentes) e pagas em cada semana',
      chart: columns(semanas, { fmt: money0, labelFn: (w) => w.replace('-S', ' s'), tipLines: (r) => [`pendentes ${money(r.pendentesCents)} (${r.pendentes})`, `pagas ${money(r.pagasCents)} (${r.pagas})`] }),
      tableHtml: table([{ label: 'Semana', get: (r) => r.key.replace('-S', ' · sem. ') }, { label: 'Pendentes', num: true, get: (r) => `${money(r.pendentesCents)} (${r.pendentes})` }, { label: 'Pagas', num: true, get: (r) => `${money(r.pagasCents)} (${r.pagas})` }], semanas),
    }),
    card({
      title: 'Por loja', desc: 'pendente, recuperado e peso sobre o faturamento',
      chart: hbar(porLoja, { fmt: money, labelW: 190, color: colorLoja, sub: (r) => `· ${r.pendentes} pend. · ${money(r.pagasCents)} pagas`, tipLines: (r) => [`pendente ${money(r.pendentesCents)} (${r.pendentes})`, `recuperado ${money(r.pagasCents)} (${r.pagas})`, r.pctFaturamento == null ? '' : `${percent(r.pctFaturamento)} do faturamento da loja`] }),
      tableHtml: table(
        [
          { label: 'Loja', get: (r) => r.key },
          { label: 'Pendentes', num: true, get: (r) => `${money(r.pendentesCents)} (${r.pendentes})` },
          { label: 'Pagas', num: true, get: (r) => `${money(r.pagasCents)} (${r.pagas})` },
          { label: 'Recuperação', num: true, get: (r) => (r.recuperacao == null ? '—' : percent(r.recuperacao)) },
          { label: '% do faturamento', num: true, get: (r) => (r.pctFaturamento == null ? '—' : percent(r.pctFaturamento)) },
        ],
        porLoja,
      ),
    }),
  ];
  const pendentesHtml = k.listaPendentes.length
    ? table(
        [
          { label: 'Em aberto', html: true, get: (t) => agingPill(t.dias) },
          { label: 'Cobrança', get: (t) => dateTime(t.dataHora) },
          { label: 'Loja', get: (t) => t.pdx },
          { label: 'Cliente', html: true, get: (t) => `${esc(t.cliente ?? t.clienteId ?? '—')} ${statusPill(t.statusCliente)}` },
          { label: 'Histórico', num: true, get: (t) => `${money(t.totalGastoCliente)} · ${number(t.comprasCliente)} compras` },
          { label: 'Itens', num: true, get: (t) => number(t.qtdeProdutos) },
          { label: 'Valor', num: true, get: (t) => money(t.totalCents) },
          { label: 'Taxa', get: (t) => (t.taxaCobranca ? 'Sim' : t.taxaCobranca === false ? 'Não' : '—') },
          { label: 'Forma', get: (t) => t.meioPagamento ?? 'link' },
          { label: 'Link', html: true, get: (t) => (t.linkPagamento ? `<a href="${esc(t.linkPagamento)}" target="_blank" rel="noopener">abrir</a>${t.idLinkPagamento ? ` <span class="desc">#${esc(t.idLinkPagamento)}</span>` : ''}` : '—') },
        ],
        k.listaPendentes,
      )
    : `<p class="empty">Nenhuma cobrança pendente no período.</p>`;
  const pagasHtml = k.listaPagas.length
    ? table(
        [
          { label: 'Pagamento', get: (t) => dateTime(t.dataHora) },
          { label: 'Loja', get: (t) => t.pdx },
          { label: 'Cliente', html: true, get: (t) => `${esc(t.cliente ?? t.clienteId ?? '—')} ${statusPill(t.statusCliente)}` },
          { label: 'Itens', num: true, get: (t) => number(t.qtdeProdutos) },
          { label: 'Valor', num: true, get: (t) => money(t.totalCents) },
          { label: 'Pagamento', get: (t) => (t.meioPagamento ? `${t.meioPagamento}${t.bandeira ? ` · ${t.bandeira}` : ''}` : '—') },
          { label: 'NFC-e', get: (t) => t.nfce ?? '—' },
        ],
        k.listaPagas,
      )
    : `<p class="empty">Nenhuma cobrança paga no período.</p>`;
  const clientesHtml = clientes.length
    ? table(
        [
          { label: 'Risco', html: true, get: (c) => riscoPill(c.risco) },
          { label: 'Cliente', html: true, get: (c) => `${esc(c.nome)} ${statusPill(c.status)}` },
          { label: 'Lojas', get: (c) => c.lojas },
          { label: 'Pendentes', num: true, get: (c) => (c.pendentes ? `${money(c.pendentesCents)} (${c.pendentes})` : '—') },
          { label: 'Pagas', num: true, get: (c) => (c.pagas ? `${money(c.pagasCents)} (${c.pagas})` : '—') },
          { label: 'Histórico', num: true, get: (c) => `${money(c.historicoCents)} · ${number(c.comprasHistorico)} compras` },
          { label: 'Última cobrança', get: (c) => dateTime(c.ultima) },
        ],
        clientes,
      )
    : '';
  return `<section><h2>Cobranças <span class="scope">itens levados sem pagamento · ${esc(scopeLabel(f.range))}</span></h2>
    <div class="tiles" style="margin-bottom:12px">${tiles.join('')}</div>
    <div class="grid">${cards.join('')}
      <div class="card span-2"><div class="card-head"><h3>Cobranças pendentes</h3><span class="desc">da mais antiga para a mais recente · abra o link para reenviar ao cliente</span></div>${pendentesHtml}</div>
      <div class="card span-2"><div class="card-head"><h3>Clientes em cobrança</h3><span class="desc">risco alto = reincidente ou pendência de cliente bloqueado/desativado · histórico ajuda a decidir entre cobrar com jeito e bloquear</span></div>${clientesHtml}</div>
      <div class="card span-2"><div class="card-head"><h3>Cobranças recuperadas</h3><span class="desc">pagamentos de cobrança no período</span></div>${pagasHtml}</div>
    </div>
    <p class="kicker" style="margin-top:10px">Como ler: uma cobrança paga aparece na data do pagamento, não na da cobrança original, então a taxa de recuperação de um período curto pode enganar. Com poucas cobranças, olhe o valor e os clientes, não a porcentagem.</p>
  </section>`;
}

function sectionVendas(f) {
  if (state.data.transacoes.length === 0) return '';
  const t = f.transacoes;
  const colorLoja = storeColors();
  const lojas = M.porLoja(t);
  const horas = M.porHora(t);
  const dias = M.porDia(t);
  const meios = M.porMeioPagamento(t);
  const vias = M.porVia(t);
  const abandonos = M.abandonosPorLoja(t);
  const viaColors = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
  const funil = M.funilEventos(t).map((r) => ({ ...r, label: EVENTOS[r.key]?.label ?? r.key }));
  const funilColor = { compra: 'var(--series-1)', carrinho: 'var(--warning)', removida: 'var(--ink-3)', estornada: 'var(--critical)', cobranca_pendente: 'var(--critical)', cobranca_paga: 'var(--good)' };
  const cards = [
    card({
      title: 'Funil de sessões', desc: 'o que aconteceu em cada sessão de compra',
      chart: hbar(funil.map((r) => ({ ...r, key: r.label, value: r.count, tipo: r.key, valor: r.value })), { fmt: (v) => number(v), labelW: 170, color: (r) => funilColor[r.tipo] ?? 'var(--series-1)', sub: (r) => (r.valor ? `· ${money(r.valor)}` : ''), tipLines: (r) => [`${number(r.value)} sessões`, r.valor ? `valor ${money(r.valor)}` : 'sem valor'] }),
      tableHtml: table([{ label: 'Evento', get: (r) => r.label }, { label: 'Sessões', num: true, get: (r) => number(r.count) }, { label: 'Valor', num: true, get: (r) => money(r.value) }], funil),
    }),
    card({
      title: 'Faturamento por loja', desc: 'compras efetuadas',
      chart: hbar(lojas, { fmt: money, color: colorLoja, labelW: 190, sub: (r) => `· ${r.count} compras` }),
      tableHtml: table(colsValor('Loja'), lojas),
    }),
    card({
      title: 'Vendas por hora do dia', desc: 'faturamento acumulado em cada hora',
      chart: columns(horas, { fmt: money0, labelFn: (h) => hourLabel(h), every: 3, tipLines: (r) => [money(r.value), `${r.count} compras`] }),
      tableHtml: table([{ label: 'Hora', get: (r) => hourLabel(r.key) }, { label: 'Faturamento', num: true, get: (r) => money(r.value) }, { label: 'Compras', num: true, get: (r) => number(r.count) }], horas.filter((h) => h.count)),
    }),
    card({
      title: 'Faturamento por dia', desc: dias.length <= 1 ? 'importe mais dias para ver a tendência' : `${dias.length} dias`,
      chart: columns(dias, { fmt: money0, labelFn: (d, i, full) => (full ? `${weekday(d)} ${longDate(d)}` : shortDate(d)), every: Math.max(1, Math.ceil(dias.length / 10)), tipLines: (r) => [money(r.value), `${r.count} compras`] }),
      tableHtml: table([{ label: 'Dia', get: (r) => `${weekday(r.key)} ${longDate(r.key)}` }, { label: 'Faturamento', num: true, get: (r) => money(r.value) }, { label: 'Compras', num: true, get: (r) => number(r.count) }], dias),
    }),
    card({
      title: 'Meio de pagamento', desc: 'por valor',
      chart: hbar(meios, { fmt: money, sub: (r) => `· ${r.count}` }),
      tableHtml: table(colsValor('Meio'), meios),
    }),
    card({
      title: 'Canal de compra', desc: 'APP (celular) × POS (totem)',
      chart: stacked(vias, { fmt: money, colors: viaColors }),
      legendHtml: legend(vias.map((r, i) => ({ label: `${r.key} · ${money(r.value)} · ${r.count} compras`, color: viaColors[i % viaColors.length] }))),
      tableHtml: table(colsValor('Canal'), vias),
    }),
    card({
      title: 'Carrinhos abandonados por loja', desc: 'sessões “No carrinho” sem compra · valor que ficou no carrinho',
      chart: abandonos.length ? hbar(abandonos, { fmt: (v) => `${number(v)}`, color: colorLoja, labelW: 190, sub: (r) => (r.valor ? `· ${money(r.valor)}` : ''), tipLines: (r) => [`${number(r.value)} carrinhos`, `valor nos carrinhos ${money(r.valor)}`] }) : emptyChart(),
      tableHtml: table([{ label: 'Loja', get: (r) => r.key }, { label: 'Carrinhos', num: true, get: (r) => number(r.value) }, { label: 'Valor', num: true, get: (r) => money(r.valor) }], abandonos),
    }),
  ];
  return `<section><h2>Vendas <span class="scope">relatório de transações</span></h2><div class="grid">${cards.join('')}</div></section>`;
}

function sectionProdutos(f) {
  if (state.data.produtos.length === 0) return '';
  const p = f.produtos;
  const top = M.topProdutos(p, 10);
  const cats = M.porCategoria(p);
  const fabs = M.porFabricante(p, 10);
  const sexo = M.porSexo(p);
  const faixas = M.porFaixaEtaria(p);
  const margemPct = (r) => (r.value ? r.margem / r.value : 0);
  const colsMargem = (keyLabel) => [
    { label: keyLabel, get: (r) => r.key },
    { label: 'Receita', num: true, get: (r) => money(r.value) },
    { label: 'Custo', num: true, get: (r) => money(r.custo) },
    { label: 'Margem', num: true, get: (r) => `${money(r.margem)} (${percent(margemPct(r))})` },
    { label: 'Unid.', num: true, get: (r) => number(r.quantidade) },
  ];
  const margemColor = (r) => (margemPct(r) < 0.3 ? 'var(--series-2)' : 'var(--series-1)');
  const sexoColors = ['var(--series-1)', 'var(--series-5)', 'var(--series-3)'];
  const cards = [
    card({
      title: 'Top 10 produtos', desc: 'por receita · laranja = margem abaixo de 30%',
      chart: hbar(top, { fmt: money, color: margemColor, sub: (r) => `· ${percent(margemPct(r))} · ${number(r.quantidade)} un`, labelW: 230, tipLines: (r) => [money(r.value), `margem ${money(r.margem)} (${percent(margemPct(r))})`, `${number(r.quantidade)} unidades · ${r.categoria}`] }),
      tableHtml: table(colsMargem('Produto'), top),
    }),
    card({
      title: 'Categorias', desc: 'receita e margem',
      chart: hbar(cats, { fmt: money, color: margemColor, labelW: 170, sub: (r) => `· ${percent(margemPct(r))}`, tipLines: (r) => [money(r.value), `margem ${money(r.margem)} (${percent(margemPct(r))})`, `${number(r.quantidade)} unidades`] }),
      tableHtml: table(colsMargem('Categoria'), cats),
    }),
    card({
      title: 'Fabricantes', desc: 'top 10 por receita',
      chart: hbar(fabs, { fmt: money, color: margemColor, sub: (r) => `· ${percent(margemPct(r))}`, tipLines: (r) => [money(r.value), `margem ${percent(margemPct(r))}`, `${number(r.quantidade)} unidades`] }),
      tableHtml: table(colsMargem('Fabricante'), fabs),
    }),
    card({
      title: 'Quem compra', desc: 'receita por sexo e faixa etária',
      chart: stacked(sexo, { fmt: money, colors: sexoColors }) + columns(faixas, { fmt: money0, tipLines: (r) => [money(r.value), `${r.count} itens`] }),
      legendHtml: legend(sexo.map((r, i) => ({ label: `${r.key} · ${money(r.value)}`, color: sexoColors[i % sexoColors.length] }))),
      tableHtml: table(colsValor('Sexo'), sexo) + table(colsValor('Faixa etária'), faixas),
    }),
  ];
  const revisar = M.produtosParaRevisar(p, 0.3, 15);
  const contrib = M.contribuicaoMargem(p, 10);
  cards.push(
    card({
      title: 'Quem paga a conta', desc: 'top 10 produtos por margem em R$',
      chart: hbar(contrib, { fmt: money, labelW: 230, sub: (r) => `· ${number(r.quantidade)} un`, tipLines: (r) => [`margem ${money(r.value)}`, `receita ${money(r.receita)}`, `${number(r.quantidade)} unidades`] }),
      tableHtml: table([{ label: 'Produto', get: (r) => r.key }, { label: 'Margem', num: true, get: (r) => money(r.value) }, { label: 'Receita', num: true, get: (r) => money(r.receita) }, { label: 'Unid.', num: true, get: (r) => number(r.quantidade) }], contrib),
    }),
  );
  const revisarHtml = revisar.length
    ? table(
        [
          { label: 'Produto', get: (r) => r.key },
          { label: 'Categoria', get: (r) => r.categoria },
          { label: 'Unid.', num: true, get: (r) => number(r.quantidade) },
          { label: 'Preço médio', num: true, get: (r) => money(r.precoMedioCents) },
          { label: 'Custo', num: true, get: (r) => money(r.custoMedioCents) },
          { label: 'Margem', num: true, html: true, get: (r) => `<span class="neg">${esc(percent(r.margemPct))}</span>` },
          { label: 'Preço p/ 30%', num: true, get: (r) => money(r.precoSugeridoCents) },
          { label: 'Margem perdida', num: true, get: (r) => money(r.margemPerdidaCents) },
        ],
        revisar,
      )
    : `<p class="empty">Todos os produtos vendidos no período têm margem de 30% ou mais.</p>`;
  return `<section><h2>Produtos <span class="scope">relatório de produtos vendidos</span></h2><div class="grid">${cards.join('')}<div class="card span-2"><div class="card-head"><h3>Produtos com margem a revisar</h3><span class="desc">abaixo de 30% · preço sugerido para atingir 30% com o custo atual · "margem perdida" = quanto faltou para 30% no período</span></div>${revisarHtml}</div></div></section>`;
}

function sectionBoletos(f) {
  if (state.data.boletos.length === 0) return '';
  const k = M.boletosKpis(f.boletos, state.hoje);
  const dias = M.vencimentosPorDia(k.comSituacao);
  const toneColor = { vencido: 'var(--critical)', vence_em_breve: 'var(--warning)', a_vencer: 'var(--series-1)', pago: 'var(--good)' };
  const lista = [...k.comSituacao].sort((a, b) => (a.vencimento ?? '').localeCompare(b.vencimento ?? '') || a.id.localeCompare(b.id));
  const tiles = [
    tile('Vencidos', money(k.vencidosCents), `${number(k.vencidos)} boletos`, k.vencidos ? 'critical' : 'good'),
    tile('Vencem em até 3 dias', money(k.venceEmBreveCents), `${number(k.venceEmBreve)} boletos`, k.venceEmBreve ? 'warning' : ''),
    tile('A vencer', money(k.aVencerCents), `${number(k.aVencer)} boletos`),
    tile('Pagos', money(k.pagosCents), `${number(k.pagos)} boletos`, k.pagos ? 'good' : ''),
    tile('Total no período', money(k.totalCents), `${number(k.quantidade)} boletos gerados`),
  ];
  const cards = [
    card({
      title: 'Vencimentos por dia', desc: 'valor a pagar em cada data',
      chart: columns(dias, { fmt: money0, width: wideChartWidth(), labelFn: (d, i, full) => (full ? `${weekday(d)} ${longDate(d)}` : shortDate(d)), every: Math.max(1, Math.ceil(dias.length / 16)), color: (r) => toneColor[r.situacao], tipLines: (r) => [money(r.value), `${r.count} boletos · ${SITUACOES[r.situacao].label}`] }),
      legendHtml: legend(Object.entries(SITUACOES).map(([s, { label }]) => ({ label, color: toneColor[s] }))),
      tableHtml: table([{ label: 'Vencimento', get: (r) => longDate(r.key) }, { label: 'Situação', html: true, get: (r) => pill(r.situacao) }, { label: 'Valor', num: true, get: (r) => money(r.value) }, { label: 'Boletos', num: true, get: (r) => number(r.count) }], dias),
      span: true,
    }),
  ];
  const lista_html = table(
    [
      { label: 'Vencimento', get: (b) => `${weekday(b.vencimento)} ${longDate(b.vencimento)}` },
      { label: 'Situação', html: true, get: (b) => pill(b.situacao) },
      { label: 'Valor', num: true, get: (b) => money(b.valorCents) },
      { label: 'Nº cobrança', get: (b) => b.numeroCobranca ?? '—' },
      { label: 'Nota fiscal', get: (b) => (b.nota ? `${b.nota} (${shortDate(b.emissaoNota)})` : 'não emitida') },
      { label: 'Picklist', get: (b) => `${b.picklist ?? '—'} · ${b.dataPicklist ?? ''}` },
      { label: 'Gerado em', get: (b) => dateTime(b.geradoEm) },
      { label: 'Boleto', html: true, get: (b) => (b.link ? `<a href="${esc(b.link)}" target="_blank" rel="noopener">abrir</a>` : '—') },
    ],
    lista,
  );
  return `<section><h2>Reabastecimento <span class="scope">boletos do CD · sem filtro de loja</span></h2>
    <div class="tiles" style="margin-bottom:12px">${tiles.join('')}</div>
    <div class="grid">${cards.join('')}<div class="card span-2"><div class="card-head"><h3>Boletos</h3><span class="desc">ordenados por vencimento</span></div>${lista_html}</div></div></section>`;
}

function sectionReposicao(f) {
  if (!state.data.boletos.length || !state.data.transacoes.length) return '';
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
  return `<section><h2>Reposição × vendas <span class="scope">por semana · só compara bem quando os dois relatórios cobrem as mesmas datas</span></h2><div class="card">${html}</div></section>`;
}

function sectionTransacoes(f) {
  if (state.data.transacoes.length === 0) return '';
  const rows = [...f.transacoes].sort((a, b) => (b.dataHora ?? '').localeCompare(a.dataHora ?? '')).slice(0, 100);
  const html = table(
    [
      { label: 'Data', get: (t) => dateTime(t.dataHora) },
      { label: 'Loja', get: (t) => t.pdx },
      { label: 'Evento', html: true, get: (t) => { const e = EVENTOS[t.tipoEvento] ?? EVENTOS.outro; return `<span class="pill ${e.tone}">${esc(e.label)}</span>` + (t.categoriaEvento ? ` <span class="desc">${esc(t.categoriaEvento)}</span>` : ''); } },
      { label: 'Cliente', get: (t) => `${t.cliente ?? '—'}${t.comprasCliente ? ` (${t.comprasCliente}ª compra)` : ''}` },
      { label: 'Canal', get: (t) => t.via ?? '—' },
      { label: 'Pagamento', get: (t) => (t.meioPagamento ? `${t.meioPagamento}${t.bandeira ? ` · ${t.bandeira}` : ''}` : '—') },
      { label: 'Itens', num: true, get: (t) => number(t.qtdeProdutos) },
      { label: 'Total', num: true, get: (t) => (t.totalCents ? money(t.totalCents) : '—') },
      { label: 'NFC-e', get: (t) => t.nfce ?? '—' },
    ],
    rows,
  );
  return `<section><h2>Últimas transações <span class="scope">${rows.length} de ${f.transacoes.length}</span></h2><div class="card">${html}</div></section>`;
}

// --- filtros (cabeçalho) ---------------------------------------------------------
function renderFilters() {
  const lojas = M.listPdx(state.data.transacoes, state.data.produtos);
  const range = currentRange();
  const custom = state.filter.preset === 'custom';
  document.getElementById('filters').innerHTML = `
    <label for="preset">Período</label>
    <div class="seg" id="preset" role="group">${PRESETS.map((p) => `<button type="button" data-preset="${p.id}" aria-pressed="${state.filter.preset === p.id}">${p.label}</button>`).join('')}</div>
    <span ${custom ? '' : 'hidden'}><input type="date" id="from" value="${state.filter.from ?? ''}" aria-label="De"> – <input type="date" id="to" value="${state.filter.to ?? ''}" aria-label="Até"></span>
    <label for="pdx">Loja</label>
    <select id="pdx"><option value="">Todas</option>${lojas.map((l) => `<option value="${l.id}" ${state.filter.pdxId === l.id ? 'selected' : ''}>${esc(l.nome)}</option>`).join('')}</select>`;
  void range;
}

// --- render ----------------------------------------------------------------------
function renderTabs() {
  const loaded = Object.values(state.data).filter((l) => l.length > 0).length;
  const total = Object.keys(REPORT_TYPES).length;
  const b = state.data.boletos.length ? M.boletosKpis(state.data.boletos, state.hoje) : null;
  const badge = (id) => {
    if (id === 'dados') return `<span class="badge ${loaded === total ? 'good' : ''}">${loaded}/${total}</span>`;
    if (id === 'financeiro' && b?.vencidos) return `<span class="badge critical">${b.vencidos}</span>`;
    if (id === 'cobrancas') { const n = state.data.transacoes.filter((t) => t.tipoEvento === 'cobranca_pendente').length; if (n) return `<span class="badge critical">${n}</span>`; }
    return '';
  };
  document.getElementById('tabs').innerHTML = TABS.map((t) => `<button type="button" role="tab" data-tab="${t.id}" aria-selected="${state.tab === t.id}">${t.label}${badge(t.id)}</button>`).join('');
  document.querySelector('[data-tab][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

export function render() {
  cardSeq = 0;
  if (!hasData()) state.tab = 'dados';
  renderFilters();
  renderTabs();
  const main = document.getElementById('main');
  if (!hasData()) {
    main.innerHTML = sectionImport() + `<section><p class="empty">Nenhum relatório carregado ainda. Exporte do painel Market4u os relatórios e arraste aqui.</p></section>`;
    bind();
    return;
  }
  const f = filtered();
  const content = {
    visao: () => { const d = sectionDecisao(f); return sectionOverview(f) + d.acoes; },
    cobrancas: () => sectionCobrancas(f),
    financeiro: () => {
      const d = sectionDecisao(f);
      return state.data.boletos.length ? d.caixa + sectionBoletos(f) + sectionReposicao(f) : `<section><p class="empty">Importe os <b>boletos de reabastecimento</b> na aba Dados para ver caixa, vencimentos e reposição × vendas.</p></section>`;
    },
    vendas: () => (state.data.transacoes.length ? sectionVendas(f) + sectionTransacoes(f) : `<section><p class="empty">Importe o relatório de <b>transações</b> na aba Dados.</p></section>`),
    produtos: () => (state.data.produtos.length ? sectionProdutos(f) : `<section><p class="empty">Importe o relatório de <b>produtos vendidos</b> na aba Dados.</p></section>`),
    operacao: () => sectionOperacao(f),
    lojas: () => (state.data.transacoes.length ? sectionLojas(f) : `<section><p class="empty">Importe o relatório de <b>transações</b> na aba Dados.</p></section>`),
    clientes: () => (state.data.transacoes.length ? sectionClientes(f) : `<section><p class="empty">Importe o relatório de <b>transações</b> na aba Dados.</p></section>`),
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
      for (const b of cardEl.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b === btn));
      for (const panel of cardEl.querySelectorAll('[data-view-panel]')) panel.hidden = panel.dataset.viewPanel !== btn.dataset.view;
    });
  }
}

// tooltip global
function setupTooltip() {
  const tip = document.getElementById('tooltip');
  const show = (el, x, y) => {
    let data;
    try { data = JSON.parse(el.getAttribute('data-tip')); } catch { return; }
    tip.innerHTML = `<b>${esc(data.label)}</b>${data.lines.map((l) => esc(l)).join('<br>')}`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(x + 12, window.innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
  };
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) show(el, e.clientX, e.clientY); else tip.hidden = true;
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
  let lastWide = wideChartWidth();
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (wideChartWidth() !== lastWide) { lastWide = wideChartWidth(); render(); } }, 150);
  });
  if (!restore()) await loadSample();
  render();
}
