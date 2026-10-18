// 由 src/changelog.js 產生指定版本的 GitHub Release 說明（Markdown）：node scripts/release-notes.mjs v0.4.0
import { createRequire } from 'node:module';
const changelog = createRequire(import.meta.url)('../src/changelog.js');
const v = process.argv[2] || changelog[0].version, e = changelog.find(x => x.version === v);
if (!e) { console.error('changelog 找不到 ' + v); process.exit(1); }
const label = { major: '重大更新', minor: '新功能', patch: '修正' }[e.type];
console.log(`## ${e.version}（${e.date}）· ${label}\n\n${e.title}\n\n${e.changes.map(c => '- ' + c).join('\n')}\n`);
console.log('---\n**使用**：下載附件 `cadastral-resurvey-workstation.html`，用 Chrome 或 Edge 開啟即可，不用安裝。已安裝舊版者，在「版本」視窗按「立即更新」。');
