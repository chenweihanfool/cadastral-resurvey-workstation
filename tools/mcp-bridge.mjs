#!/usr/bin/env node
/* mcp-bridge.mjs — 地籍圖重測工作站的 MCP 橋接程式（零相依，Node >= 20）。
 *
 * 一端是 MCP server（stdio，給 Claude Desktop／Claude Code 呼叫），另一端是 WebSocket server（給頁面連）。
 * AI 呼叫工具 → 轉成頁面的 window.CadastralAPI[method](params) → 結果回給 AI。
 * 權限由頁面「說明 → 連接 AI（MCP）」決定（唯讀／每次問我／直接修改），這支程式只轉送。
 *
 * 設定：
 *   Claude Desktop：設定 → 開發人員 → 編輯設定（claude_desktop_config.json）加入
 *     { "mcpServers": { "cadastral": { "command": "node", "args": ["C:\\路徑\\mcp-bridge.mjs"] } } }
 *   Claude Code：claude mcp add cadastral -- node /路徑/mcp-bridge.mjs
 *   重開 AI 後，在工作站按「說明 → 連接 AI（MCP）→ 連線」。
 * 參數：--port 8765（或環境變數 CADASTRAL_BRIDGE_PORT）、--timeout 600（單次呼叫秒數上限）
 * 只聽 127.0.0.1；只接受本機 HTML（file://）或 localhost 開的頁面。stdout 只給 MCP，訊息印在 stderr。 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg('port', process.env.CADASTRAL_BRIDGE_PORT || 8765);
const TIMEOUT = +arg('timeout', 600) * 1000;
const VERSION = '1.0.0';
const log = (...a) => process.stderr.write('[cadastral-bridge] ' + a.join(' ') + '\n');

// ── WebSocket server（RFC 6455 最小實作：文字框、分段、ping/pong、close）──
let page = null;            // 目前連線的頁面 { sock, info }
const pending = new Map();  // id → { resolve, reject, timer }
let seq = 0;

function wsSend(sock, text, op = 1) {
  const b = Buffer.from(text), n = b.length;
  const h = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const x = Buffer.alloc(10); x[0] = 0x80 | op; x[1] = 127; x.writeBigUInt64BE(BigInt(n), 2); return x; })();
  sock.write(Buffer.concat([h, b]));
}
const originOk = o => !o || o === 'null' || o.startsWith('file://') || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o);

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`地籍圖重測工作站 MCP 橋接 ${VERSION}：${page ? '頁面已連線' : '等待頁面連線'}\n`); });
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || !originOk(req.headers.origin)) { log('拒絕連線，來源', req.headers.origin || '?'); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  if (page) { try { wsSend(page.sock, '', 8); page.sock.end(); } catch { /* ignore */ } }   // 新頁面取代舊的
  const me = { sock, info: {} }; page = me; log('頁面已連線');
  let buf = Buffer.alloc(0), frag = [];
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mk = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
      if (buf.length < off + len) return;
      const body = Buffer.from(buf.subarray(off, off + len)); buf = buf.subarray(off + len);
      if (mk) for (let i = 0; i < body.length; i++) body[i] ^= mk[i & 3];
      if (op === 8) { try { wsSend(sock, '', 8); } catch { /* ignore */ } sock.end(); return; }
      if (op === 9) { wsSend(sock, body.toString(), 10); continue; }
      if (op === 10) continue;
      frag.push(body); if (!fin) continue;
      const text = Buffer.concat(frag).toString('utf8'); frag = [];
      onPageMessage(me, text);
    }
  });
  const gone = () => { if (page === me) { page = null; log('頁面已中斷'); for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('頁面已中斷連線')); pending.delete(id); } } };
  sock.on('close', gone); sock.on('error', gone);
});
function onPageMessage(me, text) {
  let m; try { m = JSON.parse(text); } catch { return; }
  if (m.hello) { Object.assign(me.info, m); if (m.mode) me.info.mode = m.mode; return; }
  const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer);
  m.error != null ? p.reject(new Error(m.error)) : p.resolve(m.result);
}
function callPage(method, params) {
  if (!page) return Promise.reject(new Error(`工作站頁面尚未連線：請開啟工作站 HTML，按「說明 → 連接 AI（MCP）→ 連線」（位址 ws://127.0.0.1:${PORT}）`));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`頁面 ${TIMEOUT / 1000} 秒沒有回應（${method}）；若在等使用者按確認，請使用者處理後再試`)); }, TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    wsSend(page.sock, JSON.stringify({ id, method, params: params ?? {} }));
  });
}
server.on('error', e => { log(e.code === 'EADDRINUSE' ? `埠 ${PORT} 已被使用（另一個橋接還開著？可用 --port 換埠，頁面位址也要跟著改）` : e.message); });
server.listen(PORT, '127.0.0.1', () => log(`WebSocket 等待頁面連線：ws://127.0.0.1:${PORT}`));

// ── 讀本機資料夾給 loadProject（頁面無法自己讀檔）──
const SKIP = /^(\.|node_modules$)/;
function readFolder(dir, maxMB = 400) {
  const root = path.resolve(dir), base = path.basename(root), files = []; let total = 0;
  if (!fs.statSync(root).isDirectory()) throw new Error('不是資料夾：' + root);
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP.test(e.name)) continue; const p = path.join(d, e.name), r = rel + '/' + e.name;
    if (e.isDirectory()) walk(p, r); else if (e.isFile()) { const b = fs.readFileSync(p); total += b.length; if (total > maxMB * 1048576) throw new Error(`資料夾超過 ${maxMB} MB，請指定較小的資料夾`); files.push({ path: r, base64: b.toString('base64') }); } } };
  walk(root, base); return files;
}

// ── MCP 工具 ──
const S = (props = {}, required = []) => ({ type: 'object', properties: props, required });
const SRC = { type: 'string', enum: ['chk', 'neg', 'area', 'unreg', 'ring', 'sheet'], description: '待修清單來源：chk 舊圖檢核（紅／黃／碎片）、neg 較差為負（遺漏／面積不足／被佔用）、area 面積超過公差、unreg 未登記地需分割、ring 界址串問題、sheet 分幅線附近。省略＝頁面目前選的' };
const LABEL = { type: 'string', description: '地號，例如 76-17' };
const TOOLS = [
  { name: 'workstation_status', description: '看工作站頁面是否已連線、權限模式（read 唯讀／ask 每次問使用者／write 直接修改）、目前載入的案件與進度。開始工作前先呼叫。', inputSchema: S(),
    run: async () => { const st = page ? await callPage('getState') : null; return { connected: !!page, mode: page && page.info.mode, page_version: page && page.info.version, state: st, progress: page ? await callPage('getProgress').catch(() => null) : null }; } },
  { name: 'load_project_folder', description: '讀取本機的專案資料夾（案件 D 檔、鄰段、分幅、舊圖影像），交給工作站「開啟專案資料夾」。路徑用絕對路徑。會改圖資，依頁面權限可能需要使用者確認。', inputSchema: S({ path: { type: 'string', description: '本機資料夾絕對路徑' } }, ['path']),
    run: async ({ path: p }) => callPage('loadProject', { files: readFolder(p) }) },
  { name: 'list_steps', description: '作業流程各步驟（1～6）的狀態與結果。', inputSchema: S(), run: () => callPage('listSteps') },
  { name: 'fix_queue_list', description: '列出待修清單（與工具箱「待修清單」同一份，已標修好的不列）。逐筆修的起點：依序對每筆 fix_queue_goto → 查看 → 修正 → fix_queue_done。', inputSchema: S({ source: SRC, limit: { type: 'integer', default: 100 } }),
    run: a => callPage('listFixQueue', a) },
  { name: 'fix_queue_goto', description: '在畫面上跳到待修清單的某一筆（選取並放大），讓使用者看到 AI 正在處理哪一宗。', inputSchema: S({ source: SRC, label: LABEL }, ['label']), run: a => callPage('gotoFixItem', a) },
  { name: 'fix_queue_done', description: '把一筆標成「修好了」（從待修清單劃掉），可附備註（處理方式），備註會存進專案檔、帶進報告。', inputSchema: S({ source: SRC, label: LABEL, note: { type: 'string' } }, ['label']), run: a => callPage('markFixed', a) },
  { name: 'get_parcel', description: '宗地的面積、登記面積與界址點坐標（y＝縱坐標北、x＝橫坐標東，TWD97）。', inputSchema: S({ label: LABEL }, ['label']), run: a => callPage('getParcel', a) },
  { name: 'get_check_report', description: '舊圖檢核結果：每宗的紅／黃／碎片、離舊圖線長度、影像無墨線、建議併入的鄰宗。', inputSchema: S({ limit: { type: 'integer', default: 200 } }), run: a => callPage('getCheckReport', a) },
  { name: 'fix_sliver', description: '依舊圖檢核的建議，把碎片併入建議的鄰宗。', inputSchema: S({ label: LABEL }, ['label']), run: a => callPage('fixSliver', a) },
  { name: 'plan_old_map_trim', description: '依舊界改正的建議（不改圖）：面積較差為正、接圖後界址被拉到接圖線的宗地，沿接圖前界址可切出多少、切出的面貼著哪些鄰宗。recommend＝unreg（建未登記地）／review（貼著別的登記地，可能是鄰宗範圍，要問使用者）／skip（不做，附原因）。整批處理的起點。', inputSchema: S({ labels: { type: 'array', items: { type: 'string' }, description: '只算這些地號；省略＝全部較差為正超過公差者' }, min_face: { type: 'number', description: '切出的面小於此面積（m²）視為圖解誤差不切，預設 5' } }),
    run: ({ labels, min_face }) => callPage('planTrimExcess', { labels, minFace: min_face }) },
  { name: 'trim_excess', description: '依舊界改正（會改圖）：沿接圖前界址切回，切出的部分建為未登記地（to=unreg，mother 母號）、併入鄰宗（to=鄰宗地號）或不切（keep）。items 可一次套用多筆（同一步復原），套用後自動重新比對。', inputSchema: S({ label: LABEL, to: { type: 'string', description: 'unreg（預設）、keep，或鄰宗地號' }, mother: { type: 'integer', description: '未登記地母號，預設頁面設定（9001）' }, items: { type: 'array', items: { type: 'object' }, description: '[{label,to,mother}]，整批套用' } }),
    run: a => callPage('trimExcess', a) },
  { name: 'live_check', description: '最近一次修改後的即時檢查（交錯、重疊、T 字接點）。每次修完一筆後呼叫，確認沒有產生新問題。', inputSchema: S(), run: () => callPage('liveCheck') },
  { name: 'undo', description: '復原上一個動作（等同 Ctrl+Z）。修錯時用。', inputSchema: S(), run: () => callPage('undo') },
  { name: 'save_milestone', description: '把目前的作業圖存成里程碑（版本），之後可比較或還原。開始大量修改前先存一個。', inputSchema: S({ name: { type: 'string' } }), run: a => callPage('saveMilestone', a) },
  { name: 'list_methods', description: '列出頁面 CadastralAPI 的全部方法與是否會改圖。需要上面沒有的操作時先看這份，再用 call_api。', inputSchema: S(), run: () => callPage('listMethods') },
  { name: 'call_api', description: '呼叫任一 CadastralAPI 方法，例如 mergePoints {from,to}、snapPointToEdge {id,a,b}、splitByChord {parcel,a,b}、deleteEdge {a,b}、mergeParcels、restoreShortfall {label}、batchFind／batchApply {kind}、ringIssues、setNote。方法與參數見 list_methods 與 docs/DEVELOPMENT.md「AI／MCP 現況」。', inputSchema: S({ method: { type: 'string' }, params: { type: 'object' } }, ['method']),
    run: ({ method, params }) => callPage(method, params) },
];
const INSTRUCTIONS = '地籍圖重測工作站（NECEXE D 檔）。逐筆修正流程：workstation_status → save_milestone → fix_queue_list → 對每筆 fix_queue_goto、get_parcel／get_check_report 判斷、修正（fix_sliver 或 call_api）、live_check 確認、fix_queue_done 附處理方式備註。判斷不了的不要硬修，用 call_api setNote 留備註給使用者。面積較差為正（接圖後外側漏畫未登記地）用整批：plan_old_map_trim 看建議 → recommend=unreg 的用 trim_excess items 一次套用 → review 的把切出面積與鄰宗列給使用者決定（建未登記地、併入哪一宗或不做）。修錯用 undo。使用者拒絕或權限唯讀時停下說明，不要繞過。坐標 y＝北、x＝東（TWD97）。';

// ── MCP stdio（JSON-RPC 2.0，一行一則）──
const out = m => process.stdout.write(JSON.stringify(m) + '\n');
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
async function onRpc(m) {
  const { id, method, params = {} } = m, reply = result => id != null && out({ jsonrpc: '2.0', id, result }), fail = (code, message) => id != null && out({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') return reply({ protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: 'cadastral-workstation', version: VERSION }, instructions: INSTRUCTIONS });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
  if (method === 'tools/call') {
    const t = TOOLS.find(x => x.name === params.name); if (!t) return fail(-32602, '沒有這個工具：' + params.name);
    try { const r = await t.run(params.arguments || {}); let text = JSON.stringify(r ?? null, null, 1); if (text.length > 200000) text = text.slice(0, 200000) + '\n…（結果太長已截斷，請用 limit 或更窄的查詢）'; return reply({ content: [{ type: 'text', text }] }); }
    catch (e) { return reply({ content: [{ type: 'text', text: '錯誤：' + (e && e.message || e) }], isError: true }); }
  }
  if (method && method.startsWith('notifications/')) return;
  fail(-32601, '不支援的方法：' + method);
}
let inbuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { inbuf += d; let i; while ((i = inbuf.indexOf('\n')) >= 0) { const line = inbuf.slice(0, i).trim(); inbuf = inbuf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析錯誤' } }); continue; } onRpc(m); } });
process.stdin.on('end', () => process.exit(0));
