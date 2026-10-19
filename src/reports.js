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
  else if (lower.includes('voucher')) meio = 'Voucher';
  else if (CARD_BRANDS.test(s)) meio = 'Cartão';
  else meio = s.split('|').pop().trim();
  return { meio, bandeira: brand ? brand.toLowerCase() : null };
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
  const compra = /^compra efetuada/i.test(evento);
  return {
    id,
    sessao: r['Code Session'] || null,
    franqueadoId: r['Id Franqueado'] || null,
    franqueado: r['Franqueado'] || null,
    pdxId: r['ID PDX'] || null,
    pdx: r['PDX'] || '(sem loja)',
    clienteId: r['Cliente ID'] || null,
    cliente: r['Nome Cliente'] || null,
    statusCliente: r['Status Cliente'] || null,
    totalGastoCliente: parseMoneyCents(r['Total gasto']),
    via: (r['Via'] || '').toUpperCase() || null,
    evento,
    categoriaEvento: categoria,
    compra,
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
    pdx: r['PDX'] || '(sem loja)',
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

export function normalizeBoleto(r) {
  const id = String(r['Id'] ?? '').replace(/^#/, '');
  if (!id || !/^\d+$/.test(id)) return null; // ignora a linha "Total"
  const pago = parseDateTime(r['Pago']);
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
    dataPicklist: r['Data'] || null,
    geradoEm: parseDateTime(r['Data_2']),
    data: dateOnly(parseDateTime(r['Data_2'])),
  };
}

// --- Remessas de retorno (produtos devolvidos ao CD: vencidos e avarias) ----

export function normalizeRetorno(r) {
  const dataHora = parseDateTime(r['Data']);
  if (!dataHora) return null;
  return {
    pdxId: r['ID PDX'] || null,
    pdx: r['PDX'] || '(sem loja)',
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
    pdx: r['PDX'] || '(sem loja)',
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
