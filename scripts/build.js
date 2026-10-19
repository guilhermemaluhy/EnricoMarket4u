// Gera dist/index.html: página única com CSS, JS e amostras embutidos (abre direto do disco ou publica como página estática).
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const readLatin = async (p) => new TextDecoder('windows-1252').decode(await readFile(new URL(p, root)));

const modules = ['parse', 'csv', 'format', 'reports', 'metrics', 'charts', 'app'];
let bundle = '';
const exportsOf = (src) => [...src.matchAll(/^export (?:async )?(?:function|const|let) (\w+)/gm)].map((m) => m[1]);
const declared = new Set();
const sources = Object.fromEntries(await Promise.all(modules.map(async (m) => [m, await read(`src/${m}.js`)])));
for (const m of modules) {
  const src = sources[m];
  // Tudo vira um único escopo: imports internos saem, `export` sai, aliases e namespaces viram constantes.
  let prelude = '';
  for (const imp of src.matchAll(/^import ([^;]*) from '\.\/(\w+)\.js';/gm)) {
    const [, clause, mod] = imp;
    const ns = /^\* as (\w+)$/.exec(clause.trim());
    if (ns && !declared.has(ns[1])) { declared.add(ns[1]); prelude += `const ${ns[1]} = { ${exportsOf(sources[mod]).join(', ')} };\n`; }
    for (const alias of clause.matchAll(/(\w+) as (\w+)/g)) {
      if (alias[1] === '*' || declared.has(alias[2])) continue;
      declared.add(alias[2]);
      prelude += `const ${alias[2]} = ${alias[1]};\n`;
    }
  }
  bundle += `\n// ---- src/${m}.js ----\n${prelude}` + src.replace(/^import[^;]*;\s*$/gm, '').replace(/^export (async )?function/gm, '$1function').replace(/^export (const|let)/gm, '$1');
}
const sample = {
  transacoes: await readLatin('data/sample/transacoes.csv'),
  produtos: await readLatin('data/sample/produtos.csv'),
  boletos: await readLatin('data/sample/boletos.csv'),
};
const css = await read('src/styles.css');
const html = (await read('index.html'))
  .replace('<link rel="stylesheet" href="src/styles.css">', `<style>\n${css}\n</style>`)
  .replace(/<script type="module">[\s\S]*?<\/script>/, `<script>\nwindow.EM4U_SAMPLE = ${JSON.stringify(sample).replace(/<\//g, '<\\/')};\n${bundle}\nstart();\n</script>`);
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/index.html', root), html);
console.log(`dist/index.html (${(html.length / 1024).toFixed(0)} kB)`);

// Variante sem <html>/<head>/<body> para hosts que envolvem a página no próprio esqueleto (ex.: Artifact do Claude).
const inner = html
  .replace(/^[\s\S]*?<title>/, '<title>')
  .replace('</head>\n<body>', '')
  .replace(/<\/body>\s*<\/html>\s*$/, '')
  .replace('<title>', '<meta name="claude:viewport-fit-sides" content="cover">\n<title>');
await writeFile(new URL('dist/artifact.html', root), inner);
console.log(`dist/artifact.html (${(inner.length / 1024).toFixed(0)} kB)`);
