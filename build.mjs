// 把 src/ 內嵌進 src/index.template.html，產生免安裝的單一檔案 product/index.html
// 並檢查：package.json 版本必須等於 changelog 最新一筆（避免發行版本號與歷程不一致）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const esc = s => s.replace(/<\/script/gi, '<\\/script');

const changelog = createRequire(import.meta.url)('./src/changelog.js');
const pkgVersion = JSON.parse(read('./package.json')).version;
if ('v' + pkgVersion !== changelog[0].version) {
  console.error(`版本不一致：package.json 為 ${pkgVersion}，changelog 最新為 ${changelog[0].version}`); process.exit(1);
}

// 語法檢查：測試只載入 core.js，app.js 壞掉時測試與 CI 都是綠的，整個頁面卻起不來（v0.32.1 開發時發生過：單行函式中間加 // 註解）
for (const f of ['core.js', 'changelog.js', 'app.js']) {
  try { new Script(read('./src/' + f), { filename: 'src/' + f }); } catch (e) { console.error(`src/${f} 語法錯誤：${e.message}\n${e.stack.split('\n').slice(0, 2).join('\n')}`); process.exit(1); }
}

let html = read('./src/index.template.html');
html = html.replace('/*CORE*/', () => esc(read('./src/core.js'))).replace('/*CHANGELOG*/', () => esc(read('./src/changelog.js'))).replace('/*APP*/', () => esc(read('./src/app.js')));
mkdirSync(new URL('./product/', import.meta.url), { recursive: true });
writeFileSync(new URL('./product/index.html', import.meta.url), html);
console.log('product/index.html', (html.length / 1024).toFixed(1), 'KB', changelog[0].version);
