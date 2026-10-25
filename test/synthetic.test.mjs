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
// ── 影像定位檔 JGW ──
{
  const wf = Core.parseWorldFile('0.1\r\n0\r\n0\r\n-0.1\r\n222000.05\r\n2706000.05\r\n'), q = Core.imageCorners(wf, 100, 50);
  near(q[0].x, 222000.0, 1e-9); near(q[0].y, 2706000.10, 1e-9); near(q[2].x, 222010.0, 1e-9); near(q[2].y, 2705995.10, 1e-9);   // 左上角在左上像元中心再往左上半個像元
  const b = Core.imageBounds(wf, 100, 50); near(b.x1 - b.x0, 10, 1e-9); near(b.y1 - b.y0, 5, 1e-9);
  const rt = Core.parseWorldFile(Core.worldFileText(wf)); near(rt.c, wf.c, 1e-9); near(rt.f, wf.f, 1e-9); near(rt.e, -0.1, 1e-12);
  const rot = Core.imageBounds({ a: 0, d: 1, b: 1, e: 0, c: 0, f: 0 }, 10, 10); near(rot.x1 - rot.x0, 10, 1e-9);                  // 旋轉 90°（含鏡射）的範圍
  // 影像尺寸：JPEG（前面有 APP0 與 DHT 段）、PNG
  const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xc4, 0, 3, 9, 0xff, 0xc0, 0, 11, 8, 0x04, 0xb0, 0x06, 0x40, 1, 1, 0x11, 0, 0xff, 0xd9]);
  assert.deepEqual(Core.imageSize(jpg), { w: 1600, h: 1200 });
  const png = new Uint8Array(33); png.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x03, 0x20, 0, 0, 0x02, 0x58]);
  assert.deepEqual(Core.imageSize(png), { w: 800, h: 600 }); assert.equal(Core.imageSize(Uint8Array.from([1, 2, 3, 4, 5])), null);
  assert.throws(() => Core.parseWorldFile('1\n2\n3'), /6 行/); assert.throws(() => Core.parseWorldFile('0\n0\n0\n0\n1\n1'), /像元大小/);
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
// ── 界址點編修：新增／刪除維持宗地完整、一鍵清理、輸出 ──
{
  const Y = 2700000, X = 200000, P = [[1, 0, 0], [2, 0, 10], [3, 10, 10], [4, 10, 0], [5, 0, 20], [6, 10, 20]];   // A=[1,2,3,4]、B=[2,5,6,3] 共用 2–3
  const rows = [ring(1, 1, 0, [1, 2, 3, 4]), ring(1, 2, 0, [2, 5, 6, 3])];
  const mk = () => Core.datasetFromD({ pts: Core.parseDbf(makeDbf(F_D14, P.map(([n, y, x]) => pt(n, Y + y, X + x)))), bnd: Core.parseDbf(makeDbf(F_D13, rows)) });
  const ds = mk(), A = ds.parcels[0], B = ds.parcels[1];
  // 在共用邊 2–3 上加點：兩宗地都要插入，面積不變；點落在線上（垂足）
  const r = Core.insertPoint(ds, 2, 3, Y + 5, X + 14);
  assert.equal(r.id, 7); assert.deepEqual(A.ids, [1, 2, 7, 3, 4]); assert.deepEqual(B.ids, [2, 5, 6, 3, 7]); assert.ok(A.ids.includes(7) && B.ids.includes(7), '共用邊上加點：兩邊宗地都要有');
  near(ds.points.get(7).x, X + 10, 1e-9); near(ds.points.get(7).y, Y + 5, 1e-9); near(A.area, 100, 1e-6); near(B.area, 100, 1e-6);
  assert.ok(ds.edges.has('2-7') && ds.edges.has('3-7') && !ds.edges.has('2-3'));
  Core.applyDelta(ds, r.delta, 'undo'); assert.ok(!ds.points.has(7) && A.ids.length === 4 && B.ids.length === 4 && ds.edges.has('2-3')); Core.applyDelta(ds, r.delta, 'redo'); assert.ok(A.ids.includes(7));
  // 刪除：兩邊一起刪、還原原貌；環只剩 2 點則拒絕
  const rm = Core.removePoints(ds, [7]); assert.deepEqual(rm.done, [7]); assert.ok(!A.ids.includes(7) && !B.ids.includes(7));
  const tri = Core.datasetFromD({ pts: Core.parseDbf(makeDbf(F_D14, [pt(1, Y, X), pt(2, Y, X + 10), pt(3, Y + 10, X)])), bnd: Core.parseDbf(makeDbf(F_D13, [ring(1, 1, 0, [1, 2, 3])])) });
  assert.ok(Core.removeBlocker(tri, 1), '三角形不能再少點'); assert.equal(Core.removePoints(tri, [1]).done.length, 0);
  // 圓弧點不可刪、弧上不可加點
  const arc = Core.datasetFromD({ pts: Core.parseDbf(makeDbf(F_D14, [pt(1, Y, X), pt(2, Y + 5, X + 5), pt(3, Y, X + 10), pt(4, Y + 10, X + 10), pt(5, Y + 10, X)])), bnd: Core.parseDbf(makeDbf(F_D13, [ring(1, 1, 0, [1, 2, 3, 4, 5], [false, true])])) });
  assert.ok(Core.removeBlocker(arc, 2) && Core.removeBlocker(arc, 1) && Core.removeBlocker(arc, 3), '弧中點與弧端點都不可刪'); assert.throws(() => Core.insertPoint(arc, 1, 2, Y, X + 1));
  // 一鍵清理：孤立點、直線上的點（相對門檻）、轉角點不動
  const c = mk(); const a0 = c.parcels[0].area;
  Core.addFreePoint(c, Y + 50, X + 50, 90);                                        // 孤立點
  const on = Core.insertPoint(c, 1, 2, Y, X + 5, {}).id;                          // 線上（偏差 0）
  const off = Core.insertPoint(c, 4, 1, Y + 5, X, { project: false }).id; Core.movePoints(c, [off], 0, 0.02);   // 偏 2 cm（10 m 線；1‰＝1 cm）
  assert.deepEqual(Core.unusedPoints(c), [90]);
  let pv = Core.cleanupPoints(c, {}); assert.deepEqual(pv.unused, [90]); assert.deepEqual(pv.collinear, [on], '偏 2 cm 的點在 1‰ 下不算多餘');
  Core.applyDelta(c, pv.delta, 'undo'); assert.ok(c.points.has(90) && c.points.has(on), '預覽後可還原');
  pv = Core.cleanupPoints(c, { ratio: 0.005 }); assert.deepEqual(pv.collinear.sort(), [on, off].sort()); near(c.parcels[0].area, a0, 0.2); assert.ok(c.parcels[0].ids.length === 4 || c.parcels[0].ids.length === 4);
  assert.ok(!Core.collinearCandidates(c).some(q => [1, 2, 3, 4].includes(q.id)), '轉角點不可當多餘點');
  const corner = mk(), cc = Core.insertPoint(corner, 2, 3, Y + 5, X + 10).id; Core.movePoints(corner, [cc], 0, 3);   // 凸出 3 m：不是直線
  assert.ok(!Core.collinearCandidates(corner).some(q => q.id === cc));
  // T 字路口：B 在 A 內是直線、但在 B2 宗地是轉角 → 不可刪
  const T = Core.datasetFromD({ pts: Core.parseDbf(makeDbf(F_D14, [pt(1, Y, X), pt(2, Y, X + 10), pt(3, Y, X + 20), pt(4, Y + 10, X + 20), pt(5, Y + 10, X), pt(6, Y - 10, X + 10)].concat([pt(7, Y - 10, X), pt(8, Y - 10, X + 20)]))),
    bnd: Core.parseDbf(makeDbf(F_D13, [ring(1, 1, 0, [1, 2, 3, 4, 5]), ring(1, 2, 0, [1, 7, 6, 2]), ring(1, 3, 0, [2, 6, 8, 3])])) });
  assert.ok(!Core.collinearCandidates(T).some(q => q.id === 2), 'T 字路口的點不可刪');
  // 輸出：新增點附加進 D14；D13 環改寫；重新載入後與編修結果一致
  const e = mk(), n7 = Core.insertPoint(e, 2, 3, Y + 5, X + 10).id, n8 = Core.insertPoint(e, 1, 2, Y, X + 5).id;
  const d14 = Core.parseDbf(makeDbf(F_D14, P.map(([n, y, x]) => pt(n, Y + y, X + x)))), d13 = Core.parseDbf(makeDbf(F_D13, rows));
  const o14 = Core.exportD14(d14, e), o13 = Core.exportD13(d13, e); assert.equal(o14.added, 2);
  const back = Core.datasetFromD({ pts: Core.parseDbf(o14.bytes), bnd: Core.parseDbf(o13.bytes) });
  assert.deepEqual(back.parcels.map(p => p.ids), e.parcels.map(p => p.ids)); assert.ok(back.points.has(n7) && back.points.has(n8)); near(back.points.get(n7).x, X + 10, 1e-6);
  assert.equal(Core.parseDbf(o14.bytes).n, 8); assert.equal(o14.bytes[o14.bytes.length - 1], 0x1a);
  // 環超過 8 點 → 檔尾附加記錄
  const big = mk(); let last = 4; for (let i = 0; i < 9; i++) last = Core.insertPoint(big, last, 1, Y + 9 - i, X).id;
  const bo = Core.exportD13(d13, big); assert.equal(bo.appended, 1); { const bb = Core.datasetFromD({ pts: Core.parseDbf(Core.exportD14(d14, big).bytes), bnd: Core.parseDbf(bo.bytes) }); assert.deepEqual(bb.parcels[0].ids, big.parcels[0].ids); }
  // 還原全部：結構一起還原
  Core.resetAll(big); assert.equal(big.parcels[0].ids.length, 4); assert.equal(big.points.size, 6); assert.equal(Core.structSummary(big).added, 0);
}
// ── 宗地關係偵錯報表（.ERR）──
{
  const Y = 2700000, X = 200000;
  const ds = Core.datasetFromD({ pts: Core.parseDbf(makeDbf(F_D14, [[1, 0, 0], [2, 0, 10], [3, 10, 10], [4, 10, 0], [5, 0, 20], [6, 10, 20], [900, 50, 50]].map(([n, y, x]) => pt(n, Y + y, X + x)))), bnd: Core.parseDbf(makeDbf(F_D13, [ring(336, 1, 0, [1, 2, 3, 4]), ring(336, 2, 0, [2, 5, 6, 3])])),
    par: Core.parseDbf(makeDbf(F_D11, [{ SECTION_O: 336, PAR_O_M: 1, PAR_O_C: 0, PAR_N_M: 1, PAR_N_C: 0, SECTION_N: 336, AREA_OLD: 100, AREA_NEW: 0.01 }, { SECTION_O: 336, PAR_O_M: 2, PAR_O_C: 0, PAR_N_M: 2, PAR_N_C: 0, SECTION_N: 336, AREA_OLD: 100, AREA_NEW: 0.01 }, { SECTION_O: 336, PAR_O_M: 9, PAR_O_C: 0, PAR_N_M: 9, PAR_N_C: 1, SECTION_N: 336, AREA_OLD: 5, AREA_NEW: 0.0001 }])) });
  const outl = Core.outlineLoops(ds, [0, 1]); assert.equal(outl.length, 1); near(outl[0].area, 200, 1e-6); assert.equal(outl[0].ids.length, 6, '共邊不算外圍：外圍 6 點');
  const txt = Core.errReport(ds, { name: 'KC9', date: new Date(2026, 2, 27) });
  assert.ok(txt.includes('重測成果檢核 KC9 (115. 3.27)') && txt.includes('段外圍面積 = 200.00 ㎡') && txt.includes('宗地地號 9-1-336 無地號界址') && txt.includes('界址點號 7 - 899 為空號') && txt.includes('未被任何宗地使用的界址點 1 個：900') && txt.includes('(END)'));
  assert.ok(txt.includes('\n      1       2       3 ') || txt.split('\n').some(l => /^ +\d+ +\d+ +\d+ /.test(l)), 'id 每格寬 8、每行 10 個');
}
// ── 清理遇鄰段接縫：鄰段有點的位置測區必須有點（不刪、缺則補）──
{
  const Y = 2700000, X = 200000, mk = (pts, rings) => Core.datasetFromD({ pts: Core.parseDbf(makeDbf(F_D14, pts.map(([n, y, x]) => pt(n, Y + y, X + x)))), bnd: Core.parseDbf(makeDbf(F_D13, rings)) });
  const main = mk([[1, 0, 0], [2, 0, 10], [3, 10, 10], [4, 10, 0], [7, 5, 10], [8, 8, 10]], [ring(1, 1, 0, [1, 2, 7, 8, 3, 4])]);
  const nb = mk([[11, 0, 10], [12, 0, 20], [13, 10, 20], [14, 10, 10], [15, 5, 10], [16, 2, 10]], [ring(1, 2, 0, [11, 12, 13, 14, 15, 16])]);
  const g = Core.seamGuard(main, [{ name: 'NB', ds: nb }], {});
  assert.ok(g.protect.has(7) && g.protect.has(2) && g.protect.has(3) && !g.protect.has(8), '鄰段有點的位置受保護、鄰段沒點的不保護');
  assert.equal(g.adds.length, 1); near(g.adds[0].y, Y + 2, 1e-9);
  const plain = Core.cleanupPoints(main, {}); assert.ok(plain.collinear.includes(7) && plain.collinear.includes(8), '不帶接縫守則：直線上的點都會被刪');
  Core.applyDelta(main, plain.delta, 'undo');
  const r = Core.cleanupPoints(main, { protect: g.protect, adds: g.adds, tol: g.tol });
  assert.deepEqual(r.collinear, [8], '7 受保護不刪，8 刪'); assert.equal(r.added.length, 1); assert.ok(r.kept >= 1);
  const ids = main.parcels[0].ids; assert.ok(ids.includes(7) && !ids.includes(8) && ids.includes(r.added[0].id));
  const np = main.points.get(r.added[0].id); near(np.x, X + 10, 1e-9); near(np.y, Y + 2, 1e-9); near(main.parcels[0].area, 100, 1e-6);
  assert.ok(Core.seamAnalyze(main, [{ name: 'NB', ds: nb }], {}).totals.neighbor_missing_in_main === 0, '補點後鄰段點在測區都有對應');
  Core.applyDelta(main, r.delta, 'undo'); assert.deepEqual(main.parcels[0].ids, [1, 2, 7, 8, 3, 4], '整批可復原');
}
// ── 真實案件 KC0336 的教訓：縮短的 D13 不可留舊點號、清理不可跨過鄰地的點、交錯／重疊偵測 ──
{
  const Y = 2700000, X = 200000, mk = (pts, rings) => Core.datasetFromD({ pts: Core.parseDbf(makeDbf(F_D14, pts.map(([n, y, x]) => pt(n, Y + y, X + x)))), bnd: Core.parseDbf(makeDbf(F_D13, rings)) });
  // (a) 環 10 點（2 筆記錄）去點後只剩 4 點：第 2 筆要清成 0；NECEXE 不看刪除旗標，所以忽略旗標重讀也必須與記憶體一致
  const P = [[1, 0, 0], [2, 0, 2], [3, 0, 4], [4, 0, 6], [5, 0, 8], [6, 0, 10], [7, 10, 10], [8, 10, 0], [9, 8, 0], [10, 5, 0]];
  const d14 = Core.parseDbf(makeDbf(F_D14, P.map(([n, y, x]) => pt(n, Y + y, X + x)))), d13 = Core.parseDbf(makeDbf(F_D13, [ring(1, 1, 0, [1, 2, 3, 4, 5, 6, 7, 8]), ring(1, 1, 0, [9, 10])]));
  const ds = Core.datasetFromD({ pts: d14, bnd: d13 }); assert.equal(ds.parcels[0].ids.length, 10);
  const r = Core.cleanupPoints(ds, {}); assert.deepEqual(ds.parcels[0].ids, [1, 6, 7, 8], '共線點都刪、剩 4 個轉角');
  const o = Core.exportD13(d13, ds), bp = Core.parseDbf(o.bytes), flagless = Core.datasetFromD({ pts: d14, bnd: { ...bp, rows: bp.rows.map(x => ({ ...x, _deleted: false })) } });
  assert.deepEqual(flagless.parcels[0].ids, [1, 6, 7, 8], '忽略刪除旗標重讀也不可殘留舊點號');
  assert.ok(bp.rows[1].COORD_1 === 0 && bp.rows[1].COORD_2 === 0 && !bp.rows[1]._deleted, '多出的列清成 0，不設刪除旗標');
  // (b) 三角形內有別宗地的點：不可刪（弦會跨過它）
  const mk2 = withX => mk([[1, 0, 0], [2, 0.3, 10], [3, 0, 20], [4, 10, 20], [5, 10, 0], [6, -10, 0], [7, -10, 20], [8, 0.1, 10]], [ring(1, 1, 0, [1, 2, 3, 4, 5]), ring(1, 2, 0, withX ? [3, 8, 1] : [6, 7, 3, 1])]);   // 別宗地只有 3 點（8 不能刪）：點 8 在三角形 1-2-3 內
  const blocked = mk2(true), rb = Core.cleanupPoints(blocked, { ratio: 0.02, maxAbs: 0 }); assert.ok(rb.blocked.some(q => q.id === 2 && q.by === 8) && blocked.parcels[0].ids.includes(2), '別宗地的點在三角形內 → 保留');
  const free = mk2(false), rf = Core.cleanupPoints(free, { ratio: 0.02, maxAbs: 0 }); assert.ok(rf.collinear.includes(2), '沒有別的點擋著 → 刪');
  // (c) 交錯／重疊偵測
  const X1 = mk([[1, 0, 0], [2, 0, 10], [3, 10, 10], [4, 10, 0], [5, 5, 5], [6, 5, 15], [7, 15, 15], [8, 15, 5]], [ring(1, 1, 0, [1, 2, 3, 4]), ring(1, 2, 0, [5, 6, 7, 8])]);
  assert.ok(Core.ringConflicts(X1).cross.length >= 2, '兩個方形交疊 → 邊相交');
  const OV = mk([[1, 0, 0], [2, 0, 10], [3, 10, 10], [4, 10, 0], [5, 0, 5], [6, -10, 5], [7, -10, 0]], [ring(1, 1, 0, [1, 2, 3, 4]), ring(1, 2, 0, [1, 5, 6, 7])]);   // 1–5 與 1–2 共端點 1 且共線重疊
  assert.equal(Core.ringConflicts(OV).overlap.length, 1);
  const okSq = mk([[1, 0, 0], [2, 0, 10], [3, 10, 10], [4, 10, 0], [5, 0, 20], [6, 10, 20]], [ring(1, 1, 0, [1, 2, 3, 4]), ring(1, 2, 0, [2, 5, 6, 3])]);
  assert.deepEqual([Core.ringConflicts(okSq).cross.length, Core.ringConflicts(okSq).overlap.length], [0, 0], '正常相鄰宗地沒有衝突');
  assert.ok(Core.errReport(X1, { name: 'X' }).includes('交錯'));
}
// ── 三叉點（KC0336 的 5236）：各環看到的鄰點不同，各自去點會留下縫 → 不可刪；自由閉合區偵測 ──
{
  const Y = 2700000, X = 200000, mk = (pts, rings) => Core.datasetFromD({ pts: Core.parseDbf(makeDbf(F_D14, pts.map(([n, y, x]) => pt(n, Y + y, X + x)))), bnd: Core.parseDbf(makeDbf(F_D13, rings)) });
  // J(1)、K(2) 是 R1／R2 的共用邊；R1 在 J 的鄰點是 A(3)，R2 在 J 的鄰點是 B(4)，R3 是補滿 A–J–B 楔形的三角形：兩宗各自看 J 都差 0.5 m、1/40
  const P = [[1, 0, 0], [2, 0, 10], [3, 1, -10], [4, -1, -10], [5, 5, 10], [6, 5, -10], [7, -5, 10], [8, -5, -10], [9, 1, -20], [10, -1, -20]];
  const rings = [ring(1, 1, 0, [3, 1, 2, 5, 6]), ring(1, 2, 0, [4, 1, 2, 7, 8]), ring(1, 3, 0, [3, 4, 1])];
  const ds = mk(P, rings); assert.equal(Core.freeRegions(ds).length, 0, '原本沒有縫');
  assert.ok(!Core.collinearCandidates(ds, { ratio: 0.03, maxAbs: 0 }).some(c => c.id === 1), '三叉點不是候選');
  Core.cleanupPoints(ds, { ratio: 0.03, maxAbs: 0 }); assert.ok(ds.points.has(1) && ds.parcels[0].ids.includes(1) && ds.parcels[1].ids.includes(1), '三叉點保留'); assert.equal(Core.freeRegions(ds).length, 0, '清理後沒有縫');
  // 若各環自行把 J 拿掉，A–K、B–K 兩條弦與 A–B 之間就是 20 m² 的自由閉合區
  const bad = mk(P, [ring(1, 1, 0, [3, 2, 5, 6]), ring(1, 2, 0, [4, 2, 7, 8]), ring(1, 4, 0, [9, 10, 4, 3])]), fr = Core.freeRegions(bad);
  assert.equal(fr.length, 1); near(Math.abs(fr[0].area), 20, 1e-6); assert.ok(Core.errReport(bad, { name: 'X' }).includes('自由閉合區面積 = 20.00 ㎡'));
}
// ── 界址串檢查與編修（v0.11.0）：地中地被寫進外圈界址串（跳線）、拆出地中地、重繪界址串、D12 輸出 ──
{
  const Y = 2700000, X = 200000, P = [[1, 0, 0], [2, 0, 100], [3, 100, 100], [4, 100, 0], [5, 40, 40], [6, 40, 50], [7, 50, 50], [8, 50, 40]];
  const d14 = Core.parseDbf(makeDbf(F_D14, P.map(([n, y, x]) => pt(n, Y + y, X + x))));
  const mk = (rows, d12rows) => { const bnd = Core.parseDbf(makeDbf(F_D13, rows)), d12 = d12rows ? Core.parseDbf(makeDbf(F_D12, d12rows)) : null; return { ds: Core.datasetFromD({ pts: d14, bnd, d12 }), bnd, d12 }; };
  const inner = ring(1, 2, 0, [5, 6, 7, 8]), rel = { O_SECTION: 1, O_PARCEL: 1, O_PARCEL_E: 0, I_SECTION: 1, I_PARCEL: 2, I_PARCEL_E: 0 };
  // (a) 同向內圈接在外圈後面（兩列 D13）＋ D12 也設了地中地 → 面積被加回又扣掉
  const A = mk([ring(1, 1, 0, [1, 2, 3, 4]), ring(1, 1, 0, [5, 6, 7, 8]), inner], [rel]);
  const ia = Core.ringIssues(A.ds).filter(o => o.kind === 'embedded'); assert.equal(ia.length, 1);
  assert.ok(ia[0].sameDir && ia[0].d12 && ia[0].inside); near(ia[0].areaFixed, 9900, 1e-6); assert.deepEqual(ia[0].jumps, [[4, 5], [8, 1]]);
  const a0 = A.ds.parcels[0].area; assert.ok(Math.abs(a0 - 9900) > 1, '拆出前面積不對');
  assert.ok(Core.errReport(A.ds, { name: 'X' }).includes('的界址串內含'));
  const sa = Core.splitHole(A.ds, 0, 1); assert.equal(sa.linked, false); assert.deepEqual(A.ds.parcels[0].ids, [1, 2, 3, 4]); near(A.ds.parcels[0].area, 9900, 1e-6);
  assert.equal(Core.ringIssues(A.ds).length, 0, '拆出後沒有問題');
  Core.applyDelta(A.ds, sa.delta, 'undo'); near(A.ds.parcels[0].area, a0, 1e-9); Core.applyDelta(A.ds, sa.delta, 'redo'); near(A.ds.parcels[0].area, 9900, 1e-6);
  const o13 = Core.exportD13(A.bnd, A.ds), re = Core.datasetFromD({ pts: d14, bnd: Core.parseDbf(o13.bytes), d12: A.d12 }); near(re.parcels[0].area, 9900, 1e-6, '重讀 D13');
  // (b) 反向內圈、D12 沒有關係 → 拆出後補上地中地，輸出 D12 附加一筆；復原／還原全部要拿掉關係
  const B = mk([ring(1, 1, 0, [1, 2, 3, 4]), ring(1, 1, 0, [8, 7, 6, 5]), inner], []);
  const ib = Core.ringIssues(B.ds).find(o => o.kind === 'embedded'); assert.ok(!ib.sameDir && !ib.d12); near(ib.areaFixed, 9900, 1e-6);
  const sb = Core.splitHole(B.ds, 0, 1); assert.equal(sb.linked, true); near(B.ds.parcels[0].area, 9900, 1e-6); assert.deepEqual(B.ds.parcels[0].holes, [1]); assert.equal(Core.structSummary(B.ds).holes, 1);
  const o12 = Core.exportD12(B.d12, B.ds), r12 = Core.parseDbf(o12.bytes); assert.equal(o12.added, 1); assert.deepEqual([r12.rows[0].O_PARCEL, r12.rows[0].I_PARCEL, r12.rows[0].I_SECTION], [1, 2, 1]);
  const reB = Core.datasetFromD({ pts: d14, bnd: Core.parseDbf(Core.exportD13(B.bnd, B.ds).bytes), d12: r12 }); near(reB.parcels[0].area, 9900, 1e-6, '重讀 D13＋D12');
  Core.applyDelta(B.ds, sb.delta, 'undo'); assert.deepEqual(B.ds.parcels[0].holes, []); Core.applyDelta(B.ds, sb.delta, 'redo'); Core.resetAll(B.ds); assert.deepEqual(B.ds.parcels[0].holes, []); assert.equal(B.ds.parcels[0].ids.length, 8);
  const o12b = Core.exportD12(Core.parseDbf(o12.bytes), B.ds); assert.equal(o12b.cleared, 1, '解除的關係清成 0');
  // (c) 一點進出的細縫（…4, 5,6,7,8,5, 4…）
  const C = mk([ring(1, 1, 0, [1, 2, 3, 4, 5, 8, 7, 6]), ring(1, 1, 0, [5, 4]), inner], []);
  assert.ok(Core.ringIssues(C.ds).some(o => o.kind === 'embedded')); Core.splitHole(C.ds, 0, 1); assert.deepEqual(C.ds.parcels[0].ids, [1, 2, 3, 4]); near(C.ds.parcels[0].area, 9900, 1e-6);
  // (d) 內圈在環內但沒有任何關係 → 疑似未設定地中地；splitHole 只補關係
  const D = mk([ring(1, 1, 0, [1, 2, 3, 4]), inner], []), id = Core.ringIssues(D.ds); assert.deepEqual(id.map(o => o.kind), ['missinghole']);
  Core.splitHole(D.ds, 0, 1); near(D.ds.parcels[0].area, 9900, 1e-6); assert.equal(Core.ringIssues(D.ds).length, 0);
  assert.throws(() => Core.splitHole(D.ds, 0, 1), /已是/);
  // (e) 重繪界址串
  const E = mk([ring(1, 1, 0, [1, 2, 3, 4]), inner], []), se = Core.setRing(E.ds, 0, [1, 2, 3]); near(E.ds.parcels[0].area, 5000, 1e-6);
  Core.applyDelta(E.ds, se.delta, 'undo'); near(E.ds.parcels[0].area, 10000, 1e-6);
  assert.throws(() => Core.setRing(E.ds, 0, [1, 2, 3, 2]), /重複/); assert.throws(() => Core.setRing(E.ds, 0, [1, 2]), /3 點/);
  // (f) 自我交錯（8 字形）
  const F = mk([ring(1, 1, 0, [1, 2, 4, 3])], []); assert.ok(Core.ringIssues(F.ds).some(o => o.kind === 'selfcross'));
  // (g) 通道端點（KC0336 的 1092-2：跳線接回外圈的 6159 只屬於本宗、離內圈 0.24 m）→ 一併移除，外圈直接接回真正的界址點
  const Pg = [...P, [11, 51, 0], [12, 49, 0], [13, 40.1, 39.8]], d14g = Core.parseDbf(makeDbf(F_D14, Pg.map(([n, y, x]) => pt(n, Y + y, X + x))));
  const G = Core.datasetFromD({ pts: d14g, bnd: Core.parseDbf(makeDbf(F_D13, [ring(1, 1, 0, [1, 2, 3, 4, 11, 8, 7, 6]), ring(1, 1, 0, [5, 13, 12]), inner])), d12: Core.parseDbf(makeDbf(F_D12, [])) });
  const ig = Core.ringIssues(G).find(o => o.kind === 'embedded'); assert.deepEqual(ig.trimmed, [13]); near(ig.areaFixed, 9900, 1e-6);
  const sg = Core.splitHole(G, 0, 1); assert.deepEqual(G.parcels[0].ids, [1, 2, 3, 4, 11, 12]); assert.ok(!G.points.has(13)); near(G.parcels[0].area, 9900, 1e-6);
  Core.applyDelta(G, sg.delta, 'undo'); assert.ok(G.points.has(13)); assert.equal(G.parcels[0].ids.length, 11);
  // (h) 段界上的凹口：鄰宗整圈貼著外圈（跳線只屬於本宗、鄰宗未走過的邊只屬於鄰宗）也不是地中地
  const Ph = [[1, 0, 0], [2, 0, 100], [3, 100, 100], [4, 100, 0], [5, 60, 0], [6, 60, 10], [7, 40, 10], [8, 40, 0]], d14h = Core.parseDbf(makeDbf(F_D14, Ph.map(([n, y, x]) => pt(n, Y + y, X + x))));
  const H = Core.datasetFromD({ pts: d14h, bnd: Core.parseDbf(makeDbf(F_D13, [ring(1, 1, 0, [1, 2, 3, 4, 5, 6, 7, 8]), ring(1, 2, 0, [8, 7, 6, 5])])) });
  assert.equal(Core.ringIssues(H).length, 0, '凹口不報'); assert.throws(() => Core.splitHole(H, 0, 1), /已是|凹口|不在/);
  // (i) 內部的凹口：鄰宗整圈貼著外圈、跳線與別宗共用 → 不報（KC0336 有 24 處）
  const Pi = [...Ph, [9, 0, -50], [10, 100, -50]], d14i = Core.parseDbf(makeDbf(F_D14, Pi.map(([n, y, x]) => pt(n, Y + y, X + x))));
  const I = Core.datasetFromD({ pts: d14i, bnd: Core.parseDbf(makeDbf(F_D13, [ring(1, 1, 0, [1, 2, 3, 4, 5, 6, 7, 8]), ring(1, 2, 0, [8, 7, 6, 5]), ring(1, 3, 0, [9, 1, 8, 5, 4, 10])])) });
  assert.equal(Core.ringIssues(I).length, 0, '內部凹口不報');
}
console.log('SYNTHETIC OK');
