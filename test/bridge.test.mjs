// bridge.test.mjs — tools/mcp-bridge.mjs：MCP（stdio）⇄ WebSocket 轉送。以假頁面代替瀏覽器，不需任何資料。
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';

if (typeof WebSocket !== 'function') { console.log('略過：此 Node 沒有內建 WebSocket（需 >= 22）'); process.exit(0); }
const PORT = 20000 + Math.floor(Math.random() * 20000);
const br = spawn(process.execPath, ['tools/mcp-bridge.mjs', '--port', String(PORT), '--timeout', '5'], { stdio: ['pipe', 'pipe', 'pipe'] });
let err = ''; br.stderr.on('data', d => { err += d; });
const waiters = new Map(); let rid = 0, obuf = '';
br.stdout.on('data', d => { obuf += d; let i; while ((i = obuf.indexOf('\n')) >= 0) { const m = JSON.parse(obuf.slice(0, i)); obuf = obuf.slice(i + 1); const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } } });
const rpc = (method, params) => new Promise(r => { const id = ++rid; waiters.set(id, r); br.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const call = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); return { err: !!m.result.isError, text: m.result.content[0].text }; };
const until = async f => { for (let i = 0; i < 100; i++) { if (f()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('逾時；stderr：' + err); };

let ok = 0; const t = async (name, f) => { await f(); ok++; console.log('✓', name); };
try {
  await until(() => err.includes('等待頁面連線'));
  await t('initialize 與工具清單', async () => {
    const m = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(m.result.protocolVersion, '2025-06-18'); assert.ok(m.result.capabilities.tools);
    const l = await rpc('tools/list', {}); const names = l.result.tools.map(x => x.name);
    for (const n of ['workstation_status', 'fix_queue_list', 'fix_queue_goto', 'fix_queue_done', 'call_api']) assert.ok(names.includes(n), n);
    assert.ok(l.result.tools.every(x => x.inputSchema && x.inputSchema.type === 'object' && !('run' in x)));
  });
  await t('頁面未連線時回清楚的錯誤', async () => { const r = await call('fix_queue_list', {}); assert.ok(r.err); assert.match(r.text, /尚未連線/); });

  const seen = []; const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.onmessage = ev => { const m = JSON.parse(ev.data); seen.push(m);
    const big = 'x'.repeat(70000);   // 測 64 KB 以上的框
    const res = { getState: { loaded: true, parcels: 3 }, getProgress: { done: 1 }, listFixQueue: { source: m.params.source || 'chk', total: 1, items: [{ label: '76-17', text: '碎片', pad: big }] } }[m.method];
    ws.send(JSON.stringify(m.method === 'markFixed' ? { id: m.id, error: '使用者拒絕了這個修改（markFixed）' } : { id: m.id, result: res ?? null })); };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ hello: 'cadastral-resurvey-workstation', version: 'v0.30.0', mode: 'ask' }));
  await until(() => err.includes('頁面已連線'));

  await t('狀態：連線、權限模式、版本', async () => { const r = JSON.parse((await call('workstation_status', {})).text); assert.equal(r.connected, true); assert.equal(r.mode, 'ask'); assert.equal(r.page_version, 'v0.30.0'); assert.equal(r.state.parcels, 3); });
  await t('轉送參數與大於 64 KB 的回應', async () => { const r = await call('fix_queue_list', { source: 'neg', limit: 5 }); assert.ok(!r.err); const j = JSON.parse(r.text); assert.equal(j.source, 'neg'); assert.equal(j.items[0].pad.length, 70000);
    assert.deepEqual(seen.at(-1), { id: seen.at(-1).id, method: 'listFixQueue', params: { source: 'neg', limit: 5 } }); });
  await t('頁面拒絕（權限）回成工具錯誤', async () => { const r = await call('fix_queue_done', { label: '76-17' }); assert.ok(r.err); assert.match(r.text, /拒絕/); });
  await t('call_api 轉送任意方法', async () => { await call('call_api', { method: 'mergePoints', params: { from: 'A1', to: 'A2' } }); assert.deepEqual(seen.at(-1).params, { from: 'A1', to: 'A2' }); assert.equal(seen.at(-1).method, 'mergePoints'); });
  await t('拒絕非本機來源的網頁', async () => { const code = await new Promise(r => { const q = http.request({ host: '127.0.0.1', port: PORT, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', origin: 'https://evil.example' } });
    q.on('upgrade', () => r(101)); q.on('response', x => r(x.statusCode)); q.on('error', () => r('closed')); q.end(); });
    assert.notEqual(code, 101); assert.match(err, /拒絕連線/); });
  ws.close();
  console.log(`\n全部 ${ok} 項通過`);
} finally { br.kill(); }
