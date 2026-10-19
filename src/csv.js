// Parser de CSV sem dependências. Aceita ';' ou ',' (detecta pelo cabeçalho),
// campos entre aspas com aspas duplicadas ("") e quebras de linha \r\n ou \n.

export function detectDelimiter(firstLine) {
  const count = (ch) => firstLine.split(ch).length - 1;
  return count(';') >= count(',') ? ';' : ',';
}

/** @returns {{ headers: string[], rows: string[][] }} */
export function parseCsv(text, delimiter) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstNewline = text.indexOf('\n');
  const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
  const sep = delimiter ?? detectDelimiter(firstLine);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === sep) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  const headers = (nonEmpty.shift() ?? []).map((h) => h.trim());
  return { headers, rows: nonEmpty };
}

/**
 * Converte linhas em objetos. Cabeçalhos vazios viram `coluna_N`; repetidos
 * recebem sufixo `_2`, `_3`... (o relatório de boletos tem duas colunas "Data").
 */
export function toObjects({ headers, rows }) {
  const names = [];
  const seen = new Map();
  headers.forEach((h, idx) => {
    let name = h === '' ? `coluna_${idx + 1}` : h;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name}_${n}`;
    names.push(name);
  });
  return rows.map((r) => {
    const obj = {};
    names.forEach((name, idx) => {
      obj[name] = (r[idx] ?? '').trim();
    });
    return obj;
  });
}

/** Decodifica bytes como UTF-8 e, se houver bytes inválidos, como Latin-1 (padrão dos exports Market4u). */
export function decodeBytes(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
