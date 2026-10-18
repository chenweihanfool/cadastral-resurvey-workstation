// 不依賴真實案件資料的測試（公開倉庫可直接執行）：node test/synthetic.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const Core = createRequire(import.meta.url)('../src/core.js');
const near = (a, b, e = 1e-9, m = '') => assert.ok(Math.abs(a - b) < e, `${m} ${a} vs ${b}`);
const NL = String.fromCharCode(10), TAB = String.fromCharCode(9);

// ── 迷你 DBF 產生器（dBASE III）──
function makeDbf(fields, rows) {
  const hl = 32 + 32 * fields.length + 1, rl = 1 + fields.reduce((s, f) => s + f.len, 0), u8 = new Uint8Array(hl + rl * rows.length + 1), dv = new DataView(u8.buffer);
  u8[0] = 3; dv.setUint32(4, rows.length, true); dv.setUint16(8, hl, true); dv.setUint16(10, rl, true);
  fields.forEach((f, i) => { const o = 32 + 32 * i; for (let k = 0; k < f.name.length; k++) u8[o + k] = f.name.charCodeAt(k); u8[o + 11] = f.type.charCodeAt(0); u8[o + 16] = f.len; u8[o + 17] = f.dec || 0; });
  u8[32 + 32 * fields.length] = 0x0d;
  rows.forEach((r, i) => {
    let p = hl + i * rl; u8[p++] = 0x20;
    for (const f of fields) {
      const v = r[f.name]; let s;
      if (f.type === 'N') s = (v == null ? '' : Number(v).toFixed(f.dec || 0)).padStart(f.len, ' ');
      else if (f.type === 'L') s = (v ? 'T' : 'F').padEnd(f.len, ' ');
      else s = String(v ?? '').padEnd(f.len, ' ');
      for (let k = 0; k < f.len; k++) u8[p++] = s.charCodeAt(k);
    }
  });
  u8[u8.length - 1] = 0x1a; return u8;
}
const F_D14 = [{ name: 'COT_NUMBER', type: 'N', len: 5 }, { name: 'COT_REF', type: 'N', len: 2 }, { name: 'COT_Y', type: 'N', len: 16, dec: 8 }, { name: 'COT_X', type: 'N', len: 15, dec: 8 }];
const F_D13 = [{ name: 'O_SECTION', type: 'N', len: 4 }, { name: 'O_PARCEL', type: 'N', len: 4 }, { name: 'O_PARCEL_E', type: 'N', len: 4 },
  ...Array.from({ length: 8 }, (_, i) => [{ name: 'MIDARC_' + (i + 1), type: 'L', len: 1 }, { name: 'COORD_' + (i + 1), type: 'N', len: 5 }]).flat()];
const F_D11 = ['SECTION_O', 'PAR_O_M', 'PAR_O_C', 'PAR_N_M', 'PAR_N_C', 'SECTION_N'].map(name => ({ name, type: 'N', len: 4 })).concat([{ name: 'AREA_OLD', type: 'N', len: 10, dec: 6 }, { name: 'AREA_NEW', type: 'N', len: 10, dec: 6 }]);
const F_D12 = ['O_SECTION', 'O_PARCEL', 'O_PARCEL_E', 'I_SECTION', 'I_PARCEL', 'I_PARCEL_E'].map(name => ({ name, type: 'N', len: 4 }));
const pt = (n, y, x, ref = 0) => ({ COT_NUMBER: n, COT_REF: ref, COT_Y: y, COT_X: x });
const ring = (sec, m, c, ids, mid = []) => { const r = { O_SECTION: sec, O_PARCEL: m, O_PARCEL_E: c }; for (let i = 1; i <= 8; i++) { r['COORD_' + i] = ids[i - 1] || 0; r['MIDARC_' + i] = !!mid[i - 1]; } return r; };
const rd = (f, rows) => Core.parseDbf(makeDbf(f, rows));

// ── DBF 讀寫：以原值重寫必須逐位元相同；單點修改只動該筆 ──
{
  const bytes = makeDbf(F_D14, [pt(1, 2706000.123456, 222000.654321), pt(2, 2706010.5, 222010.25), pt(2, 1, 1, 31)]);
  const dbf = Core.parseDbf(bytes); assert.equal(dbf.n, 3); near(dbf.rows[0].COT_Y, 2706000.123456, 1e-8);
  const out = new Uint8Array(bytes); Core.patchDbfNumber(out, dbf, 0, 'COT_Y', 2706000.123456); Core.patchDbfNumber(out, dbf, 0, 'COT_X', 222000.654321);
  assert.deepEqual(out, bytes);
  Core.patchDbfNumber(out, dbf, 1, 'COT_X', 222011.5); const back = Core.parseDbf(out); near(back.rows[1].COT_X, 222011.5, 1e-8); assert.equal(back.rows[0].COT_X, dbf.rows[0].COT_X);
  assert.throws(() => Core.patchDbfNumber(out, dbf, 0, 'COT_X', 1e20), /超出欄寬/);
}

// ── 資料集、面積、REF=0、(0,0) 佔位點、共用點連動 ──
{
  const pts = rd(F_D14, [pt(1, 0, 0), pt(2, 0, 0, 5), pt(10, 1000, 2000), pt(11, 1000, 2010), pt(12, 1010, 2010), pt(13, 1010, 2000), pt(14, 1000, 2020), pt(15, 1010, 2020), pt(10, 999, 1999, 7)]);
  const bnd = rd(F_D13, [ring(1, 1, 0, [10, 11, 12, 13]), ring(1, 2, 0, [11, 14, 15, 12])]);
  const par = rd(F_D11, [{ SECTION_O: 1, PAR_O_M: 1, PAR_O_C: 0, PAR_N_M: 5, PAR_N_C: 0, SECTION_N: 9, AREA_OLD: 0.0099, AREA_NEW: 0.01 }, { SECTION_O: 1, PAR_O_M: 2, PAR_O_C: 0, PAR_N_M: 6, PAR_N_C: 1, SECTION_N: 9, AREA_OLD: 0.01, AREA_NEW: 0.01 }]);
  const ds = Core.datasetFromD({ pts, bnd, par });
  assert.equal(ds.points.size, 6, '只收 REF=0 且非 (0,0) 的點'); assert.equal(ds.parcels.length, 2);
  near(ds.parcels[0].area, 100); assert.equal(ds.parcels[0].label, '5'); assert.equal(ds.parcels[1].label, '6-1'); near(ds.parcels[0].areaRef, 100, 1e-6); near(ds.parcels[0].areaReg, 99, 1e-6);
  const aff = Core.movePoints(ds, [11], 5, 0); assert.deepEqual([...aff].sort(), [0, 1]);   // 共用點：兩宗同時變動
  near(ds.parcels[0].area, 75, 1e-9); near(ds.parcels[1].area, 75, 1e-9, '鄰地');   // 共用點北移 5 m，兩宗各縮 25 m²
  Core.resetAll(ds); Core.movePoints(ds, [11], 0, 5); near(ds.parcels[0].area, 125, 1e-9); near(ds.parcels[1].area, 75, 1e-9); near(ds.parcels[0].area + ds.parcels[1].area, 200, 1e-9);   // 沿共界東移：一增一減，總和不變
  assert.equal(Core.movedPoints(ds).length, 1); Core.resetAll(ds); assert.equal(Core.movedPoints(ds).length, 0);
  const b = Core.bounds(ds); assert.ok(b.x0 === 2000 && b.x1 === 2020 && b.y0 === 1000 && b.y1 === 1010, '全圖範圍不含離群點');
  const ex = Core.exportSession(ds); assert.equal(ex.parcels_changed.length, 0);
}

// ── 弧線（外凸、內凹、半圓）與地中地（內有洞）──
{
  const P = (n, y, x) => pt(n, y + 1000, x + 2000);   // 偏移避免 0 坐標（實務上不會出現，核心視 (0,0) 為空白佔位）
  const pts = rd(F_D14, [P(1, 0, -10), P(2, 10, 0), P(3, 0, 10),                       // 半圓：弦 P1→P3，弧中點 P2（y=北，x=東）
    P(11, 0, 0), P(12, 0, 20), P(13, 20, 20), P(14, 20, 0), P(15, -5, 10),           // 方形：底邊中點 P15 向外凸 5
    P(21, 5, 10),                                                                         // 方形：底邊中點向內凹 5
    P(31, 100, 100), P(32, 100, 200), P(33, 200, 200), P(34, 200, 100), P(35, 110, 110), P(36, 110, 120), P(37, 120, 120), P(38, 120, 110)]);
  const bnd = rd(F_D13, [ring(1, 1, 0, [1, 2, 3], [false, true, false]),
    ring(1, 2, 0, [11, 15, 12, 13, 14], [false, true, false, false, false]), ring(1, 3, 0, [11, 21, 12, 13, 14], [false, true, false, false, false]),
    ring(1, 4, 0, [31, 32, 33, 34]), ring(1, 5, 0, [35, 36, 37, 38])]);
  const d12 = rd(F_D12, [{ O_SECTION: 1, O_PARCEL: 4, O_PARCEL_E: 0, I_SECTION: 1, I_PARCEL: 5, I_PARCEL_E: 0 }]);
  const ds = Core.datasetFromD({ pts, bnd, d12 });
  near(ds.parcels[0].area, Math.PI * 100 / 2, 1e-6, '半圓');
  const seg = (c, h) => { const R = (c * c / 4 + h * h) / (2 * h); return R * R * Math.acos((R - h) / R) - (R - h) * Math.sqrt(2 * R * h - h * h); };
  near(ds.parcels[1].area, 400 + seg(20, 5), 1e-6, '外凸弧'); near(ds.parcels[2].area, 400 - seg(20, 5), 1e-6, '內凹弧');
  near(ds.parcels[3].area, 10000 - 100, 1e-9, '地中地：外圈減內圈'); near(ds.parcels[4].area, 100);
  assert.equal(ds.arcs.size, 3, '三段弧');
  Core.movePoints(ds, [38], 0, 5);   // 只動內圈的點 → 外圈面積也要重算
  assert.ok(Math.abs(ds.parcels[3].area - 9900) > 1 && Math.abs(ds.parcels[3].area + ds.parcels[4].area - 10000) < 1e-9, '內圈變動連動外圈');
  const ap = Core.arcPolyline({ y: 0, x: -10 }, { y: 10, x: 0 }, { y: 0, x: 10 }, 24); near(ap[12].y, 10, 1e-9); near(Math.hypot(ap[6].x, ap[6].y), 10, 1e-9);
}

// ── 變換：旋轉保距保面積、方向、往返、兩點對位 ──
{
  const pts = rd(F_D14, [pt(1, 2706000, 222000), pt(2, 2706000, 222100), pt(3, 2706100, 222100), pt(4, 2706100, 222000)]);
  const ds = Core.datasetFromD({ pts, bnd: rd(F_D13, [ring(1, 1, 0, [1, 2, 3, 4])]) }), ids = [...ds.points.keys()], pv = Core.centroidOf(ds.points, ids);
  Core.transformPoints(ds, ids, { angle: 30 * Math.PI / 180, pivot: pv, dy: 5, dx: -3 }); near(ds.parcels[0].area, 10000, 1e-6);
  const p1 = ds.points.get(1), p2 = ds.points.get(2); near(Math.hypot(p1.x - p2.x, p1.y - p2.y), 100, 1e-7);
  const q = Core.xform({ y: 0, x: 10 }, { angle: Math.PI / 2, pivot: { y: 0, x: 0 } }); near(q.y, 10); near(q.x, 0);   // 逆時針為正：東→北
  Core.resetAll(ds); Core.transformPoints(ds, ids, { angle: 0.0087, pivot: pv }); Core.transformPoints(ds, ids, { angle: -0.0087, pivot: pv }); assert.equal(Core.movedPoints(ds).length, 0);
  const T0 = { angle: 0.0123, pivot: { y: 2706000, x: 222000 }, dy: 1.234, dx: -2.345 }, a = { y: 2706000, x: 222000 }, b = { y: 2706000, x: 222100 };
  const f = Core.twoPointFit(a, b, Core.xform(a, T0), Core.xform(b, T0)); near(f.scale, 1, 1e-8); near(f.angle, 0.0123, 1e-10);
  const g = Core.twoPointFit(a, b, { y: 0, x: 0 }, { y: 0, x: 200 }); near(g.scale, 2);   // 距離不一致時回報比值
}

// ── 角度、座標檔、極座標、控制點檔、MAC ──
{
  near(Core.parseAngle('123-45-30'), 123 + 45 / 60 + 30 / 3600); near(Core.parseAngle('123.4530', 'ddmmss'), 123 + 45 / 60 + 30 / 3600);
  near(Core.parseAngle('0.0001', 'ddmmss'), 1 / 3600); near(Core.parseAngle('45.5', 'deg'), 45.5); near(Core.parseAngle('100', 'gon'), 90);
  const r1 = Core.parsePoints(['點號,N,E,H', 'A1,2706380.644,222129.682,12.3,POLE', 'A2' + TAB + '2706340.913' + TAB + '222155.190', '222199.902 2706320.295'].join(NL));
  assert.equal(r1.points.length, 3); assert.equal(r1.points[0].code, 'POLE'); assert.equal(r1.points[2].y, 2706320.295, 'E,N 顛倒自動辨識');
  const pr = Core.polarReduce({ station: { y: 1000, x: 2000 }, backAz: 0, obs: Core.parseObservations(['P1 0-00-00 90-00-00 100', 'P2 90-00-00 90-00-00 50'].join(NL)).obs });
  near(pr[0].y, 1100, 1e-9); near(pr[1].x, 2050, 1e-9);
  const ctl = Core.parseCtl(['KC0000', 'BMC001   2706380.644 222129.682', 'BMC002 新坐標 2706340.913 222155.190', 'A1      2706380.644222129.682'].join(NL));
  assert.equal(ctl.code, 'KC0000'); assert.equal(ctl.points.length, 3); assert.equal(ctl.points[2].x, 222129.682); assert.equal(Core.parseCtl('KC0000').points.length, 0);
  // MAC：LS () 標頭；「測站 後視」；「點號 水平角(ddd.mmss) 距離」
  const mac = Core.parseMac(['LS ()', 'A B', 'B 0.0000 100.000', 'P1 90.0000 10.000', 'C 180.0000 20.000', 'C A', 'A 0.0000 20.000', 'Q1 270.0000 5.000'].join(NL));
  assert.equal(mac.blocks.length, 2); assert.equal(mac.skipped.length, 0);
  const known = new Map([['A', { y: 0, x: 0 }], ['B', { y: 100, x: 0 }]]);   // B 在 A 正北 100 m → 後視方位 0°
  const red = Core.reduceMac(mac.blocks, known);
  assert.equal(red.unresolved.length, 0); near(red.checks[0].diff, 0, 1e-9);
  const p1 = red.points.find(p => p.name === 'P1'), c = red.points.find(p => p.name === 'C');
  near(p1.x, 10, 1e-9); near(p1.y, 0, 1e-9);            // 水平角 90° → 正東
  near(c.y, -20, 1e-9); near(c.x, 0, 1e-9);              // 水平角 180° → 正南；C 成為下一段的測站
  const q1 = red.points.find(p => p.name === 'Q1'); assert.ok(q1, 'C 段（測站 C，後視 A）可用前一段算出的 C');
  assert.equal(Core.reduceMac(mac.blocks, new Map([['A', { y: 0, x: 0 }]])).unresolved.length, 2, '缺 B 時兩段皆無法化算');
  const sv = Core.newSurvey(), names = Core.addSurveyPoints(sv, [{ name: 'a', y: 0, x: 0 }, { name: 'a', y: 0, x: 10 }, { name: 'b', y: 10, x: 10 }, { name: 'c', y: 10, x: 0 }]);
  assert.deepEqual(names, ['a', 'a_2', 'b', 'c']); const ln = Core.addLine(sv, names, { closed: true }); const st = Core.lineStats(sv, ln); near(st.area, 100); near(st.length, 40);
}

// ── 舊圖數化：D2B 地號全為 0 不是界址環；線由 D2D 讀 ──
{
  const F_LIN = ['LIN_TOP', 'LIN_MID', 'LIN_BOT'].map(name => ({ name, type: 'N', len: 5 }));
  const P = Core.parseDbf(makeDbf(F_D14, [pt(1, 2700010, 200010), pt(2, 2700010, 200020), pt(3, 2700020, 200020), pt(4, 2700015, 200025)]));
  const B = Core.parseDbf(makeDbf(F_D13, [ring(0, 0, 0, [1, 2, 3, 4])]));
  assert.equal(Core.datasetFromD({ pts: P, bnd: B }).parcels.length, 0, '地號全 0 的串不當宗地');
  const L = Core.parseDbf(makeDbf(F_LIN, [{ LIN_TOP: 1, LIN_MID: 0, LIN_BOT: 2 }, { LIN_TOP: 2, LIN_MID: 4, LIN_BOT: 3 }, { LIN_TOP: 9, LIN_MID: 0, LIN_BOT: 3 }, { LIN_TOP: 1, LIN_MID: 0, LIN_BOT: 1 }]));
  const dl = Core.datasetFromLines({ pts: P, lin: L });
  assert.equal(dl.edges.size, 2, '缺點與退化線略過'); assert.equal(dl.parcels.length, 0); assert.ok(dl.arcs.has('2|4|3') && dl.edges.get('2-3').arcPart);
}
// ── 鄰段接合：重合／重疊／脫開、以鄰段為準吸附 ──
{
  const Y = 2700000, X = 200000, ds = (pts, rings) => Core.datasetFromD({ pts: Core.parseDbf(makeDbf(F_D14, pts.map(([n, y, x]) => pt(n, Y + y, X + x)))), bnd: Core.parseDbf(makeDbf(F_D13, rings)) });
  const nb = ds([[1, 0, 0], [2, 0, 10], [3, 10, 10], [4, 10, 0]], [ring(1, 1, 0, [1, 2, 3, 4])]);                      // 鄰段：x 0~10
  const main = ds([[11, 0, 10.4], [12, 0, 20], [13, 10, 20], [14, 9.5, 9.7]], [ring(2, 1, 0, [11, 12, 13, 14])]);        // 主區：11 脫開 0.4、14 重疊 0.3（在鄰段宗地內）
  const rep = Core.seamAnalyze(main, [{ name: 'NB', ds: nb }], {}), r = Object.fromEntries(rep.neighbors[0].points.map(p => [p.id, p]));
  assert.equal(rep.totals.checked, 2, '離鄰段段界超過搜尋距離的點不檢查'); assert.equal(r[11].status, 'gap'); near(r[11].gap_m, 0.4, 1e-9); assert.equal(r[14].status, 'overlap'); near(r[14].gap_m, -0.3, 1e-9);
  assert.equal(Core.seamAnalyze(main, [{ name: 'NB', ds: nb }], { tol: 0.5 }).totals.coincide, 2, '容差放寬則視為重合');
  const j = Core.seamJoin(main, [{ name: 'NB', ds: nb }], {});
  assert.equal(j.moves.length, 2); assert.equal(j.after.totals.coincide, 2); assert.equal(j.after.totals.gap + j.after.totals.overlap, 0);
  near(main.points.get(11).x, X + 10, 1e-9); near(main.points.get(14).x, X + 10, 1e-9); near(main.points.get(14).y, Y + 10, 1e-9);
  assert.equal(Core.seamJoin(main, [{ name: 'NB', ds: nb, authoritative: false }], {}).moves.length, 0, '非「以鄰段為準」不吸附');
  { const csv = Core.movedPointsCsv(main, j).split('\n'); assert.equal(csv.length, 3, '兩個異動點＋標題'); assert.ok(csv[1].includes('吸附到鄰段界址點') && csv[1].includes('NB')); assert.equal(Core.movedPointsCsv(nb).split('\n').length, 1, '沒有異動點只有標題'); }
  assert.ok(Core.seamReportText(j.after).includes('重合 2') && Core.seamReportCsv(j.after).split('\n').length >= 3);
  // 吸附上限以外：只報告、不移動
  const far = ds([[11, 0, 11.5], [12, 0, 20], [13, 10, 20], [14, 10, 11.5]], [ring(2, 1, 0, [11, 12, 13, 14])]), jf = Core.seamJoin(far, [{ name: 'NB', ds: nb }], { snap: 1 });
  assert.equal(jf.moves.length, 0); assert.equal(jf.unresolved.length, 2); assert.equal(jf.after.totals.gap, 2);
  // 多點搶同一鄰段點：只有最近的一點過去，另一點留待人工
  const two = ds([[11, 0, 10.2], [15, 0.1, 10.5], [12, 0, 20], [13, 10, 20], [14, 10, 10.2]], [ring(2, 1, 0, [11, 15, 12, 13, 14])]), jt = Core.seamJoin(two, [{ name: 'NB', ds: nb }], {});
  assert.ok(jt.unresolved.some(u => u.reason === 'conflict') && jt.moves.some(m => m.id === 11 && m.type === 'vertex'));
}
// ── TWD97 ↔ 經緯度 ──
{
  const o = Core.latLonToTm2(0, 121); near(o.x, 250000, 1e-6); near(o.y, 0, 1e-6);
  const a_ = 6378137, f_ = 1 / 298.257222101, e2_ = 2 * f_ - f_ * f_, n = 2000, h = (24 * Math.PI / 180) / n; let sum = 0;   // 子午線弧長：辛普森法積分（獨立檢驗）
  for (let i = 0; i <= n; i++) sum += a_ * (1 - e2_) / Math.pow(1 - e2_ * Math.sin(i * h) ** 2, 1.5) * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
  near(Core.latLonToTm2(24, 121).y, 0.9999 * sum * h / 3, 1e-4);
  const ll = Core.latLonToTm2(24.4939, 120.6824), rt = Core.tm2ToLatLon(ll.y, ll.x); near(rt.lat, 24.4939, 1e-9); near(rt.lon, 120.6824, 1e-9);
  const w = Core.latLonToTm2(23.5, 119.5, 119); near(Core.tm2ToLatLon(w.y, w.x, 119).lon, 119.5, 1e-9);
}
// ── 版本號與版本歷程資料 ──
{
  assert.ok(Core.compareVersions('v0.10.0', 'v0.9.9') > 0 && Core.compareVersions('1.0.0', 'v1.0.0') === 0 && Core.compareVersions('v0.3.0', 'v0.4.0') < 0 && Core.compareVersions('v1.2', 'v1.2.1') < 0);
  const log = createRequire(import.meta.url)('../src/changelog.js'), pkg = createRequire(import.meta.url)('../package.json');
  assert.equal('v' + pkg.version, log[0].version, 'package.json 版本需等於 changelog 最新一筆');
  const seen = new Set();
  log.forEach((e, i) => {
    assert.match(e.version, /^v\d+\.\d+\.\d+$/); assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/); assert.ok(['major', 'minor', 'patch'].includes(e.type), e.version + ' type');
    assert.ok(e.title && Array.isArray(e.changes) && e.changes.length, e.version + ' 內容'); assert.ok(!seen.has(e.version), '版本重複 ' + e.version); seen.add(e.version);
    if (i) assert.ok(Core.compareVersions(log[i - 1].version, e.version) > 0, '版本需由新到舊：' + e.version);
  });
}
console.log('SYNTHETIC OK');
