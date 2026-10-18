// 把 src/core.js、src/app.js 內嵌進 src/index.template.html，產生免安裝的單一檔案 product/index.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const esc = s => s.replace(/<\/script/gi, '<\\/script');
let html = read('./src/index.template.html');
html = html.replace('/*CORE*/', () => esc(read('./src/core.js'))).replace('/*APP*/', () => esc(read('./src/app.js')));
mkdirSync(new URL('./product/', import.meta.url), { recursive: true });
writeFileSync(new URL('./product/index.html', import.meta.url), html);
console.log('product/index.html', (html.length / 1024).toFixed(1), 'KB');
