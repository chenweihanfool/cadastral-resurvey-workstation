import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const Core = createRequire(import.meta.url)('../src/core.js');
// 此檔以真實案件樣本（samples/，不隨倉庫發布）對照 NECEXE 的面積；沒有樣本時略過，改跑 synthetic.test.mjs
if (!existsSync('samples/kc0381/KC0381.D14') || !existsSync('samples/KC1119/KC1119.D14')) { console.log('樣本資料不存在，略過樣本對照測試（請跑 test/synthetic.test.mjs）'); process.exit(0); }
const rd = p => new Uint8Array(readFileSync(p));
const S = 'samples/kc0381/';

// ── D 檔 ──
const pts = Core.parseDbf(rd(S + 'KC0381.D14')), bnd = Core.parseDbf(rd(S + 'KC0381.D13')), par = Core.parseDbf(rd(S + 'KC0381.D11'));
assert.equal(pts.n, 8695); assert.equal(bnd.n, 1817); assert.equal(par.n, 1297);
const ds = Core.datasetFromD({ pts, bnd, par });
console.log('D: points', ds.points.size, 'parcels', ds.parcels.length, 'edges', ds.edges.size);
let ok = 0, tot = 0, maxd = 0;
for (const p of ds.parcels) if (p.areaRef != null) { tot++; const d = Math.abs(p.areaOrig - p.areaRef); maxd = Math.max(maxd, d); if (d <= 0.05) ok++; }
console.log(`D: 面積對照 AREA_NEW ${ok}/${tot} (差<=0.05 m²), 最大差 ${maxd.toFixed(4)} m²`);
assert.ok(ok / tot > 0.95);

const bb = Core.bounds(ds); console.log('範圍', bb); assert.ok(bb.x0 > 1e5 && bb.y0 > 1e6, '全圖範圍不得含 (0,0) 離群點');
// ── 無修改輸出必須與原檔逐位元相同 ──
const same = Core.exportD14(pts, ds); assert.equal(same.changed, 0);
assert.deepEqual(same.bytes, pts.u8);
// 重新格式化原值也必須逐位元相同（驗證 patch 寫法與 NECEXE 格式一致）
const re = new Uint8Array(pts.u8);
for (const p of ds.points.values()) { Core.patchDbfNumber(re, pts, p.row, 'COT_Y', p.y0); Core.patchDbfNumber(re, pts, p.row, 'COT_X', p.x0); }
let diff = 0; for (let i = 0; i < re.length; i++) if (re[i] !== pts.u8[i]) diff++;
console.log('D14 以原值重寫，與原檔不同位元組數:', diff); assert.equal(diff, 0);

// ── 移動共用點：鄰地同時變動，其他不變；再還原 ──
const target = ds.parcels[0], pid = target.ids[0], before = ds.parcels.map(p => p.area);
const aff = Core.movePoints(ds, [pid], 0.5, 0);
console.log('移動點', pid, '影響宗地', [...aff].map(i => ds.parcels[i].label), '面積差', [...aff].map(i => (ds.parcels[i].area - before[i]).toFixed(3)));
assert.ok(aff.has(0)); assert.equal(ds.parcels.filter((p, i) => p.area !== before[i]).length, aff.size);
const ex = Core.exportD14(pts, ds); assert.equal(ex.changed, 1);
const back = Core.parseDbf(ex.bytes); const row = back.rows[ds.points.get(pid).row];
assert.ok(Math.abs(row.COT_Y - (ds.points.get(pid).y0 + 0.5)) < 1e-8);
let d2 = 0; for (let i = 0; i < ex.bytes.length; i++) if (ex.bytes[i] !== pts.u8[i]) d2++;
console.log('單點移動輸出，改動位元組數:', d2, '(<=16 為正常)'); assert.ok(d2 > 0 && d2 <= 31);
Core.resetAll(ds); assert.deepEqual(ds.parcels.map(p => p.area), before);

// ── 整張圖平移：面積不應變動 ──
Core.movePoints(ds, [...ds.points.keys()], 12.345, -7.891);
const drift = Math.max(...ds.parcels.map(p => Math.abs(p.area - p.areaOrig)));
console.log('整圖平移後面積最大漂移(m²):', drift.toExponential(2)); assert.ok(drift < 1e-6);
assert.equal(Core.exportSession(ds).parcels_changed.length, 0);
assert.equal(Core.exportD14(pts, ds).changed, ds.points.size);
Core.resetAll(ds);

// ── KC 文字檔 ──
const T = p => new TextDecoder('big5').decode(rd(p));
const kc = Core.datasetFromKC({ coa: T('samples/kc0336_1/KC0336.COA'), bnp: T('samples/kc0336_1/KC0336.BNP'), par: T('samples/kc0336_1/KC0336.PAR') });
let kok = 0; for (const p of kc.parcels) if (p.areaRef != null && Math.abs(p.areaOrig - p.areaRef) < 0.5) kok++;
console.log('KC: points', kc.points.size, 'parcels', kc.parcels.length, '面積吻合(0.5m²內)', kok);
assert.ok(kc.parcels.length > 0);
// ── 旋轉 / 對位 ──
const ds2 = Core.datasetFromD({ pts, bnd, par });
const ids2 = [...ds2.points.keys()], pv = Core.centroidOf(ds2.points, ids2);
const A0 = ds2.points.get(ids2[0]), B0 = ds2.points.get(ids2[100]), d0 = Math.hypot(A0.x - B0.x, A0.y - B0.y);
Core.transformPoints(ds2, ids2, { angle: 30 * Math.PI / 180, pivot: pv, dy: 5, dx: -3 });
const A1 = ds2.points.get(ids2[0]), B1 = ds2.points.get(ids2[100]);
assert.ok(Math.abs(Math.hypot(A1.x - B1.x, A1.y - B1.y) - d0) < 1e-6, '旋轉保距');
assert.ok(Math.max(...ds2.parcels.map(p => Math.abs(p.area - p.areaOrig))) < 1e-6, '旋轉保面積');
// 方向：逆時針 90°（北向上）：東方向的點應轉到北方
const q = Core.xform({ y: 0, x: 10 }, { angle: Math.PI / 2, pivot: { y: 0, x: 0 } }); assert.ok(Math.abs(q.y - 10) < 1e-9 && Math.abs(q.x) < 1e-9);
// 兩點對位：用已知變換造目標點，再解回來
const T0 = { angle: 0.0123, pivot: { y: A0.y0, x: A0.x0 }, dy: 1.234, dx: -2.345 };
const tA = Core.xform({ y: A0.y0, x: A0.x0 }, T0), tB = Core.xform({ y: B0.y0, x: B0.x0 }, T0);
const fit = Core.twoPointFit({ y: A0.y0, x: A0.x0 }, { y: B0.y0, x: B0.x0 }, tA, tB);
Core.resetAll(ds2); Core.transformPoints(ds2, ids2, fit.T);
const A2 = ds2.points.get(ids2[0]), B2 = ds2.points.get(ids2[100]);
assert.ok(Math.hypot(A2.y - tA.y, A2.x - tA.x) < 1e-6 && Math.hypot(B2.y - tB.y, B2.x - tB.x) < 1e-6 && Math.abs(fit.scale - 1) < 1e-9);
console.log('旋轉/兩點對位 OK，解得旋轉', (fit.angle * 180 / Math.PI).toFixed(5), '度');

// 來回旋轉後不應殘留「已移動」點
Core.resetAll(ds2); Core.transformPoints(ds2, ids2, { angle: 0.0087, pivot: pv }); Core.transformPoints(ds2, ids2, { angle: -0.0087, pivot: pv });
assert.equal(Core.movedPoints(ds2).length, 0, '往返旋轉後移動點數應為 0');
// ── 角度、現況點、極座標 ──
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, a + ' vs ' + b);
near(Core.parseAngle('123-45-30'), 123 + 45 / 60 + 30 / 3600); near(Core.parseAngle('90-00-00'), 90);
near(Core.parseAngle('123.4530', 'ddmmss'), 123 + 45 / 60 + 30 / 3600); near(Core.parseAngle('0.0001', 'ddmmss'), 1 / 3600);
near(Core.parseAngle('45.5', 'deg'), 45.5); near(Core.parseAngle('100', 'gon'), 90);
const NL = String.fromCharCode(10), TAB = String.fromCharCode(9);
const r1 = Core.parsePoints(['點號,N,E,H', 'A1,2706380.644,222129.682,12.3,POLE', 'A2' + TAB + '2706340.913' + TAB + '222155.190', '222199.902 2706320.295'].join(NL));
assert.equal(r1.points.length, 3); assert.equal(r1.points[0].code, 'POLE'); assert.equal(r1.points[0].h, 12.3);
assert.equal(r1.points[2].y, 2706320.295, 'EN 順序應自動辨識'); assert.equal(r1.skipped.length, 0);   // 首行標題列靜默略過
const r2 = Core.parsePoints('1 222129.682 2706380.644', { order: 'EN' }); assert.equal(r2.points[0].y, 2706380.644);
const ob = Core.parseObservations(['P1 0-00-00 90-00-00 100.000', 'P2 90-00-00 90-00-00 50', 'P3 180.0000 25.5'].join(NL)); assert.equal(ob.obs.length, 3);
const pr = Core.polarReduce({ station: { y: 1000, x: 2000 }, backAz: 0, obs: ob.obs.slice(0, 2) });
near(pr[0].y, 1100, 1e-9); near(pr[0].x, 2000, 1e-9); near(pr[1].y, 1000, 1e-9); near(pr[1].x, 2050, 1e-9);   // 方位 0°→北, 90°→東
near(Core.azimuth({ y: 0, x: 0 }, { y: 0, x: 5 }), 90);
const sv = Core.newSurvey(); const added = Core.addSurveyPoints(sv, [...r1.points, { name: 'A1', y: 0, x: 0 }]);
assert.equal(added[3], 'A1_2'); assert.equal(added[0], 'A1');
const sq = Core.addSurveyPoints(sv, [{ name: 'q1', y: 0, x: 0 }, { name: 'q2', y: 0, x: 10 }, { name: 'q3', y: 10, x: 10 }, { name: 'q4', y: 10, x: 0 }]);
const ln = Core.addLine(sv, sq, { closed: true }); const st = Core.lineStats(sv, ln); near(st.area, 100); near(st.length, 40);
console.log('角度/現況點/極座標/參考線 OK');

// ── KC1119（較完整的重測成果）──
const K = 'samples/KC1119/';
const kp = Core.parseDbf(rd(K + 'KC1119.D14')), kb = Core.parseDbf(rd(K + 'KC1119.D13')), kd = Core.parseDbf(rd(K + 'KC1119.D11'));
const kds = Core.datasetFromD({ pts: kp, bnd: kb, par: kd, d12: Core.parseDbf(rd(K + 'KC1119.D12')) });
let k2ok = 0, k2tot = 0, k2max = 0;
for (const p of kds.parcels) if (p.areaRef != null) { k2tot++; const d = Math.abs(p.areaOrig - p.areaRef); k2max = Math.max(k2max, d); if (d <= Math.max(0.15, p.areaRef * 2e-5)) k2ok++; }
console.log(`KC1119: points ${kds.points.size} parcels ${kds.parcels.length}，面積對照 AREA_NEW ${k2ok}/${k2tot}，最大差 ${k2max.toFixed(3)} m²`);
assert.ok(k2ok / k2tot > 0.95);
// ── TWD97 ↔ 經緯度 ──
const cm0 = Core.latLonToTm2(0, 121); near(cm0.x, 250000, 1e-6); near(cm0.y, 0, 1e-6);          // 中央經線赤道
const cm24 = Core.latLonToTm2(24, 121); near(cm24.x, 250000, 1e-6); // 獨立檢驗：以辛普森法對子午圈曲率半徑 M(φ)=a(1-e²)/(1-e²sin²φ)^1.5 積分，再乘 k0
{ const a_ = 6378137, f_ = 1 / 298.257222101, e2_ = 2 * f_ - f_ * f_, n = 2000, h = (24 * Math.PI / 180) / n; let sum = 0;
  const Mr = p => a_ * (1 - e2_) / Math.pow(1 - e2_ * Math.sin(p) ** 2, 1.5);
  for (let i = 0; i <= n; i++) sum += Mr(i * h) * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
  near(cm24.y, 0.9999 * sum * h / 3, 1e-4); }
const rt = Core.tm2ToLatLon(...Object.values(Core.latLonToTm2(24.4939, 120.6824)).slice(0, 2)); near(rt.lat, 24.4939, 1e-9); near(rt.lon, 120.6824, 1e-9);
const tx = Core.tm2ToLatLon(2706000, 222000);   // 通霄樣本區
assert.ok(tx.lat > 24.4 && tx.lat < 24.6 && tx.lon > 120.6 && tx.lon < 120.8, '樣本區應落在通霄一帶: ' + JSON.stringify(tx));
console.log('TWD97→經緯度：樣本(2706000,222000) =', tx.lat.toFixed(5), tx.lon.toFixed(5));
// ── CTL / CT2 / L02 控制點檔 ──
const ctl = Core.parseCtl(new TextDecoder('big5').decode(rd('samples/KC1119/KC0336.CTL')));
assert.equal(ctl.code, 'KC0336'); assert.ok(ctl.points.length > 100, 'CTL 點數');
assert.deepEqual([ctl.points[0].name, ctl.points[0].y, ctl.points[0].x], ['BMC001', 2706380.644, 222129.682]);
const l02 = Core.parseCtl(new TextDecoder('big5').decode(rd('samples/KC1119/KC0000.L02')));
assert.equal(l02.points[0].name, 'BMC001'); assert.equal(l02.points[0].x, 222129.682);   // L02：點名 新坐標 Y X
assert.equal(Core.parseCtl('KC0000').points.length, 0);   // 空 CTL（只有案號）
const merged = Core.parseCtl('KC1' + String.fromCharCode(10) + 'A1      2706380.644222129.682');   // NECEXE 定寬輸出 Y、X 緊貼
assert.deepEqual([merged.points[0].y, merged.points[0].x], [2706380.644, 222129.682]);
console.log('CTL:', ctl.points.length, '點；L02:', l02.points.length, '點');
// ── MAC 手簿檔 ──
const macText = new TextDecoder('big5').decode(rd('samples/MAC/sample.mac'));
const mac = Core.parseMac(macText);
assert.equal(mac.blocks.length, 2); assert.equal(mac.skipped.length, 0);
assert.deepEqual([mac.blocks[0].station, mac.blocks[0].back, mac.blocks[0].obs.length], ['HD054', 'HD055', 11]);
assert.deepEqual([mac.blocks[1].station, mac.blocks[1].back], ['QC1', 'HD054']);
near(mac.blocks[0].obs[1].h, 358 + 29 / 60 + 25 / 3600, 1e-9);   // 358.2925 → 358°29'25"
// 合成已知點：HD054 在 (2706000,222000)，HD055 在方位 45°、62.6 m
const k0 = { y: 2706000, x: 222000 }, az45 = 45 * Math.PI / 180;
const known = new Map([['HD054', k0], ['HD055', { y: k0.y + 62.6 * Math.cos(az45), x: k0.x + 62.6 * Math.sin(az45) }]]);
const red = Core.reduceMac(mac.blocks, known);
assert.equal(red.unresolved.length, 0); assert.equal(red.points.length, 10);   // 9 個測點 + 新測站 QC1
const p44 = red.points.find(p => p.name === '44.01');
near(Core.azimuth(k0, p44), 45 + (358 + 29 / 60 + 25 / 3600) - 360, 1e-7); near(Math.hypot(p44.y - k0.y, p44.x - k0.x), 6.676, 1e-9);
assert.equal(red.checks.length, 2);   // 兩次後視檢核：HD055 與 HD054
near(red.checks[0].diff, 0, 1e-6);    // 後視 HD055：量測 62.600 vs 計算 62.600
near(Math.abs(red.checks[1].diff), 0.004, 1e-6);   // 後視 HD054：檔內 33.228 vs QC1 由 33.232 化算 → 差 4 mm（資料本身的殘差）
// 已知點缺少時回報未解
const red2 = Core.reduceMac(mac.blocks, new Map([['HD054', k0]])); assert.equal(red2.unresolved.length, 2);
console.log('MAC 解析/化算 OK：', red.points.length, '點，後視檢核差', red.checks.map(c => c.diff.toFixed(4)).join(' / '));
console.log('ALL OK');
