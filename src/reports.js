// Identificação e normalização dos três relatórios exportados do painel Market4u:
// transações (clientes), produtos vendidos e boletos de reabastecimento (CD).
import { parseCsv, toObjects, decodeBytes } from './csv.js';
import {
  parseMoneyCents,
  parseNumber,
  parseInteger,
  parseCode,
  parseDateTime,
  dateOnly,
  hourOf,
  parseYesNo,
  parseDistanceKm,
  daysBetween,
} from './parse.js';
import { storeName } from './format.js';

export const REPORT_TYPES = /** @type {const} */ ({
  transacoes: { label: 'Transações', signature: ['Code Session', 'Forma pagamento'] },
  produtos: { label: 'Produtos vendidos', signature: ['Valor total venda', 'Valor total custo'] },
  boletos: { label: 'Boletos de reabastecimento', signature: ['Vencimento', 'Picklist'] },
  retornos: { label: 'Remessas de retorno', signature: ['Remessa de retorno', 'Custo total'] },
  inventario: { label: 'Inventário', signature: ['Inventário', 'Posição ajustado'] },
});

/** Descobre qual relatório é pelo cabeçalho. */
export function detectReportType(headers) {
  const set = new Set(headers.map((h) => h.trim()));
  for (const [type, { signature }] of Object.entries(REPORT_TYPES)) {
    if (signature.every((col) => set.has(col))) return type;
  }
  return null;
}

/** Lê um arquivo (bytes ou texto) e devolve `{ type, records }`. */
export function loadReport(input) {
  const text = typeof input === 'string' ? input : decodeBytes(input);
  const parsed = parseCsv(text);
  const type = detectReportType(parsed.headers);
  if (!type) {
    const err = new Error('Relatório não reconhecido: esperava transações, produtos vendidos ou boletos.');
    err.code = 'UNKNOWN_REPORT';
    throw err;
  }
  const rows = toObjects(parsed);
  const normalizers = { transacoes: normalizeTransacao, produtos: normalizeProduto, boletos: normalizeBoleto, retornos: normalizeRetorno, inventario: normalizeInventario };
  const records = rows.map(normalizers[type]).filter(Boolean);
  return { type, records };
}

// --- Transações --------------------------------------------------------------

const CARD_BRANDS = /mastercard|master|visa|elo|amex|hipercard|hiper|maestro|diners/i;

/** "Pagbank_pos | POS Cartão de crédito (visa)" → { meio: 'Crédito', bandeira: 'visa' } */
export function classifyPayment(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' || s === '--') return { meio: null, bandeira: null };
  const lower = s.toLowerCase();
  const brand = /\(([^)]+)\)/.exec(s)?.[1] ?? (CARD_BRANDS.exec(s)?.[0] ?? null);
  let meio;
  if (lower.includes('pix')) meio = 'Pix';
  else if (lower.includes('crédito') || lower.includes('credito')) meio = 'Crédito';
  else if (lower.includes('débito') || lower.includes('debito') || lower.includes('maestro')) meio = 'Débito';
  else if (lower.includes('carteira') || lower.includes('saldo')) meio = 'Carteira';
  else if (lower.includes('voucher') || /\b(vr|sodexo|pluxee|alelo|ticket|ben)\b/.test(lower)) meio = 'Voucher';
  else if (lower.includes('boleto')) meio = 'Boleto';
  else if (CARD_BRANDS.test(s)) meio = 'Cartão';
  else meio = s.split('|').pop().trim();
  return { meio, bandeira: brand ? brand.toLowerCase() : null };
}

/**
 * Classifica o evento da sessão. Cada linha do relatório é um evento:
 *  - compra: "Compra efetuada" (venda registrada e paga)
 *  - carrinho: "No carrinho" (sessão sem compra; pode ter itens no carrinho)
 *  - removida: "Compra removida" (compra cancelada/removida antes do pagamento)
 *  - estornada: "Compra estornada" (venda paga e depois estornada)
 *  - cobranca_pendente: "Cobrança pendente" (itens levados sem pagar; link de pagamento gerado)
 *  - cobranca_paga: "Pagamento efetuada (cobrança)" (cobrança recuperada)
 */
export const EVENTOS = {
  compra: { label: 'Compra', tone: 'good' },
  cobranca_paga: { label: 'Cobrança paga', tone: 'good' },
  cobranca_pendente: { label: 'Cobrança pendente', tone: 'critical' },
  carrinho: { label: 'Carrinho abandonado', tone: 'warning' },
  removida: { label: 'Compra removida', tone: 'neutral' },
  estornada: { label: 'Estornada', tone: 'critical' },
  outro: { label: 'Outro', tone: 'neutral' },
};

export function classifyEvento(evento) {
  const e = String(evento ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  // Qualquer Tipo que mencione cobrança é uma cobrança: "Cobrança pendente", "Compra efetuada (cobrança)",
  // "Pagamento efetuada (cobrança)". Removida/estornada com "(cobrança)" segue como removida/estornada.
  if (e.includes('cobranca')) {
    if (/removid/.test(e)) return 'removida';
    if (/estorn/.test(e)) return 'estornada';
    if (/pend|aguard|abert|gerad|enviad|nao pag/.test(e)) return 'cobranca_pendente';
    return 'cobranca_paga';
  }
  if (e.startsWith('compra efetuada')) return 'compra';
  if (e.startsWith('no carrinho')) return 'carrinho';
  if (e.startsWith('compra removida')) return 'removida';
  if (e.startsWith('compra estornada')) return 'estornada';
  if (e.startsWith('pagamento efetuad')) return 'cobranca_paga';
  return 'outro';
}

/** "Compra efetuada (Bebidas não alcoólicas)" → { evento: 'Compra efetuada', categoria: 'Bebidas não alcoólicas' } */
export function splitTipo(raw) {
  const m = /^(.*?)\s*(?:\((.*)\))?$/.exec(String(raw ?? '').trim());
  return { evento: m?.[1]?.trim() ?? '', categoria: m?.[2]?.trim() || null };
}

export function normalizeTransacao(r) {
  const id = r['ID'];
  if (!id || !/^\d+$/.test(id)) return null;
  const { evento, categoria } = splitTipo(r['Tipo']);
  const dataHora = parseDateTime(r['Data e hora']);
  const { meio, bandeira } = classifyPayment(r['Forma pagamento']);
  const tipoEvento = classifyEvento(evento);
  const compra = tipoEvento === 'compra';
  const link = r['Link de Pagamento'];
  return {
    id,
    sessao: r['Code Session'] || null,
    franqueadoId: r['Id Franqueado'] || null,
    franqueado: r['Franqueado'] || null,
    pdxId: r['ID PDX'] || null,
    pdx: storeName(r['PDX']) || '(sem loja)',
    clienteId: r['Cliente ID'] || null,
    cliente: r['Nome Cliente'] || null,
    statusCliente: r['Status Cliente'] || null,
    totalGastoCliente: parseMoneyCents(r['Total gasto']),
    via: (r['Via'] || '').toUpperCase() || null,
    evento,
    tipoEvento,
    categoriaEvento: categoria,
    compra,
    cobranca: tipoEvento === 'cobranca_pendente' || tipoEvento === 'cobranca_paga',
    distanciaKm: parseDistanceKm(r['Distância']),
    leituraQrcode: parseYesNo(r['Leitura QRCODE']),
    cpfNaNota: parseYesNo(r['CPF na nota']),
    nfce: r['NFC-e'] && r['NFC-e'] !== '--' ? r['NFC-e'] : null,
    qtdeProdutos: parseInteger(r['Qtde produtos']),
    qtdeRemovidos: parseInteger(r['Qtde produtos removidos']),
    comprasCliente: parseInteger(r['Qtde compras']),
    naoComprasCliente: parseInteger(r['Qtde não compras']),
    formaPagamento: r['Forma pagamento'] && r['Forma pagamento'] !== '--' ? r['Forma pagamento'] : null,
    meioPagamento: meio,
    bandeira,
    splitPagamento: parseYesNo(r['Split de pg']),
    totalCents: parseMoneyCents(r['Total']),
    voucherCents: parseMoneyCents(r['Voucher']),
    estornoCents: parseMoneyCents(r['Total Estorno']),
    descontoCents: parseMoneyCents(r['Desconto']),
    cashbackCents: parseMoneyCents(r['Cashback']),
    subtotalCents: parseMoneyCents(r['Subtotal']),
    emissaoNfce: parseDateTime(r['Emissão NFCe']),
    saldoCarteiraCents: parseMoneyCents(r['Saldo Carteira']),
    idLinkPagamento: r['ID link de pagamento'] && r['ID link de pagamento'] !== '--' ? r['ID link de pagamento'] : null,
    linkPagamento: /^https?:\/\//.test(link ?? '') ? link : null,
    taxaCobranca: parseYesNo(r['Possui taxa de cobrança']),
    dataHora,
    data: dateOnly(dataHora),
    hora: hourOf(dataHora),
  };
}

// --- Produtos vendidos -------------------------------------------------------

export function normalizeProduto(r) {
  const dataHora = parseDateTime(r['Data e hora']);
  if (!dataHora) return null;
  const vendaCents = parseMoneyCents(r['Valor total venda']);
  const custoCents = parseMoneyCents(r['Valor total custo']);
  return {
    dataHora,
    data: dateOnly(dataHora),
    hora: hourOf(dataHora),
    mes: r['Mês'] || null,
    clienteId: r['Id cliente'] || null,
    sexo: r['Sexo'] || null,
    idade: parseInteger(r['Idade']) || null,
    pdxId: r['Id PDX'] || null,
    pdx: storeName(r['PDX']) || '(sem loja)',
    codigoPdx: r['Código PDX'] || null,
    via: (r['VIA'] || '').toUpperCase() || null,
    cobranca: parseYesNo(r['Cobrança']),
    transacaoId: r['ID transação'] || null,
    fabricante: r['Fabricante'] || '(sem fabricante)',
    categoria: r['Categoria'] || '(sem categoria)',
    produtoId: r['Id do produto'] || null,
    codigo: parseCode(r['Código do produto']),
    ean: parseCode(r['Código de barras']),
    nome: r['Nome do produto'] || '(sem nome)',
    quantidade: parseNumber(r['Quantidade']),
    vendaCents,
    custoCents,
    margemCents: vendaCents - custoCents,
  };
}

// --- Boletos de reabastecimento ---------------------------------------------

/**
 * Situação calculada a partir das datas (o campo Status do relatório só muda
 * quando o painel é atualizado): pago → vencido → vence em até 3 dias → a vencer.
 */
export function situacaoBoleto(b, hoje) {
  if (b.pago || /^pago/i.test(b.status ?? '')) return 'pago';
  if (!b.vencimento) return 'a_vencer';
  const dias = daysBetween(hoje, b.vencimento);
  if (dias < 0) return 'vencido';
  if (dias <= 3) return 'vence_em_breve';
  return 'a_vencer';
}

export const SITUACOES = {
  vencido: { label: 'Vencido', tone: 'critical' },
  vence_em_breve: { label: 'Vence em até 3 dias', tone: 'warning' },
  a_vencer: { label: 'A vencer', tone: 'neutral' },
  pago: { label: 'Pago', tone: 'good' },
};

const MESES_ABREV = { jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06', jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12' };

/** "18, Out" + data de referência "2026-10-19" → "2026-10-18" (ano da referência; vira o ano anterior se ficar no futuro). */
export function parsePicklistDate(value, reference) {
  const m = /^(\d{1,2}),?\s*([a-zç]{3})/i.exec(String(value ?? '').trim());
  if (!m || !reference) return null;
  const mes = MESES_ABREV[m[2].toLowerCase().replace('ç', 'c')];
  if (!mes) return null;
  let ano = Number(reference.slice(0, 4));
  let iso = `${ano}-${mes}-${m[1].padStart(2, '0')}`;
  if (iso > reference) iso = `${ano - 1}-${mes}-${m[1].padStart(2, '0')}`;
  return iso;
}

export function normalizeBoleto(r) {
  const id = String(r['Id'] ?? '').replace(/^#/, '');
  if (!id || !/^\d+$/.test(id)) return null; // ignora a linha "Total"
  const pago = parseDateTime(r['Pago']);
  const geradoEm = parseDateTime(r['Data_2']);
  return {
    id,
    cidade: r['Cidade'] || null,
    cd: r['Franqueado (CD)'] || null,
    franqueadoId: r['Franqueado Id'] || null,
    franqueado: r['Franqueado'] || null,
    cnpj: r['CNPJ'] || null,
    status: r['Status'] || null,
    taxaCents: parseMoneyCents(r['Valor taxa']),
    valorCents: parseMoneyCents(r['Valor']),
    tipoPagamento: r['Tipo de pagamento'] || null,
    formaPagamento: r['Forma de pagamento'] || null,
    link: /^https?:\/\//.test(r['Link da cobrança'] ?? '') ? r['Link da cobrança'] : null,
    numeroCobranca: r['Nº da cobrança'] && r['Nº da cobrança'] !== '--' ? r['Nº da cobrança'] : null,
    vencimento: dateOnly(parseDateTime(r['Vencimento'])),
    bloqueiaInadimplente: parseYesNo(r['Bloqueado inadimplente']),
    nota: r['Nº Nota'] && r['Nº Nota'] !== '--' ? r['Nº Nota'] : null,
    emissaoNota: dateOnly(parseDateTime(r['Data de emissão'])),
    picklist: r['Picklist'] && r['Picklist'] !== '--' ? r['Picklist'] : null,
    pago: dateOnly(pago),
    dataPicklist: parsePicklistDate(r['Data'], dateOnly(geradoEm)) ?? (r['Data'] && r['Data'] !== '--' ? r['Data'] : null),
    geradoEm,
    data: dateOnly(geradoEm),
  };
}

// --- Remessas de retorno (produtos devolvidos ao CD: vencidos e avarias) ----

export function normalizeRetorno(r) {
  const dataHora = parseDateTime(r['Data']);
  if (!dataHora) return null;
  return {
    pdxId: r['ID PDX'] || null,
    pdx: storeName(r['PDX']) || '(sem loja)',
    dataHora,
    data: dateOnly(dataHora),
    remessa: String(r['Remessa de retorno'] ?? '').replace(/^#/, '') || null,
    ean: parseCode(r['Código de Barras']),
    codigo: parseCode(r['Código']),
    produto: r['Produto'] || '(sem nome)',
    responsavel: r['Responsável'] || null,
    operador: r['Operador'] || null,
    tipo: r['Tipo'] || '(sem tipo)',
    quantidade: parseNumber(r['Quantidade']),
    custoUnitCents: parseMoneyCents(r['Custo unitário']),
    custoTotalCents: parseMoneyCents(r['Custo total']),
  };
}

// --- Inventário (contagem física × posição do sistema) ------------------------

export function normalizeInventario(r) {
  const dataHora = parseDateTime(r['Data']);
  if (!dataHora) return null;
  const anterior = parseNumber(r['Posição anterior']);
  const diferenca = parseNumber(r['Diferença']);
  const ajustado = parseNumber(r['Posição ajustado']);
  return {
    codigoPdx: r['Código PDX'] || null,
    pdx: storeName(r['PDX']) || '(sem loja)',
    dataHora,
    data: dateOnly(dataHora),
    inventario: String(r['Inventário'] ?? '').replace(/^#/, '') || null,
    ean: parseCode(r['Código de Barras']),
    codigo: parseCode(r['Código']),
    categoria: r['Categoria'] || '(sem categoria)',
    produto: r['Produto'] || '(sem nome)',
    responsavel: r['Responsável'] || null,
    operador: r['Operador'] || null,
    custoUnitCents: parseMoneyCents(r['Custo unitário']),
    vendaUnitCents: parseMoneyCents(r['Venda unitário']),
    posicaoAnterior: anterior,
    diferenca,
    posicaoAjustada: ajustado,
    custoDiferencaCents: parseMoneyCents(r['Custo total']),
    vendaDiferencaCents: parseMoneyCents(r['Venda total']),
  };
}

const MERGE_KEYS = {
  transacoes: (t) => t.id,
  boletos: (b) => b.id,
  produtos: (p) => `${p.transacaoId}|${p.produtoId}|${p.vendaCents}|${p.quantidade}`,
  retornos: (r) => `${r.remessa}|${r.ean}|${r.tipo}|${r.quantidade}`,
  inventario: (i) => `${i.inventario}|${i.ean}|${i.codigo}`,
};

/** Une vários arquivos do mesmo tipo sem duplicar registros. */
export function mergeRecords(type, existing, incoming) {
  const key = MERGE_KEYS[type];
  const map = new Map(existing.map((r) => [key(r), r]));
  for (const r of incoming) map.set(key(r), r);
  return [...map.values()];
}
