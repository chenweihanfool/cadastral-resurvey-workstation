/* app.js — 介面與互動。UI 與 AI/外部橋接共用同一組操作函式（見檔尾 CadastralAPI）。 */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const cv = $('cv'); let ctx = cv.getContext('2d');
const NL = String.fromCharCode(10);
const APP_VERSION = CHANGELOG[0].version;
const REPO = 'chenweihanfool/cadastral-resurvey-workstation';

const S = {
  ds: null, ref: null, dbf: { pts: null, bnd: null }, names: {},
  img: [], imgActive: -1,                  // 疊合影像 [{name,w,h,bmp,wf,wf0,visible,opacity,located}]
  nb: [], seam: null, seamStale: false,      // 鄰段 [{name,ds,color,visible,mode（numeric 數值區／graphic 圖解區／none 只比對）,seg}]；接合檢查報告
  survey: Core.newSurvey(),                // 現況點與手動參考線
  controls: new Map(),                     // 已知點庫：控制點(CTL/D20)、補點(CT2)…  name → {name,y,x,src}
  view: { cx: 0, cy: 0, s: 1 },           // cx=東, cy=北, s=像素/公尺
  sel: { pt: new Set(), edge: new Set(), par: new Set() },
  filter: { pt: true, edge: true, par: true },
  tool: 'select', hover: null, undo: [], redo: [], drag: null, box: null, space: false,
  pivot: null,                             // 自訂旋轉樞紐 {y,x}；null=選取範圍/全圖中心
  align: null,                             // 兩點對位狀態 {step, pts:[]}
  draft: null,                             // 正在連的參考線 {names:[]}
  cursor: null,                            // 滑鼠世界座標（橡皮筋線用）
  basemap: { provider: 'none', opacity: 0.9, cm: 121 },   // 底圖（需 TWD97）
  printing: false,
  style: null,                             // 圖層與樣式（見 STYLE_DEF）
  clean: null,                             // 清理預覽（圖上標示將被刪的點）
  owner: null,                             // 所有權人（EXAM.MDB）：{name, ot（Core.ownerTables）, res（分析結果）}
  bl: { sets: [], res: null, focus: null }, // 接圖前比對：參考圖資各組 [{name, ds:[資料集]}]、比對結果、目前聚焦的項目
};

// ── 座標轉換 ───────────────────────────────────────────────────────────────
let W = 0, H = 0, DPR = 1;
const toSx = x => (x - S.view.cx) * S.view.s + W / 2;
const toSy = y => H / 2 - (y - S.view.cy) * S.view.s;
const toWx = sx => (sx - W / 2) / S.view.s + S.view.cx;
const toWy = sy => (H / 2 - sy) / S.view.s + S.view.cy;
function resize() {
  DPR = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect(); W = r.width; H = r.height;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); draw();
}
new ResizeObserver(resize).observe(cv);

// ── 選取 ───────────────────────────────────────────────────────────────────
const selCount = () => S.sel.pt.size + S.sel.edge.size + S.sel.par.size;
function clearSel() { S.sel.pt.clear(); S.sel.edge.clear(); S.sel.par.clear(); }
function effectiveIds() {
  const ids = new Set(S.sel.pt);
  if (!S.ds) return ids;
  for (const k of S.sel.edge) { const e = S.ds.edges.get(k); if (e) { ids.add(e.a); ids.add(e.b); } }
  for (const i of S.sel.par) for (const id of S.ds.parcels[i].ids) ids.add(id);
  return ids;
}
const isSel = h => h && S.sel[h.t].has(h.k);
function addSel(h) { S.sel[h.t].add(h.k); }
function toggleSel(h) { const s = S.sel[h.t]; s.has(h.k) ? s.delete(h.k) : s.add(h.k); }

// ── 命中測試 ───────────────────────────────────────────────────────────────
function nearestPoint(map, wx, wy, r) {
  let best = null, bd = r;
  for (const p of map.values()) { const d = Math.hypot(p.x - wx, p.y - wy); if (d < bd) { bd = d; best = p; } }
  return best;
}
function hitTest(mx, my) {
  const ds = S.ds; if (!ds) return null;
  const wx = toWx(mx), wy = toWy(my), px = 1 / S.view.s;
  if (S.filter.pt) { const b = nearestPoint(ds.points, wx, wy, 9 * px); if (b) return { t: 'pt', k: b.id }; }
  if (S.filter.edge) { const best = hitEdgeAt(wx, wy, 6 * px); if (best) return { t: 'edge', k: best.key }; }
  if (S.filter.par) {
    let best = null, ba = Infinity;
    for (const p of ds.parcels) if (p.area < ba && Core.pointInRing(p.ids, ds.points, wy, wx)) { ba = p.area; best = p; }
    if (best) return { t: 'par', k: best.idx };
  }
  return null;
}
const hitSurvey = (mx, my) => { const b = nearestPoint(S.survey.points, toWx(mx), toWy(my), 10 / S.view.s); return b ? { t: 'sp', k: b.name } : null; };
function boxSelect(x0, y0, x1, y1, add) {
  const ds = S.ds; if (!ds) return;
  if (!add) clearSel();
  const [ex0, ex1] = [Math.min(toWx(x0), toWx(x1)), Math.max(toWx(x0), toWx(x1))];
  const [ny0, ny1] = [Math.min(toWy(y0), toWy(y1)), Math.max(toWy(y0), toWy(y1))];
  const inside = id => { const p = ds.points.get(id); return p.x >= ex0 && p.x <= ex1 && p.y >= ny0 && p.y <= ny1; };
  if (S.filter.pt) for (const p of ds.points.values()) if (inside(p.id)) S.sel.pt.add(p.id);
  if (S.filter.edge) for (const e of ds.edges.values()) if (inside(e.a) && inside(e.b)) S.sel.edge.add(e.key);
  if (S.filter.par) for (const p of ds.parcels) if (p.ids.every(inside)) S.sel.par.add(p.idx);
}

// ── 編輯（含復原）：undo 項目為 {before,after}（點位）或 {undoFn,redoFn}（其他）────
const snapshot = ids => [...ids].map(id => { const p = S.ds.points.get(id); return [id, p.y, p.x]; });
function pushUndo(e) { S.seamStale = true; S.undo.push(e); if (S.undo.length > 500) S.undo.shift(); S.redo.length = 0; afterEdit('do', e); projDirty(); refresh(); }
function commit(before, after, label) {
  if (before.every((b, i) => b[1] === after[i][1] && b[2] === after[i][2])) return;
  pushUndo({ before, after, label });
}
const layerMode = () => S.tool === 'layer' && !selCount();   // 移圖工具且無選取 → 對象是整個作業圖層
const moveIds = () => (layerMode() ? new Set(S.ds.points.keys()) : effectiveIds());
const pivotOf = ids => S.pivot || Core.centroidOf(S.ds.points, ids);
function transformSelection(T, label) {
  if (!S.ds) return false; const ids = moveIds(); if (!ids.size) return false;
  const before = snapshot(ids); Core.transformPoints(S.ds, ids, T); commit(before, snapshot(ids), label); return true;
}
function moveSelection(dy, dx, label = '移動') {
  if (!S.ds || !(selCount() || layerMode())) return false;
  return transformSelection({ dy, dx, angle: 0 }, layerMode() ? '整圖平移' : label);
}
function rotateSelection(deg) {
  if (!S.ds) return false; const ids = moveIds(); if (!ids.size) return false;
  return transformSelection({ angle: deg * Math.PI / 180, pivot: pivotOf(ids) }, '旋轉');
}
function applyEntries(entries) { if (!S.ds) return; Core.setPoints(S.ds, entries); }
function undo() { S.seamStale = true; const e = S.undo.pop(); if (!e) return; e.undoFn ? e.undoFn() : applyEntries(e.before); S.redo.push(e); afterEdit('undo', e); projDirty(); refresh(); }
function redo() { S.seamStale = true; const e = S.redo.pop(); if (!e) return; e.redoFn ? e.redoFn() : applyEntries(e.after); S.undo.push(e); afterEdit('redo', e); projDirty(); refresh(); }
function resetAll() { if (!S.ds) return; Core.resetAll(S.ds); S.undo.length = 0; S.redo.length = 0; afterEdit('do', { label: '還原全部' }); projDirty(); refresh(); }

// ── 界址點編修（新增／修改／刪除）：核心在 Core.insertPoint／removePoints／cleanupPoints，這裡負責復原、選取與介面 ──
function pruneSel() {
  const ds = S.ds; if (!ds) return;
  for (const id of [...S.sel.pt]) if (!ds.points.has(id)) S.sel.pt.delete(id);
  for (const k of [...S.sel.edge]) if (!ds.edges.has(k)) S.sel.edge.delete(k);
  S.hover = null;
}
function pushStruct(delta, label) {
  pushUndo({ undoFn: () => { Core.applyDelta(S.ds, delta, 'undo'); pruneSel(); }, redoFn: () => { Core.applyDelta(S.ds, delta, 'redo'); pruneSel(); }, label });
}
const parLabels = delta => [...delta.parcels.keys()].map(i => S.ds.parcels[i].label);
function hitEdgeAt(wx, wy, r) {
  let best = null, bd = r;
  for (const e of S.ds.edges.values()) { const a = S.ds.points.get(e.a), b = S.ds.points.get(e.b), d = Core.distToSeg(wx, wy, a.x, a.y, b.x, b.y); if (d < bd) { bd = d; best = e; } }
  return best;
}
function selectOnlyPoint(id) { clearSel(); S.sel.pt.add(id); }
function addPoint({ edge, y, x, project = true }) {   // edge=[a,b]：加在該線（所有以此線為界的宗地）；省略＝孤立點
  const ds = S.ds; if (!ds) throw new Error('尚未載入圖資');
  const r = edge ? Core.insertPoint(ds, edge[0], edge[1], y, x, { project }) : Core.addFreePoint(ds, y, x);
  pushStruct(r.delta, `加點 ${r.id}`); selectOnlyPoint(r.id);
  return { id: r.id, parcels: parLabels(r.delta) };
}
function addPointAt(mx, my, free) {
  const wx = toWx(mx), wy = toWy(my);
  if (nearestPoint(S.ds.points, wx, wy, 9 / S.view.s)) return msg('這裡已有界址點；要在線上加點請點在兩點之間的線上');
  const e = hitEdgeAt(wx, wy, 8 / S.view.s);
  try {
    if (e) { const r = addPoint({ edge: [e.a, e.b], y: wy, x: wx }); msg(`已在 ${e.a}–${e.b} 加入點 ${r.id}，同步插入宗地 ${r.parcels.join('、')}（面積不變）；切到「選取」可拖曳`); }
    else if (free) { const r = addPoint({ y: wy, x: wx }); msg(`已新增孤立點 ${r.id}（不屬於任何宗地）`); }
    else msg('請點在界址線上；Shift＋點空白處＝新增孤立點');
  } catch (err) { msg(String(err.message || err)); }
}
function deletePoints(ids) {
  const ds = S.ds; if (!ds) throw new Error('尚未載入圖資');
  const r = Core.removePoints(ds, ids);
  if (r.done.length) { pushStruct(r.delta, `刪除 ${r.done.length} 點`); pruneSel(); }
  return { deleted: r.done, skipped: r.skipped, parcels: parLabels(r.delta) };
}
function deleteSelectedPoints() {
  if (!S.ds) return msg('請先載入圖資'); if (!S.sel.pt.size) return msg('請先用「選取」工具選取要刪除的界址點（可框選多個）');
  const r = deletePoints([...S.sel.pt]);
  msg((r.deleted.length ? `已刪除 ${r.deleted.length} 個界址點，更新宗地 ${r.parcels.slice(0, 6).join('、')}${r.parcels.length > 6 ? '…' : ''}；可復原` : '沒有刪除任何點') + (r.skipped.length ? `。無法刪除 ${r.skipped.length} 點：` + r.skipped.slice(0, 3).map(q => `${q.id}（${q.reason}）`).join('、') : ''));
}
// 一鍵清理多餘點：預覽＝實際執行後立刻還原，所以數字與實際結果一致
function cleanOpts() {
  const o = { unused: $('clUnused').checked, collinear: $('clCol').checked, ratio: (parseFloat($('clRatio').value) || 0) / 1000, maxAbs: parseFloat($('clCap').value) || 0 };
  if ($('clSeam').checked && S.ds && S.nb.length) { const g = Core.seamGuard(S.ds, nbArgs(), seamOpts()); o.protect = g.protect; o.adds = g.adds; o.tol = g.tol; o.radius = g.radius; }
  return o;
}
let cleanKey = '';
function cleanPreview() {
  const ds = S.ds, box = $('clSum');
  if (!ds) { S.clean = null; box.textContent = '尚未載入圖資'; return; }
  const o = cleanOpts(), hmap = new Map(Core.collinearCandidates(ds, o).map(c => [c.id, c.h])), before = ds.parcels.map(p => p.area), cf0 = Core.ringConflicts(ds), fr0 = Core.freeRegions(ds).length;
  const r = Core.cleanupPoints(ds, o); let n = 0, maxd = 0, tot = 0; const cf1 = Core.ringConflicts(ds), c0 = cf0.cross.length + cf0.overlap.length + fr0, c1 = cf1.cross.length + cf1.overlap.length + Core.freeRegions(ds).length;
  ds.parcels.forEach((p, i) => { const d = p.area - before[i]; if (Math.abs(d) > 1e-6) { n++; tot += d; maxd = Math.max(maxd, Math.abs(d)); } });
  const pts = r.delta.removed.map(p => ({ y: p.y, x: p.x, u: r.unused.includes(p.id) })).concat(r.delta.added.map(p => ({ y: p.y, x: p.x, add: true })));
  Core.applyDelta(ds, r.delta, 'undo');
  const any = r.unused.length || r.collinear.length || r.added.length; S.clean = any && $('clShow').checked ? { pts } : null;
  const hmax = Math.max(0, ...r.collinear.map(id => hmap.get(id) || 0));
  box.innerHTML = `<div>沒有宗地使用的點：<b>${r.unused.length}</b> 個</div><div>直線上的多餘點：<b>${r.collinear.length}</b> 個` + (r.collinear.length ? `（最大偏差 ${(hmax * 100).toFixed(1)} cm）` : '') + '</div>' +
    `<div class="muted">影響 ${n} 宗地面積，合計 ${tot >= 0 ? '+' : ''}${tot.toFixed(3)} m²，單宗最大 ${maxd.toFixed(3)} m²` + (r.skipped.length ? `；${r.skipped.length} 點因圓弧或環點數不足保留` : '') + '</div>' +
    (r.blocked.length ? `<div class="muted">${r.blocked.length} 點因「三角形內有別宗地的界址點」保留（刪了弦會跨過它，造成交錯）</div>` : '') +
    `<div>界址線交錯／重疊／自由閉合區（縫）：清理前 <b>${c0}</b>、清理後 <b class="${c1 > c0 ? 'neg' : ''}">${c1}</b>` + (c1 > c0 ? '　⚠ 清理會讓 NECEXE 報表多出錯誤，建議調小比例' : '') + '</div>' +
    ($('clSeam').checked ? (S.nb.length ? `<div>鄰段接縫：補點 <b>${r.added.length}</b> 個（鄰段有點、測區缺）；保留 <b>${r.kept}</b> 個在直線上、但鄰段有點的點` + (r.skippedAdds.length ? `；${r.skippedAdds.length} 處在圓弧上無法補點` : '') + '</div>' : '<div class="muted">尚未載入鄰段，不做接縫保護</div>') : '<div class="muted">已關閉鄰段接縫保護</div>');
  $('btnClean').disabled = !any; draw();
}
let cleanTimer = null; const cleanSoon = () => { clearTimeout(cleanTimer); cleanTimer = setTimeout(() => { if ($('dlgClean').open) cleanPreview(); }, 120); };
['clUnused', 'clCol', 'clRatio', 'clCap', 'clShow', 'clSeam'].forEach(id => $(id).addEventListener('input', cleanSoon));
$('dlgClean').addEventListener('close', () => { S.clean = null; draw(); });
$('btnClean').onclick = () => {
  if (!S.ds) return; S.clean = null; const r = Core.cleanupPoints(S.ds, cleanOpts());
  if (!r.unused.length && !r.collinear.length && !r.added.length) return msg('沒有可清理的點');
  pushStruct(r.delta, '清理多餘點'); pruneSel();
  msg(`已清理：沒有宗地使用的點 ${r.unused.length} 個、直線上多餘點 ${r.collinear.length} 個` + (r.added.length ? `；鄰段接縫補點 ${r.added.length} 個` : '') + (r.kept ? `；保留 ${r.kept} 個接縫點` : '') + `，更新 ${r.delta.parcels.size} 宗地；可復原。記得輸出 D14 與 D13`); cleanSoon();
};
$('btnPtTool').onclick = () => setTool('addpt'); $('btnPtDel').onclick = deleteSelectedPoints; $('btnOpenClean').onclick = () => openPanel('dlgClean');
$('btnPtSet').onclick = () => {
  if (S.sel.pt.size !== 1) return msg('請先選取一個界址點'); const id = [...S.sel.pt][0], p = S.ds.points.get(id), y = parseFloat($('ptN').value), x = parseFloat($('ptE').value);
  if (!isFinite(y) || !isFinite(x)) return msg('座標格式不正確'); transformSelectionIds(new Set([id]), { dy: y - p.y, dx: x - p.x, angle: 0 }, '座標修改'); refresh();
};
// 點移到線上：把點移到直線 a–b 的垂足（a、b 為任意兩個界址點，不必是界址線）。共用此點的宗地一起變動，可復原
const parseIds = t => String(t).split(/[\s,，、;；]+/).filter(Boolean).map(v => (S.ds.points.has(+v) ? +v : v));
function pointsToLine(ids, a, b) {
  const ds = S.ds; if (!ds) throw new Error('尚未載入圖資');
  const A = ds.points.get(a), B = ds.points.get(b); if (!A || !B) throw new Error(`找不到界址點 ${!A ? a : b}`);
  const r = Core.footsOnLine(ds, ids, a, b); if (!r.entries.length) throw new Error(r.skipped.length ? r.skipped.map(q => `${q.id}（${q.reason}）`).join('、') : '沒有要移動的點');
  const before = snapshot(r.entries.map(e => e[0])); Core.setPoints(ds, r.entries); commit(before, snapshot(r.entries.map(e => e[0])), `點移到線 ${a}–${b}`); refresh();
  return r;
}
$('btnPtLine').onclick = () => {
  if (!S.ds) return msg('請先載入圖資');
  const ids = parseIds($('plIds').value), a = parseIds($('plA').value)[0], b = parseIds($('plB').value)[0];
  if (!ids.length || a == null || b == null) return msg('請輸入要移動的點號與線的兩端點號（或先選取點與一條界址線）');
  try { const r = pointsToLine(ids, a, b); msg(`已把 ${r.moved.map(m => `${m.id}（移 ${m.d.toFixed(3)} m${m.out ? '，垂足在延長線上' : ''}）`).join('、')} 移到 ${a}–${b} 線上` + (r.skipped.length ? `；略過 ${r.skipped.map(q => `${q.id}（${q.reason}）`).join('、')}` : '') + '。可復原'); }
  catch (err) { msg('無法移動：' + err.message); }
};
$('btnPtAdd').onclick = () => {
  if (!S.ds) return msg('請先載入圖資'); const y = parseFloat($('addN').value), x = parseFloat($('addE').value); if (!isFinite(y) || !isFinite(x)) return msg('請輸入 N、E 座標');
  try {
    const only = S.sel.edge.size === 1 && !S.sel.pt.size ? S.ds.edges.get([...S.sel.edge][0]) : null;
    const r = addPoint({ edge: only ? [only.a, only.b] : null, y, x, project: false }); msg(`已新增點 ${r.id}` + (only ? `，插入 ${only.a}–${only.b}（宗地 ${r.parcels.join('、')}）` : '（孤立點）'));
  } catch (err) { msg(String(err.message || err)); }
};
function ptPanel() {
  const ds = S.ds, st = S.st || { added: 0, removed: 0, rings: 0 };
  if (ds) {   // 「點移到線上」：選了點與一條界址線時自動帶入
    const key = [...S.sel.pt].join(',') + '|' + [...S.sel.edge].join(',');
    if (key !== ptPanel.k) { ptPanel.k = key; if (S.sel.pt.size) $('plIds').value = [...S.sel.pt].join(', ');
      if (S.sel.edge.size === 1) { const e = ds.edges.get([...S.sel.edge][0]); if (e) { $('plA').value = e.a; $('plB').value = e.b; } } }
  }
  $('ptEditInfo').innerHTML = ds ? `結構異動：新增 <b>${st.added}</b> 點、刪除 <b>${st.removed}</b> 點、<b>${st.rings}</b> 宗地的界址串改變` + (st.added || st.removed || st.rings ? '<div class="muted">輸出時需同時輸出 D14 與 D13。</div>' : '') : '';
  if (S.sel.pt.size === 1 && ds) {
    const p = ds.points.get([...S.sel.pt][0]); if (!p) return;
    const used = (ds.pointParcels.get(p.id) || []).map(i => ds.parcels[i].label);
    $('ptInfo').innerHTML = `點 <b>${p.id}</b>${p.added ? '（新增）' : ''}　${used.length ? '屬於宗地 ' + used.slice(0, 6).join('、') + (used.length > 6 ? '…' : '') : '<span class="neg">沒有宗地使用</span>'}`;
    for (const [id, v] of [['ptN', p.y], ['ptE', p.x]]) if (document.activeElement !== $(id)) $(id).value = v.toFixed(3);
  } else $('ptInfo').textContent = S.sel.pt.size > 1 ? `已選 ${S.sel.pt.size} 個點（座標修改一次只能一個；可按「刪除」）` : '尚未選取界址點（用「選取」工具點一個點）';
}

// ── 現況點與參考線 ─────────────────────────────────────────────────────────
function addSurveyPoints(pts) {
  const names = Core.addSurveyPoints(S.survey, pts);
  pushUndo({ undoFn: () => names.forEach(n => S.survey.points.delete(n)), redoFn: () => pts.forEach((p, i) => S.survey.points.set(names[i], { name: names[i], y: p.y, x: p.x, h: p.h, code: p.code })) });
  return names;
}
function addLine(names, opt) {
  const ln = Core.addLine(S.survey, names, opt); if (!ln) return null;
  pushUndo({ undoFn: () => { S.survey.lines = S.survey.lines.filter(l => l !== ln); }, redoFn: () => S.survey.lines.push(ln) });
  return ln;
}
function deleteLine(id) {
  const i = S.survey.lines.findIndex(l => l.id === id); if (i < 0) return false; const [ln] = S.survey.lines.splice(i, 1);
  pushUndo({ undoFn: () => S.survey.lines.splice(i, 0, ln), redoFn: () => { S.survey.lines = S.survey.lines.filter(l => l !== ln); } }); return true;
}
function clearSurvey() {
  const pts = [...S.survey.points.entries()], lines = [...S.survey.lines];
  S.survey.points.clear(); S.survey.lines = []; S.draft = null;
  pushUndo({ undoFn: () => { pts.forEach(([k, v]) => S.survey.points.set(k, v)); S.survey.lines = lines; }, redoFn: () => { S.survey.points.clear(); S.survey.lines = []; } });
}
function finishDraft(closed) {
  const d = S.draft; S.draft = null;
  if (d && d.names.length >= 2) { const ln = addLine(d.names, { closed }); if (ln) msg(`已建立 ${ln.name}（${ln.points.length} 點${closed ? '，閉合' : ''}）`); }
  refresh();
}
// 匯入：kind='xy'（點號,N,E）或 'polar'（測站觀測）。回傳 {added, skipped, ...}
function importSurvey(kind, text, o = {}) {
  let pts, skipped;
  if (kind === 'polar') {
    const { obs, skipped: sk } = Core.parseObservations(text, { angleFmt: o.angleFmt || 'auto' }); skipped = sk;
    const station = { y: Number(o.station.y), x: Number(o.station.x) };
    let backAz = o.backAz != null && o.backAz !== '' ? (typeof o.backAz === 'number' ? o.backAz : Core.parseAngle(o.backAz, 'auto')) : NaN;
    if (Number.isNaN(backAz) && o.backPoint) backAz = Core.azimuth(station, { y: Number(o.backPoint.y), x: Number(o.backPoint.x) });
    if ([station.y, station.x, backAz].some(Number.isNaN)) throw new Error('極座標需要測站坐標與後視方位角（或後視點坐標）');
    pts = Core.polarReduce({ station, backAz, obs, slope: o.slope !== false });
  } else { const r = Core.parsePoints(text, { order: o.order || 'auto' }); pts = r.points; skipped = r.skipped; }
  if (!pts.length) throw new Error('沒有可匯入的點');
  const names = addSurveyPoints(pts);
  if (o.fit !== false) fit(surveyBounds());
  return { added: names.length, names, skipped };
}
// 已知點庫（MAC 化算的起算依據）。同名點以後匯入者覆蓋並提示。
function addControls(points, src) {
  const prev = new Map(), added = []; let replaced = 0, conflicts = 0;
  for (const p of points) {
    if (S.controls.has(p.name)) { const o = S.controls.get(p.name); prev.set(p.name, o); replaced++; if (Math.hypot(o.y - p.y, o.x - p.x) > 0.001) conflicts++; }
    S.controls.set(p.name, { name: p.name, y: p.y, x: p.x, src }); added.push(p.name);
  }
  pushUndo({ undoFn: () => added.forEach(n => (prev.has(n) ? S.controls.set(n, prev.get(n)) : S.controls.delete(n))), redoFn: () => points.forEach(p => S.controls.set(p.name, { name: p.name, y: p.y, x: p.x, src })) });
  return { added: added.length, replaced, conflicts };
}
function clearControls() {
  const snap = new Map(S.controls); S.controls.clear();
  pushUndo({ undoFn: () => snap.forEach((v, k) => S.controls.set(k, v)), redoFn: () => S.controls.clear() });
}
const knownPoints = () => { const m = new Map(); for (const p of S.controls.values()) m.set(p.name, p); for (const p of S.survey.points.values()) if (!m.has(p.name)) m.set(p.name, p); return m; };
function macPlan(text) {
  const { blocks, skipped } = Core.parseMac(text), res = Core.reduceMac(blocks, knownPoints());
  return { blocks, skipped, ...res, maxCheck: res.checks.reduce((a, c) => Math.max(a, Math.abs(c.diff)), 0) };
}
// MAC 匯入：必須先有已知點（CTL 控制點／CT2 補點／D20…）。測站或後視無坐標的段落不化算，並回報缺哪些點。
function importMac(text, o = {}) {
  if (!S.controls.size && !S.survey.points.size) throw new Error('MAC 是相對觀測，請先匯入控制點（CTL）與補點（CT2）或 D20 控制點檔');
  const plan = macPlan(text);
  if (!plan.blocks.length) throw new Error('找不到測站段落（格式：「測站 後視」一行，接「點號 水平角 距離」）');
  if (!plan.points.length) throw new Error('沒有可化算的點：' + plan.unresolved.map(u => `測站 ${u.station} 缺 ${u.missing.join('、')}`).join('；'));
  const names = addSurveyPoints(plan.points);
  if (o.fit !== false && S.survey.points.size) fit(surveyBounds());
  return { added: names.length, names, unresolved: plan.unresolved, checks: plan.checks, max_check_diff: plan.maxCheck, stations: plan.stations };
}
function controlsBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of S.controls.values()) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  return { x0: x0 - 5, x1: x1 + 5, y0: y0 - 5, y1: y1 + 5 };
}
function surveyBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of S.survey.points.values()) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  return { x0: x0 - 2, x1: x1 + 2, y0: y0 - 2, y1: y1 + 2 };
}

// ── 兩點對位 ───────────────────────────────────────────────────────────────
const ALIGN_HINT = [
  '對位 1/4：點選【新圖】上要移動的第一點 A', '對位 2/4：點選目標位置 A′（舊圖點、現況點，或圖上任一處）',
  '對位 3/4：點選【新圖】第二點 B（或按 Enter 只做平移）', '對位 4/4：點選目標位置 B′',
];
function startAlign() { if (!S.ds) return msg('請先載入圖資'); S.align = { step: 0, pts: [] }; setHint(ALIGN_HINT[0] + '　(Esc 取消)'); draw(); }
function cancelAlign() { S.align = null; setHint(''); draw(); }
function alignPick(mx, my) {
  const a = S.align, wx = toWx(mx), wy = toWy(my), r = 10 / S.view.s; let pt = null;
  if (a.step % 2 === 0) { const b = nearestPoint(S.ds.points, wx, wy, r); if (!b) return msg('請點選新圖的界址點'); pt = { y: b.y, x: b.x }; }
  else {
    const cands = [S.survey.points, S.ref && S.ref.points].filter(Boolean); let b = null;
    for (const m of cands) { b = b || nearestPoint(m, wx, wy, r); }
    pt = b ? { y: b.y, x: b.x } : { y: wy, x: wx };
  }
  a.pts.push(pt); a.step++;
  if (a.step === 4) return finishAlign();
  setHint(ALIGN_HINT[a.step] + '　(Esc 取消)'); draw();
}
function finishAlign() {
  const a = S.align; if (!a) return;
  const [A, A2, B, B2] = a.pts; S.align = null; setHint('');
  const ids = selCount() ? effectiveIds() : new Set(S.ds.points.keys());
  if (a.pts.length >= 4) {
    const f = Core.twoPointFit(A, B, A2, B2), deg = f.angle * 180 / Math.PI;
    transformSelectionIds(ids, f.T, '兩點對位');
    msg(`對位完成：旋轉 ${deg.toFixed(4)}°（逆時針為正），平移 ${Math.hypot(f.T.dy, f.T.dx).toFixed(3)} m，兩對點距離比 ${f.scale.toFixed(6)}` + (Math.abs(f.scale - 1) > 2e-4 ? '（≠1：兩對點距離不一致，B 點會有殘差）' : ''));
  } else { transformSelectionIds(ids, { dy: A2.y - A.y, dx: A2.x - A.x, angle: 0 }, '單點對位'); msg('已依第一對點平移'); }
  refresh();
}
function transformSelectionIds(ids, T, label) {
  const before = snapshot(ids); Core.transformPoints(S.ds, ids, T); commit(before, snapshot(ids), label);
}

// ── 繪圖 ───────────────────────────────────────────────────────────────────
// ── 圖層與樣式：開關、顏色、大小。顏色 null＝依深淺色主題的預設；設定記在瀏覽器（列印同樣套用）──
const STYLE_DEF = {
  edge: { show: true, color: null, width: 1 },
  pt: { show: true, color: null, movedColor: null, size: 0 },
  label: { show: true, color: null, size: 0 },
  ptid: { show: true, color: null, size: 10 },
  delta: { show: true, okColor: null, badColor: null, size: 0, all: false },
  dfill: { show: true, posColor: '#1c7ed6', negColor: '#e8590c', alpha: 0.35, minAbs: 0.005, overTol: false },
  fill: { show: true, color: null },
  ref: { show: true, color: null, width: 1 },
  survey: { show: true, color: null, size: 5, width: 2, names: true },
  ctl: { show: true, color: null, size: 6, names: true },
  sel: { color: null },
};
// [鍵, 名稱, 有開關, 欄位…]：['color', 屬性, 標籤, 預設色變數]｜['num', 屬性, 標籤, min, max, step]｜['chk', 屬性, 標籤]｜['sel', 屬性, 標籤, [[值, 文字]…]]
const STYLE_UI = [
  ['edge', '界址線', true, ['color', 'color', '色', '--edge'], ['num', 'width', '線寬', 0.5, 6, 0.5]],
  ['pt', '界址點', true, ['color', 'color', '色', '--edge'], ['color', 'movedColor', '已移動', '--bad'], ['num', 'size', '大小', 0, 12, 0.5, '0＝依縮放自動']],
  ['label', '地號標註', true, ['color', 'color', '色', '--edge'], ['num', 'size', '字級', 0, 30, 1, '0＝自動']],
  ['ptid', '點號標註（放大後）', true, ['color', 'color', '色', '--ref'], ['num', 'size', '字級', 6, 24, 1]],
  ['delta', '面積較差（圖上）', true, ['color', 'okColor', '正常色', '--ok'], ['color', 'badColor', '超限色', '--bad'], ['num', 'size', '字級', 0, 30, 1, '0＝自動'], ['chk', 'all', '全圖（所有宗地都標，不只有變動／已選取）']],
  ['dfill', '較差塗色（正／負）', true, ['color', 'posColor', '面積增加(＋)', '--accent'], ['color', 'negColor', '面積減少(−)', '--bad'], ['num', 'alpha', '不透明度', 0.05, 0.9, 0.05], ['num', 'minAbs', '忽略 |Δ| ≤', 0, 5, 0.005, 'm²'], ['chk', 'overTol', '僅超過警示值']],
  ['fill', '變動宗地底色', true, ['color', 'color', '色', '--changed']],
  ['ref', '舊圖線', true, ['color', 'color', '色', '--ref'], ['num', 'width', '線寬', 0.5, 6, 0.5]],
  ['survey', '現況點／參考線', true, ['color', 'color', '色', '--survey'], ['num', 'size', '點大小', 2, 14, 1], ['num', 'width', '線寬', 1, 8, 0.5], ['chk', 'names', '點名']],
  ['ctl', '控制點／補點', true, ['color', 'color', '色', '--ok'], ['num', 'size', '大小', 3, 14, 1], ['chk', 'names', '點名']],
  ['sel', '選取色', false, ['color', 'color', '色', '--sel']],
];
const cloneStyle = o => JSON.parse(JSON.stringify(o));
S.style = cloneStyle(STYLE_DEF);
try { const j = JSON.parse(localStorage.getItem('cw.style') || 'null'); if (j) { for (const k of Object.keys(STYLE_DEF)) if (j[k]) Object.assign(S.style[k], j[k]); if (S.style.delta.scope === 'all') S.style.delta.all = true; delete S.style.delta.scope; } } catch (e) { /* 無儲存或被封鎖時用預設 */ }
const saveStyle = () => { try { localStorage.setItem('cw.style', JSON.stringify(S.style)); } catch (e) { /* ignore */ } };
const sc_ = (k, p, v) => S.style[k][p] || css(v);   // 使用者色，否則主題預設
const cssHex = v => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = '#000'; c.fillStyle = v; let m = /^#([0-9a-f]{6})/i.exec(c.fillStyle); if (m) return '#' + m[1]; m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c.fillStyle); return m ? '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('') : '#000000'; };
function renderStyleRows() {
  const g = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  $('styleRows').innerHTML = STYLE_UI.map(([k, name, hasShow, ...fs]) => {
    const st = S.style[k], ctl = fs.map(f => {
      const id = `data-s="${k}.${f[1]}"`;
      if (f[0] === 'color') return `<label>${f[2]} <input type="color" ${id} value="${st[f[1]] || cssHex(g(f[3]))}"><button class="sx" data-reset="${k}.${f[1]}" title="還原預設色">↺</button></label>`;
      if (f[0] === 'num') return `<label title="${f[6] || ''}">${f[2]} <input type="number" ${id} min="${f[3]}" max="${f[4]}" step="${f[5]}" value="${st[f[1]]}"></label>`;
      if (f[0] === 'chk') return `<label class="chk"><input type="checkbox" ${id}${st[f[1]] ? ' checked' : ''}>${f[2]}</label>`;
      return `<label>${f[2]} <select ${id}>${f[3].map(([v, t]) => `<option value="${v}"${st[f[1]] === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
    }).join('');
    return `<div class="srow"><span>${hasShow ? `<input type="checkbox" data-s="${k}.show"${st.show ? ' checked' : ''} title="顯示／隱藏">` : ''}</span><b>${name}</b><div class="sctl">${ctl}</div></div>`;
  }).join('');
}
$('styleRows').addEventListener('input', e => {
  const t = e.target, key = t.dataset.s; if (!key) return; const [k, p] = key.split('.');
  S.style[k][p] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (parseFloat(t.value) || 0) : t.value; saveStyle(); refresh();
});
$('styleRows').addEventListener('click', e => { const r = e.target.dataset.reset; if (!r) return; const [k, p] = r.split('.'); S.style[k][p] = STYLE_DEF[k][p]; saveStyle(); renderStyleRows(); draw(); });
$('btnStyleReset').onclick = () => { S.style = cloneStyle(STYLE_DEF); saveStyle(); renderStyleRows(); draw(); };

const PRINT_PALETTE = { '--edge': '#1d2330', '--ref': '#8a93a6', '--sel': '#1f6feb', '--hover': '#00a3a3', '--changed': 'rgba(255,160,0,.28)', '--bad': '#d1242f', '--survey': '#c2188e', '--ok': '#1a7f37', '--canvas': '#ffffff' };
const css = n => (S.printing ? PRINT_PALETTE[n] : getComputedStyle(document.documentElement).getPropertyValue(n).trim());

// ── 底圖：OSM／國土測繪中心(NLSC) 電子地圖、正射影像（XYZ 圖磚，以仿射近似貼到 TM2 方格上）────
const PROVIDERS = {
  osm: { name: 'OpenStreetMap', max: 19, attr: '© OpenStreetMap contributors', url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png` },
  emap: { name: 'NLSC 通用版電子地圖', max: 19, attr: '底圖：內政部國土測繪中心 通用版電子地圖', url: (z, x, y) => `https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/${z}/${y}/${x}` },
  photo: { name: 'NLSC 正射影像', max: 19, attr: '底圖：內政部國土測繪中心 正射影像', url: (z, x, y) => `https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/${z}/${y}/${x}` },
};
const tileCache = new Map();
function getTile(url) {
  let t = tileCache.get(url);
  if (!t) {
    const img = new Image(); t = { img, state: 'loading' }; img.crossOrigin = 'anonymous';
    img.onload = () => { t.state = 'ok'; draw(); };
    img.onerror = () => {   // 伺服器未開 CORS 時改以一般方式載入（可顯示、可列印；僅無法輸出 PNG）
      if (t.retried) { t.state = 'err'; return; } t.retried = true; const i2 = new Image(); t.img = i2;
      i2.onload = () => { t.state = 'ok'; draw(); }; i2.onerror = () => { t.state = 'err'; }; i2.src = url;
    };
    img.src = url; tileCache.set(url, t);
    if (tileCache.size > 700) tileCache.delete(tileCache.keys().next().value);
  }
  return t;
}
function tileList(view, w, h) {
  const pv = PROVIDERS[S.basemap.provider]; if (!pv) return null; const cm = S.basemap.cm;
  const c = Core.tm2ToLatLon(view.cy, view.cx, cm);
  let z = Math.round(Math.log2(156543.034 * Math.cos(c.lat * Math.PI / 180) * view.s)); z = Math.max(3, Math.min(pv.max, z));
  const n = 2 ** z, tx = lon => (lon + 180) / 360 * n, ty = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n; };
  const cs = [[0, 0], [w, 0], [0, h], [w, h]].map(([sx, sy]) => Core.tm2ToLatLon((h / 2 - sy) / view.s + view.cy, (sx - w / 2) / view.s + view.cx, cm));
  const xs = cs.map(q => tx(q.lon)), ys = cs.map(q => ty(q.lat));
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.floor(Math.max(...xs)), y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(n - 1, Math.floor(Math.max(...ys)));
  const tiles = []; if ((x1 - x0 + 1) * (y1 - y0 + 1) > 160) return { z, pv, tiles, cm };
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ x, y, url: pv.url(z, ((x % n) + n) % n, y) });
  return { z, pv, tiles, cm };
}
const tileCorner = (z, x, y, cm) => { const n = 2 ** z; return Core.latLonToTm2(Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI, x / n * 360 - 180, cm); };
function drawBasemap() {
  const tl = tileList(S.view, W, H); if (!tl) return;
  ctx.save(); ctx.globalAlpha = S.basemap.opacity;
  for (const t of tl.tiles) {
    const tile = getTile(t.url); if (tile.state !== 'ok') continue;
    const nw = tileCorner(tl.z, t.x, t.y, tl.cm), ne = tileCorner(tl.z, t.x + 1, t.y, tl.cm), sw = tileCorner(tl.z, t.x, t.y + 1, tl.cm);
    const ax = toSx(nw.x), ay = toSy(nw.y);
    ctx.setTransform(DPR * (toSx(ne.x) - ax) / 256, DPR * (toSy(ne.y) - ay) / 256, DPR * (toSx(sw.x) - ax) / 256, DPR * (toSy(sw.y) - ay) / 256, DPR * ax, DPR * ay);
    ctx.drawImage(tile.img, 0, 0, 256.7, 256.7);
  }
  ctx.restore();
}
const waitTiles = async (tl, ms = 9000) => { const t0 = Date.now(); const list = tl ? tl.tiles.map(t => getTile(t.url)) : []; while (list.some(t => t.state === 'loading') && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 120)); return list.filter(t => t.state === 'ok').length + '/' + list.length; };
let drawQueued = false;
function draw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; render(); }); }
function arcsOf(d) { return d.arcs ? [...d.arcs.values()] : []; }
function strokeArcs(d, color, w, dash) {
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.beginPath();
  for (const ar of arcsOf(d)) {
    const pts = Core.arcPolyline(d.points.get(ar.a), d.points.get(ar.b), d.points.get(ar.c), 24);
    pts.forEach((p, i) => i ? ctx.lineTo(toSx(p.x), toSy(p.y)) : ctx.moveTo(toSx(p.x), toSy(p.y)));
  }
  ctx.stroke(); ctx.setLineDash([]);
}
// 法定公差（v0.29.0）：地籍測量實施規則第 243 條 (a＋b·⁴√F)·√F，F＝登記面積；係數同「接圖前比對」面板。沒有登記面積的（未登記地）用手動警示值
const legalOn = () => $('tolLegal').checked, manualTol = () => parseFloat($('tol').value) || 0;
function regTol(p) { if (!legalOn() || !(p.areaReg > 0)) return manualTol(); const o = blOpts(); return Core.areaTol(p.areaReg, o.a, o.b); }
const overLegal = p => legalOn() && !p.deleted && p.areaReg > 0 && Math.abs(p.area - p.areaReg) > regTol(p);
function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.clearRect(0, 0, W, H);   // 上一幀若中途出錯沒 restore，透明度不可殘留
  drawBasemap(); ctx.setTransform(DPR, 0, 0, DPR, 0, 0); drawImages(false);
  const ds = S.ds, sc = S.view.s;
  const ST = S.style, cEdge = sc_('edge', 'color', '--edge'), cRef = sc_('ref', 'color', '--ref'), cSel = sc_('sel', 'color', '--sel'), cHov = css('--hover'), cChg = ST.fill.color ? ST.fill.color + '38' : css('--changed'), cBad = css('--bad'), cSv = sc_('survey', 'color', '--survey');
  const tracePoly = (d, ids) => { ctx.beginPath(); ids.forEach((id, i) => { const p = d.points.get(id); i ? ctx.lineTo(toSx(p.x), toSy(p.y)) : ctx.moveTo(toSx(p.x), toSy(p.y)); }); ctx.closePath(); };
  // 舊圖
  if (S.ref && ST.ref.show) {
    ctx.strokeStyle = cRef; ctx.lineWidth = ST.ref.width; ctx.setLineDash([5, 4]); ctx.beginPath();
    for (const e of S.ref.edges.values()) { if (e.arcPart) continue; const a = S.ref.points.get(e.a), b = S.ref.points.get(e.b); ctx.moveTo(toSx(a.x), toSy(a.y)); ctx.lineTo(toSx(b.x), toSy(b.y)); }
    ctx.stroke(); ctx.setLineDash([]); strokeArcs(S.ref, cRef, ST.ref.width, [5, 4]);
  }
  for (const n of S.nb) if (n.visible) drawNeighbor(n);
  if (ds) {
    // 已變動宗地底色
    ctx.fillStyle = cChg;
    if (ST.fill.show) for (const p of ds.parcels) if (Math.abs(p.area - p.areaOrig) > 1e-6) { tracePoly(ds, p.ids); ctx.fill(); }
    if (ST.dfill.show) {   // 較差正／負塗色：面積增加／減少各一色（範圍同面積較差標註）
      const mode = $('deltaMode').value, tol = parseFloat($('tol').value) || 0, aa = Math.round(Math.min(0.9, Math.max(0.05, ST.dfill.alpha)) * 255).toString(16).padStart(2, '0');
      for (const p of ds.parcels) {
        if (!ST.delta.all && Math.abs(p.area - p.areaOrig) <= 1e-6 && !S.sel.par.has(p.idx)) continue;
        const base = mode === 'reg' ? p.areaReg : p.areaOrig; if (base == null) continue;
        const d = p.area - base, over = overLegal(p); if (!over && (Math.abs(d) <= ST.dfill.minAbs || (ST.dfill.overTol && Math.abs(d) <= (mode === 'reg' ? regTol(p) : tol)))) continue;
        ctx.fillStyle = (over ? '#d1242f' : d > 0 ? ST.dfill.posColor : ST.dfill.negColor) + aa;   // 超出法定公差：紅
        ctx.beginPath(); for (const ids of [p.ids, ...(p.holes || []).map(h => ds.parcels[h].ids)]) { ids.forEach((id, i) => { const q = ds.points.get(id); i ? ctx.lineTo(toSx(q.x), toSy(q.y)) : ctx.moveTo(toSx(q.x), toSy(q.y)); }); ctx.closePath(); }
        ctx.fill('evenodd');
      }
    }
    // 選取/懸停宗地
    ctx.fillStyle = cSel + '33';
    for (const i of S.sel.par) { tracePoly(ds, ds.parcels[i].ids); ctx.fill(); }
    if (S.hover && S.hover.t === 'par') { ctx.fillStyle = cHov + '22'; tracePoly(ds, ds.parcels[S.hover.k].ids); ctx.fill(); }
    // 邊
    if (ST.edge.show) {
      ctx.strokeStyle = cEdge; ctx.lineWidth = ST.edge.width; ctx.beginPath();
      for (const e of ds.edges.values()) { if (e.arcPart) continue; const a = ds.points.get(e.a), b = ds.points.get(e.b); ctx.moveTo(toSx(a.x), toSy(a.y)); ctx.lineTo(toSx(b.x), toSy(b.y)); }
      ctx.stroke(); strokeArcs(ds, cEdge, ST.edge.width);
    }
    const strokeEdges = (keys, color, w) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
      for (const k of keys) { const e = ds.edges.get(k); if (!e) continue; const a = ds.points.get(e.a), b = ds.points.get(e.b); ctx.moveTo(toSx(a.x), toSy(a.y)); ctx.lineTo(toSx(b.x), toSy(b.y)); } ctx.stroke(); };
    strokeEdges(S.sel.edge, cSel, 3);
    if (S.hover && S.hover.t === 'edge') strokeEdges([S.hover.k], cHov, 3);
    for (const i of S.sel.par) { ctx.strokeStyle = cSel; ctx.lineWidth = 2; tracePoly(ds, ds.parcels[i].ids); ctx.stroke(); }
    // 點
    if (ST.pt.show && sc > 0.6) {
      const r = ST.pt.size > 0 ? ST.pt.size : sc > 8 ? 3 : 1.6, cP = sc_('pt', 'color', '--edge'), cM = sc_('pt', 'movedColor', '--bad');
      for (const p of ds.points.values()) {
        const sx = toSx(p.x), sy = toSy(p.y); if (sx < -5 || sy < -5 || sx > W + 5 || sy > H + 5) continue;
        ctx.fillStyle = Core.isMoved(p) ? cM : cP; ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      }
    }
    if (S.clean && !S.printing) {   // 清理預覽：將被刪的點（橘＝沒有宗地使用、紫＝直線多餘）
      ctx.lineWidth = 2; for (const q of S.clean.pts) { const sx = toSx(q.x), sy = toSy(q.y); if (sx < -8 || sy < -8 || sx > W + 8 || sy > H + 8) continue; ctx.strokeStyle = q.add ? '#2f9e44' : q.u ? '#f08c00' : '#9c36b5'; ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 7); if (q.add) { ctx.moveTo(sx - 5, sy); ctx.lineTo(sx + 5, sy); ctx.moveTo(sx, sy - 5); ctx.lineTo(sx, sy + 5); } else { ctx.moveTo(sx - 5, sy - 5); ctx.lineTo(sx + 5, sy + 5); ctx.moveTo(sx + 5, sy - 5); ctx.lineTo(sx - 5, sy + 5); } ctx.stroke(); }
    }
    if ($('dlgBl').open && S.bl.res && $('chkBlMap').checked && !S.printing) drawBaseline(ds);
    if ($('dlgChk').open && S.chk.res && $('chkMap').checked && !S.printing) drawCheck();
    if (S.sheet && S.sheet.show && $('sheetShow').checked && !S.printing) drawSheet();
    if (S.topo && !S.printing) drawTopo();
    if (!S.printing) { if ($('dlgTopo').open) { drawBatch(); if (S.sheet && $('seamShow').checked) drawSeamPairs(); } drawLive(); if (S.msView && $('dlgMs').open) drawMs(); }
    if ($('dlgOwn').open && S.owner && S.owner.res && $('chkOwnMap').checked) drawOwners(ds);
    if ($('dlgUnreg').open && S.unreg && !S.printing) {   // 未登記地：黃＝未登記、橘＝需要分割（超過點數或太細長）、紅＝空隙
      ctx.save(); const n = unN();
      for (const u of S.unreg.parcels) { const p = ds.parcels[u.idx]; if (!p || p.deleted) continue; ctx.fillStyle = u.over ? 'rgba(240,140,0,.35)' : 'rgba(250,210,0,.25)'; tracePoly(ds, p.ids); ctx.fill(); }
      ctx.fillStyle = 'rgba(209,36,47,.45)'; for (const g of S.unreg.gaps) { tracePoly(ds, g.ids); ctx.fill(); }
      if (S.sgaps) { ctx.fillStyle = 'rgba(47,158,68,.4)'; ctx.strokeStyle = '#2f9e44'; ctx.lineWidth = 2; for (const g of S.sgaps) { ctx.beginPath(); g.nodes.forEach((n, i) => i ? ctx.lineTo(toSx(n.x), toSy(n.y)) : ctx.moveTo(toSx(n.x), toSy(n.y))); ctx.closePath(); ctx.fill(); ctx.stroke(); } }   // 與鄰段之間的空隙
      ctx.restore();
    }
    if (S.pocket && !S.printing) {   // 封閉凹口：封口線（紫虛線）與圍出的範圍（綠）
      ctx.save(); const k = S.pocket;
      if (k.region) { ctx.fillStyle = 'rgba(47,158,68,.35)'; tracePoly(ds, k.region.ids); ctx.fill(); }
      ctx.strokeStyle = '#9c36b5'; ctx.lineWidth = 3; ctx.setLineDash([7, 4]); ctx.beginPath();
      for (const [a, b] of k.chords) { const p = ds.points.get(a), q = ds.points.get(b); ctx.moveTo(toSx(p.x), toSy(p.y)); ctx.lineTo(toSx(q.x), toSy(q.y)); }
      if (k.pend != null && S.cursor) { const p = ds.points.get(k.pend); ctx.moveTo(toSx(p.x), toSy(p.y)); ctx.lineTo(toSx(S.cursor.x), toSy(S.cursor.y)); }
      ctx.stroke(); ctx.restore();
    }
    if (S.ringMark && !S.printing) {   // 界址串檢查：跳線（紅虛線）
      ctx.save(); ctx.strokeStyle = '#d1242f'; ctx.lineWidth = 4; ctx.setLineDash([8, 5]); ctx.beginPath();
      for (const [a, b] of S.ringMark) { const p = ds.points.get(a), q = ds.points.get(b); if (!p || !q) continue; ctx.moveTo(toSx(p.x), toSy(p.y)); ctx.lineTo(toSx(q.x), toSy(q.y)); }
      ctx.stroke(); ctx.restore();
    }
    if (S.redraw && !S.printing) {   // 重繪界址串：已點選的點依序連線，最後一段接到游標
      const pts = S.redraw.ids.map(id => ds.points.get(id)).filter(Boolean);
      ctx.save(); ctx.strokeStyle = '#2f9e44'; ctx.lineWidth = 3; ctx.beginPath();
      pts.forEach((q, i) => i ? ctx.lineTo(toSx(q.x), toSy(q.y)) : ctx.moveTo(toSx(q.x), toSy(q.y)));
      if (pts.length && S.cursor) { ctx.setLineDash([6, 4]); ctx.lineTo(toSx(S.cursor.x), toSy(S.cursor.y)); }
      ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = '#2f9e44'; ctx.font = 'bold 12px sans-serif';
      pts.forEach((q, i) => { const sx = toSx(q.x), sy = toSy(q.y); ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 7); ctx.fill(); ctx.fillText(String(i + 1), sx + 7, sy - 7); });
      ctx.restore();
    }
    if (S.tool === 'addpt' && S.hover && S.hover.t === 'edge' && S.cursor && !S.printing) {   // 加點預覽：垂足
      const e = ds.edges.get(S.hover.k), a = e && ds.points.get(e.a), b = e && ds.points.get(e.b);
      if (e && !e.arcPart) { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((S.cursor.x - a.x) * dx + (S.cursor.y - a.y) * dy) / l2)) : 0; ctx.strokeStyle = cHov; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(toSx(a.x + t * dx), toSy(a.y + t * dy), 6, 0, 7); ctx.stroke(); }
    }
    const eff = selCount() ? effectiveIds() : [];
    ctx.fillStyle = cSel; for (const id of eff) { const p = ds.points.get(id); if (!p) continue; ctx.fillRect(toSx(p.x) - 4, toSy(p.y) - 4, 8, 8); }
    if (S.seam && $('chkSeam').checked && !S.printing) drawSeam();
    if (S.hover && S.hover.t === 'pt') { const p = ds.points.get(S.hover.k); ctx.strokeStyle = cHov; ctx.lineWidth = 2; ctx.strokeRect(toSx(p.x) - 6, toSy(p.y) - 6, 12, 12); }
    // 標註
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const autoFs = Math.min(15, Math.max(9, sc * 1.6));
    if (ST.label.show && sc > 1.2) {
      ctx.font = `${ST.label.size > 0 ? ST.label.size : autoFs}px sans-serif`; ctx.fillStyle = sc_('label', 'color', '--edge');
      for (const p of ds.parcels) {
        const c = Core.centroidOf(ds.points, p.ids), sx = toSx(c.x), sy = toSy(c.y); if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
        ctx.fillText(p.label, sx, sy);
      }
    }
    // 圖上面積較差：預設只標有變動或已選取的宗地，在地號下方標示 Δ（超限用超限色）；可改為全部宗地
    if (ST.delta.show && sc > 0.25) {
      const mode = $('deltaMode').value, tol = parseFloat($('tol').value) || 0, bg = css('--canvas'), cOk = sc_('delta', 'okColor', '--ok'), cBd = sc_('delta', 'badColor', '--bad');
      const fs = ST.delta.size > 0 ? ST.delta.size : Math.min(14, Math.max(9, sc * 1.4)), off = (ST.label.show ? (ST.label.size > 0 ? ST.label.size : autoFs) : 0) + 1;
      ctx.font = `bold ${fs}px sans-serif`; ctx.textAlign = 'center'; ctx.lineJoin = 'round'; ctx.lineWidth = 3;
      for (const p of ds.parcels) {
        const changed = Math.abs(p.area - p.areaOrig) > 1e-6;
        if (!ST.delta.all && !changed && !S.sel.par.has(p.idx)) continue;
        const base = mode === 'reg' ? p.areaReg : p.areaOrig; if (base == null) continue;
        const d = p.area - base, c = Core.centroidOf(ds.points, p.ids);
        const sx = toSx(c.x), sy = toSy(c.y) + off; if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
        const t = (d >= 0 ? '+' : '') + d.toFixed(2);
        ctx.strokeStyle = bg; ctx.strokeText(t, sx, sy); ctx.fillStyle = Math.abs(d) > (mode === 'reg' ? regTol(p) : tol) ? cBd : cOk; ctx.fillText(t, sx, sy);
      }
    }
    if (ST.ptid.show && sc > 14) {
      ctx.font = `${ST.ptid.size}px sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = sc_('ptid', 'color', '--ref');
      for (const p of ds.points.values()) { const sx = toSx(p.x), sy = toSy(p.y); if (sx > 0 && sy > 0 && sx < W && sy < H) ctx.fillText(p.id, sx + 5, sy - 5); }
    }
  }
  drawImages(true);
  // 現況點與參考線
  const sv = S.survey;
  if (ST.survey.show && sv.lines.length) {
    for (const ln of sv.lines) {
      ctx.beginPath(); ln.points.forEach((n, i) => { const p = sv.points.get(n); i ? ctx.lineTo(toSx(p.x), toSy(p.y)) : ctx.moveTo(toSx(p.x), toSy(p.y)); });
      if (ln.closed) { ctx.closePath(); ctx.fillStyle = cSv + '22'; ctx.fill(); }
      ctx.strokeStyle = cSv; ctx.lineWidth = ST.survey.width; ctx.stroke();
    }
  }
  if (S.draft && S.draft.names.length) {
    ctx.strokeStyle = cSv; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath();
    S.draft.names.forEach((n, i) => { const p = sv.points.get(n); i ? ctx.lineTo(toSx(p.x), toSy(p.y)) : ctx.moveTo(toSx(p.x), toSy(p.y)); });
    if (S.cursor) ctx.lineTo(toSx(S.cursor.x), toSy(S.cursor.y)); ctx.stroke(); ctx.setLineDash([]);
  }
  if (ST.survey.show && sv.points.size) {
    const showName = ST.survey.names && sc > 1.5, sz = ST.survey.size, inDraft = S.draft ? new Set(S.draft.names) : new Set();
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const p of sv.points.values()) {
      const sx = toSx(p.x), sy = toSy(p.y); if (sx < -8 || sy < -8 || sx > W + 8 || sy > H + 8) continue;
      ctx.fillStyle = inDraft.has(p.name) ? cSel : cSv; ctx.beginPath(); ctx.moveTo(sx, sy - sz); ctx.lineTo(sx + sz, sy); ctx.lineTo(sx, sy + sz); ctx.lineTo(sx - sz, sy); ctx.closePath(); ctx.fill();
      if (showName) { ctx.fillStyle = cSv; ctx.fillText(p.name, sx + 8, sy - 6); }
    }
    if (S.hover && S.hover.t === 'sp') { const p = sv.points.get(S.hover.k); if (p) { ctx.strokeStyle = cHov; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(toSx(p.x), toSy(p.y), 9, 0, 7); ctx.stroke(); } }
  }
  // 控制點／補點（綠色三角形）
  if (ST.ctl.show && S.controls.size) {
    const cOk = sc_('ctl', 'color', '--ok'), showName = ST.ctl.names && sc > 0.8, z = ST.ctl.size;
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const p of S.controls.values()) {
      const sx = toSx(p.x), sy = toSy(p.y); if (sx < -8 || sy < -8 || sx > W + 8 || sy > H + 8) continue;
      ctx.fillStyle = cOk; ctx.beginPath(); ctx.moveTo(sx, sy - z); ctx.lineTo(sx + z * 0.92, sy + z * 0.67); ctx.lineTo(sx - z * 0.92, sy + z * 0.67); ctx.closePath(); ctx.fill();
      if (showName) ctx.fillText(p.name, sx + z + 2, sy - 5);
    }
  }
  // 旋轉樞紐
  if (ds && (S.tool === 'layer' || selCount())) {
    const pv = S.pivot || Core.centroidOf(ds.points, moveIds()), sx = toSx(pv.x), sy = toSy(pv.y);
    ctx.strokeStyle = cBad; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(sx - 9, sy); ctx.lineTo(sx + 9, sy); ctx.moveTo(sx, sy - 9); ctx.lineTo(sx, sy + 9); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 7); ctx.stroke();
  }
  // 兩點對位標記
  if (S.align) {
    const labels = ['A', 'A′', 'B', 'B′']; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    S.align.pts.forEach((p, i) => {
      const sx = toSx(p.x), sy = toSy(p.y); ctx.strokeStyle = i % 2 ? cSv : cBad; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 8, 0, 7); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle; ctx.fillText(labels[i], sx + 14, sy - 10);
    });
  }
  // 底圖版權
  if (S.basemap.provider !== 'none') { const t = PROVIDERS[S.basemap.provider].attr; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; const tw = ctx.measureText(t).width;
    ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillRect(W - tw - 10, H - 15, tw + 8, 13); ctx.fillStyle = '#333'; ctx.fillText(t, W - 6, H - 3); }
  // 框選
  if (S.box) {
    ctx.fillStyle = cSel + '22'; ctx.strokeStyle = cSel; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    const { x0, y0, x1, y1 } = S.box; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
  }
}

// ── 面板 ───────────────────────────────────────────────────────────────────
const f2 = v => v == null ? '—' : v.toFixed(2);
const sgn = v => (v >= 0 ? '+' : '') + v.toFixed(2);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let panelQueued = false;
function refresh() { if (panelQueued) return; panelQueued = true; requestAnimationFrame(() => { panelQueued = false; panel(); draw(); }); }
function setHint(t) { const h = $('hint'); h.textContent = t; h.style.display = t ? 'block' : 'none'; }
function lineList() {
  const sv = S.survey;
  $('svInfo').textContent = sv.points.size ? `現況點 ${sv.points.size} 個，參考線 ${sv.lines.length} 條` : '尚未匯入現況點';
  $('lineList').innerHTML = sv.lines.map(l => {
    const st = Core.lineStats(sv, l);
    return `<tr data-id="${l.id}"><td><input type="text" class="lname" value="${esc(l.name)}" style="width:92px"></td><td>${l.points.length}</td><td>${st.length.toFixed(2)}</td>` +
      `<td>${st.area == null ? '—' : st.area.toFixed(2)}</td><td><label class="chk"><input type="checkbox" class="lclosed" ${l.closed ? 'checked' : ''}>閉</label></td><td><button class="btn lzoom">看</button> <button class="btn ldel">刪</button></td></tr>`;
  }).join('');
}
let ownKeyState = '';
let tqKey = '';
function panel() {
  const ds = S.ds;
  const st = S.st = ds ? Core.structSummary(ds) : { added: 0, removed: 0, rings: 0 }, structEd = st.added + st.removed + st.rings > 0, edited = !!ds && (structEd || Core.movedPoints(ds).length > 0);
  $('btnUndo').disabled = !S.undo.length; $('btnRedo').disabled = !S.redo.length;
  actDis('undo', !S.undo.length); actDis('redo', !S.redo.length); actDis('reset', !edited); actDis('delpt', !S.sel.pt.size); actDis('err', !ds);
  $('btnExpD14').disabled = !ds || !S.dbf.pts || !edited; $('btnExpD13').disabled = !ds || !S.dbf.bnd || !st.rings; $('btnExpD12').disabled = !ds || !st.holes; $('btnExpCase').disabled = !ds || !S.dbf.pts; $('btnErr').disabled = !ds;
  $('chkDeltaAll').checked = S.style.delta.all;
  if (S.owner && S.ds) { const k = S.undo.length + ':' + S.redo.length; if (k !== ownKeyState) { ownKeyState = k; ownRun(); if ($('dlgOwn').open) ownPanel(); } }
  ptPanel(); if ($('dlgUnreg').open) { const k = S.undo.length + ':' + S.redo.length; if (k !== unKey) { unKey = k; unregPanel(); } } if ($('dlgRing').open) { const k = S.undo.length + ':' + S.redo.length; if (k !== ringKey) { ringKey = k; ringPanel(); } } if ($('dlgClean').open) { const k = S.undo.length + ':' + S.redo.length + ':' + (S.ds && S.ds.points.size); if (k !== cleanKey) { cleanKey = k; cleanSoon(); } }
  $('btnExpJson').disabled = !ds && !S.survey.points.size;
  $('drop').style.display = (ds || S.survey.points.size || S.nb.length || S.img.length) ? 'none' : 'flex';
  lineList(); nbPanel(); outPanel(); imgPanel(); wfPanel(); progPanel(); if ($('dlgChk').open) chkPanel(); if ($('dlgTopo').open) { const k = S.undo.length + ':' + S.redo.length + ':' + S.chk.ok.size; if (k !== tqKey) { tqKey = k; tqPanel(); seamPanel(); } livePanel(); }
  const srcs = [...new Set([...S.controls.values()].map(p => p.src))];
  $('ctlInfo').textContent = S.controls.size ? `已知點 ${S.controls.size} 個（${srcs.join('、')}）` : '尚未匯入控制點 — 匯入 MAC 前需先匯入 CTL／CT2（或載入含 D20 的案件）';
  $('btnCtlClear').disabled = !S.controls.size;
  if (!ds) { $('selInfo').textContent = '尚未載入圖資'; return; }
  // 選取摘要
  const ids = effectiveIds(), parts = [];
  if (S.sel.pt.size) parts.push(`${S.sel.pt.size} 點`); if (S.sel.edge.size) parts.push(`${S.sel.edge.size} 線`); if (S.sel.par.size) parts.push(`${S.sel.par.size} 面`);
  let info = layerMode() ? `移圖模式：拖曳畫面、方向鍵或 ΔN/ΔE 會平移整張新圖（${ds.points.size} 點），Shift+拖曳為旋轉，舊圖不動` : parts.length ? `已選 ${parts.join('、')}，連動 ${ids.size} 個界址點` : '尚未選取（點擊或框選）';
  if (S.sel.pt.size === 1 && !S.sel.edge.size && !S.sel.par.size) { const p = ds.points.get([...S.sel.pt][0]); info += NL + `點 ${p.id}　N ${p.y.toFixed(3)}　E ${p.x.toFixed(3)}`; }
  if (S.sel.edge.size === 1 && !S.sel.pt.size && !S.sel.par.size) { const e = ds.edges.get([...S.sel.edge][0]), a = ds.points.get(e.a), b = ds.points.get(e.b); info += NL + `線 ${e.a}–${e.b}　長 ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(3)} m`; }
  $('selInfo').innerHTML = info.split(NL).map(s => `<div>${s}</div>`).join('');
  if (S.owner && S.sel.par.size === 1) $('selInfo').insertAdjacentHTML('beforeend', ownerInfoHtml(ds.parcels[[...S.sel.par][0]]));
  { const sel = [...S.sel.par].map(i => ds.parcels[i]).filter(p => !p.deleted), b = $('btnDelHole'); b.hidden = !sel.length; b.textContent = sel.length === 1 && (sel[0].containers || []).length ? '刪除地中地（併入外圈）' : sel.length > 1 ? `刪除 ${sel.length} 宗` : '刪除宗地'; $('btnMergeSel').hidden = sel.length < 2; $('btnMergeSel').textContent = `合併 ${sel.length} 宗`; }
  $('pivotInfo').textContent = S.pivot ? `樞紐：N ${S.pivot.y.toFixed(3)}  E ${S.pivot.x.toFixed(3)}（自訂）` : '樞紐：移動對象的中心（Alt+點擊可自訂）';
  // 較差表
  const scope = document.querySelector('input[name=scope]:checked').value, tol = parseFloat($('tol').value) || 0;
  const touched = new Set(); for (const id of ids) for (const pi of ds.pointParcels.get(id) || []) touched.add(pi);
  for (const i of S.sel.par) touched.add(i);
  const rows = scope === 'selected' ? [...touched] : scope === 'all' ? ds.parcels.map(p => p.idx) : scope === 'over' ? ds.parcels.filter(overLegal).map(p => p.idx) : ds.parcels.filter(p => Math.abs(p.area - p.areaOrig) > 1e-6).map(p => p.idx);
  for (const i of S.sel.par) if (!rows.includes(i)) rows.push(i);
  rows.sort((a, b) => Math.abs(ds.parcels[b].area - ds.parcels[b].areaOrig) - Math.abs(ds.parcels[a].area - ds.parcels[a].areaOrig));
  const cls = d => (Math.abs(d) > tol ? 'neg' : 'pos');
  $('tbody').innerHTML = rows.slice(0, 300).map(i => {
    const p = ds.parcels[i], d1 = p.area - p.areaOrig, d2 = p.areaReg == null ? null : p.area - p.areaReg, t2 = regTol(p), bad2 = d2 != null && Math.abs(d2) > t2;
    return `<tr data-i="${i}" class="${S.sel.par.has(i) ? 'sel' : ''}${bad2 ? ' warn' : ''}"><td>${p.label}${p.deleted ? '（已刪除）' : ''}</td><td>${f2(p.areaReg)}</td><td>${f2(p.areaOrig)}</td><td>${f2(p.area)}</td>` +
      `<td class="${cls(d1)}">${sgn(d1)}</td><td class="${d2 == null ? '' : bad2 ? 'neg' : 'pos'}" title="${legalOn() && p.areaReg > 0 ? '法定公差' : '警示值'} ±${t2.toFixed(2)} m²">${d2 == null ? '—' : sgn(d2)}</td></tr>`;
  }).join('');
  const changed = ds.parcels.filter(p => Math.abs(p.area - p.areaOrig) > 1e-6), tot = changed.reduce((s, p) => s + (p.area - p.areaOrig), 0);
  const nOver = legalOn() ? ds.parcels.filter(overLegal).length : 0;
  $('sumInfo').textContent = `共 ${changed.length} 宗地號面積有變動，合計 ${sgn(tot)} m²；已移動 ${Core.movedPoints(ds).length} 個界址點。` + (legalOn() ? `超出法定公差（對登記面積）${nOver} 宗。` : '') + (rows.length > 300 ? '（表格只列前 300 筆）' : '');
  $('layerInfo').innerHTML = `<div>作業圖層：${ds.source}（${ds.points.size} 點／${ds.edges.size} 線／${ds.parcels.length} 面）</div>` +
    (S.ref ? `<div>舊圖參考：${S.ref.source}（${S.ref.parcels.length ? S.ref.parcels.length + ' 面' : S.ref.edges.size + ' 線'}）</div>` : '<div>舊圖參考：無</div>') +
    `<div class="muted">檔案：${Object.values(S.names).join('、')}</div>` + (ds.arcs && ds.arcs.size ? `<div class="muted">含 ${ds.arcs.size} 段圓弧（面積已依弧線計算）</div>` : '');
}
$('tbody').addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const i = +tr.dataset.i; clearSel(); S.sel.par.add(i); zoomTo([i]); refresh();
});
$('lineList').addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (!tr) return; const id = +tr.dataset.id, ln = S.survey.lines.find(l => l.id === id); if (!ln) return;
  if (e.target.classList.contains('ldel')) { deleteLine(id); }
  else if (e.target.classList.contains('lzoom')) { let b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; for (const n of ln.points) { const p = S.survey.points.get(n); b = { x0: Math.min(b.x0, p.x), x1: Math.max(b.x1, p.x), y0: Math.min(b.y0, p.y), y1: Math.max(b.y1, p.y) }; } fit({ x0: b.x0 - 2, x1: b.x1 + 2, y0: b.y0 - 2, y1: b.y1 + 2 }); }
});
$('lineList').addEventListener('change', e => {
  const tr = e.target.closest('tr'); if (!tr) return; const ln = S.survey.lines.find(l => l.id === +tr.dataset.id); if (!ln) return;
  if (e.target.classList.contains('lname')) ln.name = e.target.value; if (e.target.classList.contains('lclosed')) ln.closed = e.target.checked; refresh();
});

// ── 界址串檢查與編修：核心在 Core.ringIssues／splitHole／setRing ──
let ringKey = '', unKey = '';
const RING_KIND = { embedded: '內含別宗整圈', repeat: '自我接觸', selfcross: '自我交錯', missinghole: '未設地中地' };
function ringPanel() {
  const box = $('ringList'); if (!S.ds) { box.innerHTML = '<div class="small muted">尚未載入圖資</div>'; return; }
  const r = S.ringIssues = Core.ringIssues(S.ds);
  $('ringSum').textContent = r.length ? `找到 ${r.length} 項界址串問題；點一列可放大檢視（紅虛線＝跳線）` : '沒有發現界址串問題';
  box.innerHTML = r.length ? '<table><thead><tr><th>地號</th><th>問題</th><th>說明</th><th></th></tr></thead><tbody>' + r.map((o, i) => {
    const can = (o.kind === 'embedded' && o.inside) || o.kind === 'missinghole';
    return `<tr data-i="${i}" style="cursor:pointer"><td>${esc(S.ds.parcels[o.p].label)}</td><td>${RING_KIND[o.kind]}</td><td class="small">${esc(Core.ringIssueLine(S.ds, o))}</td><td>${can ? `<button class="btn" data-fix="${i}">${o.kind === 'missinghole' ? '設為地中地' : '拆出地中地'}</button>` : `<button class="btn" data-redraw="${o.p}">重繪</button>`}</td></tr>`;
  }).join('') + '</tbody></table>' : '';
}
function ringFocus(o) {
  clearSel(); S.sel.par.add(o.p); if (o.h != null) S.sel.par.add(o.h); zoomTo([o.p]);
  S.ringMark = o.kind === 'embedded' ? o.jumps : o.kind === 'selfcross' ? o.pairs.flat() : null; refresh();
}
$('ringList').addEventListener('click', e => {
  const fx = e.target.closest('[data-fix]'), rd = e.target.closest('[data-redraw]'), tr = e.target.closest('tr[data-i]');
  if (fx) { const o = S.ringIssues[+fx.dataset.fix]; splitHoleUI(o.p, o.h); return; }
  if (rd) { clearSel(); S.sel.par.add(+rd.dataset.redraw); startRedraw(); return; }
  if (tr) ringFocus(S.ringIssues[+tr.dataset.i]);
});
function splitHoleUI(pi, hi) {
  const p = S.ds.parcels[pi], h = S.ds.parcels[hi], a0 = p.area;
  try {
    const r = Core.splitHole(S.ds, pi, hi); pushStruct(r.delta, `拆出地中地 ${h.label}`); S.ringMark = null; clearSel(); S.sel.par.add(pi);
    const cut = r.delta.parcels.get(pi).ids0.length !== p.ids.length;
    msg(`${p.label}：` + (cut ? `已從界址串移除 ${h.label} 的整圈` + (r.jumps.length ? '與跳線 ' + r.jumps.map(j => j.join('–')).join('、') : '') + (r.trimmed.length ? `（通道端點 ${r.trimmed.join('、')} 一併刪除）` : '') + '；' : '') + (r.linked ? `已設 ${h.label} 為地中地；` : '') + `面積 ${a0.toFixed(2)} → ${p.area.toFixed(2)} m²。可復原；記得輸出 D13` + (r.linked ? '＋D12' : '') + (r.trimmed.length ? '＋D14' : ''));
  } catch (err) { msg('無法拆出：' + err.message); }
  ringPanel(); refresh();
}
// 重繪界址串：依序點選既有界址點，Enter 或點回第一點完成
function startRedraw() {
  if (!S.ds) return msg('請先載入圖資'); if (S.sel.par.size !== 1) return msg('請先選取一宗要重繪的宗地');
  S.redraw = { pi: [...S.sel.par][0], ids: [] }; S.ringMark = null; redrawHint(); refresh();
}
function redrawHint() {
  const r = S.redraw; if (!r) return; const p = S.ds.parcels[r.pi];
  let a = ''; if (r.ids.length >= 3) { const pts = r.ids.map(id => S.ds.points.get(id)); let s2 = 0; pts.forEach((q, i) => { const n = pts[(i + 1) % pts.length]; s2 += (q.x - pts[0].x) * (n.y - pts[0].y) - (n.x - pts[0].x) * (q.y - pts[0].y); }); a = `，暫定面積 ${(Math.abs(s2) / 2).toFixed(2)} m²（不含弧與地中地）`; }
  setHint(`重繪 ${p.label} 的界址串（原 ${p.ids.length} 點、面積 ${p.area.toFixed(2)} m²）：依序點選界址點，已選 ${r.ids.length} 點${a}。點回第一點或 Enter 完成、Backspace 退一點、Esc 取消`);
}
function redrawPick(mx, my) {
  const q = nearestPoint(S.ds.points, toWx(mx), toWy(my), 12 / S.view.s); if (!q) return msg('請點在界址點上'); const ids = S.redraw.ids;
  if (ids.length >= 3 && q.id === ids[0]) { finishRedraw(); return; }
  if (ids.includes(q.id)) return msg(`界址點 ${q.id} 已點選過`); ids.push(q.id); redrawHint(); draw();
}
function cancelRedraw() { S.redraw = null; setHint(''); draw(); }
function finishRedraw() {
  const r = S.redraw; if (!r) return; const p = S.ds.parcels[r.pi], a0 = p.area;
  try { const res = Core.setRing(S.ds, r.pi, r.ids); S.redraw = null; setHint(''); pushStruct(res.delta, `重繪界址串 ${p.label}`); msg(`已重繪 ${p.label} 的界址串：${p.ids.length} 點，面積 ${a0.toFixed(2)} → ${p.area.toFixed(2)} m²。可復原；記得輸出 D13`); }
  catch (err) { msg('無法完成：' + err.message); }
  if ($('dlgRing').open) ringPanel(); refresh();
}
// 刪除宗地（核心 Core.deleteParcel）：地中地面積併入外圈；一般宗地直接刪除，範圍變成空地／段外。輸出時 D13／D11／D21 一併更新，D12 照 NECEXE 保留
function deleteParcelUI(pis) {
  const ds = S.ds; if (!ds) return msg('請先載入圖資'); pis = (pis || [...S.sel.par]).filter(i => !ds.parcels[i].deleted); if (!pis.length) return msg('請先選取要刪除的宗地');
  const hs = pis.map(i => ds.parcels[i]), nest = hs.filter(h => (h.holes || []).some(x => !pis.includes(x)));
  if (nest.length) return msg(`${nest.map(h => h.label).join('、')} 本身還有地中地，請一併選取或先處理內層`);
  const line = h => (h.containers || []).length ? `${h.label}（地中地 ${h.area.toFixed(2)} m²，併入 ${h.containers.map(i => ds.parcels[i].label).join('、')}）` : `${h.label}（${h.area.toFixed(2)} m²，範圍變成空地／段外，面積不轉給別宗）`;
  const reg = hs.filter(h => !h.created && parseInt(h.label, 10) < 9000);
  if (!confirm(`刪除 ${hs.length} 宗：\n${hs.slice(0, 12).map(line).join('\n')}${hs.length > 12 ? '\n…' : ''}\n\n只屬於它的界址點會一併刪除；可復原。` + (reg.length ? `\n${reg.map(h => h.label).join('、')} 是已登記地號：D11 保留記錄、新面積改 0。` : ''))) return;
  // 內層先刪（地中地與外圈同時選取時）
  const order = hs.slice().sort((x, y) => ((x.holes || []).length - (y.holes || []).length)), deltas = [], pts = [];
  const into = [...new Set(hs.flatMap(h => h.containers || []))].filter(i => !pis.includes(i)).map(i => ds.parcels[i]);
  try {
    for (const h of order) { const r = Core.deleteParcel(ds, h.idx); deltas.push(r.delta); pts.push(...r.removedPoints); }
  } catch (err) { for (const d of deltas.slice().reverse()) Core.applyDelta(ds, d, 'undo'); msg('無法刪除：' + err.message); refresh(); return; }
  pushMulti(deltas, `刪除宗地 ${hs.map(h => h.label).join('、')}`); clearSel(); into.forEach(o => S.sel.par.add(o.idx));
  msg(`已刪除 ${hs.map(h => h.label).join('、')}` + (into.length ? `；地中地面積併入 ${into.map(o => `${o.label}（${o.area.toFixed(2)} m²）`).join('、')}` : '') + (pts.length ? `；刪除界址點 ${pts.slice(0, 20).join('、')}${pts.length > 20 ? '…' : ''}` : '') + '。可復原；輸出完整案件資料夾時 D13、D11、D21 會一併更新');
  if ($('dlgRing').open) ringPanel(); refresh();
}
$('btnDelHole').onclick = () => deleteParcelUI();
// 合併所選宗地（通用；核心 Core.mergeParcels）：外圍須相連成一圈、中間不可有空洞；保留已登記且地號最小者（未登記地合併是其特例，另可自動分割）。
// 被併掉的宗地標為已刪除：已登記地號 D11 保留記錄、新面積 0；9000 號以上整筆移除。只屬於這些宗地、合併後在內部的界址點一併刪除
function mergeParcelsUI(pis) {
  const ds = S.ds; if (!ds) return msg('請先載入圖資'); pis = (pis || [...S.sel.par]).filter(i => !ds.parcels[i].deleted); if (pis.length < 2) return msg('請先選取兩宗以上相連的宗地');
  const hs = pis.map(i => ds.parcels[i]), keep = hs.slice().sort((a, b) => (a.created - b.created) || (parseInt(a.label, 10) - parseInt(b.label, 10)) || String(a.label).localeCompare(String(b.label), 'zh-Hant', { numeric: true }))[0];
  const reg = hs.filter(h => h !== keep && !h.created && parseInt(h.label, 10) < 9000);
  if (!confirm(`合併 ${hs.length} 宗：${hs.slice(0, 12).map(h => h.label).join('、')}${hs.length > 12 ? '…' : ''}\n保留地號 ${keep.label}，合計 ${hs.reduce((t, h) => t + h.area, 0).toFixed(2)} m²；其餘標為已刪除。` + (reg.length ? `\n${reg.map(h => h.label).join('、')} 是已登記地號：D11 保留記錄、新面積改 0。` : '') + '\n合併後在內部、只屬於這些宗地的界址點會刪除；可復原。')) return;
  try { const a0 = hs.reduce((t, h) => t + h.area, 0), r = Core.mergeParcels(ds, pis, keep.idx); pushStruct(r.delta, `合併 ${hs.map(h => h.label).join('、')}`); clearSel(); S.sel.par.add(keep.idx);
    msg(`已合併成 ${r.keep}（${a0.toFixed(2)} → ${keep.area.toFixed(2)} m²），併入 ${r.merged.join('、')}` + (r.removedPoints.length ? `；刪除內部界址點 ${r.removedPoints.length} 點` : '') + '。可復原；輸出完整案件資料夾時 D13、D11、D21 會一併更新');
  } catch (err) { msg('無法合併：' + err.message); }
  if ($('dlgUnreg').open) unregPanel(); refresh();
}
$('btnMergeSel').onclick = () => mergeParcelsUI();

$('btnRingCheck').onclick = ringPanel; $('btnRedraw').onclick = startRedraw;
$('dlgRing').addEventListener('close', () => { S.ringMark = null; draw(); });

// ── 未登記土地（9000 號以上）：清單、合併、每筆 ≤ N 點分割、空隙與凹口建為新地號（核心在 Core.unregSummary／splitParcel／mergeParcels／fillRegion／pocketRegion）──
const unN = () => Math.max(3, parseInt($('unN').value, 10) || 30), unRatio = () => Math.max(0, parseFloat($('unRatio').value) || 0), unMother = () => Math.max(9000, parseInt($('unMother').value, 10) || 9001), unMin = () => Math.max(0, parseFloat($('unMin').value) || 0);
function pushMulti(deltas, label) {   // 多步驟的一鍵操作：一次復原
  deltas = deltas.filter(Boolean); if (!deltas.length) return;
  pushUndo({ undoFn: () => { for (const d of deltas.slice().reverse()) Core.applyDelta(S.ds, d, 'undo'); pruneSel(); }, redoFn: () => { for (const d of deltas) Core.applyDelta(S.ds, d, 'redo'); pruneSel(); }, label });
}
function unregPanel() {
  const ds = S.ds; if (!ds) { $('unSum').textContent = '尚未載入圖資'; $('unList').innerHTML = ''; S.unreg = null; return; }
  const n = unN(), lim = unRatio(), r = S.unreg = Core.unregSummary(ds, n, lim, unMin()), over = r.parcels.filter(p => p.over);
  $('unSum').innerHTML = `未登記地 <b>${r.parcels.length}</b> 筆（共 ${r.parcels.reduce((s, p) => s + p.area, 0).toFixed(2)} m²），需要分割 <b class="${over.length ? 'neg' : ''}">${over.length}</b> 筆（超過 ${n} 點 ${r.parcels.filter(p => p.overPts).length} 筆${lim ? `、長寬比超過 ${lim} 的 ${r.parcels.filter(p => p.long).length} 筆` : ''}）；宗地之間沒有地號的封閉空隙 <b>${r.gaps.length}</b> 處。` +
    '<div class="muted">圖上：黃＝未登記地、橘＝需要分割（超過點數或太細長）、紅＝空隙。與段外相通的長條（凹口）請用下方「封閉凹口」畫封口線。</div>';
  const rows = r.parcels.slice().sort((a, b) => (b.over - a.over) || String(a.label).localeCompare(String(b.label), 'zh-Hant', { numeric: true }));
  $('unList').innerHTML = '<table><thead><tr><th></th><th>地號</th><th>點數</th><th>長寬比</th><th>面積</th><th></th></tr></thead><tbody>' +
    r.gaps.map((g, i) => `<tr data-gap="${i}" style="cursor:pointer"><td></td><td class="neg">空隙 ${i + 1}</td><td>${g.ids.length}</td><td></td><td>${g.area.toFixed(2)}</td><td><button class="btn" data-fillgap="${i}">建為新地號</button></td></tr>`).join('') +
    rows.map(p => `<tr data-i="${p.idx}" style="cursor:pointer"><td><input type="checkbox" class="unchk" data-i="${p.idx}"${S.unSel && S.unSel.has(p.idx) ? ' checked' : ''}></td><td>${esc(p.label)}${p.nested ? '<span class="muted">（地中地）</span>' : ''}${p.arc ? '<span class="muted">（圓弧）</span>' : ''}</td><td class="${p.overPts ? 'neg' : ''}">${p.pts}</td><td class="${p.long ? 'neg' : ''}">${isFinite(p.ratio) ? p.ratio.toFixed(1) : '—'}</td><td>${p.area.toFixed(2)}</td><td></td></tr>`).join('') + '</tbody></table>';
}
S.unSel = new Set();
$('unList').addEventListener('change', e => { const c = e.target.closest('.unchk'); if (!c) return; c.checked ? S.unSel.add(+c.dataset.i) : S.unSel.delete(+c.dataset.i); });
$('unList').addEventListener('click', e => {
  if (e.target.closest('.unchk')) return;
  const fg = e.target.closest('[data-fillgap]'); if (fg) { const g = S.unreg.gaps[+fg.dataset.fillgap]; try { const r = Core.fillRegion(S.ds, g.ids, unMother()); pushStruct(r.delta, `空隙建為 ${r.label}`); msg(`空隙已建為新地號 ${r.label}（${g.area.toFixed(2)} m²、${g.ids.length} 點）。可復原`); } catch (err) { msg('無法建立：' + err.message); } unregPanel(); refresh(); return; }
  const tg = e.target.closest('tr[data-gap]'); if (tg) { const g = S.unreg.gaps[+tg.dataset.gap]; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const id of g.ids) { const q = S.ds.points.get(id); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); } fit({ x0: x0 - 10, x1: x1 + 10, y0: y0 - 10, y1: y1 + 10 }); return; }
  const tr = e.target.closest('tr[data-i]'); if (tr) { clearSel(); S.sel.par.add(+tr.dataset.i); zoomTo([+tr.dataset.i]); refresh(); }
});
const unChecked = () => [...S.unSel].filter(i => S.ds.parcels[i] && !S.ds.parcels[i].deleted);
// 批次處理時讓出主執行緒（約每 80 ms）並顯示進度，避免瀏覽器判定「網頁沒有回應」；處理期間停用按鈕
const unBusy = on => ['btnUnSplit', 'btnUnMerge', 'btnUnRefresh'].forEach(id => { $(id).disabled = on; });
function yielder(label, total) { let t = performance.now(); return async k => { if (performance.now() - t < 80) return; msg(`${label}… ${k}／${total}`); await new Promise(r => setTimeout(r, 0)); t = performance.now(); }; }
async function splitAsync(ds, i, n, lim, tick, k) { const g = Core.splitSteps(ds, i, n, lim, { minArea: unMin() }); for (;;) { const r = g.next(); if (r.done) return r.value; await tick(k); } }   // 每切一刀檢查是否該讓出主執行緒
$('btnUnSplit').onclick = () => unregSplit();
async function unregSplit() {   // 分割勾選的；沒勾選＝全部超過點數或長寬比上限者
  if (!S.ds || $('btnUnSplit').disabled) return null; if (!S.unreg) unregPanel(); const n = unN(), lim = unRatio(), list = unChecked().length ? unChecked() : S.unreg.parcels.filter(p => p.over).map(p => p.idx);
  if (!list.length) { msg(`沒有超過 ${n} 點` + (lim ? `或長寬比超過 ${lim}` : '') + ' 的未登記地'); return { split: 0, left: 0, failed: 0 }; }
  const deltas = [], made = [], fail = [], left = [];
  unBusy(true); const tick = yielder('分割中', list.length);
  for (const [k, i] of list.entries()) { await tick(k); const p = S.ds.parcels[i]; try { const r = await splitAsync(S.ds, i, n, lim, tick, k); if (r.delta) { deltas.push(r.delta); made.push(`${p.label}→${r.pieces.length + 1} 筆` + (r.delta.added.length ? `（新增 ${r.delta.added.length} 點）` : '')); } if (r.unresolved != null) left.push(`${p.label}（${r.unresolved.toFixed(1)}）`); } catch (err) { fail.push(`${p.label}（${err.message}）`); } }
  let ab = null; if ($('unAbsorb').checked && unMin() > 0) { ab = Core.absorbSlivers(S.ds, unMin()); deltas.push(...ab.deltas); }
  unBusy(false); pushMulti(deltas, `未登記地分割 ≤${n} 點` + (lim ? `、長寬比 ≤${lim}` : '')); S.unSel.clear();
  msg((made.length ? `已分割 ${made.length} 筆：${made.slice(0, 8).join('、')}${made.length > 8 ? '…' : ''}` : '沒有分割任何宗地') + (left.length ? `；形狀切不開、仍超過長寬比 ${left.length} 筆：${left.slice(0, 5).join('、')}` : '') + (fail.length ? `；未處理 ${fail.length} 筆：${fail.slice(0, 3).join('、')}` : '') + '。可一次復原' + (deltas.some(d => d.added && d.added.length) ? '；有新增界址點，輸出完整案件資料夾時 D14 一併更新' : '') + (ab ? `；碎塊併入相鄰未登記地 ${ab.merged.length} 筆` + (ab.left.length ? `，只鄰登記地而留下 ${ab.left.length} 筆（${ab.left.slice(0, 5).join('、')}）` : '') : ''));
  if ($('dlgUnreg').open) unregPanel(); return { split: made.length, left: left.length, failed: fail.length, absorbed: ab ? ab.merged.length : 0, small_left: ab ? ab.left : [] };
}
$('btnUnMerge').onclick = () => unregMerge();
async function unregMerge(ask = true) {   // 合併勾選的；沒勾選＝相連的未登記地各併成一筆（不限同母號）
  if (!S.ds || $('btnUnMerge').disabled) return null; if (!S.unreg) unregPanel(); const ds = S.ds, n = unN(), lim = unRatio(), auto = $('unAutoSplit').checked, deltas = [], done = [], fail = [];
  let groups;
  if (unChecked().length) groups = [unChecked()];
  else {   // 相連者為一組
    const un = S.unreg.parcels.filter(p => !p.nested && !p.arc).map(p => p.idx), set = new Set(un), parent = new Map(un.map(i => [i, i])), find = i => { while (parent.get(i) !== i) i = parent.get(i); return i; };
    // 相鄰＝共用界址線，或邊沿線重疊（T 字接點：一宗的點落在另一宗的邊上、沒有共用點）；只比外框相交的（不限同母號）
    const box = i => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const id of ds.parcels[i].ids) { const q = ds.points.get(id); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); } return { x0, x1, y0, y1 }; };
    const bb = new Map(un.map(i => [i, box(i)])), hit = (a, b) => a.x0 <= b.x1 + 0.05 && b.x0 <= a.x1 + 0.05 && a.y0 <= b.y1 + 0.05 && b.y0 <= a.y1 + 0.05;
    for (let a = 0; a < un.length; a++) for (let b = a + 1; b < un.length; b++) { const i = un[a], j = un[b]; if (find(i) !== find(j) && hit(bb.get(i), bb.get(j)) && Core.parcelsTouch(ds, i, j)) parent.set(find(j), find(i)); }
    const m = new Map(); for (const i of un) { const r = find(i); if (!m.has(r)) m.set(r, []); m.get(r).push(i); }
    groups = [...m.values()].filter(g => g.length > 1);
    if (!groups.length) { msg('沒有相連的未登記地可合併'); return { merged: 0, failed: 0 }; }
    if (ask && !confirm(`把相連的未登記地合併：共 ${groups.length} 組、${groups.reduce((s, g) => s + g.length, 0)} 筆` + (auto ? `，合併後再切成每筆 ≤ ${n} 點` + (lim ? `、長寬比 ≤ ${lim}` : '') : '') + '？可一次復原')) return;
  }
  if (!unChecked().length) {   // 自動分組：圍成一圈的組（中間是別的宗地）拆成不留空洞的幾群，各自合併
    const out = []; for (const g of groups) { const c = Core.mergeClusters(ds, g); if (c.delta) deltas.push(c.delta); out.push(...c.clusters.filter(x => x.length > 1)); } groups = out;
  }
  unBusy(true); const tick = yielder(auto ? '合併並分割中' : '合併中', groups.length);
  for (const [gi, g] of groups.entries()) {
    await tick(gi);
    try { const r = Core.mergeParcels(ds, g); deltas.push(r.delta); let t = `${r.keep}（併入 ${r.merged.length} 筆）`;
      if (auto) { const k = ds.parcels.find(p => p.label === r.keep && !p.deleted); const s = await splitAsync(ds, k.idx, n, lim, tick, gi); if (s.delta) { deltas.push(s.delta); t += `→再切成 ${s.pieces.length + 1} 筆`; } }
      done.push(t); } catch (err) { fail.push(`${g.map(i => ds.parcels[i].label).slice(0, 3).join('、')}…（${err.message}）`); }
  }
  let ab = null; if (auto && $('unAbsorb').checked && unMin() > 0) { ab = Core.absorbSlivers(ds, unMin()); deltas.push(...ab.deltas); if (ab.merged.length) done.push(`碎塊併入 ${ab.merged.length} 筆`); }
  unBusy(false); pushMulti(deltas, '未登記地合併'); S.unSel.clear();
  msg((done.length ? `已合併 ${done.length} 組：${done.slice(0, 6).join('、')}${done.length > 6 ? '…' : ''}` : '沒有合併任何宗地') + (fail.length ? `；未處理 ${fail.length} 組：${fail.slice(0, 2).join('；')}` : '') + '。可一次復原'); unregPanel(); refresh();
  return { merged: done.length, failed: fail.length };
}
// 封閉凹口：依序點兩個段外圍上的界址點＝一條封口線，可畫多條；Enter 建立
function startPocket() { if (!S.ds) return msg('請先載入圖資'); S.pocket = { chords: [], pend: null, region: null, err: '' }; pocketHint(); draw(); }
function pocketHint() {
  const k = S.pocket; if (!k) return;
  setHint(`封閉凹口：點兩個段外圍上的界址點畫一條封口線（已畫 ${k.chords.length} 條${k.pend != null ? `，起點 ${k.pend}` : ''}）。` + (k.region ? `圍出 ${k.region.area.toFixed(2)} m²、${k.region.ids.length} 點（綠色）；Enter 建為新地號 ${unMother()}-…` : k.err ? `⚠ ${k.err}` : '') + '　Backspace 退一步、Esc 取消');
}
function pocketPick(mx, my) {
  const k = S.pocket, q = nearestPoint(S.ds.points, toWx(mx), toWy(my), 12 / S.view.s); if (!q) return msg('請點在界址點上');
  if (k.pend == null) { k.pend = q.id; } else { if (q.id === k.pend) return; k.chords.push([k.pend, q.id]); k.pend = null;
    try { k.region = Core.pocketRegion(S.ds, k.chords); k.err = ''; } catch (err) { k.region = null; k.err = err.message; } }
  pocketHint(); draw();
}
function pocketBack() { const k = S.pocket; if (k.pend != null) k.pend = null; else k.chords.pop(); try { k.region = k.chords.length ? Core.pocketRegion(S.ds, k.chords) : null; k.err = ''; } catch (err) { k.region = null; k.err = err.message; } pocketHint(); draw(); }
function cancelPocket() { S.pocket = null; setHint(''); draw(); }
function finishPocket() {
  const k = S.pocket; if (!k || !k.region) return msg(k && k.err ? k.err : '請先畫封口線');
  try { const r = Core.fillRegion(S.ds, k.region.ids, unMother()); pushStruct(r.delta, `凹口建為 ${r.label}`); msg(`凹口已建為新地號 ${r.label}（${k.region.area.toFixed(2)} m²、${k.region.ids.length} 點）。點數超過 ${unN()} 可按「分割」；可復原`); cancelPocket(); }
  catch (err) { msg('無法建立：' + err.message); }
  if ($('dlgUnreg').open) unregPanel(); refresh();
}
// 與鄰段之間的封閉空隙（核心 Core.seamGaps／fillSeamGap）
S.sgaps = null;
const sgCenter = g => g.nodes.reduce((a, n) => ({ x: a.x + n.x / g.nodes.length, y: a.y + n.y / g.nodes.length }), { x: 0, y: 0 });
function seamGapPanel(recompute) {
  if (recompute) { if (!S.ds) return msg('請先載入圖資'); if (!S.nb.length) { S.sgaps = null; $('sgSum').textContent = '請先在「鄰段」加入相鄰地段'; $('sgList').innerHTML = ''; return; } S.sgaps = Core.seamGaps(S.ds, nbArgs()); }
  const g = S.sgaps || []; $('btnSeamGapsAll').disabled = !g.length;
  $('sgSum').innerHTML = S.sgaps ? (g.length ? `找到 <b>${g.length}</b> 處，共 ${g.reduce((t, x) => t + x.area, 0).toFixed(2)} m²（綠色）；點一列放大，按「建為新地號」建立` : '沒有找到與鄰段之間的封閉空隙') + ((g.skipped || []).length ? `<div class="muted">另有 ${g.skipped.length} 處圍出的範圍會蓋到宗地（${g.skipped.slice(0, 3).map(k => k.parcel || '鄰段').join('、')}${g.skipped.length > 3 ? '…' : ''}，多半是空地裡有不相連的宗地），不列出；請用「新增面」沿著空地手動圍</div>` : '') : '';
  $('sgList').innerHTML = g.length ? '<table><thead><tr><th></th><th>面積</th><th>點數</th><th>新增點</th><th></th></tr></thead><tbody>' + g.map((x, i) => `<tr data-sg="${i}" style="cursor:pointer"><td>空隙 ${i + 1}</td><td>${x.area.toFixed(2)}</td><td>${x.nodes.length}</td><td>${x.nodes.filter(n => n.id == null).length}</td><td><button class="btn" data-sgfill="${i}">建為新地號</button></td></tr>`).join('') + '</tbody></table>' : '';
  draw();
}
// 建立前重新計算，對回同一處（避免清單在復原或其他編修後過期）
function freshGap(old, cur) { const c = sgCenter(old); cur = cur || Core.seamGaps(S.ds, nbArgs()); return cur.find(x => { const d = sgCenter(x); return Math.hypot(d.x - c.x, d.y - c.y) < 0.5 && Math.abs(x.area - old.area) < Math.max(0.5, old.area * 0.01); }); }
$('btnSeamGaps').onclick = () => seamGapPanel(true);
$('sgList').addEventListener('click', e => {
  const b = e.target.closest('[data-sgfill]');
  if (b) { const old = S.sgaps[+b.dataset.sgfill], g = freshGap(old); if (!g) { msg('這處空隙已變動，請重新找出'); return seamGapPanel(true); }
    try { const r = Core.fillSeamGap(S.ds, g, unMother()); pushStruct(r.delta, `與鄰段之間的空隙建為 ${r.label}`); msg(`已建為新地號 ${r.label}（${g.area.toFixed(2)} m²、${g.nodes.length} 點，新增界址點 ${r.added.length} 點）。可復原；輸出完整案件資料夾時 D14、D13、D11、D21 會一併更新`); }
    catch (err) { msg('無法建立：' + err.message); }
    unregPanel(); seamGapPanel(true); refresh(); return; }
  const tr = e.target.closest('tr[data-sg]'); if (tr) { const g = S.sgaps[+tr.dataset.sg]; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const n of g.nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); } const m = Math.max(5, (x1 - x0 + y1 - y0) * 0.15); fit({ x0: x0 - m, x1: x1 + m, y0: y0 - m, y1: y1 + m }); }
});
$('btnSeamGapsAll').onclick = () => fillAllGaps();
function fillAllGaps(ask = true) {
  if (!S.sgaps || !S.sgaps.length) return { made: 0, failed: 0 }; const list = S.sgaps.slice();
  if (ask && !confirm(`把 ${list.length} 處與鄰段之間的空隙（共 ${list.reduce((t, x) => t + x.area, 0).toFixed(2)} m²）各建為新地號（母號 ${unMother()} 續編）？可一次復原`)) return;
  const deltas = [], made = [], fail = [], cur = Core.seamGaps(S.ds, nbArgs());   // 只重算一次；各處空隙互不影響（共用的新點建立時會沿用）
  for (const old of list) { const g = freshGap(old, cur); if (!g) { fail.push(old.area.toFixed(1)); continue; } try { const r = Core.fillSeamGap(S.ds, g, unMother()); deltas.push(r.delta); made.push(r.label); } catch (err) { fail.push(`${old.area.toFixed(1)}（${err.message}）`); } }
  pushMulti(deltas, '與鄰段之間的空隙建為新地號');
  msg((made.length ? `已建立 ${made.length} 筆：${made.slice(0, 8).join('、')}${made.length > 8 ? '…' : ''}` : '沒有建立任何地號') + (fail.length ? `；未建立 ${fail.length} 處：${fail.slice(0, 3).join('、')}` : '') + '。可一次復原；輸出完整案件資料夾時 D14、D13、D11、D21 會一併更新');
  unregPanel(); seamGapPanel(true); refresh();
  return { made: made.length, failed: fail.length };
}
$('btnUnPocket').onclick = startPocket; $('btnUnRefresh').onclick = unregPanel; $('unN').oninput = unregPanel; $('unRatio').oninput = unregPanel;
$('dlgUnreg').addEventListener('close', () => { cancelPocket(); S.sgaps = null; $('sgSum').textContent = ''; $('sgList').innerHTML = ''; });

// ── 檢視 ───────────────────────────────────────────────────────────────────
function fit(box) {
  let b = box;
  if (!b) {
    b = S.ds ? Core.bounds(S.ds) : null;
    for (const n of S.nb) { const q = Core.bounds(n.ds); b = b ? { x0: Math.min(b.x0, q.x0), x1: Math.max(b.x1, q.x1), y0: Math.min(b.y0, q.y0), y1: Math.max(b.y1, q.y1) } : q; }
    if (S.survey.points.size) { const s = surveyBounds(); b = b ? { x0: Math.min(b.x0, s.x0), x1: Math.max(b.x1, s.x1), y0: Math.min(b.y0, s.y0), y1: Math.max(b.y1, s.y1) } : s; }
    for (const im of S.img) { const q = imgBox(im); b = b ? { x0: Math.min(b.x0, q.x0), x1: Math.max(b.x1, q.x1), y0: Math.min(b.y0, q.y0), y1: Math.max(b.y1, q.y1) } : q; }   // 只有「全圖」才併入影像範圍；指定範圍（跳至地號）不受影像影響
  }
  if (!b || !isFinite(b.x0)) return;
  const w = Math.max(b.x1 - b.x0, 1), h = Math.max(b.y1 - b.y0, 1);
  S.view.s = Math.min(W / w, H / h) * 0.9; S.view.cx = (b.x0 + b.x1) / 2; S.view.cy = (b.y0 + b.y1) / 2; draw();
}
function zoomTo(parIdx) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of parIdx) for (const id of S.ds.parcels[i].ids) { const p = S.ds.points.get(id); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const m = Math.max(3, 0.25 * Math.max(x1 - x0, y1 - y0));   // 留四周鄰地當參考
  fit({ x0: x0 - m, x1: x1 + m, y0: y0 - m, y1: y1 + m });
}
cv.addEventListener('wheel', e => {
  e.preventDefault(); const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const wx = toWx(mx), wy = toWy(my), k = Math.exp(-e.deltaY * 0.0015);
  S.view.s = Math.min(2000, Math.max(0.02, S.view.s * k)); S.view.cx = wx - (mx - W / 2) / S.view.s; S.view.cy = wy + (my - H / 2) / S.view.s; draw();
}, { passive: false });
cv.addEventListener('contextmenu', e => e.preventDefault());

// ── 滑鼠互動 ───────────────────────────────────────────────────────────────
const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId); const [mx, my] = pos(e);
  if (e.button === 1 || e.button === 2 || S.tool === 'pan' || S.space) { S.drag = { kind: 'pan', mx, my, cx: S.view.cx, cy: S.view.cy }; return; }
  if (e.button !== 0) return;
  if (S.tool === 'img') {
    const hit = imgAt(toWx(mx), toWy(my)); if (hit >= 0) S.imgActive = hit; const im = imgActive();
    if (!im) { msg('請先載入影像'); return; }
    S.drag = { kind: 'img', im, wx: toWx(mx), wy: toWy(my), c0: im.wf.c, f0: im.wf.f }; refresh(); return;
  }
  if (S.topo) { if (S.ds) topoPick(mx, my); return; }
  if (S.align) { alignPick(mx, my); return; }
  if (S.redraw) { redrawPick(mx, my); return; }
  if (S.pocket) { pocketPick(mx, my); return; }
  if (S.tool === 'line') {
    const h = hitSurvey(mx, my); if (!h) return;
    if (!S.draft) S.draft = { names: [h.k] };
    else if (S.draft.names.length >= 3 && h.k === S.draft.names[0]) { finishDraft(true); return; }
    else if (S.draft.names[S.draft.names.length - 1] !== h.k) S.draft.names.push(h.k);
    setHint(`連線中：已選 ${S.draft.names.length} 點。繼續點選；Enter 完成、點回第一點閉合、Backspace 退一點、Esc 取消`); refresh(); return;
  }
  if (!S.ds) return;
  if (S.tool === 'addpt') { addPointAt(mx, my, e.shiftKey); return; }
  if (e.altKey) { S.pivot = { y: toWy(my), x: toWx(mx) }; refresh(); return; }
  if (layerMode()) {
    const ids = moveIds(), pv = pivotOf(ids), wx = toWx(mx), wy = toWy(my);
    S.drag = { kind: 'move', mx, my, wx, wy, before: snapshot(ids), moved: false, hit: null, toggleOff: false, rot: e.shiftKey, pv, a0: Math.atan2(wy - pv.y, wx - pv.x) }; return;
  }
  const h = hitTest(mx, my), add = e.shiftKey || e.ctrlKey;
  if (h) {
    let toggleOff = false;
    if (isSel(h)) toggleOff = add; else { if (!add) clearSel(); addSel(h); }
    S.drag = { kind: 'move', mx, my, wx: toWx(mx), wy: toWy(my), before: snapshot(effectiveIds()), moved: false, hit: h, toggleOff };
  } else { if (!add) clearSel(); S.drag = { kind: 'box', mx, my, add }; }
  refresh();
});
cv.addEventListener('pointermove', e => {
  const [mx, my] = pos(e), d = S.drag;
  S.cursor = { y: toWy(my), x: toWx(mx) };
  { const ll = Core.tm2ToLatLon(S.cursor.y, S.cursor.x, S.basemap.cm); $('stCoord').textContent = `N ${S.cursor.y.toFixed(3)}　E ${S.cursor.x.toFixed(3)}　(${ll.lat.toFixed(6)}°, ${ll.lon.toFixed(6)}°)`; }
  $('stScale').textContent = `1 px = ${(1 / S.view.s).toFixed(3)} m`;
  if (!d) {
    const h = S.align ? null : S.tool === 'line' ? hitSurvey(mx, my) : S.tool === 'select' && S.ds ? hitTest(mx, my) : S.tool === 'addpt' && S.ds ? (e2 => e2 ? { t: 'edge', k: e2.key } : null)(hitEdgeAt(toWx(mx), toWy(my), 8 / S.view.s)) : null;
    if (JSON.stringify(h) !== JSON.stringify(S.hover)) { S.hover = h; draw(); }
    tip(h, e); if (S.draft || S.align || S.redraw || S.pocket || S.tool === 'addpt') draw(); return;
  }
  if (d.kind === 'pan') { S.view.cx = d.cx - (mx - d.mx) / S.view.s; S.view.cy = d.cy + (my - d.my) / S.view.s; draw(); return; }
  if (d.kind === 'img') { setImgPos(d.im, d.c0 + (toWx(mx) - d.wx), d.f0 + (toWy(my) - d.wy)); return; }
  if (d.kind === 'box') { if (Math.hypot(mx - d.mx, my - d.my) > 3) { S.box = { x0: d.mx, y0: d.my, x1: mx, y1: my }; draw(); } return; }
  if (d.kind === 'move') {
    if (!d.moved && Math.hypot(mx - d.mx, my - d.my) < 4) return;
    d.moved = true; const wx = toWx(mx), wy = toWy(my);
    if (d.rot) {
      const ang = Math.atan2(wy - d.pv.y, wx - d.pv.x) - d.a0, T = { angle: ang, pivot: d.pv }; d.angle = ang;
      Core.setPoints(S.ds, d.before.map(([id, y, x]) => { const q = Core.xform({ y, x }, T); return [id, q.y, q.x]; }));
      setHint(`旋轉 ${(ang * 180 / Math.PI).toFixed(3)}°`);
    } else { const dx = wx - d.wx, dy = wy - d.wy; Core.setPoints(S.ds, d.before.map(([id, y, x]) => [id, y + dy, x + dx])); }
    refresh();
  }
});
cv.addEventListener('pointerup', () => {
  const d = S.drag; S.drag = null; if (!d) return;
  if (d.kind === 'img') { if (d.im.wf.c !== d.c0 || d.im.wf.f !== d.f0) pushImgUndo(d.im, d.c0, d.f0, d.im.wf.c, d.im.wf.f); return; }
  if (d.kind === 'box') { if (S.box) { boxSelect(S.box.x0, S.box.y0, S.box.x1, S.box.y1, d.add); S.box = null; } refresh(); return; }
  if (d.kind === 'move') {
    if (d.moved) commit(d.before, snapshot(new Set(d.before.map(b => b[0]))), d.rot ? '旋轉' : d.hit ? '拖曳' : '整圖平移');
    else if (d.toggleOff) toggleSel(d.hit);
    if (d.rot) setHint(''); refresh();
  }
});
cv.addEventListener('dblclick', () => { if (S.tool === 'line' && S.draft) finishDraft(false); });
function tip(h, e) {
  const t = $('tip'); if (!h) { t.style.display = 'none'; return; }
  let s = '';
  if (h.t === 'sp') { const p = S.survey.points.get(h.k); s = `現況點 ${p.name}\nN ${p.y.toFixed(3)}  E ${p.x.toFixed(3)}` + (p.code ? `\n${p.code}` : ''); }
  else if (!S.ds) { t.style.display = 'none'; return; }
  else if (h.t === 'pt') { const p = S.ds.points.get(h.k); s = `點 ${p.id}\nN ${p.y.toFixed(3)}  E ${p.x.toFixed(3)}`; }
  else if (h.t === 'edge') { const ed = S.ds.edges.get(h.k), a = S.ds.points.get(ed.a), b = S.ds.points.get(ed.b); s = `線 ${ed.a}–${ed.b}\n長 ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(3)} m\n鄰接：${ed.parcels.map(i => S.ds.parcels[i].label).join('、')}`; }
  else { const p = S.ds.parcels[h.k]; s = `地號 ${p.label}（舊 ${p.oldLabel}）\n面積 ${p.area.toFixed(2)} m²` + (p.areaReg != null ? `\n登記 ${p.areaReg.toFixed(2)} m²` : ''); }
  const r = cv.getBoundingClientRect(); t.textContent = s; t.style.display = 'block';
  t.style.left = Math.min(e.clientX - r.left + 14, r.width - 180) + 'px'; t.style.top = (e.clientY - r.top + 14) + 'px';
}

// ── 鍵盤 ───────────────────────────────────────────────────────────────────
addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && e.key !== 'Escape') return;
  if ($('impDlg').open) return;
  const k = e.key;
  if (k === ' ') { S.space = true; e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (k === 'Escape') { if (S.topo) topoCancel(); else if (S.pocket) cancelPocket(); else if (S.redraw) cancelRedraw(); else if (S.align) cancelAlign(); else if (S.draft) { S.draft = null; setHint(''); draw(); } else { clearSel(); refresh(); } }
  else if (k === 'Enter') { if (S.topo && S.topo.picks.length) topoRun(); else if (S.pocket) finishPocket(); else if (S.redraw) finishRedraw(); else if (S.align && S.align.step === 2) { finishAlign(); } else if (S.draft) finishDraft(false); }
  else if (k === 'Backspace' && S.topo) { S.topo.picks.pop(); topoPanel(); draw(); }
  else if (k === 'Backspace' && S.pocket) pocketBack();
  else if (k === 'Backspace' && S.redraw) { S.redraw.ids.pop(); redrawHint(); draw(); }
  else if (k === 'Backspace' && S.draft) { S.draft.names.pop(); if (!S.draft.names.length) { S.draft = null; setHint(''); } draw(); }
  else if (k === 'Delete' && S.ds && S.sel.pt.size) { e.preventDefault(); deleteSelectedPoints(); }
  else if (k === 'a' || k === 'A') setTool('addpt'); else if (k === 'v' || k === 'V') setTool('select'); else if (k === 'h' || k === 'H') setTool('pan'); else if (k === 'm' || k === 'M') setTool('layer'); else if (k === 'l' || k === 'L') setTool('line'); else if (k === 'i' || k === 'I') setTool('img');
  else if (k === '1') toggleFilter('pt'); else if (k === '2') toggleFilter('edge'); else if (k === '3') toggleFilter('par');
  else if (k.startsWith('Arrow') && S.tool === 'img' && imgActive()) {
    e.preventDefault(); const st = parseFloat($('step').value) * (e.shiftKey ? 10 : 1);
    moveImage(imgActive(), k === 'ArrowUp' ? st : k === 'ArrowDown' ? -st : 0, k === 'ArrowRight' ? st : k === 'ArrowLeft' ? -st : 0);
  }
  else if (k.startsWith('Arrow') && (selCount() || layerMode())) {
    e.preventDefault(); const st = parseFloat($('step').value) * (e.shiftKey ? 10 : 1);
    const dy = k === 'ArrowUp' ? st : k === 'ArrowDown' ? -st : 0, dx = k === 'ArrowRight' ? st : k === 'ArrowLeft' ? -st : 0;
    moveSelection(dy, dx, '微調');
  }
});
addEventListener('keyup', e => { if (e.key === ' ') S.space = false; });

// ── 工具列 ─────────────────────────────────────────────────────────────────
function setTool(t) {
  S.tool = t; if (t !== 'line' && S.draft) { S.draft = null; } if (t !== 'line' && t !== 'img' && !S.align) setHint('');
  document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  cv.style.cursor = t === 'pan' ? 'grab' : t === 'layer' || t === 'img' ? 'move' : t === 'line' || t === 'addpt' ? 'crosshair' : 'default';
  if (t === 'addpt') setHint('加點工具：在界址線上點一下加點（共用此線的宗地一併插入）；Shift＋點空白處＝孤立點。按 V 回到選取');
  if (t === 'img') setHint('移影像：拖曳作用中影像平移（點選哪張就以哪張為作用中），或用方向鍵微調（步距見「移動／旋轉」面板）；即時坐標顯示在底部與「處理」分頁');
  if (t === 'line') setHint('連線工具：依序點選現況點（Enter 完成、點回第一點閉合、Backspace 退一點、Esc 取消）'); refresh();
}
function toggleFilter(f) { S.filter[f] = !S.filter[f]; document.querySelector(`#filters [data-f=${f}]`).classList.toggle('on', S.filter[f]); }
document.querySelectorAll('#tools button').forEach(b => b.onclick = () => setTool(b.dataset.tool));
document.querySelectorAll('#filters button').forEach(b => b.onclick = () => toggleFilter(b.dataset.f));
$('btnUndo').onclick = undo; $('btnRedo').onclick = redo; $('btnFit').onclick = () => fit();
const actDis = (n, v) => document.querySelectorAll(`[data-act="${n}"]`).forEach(b => { b.disabled = v; });
// ── 功能列表與浮動面板 ──
function openPanel(id) {
  document.querySelectorAll('dialog.fp[open]').forEach(d => { if (d.id !== id) d.close(); });
  const d = $(id); if (!d.open) d.show();
  if (id === 'dlgClean') cleanPreview(); else if (id === 'dlgStyle') renderStyleRows(); else if (id === 'dlgRing') ringPanel(); else if (id === 'dlgUnreg') unregPanel(); else if (id === 'dlgBl') blPanel(); else if (id === 'dlgOwn') ownPanel(); else if (id === 'dlgChk') chkPanel(); else if (id === 'dlgTopo') { topoPanel(); seamPanel(); batchPanel(); livePanel(); } else if (id === 'dlgLog') logPanel(); else if (id === 'dlgMs') msPanel(); else if (id === 'dlgAi') aiPanel(); refresh();
}
function toggleSidebar() { document.querySelector('main').classList.toggle('nosb'); try { localStorage.setItem('cw.sidebar', document.querySelector('main').classList.contains('nosb') ? '0' : '1'); } catch (e) { /* ignore */ } }
const ACTS = {
  open: () => $('fileIn').click(), folder: () => $('dirIn').click(), data: () => openPanel('dlgData'), imp: () => $('btnImp').click(), out: () => openPanel('dlgOut'), outcase: exportCaseFolder, err: () => $('btnErr').click(), print: () => $('btnPrint').click(),
  undo, redo, reset: () => confirm('確定還原所有移動與界址點增刪？') && resetAll(), pts: () => openPanel('dlgPts'), ptline: () => openPanel('dlgPts'), addpt: () => setTool('addpt'), delpt: () => deleteSelectedPoints(), clean: () => openPanel('dlgClean'), ring: () => openPanel('dlgRing'), unreg: () => openPanel('dlgUnreg'), delhole: () => deleteParcelUI(), merge: () => mergeParcelsUI(), move: () => openPanel('dlgMove'),
  fit: () => fit(), style: () => openPanel('dlgStyle'), base: () => openPanel('dlgBase'), img: () => openPanel('dlgImg'), sidebar: toggleSidebar, seam: () => openPanel('dlgSeam'), ref: () => openPanel('dlgRef'), bl: () => openPanel('dlgBl'), own: () => openPanel('dlgOwn'), chk: () => openPanel('dlgChk'), topo: () => openPanel('dlgTopo'), flow: () => toggleFlow(), project: () => $('projDir').click(), projsave: () => saveProject(), log: () => openPanel('dlgLog'), ms: () => openPanel('dlgMs'), notesimp: () => $('notesIn').click(), projsaveas: () => saveProject(true), projopen: () => pickProject(), ai: () => openPanel('dlgAi'),
  help: () => $('help').showModal(),
};
document.addEventListener('click', e => {
  const mb = e.target.closest('.mbtn'); document.querySelectorAll('.menu.open').forEach(m => { if (!mb || m !== mb.parentElement) m.classList.remove('open'); });
  if (mb) { mb.parentElement.classList.toggle('open'); return; }
  const a = e.target.closest('[data-act]'); if (a && !a.disabled && ACTS[a.dataset.act]) ACTS[a.dataset.act]();
  const c = e.target.closest('[data-close]'); if (c) c.closest('dialog').close();
});
document.querySelectorAll('.menu').forEach(m => m.addEventListener('mouseenter', () => { if (document.querySelector('.menu.open') && !m.classList.contains('open')) { document.querySelectorAll('.menu.open').forEach(x => x.classList.remove('open')); m.classList.add('open'); } }));
$('btnSide').onclick = toggleSidebar;
try { if (localStorage.getItem('cw.sidebar') === '0') document.querySelector('main').classList.add('nosb'); } catch (e) { /* ignore */ }
$('deltaMode').onchange = draw;
document.querySelectorAll('input[name=scope]').forEach(r => r.onchange = refresh);
$('chkDeltaAll').onchange = () => { S.style.delta.all = $('chkDeltaAll').checked; if ($('chkDeltaAll').checked) S.style.delta.show = true; saveStyle(); if ($('dlgStyle').open) renderStyleRows(); refresh(); }; $('tol').oninput = refresh; $('tolLegal').onchange = refresh;
$('btnMove').onclick = () => { if (!moveSelection(parseFloat($('dN').value) || 0, parseFloat($('dE').value) || 0, '數值移動')) msg('請先選取要素，或切到「移圖」工具'); };
const rotAngle = () => { const v = Core.parseAngle($('rotDeg').value, 'auto'); return Number.isNaN(v) ? null : v; };
$('btnRotL').onclick = () => { const a = rotAngle(); if (a == null) return msg('旋轉角度格式不正確（例 0.5 或 0-30-00）'); if (!rotateSelection(a)) msg('請先選取要素，或切到「移圖」工具'); };
$('btnRotR').onclick = () => { const a = rotAngle(); if (a == null) return msg('旋轉角度格式不正確（例 0.5 或 0-30-00）'); if (!rotateSelection(-a)) msg('請先選取要素，或切到「移圖」工具'); };
$('btnPivotReset').onclick = () => { S.pivot = null; refresh(); };
$('btnAlign').onclick = startAlign;
// 跳至地號／點號：全形轉半形、「1092-0」＝「1092」；找不到完全相同的地號就找開頭相同的；「點 123」或只有點號相符時跳到界址點
const normLabel = q => q.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[－—–‐]/g, '-').replace(/\s+/g, '').replace(/-0$/, '');
function goTo(raw) {
  if (!S.ds) return msg('請先載入案件');
  let q = normLabel(String(raw || '')); if (!q) return;
  const ptOnly = /^(點|#)/.test(q); q = q.replace(/^(點|#)/, '');
  const pts = () => { const id = S.ds.points.has(+q) ? +q : S.ds.points.has(q) ? q : null; if (id == null) return false;
    const p = S.ds.points.get(id); clearSel(); S.sel.pt.add(id); fit({ x0: p.x - 20, x1: p.x + 20, y0: p.y - 20, y1: p.y + 20 }); refresh(); msg(`界址點 ${id}`); return true; };
  if (ptOnly) { if (!pts()) msg(`找不到界址點 ${q}`); return; }
  const L = p => [normLabel(p.label), normLabel(p.oldLabel)];
  let hit = S.ds.parcels.filter(p => L(p).includes(q));
  if (!hit.length) hit = S.ds.parcels.filter(p => L(p).some(l => l.startsWith(q + '-')));
  if (!hit.length && pts()) return;
  if (!hit.length) return msg(`找不到地號 ${q}`);
  clearSel(); hit.forEach(p => S.sel.par.add(p.idx)); zoomTo(hit.map(p => p.idx)); refresh();
  const p = hit[0];
  msg(hit.length > 1 ? `地號 ${q}：找到 ${hit.length} 宗（${hit.slice(0, 8).map(p => p.label).join('、')}${hit.length > 8 ? '…' : ''}），已全部選取` : `地號 ${p.label}` + (p.oldLabel !== p.label ? `（舊 ${p.oldLabel}）` : '') + `　面積 ${p.area.toFixed(2)} m²` + (p.areaReg != null ? `　登記 ${p.areaReg.toFixed(2)} m²` : ''));
}
function fillParList() { if (!S.ds) return; const set = new Set(); for (const p of S.ds.parcels) { set.add(p.label); set.add(p.oldLabel); }
  $('parList').innerHTML = [...set].sort((a, b) => a.localeCompare(b, 'zh-Hant', { numeric: true })).map(l => `<option value="${esc(l)}">`).join(''); }
for (const id of ['find', 'findTop']) {
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { goTo($(id).value); } else if (e.key === 'Escape') $(id).blur(); });
  $(id).addEventListener('focus', fillParList);
}
$('findTop').addEventListener('change', () => { if (S.ds && S.ds.parcels.some(p => p.label === $('findTop').value || p.oldLabel === $('findTop').value)) goTo($('findTop').value); });
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('findTop').focus(); $('findTop').select(); } });
const msg = t => { $('stMsg').textContent = t; clearTimeout(msg.t); msg.t = setTimeout(() => $('stMsg').textContent = '', 9000); };

// ── 輸出 ───────────────────────────────────────────────────────────────────
function download(name, data, type = 'application/octet-stream') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
$('btnExpD14').onclick = () => {
  const r = Core.exportD14(S.dbf.pts, S.ds); download(S.names.d14 || 'out.D14', r.bytes);
  const st = S.st || {};
  msg(`已輸出 ${S.names.d14}：改動 ${r.changed} 個點的坐標` + (r.added ? `、檔尾附加 ${r.added} 個新增點` : '') + (r.orphans ? `；${r.orphans} 個已刪除的點仍留在檔內（不從 D14 移除記錄，避免索引不一致）` : '') + '。' + (st.added || st.removed || st.rings ? '有增刪界址點，請一併輸出 D13。' : '') + '覆蓋原檔前請先備份案件資料夾。');
};
// ── 宗地關係偵錯報表 .ERR（仿 NECEXE；Big5、CRLF）──
let big5Map = null;
function big5Bytes(text) {   // TextEncoder 只會 UTF-8：用 TextDecoder('big5') 反推出字元 → 雙位元組對照表
  if (!big5Map) {
    big5Map = new Map(); const dec = new TextDecoder('big5');
    for (let a = 0xa1; a <= 0xf9; a++) for (let b = 0x40; b <= 0xfe; b++) { if (b > 0x7e && b < 0xa1) continue; const ch = dec.decode(Uint8Array.of(a, b)); if (ch.length === 1 && ch !== '�' && !big5Map.has(ch)) big5Map.set(ch, [a, b]); }
  }
  const out = []; for (const ch of text) { const c = ch.codePointAt(0); if (c < 128) out.push(c); else { const q = big5Map.get(ch); if (q) out.push(q[0], q[1]); else out.push(0x3f); } }
  return Uint8Array.from(out);
}
const caseBase = () => (S.names.d14 || S.names.coa || (S.ds && S.ds.name) || 'case').replace(/\.\w+$/, '');
function errReportText() {
  let pts = null;
  if (S.dbf.pts) { const rows = S.dbf.pts.rows.filter(r => !r._deleted && r.COT_NUMBER != null); pts = { confirmed: rows.filter(r => r.COT_REF === 0 && r.COT_Y && r.COT_X).length, refs: rows.filter(r => r.COT_REF !== 0 && r.COT_REF != null).length }; }
  return Core.errReport(S.ds, { name: caseBase(), date: new Date(), pts });
}
$('btnErr').onclick = () => {
  if (!S.ds) return msg('請先載入圖資');
  const txt = errReportText(), bytes = big5Bytes(txt.replace(/\n/g, '\r\n')); download(caseBase() + '.ERR', bytes, 'text/plain');
  msg(`已產出 ${caseBase()}.ERR（Big5、CRLF；${txt.split('\n').length} 行）。NECEXE 讀的欄位（調查情形、界址查註、坐標來源）本程式未讀取，報表內已註明略過`);
};
$('btnExpD13').onclick = () => {
  const r = Core.exportD13(S.dbf.bnd, S.ds); download(S.names.d13 || 'out.D13', r.bytes);
  msg(`已輸出 ${S.names.d13 || 'D13'}：改寫 ${r.parcels} 宗地的界址串（${r.rewritten} 筆記錄，檔尾附加 ${r.appended} 筆）。請與 D14 一併取代原檔；尚未用 NECEXE 驗證匯入，請先備份案件資料夾`);
};

$('btnExpD12').onclick = () => {
  if (!S.dbf.d12) return msg('案件沒有載入 D12：請把案件的 D12 放進資料夾重新開啟（本程式不自行建立 D12，避免欄位格式與 NECEXE 不符）');
  const r = Core.exportD12(S.dbf.d12, S.ds); download(S.names.d12 || 'out.D12', r.bytes);
  msg(`已輸出 ${S.names.d12 || 'D12'}：新增地中地關係 ${r.added} 筆` + (r.cleared ? `、解除 ${r.cleared} 筆（欄位清成 0）` : '') + '。請與 D13 一併取代原檔；尚未用 NECEXE 驗證匯入，請先備份案件資料夾');
};
// 輸出完整案件資料夾：原資料夾所有檔案原樣複製，只換掉有改動的 D 檔（D14／D13／D12）。
// 支援直接寫入資料夾的瀏覽器（Chrome、Edge）→ 選一個存放位置，建立新的子資料夾；其他瀏覽器 → 下載同內容的 ZIP。原資料夾永遠不覆寫。
// 讀取來源檔。開啟資料夾後原檔被改動或移走（其他程式存檔、同步軟體、搬移），瀏覽器會拒絕讀取（NotReadableError）。
// 這些都是原樣複製的檔案（改動的 D 檔在記憶體裡，不必讀原檔），所以略過並列出，請使用者自行從原資料夾複製，不讓整個輸出失敗、調整白做。
async function readItem(it, skipped) {
  try { return await it.get(); }
  catch (e) { skipped.push(`${it.rel}（${e && e.name === 'NotReadableError' ? '開啟後已被改動或移走' : e && e.message || e}）`); return null; }
}
async function exportCaseFolder() {
  if (!S.ds || !S.dbf.pts) return msg('請先用「開啟資料夾」載入 NECEXE 案件（D14＋D13）');
  const cf = S.caseFiles || { name: caseBase(), list: [], partial: true }, ch = Core.changedDFiles(S.ds, S.dbf);
  if (ch.needD12) return msg('設定了地中地但案件沒有 D12：請確認案件資料夾內有 D12 再重新開啟');
  const rep = new Map(); for (const [x, v] of Object.entries(ch.files)) { const n = S.names[x] || `${caseBase()}.${x.toUpperCase()}`; rep.set(n.toLowerCase(), { name: n, ...v }); }
  if (!rep.size && !confirm('沒有任何改動，仍要輸出一份與原案件相同的資料夾？')) return;
  const d = new Date(), z = v => String(v).padStart(2, '0'), stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`, folder = `${cf.name}_調整_${stamp}`;
  const items = []; const seen = new Set();
  for (const { rel, file } of cf.list) { const r = !rel.includes('/') && rep.get(rel.toLowerCase()); items.push({ rel, changed: !!r, get: r ? async () => r.bytes : () => readBuf(file) }); seen.add(rel.toLowerCase()); }
  for (const [k, r] of rep) if (!seen.has(k)) items.push({ rel: r.name, changed: true, get: async () => r.bytes });   // 只開了個別檔案時，至少放進改動的 D 檔
  const what = rep.size ? [...rep.values()].map(r => `${r.name}（${r.note}）`).join('、') : '無改動';
  const skipped = [], failed = [], skipMsg = () => (skipped.length ? `。⚠ ${skipped.length} 個原檔讀不到、沒有複製，請自行從原資料夾複製（未改動）：${skipped.slice(0, 5).join('、')}${skipped.length > 5 ? '…' : ''}` : '') +
    (failed.length ? `。⚠ ${failed.length} 個檔案寫入失敗${failed.some(f => f.changed) ? '（含改動的 D 檔，這個資料夾不完整，請勿使用）' : '（未改動，可自行從原資料夾複製）'}：${failed.slice(0, 5).map(f => `${f.rel}（${f.err}）`).join('、')}${failed.length > 5 ? '…' : ''}` : '');
  const warn = cf.partial ? '。注意：目前是用「開啟檔案」個別選的，資料夾內只有選取的檔案；要完整資料夾請改用「開啟資料夾」載入' : '';
  let picked = false;
  try {
    if (window.showDirectoryPicker) {
      const parent = await window.showDirectoryPicker({ id: 'necexe-out', mode: 'readwrite' }); picked = true;
      const exist = new Set(); for await (const [k] of parent.entries()) exist.add(k.toLowerCase());   // 先列出現有名稱，同名就加 (2)、(3)…
      let name = folder, n = 1; while (exist.has(name.toLowerCase())) name = `${folder}(${++n})`;
      const root = await parent.getDirectoryHandle(name, { create: true });
      for (const it of items) {   // 逐檔處理：一個檔失敗只列出，不中斷、不刪除已寫好的檔案
        const data = await readItem(it, skipped); if (!data) continue;   // 先讀來源再建檔：讀不到時不會留下 0 KB 的檔案與 .crswap
        const parts = it.rel.split('/'), fname = parts[parts.length - 1]; let w = null, dir = root;
        try {
          for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
          w = await (await dir.getFileHandle(fname, { create: true })).createWritable(); await w.write(data); await w.close();
        } catch (e) { if (w) { try { await w.abort(); } catch {} try { await dir.removeEntry(fname); } catch {} } failed.push({ rel: it.rel, changed: it.changed, err: `${e && e.name || ''} ${e && e.message || e}`.trim() }); }
      }
      msg(`已建立資料夾「${parent.name}／${name}」：${items.length - skipped.length - failed.length} 個檔案，改動的 D 檔：${what}。可直接用 NECEXE 開啟這個資料夾${warn}${skipMsg()}`);
    } else {
      const files = []; for (const it of items) { const data = await readItem(it, skipped); if (data) files.push({ name: `${folder}/${it.rel}`, data }); }
      download(folder + '.zip', Core.makeZip(files, d), 'application/zip');
      msg(`已下載 ${folder}.zip：${files.length} 個檔案，改動的 D 檔：${what}。解壓縮後即為完整案件資料夾，可直接用 NECEXE 開啟${warn}${skipMsg()}`);
    }
  } catch (err) { if (err && err.name === 'AbortError' && !picked) return; msg('輸出失敗：' + `${err && err.name || ''} ${err && err.message || err}`.trim()); }   // 只有取消選資料夾才靜默；寫檔被瀏覽器擋下也是 AbortError，要顯示
}
$('btnExpCase').onclick = exportCaseFolder;
$('btnExpJson').onclick = () => download((S.names.d14 || 'session').replace(/\.\w+$/, '') + '.adjust.json', JSON.stringify(Core.exportSession(S.ds || Core.newDataset('', ''), { files: S.names, control_points: [...S.controls.values()].map(p => ({ name: p.name, y: p.y, x: p.x, source: p.src })) }, S.survey), null, 2), 'application/json');

// ── 載入檔案 ───────────────────────────────────────────────────────────────
const extOf = n => (n.split('.').pop() || '').toLowerCase();
const readBuf = f => f.arrayBuffer().then(b => new Uint8Array(b));
const readText = f => readBuf(f).then(u => { try { return new TextDecoder('utf-8', { fatal: true }).decode(u); } catch { return new TextDecoder('big5').decode(u); } });
async function loadFiles(files) {
  const by = {}, dup = [], texts = [], macs = [], ctlFiles = [], imgs = [], mdbs = [];
  const pj = files.find(f => extOf(f.name) === PROJ_EXT); if (pj) { await openProjectFile(pj); return true; }   // 專案檔
  for (const f of files) {
    const x = extOf(f.name);
    if (/^(txt|csv|xyz|pts|dat|asc)$/.test(x)) { texts.push(f); continue; }
    if (IMG_RE.test(x) || WLD_RE.test(x)) { imgs.push(f); continue; }
    if (x === 'mdb') { mdbs.push(f); continue; }
    if (x === 'mac') { macs.push(f); continue; }
    if (/^(ctl|ct2|cen|l02)$/.test(x)) { ctlFiles.push(f); continue; }
    if (!/^(d11|d12|d13|d14|d20|d21|d2b|d2c|d2d|coa|bnp|par)$/.test(x)) continue; if (by[x]) dup.push(f.name); else by[x] = f;
  }
  // 控制點／補點：CTL、CT2、CEN、L02、D20 —— 可在圖資之前或之後匯入
  let ctlMsg = '';
  const ctlAdd = (pts, src) => { if (pts.length) { const r = addControls(pts, src); ctlMsg += `${src} ${r.added} 點${r.replaced ? `（覆蓋同名 ${r.replaced}${r.conflicts ? `，其中 ${r.conflicts} 點坐標不同⚠` : '，坐標相同'}）` : ''}　`; } };
  for (const f of ctlFiles) ctlAdd(Core.parseCtl(await readText(f)).points, f.name);
  if (by.d20) ctlAdd(Core.parseDbf(await readBuf(by.d20)).rows.filter(r => !r._deleted && r.CTL_NAME && r.CTL_Y && r.CTL_X).map(r => ({ name: r.CTL_NAME, y: r.CTL_Y, x: r.CTL_X })), by.d20.name);
  if (ctlMsg) { msg('已匯入已知點：' + ctlMsg); if (!S.ds && S.controls.size) fit(controlsBounds()); }
  const has = (...xs) => xs.every(x => by[x]);
  let ds = null, ref = null; const names = {};
  const DS = async (cp, cb, extra = {}) => Core.datasetFromD({ pts: Core.parseDbf(await readBuf(cp)), bnd: Core.parseDbf(await readBuf(cb)), ...extra });
  const DL = async (cp, cl, extra = {}) => Core.datasetFromLines({ pts: Core.parseDbf(await readBuf(cp)), lin: Core.parseDbf(await readBuf(cl)), ...extra });
  if (has('d14', 'd13')) {
    const par = by.d11 ? Core.parseDbf(await readBuf(by.d11)) : null, d12 = by.d12 ? Core.parseDbf(await readBuf(by.d12)) : null;
    ds = await DS(by.d14, by.d13, { par, d12, name: by.d14.name, source: 'D14/D13 新成果' }); S.dbf.d12 = d12; S.dbf.par = par; S.dbf.lin = by.d21 ? Core.parseDbf(await readBuf(by.d21)) : null; if (by.d21) names.d21 = by.d21.name; S.dbf.pts = Core.parseDbf(await readBuf(by.d14)); S.dbf.bnd = Core.parseDbf(await readBuf(by.d13));
    names.d14 = by.d14.name; names.d13 = by.d13.name; if (by.d11) names.d11 = by.d11.name; if (by.d12) names.d12 = by.d12.name;
    if (has('d2c', 'd2d')) { ref = await DL(by.d2c, by.d2d, { name: 'old', source: 'D2C/D2D 舊圖線' }); names.d2c = by.d2c.name; names.d2d = by.d2d.name; }
    else if (has('d2c', 'd2b')) { ref = await DS(by.d2c, by.d2b, { name: 'old', source: 'D2C/D2B 舊圖' }); names.d2c = by.d2c.name; names.d2b = by.d2b.name; }
  } else if (has('coa', 'bnp')) {
    ds = Core.datasetFromKC({ coa: await readText(by.coa), bnp: await readText(by.bnp), par: by.par ? await readText(by.par) : null }); S.dbf.pts = null; S.dbf.bnd = null; S.dbf.d12 = null; S.dbf.par = null; S.dbf.lin = null;
    names.coa = by.coa.name; names.bnp = by.bnp.name; if (by.par) names.par = by.par.name;
  } else if (has('d2c', 'd2b')) {
    ds = await DS(by.d2c, by.d2b, { name: by.d2c.name, source: 'D2C/D2B 舊圖' }); S.dbf.d12 = null; S.dbf.par = null; S.dbf.lin = null; S.dbf.pts = Core.parseDbf(await readBuf(by.d2c)); S.dbf.bnd = Core.parseDbf(await readBuf(by.d2b));
    names.d14 = by.d2c.name; names.d13 = by.d2b.name; names.d2c = by.d2c.name; names.d2b = by.d2b.name;
  }
  if (imgs.length) await loadImages(imgs);
  if (!ds && mdbs.length && S.ds) { await loadOwners(mdbs[0]); return true; }
  if (!ds) {
    if (imgs.length) return true;
    if (macs.length) { openImport(await readText(macs[0]), macs[0].name, 'mac'); return true; }
    if (texts.length) { openImport(await readText(texts[0]), texts[0].name); return true; }
    if (ctlMsg) return true;
    msg('缺少必要檔案：需要 D14+D13，或 COA+BNP，或 D2C+D2B；控制點用 CTL/CT2/D20；現況點請用「匯入現況點」'); return false;
  }
  S.caseFiles = caseFolderFiles(files, by.d14 || by.coa || by.d2c); srcMain(files);
  S.bl.res = null; S.bl.focus = null; S.seam = null; S.clean = null; S.ringMark = null; S.redraw = null; S.ds = ds; S.ref = ref; S.names = names; S.undo.length = S.redo.length = 0; clearSel(); S.hover = null; S.pivot = null; S.align = null;
  S.owner = null; let ownMsg = ''; if (mdbs.length) { const r = await loadOwners(mdbs.find(f => /exam/i.test(f.name)) || mdbs[0], true); ownMsg = r ? `；登記資料 ${r}` : ''; }
  fit(); snapReset(); refresh();
  msg(`已載入 ${ds.parcels.length} 宗地號／${ds.points.size} 點` + (ctlMsg ? `；已知點：${ctlMsg}` : '') + ownMsg + (dup.length ? `（同副檔名重複，略過：${dup.slice(0, 3).join('、')}）` : ''));
  return true;
}
// 案件資料夾：與主要 D 檔同一個資料夾（含子資料夾）的所有檔案，供「輸出完整案件資料夾」原樣複製。只選了個別檔案時 partial＝true
function caseFolderFiles(files, main) {
  const path = f => f.webkitRelativePath || f._path || f.name, mp = main ? path(main) : '', k = mp.lastIndexOf('/'), dir = k >= 0 ? mp.slice(0, k + 1) : '';
  const list = files.filter(f => !dir || path(f).startsWith(dir)).map(f => ({ rel: path(f).slice(dir.length), file: f }));
  return { name: dir ? dir.replace(/\/$/, '').split('/').pop() : caseBase(), list, partial: !dir };
}
$('btnOpen').onclick = () => $('fileIn').click(); $('btnFolder').onclick = () => $('dirIn').click();
$('fileIn').onchange = e => { loadFiles([...e.target.files]); e.target.value = ''; };
$('dirIn').onchange = e => { loadFiles([...e.target.files]); e.target.value = ''; };
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', async e => {
  e.preventDefault(); const files = [];
  const walk = async en => {
    if (en.isFile) { const f = await new Promise(r => en.file(r)); f._path = en.fullPath.replace(/^\//, ''); files.push(f); }
    else if (en.isDirectory) { const rd = en.createReader(); let all = []; for (;;) { const b = await new Promise(r => rd.readEntries(r)); if (!b.length) break; all = all.concat(b); } for (const c of all) await walk(c); }
  };
  const items = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (items.length) for (const en of items) await walk(en); else files.push(...e.dataTransfer.files);
  e.shiftKey ? loadNeighbors(files) : loadProject(files).catch(err => msg(err.message));
});

// ── 影像疊圖（JPG／PNG ＋ JGW 定位檔）：資料夾內的影像全部先登記（只讀檔頭與定位檔），由使用者逐張決定是否顯示 ─────────
// 每張可個別：顯示、不透明度、疊在向量圖之下／之上、上下層順序、平移對位。第一次顯示才解碼，隱藏即釋放記憶體。
const IMG_RE = /^(jpg|jpeg|png)$/, WLD_RE = /^(jgw|jpgw|pgw|wld)$/;
const imgActive = () => S.img[S.imgActive] || null;
const imgBox = im => Core.imageBounds(im.wf, im.w, im.h);
const imgIdx = im => S.img.indexOf(im);
function ensureBitmap(im) {
  if (im.bmp) return Promise.resolve(im.bmp);
  if (!im.p) im.p = createImageBitmap(im.file, { imageOrientation: 'none' }).catch(() => createImageBitmap(im.file)).then(b => { if (im.visible && S.img.includes(im)) im.bmp = b; else b.close && b.close(); return im.bmp || null; })
    .catch(e => { im.error = e.message; msg(`影像 ${im.name} 無法解碼：${e.message}`); return null; }).finally(() => { im.p = null; draw(); refresh(); });
  return im.p;
}
function releaseBitmap(im) { if (im.bmp) { im.bmp.close && im.bmp.close(); im.bmp = null; } }
function setImgVisible(im, v) { im.visible = v; if (v) ensureBitmap(im); else releaseBitmap(im); }
async function loadImages(files) {
  srcRec().img.push(...files); S.srcDirty = true; const groups = new Map();
  for (const f of files) {
    const m = /^(.*)\.([^.]+)$/.exec(f.name); if (!m) continue; const x = m[2].toLowerCase(); const isImg = IMG_RE.test(x); if (!isImg && !WLD_RE.test(x)) continue;
    const key = nbDirOf(f) + m[1].toLowerCase(); let g = groups.get(key); if (!g) groups.set(key, g = { name: m[1] });
    if (isImg) g.img = f; else g.wld = f;
  }
  const withImg = [...groups.values()].filter(g => g.img), many = withImg.length > 1, added = [];
  const skipped = [...groups.values()].filter(g => !g.img).map(g => g.wld.name + '（找不到同名影像）');
  for (const g of withImg) {
    try {
      let size = Core.imageSize(new Uint8Array(await g.img.slice(0, 262144).arrayBuffer())), bmp0 = null;
      if (!size || !size.w) { bmp0 = await createImageBitmap(g.img, { imageOrientation: 'none' }).catch(() => createImageBitmap(g.img)); size = { w: bmp0.width, h: bmp0.height }; }
      let wf = null; if (g.wld) wf = Core.parseWorldFile(await readText(g.wld));
      if (!wf) { const s = Math.max(W, 200) / S.view.s * 0.6 / size.w; wf = { a: s, d: 0, b: 0, e: -s, c: S.view.cx - size.w * s / 2, f: S.view.cy + size.h * s / 2 }; }   // 沒有定位檔：放在畫面中央，之後手動平移對位
      const im = { name: g.img.name, file: g.img, w: size.w, h: size.h, bmp: null, wf, wf0: { ...wf }, visible: false, opacity: 0.7, above: false, located: !!g.wld };
      const old = S.img.findIndex(q => q.name.toLowerCase() === im.name.toLowerCase());
      if (old >= 0) { releaseBitmap(S.img[old]); S.img[old] = im; } else S.img.push(im);
      if (!many) { im.visible = true; if (bmp0) { im.bmp = bmp0; bmp0 = null; } else ensureBitmap(im); }   // 只載入單張：直接顯示；多張：全部先不顯示
      if (bmp0 && bmp0.close) bmp0.close();
      S.imgActive = S.img.indexOf(im);
      added.push(im.name + (g.wld ? '' : '（無定位檔，請平移對位）'));
    } catch (e) { skipped.push(g.img.name + '（' + e.message + '）'); }
  }
  if (added.length && !many) { const a = imgActive(); if (a) fit(imgBox(a)); }
  refresh();
  msg(added.length ? (many ? `已登記 ${added.length} 張影像（預設不顯示）：到「檢視→影像圖層」勾選要顯示的` : `已載入影像：${added.join('、')}`) + (skipped.length ? `；略過 ${skipped.join('、')}` : '') : '沒有可載入的影像' + (skipped.length ? `：${skipped.join('、')}` : '（需要 JPG／PNG，建議附同名 JGW／PGW）'));
  return { added, skipped };
}
// 影像 above=false 畫在向量圖之下、true 畫在向量圖之上；陣列後面的在上層
function drawImages(above) {
  const vx0 = toWx(0), vx1 = toWx(W), vy0 = toWy(H), vy1 = toWy(0), act = imgActive();
  for (const im of S.img) {
    if (!im.visible || !!im.above !== !!above) continue;
    const b = imgBox(im); if (b.x1 < vx0 || b.x0 > vx1 || b.y1 < vy0 || b.y0 > vy1) continue;
    if (!im.bmp) { ensureBitmap(im); continue; }
    const { a, d, b: bb, e, c, f } = im.wf, s = S.view.s, ox = c - a / 2 - bb / 2, oy = f - d / 2 - e / 2;   // 影像左上角（像元邊緣）的世界坐標
    ctx.save(); ctx.globalAlpha = im.opacity; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(DPR * s * a, -DPR * s * d, DPR * s * bb, -DPR * s * e, DPR * toSx(ox), DPR * toSy(oy));
    ctx.drawImage(im.bmp, 0, 0); ctx.restore();
  }
  if (act && act.visible && !!act.above === !!above && S.tool === 'img' && !S.printing) {   // 移影像工具：畫出作用中影像的外框
    const q = Core.imageCorners(act.wf, act.w, act.h); ctx.save(); ctx.strokeStyle = css('--sel'); ctx.lineWidth = 2; ctx.setLineDash([8, 5]); ctx.beginPath();
    q.forEach((p, i) => i ? ctx.lineTo(toSx(p.x), toSy(p.y)) : ctx.moveTo(toSx(p.x), toSy(p.y))); ctx.closePath(); ctx.stroke(); ctx.restore();
  }
}
const pointInQuad = (q, x, y) => { let ins = false; for (let i = 0, j = 3; i < 4; j = i++) if ((q[i].y > y) !== (q[j].y > y) && x < (q[j].x - q[i].x) * (y - q[i].y) / (q[j].y - q[i].y) + q[i].x) ins = !ins; return ins; };
const imgAt = (wx, wy) => {   // 由上層往下找：先看「向量之上」的，再看「向量之下」的
  for (const ab of [true, false]) for (let i = S.img.length - 1; i >= 0; i--) { const im = S.img[i]; if (im.visible && !!im.above === ab && pointInQuad(Core.imageCorners(im.wf, im.w, im.h), wx, wy)) return i; }
  return -1;
};
function imgPosText(im) {
  const dn = im.wf.f - im.wf0.f, de = im.wf.c - im.wf0.c;
  return `左上像元中心　N ${im.wf.f.toFixed(3)}　E ${im.wf.c.toFixed(3)}　｜　相對原定位 Δ北 ${dn >= 0 ? '+' : ''}${dn.toFixed(3)}　Δ東 ${de >= 0 ? '+' : ''}${de.toFixed(3)} m`;
}
function setImgPos(im, c, f) { im.wf.c = c; im.wf.f = f; msg(`影像 ${im.name}：${imgPosText(im)}`); refresh(); }
function pushImgUndo(im, c0, f0, c1, f1) {
  const st = S.seamStale; pushUndo({ undoFn: () => { im.wf.c = c0; im.wf.f = f0; }, redoFn: () => { im.wf.c = c1; im.wf.f = f1; } }); S.seamStale = st;
}
function moveImage(im, dy, dx) { const c0 = im.wf.c, f0 = im.wf.f; setImgPos(im, c0 + dx, f0 + dy); pushImgUndo(im, c0, f0, im.wf.c, im.wf.f); }
// 上下層：dir = 'up'（往上一層）、'down'、'top'、'bottom'
function moveImgLayer(im, dir) {
  const i = imgIdx(im); if (i < 0) return; const act = imgActive(); S.img.splice(i, 1);
  const j = dir === 'top' ? S.img.length : dir === 'bottom' ? 0 : dir === 'up' ? Math.min(S.img.length, i + 1) : Math.max(0, i - 1);
  S.img.splice(j, 0, im); S.imgActive = S.img.indexOf(act); draw(); refresh();
}
function removeImage(im) { const act = imgActive(), i = imgIdx(im); releaseBitmap(im); S.img.splice(i, 1); S.imgActive = act === im ? Math.min(i, S.img.length - 1) : S.img.indexOf(act); refresh(); }
function imgPanel() {
  const act = imgActive(), q = ($('imgFilter').value || '').trim().toLowerCase(), shown = S.img.filter(im => im.visible).length;
  $('imgSummary').textContent = S.img.length ? `已登記 ${S.img.length} 張影像，顯示中 ${shown} 張。` : '尚未載入影像';
  $('btnImgManage').disabled = !S.img.length; $('btnImgFit').disabled = !act;
  const rows = []; for (let i = S.img.length - 1; i >= 0; i--) { const im = S.img[i]; if (q && !im.name.toLowerCase().includes(q)) continue;
    rows.push(`<div style="border:1px solid var(--line);border-radius:6px;padding:6px;margin:5px 0${i === S.imgActive ? ';box-shadow:inset 3px 0 var(--sel)' : ''}"><div class="row"><label class="chk" title="顯示／隱藏這張影像"><input type="checkbox" data-i="${i}" data-k="visible"${im.visible ? ' checked' : ''}><b>${esc(im.name)}</b></label>` +
      `<span class="muted small">${im.w}×${im.h}　${Math.hypot(im.wf.a, im.wf.d).toFixed(4)} m/px${im.located ? '' : '　<span class="neg">無定位檔</span>'}${im.visible && !im.bmp ? '　解碼中…' : ''}</span><span style="flex:1"></span>` +
      `<button class="btn" data-i="${i}" data-k="up" title="上移一層">▲</button><button class="btn" data-i="${i}" data-k="down" title="下移一層">▼</button><button class="btn" data-i="${i}" data-k="fit" title="縮放到這張影像">縮放</button><button class="btn" data-i="${i}" data-k="del" title="移除">✕</button></div>` +
      `<div class="row small" style="margin-top:4px"><span class="muted">透明度</span><input type="range" min="0.05" max="1" step="0.05" value="${im.opacity}" data-i="${i}" data-k="opacity" style="width:90px"><span class="muted" data-pct="${i}">${Math.round(im.opacity * 100)}%</span>` +
      `<select data-i="${i}" data-k="above" title="疊在向量圖之下或之上"><option value="0"${im.above ? '' : ' selected'}>向量之下</option><option value="1"${im.above ? ' selected' : ''}>向量之上</option></select>` +
      `<label class="chk" title="作用中：移影像工具與下方平移對位的對象"><input type="radio" name="imgAct" data-i="${i}" data-k="active"${i === S.imgActive ? ' checked' : ''}>作用中</label></div></div>`); }
  $('imgList').innerHTML = S.img.length ? (rows.join('') || '<span class="muted">沒有符合的影像</span>') : '<span class="muted">尚未載入影像 — 到「檔案→資料來源與匯入」載入</span>';
  $('btnImgTool').classList.toggle('primary', S.tool === 'img');
  $('imgActiveSel').innerHTML = S.img.map((im, i) => `<option value="${i}"${i === S.imgActive ? ' selected' : ''}>${esc(im.name)}</option>`).join('');
  $('imgActiveSel').disabled = !S.img.length; $('btnImgMove').disabled = $('btnImgReset').disabled = !act;
  $('imgPos').textContent = act ? imgPosText(act) : '尚未載入影像';
  const moved = S.img.map((im, i) => [im, i]).filter(([im]) => Math.hypot(im.wf.c - im.wf0.c, im.wf.f - im.wf0.f) > 1e-9 || !im.located);
  $('imgOut').innerHTML = moved.length ? moved.map(([im, i]) => `<div class="row" style="margin:3px 0"><button class="btn imgjgw" data-i="${i}">下載 ${esc(im.name.replace(/\.\w+$/, ''))}.jgw</button><span class="small muted">${im.located ? `已平移 ${Math.hypot(im.wf.c - im.wf0.c, im.wf.f - im.wf0.f).toFixed(3)} m` : '新建定位（原無定位檔）'}</span></div>`).join('') : '<span class="muted small">沒有平移過的影像</span>';
}
$('btnImgAdd').onclick = () => $('imgIn').click(); $('imgIn').onchange = e => { loadImages([...e.target.files]); e.target.value = ''; };
$('btnImgFit').onclick = () => { const a = imgActive(); if (a) fit(imgBox(a)); };
$('btnImgManage').onclick = () => openPanel('dlgImg');
$('btnImgTool').onclick = () => setTool(S.tool === 'img' ? 'select' : 'img');
$('imgActiveSel').onchange = e => { S.imgActive = +e.target.value; refresh(); };
$('btnImgMove').onclick = () => { const a = imgActive(); if (a) moveImage(a, parseFloat($('imgDN').value) || 0, parseFloat($('imgDE').value) || 0); };
$('btnImgReset').onclick = () => { const a = imgActive(); if (!a) return; const c0 = a.wf.c, f0 = a.wf.f; setImgPos(a, a.wf0.c, a.wf0.f); pushImgUndo(a, c0, f0, a.wf.c, a.wf.f); };
$('btnImgAll').onclick = () => { for (const im of S.img) { const q = ($('imgFilter').value || '').trim().toLowerCase(); if (!q || im.name.toLowerCase().includes(q)) setImgVisible(im, true); } refresh(); };
$('btnImgNone').onclick = () => { for (const im of S.img) setImgVisible(im, false); refresh(); };
$('imgFilter').oninput = refresh;
$('imgList').addEventListener('input', e => { const k = e.target.dataset.k, im = S.img[e.target.dataset.i]; if (k !== 'opacity' || !im) return;   // 拖曳滑桿時不重建清單，只重畫
  im.opacity = +e.target.value; const t = $('imgList').querySelector(`[data-pct="${e.target.dataset.i}"]`); if (t) t.textContent = Math.round(im.opacity * 100) + '%'; draw(); });
$('imgList').addEventListener('change', e => { const im = S.img[e.target.dataset.i]; if (!im) return; const k = e.target.dataset.k;
  if (k === 'visible') setImgVisible(im, e.target.checked); else if (k === 'active') S.imgActive = +e.target.dataset.i; else if (k === 'above') im.above = e.target.value === '1'; refresh(); });
$('imgList').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.dataset.i == null) return; const im = S.img[b.dataset.i]; if (!im) return;
  if (b.dataset.k === 'up') moveImgLayer(im, 'up'); else if (b.dataset.k === 'down') moveImgLayer(im, 'down'); else if (b.dataset.k === 'fit') fit(imgBox(im)); else if (b.dataset.k === 'del') removeImage(im); });
$('imgOut').addEventListener('click', e => { if (!e.target.classList.contains('imgjgw')) return; const im = S.img[+e.target.dataset.i]; download(im.name.replace(/\.\w+$/, '') + '.jgw', Core.worldFileText(im.wf), 'text/plain'); });

$('btnGoOut').onclick = () => openPanel('dlgOut');
// 輸出面板的摘要：說明目前有什麼可輸出、為何輸出鈕是灰的
function outPanel() {
  const ds = S.ds, moved = ds ? Core.movedPoints(ds).length : 0, changed = ds ? ds.parcels.filter(p => Math.abs(p.area - p.areaOrig) > 1e-6).length : 0, st = S.st || { added: 0, removed: 0, rings: 0, holes: 0, deleted: 0 }, sEd = st.added + st.removed + st.rings + (st.holes || 0) + (st.deleted || 0);
  $('btnExpMoved').disabled = !moved; $('btnGoOut').hidden = !(moved || sEd);
  let h = '', hint = '';
  if (!ds) h = '<span class="muted">尚未載入主要測區。</span>';
  else {
    h = `已移動 <b>${moved}</b> 個界址點，面積變動 <b>${changed}</b> 宗地號。` + (sEd ? `<br>界址點新增 <b>${st.added}</b>、刪除 <b>${st.removed}</b>，<b>${st.rings}</b> 宗地的界址串改變。` : '');
    if (!moved && !sEd) {
      const j = S.seam && S.seam.join;
      hint = '目前沒有異動點，所以輸出鈕是灰色。先移動點、增刪界址點，或按「自動接合」。';
      if (j) {
        const un = j.unresolved, beyond = un.filter(u => u.reason === 'beyond_snap').length, conf = un.filter(u => u.reason === 'conflict').length;
        hint = '上次自動接合沒有移動任何點：' + [j.skipped.length ? `設為「只比對」的鄰段：${j.skipped.join('、')}` : '', beyond ? `${beyond} 點超出吸附上限（可到「處理」調高「吸附」）` : '', conf ? `${conf} 點與別點搶同一鄰段點` : ''].filter(Boolean).join('；') + '。';
      }
    } else if (S.dbf.pts) { const ch = Core.changedDFiles(ds, S.dbf); hint = `「輸出完整案件資料夾」會換掉：${Object.keys(ch.files).map(x => S.names[x] || x.toUpperCase()).join('、') || '（無）'}，其餘檔案原樣複製；用 NECEXE 開啟新資料夾後重算面積。` + (S.caseFiles && S.caseFiles.partial ? '目前是個別開啟的檔案，資料夾只會有選取的檔案；要完整資料夾請改用「開啟資料夾」。' : ''); }
    else hint = '主要測區不是由 D14 載入（COA／BNP），無法輸出 D14；請用「異動點位 CSV」或「輸出 JSON」。';
  }
  $('outSummary').innerHTML = h; $('outHint').textContent = hint;
}
$('btnExpMoved').onclick = () => download(`${(S.ds.name || 'main').replace(/\.\w+$/, '')}-moved-points.csv`, '\ufeff' + Core.movedPointsCsv(S.ds, S.seam && S.seam.join), 'text/csv;charset=utf-8');

// ── 鄰段：同時載入相鄰地段、以不同顏色區分，並檢查／接合段界 ───────────────────
const NB_COLORS = ['#e8590c', '#1c7ed6', '#9c36b5', '#2f9e44', '#c2255c', '#b08900', '#0c8599', '#6741d9'];
const SEAM_COLOR = { coincide: '#1a7f37', overlap: '#d1242f', gap: '#f08c00', missing_in_main: '#9c36b5', unmatched: '#9c36b5' };
const SEAM_TEXT = { coincide: '重合', overlap: '重疊', gap: '脫開', missing_in_main: '主區缺點', unmatched: '無對應' };
const nbDirOf = f => { const p = f.webkitRelativePath || f._path || ''; return p.slice(0, p.lastIndexOf('/') + 1); };
// ── 接圖前比對：參考圖資（各組可含多個資料夾）、比對、表格與圖上標記 ──────────────
async function loadBaseline(files) {
  const groups = new Map();
  for (const f of files) {
    const m = /^(.*)\.([^.]+)$/.exec(f.name); if (!m) continue; const x = m[2].toLowerCase(); if (!/^(d11|d12|d13|d14|coa|bnp|par)$/.test(x)) continue;
    const dir = nbDirOf(f), key = dir + m[1].toLowerCase(); let g = groups.get(key); if (!g) groups.set(key, g = { name: (dir.replace(/\/$/, '').split('/').pop() || m[1]), f: {} });
    if (!g.f[x]) g.f[x] = f;
  }
  const ds = [], skipped = [];
  for (const g of groups.values()) {
    try {
      let d = null;
      if (g.f.d14 && g.f.d13) d = Core.datasetFromD({ pts: Core.parseDbf(await readBuf(g.f.d14)), bnd: Core.parseDbf(await readBuf(g.f.d13)), par: g.f.d11 ? Core.parseDbf(await readBuf(g.f.d11)) : null, d12: g.f.d12 ? Core.parseDbf(await readBuf(g.f.d12)) : null, name: g.name, source: 'D 檔' });
      else if (g.f.coa && g.f.bnp) d = Core.datasetFromKC({ coa: await readText(g.f.coa), bnp: await readText(g.f.bnp), par: g.f.par ? await readText(g.f.par) : null, name: g.name, source: 'COA/BNP/PAR' });
      if (d && d.parcels.length) ds.push(d); else skipped.push(g.name);
    } catch (e) { skipped.push(g.name + '（' + e.message + '）'); }
  }
  if (!ds.length) { msg('沒有可用的接圖前圖資（需要 D14＋D13（＋D11）或 COA＋BNP（＋PAR））' + (skipped.length ? '：' + skipped.join('、') : '')); return { added: 0, skipped }; }
  const dirs = [...new Set(files.map(f => nbDirOf(f)).filter(Boolean))], top = dirs.length ? (dirs.length > 1 ? dirs.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, a.lastIndexOf('/', i - 1) + 1); }) : dirs[0]).replace(/\/$/, '').split('/').pop() : '';   // 各幅共同的上層資料夾名稱（例如「單幅」）
  const set = { name: ds.length > 1 ? `${top || ds[0].name}（${ds.length} 幅）` : ds[0].name, ds };
  S.bl.sets.push(set); S.bl.res = null; srcRec().bl.push({ files: files.filter(f => SRC_RE.test(f.name)), set }); S.srcDirty = true; sheetAuto(); blPanel(); refresh();
  msg(`已加入接圖前圖資「${set.name}」：${ds.reduce((t, d) => t + d.parcels.length, 0)} 宗` + (skipped.length ? `；略過 ${skipped.join('、')}` : ''));
  return { added: ds.length, name: set.name, skipped };
}
const blOpts = () => { const v = (id, d) => { const x = parseFloat($(id).value); return Number.isFinite(x) && x >= 0 ? x : d; }; return { a: v('blA', 0.25), b: v('blB', 0.07), ratio: v('blRatio', 5) }; };
function blRun(o = {}) {
  if (!S.ds) throw new Error('請先開啟目前的圖（接完圖的地籍圖）'); if (!S.bl.sets.length) throw new Error('請先加入接圖前圖資');
  S.bl.res = Core.compareBaseline(S.ds, S.bl.sets.map(s => s.ds), { ...blOpts(), ...o }); S.bl.focus = null; blPanel(); refresh(); return S.bl.res;
}
const BL_CAUSE = { '接圖前即不符': '#8a5a00', '接圖後產生': '#d1242f', '跨分幅，請人工判斷': '#6741d9', '接圖前無此宗': '#6741d9' };
function blPanel() {
  $('blSets').innerHTML = S.bl.sets.length ? S.bl.sets.map((s, i) => `<div class="row" style="margin:2px 0"><b>${esc(s.name)}</b><span class="muted">${s.ds.reduce((t, d) => t + d.parcels.length, 0)} 宗（${esc(s.ds[0].source)}）</span><button class="btn" data-blrm="${i}" title="移除這組">✕</button></div>`).join('') : '<span class="muted">尚未加入</span>';
  const r = S.bl.res; $('btnBlCsv').disabled = $('btnBlHtml').disabled = !r; $('btnBlRun').disabled = !S.ds || !S.bl.sets.length;
  if (!r) { $('blSum').textContent = !S.ds ? '請先開啟目前的圖' : S.bl.sets.length ? '按「開始比對」' : ''; $('blList').innerHTML = ''; return; }
  const f = r.fit, n = (v, d = 1) => (v == null ? '' : v.toFixed(d)), causes = {}; for (const x of r.flagged) causes[x.cause] = (causes[x.cause] || 0) + 1;
  $('blSum').innerHTML = `接圖前 ${r.refParcels} 宗（併回分幅後 ${r.refGroups} 個地號）；目前的圖 ${r.curParcels} 宗。` +
    `${Core.alignText(f)}。` + (f && f.sheets.length > 1 ? `<details class="small"><summary>各幅平移（${f.sheets.length} 幅）</summary><table><thead><tr><th>分幅</th><th>ΔE m</th><th>ΔN m</th><th>同地號</th><th>ICP 點</th><th>殘差中位數</th></tr></thead><tbody>${f.sheets.map(q => `<tr><td>${esc(q.name)}</td><td>${q.dx.toFixed(2)}</td><td>${q.dy.toFixed(2)}</td><td>${q.pairs}</td><td>${q.icp}</td><td>${q.median == null ? '—' : q.median.toFixed(2)}</td></tr>`).join('')}</tbody></table></details>` : '') +
    `<br><b style="color:${r.missing.length ? '#d1242f' : 'inherit'}">遺漏 ${r.missing.length}</b>　部分在區內 ${r.partial.length}　被未登記地佔用 ${r.occupied.length}　接圖前沒有 ${r.extra.length}　<b style="color:${r.flagged.length ? '#d1242f' : 'inherit'}">面積超過 ${r.opt.ratio} 倍公差 ${r.flagged.length}</b>` +
    (r.flagged.length ? '（' + Object.entries(causes).map(([k, v]) => `${k} ${v}`).join('、') + '）' : '');
  const cov = l => l.map(h => `${esc(h.label)}（${h.area.toFixed(0)}）`).join('、') || '—';
  const sec = (title, open, head, rows) => rows.length ? `<details ${open ? 'open' : ''} style="margin:4px 0"><summary><b>${title}</b>（${rows.length}）</summary><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></details>` : '';
  $('blList').innerHTML =
    (r.missing.length ? `<div class="row small" style="margin:4px 0"><button class="btn primary" id="btnBlFixAll" title="依接圖前界址從蓋住它的未登記地切出，建回原地號（登記面積照接圖前）；可一次復原">全部修復（${r.missing.length}）</button><span class="muted">只從未登記地（9000 號以上）切；位置上有登記地就不做，請人工處理</span></div>` : '') +
    sec('遺漏：接圖前有、目前的圖沒有', true, ['地號', '登記㎡', '接圖前㎡', '在圖內', '現屬（㎡）', ''], r.missing.map((m, i) => `<tr data-bl="missing:${i}" style="cursor:pointer"><td><b>${esc(m.label)}</b></td><td>${n(m.reg, 0)}</td><td>${n(m.area, 0)}</td><td>${(m.inside * 100).toFixed(0)}%</td><td class="small">${cov(m.cover)}${blRegNote(m.label)}</td><td><button class="btn" data-blfix="${i}" title="依接圖前界址從未登記地切出，建回 ${esc(m.label)}">修復</button></td></tr>`)) +
    sec(`面積較差超過 ${r.opt.ratio} 倍公差`, true, ['地號', '登記㎡', '現面積㎡', '較差㎡', '倍數', '接圖前倍數', '原因'], r.flagged.map(x => `<tr data-bl="par:${x.idx}" style="cursor:pointer"><td>${esc(x.label)}</td><td>${n(x.reg, 0)}</td><td>${n(x.area)}</td><td>${x.diff >= 0 ? '+' : ''}${n(x.diff)}</td><td><b>${n(x.ratio)}</b></td><td>${x.refRatio == null ? '' : n(x.refRatio) + (x.pieces > 1 ? `<div class="muted">${x.pieces} 塊</div>` : '')}</td><td class="cause" style="color:${BL_CAUSE[x.cause] || 'inherit'}" title="${x.cause}">${x.cause.replace('，請人工判斷', '')}</td></tr>`)) +
    sec('部分在區內（只有一部分落在目前的圖內，請確認區界）', false, ['地號', '登記㎡', '接圖前㎡', '在圖內', '區內部分現屬（㎡）'], r.partial.map((m, i) => `<tr data-bl="partial:${i}" style="cursor:pointer"><td>${esc(m.label)}</td><td>${n(m.reg, 0)}</td><td>${n(m.area, 0)}</td><td>${(m.inside * 100).toFixed(1)}%</td><td class="small">${cov(m.cover)}</td></tr>`)) +
    sec('登記地被未登記地佔用（超過該宗公差）', false, ['地號', '登記㎡', '被佔㎡', '公差㎡', '佔用的未登記地（㎡）'], r.occupied.map(o => `<tr data-bl="par:${o.idx}" style="cursor:pointer"><td>${esc(o.label)}</td><td>${n(o.reg, 0)}</td><td>${n(o.occ)}</td><td>${n(o.tol)}</td><td class="small">${cov(o.cover)}</td></tr>`)) +
    sec('接圖前的未登記地（目前另編號，不算遺漏）', false, ['地號', '接圖前㎡', '現屬（㎡）'], r.unreg.map((m, i) => `<tr data-bl="unreg:${i}" style="cursor:pointer"><td>${esc(m.label)}</td><td>${n(m.area, 0)}</td><td class="small">${cov(m.cover)}</td></tr>`)) +
    sec('目前的圖有、接圖前沒有（非未登記地）', false, ['地號'], r.extra.map(e => `<tr data-bl="par:${e.idx}" style="cursor:pointer"><td>${esc(e.label)}</td></tr>`)) +
    (!r.missing.length && !r.flagged.length ? '<div class="small" style="color:#1a7f37">沒有遺漏，也沒有面積超限的宗地</div>' : '');
}
function blFocus(kind, i) {
  if (kind === 'par') { clearSel(); S.sel.par.add(i); zoomTo([i]); S.bl.focus = null; refresh(); const p = S.ds.parcels[i]; msg(`${p.label}：面積 ${p.area.toFixed(2)} m²` + (p.areaReg != null ? `　登記 ${p.areaReg.toFixed(2)} m²` : '')); return; }
  const m = S.bl.res[kind][i]; S.bl.focus = m; clearSel(); for (const h of m.cover) S.sel.par.add(h.idx);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const r of m.rings) for (const q of r) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  const g = Math.max(5, 0.4 * Math.max(x1 - x0, y1 - y0)); fit({ x0: x0 - g, x1: x1 + g, y0: y0 - g, y1: y1 + g }); refresh();
  msg(`接圖前 ${m.label}（${m.area.toFixed(1)} m²，${(m.inside * 100).toFixed(0)}% 在目前的圖內）` + (m.cover.length ? '，現屬 ' + m.cover.map(h => h.label).join('、') + '（已選取）' : ''));
}
function drawBaseline(ds) {
  const r = S.bl.res, ring = q => { ctx.beginPath(); q.forEach((p, k) => k ? ctx.lineTo(toSx(p.x), toSy(p.y)) : ctx.moveTo(toSx(p.x), toSy(p.y))); ctx.closePath(); };
  ctx.save();
  ctx.strokeStyle = '#d6336c'; ctx.lineWidth = 2.5; for (const x of r.flagged) { const p = ds.parcels[x.idx]; if (p && !p.deleted) { ring(p.ids.map(id => ds.points.get(id))); ctx.stroke(); } }
  const layer = (list, fill, stroke) => { ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); for (const m of list) for (const q of m.rings) { ring(q); ctx.fill(); ctx.stroke(); } ctx.setLineDash([]); };
  layer(r.partial, 'rgba(240,140,0,.18)', '#f08c00'); layer(r.missing, 'rgba(209,36,47,.35)', '#d1242f');
  if (S.bl.focus) { ctx.strokeStyle = '#d1242f'; ctx.lineWidth = 4; for (const q of S.bl.focus.rings) { ring(q); ctx.stroke(); } }
  if (S.view.s > 0.5) { ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#d1242f';
    for (const m of r.missing) { const q = m.rings[0]; let sx = 0, sy = 0; for (const p of q) { sx += p.x; sy += p.y; } ctx.fillText('遺漏 ' + m.label, toSx(sx / q.length), toSy(sy / q.length)); } }
  ctx.restore();
}
$('btnBlDir').onclick = () => $('blDir').click(); $('btnBlAdd').onclick = () => $('blIn').click();
$('blIn').onchange = e => { loadBaseline([...e.target.files]); e.target.value = ''; }; $('blDir').onchange = e => { loadBaseline([...e.target.files]); e.target.value = ''; };
$('btnBlClear').onclick = () => { S.bl = { sets: [], res: null, focus: null }; blPanel(); refresh(); };
$('btnBlRun').onclick = () => { try { const r = blRun(); msg(`比對完成：遺漏 ${r.missing.length}、面積超限 ${r.flagged.length}`); } catch (e) { msg(e.message); } };
$('btnBlCsv').onclick = () => download(caseBase() + '_接圖前比對.csv', '﻿' + Core.baselineCsv(S.bl.res), 'text/csv;charset=utf-8');
// 互動報告（HTML）：接圖前比對＋舊圖檢核（有做的話），每筆一張卡片附局部圖，可篩選、勾已處理、寫備註、列印成 PDF
function reportHtml(negOnly = $('rptNeg').checked) {
  if (!S.ds || (!S.bl.res && !S.chk.res)) throw new Error('請先做接圖前比對或舊圖檢核');
  const d = new Date(), pad = n => String(n).padStart(2, '0'), both = S.bl.res && S.chk.res;
  return Core.baselineReportHtml(S.ds, S.bl.res, { chk: S.chk.res ? S.chk.res.rows.filter(x => !S.chk.ok.has(x.label)) : null, caseName: caseBase(), version: '地籍圖重測工作站 ' + APP_VERSION,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`, title: both ? '接圖前比對與舊圖檢核報告' : S.bl.res ? '接圖前比對報告' : '舊圖檢核報告', negOnly, notes: S.notes, done: reportDone() });
}
function downloadReport() { try { download(caseBase() + ($('rptNeg').checked ? '_比對報告_較差為負.html' : '_比對報告.html'), reportHtml(), 'text/html;charset=utf-8'); msg('已輸出比對報告（HTML）：用瀏覽器開啟，可篩選、勾已處理、寫備註，按「列印／另存 PDF」'); } catch (e) { msg(e.message); } }
$('btnBlHtml').onclick = downloadReport; $('btnChkHtml').onclick = downloadReport;
$('chkBlMap').onchange = draw;
$('blSets').addEventListener('click', e => { const b = e.target.closest('[data-blrm]'); if (!b) return; S.bl.sets.splice(+b.dataset.blrm, 1); S.bl.res = null; blPanel(); refresh(); });
// 遺漏地號一鍵修復：依接圖前界址從蓋住它的未登記地切出、建回原地號；全部同一步復原，做完重新比對
function blFix(items, ask = true) {
  if (!S.ds || !S.bl.res) throw new Error('請先比對'); if (!items.length) return { restored: [], failed: [] };
  const notReg = S.owner ? items.filter(m => !blInRegister(m.label)).map(m => m.label) : [];
  if (ask && notReg.length && !confirm(`登記資料（${S.owner.name}）沒有 ${notReg.join('、')}，可能已合併、分割或滅失，不一定是遺漏。仍要修復？`)) return null;
  if (ask && !confirm(`依接圖前界址把 ${items.map(m => m.label).join('、')} 從蓋住它的未登記地切出，建回原地號（登記面積照接圖前）？\n只從未登記地切；位置上有登記地就不做。可一次復原。`)) return null;
  const deltas = [], restored = [], failed = [];
  for (const m of items) { try { const x = Core.restoreMissing(S.ds, m); deltas.push(x.delta); restored.push({ label: x.label, area: x.area, from: x.from.map(f => f.label), pieces: x.pieces, deleted: x.deleted, added: x.added.length, hole: x.hole }); } catch (err) { failed.push({ label: m.label, reason: err.message }); } }
  if (deltas.length) pushMulti(deltas, `復原遺漏地號 ${restored.map(x => x.label).join('、')}`);
  blRun(); clearSel(); for (const x of restored) { const p = S.ds.parcels.find(q => !q.deleted && q.label === x.label); if (p) S.sel.par.add(p.idx); } refresh();
  msg((restored.length ? `已復原 ${restored.map(x => `${x.label}（${x.area.toFixed(2)} m²，取自 ${x.from.join('、')}${x.pieces.length ? `；未登記地剩下的另一塊編為 ${x.pieces.join('、')}` : ''}${x.deleted.length ? `；${x.deleted.join('、')} 整宗切完已刪除` : ''}）`).join('；')}` : '沒有復原任何地號') +
    (failed.length ? `。未修復：${failed.map(f => `${f.label}（${f.reason}）`).join('；')}` : '') + (restored.length ? '。可復原；輸出完整案件資料夾時 D14、D13、D11、D21 會一併更新' : ''));
  return { restored, failed };
}
$('blList').addEventListener('click', e => { const fx = e.target.closest('[data-blfix]'); if (fx) { try { blFix([S.bl.res.missing[+fx.dataset.blfix]]); } catch (err) { msg(err.message); } return; }
  if (e.target.closest('#btnBlFixAll')) { try { blFix(S.bl.res.missing.slice()); } catch (err) { msg(err.message); } return; }
  const tr = e.target.closest('tr[data-bl]'); if (!tr) return; const [k, i] = tr.dataset.bl.split(':'); blFocus(k, +i); });
$('dlgBl').addEventListener('close', () => { S.bl.focus = null; draw(); });
// ── 所有權人分析（EXAM.MDB）：載入、分析、面板、著色、選取資訊 ─────────────────────────
async function loadOwners(file, quiet = false) {
  try {
    const ot = Core.ownerTables(Core.parseMdb(await readBuf(file)));
    S.owner = { name: file.name, ot, res: null }; ownRun(); srcRec().own = file; S.srcDirty = true;
    const t = `${file.name}：土地標示 ${ot.landRows} 筆、權利人 ${ot.ownRows} 筆` + (S.owner.res ? `；非 9000 號沒有所有權人 ${S.owner.res.noOwner.length} 筆` : '');
    if (!quiet) msg('已讀入登記資料 ' + t); ownPanel(); if ($('dlgBl').open) blPanel(); refresh(); return t;
  } catch (e) { msg(`無法讀取 ${file.name}：${e.message}`); return ''; }
}
function ownRun() { if (S.owner && S.ds) S.owner.res = Core.ownerAnalysis(S.ds, S.owner.ot); return S.owner && S.owner.res; }
const OWN_COLOR = { none: 'rgba(209,36,47,.55)', public: 'rgba(47,158,68,.35)', single: 'rgba(28,126,214,.18)', corp: 'rgba(156,54,181,.3)', shared: 'rgba(240,140,0,.3)', joint: 'rgba(194,37,92,.3)', unreg: 'rgba(140,140,140,.18)' };
const OWN_TEXT = { ...Core.OWNER_CLASS, unreg: '未登記地（9000 號以上）' };
const ownKey = label => { const m = /^(\d+)(?:-(\d+))?$/.exec(String(label)); const sec = (S.ds && (S.ds.parcels.find(p => p.section) || {}).section) || 0; return m ? `${sec}|${+m[1]}|${+(m[2] || 0)}` : ''; };
const blInRegister = label => !S.owner || S.owner.ot.land.has(ownKey(label)) || S.owner.ot.own.has(ownKey(label));
const blRegNote = label => (S.owner && !blInRegister(label) ? `<div style="color:#8a5a00">登記資料無此地號（可能已合併或滅失，不一定是遺漏）</div>` : '');
function ownPanel() {
  const o = S.owner; $('ownSrc').textContent = o ? `${o.name}：土地標示 ${o.ot.landRows} 筆、權利人 ${o.ot.ownRows} 筆` : '尚未載入';
  $('btnOwnCsv').disabled = !(o && o.res);
  if (!o || !S.ds) { $('ownSum').textContent = !S.ds ? '請先開啟地籍圖' : '請載入 EXAM.MDB'; $('ownList').innerHTML = ''; return; }
  const r = o.res || ownRun(); if (!r) return;
  $('ownSum').innerHTML = `<div style="margin-bottom:4px"><b style="color:${r.noOwner.length ? '#d1242f' : '#1a7f37'}">非 9000 號、沒有所有權人：${r.noOwner.length} 筆</b>　登記有、圖上沒有：${r.noLand.length} 筆　持分合計不為 1：${r.shareBad.length} 筆</div>` +
    Object.keys(OWN_TEXT).filter(k => r.counts[k]).map(k => `<span style="display:inline-flex;align-items:center;gap:4px;margin:0 10px 2px 0"><span style="width:12px;height:12px;border:1px solid #888;background:${OWN_COLOR[k]}"></span>${OWN_TEXT[k]} ${r.counts[k]}</span>`).join('');
  const n = (v, d = 1) => (v == null ? '' : v.toFixed(d));
  const sec = (title, open, head, rows) => `<details ${open ? 'open' : ''} style="margin:4px 0"><summary><b>${title}</b>（${rows.length}）</summary>` + (rows.length ? `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>` : '<div class="small muted">無</div>') + '</details>';
  $('ownList').innerHTML =
    sec('非 9000 號、圖上有，但沒有所有權人', true, ['地號', '原地號', '面積㎡', '登記㎡', '說明'], r.noOwner.map(x => `<tr data-own="${x.idx}" style="cursor:pointer"><td><b>${esc(x.label)}</b></td><td>${esc(x.oldLabel)}</td><td>${n(x.area)}</td><td>${n(x.reg, 0)}</td><td class="small">${x.inLand ? '有土地標示、沒有所有權記錄' : '登記資料沒有此地號'}${x.others ? `；有 ${x.others} 筆他項權利` : ''}</td></tr>`)) +
    sec('登記資料有、圖上沒有', r.noLand.length > 0, ['原地號', '所有權人數'], r.noLand.map(x => `<tr><td>${esc(x.label)}</td><td>${x.owners}</td></tr>`)) +
    sec('持分合計不為 1（不含公同共有）', false, ['地號', '合計', '所有權人數'], r.shareBad.map(x => `<tr data-own="${x.idx}" style="cursor:pointer"><td>${esc(x.label)}</td><td>${x.sum}</td><td>${x.owners}</td></tr>`));
}
function ownerInfoHtml(p) {
  if (!p || p.deleted) return ''; const ot = S.owner.ot, land = ot.land.get(p.key), list = ot.own.get(p.key) || [], o = list.filter(x => x.right === '所有權'), oth = list.filter(x => x.right !== '所有權');
  const no = Core.parcelNo(p), cls = no && no.m >= 9000 ? 'unreg' : Core.ownerClass(list);
  return `<div style="margin-top:6px;border-top:1px solid var(--line);padding-top:4px"><div><b>${esc(p.label)}</b>${p.oldLabel !== p.label ? `（原 ${esc(p.oldLabel)}）` : ''}　<span style="background:${OWN_COLOR[cls]};padding:0 4px">${OWN_TEXT[cls]}</span></div>` +
    (land ? `<div>${esc(land.zone)}／${esc(land.use)}${land.other ? '　有他項權利' : ''}${land.bldg ? '　有建物登記' : ''}</div>` : `<div style="color:#8a5a00">${cls === 'unreg' ? '未登記地' : '登記資料沒有此地號'}</div>`) +
    o.slice(0, 30).map(x => `<div>・${esc(x.name)}${x.mgr ? `（管理者 ${esc(x.mgr)}）` : ''}　${esc(x.scope)}${x.den && x.num && x.scope !== '全部' ? ` ${esc(x.num)}/${esc(x.den)}` : ''}　<span class="muted">${esc(x.kind)}</span></div>`).join('') + (o.length > 30 ? `<div class="muted">…共 ${o.length} 人</div>` : '') +
    (oth.length ? `<div class="muted">他項權利：${oth.map(x => `${esc(x.right)}（${esc(x.name)}）`).join('、')}</div>` : '') + '</div>';
}
function drawOwners(ds) {
  ctx.save();
  for (const x of S.owner.res.parcels) { const p = ds.parcels[x.idx]; if (!p || p.deleted) continue; ctx.fillStyle = OWN_COLOR[x.cls]; ctx.beginPath(); p.ids.forEach((id, k) => { const q = ds.points.get(id); k ? ctx.lineTo(toSx(q.x), toSy(q.y)) : ctx.moveTo(toSx(q.x), toSy(q.y)); }); ctx.closePath(); ctx.fill(); if (x.cls === 'none') { ctx.strokeStyle = '#d1242f'; ctx.lineWidth = 3; ctx.stroke(); } }
  ctx.restore();
}
function ownCsv(r) {
  const q = v => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)), out = [['類別', '地號', '原地號', '面積㎡', '登記面積㎡', '所有權型態', '所有權人數', '說明'].join(',')];
  for (const x of r.noOwner) out.push(['沒有所有權人', x.label, x.oldLabel, x.area.toFixed(2), x.reg == null ? '' : x.reg, '', 0, x.inLand ? '有土地標示、沒有所有權記錄' : '登記資料沒有此地號'].map(q).join(','));
  for (const x of r.noLand) out.push(['登記有、圖上沒有', '', x.label, '', '', '', x.owners, ''].map(q).join(','));
  for (const x of r.shareBad) out.push(['持分合計不為 1', x.label, '', '', '', '', x.owners, x.sum].map(q).join(','));
  for (const x of r.parcels) { const p = S.ds.parcels[x.idx]; out.push(['宗地', p.label, p.oldLabel, p.area.toFixed(2), p.areaReg == null ? '' : p.areaReg, OWN_TEXT[x.cls], (S.owner.ot.own.get(p.key) || []).filter(o => o.right === '所有權').length, ''].map(q).join(',')); }
  return out.join('\r\n') + '\r\n';
}
$('btnOwnAdd').onclick = () => $('ownIn').click(); $('ownIn').onchange = e => { const f = e.target.files[0]; if (f) loadOwners(f); e.target.value = ''; };
$('chkOwnMap').onchange = draw;
$('btnOwnCsv').onclick = () => download(caseBase() + '_所有權人分析.csv', '﻿' + ownCsv(S.owner.res), 'text/csv;charset=utf-8');
$('ownList').addEventListener('click', e => { const tr = e.target.closest('tr[data-own]'); if (!tr) return; const i = +tr.dataset.own; clearSel(); S.sel.par.add(i); zoomTo([i]); refresh(); });
const ownFind = () => { if (!S.owner || !S.ds) return msg('請先開啟地籍圖並載入 EXAM.MDB'); const q = $('ownQ').value.trim(), hit = Core.findOwner(S.ds, S.owner.ot, q);
  clearSel(); hit.forEach(i => S.sel.par.add(i)); if (hit.length) zoomTo(hit); $('ownFindInfo').textContent = q ? `${hit.length} 宗` : ''; refresh(); msg(q ? (hit.length ? `「${q}」的土地 ${hit.length} 宗：${hit.slice(0, 10).map(i => S.ds.parcels[i].label).join('、')}${hit.length > 10 ? '…' : ''}（已選取）` : `找不到「${q}」的土地`) : ''); };
$('btnOwnFind').onclick = ownFind; $('ownQ').addEventListener('keydown', e => { if (e.key === 'Enter') ownFind(); });
const nbArgs = () => S.nb.map(n => ({ name: n.name, ds: n.ds, mode: n.mode, authoritative: n.mode === 'numeric', shift: n.mode === 'graphic' ? n.shift || null : null }));
const NB_MODE = { numeric: '數值區（照抄）', graphic: '圖解區（防重疊）', none: '只比對' };
const seamOpts = (o = {}) => { const v = (id, k) => { const x = parseFloat($(id).value); return Number.isFinite(x) && x >= 0 ? x : Core.SEAM_DEFAULT[k]; };
  return { tol: o.tol ?? v('seamTol', 'tol'), search: o.search ?? v('seamSearch', 'search'), snap: o.snap ?? v('seamSnap', 'snap') }; };
// 以「同資料夾＋同主檔名」分組，一次可加入多個地段（例如選取含多個案件資料夾的上層資料夾）
async function loadNeighbors(files) {
  srcRec().nb.push(...files.filter(f => SRC_RE.test(f.name))); S.srcDirty = true; const groups = new Map();
  for (const f of files) {
    const m = /^(.*)\.([^.]+)$/.exec(f.name); if (!m) continue; const x = m[2].toLowerCase(); if (!/^(d11|d12|d13|d14|coa|bnp|par)$/.test(x)) continue;
    const key = nbDirOf(f) + m[1].toLowerCase(); let g = groups.get(key); if (!g) groups.set(key, g = { name: m[1], f: {} });
    if (!g.f[x]) g.f[x] = f;
  }
  const added = [], skipped = [];
  for (const g of groups.values()) {
    const mainName = (S.names.d14 || S.names.coa || '').toLowerCase(), own = (g.f.d14 || g.f.coa || {}).name;
    if (own && own.toLowerCase() === mainName) { skipped.push(g.name + '（與主要測區相同）'); continue; }
    let ds = null;
    try {
      if (g.f.d14 && g.f.d13) ds = Core.datasetFromD({ pts: Core.parseDbf(await readBuf(g.f.d14)), bnd: Core.parseDbf(await readBuf(g.f.d13)), par: g.f.d11 ? Core.parseDbf(await readBuf(g.f.d11)) : null, d12: g.f.d12 ? Core.parseDbf(await readBuf(g.f.d12)) : null, name: g.name, source: 'D14/D13 鄰段' });
      else if (g.f.coa && g.f.bnp) ds = Core.datasetFromKC({ coa: await readText(g.f.coa), bnp: await readText(g.f.bnp), par: g.f.par ? await readText(g.f.par) : null, name: g.name });
    } catch (e) { skipped.push(g.name + '（' + e.message + '）'); continue; }
    if (!ds || !ds.parcels.length) { skipped.push(g.name + '（缺 D14+D13 或 COA+BNP，或沒有宗地）'); continue; }
    const old = S.nb.findIndex(n => n.name.toLowerCase() === g.name.toLowerCase());
    const n = { name: g.name, ds, color: old >= 0 ? S.nb[old].color : NB_COLORS[S.nb.length % NB_COLORS.length], visible: true, mode: old >= 0 ? S.nb[old].mode : 'numeric', seg: Core.boundarySegments(ds) };
    if (old >= 0) S.nb[old] = n; else S.nb.push(n);
    added.push(g.name);
  }
  S.seam = null;
  if (added.length) { fit(); }
  refresh();
  const r = { added, skipped };
  msg(added.length ? `已加入鄰段：${added.join('、')}` + (skipped.length ? `；略過 ${skipped.join('、')}` : '') : '沒有可加入的鄰段' + (skipped.length ? `：${skipped.join('、')}` : '（需要 D14+D13 或 COA+BNP）'));
  return r;
}
// 鄰段繪圖快取：邊／宗地外框／圓弧預先建成 Path2D（以鄰段左下角為原點的公尺坐標），依空間分塊，只畫畫面內的塊；
// 縮小到看不清內部線時只畫外框。每一幀不再逐邊呼叫 moveTo/lineTo，也不再重算重心與範圍。
function buildNbCache(n) {
  const d = n.ds, b = Core.bounds(d), ox = b.x0, oy = b.y0, cs = Math.max(b.x1 - b.x0, b.y1 - b.y0, 1) / 8, tiles = new Map();
  const tile = (x, y) => { const k = Math.floor((x - ox) / cs) + ',' + Math.floor((y - oy) / cs); let t = tiles.get(k); if (!t) tiles.set(k, t = { edges: new Path2D(), fill: new Path2D(), x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }); return t; };
  const grow = (t, x, y) => { if (x < t.x0) t.x0 = x; if (x > t.x1) t.x1 = x; if (y < t.y0) t.y0 = y; if (y > t.y1) t.y1 = y; };
  let len = 0, ne = 0;
  for (const e of d.edges.values()) {
    if (e.arcPart) continue; const a = d.points.get(e.a), q = d.points.get(e.b), t = tile((a.x + q.x) / 2, (a.y + q.y) / 2);
    t.edges.moveTo(a.x - ox, a.y - oy); t.edges.lineTo(q.x - ox, q.y - oy); grow(t, a.x - ox, a.y - oy); grow(t, q.x - ox, q.y - oy); len += Math.hypot(a.x - q.x, a.y - q.y); ne++;
  }
  for (const ar of d.arcs ? d.arcs.values() : []) {
    const pl = Core.arcPolyline(d.points.get(ar.a), d.points.get(ar.b), d.points.get(ar.c), 16), bp = d.points.get(ar.b), t = tile(bp.x, bp.y);
    pl.forEach((p, i) => { i ? t.edges.lineTo(p.x - ox, p.y - oy) : t.edges.moveTo(p.x - ox, p.y - oy); grow(t, p.x - ox, p.y - oy); });
  }
  const labels = [];
  for (const p of d.parcels) {
    const c = Core.centroidOf(d.points, p.ids), t = tile(c.x, c.y); labels.push({ x: c.x - ox, y: c.y - oy, t: p.label });
    p.ids.forEach((id, i) => { const q = d.points.get(id); i ? t.fill.lineTo(q.x - ox, q.y - oy) : t.fill.moveTo(q.x - ox, q.y - oy); grow(t, q.x - ox, q.y - oy); }); t.fill.closePath();
  }
  const outline = new Path2D(); for (const s of n.seg.segs) { outline.moveTo(s.ax - ox, s.ay - oy); outline.lineTo(s.bx - ox, s.by - oy); }
  const bv = []; for (const id of n.seg.vids) { const p = d.points.get(id); if (p) bv.push(p.x - ox, p.y - oy); }
  return { ox, oy, tiles: [...tiles.values()], labels, outline, bv, avgEdge: ne ? len / ne : 1, cx: (b.x1 - b.x0) / 2, cy: (b.y1 - b.y0) / 2, w: b.x1 - ox, h: b.y1 - oy };
}
function drawNeighbor(n) {
  const c = n.cache || (n.cache = buildNbCache(n)), sc = S.view.s, col = n.color;
  const vx0 = toWx(0) - c.ox, vx1 = toWx(W) - c.ox, vy0 = toWy(H) - c.oy, vy1 = toWy(0) - c.oy;
  if (vx1 < 0 || vy1 < 0 || vx0 > c.w || vy0 > c.h) return;                     // 整個鄰段都在畫面外
  const detail = c.avgEdge * sc >= 3;                                            // 平均邊長不到 3 px：內部線看不清，只畫外框
  ctx.save(); ctx.setTransform(DPR * sc, 0, 0, -DPR * sc, DPR * toSx(c.ox), DPR * toSy(c.oy));
  ctx.fillStyle = col + '22'; ctx.strokeStyle = col; ctx.lineWidth = 1.2 / sc;
  for (const t of c.tiles) { if (t.x1 < vx0 || t.x0 > vx1 || t.y1 < vy0 || t.y0 > vy1) continue; ctx.fill(t.fill); if (detail) ctx.stroke(t.edges); }
  if (!detail) { ctx.lineWidth = 1.5 / sc; ctx.stroke(c.outline); }
  ctx.restore();
  if (sc > 3) { ctx.fillStyle = col; const r = sc > 8 ? 2.5 : 1.8; for (let i = 0; i < c.bv.length; i += 2) { if (c.bv[i] < vx0 || c.bv[i] > vx1 || c.bv[i + 1] < vy0 || c.bv[i + 1] > vy1) continue; ctx.fillRect(toSx(c.ox + c.bv[i]) - r, toSy(c.oy + c.bv[i + 1]) - r, r * 2, r * 2); } }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (sc > 2 && S.style.label.show) { ctx.font = `${Math.min(14, Math.max(9, sc * 1.4))}px sans-serif`; ctx.fillStyle = col; let k = 0; for (const l of c.labels) { if (l.x < vx0 || l.x > vx1 || l.y < vy0 || l.y > vy1) continue; ctx.fillText(l.t, toSx(c.ox + l.x), toSy(c.oy + l.y)); if (++k > 800) break; } }
  ctx.font = 'bold 16px sans-serif'; ctx.fillStyle = col; ctx.fillText(n.name, toSx(c.ox + c.cx), toSy(c.oy + c.cy));
}
function drawSeam() {
  const ds = S.ds; if (!ds || !S.seam) return;
  for (const nr of S.seam.neighbors) {
    const nb = S.nb.find(n => n.name === nr.name);
    for (const r of nr.points) {
      const p = ds.points.get(r.id); if (!p) continue; const sx = toSx(p.x), sy = toSy(p.y); if (sx < -10 || sy < -10 || sx > W + 10 || sy > H + 10) continue;
      ctx.strokeStyle = ctx.fillStyle = SEAM_COLOR[r.status];
      if (r.status === 'coincide') { if (S.view.s > 2) { ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, 7); ctx.lineWidth = 1.5; ctx.stroke(); } continue; }
      const tgt = nb && r.vertex_dist <= S.seam.params.snap ? nb.ds.points.get(r.vertex) : r.foot;
      if (tgt) { ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(toSx(tgt.x), toSy(tgt.y)); ctx.stroke(); }
      ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 7); ctx.stroke();
    }
    for (const r of nr.neighbor_points) if (r.status === 'missing_in_main') { ctx.strokeStyle = SEAM_COLOR.missing_in_main; ctx.lineWidth = 2; ctx.strokeRect(toSx(r.x) - 6, toSy(r.y) - 6, 12, 12); }
  }
}
function runSeam(o = {}) {
  if (!S.ds) throw new Error('請先載入主要測區'); if (!S.nb.length) throw new Error('請先加入鄰段');
  S.seam = Core.seamAnalyze(S.ds, nbArgs(), seamOpts(o)); for (const r of S.seam.neighbors) { const n = S.nb.find(q => q.name === r.name); if (n && r.shift) n.shift = r.shift; } S.seamStale = false; refresh(); return S.seam;
}
function joinSeam(o = {}) {
  if (!S.ds) throw new Error('請先載入主要測區'); if (!S.nb.length) throw new Error('請先加入鄰段');
  const j = Core.seamJoin(S.ds, nbArgs(), seamOpts(o)), first = new Map(); for (const [name, sh] of Object.entries(j.shifts)) { const n = S.nb.find(q => q.name === name); if (n) n.shift = sh; }
  for (const m of j.moves) if (!first.has(m.id)) first.set(m.id, m.from);
  const before = [...first].map(([id, f]) => [id, f.y, f.x]), after = [...first.keys()].map(id => { const p = S.ds.points.get(id); return [id, p.y, p.x]; });
  commit(before, after, '鄰段接合');
  // 數值區：補上鄰段有、本段缺的接縫點，刪掉本段多出來的（不多不少）
  const ex = Core.seamExact(S.ds, nbArgs(), seamOpts(o)); if (ex.added.length || ex.removed.length) { pushStruct(ex.delta, '鄰段接合：數值區補點／刪點'); pruneSel(); }
  const after2 = Core.seamAnalyze(S.ds, nbArgs(), seamOpts(o)), skipped = S.nb.filter(n => n.mode === 'none').map(n => n.name), pushed = j.moves.filter(m => m.type === 'push').length;
  S.seam = { ...after2, join: { before: j.before.totals, moves: j.moves, unresolved: j.unresolved, skipped, added: ex.added, removed: ex.removed, kept: ex.kept } }; S.seamStale = false; refresh();
  const t = after2.totals, parts = [`吸附 ${first.size - pushed} 點`];
  if (S.nb.some(n => n.mode === 'numeric')) parts.push(`數值區補點 ${ex.added.length}、刪點 ${ex.removed.length}` + (ex.kept.length ? `（T 字點等保留 ${ex.kept.length}）` : ''));
  if (S.nb.some(n => n.mode === 'graphic')) parts.push(`圖解區推出重疊點 ${pushed}`);
  msg(`鄰段接合：${parts.join('；')}；仍重疊 ${t.overlap}、脫開 ${t.gap}（圖解區脫開不處理）；未處理 ${j.unresolved.length}。可復原` + (skipped.length ? `；只比對：${skipped.join('、')}` : ''));
  return { before: j.before.totals, after: t, moves: j.moves, unresolved: j.unresolved, added: ex.added, removed: ex.removed, kept: ex.kept, report: S.seam };
}
function nbPanel() {
  const sgn = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(3);
  $('nbList').innerHTML = S.nb.length ? S.nb.map((n, i) => `<div class="row" style="margin:3px 0"><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${n.color}"></span><b>${esc(n.name)}</b>` +
    `<span class="muted">${n.ds.parcels.length} 宗／${n.ds.points.size} 點</span><label class="chk"><input type="checkbox" data-nb="${i}" data-k="visible"${n.visible ? ' checked' : ''}>顯示</label>` +
    `<select data-nb="${i}" data-k="mode" title="數值區：接邊界址點完全照抄鄰段（吸附、補點、刪多餘點）。圖解區：平移鄰段比形狀，只把跑進鄰段的點推回去，脫開不處理、不補點，接縫上的直線點可清除。只比對：不動">${Object.entries(NB_MODE).map(([k, v]) => `<option value="${k}"${n.mode === k ? ' selected' : ''}>${v}</option>`).join('')}</select>` +
    `<button class="btn nbfit" data-nb="${i}">縮放</button><button class="btn nbdel" data-nb="${i}">✕</button></div>`).join('') : '<span class="muted">尚未加入鄰段 — 先開主要測區，再「加入鄰段」（可一次選含多個案件資料夾的上層資料夾）</span>';
  $('seamNbList').innerHTML = S.nb.map((n, i) => `<div class="row" style="margin:2px 0"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${n.color}"></span><b>${esc(n.name)}</b><select data-nb="${i}" data-k="mode">${Object.entries(NB_MODE).map(([k, v]) => `<option value="${k}"${n.mode === k ? ' selected' : ''}>${v}</option>`).join('')}</select>` +
    (n.mode === 'graphic' && n.shift ? `<span class="muted">平移 ΔE ${n.shift.dx.toFixed(2)}、ΔN ${n.shift.dy.toFixed(2)} m</span>` : '') + '</div>').join('');
  $('btnSeamChk').disabled = $('btnSeamJoin').disabled = !S.ds || !S.nb.length; $('btnNbFit').disabled = !S.nb.length;
  const s = S.seam; $('btnSeamCsv').disabled = $('btnSeamJson').disabled = !s;
  if (!s) { $('seamSum').textContent = S.ds && S.nb.length ? '按「檢查接合」逐點檢查主區段界點與鄰段段界是否重合、重疊或脫開' : ''; $('seamTbl').innerHTML = ''; return; }
  const t = s.totals;
  $('seamSum').innerHTML = `檢查 ${t.checked} 點：<span style="color:${SEAM_COLOR.coincide}">重合 ${t.coincide}</span>／<span style="color:${SEAM_COLOR.overlap}">重疊 ${t.overlap}</span>／<span style="color:${SEAM_COLOR.gap}">脫開 ${t.gap}</span>；鄰段點主區缺 ${t.neighbor_missing_in_main}` +
    (S.seamStale ? ' <b class="neg">（點位已變動，請重新檢查）</b>' : '') + (s.join ? `<br>上次接合：移動 ${new Set(s.join.moves.map(m => m.id)).size} 點，未處理 ${s.join.unresolved.length}（超出吸附上限 ${s.join.unresolved.filter(u => u.reason === 'beyond_snap').length}、搶同一鄰段點 ${s.join.unresolved.filter(u => u.reason === 'conflict').length}）` + (s.join.added ? `；數值區補點 ${s.join.added.length}、刪點 ${s.join.removed.length}` : '') + (s.join.skipped.length ? `；只比對：${esc(s.join.skipped.join('、'))}` : '') : '');
  const showOk = $('seamShowOk').checked, rows = [];
  for (const n of s.neighbors) {
    for (const r of n.points) if (showOk || r.status !== 'coincide') rows.push({ n: n.name, t: 'p', id: r.id, st: r.status, v: r.gap_m, y: r.y, x: r.x, k: r.kind });
    for (const r of n.neighbor_points) if (r.status === 'missing_in_main') rows.push({ n: n.name, t: 'n', id: r.id, st: r.status, v: r.dist, y: r.y, x: r.x });
  }
  rows.sort((a, b) => (a.st === 'coincide') - (b.st === 'coincide') || Math.abs(b.v) - Math.abs(a.v));
  $('seamTbl').innerHTML = rows.slice(0, 300).map(r => `<tr data-y="${r.y}" data-x="${r.x}" data-id="${esc(r.id)}" data-t="${r.t}" style="cursor:pointer"><td>${esc(r.n)}</td><td>${r.t === 'n' ? '鄰段 ' : ''}${esc(r.id)}</td>` +
    `<td style="color:${SEAM_COLOR[r.st]}">${SEAM_TEXT[r.st]}${r.k === 'line' ? '(線上)' : ''}</td><td>${r.st === 'coincide' ? '—' : sgn(r.v)}</td></tr>`).join('') + (rows.length > 300 ? `<tr><td colspan="4" class="muted">只列前 300 筆，共 ${rows.length} 筆（完整內容請輸出報告）</td></tr>` : '');
}
$('btnNbAdd').onclick = () => $('nbIn').click(); $('btnNbDir').onclick = () => $('nbDir').click();
$('nbIn').onchange = e => { loadNeighbors([...e.target.files]); e.target.value = ''; }; $('nbDir').onchange = e => { loadNeighbors([...e.target.files]); e.target.value = ''; };
$('btnNbFit').onclick = () => fit();
$('nbList').addEventListener('change', e => { const i = e.target.dataset.nb; if (i == null) return; const k = e.target.dataset.k; S.nb[i][k] = k === 'mode' ? e.target.value : e.target.checked; if (k === 'mode') { S.nb[i].shift = null; S.seamStale = !!S.seam; } refresh(); });
$('seamNbList').addEventListener('change', e => { const i = e.target.dataset.nb; if (i == null) return; const k = e.target.dataset.k; S.nb[i][k] = k === 'mode' ? e.target.value : e.target.checked; if (k === 'mode') { S.nb[i].shift = null; S.seamStale = !!S.seam; } refresh(); });
$('nbList').addEventListener('click', e => {
  const i = e.target.dataset.nb; if (i == null || e.target.tagName !== 'BUTTON') return;
  if (e.target.classList.contains('nbfit')) { const b = Core.bounds(S.nb[i].ds); fit({ x0: b.x0 - 5, x1: b.x1 + 5, y0: b.y0 - 5, y1: b.y1 + 5 }); }
  else { S.nb.splice(i, 1); S.seam = null; refresh(); }
});
$('btnSeamChk').onclick = () => { try { const r = runSeam(); msg(`鄰段檢查：重合 ${r.totals.coincide}、重疊 ${r.totals.overlap}、脫開 ${r.totals.gap}`); } catch (e) { msg(e.message); } };
$('btnSeamJoin').onclick = () => { try { joinSeam(); } catch (e) { msg(e.message); } };
$('seamShowOk').onchange = refresh; $('chkSeam').onchange = draw;
$('seamTbl').addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (!tr || !tr.dataset.id) return; const y = +tr.dataset.y, x = +tr.dataset.x;
  if (tr.dataset.t === 'p') { clearSel(); S.sel.pt.add(Number.isNaN(+tr.dataset.id) ? tr.dataset.id : +tr.dataset.id); }
  fit({ x0: x - 8, x1: x + 8, y0: y - 8, y1: y + 8 }); refresh();
});
const seamName = ext => `${(S.ds && S.ds.name || 'main').replace(/\.\w+$/, '')}-seam-report.${ext}`;
$('btnSeamCsv').onclick = () => download(seamName('csv'), '﻿' + Core.seamReportCsv(S.seam), 'text/csv;charset=utf-8');
$('btnSeamJson').onclick = () => download(seamName('json'), JSON.stringify(S.seam, null, 2), 'application/json');

// ── 現況點匯入對話框 ───────────────────────────────────────────────────────
function impOpts() {
  const kind = $('impKind').value;
  if (kind === 'polar') return { kind, o: { station: { y: $('stY').value, x: $('stX').value }, backAz: $('bsAz').value.trim() || null,
    backPoint: ($('bsY').value && $('bsX').value) ? { y: $('bsY').value, x: $('bsX').value } : null, angleFmt: $('angFmt').value, slope: $('distKind').value === 'slope' } };
  return { kind, o: { order: $('xyOrder').value } };
}
function impPreview() {
  const kind = $('impKind').value, text = $('impText').value; $('xyOpts').style.display = kind === 'xy' ? '' : 'none'; $('polarOpts').style.display = kind === 'polar' ? '' : 'none';
  $('macOpts').style.display = kind === 'mac' ? '' : 'none';
  const noKnown = kind === 'mac' && !S.controls.size && !S.survey.points.size; $('impGo').disabled = noKnown;
  let t = '';
  try {
    if (kind === 'mac') {
      $('macKnown').textContent = noKnown ? '尚無已知點：MAC 是相對觀測，請先關閉本視窗，用「開啟檔案」匯入 CTL（控制點）、CT2（補點）或含 D20 的案件資料夾。' : `已知點 ${knownPoints().size} 個（控制點／補點 ${S.controls.size}，現況點 ${S.survey.points.size}）`;
      $('macKnown').className = noKnown ? 'small neg' : 'small muted';
      if (noKnown) t = '';
      else if (!text.trim()) t = '貼上 MAC 文字或選擇檔案';
      else {
        const p = macPlan(text); const miss = [...new Set(p.unresolved.flatMap(u => u.missing))];
        t = `${p.blocks.length} 個測站段，可化算 ${p.points.length} 點` + (p.checks.length ? `；後視檢核最大差 ${(p.maxCheck * 1000).toFixed(1)} mm` : '') + (p.skipped.length ? `；無法解析 ${p.skipped.length} 行` : '');
        if (miss.length) t += `。⚠ 缺少已知點：${miss.join('、')}（含這些測站／後視的段落不會化算）`;
      }
    }
    else if (!text.trim()) t = '貼上文字或選擇檔案';
    else if (kind === 'xy') { const r = Core.parsePoints(text, { order: $('xyOrder').value }); t = `可匯入 ${r.points.length} 點（座標順序：${r.order === 'NE' ? 'N,E' : 'E,N'}），無法解析 ${r.skipped.length} 行` + (r.points[0] ? `；首點 ${r.points[0].name}: N ${r.points[0].y} E ${r.points[0].x}` : ''); }
    else { const r = Core.parseObservations(text, { angleFmt: $('angFmt').value }); t = `解析 ${r.obs.length} 筆觀測，無法解析 ${r.skipped.length} 行`; }
  } catch (err) { t = String(err.message || err); }
  $('impPrev').textContent = t;
}
function openImport(text = '', fname = '', kind = null) { if (kind) $('impKind').value = kind; $('impText').value = text; $('impName').textContent = fname; impPreview(); $('impDlg').showModal(); }
$('btnImp').onclick = () => openImport();
$('impFile').onchange = async e => { const f = e.target.files[0]; if (f) { $('impText').value = await readText(f); $('impName').textContent = f.name; impPreview(); } e.target.value = ''; };
['impKind', 'impText', 'xyOrder', 'angFmt', 'stY', 'stX'].forEach(id => $(id).addEventListener('input', impPreview));
$('impGo').onclick = e => {
  e.preventDefault(); const { kind, o } = impOpts();
  try {
    if (kind === 'mac') {
      const r = importMac($('impText').value); $('impDlg').close();
      msg(`MAC：已化算 ${r.added} 個現況點` + (r.checks.length ? `，後視檢核最大差 ${(r.max_check_diff * 1000).toFixed(1)} mm` : '') + (r.unresolved.length ? `；⚠ ${r.unresolved.length} 段缺已知點未化算（${[...new Set(r.unresolved.flatMap(u => u.missing))].join('、')}）` : '')); return;
    }
    const r = importSurvey(kind, $('impText').value, o); $('impDlg').close(); msg(`已匯入 ${r.added} 個現況點` + (r.skipped.length ? `（略過 ${r.skipped.length} 行）` : '') + '。用「連線」工具(L)手動連成參考線'); }
  catch (err) { $('impPrev').textContent = '無法匯入：' + (err.message || err); }
};
$('impCancel').onclick = e => { e.preventDefault(); $('impDlg').close(); };
$('btnCtlClear').onclick = () => S.controls.size && confirm('清除全部已知點（控制點／補點）？（可復原）') && clearControls();
$('btnCtlFit').onclick = () => S.controls.size && fit(controlsBounds());
$('btnSvFit').onclick = () => S.survey.points.size && fit(surveyBounds());
$('btnSvClear').onclick = () => S.survey.points.size && confirm('清除全部現況點與參考線？（可復原）') && clearSurvey();


// ── 底圖設定 ───────────────────────────────────────────────────────────────
try { const b = JSON.parse(localStorage.getItem('cw.basemap') || 'null'); if (b && PROVIDERS[b.provider]) Object.assign(S.basemap, b); } catch (e) { /* 無儲存或被封鎖時忽略 */ }
const saveBasemap = () => { try { localStorage.setItem('cw.basemap', JSON.stringify(S.basemap)); } catch (e) { /* ignore */ } };
$('bmSel').value = S.basemap.provider; $('bmOp').value = S.basemap.opacity; $('bmCm').value = String(S.basemap.cm);
$('bmSel').onchange = () => { S.basemap.provider = $('bmSel').value; saveBasemap(); draw(); if (S.basemap.provider !== 'none') msg('底圖需連網，且只適用 TWD97 坐標（TWD67 會偏移約 800 m）'); };
$('bmOp').oninput = () => { S.basemap.opacity = parseFloat($('bmOp').value); saveBasemap(); draw(); };
$('bmCm').onchange = () => { S.basemap.cm = parseInt($('bmCm').value, 10); saveBasemap(); draw(); };

// ── 列印（A4/A3、指定比例尺、含底圖／標題欄／圖例／比例尺／指北）────────────────────────
const PAPER = { A4: [1123, 794], A3: [1587, 1123] };          // 96 dpi 的 CSS 像素；A4=297×210 mm
const STD_SCALES = [200, 250, 300, 500, 600, 1000, 1200, 2000, 2500, 3000, 5000, 10000];
const PX_PER_M_AT_1 = 96 / 0.0254;                              // 紙上 1:1 時每公尺的像素數
function allBounds() {
  let b = S.ds ? Core.bounds(S.ds) : null;
  const add = c => { b = b ? { x0: Math.min(b.x0, c.x0), x1: Math.max(b.x1, c.x1), y0: Math.min(b.y0, c.y0), y1: Math.max(b.y1, c.y1) } : c; };
  if (S.survey.points.size) add(surveyBounds()); if (S.controls.size && !S.ds) add(controlsBounds()); return b;
}
function printExtent(mode) {
  if (mode === 'screen') return { x0: toWx(0), x1: toWx(W), y0: toWy(H), y1: toWy(0) };
  if (mode === 'sel' && S.ds) {
    const ids = selCount() ? effectiveIds() : new Set(S.ds.parcels.filter(p => Math.abs(p.area - p.areaOrig) > 1e-6).flatMap(p => p.ids));
    if (ids.size) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const id of ids) { const p = S.ds.points.get(id); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); } return { x0: x0 - 3, x1: x1 + 3, y0: y0 - 3, y1: y1 + 3 }; }
  }
  return allBounds();
}
function prtOpts() {
  return { paper: $('prtPaper').value, land: $('prtOrient').value === 'land', scale: $('prtScale').value, extent: $('prtExtent').value,
    title: $('prtTitle').value, note: $('prtNote').value, basemap: $('prtBase').checked && S.basemap.provider !== 'none' };
}
function printPlan(o) {
  let [pw, ph] = PAPER[o.paper]; if (!o.land) [pw, ph] = [ph, pw];
  const M = 30, TB = 96, frame = { x: M, y: M, w: pw - 2 * M, h: ph - 2 * M - TB };
  const e = printExtent(o.extent); if (!e) return null;
  const ecx = (e.x0 + e.x1) / 2, ecy = (e.y0 + e.y1) / 2, ew = Math.max(e.x1 - e.x0, 1), eh = Math.max(e.y1 - e.y0, 1);
  let N = o.scale === 'auto' ? null : parseInt(o.scale, 10);
  if (!N) { const need = PX_PER_M_AT_1 / Math.min(frame.w * 0.96 / ew, frame.h * 0.96 / eh); N = STD_SCALES.find(v => v >= need) || Math.ceil(need / 1000) * 1000; }
  const sc = PX_PER_M_AT_1 / N, sxc = frame.x + frame.w / 2, syc = frame.y + frame.h / 2;
  return { pw, ph, frame, TB, M, N, view: { cx: ecx - (sxc - pw / 2) / sc, cy: ecy + (syc - ph / 2) / sc, s: sc } };
}
async function renderPrint(canvas, o, dpr) {
  const plan = printPlan(o); if (!plan) throw new Error('沒有可列印的內容，請先載入圖資或匯入現況點');
  const { pw, ph, frame } = plan;
  if (o.basemap) await waitTiles(tileList(plan.view, pw, ph));
  await Promise.all(S.img.filter(im => im.visible).map(ensureBitmap));
  const keep = { ctx, W, H, DPR, view: S.view, sel: S.sel, hover: S.hover, align: S.align, draft: S.draft, box: S.box, tool: S.tool, printing: S.printing, provider: S.basemap.provider };
  try {
    canvas.width = Math.round(pw * dpr); canvas.height = Math.round(ph * dpr);
    ctx = canvas.getContext('2d'); W = pw; H = ph; DPR = dpr; S.view = plan.view; S.printing = true;
    S.sel = { pt: new Set(), edge: new Set(), par: new Set() }; S.hover = null; S.align = null; S.draft = null; S.box = null; S.tool = 'select';
    if (!o.basemap) S.basemap.provider = 'none';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pw, ph);
    ctx.save(); ctx.beginPath(); ctx.rect(frame.x, frame.y, frame.w, frame.h); ctx.clip(); render(); ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); drawPrintFrame(o, plan);
  } finally { ctx = keep.ctx; W = keep.W; H = keep.H; DPR = keep.DPR; S.view = keep.view; S.sel = keep.sel; S.hover = keep.hover; S.align = keep.align; S.draft = keep.draft; S.box = keep.box; S.tool = keep.tool; S.printing = keep.printing; S.basemap.provider = keep.provider; }
  return plan;
}
function drawPrintFrame(o, plan) {
  const { frame, TB, N } = plan, sc = plan.view.s, ink = '#1d2330', ty = frame.y + frame.h;
  ctx.strokeStyle = ink; ctx.lineWidth = 1.5; ctx.strokeRect(frame.x, frame.y, frame.w, frame.h); ctx.lineWidth = 1; ctx.strokeRect(frame.x, ty, frame.w, TB);
  ctx.fillStyle = ink; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  const names = S.names.d14 || S.names.coa || (S.ds && S.ds.name) || '', d = new Date(), ds2 = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  const bx = frame.x + 10; ctx.font = 'bold 16px sans-serif'; ctx.fillText(o.title || '地籍圖調整成果圖', bx, ty + 8);
  ctx.font = '12px sans-serif'; ctx.fillText(`案件：${names.replace(/\.\w+$/, '')}　列印日期：${ds2}`, bx, ty + 32); if (o.note) ctx.fillText(o.note, bx, ty + 50);
  const changed = S.ds ? S.ds.parcels.filter(p => Math.abs(p.area - p.areaOrig) > 1e-6).length : 0;
  ctx.fillStyle = '#69718a'; ctx.fillText(`座標系統 TWD97（中央經線 ${S.basemap.cm}°E）　${S.ds ? `作業圖 ${S.ds.parcels.length} 宗` : ''}${changed ? `　面積變動 ${changed} 宗` : ''}`, bx, ty + 68);
  // 比例尺文字與圖例
  const mx = frame.x + frame.w * 0.42; ctx.fillStyle = ink; ctx.font = 'bold 15px sans-serif'; ctx.fillText(`比例尺 1:${N}`, mx, ty + 8);
  ctx.font = '11px sans-serif'; let lx = mx, ly = ty + 34;
  const item = (label, drawIcon) => { drawIcon(lx, ly + 6); ctx.fillStyle = ink; ctx.textBaseline = 'middle'; ctx.fillText(label, lx + 26, ly + 6); ctx.textBaseline = 'top'; lx += 26 + ctx.measureText(label).width + 12; };
  item('新圖', (x, y) => { ctx.strokeStyle = '#1d2330'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 20, y); ctx.stroke(); });
  if (S.ref && S.style.ref.show) item('舊圖', (x, y) => { ctx.strokeStyle = '#8a93a6'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 20, y); ctx.stroke(); ctx.setLineDash([]); });
  if (changed) item('面積變動', (x, y) => { ctx.fillStyle = 'rgba(255,160,0,.45)'; ctx.fillRect(x, y - 5, 20, 10); });
  if (changed && S.style.dfill.show) { item('面積增加', (x, y) => { ctx.fillStyle = S.style.dfill.posColor + '99'; ctx.fillRect(x, y - 5, 20, 10); }); item('面積減少', (x, y) => { ctx.fillStyle = S.style.dfill.negColor + '99'; ctx.fillRect(x, y - 5, 20, 10); }); }
  ly += 18; lx = mx;
  if (S.survey.points.size) item('現況點', (x, y) => { ctx.fillStyle = '#c2188e'; ctx.beginPath(); ctx.moveTo(x + 10, y - 5); ctx.lineTo(x + 15, y); ctx.lineTo(x + 10, y + 5); ctx.lineTo(x + 5, y); ctx.closePath(); ctx.fill(); });
  if (S.survey.lines.length) item('參考線', (x, y) => { ctx.strokeStyle = '#c2188e'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 20, y); ctx.stroke(); });
  if (S.controls.size) item('控制點', (x, y) => { ctx.fillStyle = '#1a7f37'; ctx.beginPath(); ctx.moveTo(x + 10, y - 5); ctx.lineTo(x + 15, y + 4); ctx.lineTo(x + 5, y + 4); ctx.closePath(); ctx.fill(); });
  if (o.basemap) { ctx.fillStyle = '#69718a'; ctx.font = '10px sans-serif'; ctx.textBaseline = 'top'; ctx.fillText(PROVIDERS[S.basemap.provider].attr, mx, ty + 76); }
  // 比例尺條（4 段）
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000], L = nice.filter(v => v * sc <= 150).pop() || 1, bw = L * sc, bx0 = frame.x + frame.w - bw - 70, by0 = ty + 60;
  for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#fff' : ink; ctx.fillRect(bx0 + i * bw / 4, by0, bw / 4, 6); } ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.strokeRect(bx0, by0, bw, 6);
  ctx.fillStyle = ink; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('0', bx0, by0 - 2); ctx.fillText(`${L} m`, bx0 + bw, by0 - 2); ctx.textAlign = 'left';
  // 指北針（坐標北，圖面向上）
  const nx = frame.x + frame.w - 32, ny = ty + 44; ctx.fillStyle = ink; ctx.beginPath(); ctx.moveTo(nx, ny - 26); ctx.lineTo(nx + 9, ny + 10); ctx.lineTo(nx, ny + 3); ctx.lineTo(nx - 9, ny + 10); ctx.closePath(); ctx.fill();
  ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('N', nx, ny + 12); ctx.textAlign = 'left';
}
let prtTimer = null, prtBusy = false;
async function prtPreview() {
  if (prtBusy) { clearTimeout(prtTimer); prtTimer = setTimeout(prtPreview, 300); return; } prtBusy = true;
  try {
    $('prtInfo').textContent = '產生預覽中…'; const o = prtOpts(), plan = await renderPrint($('prtCanvas'), o, 1.5);
    $('prtInfo').textContent = `${o.paper} ${o.land ? '橫式' : '直式'}，比例尺 1:${plan.N}` + (o.basemap ? `，底圖：${PROVIDERS[S.basemap.provider].name}` : '') + (S.basemap.provider !== 'none' && !o.basemap ? '（本次不含底圖）' : '');
  } catch (err) { $('prtInfo').textContent = String(err.message || err); } finally { prtBusy = false; }
}
function openPrint() {
  if (!S.ds && !S.survey.points.size && !S.controls.size) return msg('請先載入圖資');
  $('prtBase').checked = S.basemap.provider !== 'none'; $('prtBase').disabled = S.basemap.provider === 'none';
  if (!$('prtTitle').value) $('prtTitle').value = '地籍圖調整成果圖'; $('prtDlg').showModal(); prtPreview();
}
['prtPaper', 'prtOrient', 'prtScale', 'prtExtent', 'prtBase'].forEach(id => $(id).addEventListener('change', () => { clearTimeout(prtTimer); prtTimer = setTimeout(prtPreview, 150); }));
['prtTitle', 'prtNote'].forEach(id => $(id).addEventListener('input', () => { clearTimeout(prtTimer); prtTimer = setTimeout(prtPreview, 400); }));
$('btnPrint').onclick = openPrint; $('prtClose').onclick = e => { e.preventDefault(); $('prtDlg').close(); };
$('prtGo').onclick = async e => {
  e.preventDefault(); const o = prtOpts(), area = $('printArea'); area.textContent = '';
  try {
    const c = document.createElement('canvas'), plan = await renderPrint(c, o, 3); c.style.width = (plan.pw * 25.4 / 96) + 'mm'; c.style.height = (plan.ph * 25.4 / 96) + 'mm'; area.appendChild(c);
    let st = document.getElementById('pageStyle'); if (!st) { st = document.createElement('style'); st.id = 'pageStyle'; document.head.appendChild(st); }
    st.textContent = `@page{size:${o.paper} ${o.land ? 'landscape' : 'portrait'};margin:0}`;
    $('prtDlg').close(); document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); area.textContent = ''; removeEventListener('afterprint', done); }; addEventListener('afterprint', done);
    setTimeout(() => window.print(), 150);
  } catch (err) { $('prtInfo').textContent = '無法列印：' + (err.message || err); }
};
$('prtPng').onclick = async e => {
  e.preventDefault();
  try { const c = document.createElement('canvas'); await renderPrint(c, prtOpts(), 2); c.toBlob(b => { if (!b) return msg('底圖來源未開放跨網域，無法輸出 PNG；請用「列印」再選「另存為 PDF」'); download('成果圖.png', b, 'image/png'); }); }
  catch (err) { msg('無法輸出 PNG：' + (err.message || '底圖來源未開放跨網域，請改用列印另存 PDF')); }
};
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); openPrint(); } });

// ── 版本歷程（時間軸）與更新 ───────────────────────────────────────────────────
const TYPE_META = { major: '重大', minor: '新功能', patch: '修正' };
const verState = { open: new Set(), type: 'all', q: '' };
const verFilter = () => { const q = verState.q.trim().toLowerCase(); return CHANGELOG.filter(e => (verState.type === 'all' || e.type === verState.type) && (!q || (e.version + e.title + e.changes.join('')).toLowerCase().includes(q))); };
function renderTimeline() {
  const es = verFilter();
  $('verCount').textContent = `共 ${CHANGELOG.length} 版，目前 ${APP_VERSION}`;
  const all = es.length && es.every(e => verState.open.has(e.version)); $('verAll').textContent = all ? '全部收合' : '全部展開';
  $('verList').innerHTML = es.length ? es.map(e => {
    const open = verState.open.has(e.version);
    return `<li class="t-${e.type}${open ? ' open' : ''}" data-v="${esc(e.version)}"><div class="ver"><b>${esc(e.version)}</b><span>${esc(e.date)}</span></div>` +
      `<div class="axis"><span class="dot"></span></div><div class="item"><button class="head" aria-expanded="${open}"><span class="badge">${TYPE_META[e.type]}</span><span class="ttl">${esc(e.title)}</span><span class="chev">▾</span></button>` +
      (open ? `<ul>${e.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : '') + `</div></li>`;
  }).join('') : '<li style="display:block;text-align:center;padding:48px;color:var(--muted)">沒有符合的更新紀錄</li>';
}
function renderUpdate() {
  const u = S.update, b = document.querySelector('[data-act="ver"]'); b.textContent = '版本歷程與更新　' + APP_VERSION + (u ? `　↑ 有新版 ${u.tag}` : '');
  const ban = $('updBanner'); ban.hidden = !u; if (!u) return;
  ban.innerHTML = `<b>有新版本 ${esc(u.tag)}</b>${u.name ? '：' + esc(u.name) : ''}　<button class="btn primary" id="btnApplyUpd">立即更新</button> <a href="${esc(u.url)}" target="_blank" rel="noopener">發行頁面</a>` +
    (u.body ? `<div class="notes">${esc(u.body.split('---')[0].split(NL).map(l => l.replace(/^#+\s*/, '')).join(NL).trim())}</div>` : '') + `<div class="muted small" style="margin-top:4px">更新會以新版覆寫你選取的檔案（Chrome／Edge）或下載新檔；請先輸出 D14／JSON，重新開啟後才生效。</div>`;
  $('btnApplyUpd').onclick = () => applyUpdate();
}
async function checkUpdate({ silent = false, currentVersion = APP_VERSION } = {}) {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(), newer = Core.compareVersions(j.tag_name, currentVersion) > 0;
    S.update = newer ? { tag: j.tag_name, name: j.name, url: j.html_url, body: j.body || '', published: j.published_at } : null; renderUpdate();
    if (!silent) msg(newer ? `有新版本 ${j.tag_name}（目前 ${currentVersion}）` : `目前已是最新版（${currentVersion}）`);
    return { current: currentVersion, latest: j.tag_name, update_available: newer };
  } catch (e) { if (!silent) msg('無法檢查更新：' + (e.message || e) + '（需連網）'); return { error: String(e.message || e) }; }
}
async function applyUpdate() {
  const u = S.update; if (!u) return;
  if (!confirm(`更新到 ${u.tag}？` + NL + '將以新版覆寫你選取的檔案；尚未輸出的調整請先輸出 D14／JSON。')) return;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${u.tag}/product/index.html`); if (!res.ok) throw new Error('下載失敗 HTTP ' + res.status);
    const html = await res.text(); if (!html.includes(u.tag) || !html.includes('<title>地籍圖')) throw new Error('下載內容驗證失敗');
    if (window.showSaveFilePicker) {
      const h = await showSaveFilePicker({ suggestedName: decodeURIComponent(location.pathname.split('/').pop() || '') || 'index.html', types: [{ description: 'HTML 檔', accept: { 'text/html': ['.html'] } }] });
      const w = await h.createWritable(); await w.write(html); await w.close(); msg(`已寫入 ${h.name}：請重新開啟該檔（或按 Ctrl+R）以使用 ${u.tag}`);
    } else { download(`cadastral-resurvey-workstation-${u.tag}.html`, html, 'text/html'); msg('已下載新版，請用新檔取代舊檔'); }
  } catch (e) { if (e && e.name === 'AbortError') return; msg('更新失敗：' + (e.message || e)); }
}
const autoUpdOn = () => { try { return localStorage.getItem('cw.autoUpdate') !== '0'; } catch (e) { return true; } };
ACTS.ver = () => { $('chkAutoUpd').checked = autoUpdOn(); renderTimeline(); renderUpdate(); $('verDlg').showModal(); };
$('verClose').onclick = e => { e.preventDefault(); $('verDlg').close(); };
$('verQ').oninput = () => { verState.q = $('verQ').value; renderTimeline(); };
$('verTypes').onclick = e => { const t = e.target.dataset && e.target.dataset.t; if (!t) return; verState.type = t; document.querySelectorAll('#verTypes button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); renderTimeline(); };
$('verAll').onclick = () => { const es = verFilter(), all = es.every(e => verState.open.has(e.version)); es.forEach(e => (all ? verState.open.delete(e.version) : verState.open.add(e.version))); renderTimeline(); };
$('verList').onclick = e => { const li = e.target.closest('li[data-v]'); if (!li || !e.target.closest('.head')) return; const v = li.dataset.v; verState.open.has(v) ? verState.open.delete(v) : verState.open.add(v); renderTimeline(); };
$('chkAutoUpd').onchange = () => { try { localStorage.setItem('cw.autoUpdate', $('chkAutoUpd').checked ? '1' : '0'); } catch (e) { /* ignore */ } };
$('btnCheckUpd').onclick = () => checkUpdate();
renderUpdate();
if (autoUpdOn() && /^(https?|file):$/.test(location.protocol)) setTimeout(() => checkUpdate({ silent: true }), 2500);

// ── 專案資料夾一鍵讀入：依子資料夾分類（主要測區、鄰段、分幅舊圖、影像、登記資料）──────────
// 鄰段：路徑含「鄰段」；分幅舊圖：路徑含「分幅／接圖前／單幅／整幅／舊圖數值」（同一上層資料夾的各幅併成一組）；其餘含 D14＋D13 或 COA＋BNP 的資料夾中，最淺的一個是主要測區。
// 主要測區資料夾同時有 D14＋D13 與 COA＋BNP 時，COA＋BNP（數化舊圖）自動加入為分幅舊圖。
const NB_DIR = /鄰段|neighbou?r/i, BL_DIR = /分幅|接圖前|單幅|整幅|舊圖數值|sheet/i, OLDMAP_SKIP = /航照|正射|ortho|aerial|photo|衛星/i;
const isOldMapImg = im => (im.oldmap != null ? im.oldmap : !OLDMAP_SKIP.test(im.name));
async function loadProject(files) {
  const pj = files.find(f => extOf(f.name) === PROJ_EXT); if (pj && confirm(`資料夾裡有專案檔 ${pj.name}：要開啟它、接著上次的進度做嗎？\n（選「取消」＝重新讀入資料夾，從頭做）`)) { await openProjectFile(pj); return { project: pj.name }; }
  files = files.filter(f => extOf(f.name) !== PROJ_EXT); const pathOf = f => f.webkitRelativePath || f._path || f.name, dirs = new Map();
  for (const f of files) { const d = nbDirOf(f); let g = dirs.get(d); if (!g) dirs.set(d, g = { dir: d, files: [], ext: new Set() }); g.files.push(f); const m = /\.([^.]+)$/.exec(f.name); if (m) g.ext.add(m[1].toLowerCase()); }
  const isData = g => (g.ext.has('d14') && g.ext.has('d13')) || (g.ext.has('coa') && g.ext.has('bnp'));
  const data = [...dirs.values()].filter(isData), nbs = data.filter(g => NB_DIR.test(g.dir)), bls = data.filter(g => !NB_DIR.test(g.dir) && BL_DIR.test(g.dir)), rest = data.filter(g => !nbs.includes(g) && !bls.includes(g));
  if (data.length <= 1 && !nbs.length && !bls.length) { const ok = await loadFiles(files); if (ok && data[0]) await autoBaseline(data[0]); return { main: data[0] ? data[0].dir || '（所選檔案）' : null, neighbors: [], baselines: S.bl.sets.map(s => s.name), images: S.img.length }; }
  const depth = g => g.dir.split('/').length;
  rest.sort((a, b) => depth(a) - depth(b) || a.dir.localeCompare(b.dir));
  if (!rest.length) throw new Error('找不到主要測區（含 D14＋D13 或 COA＋BNP、且路徑不含「鄰段」「分幅」的資料夾）');
  if (rest.length > 1 && depth(rest[0]) === depth(rest[1])) throw new Error(`有 ${rest.length} 個資料夾都像主要測區（${rest.slice(0, 4).map(g => g.dir || '／').join('、')}）：請把鄰段放在名稱含「鄰段」的資料夾、分幅舊圖放在含「分幅」的資料夾，或改用下方個別按鈕`);
  const main = rest[0], inMain = f => pathOf(f).startsWith(main.dir) && !data.some(g => g !== main && g.dir.startsWith(main.dir) && pathOf(f).startsWith(g.dir));
  const extra = files.filter(f => !inMain(f) && /\.(mdb|ctl|ct2|cen|l02)$/i.test(f.name));
  if (!await loadFiles(files.filter(inMain).concat(extra))) return null;
  await autoBaseline(main);
  const imgs = files.filter(f => !inMain(f) && /\.(jpe?g|png|jgw|jpgw|pgw|wld)$/i.test(f.name)); if (imgs.length) await loadImages(imgs);
  if (!S.img.some(im => im.visible)) { const im = S.img.find(q => q.located && isOldMapImg(q)); if (im) { im.opacity = 0.8; setImgVisible(im, true); } }   // 顯示第一張舊圖，方便對照
  if (nbs.length) await loadNeighbors(nbs.flatMap(g => g.files));
  { const byParent = new Map(); for (const g of bls) { const par = g.dir.replace(/[^/]*\/$/, ''); (byParent.get(par) || byParent.set(par, []).get(par)).push(g); }   // 同一個上層資料夾（例如「單幅」）底下的各幅併成一組：各幅一起擬合、接合線才認得
    for (const list of byParent.values()) await loadBaseline(list.flatMap(g => g.files)); }
  const out = { main: main.dir.replace(/\/$/, '') || '／', neighbors: S.nb.map(n => n.name), baselines: S.bl.sets.map(s => s.name), images: S.img.length, oldmap_images: S.img.filter(isOldMapImg).length, ignored: rest.slice(1).map(g => g.dir) };
  msg(`專案已讀入：主要測區 ${out.main}；鄰段 ${out.neighbors.length}；分幅舊圖 ${out.baselines.length} 組；影像 ${out.images} 張（舊圖 ${out.oldmap_images}）` + (out.ignored.length ? `；略過 ${out.ignored.length} 個資料夾` : ''));
  refresh(); return out;
}
async function autoBaseline(g) {   // 案件資料夾內的 COA＋BNP（數化舊圖）當作分幅舊圖
  if (!(g.ext.has('d14') && g.ext.has('d13') && g.ext.has('coa') && g.ext.has('bnp'))) return;
  const fs = g.files.filter(f => /\.(coa|bnp|par)$/i.test(f.name)); if (S.bl.sets.some(s => s.auto)) return;
  const r = await loadBaseline(fs); if (r && r.added) { const s = S.bl.sets[S.bl.sets.length - 1]; s.auto = true; s.name += '（案件資料夾內 COA／BNP）'; }
}

// ── 檢核：原分幅向量圖（Core.shapeCheck）與舊圖影像（Core.inkPlan／inkBlock／inkResult）──────────
S.chk = { res: null, focus: null, ok: new Set(), running: false };
const chkOpts = () => { const v = (id, d) => { const x = parseFloat($(id).value); return Number.isFinite(x) && x > 0 ? x : d; }; return { tol: v('chkTol', 1), inkTol: v('chkInkTol', 0.6), shift: v('chkShift', 5), redInk: $('chkRed').value }; };
const chkImages = () => S.img.filter(im => im.located && isOldMapImg(im));
function imgRegion(im, bmp, cv2, x0, y0, x1, y1) {
  const wf = im.wf, det = wf.a * wf.e - wf.b * wf.d, P = (x, y) => { const X = x - wf.c, Y = y - wf.f; return [(wf.e * X - wf.b * Y) / det, (-wf.d * X + wf.a * Y) / det]; };
  const cs = [P(x0, y0), P(x1, y0), P(x0, y1), P(x1, y1)], us = cs.map(c => c[0]), vs = cs.map(c => c[1]);
  const u0 = Math.max(0, Math.floor(Math.min(...us))), u1 = Math.min(im.w, Math.ceil(Math.max(...us)) + 1), v0 = Math.max(0, Math.floor(Math.min(...vs))), v1 = Math.min(im.h, Math.ceil(Math.max(...vs)) + 1);
  if (u1 - u0 < 8 || v1 - v0 < 8) return null;
  const w = u1 - u0, h = v1 - v0; cv2.width = w; cv2.height = h; const g = cv2.getContext('2d', { willReadFrequently: true }); g.clearRect(0, 0, w, h); g.drawImage(bmp, u0, v0, w, h, 0, 0, w, h);
  return { rgba: g.getImageData(0, 0, w, h).data, w, h, wf: { ...wf, c: wf.c + wf.a * u0 + wf.b * v0, f: wf.f + wf.d * u0 + wf.e * v0 } };
}
async function runCheck(o = {}) {
  if (!S.ds) throw new Error('請先載入作業圖'); if (S.chk.running) throw new Error('檢核進行中');
  const op = { ...chkOpts(), ...o }, imgs = (o.images ? S.img.filter(im => o.images.includes(im.name)) : chkImages()).filter(im => im.located);
  if (!S.bl.sets.length && !imgs.length) throw new Error('沒有比對來源：請在步驟 1 載入分幅舊圖（COA／BNP 或 D 檔）或舊圖影像（JPG＋JGW）');
  S.chk.running = true; $('btnChkRun').disabled = true; const t0 = performance.now(); let shape = null, ink = null, inkErr = '';
  try {
    if (S.bl.sets.length) { msg('分幅舊圖向量比對中…'); await new Promise(r => setTimeout(r, 0)); blRun(); shape = Core.shapeCheck(S.ds, S.bl.sets.map(s => s.ds), { tol: op.tol }); }
    if (imgs.length) {
      const plan = Core.inkPlan(S.ds, { tol: op.inkTol, shift: op.shift, redInk: op.redInk }), cv2 = document.createElement('canvas'), bmps = new Map(), tick = yielder('影像墨線檢核', plan.blocks.length);
      try {
        for (const [k, b] of plan.blocks.entries()) {
          await tick(k); const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
          const im = imgs.slice().reverse().find(q => { const bb = imgBox(q); return cx >= bb.x0 && cx <= bb.x1 && cy >= bb.y0 && cy <= bb.y1; });
          if (!im) { Core.inkBlock(plan, b, null); continue; }
          let bmp = im.bmp || bmps.get(im); if (!bmp) { bmp = await createImageBitmap(im.file, { imageOrientation: 'none' }).catch(() => createImageBitmap(im.file)); bmps.set(im, bmp); }
          Core.inkBlock(plan, b, imgRegion(im, bmp, cv2, b.wx0, b.wy0, b.wx1, b.wy1));
        }
      } catch (e) { inkErr = e.message; } finally { for (const b of bmps.values()) b.close && b.close(); }
      if (!inkErr) ink = Core.inkResult(S.ds, plan);
    }
    S.chk.res = { shape, ink, inkErr, rows: Core.oldMapReport(shape, ink), bl: S.bl.res, images: imgs.map(im => im.name), sets: S.bl.sets.map(s => s.name), ms: performance.now() - t0, opt: op };
    for (const r of S.chk.res.rows) r.fix = sliverFix(r);
    S.chk.focus = null; S.chk.ok.clear();
  } finally { S.chk.running = false; $('btnChkRun').disabled = false; }
  chkPanel(); projDirty(); refresh();
  const c = chkCounts(); msg(`檢核完成：紅 ${c.red}、黃 ${c.yellow}、碎片 ${c.sliver}` + (inkErr ? `；影像無法讀取：${inkErr}` : '') + `（${(S.chk.res.ms / 1000).toFixed(1)} 秒）`);
  return S.chk.res;
}
const chkCounts = () => { const rows = S.chk.res ? S.chk.res.rows : []; return { red: rows.filter(r => r.level === 'red').length, yellow: rows.filter(r => r.level === 'yellow').length, sliver: rows.filter(r => r.sliver).length, total: rows.length }; };
// 碎片（面積 < 30 m²）的建議：併入相鄰宗地——共用界線中「舊圖上沒有」（影像沒墨線或離舊圖界線遠）最長的那一宗；沒有判斷依據時取共用界線最長者
function sliverFix(r) {
  if (!r.sliver) return null; const ds = S.ds, p = ds.parcels[r.idx]; if (!p || p.deleted || (p.holes || []).length || (p.containers || []).length) return null;
  const bad = new Map(), share = new Map(), offKeys = new Set([...(r.img ? r.img.offEdges : []), ...(r.vec ? r.vec.offEdges : [])]);
  for (let i = 0; i < p.ids.length; i++) { const a = p.ids[i], b = p.ids[(i + 1) % p.ids.length], k = a < b ? a + '-' + b : b + '-' + a, e = ds.edges.get(k); if (!e) continue; const A = ds.points.get(a), B = ds.points.get(b), len = Math.hypot(A.x - B.x, A.y - B.y);
    for (const j of e.parcels) { if (j === r.idx || ds.parcels[j].deleted) continue; share.set(j, (share.get(j) || 0) + len); if (offKeys.has(k)) bad.set(j, (bad.get(j) || 0) + len); } }
  const pick = m => [...m].sort((u, v) => v[1] - u[1])[0];
  const best = pick(bad) || pick(share); if (!best) return null;
  const q = ds.parcels[best[0]]; return { into: q.idx, label: q.label, why: bad.size ? '共用界線舊圖上沒有' : '共用界線最長' };
}
function applySliverFix(r) {
  const f = r.fix; if (!f) throw new Error(`${r.label} 沒有可用的建議`);
  const res = Core.mergeParcels(S.ds, [r.idx, f.into], f.into); pushStruct(res.delta, `碎片 ${r.label} 併入 ${f.label}`);
  S.chk.ok.add(r.label); msg(`已把 ${r.label} 併入 ${res.keep}（可復原）；建議重新檢核`); chkPanel(); refresh(); return { keep: res.keep, merged: res.merged };
}
// 第 6 步一鍵修正（v0.25.0）：① 遺漏地號依接圖前界址從未登記地切回 ② 較差為負且「接圖後產生」者，依接圖前界址從相鄰未登記地補回（登記地不動）
// ③ 碎片併入建議的鄰宗。全部一次復原；修完重新檢核並輸出報告（只列較差為負）。「接圖前即不符」的負較差接圖前就不對，不自動修，留在報告人工判斷
async function fixOldMap({ report = true } = {}) {
  if (!S.ds) throw new Error('請先載入作業圖'); if (!S.bl.res && !S.chk.res) await runCheck();
  const deltas = [], done = { missing: [], shortfall: [], sliver: [] }, failed = [];
  if (S.bl.res) {
    for (const m of S.bl.res.missing) { try { const x = Core.restoreMissing(S.ds, m); deltas.push(x.delta); done.missing.push(`${x.label}（${x.area.toFixed(1)} m²）`); } catch (e) { failed.push(`${m.label}：${e.message}`); } }
    for (const x of S.bl.res.flagged.filter(x => x.diff < 0 && x.cause === '接圖後產生')) { try { const r = Core.restoreShortfall(S.ds, x); deltas.push(r.delta); done.shortfall.push(`${x.label} +${r.gain.toFixed(1)} m²（取自 ${r.from.map(f => f.label).join('、')}）`); } catch (e) { failed.push(`${x.label}：${e.message}`); } }
  }
  if (S.chk.res) for (const x of S.chk.res.rows.filter(r => r.fix && !S.chk.ok.has(r.label))) {
    const p = S.ds.parcels[x.idx], q = S.ds.parcels[x.fix.into]; if (!p || p.deleted || !q || q.deleted) continue;
    try { const r = Core.mergeParcels(S.ds, [x.idx, x.fix.into], x.fix.into); deltas.push(r.delta); done.sliver.push(`${x.label}→${r.keep}`); } catch (e) { failed.push(`${x.label}：${e.message}`); } }
  pushMulti(deltas, '舊圖檢核一鍵修正');
  const left = S.bl.res ? S.bl.res.flagged.filter(x => x.diff < 0 && x.cause !== '接圖後產生').map(x => x.label) : [];
  await runCheck();
  const text = `遺漏切回 ${done.missing.length}、面積不足補回 ${done.shortfall.length}、碎片併入 ${done.sliver.length}` + (failed.length ? `；未修 ${failed.length}` : '') + (left.length ? `；接圖前即不符、需人工判斷 ${left.length}（${left.slice(0, 6).join('、')}）` : '');
  msg(`一鍵修正：${text}。可一次復原` + (report ? '；已輸出報告（只列較差為負）' : ''));
  if (report) download(caseBase() + '_比對報告_較差為負.html', reportHtml(true), 'text/html;charset=utf-8');
  return { text, done, failed, manual: left };
}
$('btnChkFix').onclick = () => { if (confirm('一鍵修正：遺漏地號依接圖前界址切回、較差為負且接圖後產生者依接圖前界址從相鄰未登記地補回（登記地不動）、碎片併入建議的鄰宗。可一次復原。修完重新檢核並輸出報告（只列較差為負）。繼續？')) fixOldMap().catch(e => msg(e.message)); };
const LV = { red: ['#d1242f', '紅'], yellow: ['#b7791f', '黃'], '': ['#6741d9', '碎片'] };
function chkPanel() {
  const im = S.img.filter(q => q.located);
  $('chkSrc').innerHTML = `<div>分幅舊圖：${S.bl.sets.length ? S.bl.sets.map(s => `<b>${esc(s.name)}</b>`).join('、') : '<span class="muted">尚未載入（步驟 1「分幅舊圖」）</span>'}</div>` +
    `<div style="margin-top:4px">舊圖影像（勾選的用來比對墨線）：${im.length ? im.map(q => `<label class="chk" style="margin-right:8px"><input type="checkbox" data-chkimg="${esc(q.name)}"${isOldMapImg(q) ? ' checked' : ''}>${esc(q.name)}</label>`).join('') : '<span class="muted">尚未載入（步驟 1「舊圖影像」，需要 JGW 定位檔）</span>'}</div>`;
  const r = S.chk.res; $('btnChkCsv').disabled = $('btnChkHtml').disabled = !r; $('btnChkFix').disabled = !S.ds;
  if (!r) { $('chkSum').textContent = S.ds ? '按「開始檢核」' : '請先載入作業圖'; $('chkList').innerHTML = ''; return; }
  const c = chkCounts(), sh = r.shape, ik = r.ink, bl = r.bl;
  $('chkSum').innerHTML = `<b style="color:#d1242f">紅 ${c.red}</b>　<b style="color:#b7791f">黃 ${c.yellow}</b>　<span style="color:#6741d9">碎片 ${c.sliver}</span>　<span class="muted">共 ${c.total} 宗待確認</span>` +
    (sh ? `<div class="muted">向量：舊圖界線 ${sh.refSegs} 段；${Core.alignText(sh.fit)}</div>` : '') +
    (ik ? `<div class="muted">影像：${ik.covered}/${ik.blocks} 個 ${ik.opt.block} m 方格可比對，自動平移中位數 ${ik.shiftMedian.toFixed(2)} m；沒有墨線的界址線 ${ik.offLen.toFixed(0)} / ${ik.checkedLen.toFixed(0)} m` + (ik.poor ? `；<b>${ik.poor}</b> 格影像對不上（偏移超過 ${ik.opt.shift} m、空白或不是同一張圖），未判斷，圖上灰框` : '') + '</div>' : r.inkErr ? `<div class="neg">影像無法讀取：${esc(r.inkErr)}</div>` : '') +
    (bl ? `<div style="margin-top:4px">接圖前比對：<b class="${bl.missing.length ? 'neg' : ''}">遺漏 ${bl.missing.length}</b>、面積超過 ${bl.opt.ratio} 倍公差 ${bl.flagged.length} <button class="btn" data-act="bl">詳細與一鍵修復 →</button></div>` : '');
  const n = v => (v == null ? '' : v.toFixed(0));
  $('chkList').innerHTML = `<table><thead><tr><th>地號</th><th>等級</th><th title="界址線離分幅舊圖界線超過容差（m）">離舊圖線</th><th title="舊圖界線穿過宗地內部（m）">內部舊圖線</th><th title="影像上沒有墨線的界址線（m）／檢查長度">無墨線</th><th>建議</th></tr></thead><tbody>` +
    r.rows.map((x, i) => { const [col, txt] = LV[x.level]; const done = S.chk.ok.has(x.label);
      return `<tr data-chk="${i}" style="cursor:pointer${done ? ';opacity:.45' : ''}"><td><b>${esc(x.label)}</b>${x.sliver ? `<div class="muted">${x.area.toFixed(1)} m²</div>` : ''}</td><td style="color:${col}">${txt}${x.sliver && x.level ? '・碎片' : ''}</td>` +
        `<td>${x.vec ? n(x.vec.offLen) : ''}</td><td>${x.vec ? n(x.vec.innerLen) : ''}</td><td>${x.img ? `${n(x.img.offLen)}/${n(x.img.checked)}` : ''}</td>` +
        `<td class="small" style="text-align:left;white-space:normal">${x.fix && !done ? `<button class="btn" data-chkfix="${i}" title="${esc(x.fix.why)}；可復原">併入 ${esc(x.fix.label)}</button>` : ''}<button class="btn" data-chkok="${i}" title="人工確認後標記，不影響資料">${done ? '取消確認' : '已確認'}</button></td></tr>`; }).join('') + '</tbody></table>';
}
function chkFocus(i) {
  const x = S.chk.res.rows[i]; S.chk.focus = x; clearSel(); S.sel.par.add(x.idx); zoomTo([x.idx]); refresh();
  const parts = []; if (x.vec) parts.push(`離舊圖線 ${x.vec.offLen.toFixed(1)} m、內部舊圖線 ${x.vec.innerLen.toFixed(1)} m（局部平移 ${Math.hypot(x.vec.shift.dx, x.vec.shift.dy).toFixed(2)} m）`); if (x.img) parts.push(`影像無墨線 ${x.img.offLen.toFixed(1)} / ${x.img.checked.toFixed(1)} m` + (x.img.redLen ? `（落在紅線上 ${x.img.redLen.toFixed(1)} m，不檢核）` : ''));
  msg(`${x.label}（${x.area.toFixed(1)} m²）：` + parts.join('；') + (x.fix ? `；建議併入 ${x.fix.label}` : ''));
}
function drawCheck() {
  const r = S.chk.res; if (!r) return; ctx.save(); ctx.lineCap = 'round';
  const seg = (list, color, w, dash) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.beginPath(); for (const [a, b] of list) { ctx.moveTo(toSx(a.x), toSy(a.y)); ctx.lineTo(toSx(b.x), toSy(b.y)); } ctx.stroke(); };
  if (r.ink && r.ink.poorBoxes.length) { ctx.strokeStyle = 'rgba(105,113,138,.7)'; ctx.fillStyle = 'rgba(105,113,138,.08)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); for (const b of r.ink.poorBoxes) { const x = toSx(b.x0), y = toSy(b.y1), w = (b.x1 - b.x0) * S.view.s, h = (b.y1 - b.y0) * S.view.s; ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); } ctx.setLineDash([]); }
  for (const x of r.rows) { if (S.chk.ok.has(x.label)) continue; const f = x === S.chk.focus ? 2 : 1;
    if (x.img) seg(x.img.offSegs, 'rgba(209,36,47,.75)', 5 * f); if (x.vec) { seg(x.vec.offSegs, '#ae3ec9', 2.5 * f); seg(x.vec.innerSegs, '#1c7ed6', 2.5 * f, [7, 5]); } }
  ctx.setLineDash([]);
  if (S.view.s > 0.3) { ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const x of r.rows) { if (S.chk.ok.has(x.label)) continue; const p = S.ds.parcels[x.idx]; if (!p || p.deleted) continue; const c = Core.centroidOf(S.ds.points, p.ids); ctx.fillStyle = LV[x.level][0]; ctx.fillText(x.label, toSx(c.x), toSy(c.y)); } }
  ctx.restore();
}
function chkCsv() {
  const r = S.chk.res, q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)), f = (v, d = 1) => (v == null ? '' : v.toFixed(d));
  const out = [['地號', '面積㎡', '等級', '碎片', '離舊圖線m', '內部舊圖線m', '最大偏離m', '局部平移m', '影像無墨線m', '影像檢查長度m', '建議', '已確認'].join(',')];
  for (const x of r.rows) out.push([x.label, f(x.area, 2), LV[x.level][1], x.sliver ? '是' : '', x.vec && f(x.vec.offLen), x.vec && f(x.vec.innerLen), x.vec && f(x.vec.maxDev, 2), x.vec && f(Math.hypot(x.vec.shift.dx, x.vec.shift.dy), 2), x.img && f(x.img.offLen), x.img && f(x.img.checked), x.fix ? `併入 ${x.fix.label}` : '', S.chk.ok.has(x.label) ? '是' : ''].map(q).join(','));
  return out.join('\r\n') + '\r\n';
}
$('btnChkRun').onclick = () => runCheck().catch(e => msg(e.message));
$('btnChkCsv').onclick = () => download(caseBase() + '_舊圖檢核.csv', '﻿' + chkCsv(), 'text/csv;charset=utf-8');
$('chkMap').onchange = draw;
$('chkSrc').addEventListener('change', e => { const n = e.target.dataset.chkimg; if (n == null) return; const im = S.img.find(q => q.name === n); if (im) im.oldmap = e.target.checked; });
$('chkList').addEventListener('click', e => {
  const fx = e.target.closest('[data-chkfix]'); if (fx) { try { applySliverFix(S.chk.res.rows[+fx.dataset.chkfix]); } catch (err) { msg(err.message); } return; }
  const ok = e.target.closest('[data-chkok]'); if (ok) { const x = S.chk.res.rows[+ok.dataset.chkok]; S.chk.ok.has(x.label) ? S.chk.ok.delete(x.label) : S.chk.ok.add(x.label); chkPanel(); projDirty(); refresh(); return; }
  const tr = e.target.closest('tr[data-chk]'); if (tr) chkFocus(+tr.dataset.chk);
});
$('dlgChk').addEventListener('close', () => { S.chk.focus = null; draw(); });

// ── 作業流程（給人操作的一鍵步驟）：每步一個主要按鈕、狀態與結果；細項設定仍在原本的面板。AI 由 CadastralAPI.runStep 呼叫同一組函式 ──
S.wf = {};   // 各步驟最後一次的結果 { n: { ok, text } }
const sheetPieces = () => (S.ds ? S.ds.parcels.filter(p => { if (p.deleted) return false; const no = Core.parcelNo(p); return no && no.m < 9000 && no.c >= 1000; }).length : 0);
const STEPS = [
  { n: 1, title: '讀檔', desc: '專案資料夾（案件 D 檔、舊圖影像、分幅舊圖、鄰段、EXAM.MDB）',
    status: () => S.ds ? { st: 'done', text: `作業圖 ${S.ds.parcels.filter(p => !p.deleted).length} 宗；影像 ${S.img.length}（舊圖 ${chkImages().length}）；分幅舊圖 ${S.bl.sets.length} 組；鄰段 ${S.nb.length}${S.owner ? '；登記資料 ✓' : ''}` } : { st: 'todo', text: '尚未載入' } },
  { n: 2, title: '自動接圖', desc: '先加入分幅線（分幅舊圖各幅的接合處），待修清單優先排分幅線附近的地號；依分幅線自動接圖開發中', run: async () => sheetRun(),
    status: () => { if (!S.ds) return { st: 'todo', text: '' }; const w = S.wf[2], pc = sheetPieces(), sh = S.sheet ? sheetText() : '';
      if (pc) return { st: 'warn', text: `偵測到 ${pc} 塊分幅塊（子號 ≥ 1000）：這張圖還沒接圖。自動接圖尚未提供，請先用 NECEXE 接圖後再載入` + (sh ? '\n' + sh : '') };
      if (S.sheet) return { st: 'done', text: sh }; if (w && !w.ok) return { st: 'err', text: w.text };
      return { st: 'na', text: S.bl.sets.some(s => s.ds.length > 1) ? '已接圖；按「一鍵執行」加入分幅線' : '已接圖（沒有分幅塊）。要加入分幅線，請在步驟 1 載入兩幅以上的分幅舊圖' }; } },
  { n: 3, title: '鄰段接合', desc: '數值區鄰段：界址點完全照抄；圖解區鄰段：平移比形狀，只防重疊', adv: 'seam', needNb: true,
    run: async () => { runSeam(); const r = joinSeam(); return `移動 ${r.moves.length ? new Set(r.moves.map(m => m.id)).size : 0} 點、補點 ${r.added.length}、刪點 ${r.removed.length}；仍重疊 ${r.after.overlap}、脫開 ${r.after.gap} 點`; } },
  { n: 4, title: '未登記土地合併分割', desc: '與鄰段的空隙建新地號 → 相連的未登記地合併 → 依點數與長寬比分割', adv: 'unreg',
    confirm: () => { unregPanel(); const r = S.unreg; return `未登記地目前 ${r.parcels.length} 筆。將：與鄰段的空隙建新地號 → 相連的未登記地各併成一筆 → 再切成每筆 ≤ ${unN()} 點、長寬比 ≤ ${unRatio() || '不限'}、每塊 ≥ ${unMin()} m²，小於 ${unMin()} m² 的碎塊併入相鄰未登記地（設定在「詳細設定…」）。\n已經合併分割過的圖會整批重新切，筆數可能大增。可一次一步復原。繼續？`; },
    run: async () => { const t = [], cnt = () => S.ds.parcels.filter(p => !p.deleted && (Core.parcelNo(p) || { m: 0 }).m >= 9000).length, n0 = cnt(); unregPanel();
      if (S.nb.length) { S.sgaps = Core.seamGaps(S.ds, nbArgs()); const g = fillAllGaps(false), sk = (S.sgaps && S.sgaps.skipped || []).length; t.push(`空隙建新地號 ${g.made}` + (sk ? `（另 ${sk} 處會蓋到宗地，未建）` : '')); }
      S.unSel.clear(); unregPanel(); const m = await unregMerge(false); t.push(`合併 ${m ? m.merged : 0} 組`);
      unregPanel(); const s = await unregSplit(); t.push(`分割 ${s ? s.split : 0} 筆`); t.push(`未登記地 ${n0} → ${cnt()} 筆`); return t.join('；'); } },
  { n: 5, title: '去除雜點', desc: '沒有宗地使用的點、直線上的多餘點（鄰段接縫點保留）', adv: 'clean',
    run: async () => { const r = api.cleanupPoints({ unused: $('clUnused').checked, collinear: $('clCol').checked, ratio_permille: parseFloat($('clRatio').value) || 0, max_abs_m: parseFloat($('clCap').value) || 0, seam: $('clSeam').checked }); return `刪除未使用點 ${r.unused.length}、直線多餘點 ${r.collinear.length}` + (r.added.length ? `；接縫補點 ${r.added.length}` : ''); } },
  { n: 6, title: '檢核原分幅向量圖及影像圖', desc: '每宗對照分幅舊圖向量與舊圖掃描影像，標出形狀跑掉、多畫或少分的宗地', adv: 'chk',
    run: async () => { msSave('步驟 6 檢核時', true); await runCheck(); openPanel('dlgChk'); const c = chkCounts(); return `紅 ${c.red}、黃 ${c.yellow}、碎片 ${c.sliver}`; },
    fix: async () => { msSave('步驟 6 一鍵修正前', true); const r = await fixOldMap(); openPanel('dlgChk'); return r.text; } },
];
const ST_CHIP = { done: ['已完成', 'var(--ok)'], todo: ['未執行', 'var(--muted)'], warn: ['需處理', '#b7791f'], na: ['略過', 'var(--muted)'], err: ['失敗', 'var(--bad)'] };
function stepStatus(s) {
  if (s.status) return s.status();
  if (!S.ds) return { st: 'todo', text: '' };
  if (s.needNb && !S.nb.length) return { st: 'na', text: '沒有鄰段（步驟 1 可加入）' };
  const w = S.wf[s.n]; return w ? { st: w.ok ? 'done' : 'err', text: w.text } : { st: 'todo', text: '' };
}
function wfRender() {
  $('steps').innerHTML = STEPS.map(s => `<li class="step" data-step="${s.n}"><div class="sh"><span class="sn">${s.n}</span><b>${s.title}</b><span class="chip" id="wfChip${s.n}"></span></div><div class="sd">${s.desc}</div>` +
    (s.n === 1 ? `<div class="row"><button class="btn primary" id="wfProj">開啟專案資料夾</button></div><div class="row small" style="margin-top:4px"><button class="btn" data-act="open" title="個別選 D 檔或 COA／BNP">案件檔案</button><button class="btn" id="wfImg" title="JPG／PNG＋JGW">舊圖影像</button><button class="btn" id="wfBl" title="分幅數化舊圖：COA／BNP 或 D 檔資料夾">分幅舊圖</button><button class="btn" id="wfNb">鄰段</button><button class="btn" id="wfMdb">EXAM.MDB</button></div>`
      : s.run ? `<div class="row"><button class="btn primary" data-wfrun="${s.n}">一鍵執行</button>${s.fix ? `<button class="btn" data-wffix="${s.n}" title="遺漏切回、較差為負補回、碎片併入，修完重新檢核並輸出報告（只列較差為負）">一鍵修正並出報告</button>` : ''}${s.adv ? `<button class="btn" data-act="${s.adv}">詳細設定…</button>` : ''}</div>` : '') +
    `<div class="sr small" id="wfRes${s.n}"></div></li>`).join('');
  $('wfProj').onclick = () => $('projDir').click(); $('wfImg').onclick = () => $('imgIn').click(); $('wfBl').onclick = () => $('blDir').click(); $('wfNb').onclick = () => $('nbDir').click(); $('wfMdb').onclick = () => $('ownIn').click();
}
function wfPanel() {
  for (const s of STEPS) { const r = stepStatus(s), [t, c] = ST_CHIP[r.st]; const chip = $('wfChip' + s.n); chip.textContent = t; chip.style.color = c; chip.style.borderColor = c; $('wfRes' + s.n).textContent = r.text || '';
    const b = document.querySelector(`[data-wfrun="${s.n}"]`); if (b) b.disabled = !S.ds || S.wfBusy || (s.needNb && !S.nb.length); const f = document.querySelector(`[data-wffix="${s.n}"]`); if (f) f.disabled = !S.ds || S.wfBusy; }
  $('wfRunAll').disabled = !S.ds || !!S.wfBusy;
}
async function runStep(n, o = {}) {
  const s = STEPS.find(x => x.n === +n); if (!s) throw new Error('沒有步驟 ' + n); if (!s.run) throw new Error(`步驟 ${n}（${s.title}）沒有一鍵執行`);
  if (!S.ds) throw new Error('請先完成步驟 1（讀檔）'); if (s.needNb && !S.nb.length) { S.wf[n] = { ok: true, text: '沒有鄰段，略過' }; return S.wf[n]; }
  S.wfBusy = true; wfPanel();
  try { const text = await s.run(o); S.wf[n] = { ok: true, text }; }
  catch (e) { S.wf[n] = { ok: false, text: e.message }; throw e; }
  finally { S.wfBusy = false; projDirty(); refresh(); }
  return S.wf[n];
}
async function runSteps(from = 3, to = 6) {
  const out = []; for (const s of STEPS) { if (!s.run || s.n < from || s.n > to) continue; try { out.push({ step: s.n, ...(await runStep(s.n)) }); } catch (e) { out.push({ step: s.n, ok: false, text: e.message }); msg(`步驟 ${s.n} 失敗：${e.message}（之後的步驟未執行）`); break; } }
  return out;
}
wfRender();
$('steps').addEventListener('click', e => { const fx = e.target.closest('[data-wffix]'); if (fx && !fx.disabled) { const st = STEPS.find(x => x.n === +fx.dataset.wffix); if (confirm('一鍵修正：遺漏地號切回、較差為負且接圖後產生者從相鄰未登記地補回（登記地不動）、碎片併入鄰宗；修完重新檢核並輸出報告（只列較差為負）。可一次復原。繼續？')) { S.wfBusy = true; wfPanel(); st.fix().then(t => { S.wf[st.n] = { ok: true, text: t }; }, err => { S.wf[st.n] = { ok: false, text: err.message }; msg(err.message); }).finally(() => { S.wfBusy = false; refresh(); }); } return; }
  const b = e.target.closest('[data-wfrun]'); if (!b || b.disabled) return; const st = STEPS.find(x => x.n === +b.dataset.wfrun); if (st.confirm && S.ds && !confirm(st.confirm())) return; if (b) runStep(+b.dataset.wfrun).then(r => msg(`步驟 ${b.dataset.wfrun}：${r.text}`), err => msg(`步驟 ${b.dataset.wfrun} 失敗：${err.message}`)); });
$('wfRunAll').onclick = () => { if (confirm('依序執行步驟 3～6（鄰段接合、未登記地合併分割、去除雜點、檢核）？每一步都可復原；任何一步失敗就停下。')) runSteps(3, 6); };
$('projDir').onchange = e => { const f = [...e.target.files]; e.target.value = ''; loadProject(f).catch(err => msg(err.message)); };
document.querySelectorAll('#flowTabs button').forEach(b => b.onclick = () => { document.querySelectorAll('#flowTabs button').forEach(x => x.classList.toggle('on', x === b)); document.querySelectorAll('#flow .stage').forEach(st => { st.hidden = st.id !== b.dataset.stage; }); });
function toggleFlow() { const m = document.querySelector('main'); m.classList.toggle('noflow'); try { localStorage.setItem('cw.flow', m.classList.contains('noflow') ? '0' : '1'); } catch (e) { /* ignore */ } }
$('btnFlow').onclick = toggleFlow;
try { if (localStorage.getItem('cw.flow') === '0') document.querySelector('main').classList.add('noflow'); } catch (e) { /* ignore */ }

// ── 點線面編修工具箱（v0.27.0）：看完檢核報告後逐筆手工修。工具＝在圖上依序點選（點／線／面），湊齊就執行；每次都可 Ctrl+Z 復原 ──
// 待修清單：把舊圖檢核、接圖前比對、未登記地、界址串檢查的結果串成一列，◀ ▶ 逐筆跳過去
const TOPO = {
  addOnLine: { g: '點', name: '線上加點', picks: ['edge'], hint: '點一下界址線：在垂足加點，兩側宗地同步插入（面積不變）' },
  addFree: { g: '點', name: '加孤立點', picks: ['xy'], hint: '點一下空白處：新增不屬於任何宗地的點（之後可貼到線或用來畫面）' },
  move: { g: '點', name: '移動點', picks: [], hint: '拖曳界址點移動（方向鍵微調；共用此點的宗地一起變）' },
  delPt: { g: '點', name: '刪點', picks: ['pt'], hint: '點一下要刪的界址點：從所有用到它的宗地移除（環不可少於 3 點）' },
  snapLine: { g: '點', name: '點貼到線', picks: ['pt', 'edge'], hint: '先點界址點，再點界址線：點移到線上垂足，並接進那條線兩側的宗地（補 T 字接點）' },
  mergePt: { g: '點', name: '點併點', picks: ['pt', 'pt'], hint: '先點要併掉的點，再點要保留的點：兩點變一點（保留點的坐標不動）' },
  addLine: { g: '線', name: '新增線（切開）', picks: ['pt', 'pt'], hint: '在同一宗地內點兩個界址點：連線把宗地切成兩宗（小的一側編新子號）' },
  delLine: { g: '線', name: '刪除線（合併）', picks: ['edge'], hint: '點一下兩宗之間的界址線：刪線＝兩宗合併（段界線不能刪）' },
  addFace: { g: '面', name: '新增面', picks: ['pts'], hint: '依序點界址點圍出空地（縫、空隙），點回第一點或 Enter 建為新地號（母號同未登記地設定）' },
  delFace: { g: '面', name: '刪除面', picks: ['par'], hint: '點一下要刪的宗地：地中地併入外圈，一般宗地範圍變成空地／段外' },
  mergeFace: { g: '面', name: '合併面', picks: ['pars'], hint: '依序點要合併的相連宗地，Enter 合併（保留已登記且地號小者）' },
  redraw: { g: '面', name: '重繪界址串', picks: ['par'], hint: '點一下宗地，再依序點它的界址點重畫界址串（Enter 完成）' },
};
S.topo = null;   // { tool, picks:[{t:'pt'|'edge'|'par'|'xy', …}] }
function topoPanel() {
  const by = {}; for (const [k, t] of Object.entries(TOPO)) (by[t.g] = by[t.g] || []).push([k, t]);
  $('topoTools').innerHTML = Object.entries(by).map(([g, list]) => `<div class="tgrp"><b>${g}</b><div class="row small">${list.map(([k, t]) => `<button class="btn${S.topo && S.topo.tool === k ? ' primary' : ''}" data-topo="${k}" title="${esc(t.hint)}">${t.name}</button>`).join('')}</div></div>`).join('');
  $('topoHint').textContent = S.topo ? `${TOPO[S.topo.tool].name}：${TOPO[S.topo.tool].hint}` + (S.topo.picks.length ? `（已點 ${S.topo.picks.length}）` : '') : '選一個工具，然後在圖上點選。Esc 取消、Enter 完成、Backspace 退一步；每次都可 Ctrl+Z 復原。';
  tqPanel();
}
function topoStart(tool) {
  if (!S.ds) return msg('請先載入圖資'); cancelModes();
  if (tool === 'move') { S.topo = null; setTool('select'); S.filter.pt = true; S.filter.edge = S.filter.par = false; document.querySelectorAll('#filters button').forEach(b => b.classList.toggle('on', S.filter[b.dataset.f])); setHint('移動點：拖曳界址點（只選得到點）；方向鍵微調、Shift×10'); topoPanel(); return; }
  S.topo = { tool, picks: [] }; setTool('select'); setHint(`${TOPO[tool].name}：${TOPO[tool].hint}　Esc 取消`); topoPanel(); draw();
}
function cancelModes() { if (S.pocket) cancelPocket(); if (S.redraw) cancelRedraw(); if (S.align) cancelAlign(); }
function topoCancel() { S.topo = null; setHint(''); topoPanel(); draw(); }
function parcelAt(wx, wy) { let best = null; for (const p of S.ds.parcels) { if (p.deleted || p.ids.length < 3) continue; if (Core.pointInRing(p.ids, S.ds.points, wy, wx) && (!best || p.area < best.area)) best = p; } return best; }
function topoPick(mx, my) {
  const T = S.topo, def = TOPO[T.tool], wx = toWx(mx), wy = toWy(my), need = def.picks[Math.min(T.picks.length, def.picks.length - 1)];
  const pt = () => nearestPoint(S.ds.points, wx, wy, 12 / S.view.s), edge = () => hitEdgeAt(wx, wy, 8 / S.view.s);
  if (need === 'pt' || need === 'pts') { const q = pt(); if (!q) return msg('請點在界址點上');
    if (need === 'pts' && T.picks.length >= 3 && q.id === T.picks[0].id) return topoRun();
    if (T.picks.some(p => p.id === q.id) && need === 'pts') return msg(`界址點 ${q.id} 已點過`); T.picks.push({ t: 'pt', id: q.id }); }
  else if (need === 'edge') { const e = edge(); if (!e) return msg('請點在界址線上（兩點之間）'); T.picks.push({ t: 'edge', a: e.a, b: e.b, y: wy, x: wx }); }
  else if (need === 'par' || need === 'pars') { const p = parcelAt(wx, wy); if (!p) return msg('這裡沒有宗地'); if (T.picks.some(q => q.idx === p.idx)) { T.picks = T.picks.filter(q => q.idx !== p.idx); } else T.picks.push({ t: 'par', idx: p.idx }); }
  else if (need === 'xy') T.picks.push({ t: 'xy', y: wy, x: wx });
  const multi = def.picks[def.picks.length - 1] === 'pts' || def.picks[def.picks.length - 1] === 'pars';
  if (!multi && T.picks.length >= def.picks.length) return topoRun();
  setHint(`${def.name}：${def.hint}　已點 ${T.picks.length}` + (multi ? '，Enter 完成' : '') + '　Esc 取消'); topoPanel(); draw();
}
function topoRun() {
  const T = S.topo, P = T.picks, ds = S.ds; T.picks = [];
  try {
    switch (T.tool) {
      case 'addOnLine': { const r = addPoint({ edge: [P[0].a, P[0].b], y: P[0].y, x: P[0].x }); msg(`已在 ${P[0].a}–${P[0].b} 加點 ${r.id}（${r.parcels.join('、')} 同步插入）`); break; }
      case 'addFree': { const r = addPoint({ y: P[0].y, x: P[0].x }); msg(`已新增孤立點 ${r.id}`); break; }
      case 'delPt': { const r = deletePoints([P[0].id]); msg(r.deleted.length ? `已刪除點 ${P[0].id}（${r.parcels.join('、')}）` : `無法刪除：${r.skipped.map(q => q.reason).join('、')}`); break; }
      case 'snapLine': { const id = P[0].id, r = Core.snapPointToEdge(ds, id, P[1].a, P[1].b), from = r.from, to = r.to, d = r.delta, setXY = q => { const p = ds.points.get(id); p.y = q.y; p.x = q.x; };
        pushUndo({ undoFn: () => { setXY(from); Core.applyDelta(ds, d, 'undo'); }, redoFn: () => { setXY(to); Core.applyDelta(ds, d, 'redo'); }, label: `點 ${id} 貼到線 ${P[1].a}–${P[1].b}` });
        selectOnlyPoint(id); msg(`點 ${id} 移 ${r.dist.toFixed(3)} m 到 ${P[1].a}–${P[1].b} 線上，並接進 ${parLabels(d).join('、')}`); break; }
      case 'mergePt': { const r = Core.mergePoints(ds, P[0].id, P[1].id); pushStruct(r.delta, `點 ${P[0].id} 併入 ${P[1].id}`); pruneSel(); selectOnlyPoint(P[1].id); msg(`點 ${P[0].id} 已併入 ${P[1].id}（${parLabels(r.delta).join('、')}）`); break; }
      case 'addLine': { const a = P[0].id, b = P[1].id, common = (ds.pointParcels.get(a) || []).filter(i => (ds.pointParcels.get(b) || []).includes(i) && !ds.parcels[i].deleted);
        if (!common.length) throw new Error(`點 ${a}、${b} 不在同一宗地上`); let r = null, err = null; for (const pi of common) { try { r = Core.splitByChord(ds, pi, a, b); break; } catch (e) { err = e; } } if (!r) throw err;
        pushStruct(r.delta, `新增線 ${a}–${b}（切開 ${r.keep}）`); msg(`已用 ${a}–${b} 把 ${r.keep} 切開，切下的一側編為 ${r.created}`); break; }
      case 'delLine': { const e = ds.edges.get(P[0].a < P[0].b ? P[0].a + '-' + P[0].b : P[0].b + '-' + P[0].a), labels = e ? e.parcels.map(i => ds.parcels[i].label) : [];
        if (labels.length >= 2 && !confirm(`刪除線 ${P[0].a}–${P[0].b}＝合併 ${labels.join('、')}？可復原`)) break;
        const r = Core.deleteEdge(ds, P[0].a, P[0].b); pushStruct(r.delta, `刪除線 ${P[0].a}–${P[0].b}`); clearSel(); msg(`已刪除線 ${P[0].a}–${P[0].b}：${r.merged.join('、')} 併入 ${r.keep}`); break; }
      case 'addFace': { const r = Core.addFace(ds, P.map(p => p.id), unMother()); pushStruct(r.delta, `新增面 ${r.label}`); const q = ds.parcels.find(p => p.label === r.label && !p.deleted); clearSel(); if (q) S.sel.par.add(q.idx); msg(`已建立 ${r.label}（${q ? q.area.toFixed(2) : ''} m²）`); break; }
      case 'delFace': deleteParcelUI([P[0].idx]); break;
      case 'mergeFace': if (P.length < 2) throw new Error('至少點兩宗'); mergeParcelsUI(P.map(p => p.idx)); break;
      case 'redraw': clearSel(); S.sel.par.add(P[0].idx); S.topo = null; startRedraw(); topoPanel(); return;
    }
  } catch (err) { msg(`${TOPO[T.tool].name}：${err.message}`); }
  setHint(`${TOPO[T.tool].name}：${TOPO[T.tool].hint}　（繼續下一筆，Esc 結束）`); topoPanel(); refresh();
}
function drawTopo() {
  const T = S.topo; if (!T || !T.picks.length) return; ctx.save(); ctx.lineWidth = 3; ctx.strokeStyle = ctx.fillStyle = '#f08c00';
  for (const p of T.picks) {
    if (p.t === 'pt') { const q = S.ds.points.get(p.id); if (q) { ctx.beginPath(); ctx.arc(toSx(q.x), toSy(q.y), 8, 0, 7); ctx.stroke(); } }
    else if (p.t === 'edge') { const a = S.ds.points.get(p.a), b = S.ds.points.get(p.b); ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(toSx(a.x), toSy(a.y)); ctx.lineTo(toSx(b.x), toSy(b.y)); ctx.stroke(); ctx.lineWidth = 3; }
    else if (p.t === 'par') { ctx.globalAlpha = 0.25; ctx.beginPath(); S.ds.parcels[p.idx].ids.forEach((id, i) => { const q = S.ds.points.get(id); i ? ctx.lineTo(toSx(q.x), toSy(q.y)) : ctx.moveTo(toSx(q.x), toSy(q.y)); }); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1; }   // tracePoly 是 render() 內的區域函式，這裡不能用（v0.27.0 在此丟例外，save() 沒 restore，整張圖留在 25% 透明＝「合併面後顏色變淡」）
  }
  if (T.tool === 'addFace' && T.picks.length > 1) { ctx.setLineDash([6, 4]); ctx.beginPath(); T.picks.forEach((p, i) => { const q = S.ds.points.get(p.id); i ? ctx.lineTo(toSx(q.x), toSy(q.y)) : ctx.moveTo(toSx(q.x), toSy(q.y)); }); ctx.stroke(); }
  ctx.restore();
}
// 待修清單
S.tq = { src: 'chk', i: -1, done: new Set() };
function tqItems() {
  const ds = S.ds; if (!ds) return [];
  const byLabel = l => ds.parcels.find(p => !p.deleted && p.label === l);
  switch ($('tqSrc').value) {
    case 'chk': return S.chk.res ? S.chk.res.rows.filter(r => !S.chk.ok.has(r.label)).map(r => ({ key: 'chk|' + r.label, label: r.label, text: `${r.level === 'red' ? '紅' : r.level === 'yellow' ? '黃' : '碎片'}：` + [r.vec ? `離舊圖線 ${r.vec.offLen.toFixed(0)} m、舊圖線穿過內部 ${r.vec.innerLen.toFixed(0)} m` : '', r.img ? `影像無墨線 ${r.img.offLen.toFixed(0)}/${r.img.checked.toFixed(0)} m` + (r.img.redLen ? `（紅線 ${r.img.redLen.toFixed(0)} m 不檢核）` : '') : '', r.fix ? `建議併入 ${r.fix.label}` : ''].filter(Boolean).join('；') })) : [];
    case 'neg': return S.bl.res ? S.bl.res.missing.map(m => ({ key: 'miss|' + m.label, label: m.label, rings: m.rings, text: `遺漏：接圖前 ${m.area.toFixed(0)} m²，現屬 ${m.cover.map(h => h.label).join('、')}` }))
      .concat(S.bl.res.flagged.filter(x => x.diff < 0).map(x => ({ key: 'neg|' + x.label, label: x.label, rings: x.rings, text: `較差 ${x.diff.toFixed(1)} m²（${x.ratio.toFixed(1)} 倍公差，${x.cause}）` })))
      .concat(S.bl.res.occupied.map(o => ({ key: 'occ|' + o.label, label: o.label, rings: o.rings, text: `被未登記地佔用 ${o.occ.toFixed(1)} m²：${o.cover.map(h => h.label).join('、')}` }))) : [];
    case 'area': return S.bl.res ? S.bl.res.flagged.map(x => ({ key: 'area|' + x.label, label: x.label, rings: x.rings, text: `較差 ${x.diff >= 0 ? '+' : ''}${x.diff.toFixed(1)} m²（${x.ratio.toFixed(1)} 倍公差，${x.cause}）` })) : [];
    case 'unreg': return Core.unregSummary(ds, unN(), unRatio(), unMin()).parcels.filter(p => p.over).map(p => ({ key: 'un|' + p.label, label: p.label, text: `未登記地 ${p.pts} 點、長寬比 ${isFinite(p.ratio) ? p.ratio.toFixed(1) : '—'}、${p.area.toFixed(0)} m²` }));
    case 'ring': return Core.ringIssues(ds).map(o => ({ key: 'ring|' + ds.parcels[o.p].label + '|' + o.kind, label: ds.parcels[o.p].label, text: Core.ringIssueLine(ds, o) }));
    case 'sheet': { if (!S.sheet) return []; const chk = new Map((S.chk.res ? S.chk.res.rows : []).filter(r => !S.chk.ok.has(r.label)).map(r => [r.label, r])), area = new Map((S.bl.res ? S.bl.res.flagged : []).map(x => [x.label, x]));
      return sheetNear().map(q => { const c = chk.get(q.label), a = area.get(q.label);
        return { key: 'sheet|' + q.label, label: q.label, text: `距分幅線 ${q.dist.toFixed(1)} m（${q.pair}）` + [c ? `舊圖檢核${c.level === 'red' ? '紅' : c.level === 'yellow' ? '黃' : '碎片'}` : '', a ? `較差 ${a.diff >= 0 ? '+' : ''}${a.diff.toFixed(1)} m²` : ''].filter(Boolean).map(t => '；' + t).join('') }; }); }
  }
  return [];
}
function tqPanel() {
  const items = tqLive(); S.tq.items = items; if (S.tq.i >= items.length) S.tq.i = items.length - 1;
  $('tqPos').textContent = items.length ? `${S.tq.i + 1 > 0 ? S.tq.i + 1 : '—'} / ${items.length}` : '沒有待修項目';
  const it = items[S.tq.i]; $('tqInfo').innerHTML = it ? `<b>${esc(it.label)}</b>　${esc(it.text)}` : ($('tqSrc').value === 'chk' && !S.chk.res ? '請先做第 6 步檢核' : $('tqSrc').value === 'sheet' ? (S.sheet ? '' : '請先做第 2 步加入分幅線') : ($('tqSrc').value !== 'unreg' && $('tqSrc').value !== 'ring' && !S.bl.res ? '請先做接圖前比對' : ''));
  $('tqPrev').disabled = $('tqNext').disabled = !items.length; $('tqDone').disabled = !it; notePanel();
}
const tqLive = () => tqSort(tqItems().filter(x => !S.tq.done.has(x.key) && !(x.key.startsWith('chk|') && S.chk.ok.has(x.label))));
function tqSetSrc(src) { if (src == null || src === $('tqSrc').value) return; if (![...$('tqSrc').options].some(o => o.value === src)) throw new Error('source 需為 ' + [...$('tqSrc').options].map(o => o.value).join('／')); $('tqSrc').value = src; S.tq.i = -1; tqPanel(); }
function tqGo(step) {
  const items = tqLive(); S.tq.items = items; if (!items.length) { S.tq.i = -1; S.tq.focus = null; tqPanel(); return; }   // 每次重算：剛按「修好了」的那筆已經不在清單裡（v0.27.0 用舊清單，畫面跳到剛修好的那宗、對話框卻顯示下一筆）
  S.tq.i = ((S.tq.i < 0 && step < 0 ? 0 : S.tq.i) + step + items.length) % items.length; const it = items[S.tq.i];
  const p = S.ds.parcels.find(q => !q.deleted && q.label === it.label); clearSel();
  if (p) { S.sel.par.add(p.idx); zoomTo([p.idx]); }
  else if (it.rings && it.rings.length) { let b = null; for (const r of it.rings) for (const q of r) b = b ? { x0: Math.min(b.x0, q.x), x1: Math.max(b.x1, q.x), y0: Math.min(b.y0, q.y), y1: Math.max(b.y1, q.y) } : { x0: q.x, x1: q.x, y0: q.y, y1: q.y }; const m = Math.max(10, (b.x1 - b.x0 + b.y1 - b.y0) * 0.3); fit({ x0: b.x0 - m, x1: b.x1 + m, y0: b.y0 - m, y1: b.y1 + m }); }
  S.tq.focus = it; tqPanel(); refresh(); msg(`${it.label}：${it.text}`);
}
function tqMarkDone() { const it = (S.tq.items || [])[S.tq.i]; if (!it) return; if (it.key.startsWith('chk|')) S.chk.ok.add(it.label); else S.tq.done.add(it.key); S.tq.i--; tqGo(1); projDirty(); }
$('topoTools').addEventListener('click', e => { const b = e.target.closest('[data-topo]'); if (!b) return; S.topo && S.topo.tool === b.dataset.topo ? topoCancel() : topoStart(b.dataset.topo); });
$('tqPrev').onclick = () => tqGo(-1); $('tqNext').onclick = () => tqGo(1); $('tqDone').onclick = tqMarkDone; $('tqSrc').onchange = () => { S.tq.i = -1; tqPanel(); };
$('dlgTopo').addEventListener('close', () => { if (S.topo) topoCancel(); });

// ── 分幅線（v0.28.0）：分幅舊圖各幅的接合處。步驟 2 一鍵加入（載入兩幅以上的分幅舊圖時自動加入）；待修清單優先排分幅線附近的地號 ──
S.sheet = null;   // { segs, pairs, length, show, near（附近宗地，依線排序）, nearKey }
const sheetDist = () => { const v = parseFloat($('sheetDist').value); return Number.isFinite(v) && v > 0 ? v : 10; };
function sheetNear() {
  if (!S.sheet || !S.ds) return []; const k = S.undo.length + ':' + S.redo.length + ':' + sheetDist();
  if (S.sheet.nearKey !== k) { S.sheet.near = Core.nearSheetLines(S.ds, S.sheet, sheetDist()); S.sheet.nearKey = k; }
  return S.sheet.near;
}
const sheetText = () => `分幅線 ${S.sheet.pairs.length} 處接合、共 ${S.sheet.length.toFixed(0)} m；附近（≤ ${sheetDist()} m）${sheetNear().length} 宗，待修清單優先排這些`;
function sheetRun() {
  if (!S.ds) throw new Error('請先載入作業圖'); const sets = S.bl.sets.map(s => s.ds);
  if (!sets.some(d => d.length > 1)) throw new Error('需要兩幅以上的分幅舊圖才能加入分幅線（步驟 1「分幅舊圖」選放各幅的資料夾）');
  const sl = Core.sheetLines(S.ds, sets); if (!sl.segs.length) throw new Error('分幅舊圖各幅之間找不到接合處（各幅外緣相距都超過 6 m）');
  S.sheet = { ...sl, show: true, near: null, nearKey: null }; projDirty(); refresh(); return sheetText();
}
function sheetAuto() { if (!S.ds || !S.bl.sets.some(s => s.ds.length > 1)) return; try { S.wf[2] = { ok: true, text: sheetRun() }; } catch (e) { /* 找不到接合處：不自動加入，步驟 2 可手動執行看原因 */ } }
function drawSheet() {
  ctx.save(); ctx.strokeStyle = 'rgba(214,51,108,.75)'; ctx.lineWidth = 4; ctx.setLineDash([10, 6]); ctx.lineCap = 'round'; ctx.beginPath();
  for (const s of S.sheet.segs) { ctx.moveTo(toSx(s.ax), toSy(s.ay)); ctx.lineTo(toSx(s.bx), toSy(s.by)); } ctx.stroke(); ctx.restore();
}
// 待修清單：分幅線附近的排前面（依沿線順序），其餘照原順序
function tqSort(items) {
  if (!S.sheet || !$('tqSheet').checked || $('tqSrc').value === 'sheet') return items;
  const rank = new Map(sheetNear().map((q, i) => [q.label, i])), near = items.filter(x => rank.has(x.label)).sort((a, b) => rank.get(a.label) - rank.get(b.label));
  return near.map(x => ({ ...x, text: '〔分幅線附近〕' + x.text })).concat(items.filter(x => !rank.has(x.label)));
}

// ── 專案檔（v0.28.0）：把讀入的原始檔案（主要測區、鄰段、分幅舊圖、登記資料，可選含影像）與目前的作業狀態
// （點位、界址串、各步驟結果、檢核報告與「修好了」、待修清單進度、分幅線、設定）存成一個 .crwp 檔，下次開啟接著做。
// 另在瀏覽器自動暫存（IndexedDB），重開程式時可「接著做」。復原記錄不存（開啟後從目前狀態開始）。
const PROJ_EXT = 'crwp', PROJ_FMT = 'cadastral-resurvey-workstation/project@1', SRC_RE = /\.(d11|d12|d13|d14|d20|d21|d2b|d2c|d2d|coa|bnp|par|mdb|ctl|ct2|cen|l02)$/i;
S.src = null; S.srcDirty = false; S.proj = { handle: null, saved: null, auto: null, dirty: false };
const srcRec = () => S.src || (S.src = { main: [], nb: [], bl: [], img: [], own: null });
function srcMain(files) { const o = srcRec(); o.main = files.filter(f => !IMG_RE.test(extOf(f.name)) && !WLD_RE.test(extOf(f.name))); o.own = null; S.srcDirty = true; S.proj.handle = null; S.proj.saved = null; S.proj.images = null; S.log = []; S.notes = {}; S.ms = []; S.msView = null; S.live = null; S.batch = null; }
const pathOf = f => f.webkitRelativePath || f._path || f.name, baseOf = f => f.name.replace(/\.[^.]+$/, '').toLowerCase();
// 目前仍在使用的來源檔（移除的鄰段、分幅舊圖、影像不存）
function srcLive(images) {
  const o = srcRec(), nb = new Set(S.nb.map(n => n.name.toLowerCase())), im = new Set(S.img.map(q => q.name.toLowerCase())), uniq = l => [...new Map(l.map(f => [pathOf(f), f])).values()];
  return { main: uniq(o.main), nb: uniq(o.nb.filter(f => nb.has(baseOf(f)))), bl: o.bl.filter(b => S.bl.sets.includes(b.set)).map(b => ({ name: b.set.name, auto: !!b.set.auto, files: uniq(b.files) })),
    img: images ? uniq(o.img.filter(f => im.has(baseOf(f)))) : [], own: o.own && !o.main.includes(o.own) ? o.own : null };
}
const SET_SKIP = /^(findTop|tqSrc)$/;
function projState() {
  const settings = {}; document.querySelectorAll('dialog.fp input[id], dialog.fp select[id], #tol, #deltaMode').forEach(el => { if (el.type === 'file' || SET_SKIP.test(el.id)) return; settings[el.id] = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value; });
  const fixed = S.chk.res ? S.chk.res.rows.filter(r => S.chk.ok.has(r.label)).length : 0;
  return { ds: Core.datasetState(S.ds), view: { ...S.view }, wf: S.wf, bl: S.bl.res, chk: S.chk.res ? { res: { ...S.chk.res, bl: null }, ok: [...S.chk.ok] } : null,
    tq: { src: $('tqSrc').value, i: S.tq.i, done: [...S.tq.done] }, sheet: S.sheet ? { segs: S.sheet.segs, pairs: S.sheet.pairs, length: S.sheet.length, show: S.sheet.show } : null,
    nb: S.nb.map(n => ({ name: n.name, mode: n.mode, visible: n.visible })), settings, log: S.log, notes: S.notes, ms: S.ms, progress: projProgress(), summary: { case: caseBase(), fixed, rows: S.chk.res ? S.chk.res.rows.length : 0 } };
}
function projApply(st) {
  Core.applyDatasetState(S.ds, st.ds); S.undo.length = S.redo.length = 0; clearSel(); S.hover = null;
  for (const [id, v] of Object.entries(st.settings || {})) { const el = $(id); if (!el) continue; if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!v; else el.value = v; }
  S.wf = st.wf || {}; S.bl.res = st.bl || null; S.chk.res = st.chk ? { ...st.chk.res, bl: S.bl.res } : null; S.chk.ok = new Set(st.chk ? st.chk.ok : []); S.chk.focus = null;
  if (st.tq) { $('tqSrc').value = st.tq.src || 'chk'; S.tq.i = st.tq.i ?? -1; S.tq.done = new Set(st.tq.done || []); }
  S.sheet = st.sheet ? { ...st.sheet, near: null, nearKey: null } : null;
  for (const n of st.nb || []) { const x = S.nb.find(q => q.name === n.name); if (x) { x.mode = n.mode; x.visible = n.visible; } }
  if (st.view) S.view = { ...S.view, ...st.view }; if (S.owner) ownRun();
  S.log = st.log || []; S.notes = st.notes || {}; S.ms = st.ms || []; S.msView = null; S.live = null; snapReset();
}
const toB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
async function projFile(images) {
  if (!S.ds || !S.src) throw new Error('請先載入案件');
  const src = srcLive(images), enc = async f => ({ path: pathOf(f), base64: toB64(await readBuf(f)) }), all = l => Promise.all(l.map(enc));
  return { format: PROJ_FMT, app: APP_VERSION, saved: new Date().toISOString(), name: caseBase(), images: S.img.map(q => q.name), images_included: !!images,
    note: '地籍圖重測工作站專案檔：source＝讀入的原始檔案（base64）；state＝作業狀態（ds.points／ds.parcels 為目前的界址點與界址串，y＝縱坐標（北）、x＝橫坐標（東），TWD97）',
    source: { main: await all(src.main), nb: await all(src.nb), bl: await Promise.all(src.bl.map(async b => ({ name: b.name, auto: b.auto, files: await all(b.files) }))), img: await all(src.img), own: src.own ? await enc(src.own) : null }, state: projState() };
}
async function saveProject(as = false) {
  if (!S.ds) return msg('請先載入案件');
  if (S.proj.images == null || as) S.proj.images = !!S.img.length && confirm(`專案檔要包含舊圖影像嗎？（${S.img.length} 張，檔案會很大）\n選「取消」＝不含影像，開啟後再按「舊圖影像」載入`); const big = S.proj.images;   // 同一案件只問一次（另存時再問）
  try {
    msg('專案檔準備中…'); const text = JSON.stringify(await projFile(big)), name = caseBase() + '.' + PROJ_EXT;
    if (window.showSaveFilePicker) {
      try { if (as || !S.proj.handle) S.proj.handle = await showSaveFilePicker({ suggestedName: name, types: [{ description: '地籍圖重測工作站專案', accept: { 'application/json': ['.' + PROJ_EXT] } }] });
        const w = await S.proj.handle.createWritable(); await w.write(text); await w.close(); }
      catch (e) { if (e.name === 'AbortError') return msg('已取消儲存'); S.proj.handle = null; download(name, text, 'application/json'); }
    } else download(name, text, 'application/json');
    S.proj.saved = new Date(); S.proj.dirty = false; msg(`已儲存專案檔 ${S.proj.handle ? S.proj.handle.name : name}（${(text.length / 1048576).toFixed(1)} MB${big ? '，含影像' : ''}）：下次「開啟專案檔」或把它拖進畫面就能接著做`); refresh();
  } catch (e) { msg('儲存專案檔失敗：' + e.message); }
}
const srcFile = e => (e.blob ? Object.assign(new File([e.blob], e.path.split('/').pop()), { _path: e.path }) : toFile({ name: e.path, path: e.path, base64: e.base64 }));
async function openProjectData(j) {
  if (!j || j.format !== PROJ_FMT) throw new Error('不是本程式的專案檔');
  S.nb.length = 0; S.bl.sets.length = 0; S.bl.res = null; S.img.length = 0; S.imgActive = -1; S.src = null; S.wf = {}; S.chk.res = null; S.chk.ok = new Set(); S.sheet = null; S.owner = null;
  const F = l => (l || []).map(srcFile), s = j.source;
  if (!await loadFiles(F(s.main))) throw new Error('專案檔裡的主要測區無法讀入');
  if (s.own) await loadOwners(srcFile(s.own), true);
  if (s.nb && s.nb.length) await loadNeighbors(F(s.nb));
  for (const b of s.bl || []) { const r = await loadBaseline(F(b.files)); const set = S.bl.sets[S.bl.sets.length - 1]; if (r && r.added && set) { set.name = b.name; set.auto = b.auto; } }
  if (s.img && s.img.length) { await loadImages(F(s.img)); if (!S.img.some(im => im.visible)) { const im = S.img.find(q => q.located && isOldMapImg(q)); if (im) { im.opacity = 0.8; setImgVisible(im, true); } } }
  projApply(j.state); S.srcDirty = true; S.proj.dirty = false;
  const lost = (j.images || []).filter(n => !S.img.some(q => q.name === n)), pg = projProgress();
  msg(`已開啟專案 ${j.name}（${new Date(j.saved).toLocaleString()} 儲存）：圖資準備 ${pg.prep}/6 步` + (pg.rows ? `、逐筆修 ${pg.fixed}/${pg.rows}` : '') + (lost.length ? `；影像 ${lost.length} 張未存在專案檔，請按「舊圖影像」重新載入` : ''));
  refresh(); return { name: j.name, saved: j.saved, progress: pg, missing_images: lost };
}
async function openProjectFile(f) { try { const r = await openProjectData(JSON.parse(await readText(f))); if (f.createWritable) S.proj.handle = f; S.proj.saved = new Date(); return r; } catch (e) { msg('無法開啟專案檔：' + e.message); return null; } }
async function pickProject() {
  if (window.showOpenFilePicker) { try { const [h] = await showOpenFilePicker({ types: [{ description: '地籍圖重測工作站專案', accept: { 'application/json': ['.' + PROJ_EXT] } }] }); const r = await openProjectFile(await h.getFile()); if (r) S.proj.handle = h; } catch (e) { if (e.name !== 'AbortError') msg(e.message); } }
  else $('projIn').click();
}
// 瀏覽器自動暫存：原始檔（Blob，只在讀入新檔後寫一次）與狀態（每次修改後約 3 秒）分開存
const idb = (() => { let db = null; const open = () => db || (db = new Promise((res, rej) => { const r = indexedDB.open('cadastral-resurvey-workstation', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = (mode, fn) => open().then(d => new Promise((res, rej) => { const t = d.transaction('kv', mode), q = fn(t.objectStore('kv')); t.oncomplete = () => res(q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }));
  return { get: k => tx('readonly', st => st.get(k)), set: (k, v) => tx('readwrite', st => st.put(v, k)), del: k => tx('readwrite', st => st.delete(k)) }; })();
function projDirty() { if (!S.ds) return; S.proj.dirty = true; clearTimeout(projDirty.t); projDirty.t = setTimeout(autoSave, 3000); }
async function autoSave() {
  if (!S.ds || !S.src || !window.indexedDB) return;
  try {
    if (S.srcDirty) { const src = srcLive(true), size = src.img.reduce((t, f) => t + f.size, 0), blob = f => ({ path: pathOf(f), blob: f }), l = x => x.map(blob);
      await idb.set('src', { main: l(src.main), nb: l(src.nb), bl: src.bl.map(b => ({ name: b.name, auto: b.auto, files: l(b.files) })), img: size < 400 * 1048576 ? l(src.img) : [], own: src.own ? blob(src.own) : null }); S.srcDirty = false; }
    const st = projState(); await idb.set('state', st); await idb.set('meta', { name: caseBase(), saved: new Date().toISOString(), app: APP_VERSION, images: S.img.map(q => q.name), progress: st.progress });
    S.proj.auto = new Date(); progPanel();
  } catch (e) { S.proj.auto = null; S.proj.autoErr = e.message; progPanel(); }
}
async function resumeAuto() {
  const [meta, src, state] = await Promise.all([idb.get('meta'), idb.get('src'), idb.get('state')]); if (!meta || !src || !state) throw new Error('沒有暫存的案件');
  $('resume').hidden = true; return openProjectData({ format: PROJ_FMT, name: meta.name, saved: meta.saved, images: meta.images, source: src, state });
}
async function resumeOffer() {
  if (!window.indexedDB) return; let m = null; try { m = await idb.get('meta'); } catch (e) { return; } if (!m || S.ds) return;
  const pg = m.progress || {}; $('resume').hidden = false;
  $('resume').innerHTML = `上次的案件 <b>${esc(m.name)}</b>（${new Date(m.saved).toLocaleString()}）：圖資準備 ${pg.prep ?? '—'}/6 步` + (pg.rows ? `、逐筆修 ${pg.fixed}/${pg.rows}` : '') + `<div class="row small" style="margin-top:4px"><button class="btn primary" id="btnResume">接著做</button><button class="btn" id="btnResumeNo" title="清除瀏覽器暫存（不影響已儲存的專案檔）">清除暫存</button></div>`;
  $('btnResume').onclick = () => resumeAuto().catch(e => msg('無法接續：' + e.message)); $('btnResumeNo').onclick = () => { if (confirm('清除瀏覽器裡暫存的上次案件？已儲存的專案檔不受影響')) { idb.del('meta'); idb.del('src'); idb.del('state'); $('resume').hidden = true; } };
}
// 專案進度：圖資準備 6 步＋檢核後逐筆修（劃掉的筆數）＋分幅線附近（已看過的宗數）
function projProgress() {
  const prep = S.ds ? STEPS.filter(s => { const st = stepStatus(s).st; return st === 'done' || st === 'na'; }).length : 0;
  const rows = S.chk.res ? S.chk.res.rows.length : 0, fixed = S.chk.res ? S.chk.res.rows.filter(r => S.chk.ok.has(r.label)).length : 0;
  const near = S.sheet ? sheetNear() : [], chkLeft = new Set(S.chk.res ? S.chk.res.rows.filter(r => !S.chk.ok.has(r.label)).map(r => r.label) : []), seen = near.filter(q => S.tq.done.has('sheet|' + q.label) || (S.chk.res && !chkLeft.has(q.label) && S.chk.ok.has(q.label))).length;
  return { prep, rows, fixed, near: near.length, seen, pct: Math.round(100 * (rows ? (prep / 6) * 0.5 + (fixed / rows) * 0.5 : (prep / 6) * 0.5)) };
}
function progPanel() {
  const el = $('prog'); if (!el) return; if (!S.ds) { el.hidden = true; return; } el.hidden = false; const g = projProgress();
  $('progName').textContent = caseBase(); $('progPct').textContent = g.pct + '%';
  $('progPrep').style.width = (g.prep / 6 * 100) + '%'; $('progFix').style.width = (g.rows ? g.fixed / g.rows * 100 : 0) + '%';
  $('progText').textContent = `圖資準備 ${g.prep}/6 步　逐筆修 ${g.rows ? `${g.fixed}/${g.rows}` : '（第 6 步檢核後）'}` + (g.near ? `　分幅線附近 ${g.seen}/${g.near}` : '');
  $('progSave').textContent = S.proj.saved ? `專案檔 ${S.proj.saved.toLocaleTimeString()} 儲存${S.proj.dirty ? '（之後有修改）' : ''}` : S.proj.auto ? `已自動暫存 ${S.proj.auto.toLocaleTimeString()}（尚未存成專案檔）` : S.proj.autoErr ? `自動暫存無法使用：${S.proj.autoErr}` : '尚未儲存';
}
$('projIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openProjectFile(f); };
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(e.shiftKey); } });
$('sheetShow').onchange = draw; $('tqSheet').onchange = () => { S.tq.i = -1; tqPanel(); }; $('sheetDist').onchange = () => { tqPanel(); refresh(); };
resumeOffer();

// ── 每次修改之後（v0.29.0）：比對修改前後的界址串與面積 → 寫作業紀錄、對動到的宗地做即時檢查 ──
S.snap = { sig: [], area: [] }; S.log = []; S.live = null; S.notes = {}; S.ms = [];
const ringSig = p => (p.deleted ? 'x' : p.ids.join(','));
function snapReset() { const ds = S.ds; S.snap = { sig: ds ? ds.parcels.map(ringSig) : [], area: ds ? ds.parcels.map(p => p.area) : [] }; }
function afterEdit(kind, e) {
  const ds = S.ds; if (!ds || !e) return; const ch = [];
  for (const p of ds.parcels) { const i = p.idx, sig = ringSig(p), s0 = S.snap.sig[i], a0 = S.snap.area[i];
    if (s0 !== sig || Math.abs((a0 ?? 0) - p.area) > 1e-6) ch.push({ i, l: p.label, st: s0 == null ? '新增' : p.deleted ? '刪除' : s0 === 'x' ? '恢復' : s0 !== sig ? '界址串' : '面積', a0: s0 == null || s0 === 'x' ? null : a0, a1: p.deleted ? null : p.area });
    S.snap.sig[i] = sig; S.snap.area[i] = p.area; }
  const moved = (e.before || []).map(b => b[0]).filter(id => ds.points.has(id)), idxs = new Set(ch.map(c => c.i));
  for (const id of moved) for (const pi of ds.pointParcels.get(id) || []) idxs.add(pi);
  const op = (kind === 'undo' ? '復原：' : kind === 'redo' ? '重做：' : '') + (e.label || '修改');
  S.log.push({ t: new Date().toISOString(), op, n: ch.length, parcels: ch.slice(0, 300).map(c => ({ l: c.l, st: c.st, a0: c.a0 == null ? null : +c.a0.toFixed(3), a1: c.a1 == null ? null : +c.a1.toFixed(3) })), moved: moved.length, pts: moved.slice(0, 100) });
  if (S.log.length > 20000) S.log.splice(0, S.log.length - 20000);
  liveCheck([...idxs]);
}
// 即時檢查：只看這次動到的宗地與鄰宗；一次動太多（一鍵步驟）就略過，改用「一鍵產出 .ERR」
function liveCheck(idxs) {
  if (!$('liveChk').checked || !S.ds || !idxs.length) { S.live = null; return; }
  if (idxs.length > 400) { S.live = { issues: [], skipped: idxs.length, i: -1 }; return; }
  const issues = Core.localConflicts(S.ds, idxs); S.live = { issues, i: -1 };
  if (issues.length) msg(`⚠ 即時檢查：這次修改附近有 ${issues.length} 處問題（${liveCount(issues)}）——工具箱「即時檢查」可逐處看，Ctrl+Z 復原`);
}
const liveCount = l => [['cross', '交錯'], ['overlap', '重疊'], ['tee', 'T 字接點']].map(([k, n]) => [n, l.filter(x => x.kind === k).length]).filter(x => x[1]).map(x => x.join(' ')).join('、');
function livePanel() {
  const L = S.live; $('liveInfo').innerHTML = !L ? '<span class="muted">每次修改後檢查動到的宗地與鄰宗（交錯、重疊、T 字接點）</span>' : L.skipped ? `<span class="muted">上一個動作改了 ${L.skipped} 宗，太多不即時檢查；請用「一鍵產出偵錯報表 .ERR」</span>` : L.issues.length ? `<b style="color:var(--bad)">⚠ ${L.issues.length} 處：${liveCount(L.issues)}</b>　${L.i >= 0 ? esc(L.issues[L.i].text) : ''}` : '<span style="color:var(--ok)">✓ 上一個修改沒有產生交錯、重疊或 T 字接點</span>';
  $('liveNext').disabled = !(L && L.issues && L.issues.length);
}
function liveNext() { const L = S.live; if (!L || !L.issues.length) return; L.i = (L.i + 1) % L.issues.length; const x = L.issues[L.i], m = 8; fit({ x0: x.x - m, x1: x.x + m, y0: x.y - m, y1: x.y + m }); livePanel(); msg(x.text); refresh(); }
function drawLive() { const L = S.live; if (!L || !L.issues || !L.issues.length) return; ctx.save(); ctx.strokeStyle = '#d1242f'; ctx.lineWidth = 3;
  L.issues.forEach((x, k) => { const sx = toSx(x.x), sy = toSy(x.y), r = k === L.i ? 14 : 9; ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.stroke(); }); ctx.restore(); }

// ── 作業紀錄（v0.29.0）：每個動作的時間、名稱、動到的地號（面積前後）與移動的點；存進專案檔，可輸出 CSV／列印 ──
function logPanel() {
  const L = S.log.slice().reverse(), q = $('logFind').value.trim();
  const rows = (q ? L.filter(x => x.op.includes(q) || x.parcels.some(p => p.l === q || p.l.startsWith(q + '-'))) : L).slice(0, 500);
  $('logSum').textContent = `共 ${S.log.length} 筆動作` + (q ? `；符合 ${rows.length}` : '') + (S.log.length ? `（${new Date(S.log[0].t).toLocaleString()} 起）` : '');
  $('logBody').innerHTML = rows.map(x => `<tr><td>${new Date(x.t).toLocaleString()}</td><td>${esc(x.op)}</td><td>${x.parcels.slice(0, 8).map(p => `${esc(p.l)}<span class="muted">（${p.st}${p.a0 != null || p.a1 != null ? ` ${p.a0 == null ? '—' : p.a0.toFixed(2)}→${p.a1 == null ? '—' : p.a1.toFixed(2)}` : ''}）</span>`).join('、')}${x.n > 8 ? `…共 ${x.n} 宗` : ''}</td><td>${x.moved || ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">尚無紀錄</td></tr>';
}
function logCsv() {
  const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)), out = [['時間', '動作', '地號', '變動', '面積前㎡', '面積後㎡', '差㎡', '移動點數', '移動點號（前 100）'].join(',')];
  for (const x of S.log) { const t = new Date(x.t).toLocaleString(), pts = x.pts.join(' ');
    if (!x.parcels.length) out.push([t, x.op, '', '', '', '', '', x.moved, pts].map(q).join(','));
    x.parcels.forEach((p, k) => out.push([t, x.op, p.l, p.st, p.a0, p.a1, p.a0 != null && p.a1 != null ? (p.a1 - p.a0).toFixed(3) : '', k ? '' : x.moved, k ? '' : pts].map(q).join(',')));
    if (x.n > x.parcels.length) out.push([t, x.op, `（另 ${x.n - x.parcels.length} 宗未列）`, '', '', '', '', '', ''].map(q).join(',')); }
  return '﻿' + out.join('\r\n') + '\r\n';
}
function logHtml() {
  const d = new Date(), rows = S.log.map(x => `<tr><td>${new Date(x.t).toLocaleString()}</td><td>${esc(x.op)}</td><td>${x.parcels.map(p => `${esc(p.l)}（${p.st}${p.a0 != null || p.a1 != null ? ` ${p.a0 == null ? '—' : p.a0.toFixed(2)}→${p.a1 == null ? '—' : p.a1.toFixed(2)} ㎡` : ''}）`).join('、')}${x.n > x.parcels.length ? `…共 ${x.n} 宗` : ''}</td><td>${x.moved || ''}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(caseBase())} 重測調整作業紀錄</title><style>body{font:13px/1.5 "Noto Sans TC","Microsoft JhengHei",sans-serif;margin:16px;color:#1d2330}h1{font-size:18px;margin:0 0 4px}.m{color:#69718a;margin-bottom:10px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #c8ccd6;padding:3px 6px;vertical-align:top;text-align:left}th{background:#eef0f4}td:nth-child(1){white-space:nowrap}.sign{margin-top:24px;display:flex;gap:60px}@media print{@page{size:A4;margin:12mm}}</style></head><body>
<h1>${esc(caseBase())} 重測調整作業紀錄</h1><div class="m">地籍圖重測工作站 ${APP_VERSION}　產出 ${d.toLocaleString()}　共 ${S.log.length} 筆動作</div><table><thead><tr><th>時間</th><th>動作</th><th>地號（變動 面積前→後）</th><th>移動點數</th></tr></thead><tbody>${rows}</tbody></table>
<div class="sign"><span>作業人員：＿＿＿＿＿＿</span><span>審核：＿＿＿＿＿＿</span></div></body></html>`;
}
$('logFind').oninput = logPanel; $('btnLogCsv').onclick = () => download(caseBase() + '_作業紀錄.csv', logCsv(), 'text/csv;charset=utf-8');
$('btnLogHtml').onclick = () => { download(caseBase() + '_作業紀錄.html', logHtml(), 'text/html;charset=utf-8'); msg('已輸出作業紀錄（HTML）：用瀏覽器開啟後可列印或另存 PDF'); };

// ── 批次處理（v0.29.0）：同類問題先預覽、一鍵全部套用、一次復原 ──
S.batch = null;   // { kind, items:[{text, x, y, …}] }
const BATCH = {
  sliver: { name: '碎片併入（舊圖檢核建議的鄰宗）', tol: false,
    find: () => { if (!S.chk.res) throw new Error('請先做第 6 步檢核'); return S.chk.res.rows.filter(r => r.fix && !S.chk.ok.has(r.label)).map(r => { const p = S.ds.parcels[r.idx], q = S.ds.parcels[r.fix.into]; if (!p || p.deleted || !q || q.deleted) return null; const c = Core.centroidOf(S.ds.points, p.ids); return { idx: r.idx, into: r.fix.into, label: r.label, x: c.x, y: c.y, text: `${r.label}（${p.area.toFixed(1)} m²）併入 ${q.label}` }; }).filter(Boolean); },
    apply: it => ({ delta: Core.mergeParcels(S.ds, [it.idx, it.into], it.into).delta, ok: () => S.chk.ok.add(it.label) }) },
  snap: { name: '離線的點貼到線（T 字接點沒接上）', tol: 0.05,
    // 離線較遠的先貼：兩點互相靠線時（斜線上的端點也在容許內），貼了遠的那一點，近的那一點通常就被位相重建一起接上，不必再移
    find: tol => Core.nearEdgePoints(S.ds, tol).sort((u, v) => v.d - u.d).map(c => ({ ...c, text: `點 ${c.id} 離 ${c.a}–${c.b} ${(c.d * 100).toFixed(1)} cm` })),
    apply: it => { const e = S.ds.edges.get(it.a < it.b ? it.a + '-' + it.b : it.b + '-' + it.a); if (!e || e.parcels.some(i => S.ds.parcels[i].ids.includes(it.id))) return null;   // 前面幾筆已經接好
      const r = Core.snapPointToEdge(S.ds, it.id, it.a, it.b); return { delta: r.delta, id: it.id, from: r.from, to: r.to }; } },
  dup: { name: '重複點併點（兩點號幾乎同位置）', tol: 0.05,
    find: tol => Core.nearDupPoints(S.ds, tol).map(c => ({ ...c, text: `點 ${c.from} 併入 ${c.to}（相距 ${(c.d * 100).toFixed(1)} cm）${c.edge ? '　兩點之間有線' : ''}` })),
    apply: it => ({ delta: Core.mergePoints(S.ds, it.from, it.to).delta }) },
  seam: { name: '分幅線接合點併點（< 0.3 m 的配對）', tol: false,
    find: () => { if (!S.sheet) throw new Error('請先做第 2 步加入分幅線'); return seamPairs().filter(p => p.level === 'ok').map(c => ({ ...c, text: `點 ${c.from} 併入 ${c.to}（${(c.d * 100).toFixed(0)} cm，${c.sheets}）` })); },
    apply: it => ({ delta: Core.mergePoints(S.ds, it.from, it.to).delta }) },
};
function runBatchSteps(items, apply, label) {   // 逐筆套用（失敗的跳過並列出），整批一次復原
  const ds = S.ds, steps = [], failed = [], oks = [], setXY = (id, q) => { const p = ds.points.get(id); if (p) { p.y = q.y; p.x = q.x; } };
  let skipped = 0; for (const it of items) { try { const r = apply(it); if (!r) { skipped++; continue; } steps.push(r); if (r.ok) oks.push(r.ok); } catch (e) { failed.push(`${it.text}：${e.message}`); } }
  if (steps.length) { for (const f of oks) f();
    pushUndo({ undoFn: () => { for (const s of steps.slice().reverse()) { if (s.from) setXY(s.id, s.from); Core.applyDelta(ds, s.delta, 'undo'); } pruneSel(); }, redoFn: () => { for (const s of steps) { if (s.to) setXY(s.id, s.to); Core.applyDelta(ds, s.delta, 'redo'); } pruneSel(); }, label: `${label}（${steps.length} 筆）` }); }
  return { done: steps.length, failed, skipped };
}
function batchPreview() {
  if (!S.ds) return msg('請先載入圖資'); const k = $('batchKind').value, b = BATCH[k], tol = parseFloat($('batchTol').value) || b.tol;
  try { S.batch = { kind: k, items: b.find(tol) }; } catch (e) { S.batch = null; msg(e.message); }
  batchPanel(); draw();
}
function batchPanel() {
  const k = $('batchKind').value, b = BATCH[k]; $('batchTolWrap').hidden = !b.tol; const B = S.batch && S.batch.kind === k ? S.batch : null;
  $('batchInfo').innerHTML = B ? (B.items.length ? `找到 <b>${B.items.length}</b> 筆（圖上橘圈）：<div class="blist">${B.items.slice(0, 200).map((x, i) => `<div data-bi="${i}">${esc(x.text)}</div>`).join('')}${B.items.length > 200 ? `<div class="muted">…另 ${B.items.length - 200} 筆</div>` : ''}</div>` : '沒有符合的項目') : '<span class="muted">按「預覽」列出候選；確認後「全部套用」，一次 Ctrl+Z 全部復原</span>';
  $('batchApply').disabled = !(B && B.items.length);
}
function batchApply() {
  const B = S.batch; if (!B || !B.items.length) return; const b = BATCH[B.kind];
  if (!confirm(`${b.name}：套用 ${B.items.length} 筆？可一次復原`)) return;
  const r = runBatchSteps(B.items, b.apply, b.name); S.batch = null; batchPanel();
  msg(`${b.name}：完成 ${r.done} 筆` + (r.skipped ? `（${r.skipped} 筆已被前面的一起接好）` : '') + (r.failed.length ? `；${r.failed.length} 筆沒做：${r.failed.slice(0, 3).join('；')}${r.failed.length > 3 ? '…' : ''}` : '') + '。可一次復原'); if ($('dlgChk').open) chkPanel(); refresh();
}
function drawBatch() { const B = S.batch; if (!B || !B.items.length) return; ctx.save(); ctx.strokeStyle = '#f08c00'; ctx.lineWidth = 2.5; for (const x of B.items) { ctx.beginPath(); ctx.arc(toSx(x.x), toSy(x.y), 10, 0, 7); ctx.stroke(); } ctx.restore(); }
$('batchKind').innerHTML = Object.entries(BATCH).map(([k, b]) => `<option value="${k}">${b.name}</option>`).join('');
$('batchKind').onchange = () => { const b = BATCH[$('batchKind').value]; if (b.tol) $('batchTol').value = b.tol; S.batch = null; batchPanel(); draw(); };
$('batchPrev').onclick = batchPreview; $('batchApply').onclick = batchApply;
$('batchInfo').addEventListener('click', e => { const d = e.target.closest('[data-bi]'); if (!d || !S.batch) return; const x = S.batch.items[+d.dataset.bi], m = 6; fit({ x0: x.x - m, x1: x.x + m, y0: x.y - m, y1: x.y + m }); msg(x.text); refresh(); });

// ── 分幅線接合點配對（v0.29.0）：分幅線 3 m 內、彼此最近且相距 ≤ 2 m 的點對；< 0.3 m 綠（可一鍵併）、其餘黃（人工判斷）──
function seamPairs() {
  if (!S.sheet || !S.ds) return []; const k = S.undo.length + ':' + S.redo.length;
  if (S.sheet.pairKey !== k) { S.sheet.pairsPts = Core.seamPointPairs(S.ds, S.sheet, { band: 3, max: 2, ok: 0.3 }); S.sheet.pairKey = k; }
  return S.sheet.pairsPts;
}
function seamPanel() {
  if (!S.sheet) { $('seamInfo').innerHTML = '<span class="muted">先做第 2 步加入分幅線</span>'; $('seamList').innerHTML = ''; return; }
  const l = seamPairs(), ok = l.filter(p => p.level === 'ok');
  $('seamInfo').innerHTML = `接合點配對 ${l.length} 對：<b style="color:var(--ok)">< 0.3 m ${ok.length}</b>、<b style="color:#b7791f">0.3～2 m ${l.length - ok.length}</b>（圖上綠／黃線）` + (ok.length ? `　<button class="btn" id="seamMergeOk">一鍵併 < 0.3 m（${ok.length} 對）</button>` : '');
  $('seamList').innerHTML = l.slice(0, 300).map((p, i) => `<tr data-sp="${i}"><td style="color:${p.level === 'ok' ? 'var(--ok)' : '#b7791f'}">${(p.d * 100).toFixed(0)} cm</td><td>${p.from} → ${p.to}</td><td class="muted">${esc(p.sheets)}${p.edge ? '；兩點間有線' : ''}</td><td><button class="btn" data-spm="${i}">併</button></td></tr>`).join('');
  const b = $('seamMergeOk'); if (b) b.onclick = () => { if (!confirm(`分幅線接合點 < 0.3 m 的 ${ok.length} 對一鍵併點（每對留用到宗地較多的點，位置不動）？可一次復原`)) return; const r = runBatchSteps(ok.map(p => ({ ...p, text: `${p.from}→${p.to}` })), BATCH.seam.apply, '分幅線接合點併點'); msg(`接合點併點 ${r.done} 對` + (r.failed.length ? `；${r.failed.length} 對沒做：${r.failed.slice(0, 3).join('；')}` : '')); seamPanel(); refresh(); };
}
$('seamList').addEventListener('click', e => {
  const m = e.target.closest('[data-spm]'), tr = e.target.closest('[data-sp]'); if (!tr) return; const p = seamPairs()[+(m || tr).dataset[m ? 'spm' : 'sp']];
  if (m) { const r = runBatchSteps([{ ...p, text: `${p.from}→${p.to}` }], BATCH.seam.apply, `接合點 ${p.from} 併入 ${p.to}`); msg(r.done ? `點 ${p.from} 已併入 ${p.to}` : r.failed[0]); seamPanel(); refresh(); return; }
  const z = 5; fit({ x0: p.x - z, x1: p.x + z, y0: p.y - z, y1: p.y + z }); clearSel(); S.sel.pt.add(p.from); S.sel.pt.add(p.to); msg(`接合點 ${p.from}、${p.to} 相距 ${(p.d * 100).toFixed(1)} cm`); refresh();
});
function drawSeamPairs() { const l = seamPairs(); if (!l.length || S.view.s < 0.5) return; ctx.save(); ctx.lineWidth = 3;
  for (const p of l) { const a = S.ds.points.get(p.from), b = S.ds.points.get(p.to); if (!a || !b) continue; ctx.strokeStyle = p.level === 'ok' ? '#2f9e44' : '#f59f00'; ctx.beginPath(); ctx.moveTo(toSx(a.x), toSy(a.y)); ctx.lineTo(toSx(b.x), toSy(b.y)); ctx.stroke(); ctx.beginPath(); ctx.arc(toSx(a.x), toSy(a.y), 5, 0, 7); ctx.stroke(); }
  ctx.restore(); }

// ── 備註（v0.29.0）：每個地號一則，存進專案檔；輸出互動報告時帶進去，報告匯出的備註 CSV 也可匯回 ──
function notePanel() { const it = (S.tq.items || [])[S.tq.i], t = $('tqNote'); t.disabled = !it; t.value = it ? S.notes[it.label] || '' : ''; t.placeholder = it ? `${it.label} 的備註（處理方式、待查事項…）` : '跳到一筆待修項目後可寫備註'; }
$('tqNote').oninput = () => { const it = (S.tq.items || [])[S.tq.i]; if (!it) return; const v = $('tqNote').value; if (v) S.notes[it.label] = v; else delete S.notes[it.label]; projDirty(); };
const REPORT_DONE = { chk: null, missing: 'miss', area: ['area', 'neg'], occupied: 'occ' };
function reportDone() {   // 工作站的「修好了」→ 報告的「已處理」
  const out = []; for (const k of S.tq.done) { const [src, l] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)]; const cat = { miss: 'missing', neg: 'area', area: 'area', occ: 'occupied' }[src]; if (cat) out.push(cat + '|' + l); } return out;
}
async function importNotes(f) {
  try { const list = Core.parseReportNotes(await readText(f)); let n = 0, d = 0;
    for (const x of list) { if (x.note && (S.notes[x.label] || '') !== x.note && !(S.notes[x.label] || '').includes(x.note)) { S.notes[x.label] = S.notes[x.label] ? S.notes[x.label] + '／' + x.note : x.note; n++; }
      if (x.done) { const m = REPORT_DONE[x.cat]; if (x.cat === 'chk') S.chk.ok.add(x.label); else if (m) for (const s of [].concat(m)) S.tq.done.add(s + '|' + x.label); d++; } }
    projDirty(); tqPanel(); if ($('dlgChk').open) chkPanel(); refresh(); msg(`已匯入報告備註：備註 ${n} 則、已處理 ${d} 筆（共 ${list.length} 列）`);
  } catch (e) { msg('無法匯入備註：' + e.message); }
}
$('notesIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importNotes(f); };

// ── 里程碑（v0.29.0）：把目前的作業圖存成一個版本（例如步驟 6 前／後），可與目前比較差異、圖上疊出當時的界址，或還原（可復原）──
S.msView = null;   // { k, diff }
function msSave(name, quiet) {
  if (!S.ds) return null; const m = { name: name || `里程碑 ${S.ms.length + 1}`, t: new Date().toISOString(), state: Core.datasetState(S.ds), areas: S.ds.parcels.map(p => p.area), progress: projProgress(), steps: undefined };
  const old = S.ms.findIndex(x => x.name === m.name && name && /^步驟 \d/.test(name)); if (old >= 0) S.ms.splice(old, 1);   // 自動的（步驟 6 前）只留最新一份
  S.ms.push(m); if (S.ms.length > 20) S.ms.shift(); S.msDirty = true; projDirty(); if (!quiet) msg(`已存里程碑「${m.name}」`); if ($('dlgMs').open) msPanel(); return m;
}
function msPanel() {
  $('msList').innerHTML = S.ms.length ? S.ms.map((m, k) => `<tr class="${S.msView && S.msView.k === k ? 'sel' : ''}"><td><b>${esc(m.name)}</b><div class="muted">${new Date(m.t).toLocaleString()}　圖資準備 ${m.progress.prep}/6${m.progress.rows ? `、逐筆修 ${m.progress.fixed}/${m.progress.rows}` : ''}</div></td><td style="white-space:nowrap"><button class="btn" data-msc="${k}">比較</button><button class="btn" data-msr="${k}">還原</button><button class="btn" data-msd="${k}" title="刪除">✕</button></td></tr>`).join('') : '<tr><td class="muted">尚無里程碑。按「存目前為里程碑」，或執行第 6 步時自動存「步驟 6 前」。</td></tr>';
  const V = S.msView; if (!V) { $('msDiff').innerHTML = ''; return; } const d = V.diff, m = S.ms[V.k];
  $('msDiff').innerHTML = `<div><b>「${esc(m.name)}」→ 目前</b>：宗地 ${d.parcels.length} 宗有變（新增 ${d.parcels.filter(p => p.kind === '新增').length}、刪除 ${d.parcels.filter(p => p.kind === '刪除').length}）、點移動 ${d.moved.length}、新增點 ${d.added.length}、刪除點 ${d.removed.length}。圖上橘色虛線＝當時的界址</div>` +
    `<div id="tblwrap" style="max-height:260px"><table><thead><tr><th>地號</th><th>變動</th><th>當時㎡</th><th>目前㎡</th><th>差</th></tr></thead><tbody>${d.parcels.slice(0, 400).map((p, i) => `<tr data-msp="${i}"><td>${esc(p.label)}</td><td>${p.kind}</td><td>${p.a0 == null ? '—' : p.a0.toFixed(2)}</td><td>${p.a1 == null ? '—' : p.a1.toFixed(2)}</td><td>${p.a0 != null && p.a1 != null ? (p.a1 - p.a0 >= 0 ? '+' : '') + (p.a1 - p.a0).toFixed(2) : ''}</td></tr>`).join('')}</tbody></table></div>`;
}
function msCompare(k) { const m = S.ms[k]; if (!m) return; S.msView = { k, diff: Core.diffState(S.ds, m), P: new Map(m.state.points.map(q => [q.id, q])) }; msPanel(); draw(); }
function msRestore(k) {
  const m = S.ms[k]; if (!m || !confirm(`把作業圖還原成里程碑「${m.name}」（${new Date(m.t).toLocaleString()}）？\n點位與界址串回到當時；可用 Ctrl+Z 復原這次還原`)) return;
  const cur = Core.datasetState(S.ds), to = m.state; Core.applyDatasetState(S.ds, to);
  pushUndo({ undoFn: () => { Core.applyDatasetState(S.ds, cur); pruneSel(); }, redoFn: () => { Core.applyDatasetState(S.ds, to); pruneSel(); }, label: `還原里程碑「${m.name}」` });
  clearSel(); S.msView = null; msPanel(); msg(`已還原成「${m.name}」，可 Ctrl+Z 復原`);
}
function drawMs() { const V = S.msView; if (!V) return; ctx.save(); ctx.strokeStyle = '#f08c00'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath();
  for (const p of V.diff.parcels) if (p.ring0) p.ring0.forEach((id, i) => { const q = V.P.get(id); if (!q) return; i ? ctx.lineTo(toSx(q.x), toSy(q.y)) : ctx.moveTo(toSx(q.x), toSy(q.y)); if (i === p.ring0.length - 1) ctx.closePath(); });
  ctx.stroke(); ctx.restore(); }
$('msList').addEventListener('click', e => { const c = e.target.closest('[data-msc]'), r = e.target.closest('[data-msr]'), d = e.target.closest('[data-msd]');
  if (c) msCompare(+c.dataset.msc); else if (r) msRestore(+r.dataset.msr); else if (d && confirm('刪除這個里程碑？')) { S.ms.splice(+d.dataset.msd, 1); S.msView = null; S.msDirty = true; projDirty(); msPanel(); draw(); } });
$('msDiff').addEventListener('click', e => { const tr = e.target.closest('[data-msp]'); if (!tr || !S.msView) return; const p = S.msView.diff.parcels[+tr.dataset.msp], q = S.ds.parcels[p.idx];
  if (q && !q.deleted) { clearSel(); S.sel.par.add(q.idx); zoomTo([q.idx]); } else if (p.ring0) { const pts = p.ring0.map(id => S.msView.P.get(id)).filter(Boolean), xs = pts.map(q => q.x), ys = pts.map(q => q.y), m = 10; fit({ x0: Math.min(...xs) - m, x1: Math.max(...xs) + m, y0: Math.min(...ys) - m, y1: Math.max(...ys) + m }); } refresh(); });
$('btnMsSave').onclick = () => { const n = prompt('里程碑名稱', `里程碑 ${S.ms.length + 1}`); if (n != null) msSave(n.trim() || undefined); };
$('dlgMs').addEventListener('close', () => { S.msView = null; draw(); });
$('liveNext').onclick = liveNext; $('liveChk').onchange = () => { if (!$('liveChk').checked) S.live = null; livePanel(); draw(); };

// ── AI / MCP 預留介面 ─────────────────────────────────────────────────────
const findPar = q => S.ds.parcels.find(p => p.label === String(q) || p.oldLabel === String(q));
const toFile = f => { const o = new File([f.base64 ? Uint8Array.from(atob(f.base64), c => c.charCodeAt(0)) : new TextEncoder().encode(f.text || '')], f.name.split('/').pop()); o._path = f.path || f.name; return o; };   // path：相對路徑（loadProject 依資料夾分類用）
const api = {
  getState: () => ({ loaded: !!S.ds, source: S.ds && S.ds.source, points: S.ds ? S.ds.points.size : 0, parcels: S.ds ? S.ds.parcels.length : 0,
    moved_points: S.ds ? Core.movedPoints(S.ds).length : 0, control_points: S.controls.size, survey_points: S.survey.points.size, reference_lines: S.survey.lines.length,
    selection: { points: [...S.sel.pt], edges: [...S.sel.edge], parcels: S.ds ? [...S.sel.par].map(i => S.ds.parcels[i].label) : [] } }),
  setBasemap: ({ provider = 'none', opacity, cm } = {}) => { if (provider !== 'none' && !PROVIDERS[provider]) throw new Error('provider 需為 none/osm/emap/photo'); S.basemap.provider = provider; if (opacity != null) S.basemap.opacity = opacity; if (cm != null) S.basemap.cm = cm; $('bmSel').value = provider; saveBasemap(); draw(); return { ...S.basemap }; },
  toLatLon: ({ y, x }) => Core.tm2ToLatLon(y, x, S.basemap.cm),
  getVersion: () => ({ version: APP_VERSION, changelog: CHANGELOG, update: S.update }),
  checkUpdate: o => checkUpdate(o || {}),
  getView: () => ({ cx: S.view.cx, cy: S.view.cy, px_per_m: S.view.s, width: W, height: H, note: 'screen_x=(E-cx)*px_per_m+width/2, screen_y=height/2-(N-cy)*px_per_m' }),
  getParcel: ({ label }) => { const p = findPar(label); if (!p) throw new Error('找不到地號 ' + label); return { label: p.label, area: p.area, area_registered: p.areaReg, points: p.ids.map(id => { const q = S.ds.points.get(id); return { id, y: q.y, x: q.x }; }) }; },
  listParcels: () => S.ds.parcels.map(p => ({ label: p.label, old_label: p.oldLabel, area: p.area, area_before: p.areaOrig, area_ref: p.areaRef, area_registered: p.areaReg, points: p.ids })),
  select: ({ points = [], edges = [], parcels = [], add = false } = {}) => {
    if (!add) clearSel(); points.forEach(id => S.sel.pt.add(id)); edges.forEach(k => S.sel.edge.add(k));
    parcels.forEach(q => { const p = findPar(q); if (p) S.sel.par.add(p.idx); }); refresh(); return api.getState();
  },
  move: ({ dy = 0, dx = 0 } = {}) => ({ ok: moveSelection(dy, dx, 'API'), ...api.getState() }),
  // 變換目前選取（無選取且在移圖工具＝整張圖）：angle_deg 逆時針為正；pivot 省略＝移動對象中心
  transform: ({ dy = 0, dx = 0, angle_deg = 0, pivot = null } = {}) => {
    if (!S.ds) throw new Error('尚未載入圖資'); const saved = S.tool; if (!selCount()) S.tool = 'layer';
    try { const ids = moveIds(); const ok = transformSelection({ dy, dx, angle: angle_deg * Math.PI / 180, pivot: pivot || pivotOf(ids) }, 'API 變換'); return { ok, ...api.getState() }; }
    finally { S.tool = saved; refresh(); }
  },
  alignTwoPoints: ({ src, dst } = {}) => {   // src/dst 各兩點 [{y,x},{y,x}]；對象同 transform
    if (!S.ds) throw new Error('尚未載入圖資'); const ids = selCount() ? effectiveIds() : new Set(S.ds.points.keys());
    const f = Core.twoPointFit(src[0], src[1], dst[0], dst[1]); transformSelectionIds(ids, f.T, 'API 對位'); refresh();
    return { angle_deg: f.angle * 180 / Math.PI, scale: f.scale, shift_m: Math.hypot(f.T.dy, f.T.dx) };
  },
  // 已知點（先匯入才能匯入 MAC）：text 為 CTL/CT2/CEN/L02 內容
  importControls: ({ text, source = 'API' }) => { const r = Core.parseCtl(text); const a = addControls(r.points, source); refresh(); return { ...a, code: r.code, skipped: r.skipped.length }; },
  listControls: () => [...S.controls.values()].map(p => ({ name: p.name, y: p.y, x: p.x, source: p.src })),
  importMac: ({ text }) => { const r = importMac(text); refresh(); return r; },
  importSurveyPoints: ({ text, order = 'auto' }) => importSurvey('xy', text, { order }),
  importPolar: opts => importSurvey('polar', opts.text, opts),
  addSurveyPoints: pts => { const names = addSurveyPoints(pts); refresh(); return names; },
  listSurveyPoints: () => [...S.survey.points.values()].map(p => ({ name: p.name, y: p.y, x: p.x, h: p.h, code: p.code })),
  addLine: ({ points, closed = false, name } = {}) => { const l = addLine(points, { closed, name }); refresh(); return l && { id: l.id, name: l.name, points: l.points, closed: l.closed, ...Core.lineStats(S.survey, l) }; },
  listLines: () => S.survey.lines.map(l => ({ id: l.id, name: l.name, points: l.points, closed: l.closed, ...Core.lineStats(S.survey, l) })),
  deleteLine: ({ id }) => deleteLine(id),
  // ── 鄰段接合（MCP）：listNeighbors → addNeighbor → joinSeam（自動接合並回傳報告）／checkSeam（只檢查）→ getSeamReport ──
  listNeighbors: () => S.nb.map(n => ({ name: n.name, source: n.ds.source, parcels: n.ds.parcels.length, points: n.ds.points.size, boundary_points: n.seg.vids.size, visible: n.visible, mode: n.mode, color: n.color })),
  // files: [{name:'KC1120.D14', base64:'…'} | {name:'KC1120.BNP', text:'…'}]，需 D14+D13（建議 D11、D12）或 COA+BNP
  addNeighbor: ({ files = [] } = {}) => loadNeighbors(files.map(toFile)),
  // ── 接圖前比對（MCP）：addBaseline（每次一組，可多個資料夾）→ compareBaseline（遺漏＋面積超限）→ getBaselineReport ──
  addBaseline: ({ files = [] } = {}) => loadBaseline(files.map(toFile)),
  restoreMissing: ({ labels } = {}) => { if (!S.bl.res) blRun(); const all = S.bl.res.missing, pick = labels ? all.filter(m => labels.map(String).includes(m.label)) : all.slice(); return blFix(pick, false); },
  // ── 所有權人分析（MCP）：loadOwners({files:[EXAM.MDB]}) → getOwnerReport()（不含姓名）／getParcelOwners({label})（含姓名）／findOwner({name}) ──
  loadOwners: async ({ files = [] } = {}) => { const f = files.map(toFile)[0]; if (!f) throw new Error('請給 MDB 檔'); await loadOwners(f, true); return api.getOwnerReport(); },
  getOwnerReport: () => { if (!S.owner || !S.ds) return null; const r = S.owner.res || ownRun(); return { source: S.owner.name, counts: r.counts, no_owner: r.noOwner.map(({ idx, ...x }) => x), in_register_not_on_map: r.noLand, share_not_one: r.shareBad.map(({ idx, ...x }) => x) }; },
  getParcelOwners: ({ label }) => { if (!S.owner) throw new Error('尚未載入 EXAM.MDB'); const p = S.ds.parcels.find(q => !q.deleted && (q.label === String(label) || q.oldLabel === String(label))); if (!p) throw new Error('找不到地號 ' + label); return { label: p.label, land: S.owner.ot.land.get(p.key) || null, rights: S.owner.ot.own.get(p.key) || [] }; },
  findOwner: ({ name }) => { if (!S.owner) throw new Error('尚未載入 EXAM.MDB'); return Core.findOwner(S.ds, S.owner.ot, name).map(i => S.ds.parcels[i].label); },
  clearBaseline: () => { S.bl = { sets: [], res: null, focus: null }; refresh(); return { sets: 0 }; },
  compareBaseline: (o = {}) => { const r = blRun(o); return api.getBaselineReport(); },
  // ── 作業流程（MCP）：listSteps → loadProject → runStep（3～6）或 runSteps；舊圖檢核 checkOldMap → getCheckReport → fixSliver／confirmCheck ──
  getProgress: () => projProgress(),
  getLog: ({ limit = 200 } = {}) => S.log.slice(-limit),
  liveCheck: () => S.live || { issues: [] },
  batchFind: ({ kind, tol } = {}) => { const b = BATCH[kind]; if (!b) throw new Error('kind 需為 ' + Object.keys(BATCH).join('/')); return b.find(tol || b.tol).map(x => ({ text: x.text, x: x.x, y: x.y })); },
  batchApply: ({ kind, tol } = {}) => { const b = BATCH[kind]; if (!b) throw new Error('kind 需為 ' + Object.keys(BATCH).join('/')); const r = runBatchSteps(b.find(tol || b.tol), b.apply, b.name); refresh(); return r; },
  seamPointPairs: () => seamPairs().map(p => ({ from: p.from, to: p.to, dist_m: p.d, level: p.level, sheets: p.sheets })),
  saveMilestone: ({ name } = {}) => { const m = msSave(name, true); return { name: m.name, t: m.t }; },
  listMilestones: () => S.ms.map((m, i) => ({ index: i, name: m.name, t: m.t, progress: m.progress })),
  compareMilestone: ({ index }) => { const m = S.ms[index]; if (!m) throw new Error('沒有這個里程碑'); const d = Core.diffState(S.ds, m); return { parcels: d.parcels.map(p => ({ label: p.label, kind: p.kind, area_then: p.a0, area_now: p.a1 })), moved: d.moved.length, added: d.added.length, removed: d.removed.length }; },
  setNote: ({ label, note }) => { if (note) S.notes[label] = note; else delete S.notes[label]; projDirty(); return { label, note: S.notes[label] || '' }; },
  addSheetLines: () => ({ text: sheetRun(), pairs: S.sheet.pairs, length_m: S.sheet.length }),
  listSheetParcels: ({ dist } = {}) => { if (!S.sheet) throw new Error('尚未加入分幅線（步驟 2）'); if (dist) $('sheetDist').value = dist; return sheetNear().map(q => ({ label: q.label, dist_m: q.dist, sheets: q.pair })); },
  saveProjectJson: async ({ images = false } = {}) => projFile(images),   // 回傳專案檔內容（物件）；存檔請用介面的「儲存專案檔」
  openProjectJson: async ({ project }) => openProjectData(typeof project === 'string' ? JSON.parse(project) : project),
  listSteps: () => STEPS.map(s => { const r = stepStatus(s); return { step: s.n, title: s.title, description: s.desc, runnable: !!s.run, status: r.st, result: r.text || '' }; }),
  loadProject: async ({ files = [] } = {}) => loadProject(files.map(toFile)),   // files：[{ path:'KC0336/KC0336.D14', base64 }]，依路徑分類主要測區／鄰段／分幅／影像
  runStep: ({ step }) => runStep(step),
  runSteps: ({ from = 3, to = 6 } = {}) => runSteps(from, to),
  checkOldMap: async ({ tol, ink_tol, shift, images } = {}) => { const o = {}; if (tol != null) o.tol = tol; if (ink_tol != null) o.inkTol = ink_tol; if (shift != null) o.shift = shift; if (images) o.images = images; await runCheck(o); return api.getCheckReport(); },
  getCheckReport: ({ limit = 200 } = {}) => { const r = S.chk.res; if (!r) return null; const f = v => (v == null ? null : Math.round(v * 100) / 100);
    return { counts: chkCounts(), sources: { baselines: r.sets, images: r.images }, image_shift_median_m: r.ink ? f(r.ink.shiftMedian) : null, image_error: r.inkErr || null,
      baseline: r.bl ? { missing: r.bl.missing.map(m => m.label), area_flagged: r.bl.flagged.map(x => x.label) } : null,
      rows: r.rows.slice(0, limit).map(x => ({ label: x.label, area: f(x.area), level: x.level || 'sliver', sliver: x.sliver, confirmed: S.chk.ok.has(x.label),
        vector: x.vec ? { off_m: f(x.vec.offLen), inner_m: f(x.vec.innerLen), max_dev_m: f(x.vec.maxDev), shift_m: f(Math.hypot(x.vec.shift.dx, x.vec.shift.dy)) } : null,
        image: x.img ? { no_ink_m: f(x.img.offLen), checked_m: f(x.img.checked) } : null, suggestion: x.fix ? { merge_into: x.fix.label, reason: x.fix.why } : null })) }; },
  fixSliver: ({ label }) => { const x = S.chk.res && S.chk.res.rows.find(r => r.label === String(label)); if (!x) throw new Error('檢核結果沒有 ' + label); return applySliverFix(x); },
  confirmCheck: ({ label, confirmed = true }) => { if (!S.chk.res) throw new Error('尚未檢核'); confirmed ? S.chk.ok.add(String(label)) : S.chk.ok.delete(String(label)); chkPanel(); draw(); return { confirmed: [...S.chk.ok] }; },
  exportReportHtml: ({ negOnly = false } = {}) => reportHtml(negOnly),
  fixOldMap: () => fixOldMap({ report: false }),   // 第 6 步一鍵修正（遺漏切回、較差為負補回、碎片併入），回傳結果；報告另以 exportReportHtml({negOnly:true}) 取得
  restoreShortfall: ({ label }) => { if (!S.bl.res) blRun(); const x = S.bl.res.area.find(a => a.label === String(label)); if (!x) throw new Error('沒有 ' + label + ' 的面積比對'); const g = Core.restoreShortfall(S.ds, { ...x, rings: x.rings && x.rings.length ? x.rings : (S.bl.res.flagged.find(f => f.label === x.label) || {}).rings }); pushStruct(g.delta, `面積不足補回 ${label}`); blRun(); return { label, gain: g.gain, from: g.from }; },   // 接圖前比對＋舊圖檢核的互動報告（HTML 字串）
  // ── 點線面編修（MCP）：與工具箱同一組核心；每個都可 undo ──
  snapPointToEdge: ({ id, a, b }) => { const r = Core.snapPointToEdge(S.ds, id, a, b), d = r.delta, setXY = q => { const p = S.ds.points.get(id); p.y = q.y; p.x = q.x; }; pushUndo({ undoFn: () => { setXY(r.from); Core.applyDelta(S.ds, d, 'undo'); }, redoFn: () => { setXY(r.to); Core.applyDelta(S.ds, d, 'redo'); }, label: `點 ${id} 貼到線 ${a}–${b}` }); return { moved_m: r.dist, parcels: parLabels(d) }; },
  mergePoints: ({ from, to }) => { const r = Core.mergePoints(S.ds, from, to); pushStruct(r.delta, `點 ${from} 併入 ${to}`); return { parcels: parLabels(r.delta) }; },
  splitByChord: ({ parcel, a, b }) => { const p = findPar(parcel); if (!p) throw new Error('找不到地號 ' + parcel); const r = Core.splitByChord(S.ds, p.idx, a, b); pushStruct(r.delta, `新增線 ${a}–${b}`); return { keep: r.keep, created: r.created }; },
  deleteEdge: ({ a, b }) => { const r = Core.deleteEdge(S.ds, a, b); pushStruct(r.delta, `刪除線 ${a}–${b}`); return { keep: r.keep, merged: r.merged }; },
  addFace: ({ ids, mother = 9001 }) => { const r = Core.addFace(S.ds, ids, mother); pushStruct(r.delta, `新增面 ${r.label}`); return { label: r.label }; },
  getBaselineReport: () => { const r = S.bl.res; if (!r) return null; const strip = l => l.map(({ rings, ...x }) => x);
    return { ...r, missing: strip(r.missing), partial: strip(r.partial), unreg: strip(r.unreg), occupied: strip(r.occupied), area: undefined, flagged: strip(r.flagged), sets: S.bl.sets.map(s => s.name) }; },

  removeNeighbor: ({ name }) => { const i = S.nb.findIndex(n => n.name.toLowerCase() === String(name).toLowerCase()); if (i < 0) throw new Error('找不到鄰段 ' + name); S.nb.splice(i, 1); S.seam = null; refresh(); return api.listNeighbors(); },
  setNeighbor: ({ name, visible, mode, authoritative }) => { const n = S.nb.find(n => n.name.toLowerCase() === String(name).toLowerCase()); if (!n) throw new Error('找不到鄰段 ' + name); if (visible != null) n.visible = !!visible;   // mode：numeric 數值區／graphic 圖解區／none 只比對（authoritative 為舊參數）
    if (mode != null) { if (!NB_MODE[mode]) throw new Error('mode 需為 numeric／graphic／none'); n.mode = mode; n.shift = null; } else if (authoritative != null) n.mode = authoritative ? 'numeric' : 'none'; S.seamStale = !!S.seam; refresh(); return api.listNeighbors(); },
  // 參數：tol 重合容差、search 搜尋距離、snap 吸附上限（公尺）；省略用畫面上的設定
  checkSeam: o => runSeam(o || {}),
  joinSeam: o => joinSeam(o || {}),
  getSeamReport: ({ format = 'json' } = {}) => { if (!S.seam) throw new Error('尚未檢查接合'); return format === 'text' ? Core.seamReportText(S.seam) : format === 'csv' ? Core.seamReportCsv(S.seam) : S.seam; },
  // 載入／輸出案件（AI 不能用檔案選擇器）：files 同 addNeighbor；exportD14 回傳 {name, base64, moved}
  loadCase: async ({ files = [] } = {}) => ({ ok: await loadFiles(files.map(toFile)), ...api.getState() }),
  exportD14: () => { if (!S.dbf.pts) throw new Error('主要測區不是由 D14 載入'); const r = Core.exportD14(S.dbf.pts, S.ds); let bin = ''; for (let i = 0; i < r.bytes.length; i += 8192) bin += String.fromCharCode.apply(null, r.bytes.subarray(i, i + 8192)); return { name: S.names.d14 || 'out.D14', base64: btoa(bin), moved: Core.movedPoints(S.ds).length }; },
  exportMovedCsv: () => Core.movedPointsCsv(S.ds, S.seam && S.seam.join),
  // 效能診斷：連續繪製 n 次的平均毫秒
  benchRender: ({ n = 10 } = {}) => { const t0 = performance.now(); for (let i = 0; i < n; i++) render(); ctx.getImageData(0, 0, 1, 1); return { ms_per_frame: (performance.now() - t0) / n }; },
  // ── 影像疊圖：addImage 以 base64 影像＋定位檔文字載入；setImage 可用 dy/dx 相對平移，或 y/x 指定左上像元中心 ──
  listImages: () => S.img.map((im, i) => ({ name: im.name, width: im.w, height: im.h, located: im.located, visible: im.visible, opacity: im.opacity, above_vectors: !!im.above, layer: i, active: im === imgActive(), origin: { y: im.wf.f, x: im.wf.c }, shift_m: Math.hypot(im.wf.c - im.wf0.c, im.wf.f - im.wf0.f), bounds: imgBox(im) })),
  // 載入多張時預設不顯示；單張預設顯示。layer 數字越大越上層
  addImage: ({ name, base64, wld, wld_name }) => loadImages([toFile({ name, base64 }), ...(wld ? [toFile({ name: wld_name || name.replace(/\.\w+$/, '') + '.jgw', text: wld })] : [])]),
  setImage: ({ name, visible, opacity, above_vectors, layer_move, dy, dx, y, x }) => {   // layer_move: up/down/top/bottom
    const im = S.img.find(q => q.name.toLowerCase() === String(name).toLowerCase()); if (!im) throw new Error('找不到影像 ' + name);
    if (visible != null) setImgVisible(im, !!visible); if (opacity != null) im.opacity = Math.min(1, Math.max(0.05, opacity)); if (above_vectors != null) im.above = !!above_vectors; if (layer_move) moveImgLayer(im, layer_move);
    if (dy != null || dx != null || y != null || x != null) { const c0 = im.wf.c, f0 = im.wf.f; setImgPos(im, x != null ? x : c0 + (dx || 0), y != null ? y : f0 + (dy || 0)); pushImgUndo(im, c0, f0, im.wf.c, im.wf.f); }
    refresh(); return api.listImages();
  },
  removeImage: ({ name }) => { const im = S.img.find(q => q.name.toLowerCase() === String(name).toLowerCase()); if (!im) throw new Error('找不到影像 ' + name); removeImage(im); return api.listImages(); },
  exportWorldFile: ({ name }) => { const im = S.img.find(q => q.name.toLowerCase() === String(name).toLowerCase()); if (!im) throw new Error('找不到影像 ' + name); return Core.worldFileText(im.wf); },
  // ── 界址點編修：addPoint（edge=[a,b] 加在該線並同步插入所有鄰接宗地；省略 edge＝孤立點）、deletePoints、cleanupPoints（preview 只算不改）──
  addPoint: ({ edge = null, y, x, project = true } = {}) => { const r = addPoint({ edge, y, x, project }); refresh(); return r; },
  deletePoints: ({ ids = [] } = {}) => { const r = deletePoints(ids); refresh(); return r; },
  cleanupPoints: ({ preview = false, unused = true, collinear = true, ratio_permille = 30, max_abs_m = 0.5, seam = true } = {}) => {
    if (!S.ds) throw new Error('尚未載入圖資'); const o = { unused, collinear, ratio: ratio_permille / 1000, maxAbs: max_abs_m };
    if (seam && S.nb.length) { const g = Core.seamGuard(S.ds, nbArgs(), seamOpts()); o.protect = g.protect; o.adds = g.adds; o.tol = g.tol; }
    const r = Core.cleanupPoints(S.ds, o);
    if (preview) Core.applyDelta(S.ds, r.delta, 'undo'); else if (r.unused.length || r.collinear.length || r.added.length) { pushStruct(r.delta, '清理多餘點'); pruneSel(); } else Core.applyDelta(S.ds, r.delta, 'undo');
    refresh(); return { preview, added: r.added, unused: r.unused, collinear: r.collinear, kept_for_seam: r.kept, blocked: r.blocked, skipped: r.skipped, skipped_adds: r.skippedAdds };
  },
  exportErrReport: () => { if (!S.ds) throw new Error('尚未載入圖資'); return errReportText(); },
  ringIssues: () => { if (!S.ds) throw new Error('尚未載入圖資'); return Core.ringIssues(S.ds).map(o => ({ kind: o.kind, parcel: S.ds.parcels[o.p].label, inner: o.h != null ? S.ds.parcels[o.h].label : null, text: Core.ringIssueLine(S.ds, o), jumps: o.jumps || null })); },
  splitHole: ({ outer, inner }) => { const f = l => { const p = S.ds.parcels.find(q => q.label === l || q.oldLabel === l); if (!p) throw new Error('找不到地號 ' + l); return p.idx; }; const pi = f(outer), r = Core.splitHole(S.ds, pi, f(inner)); pushStruct(r.delta, `拆出地中地 ${inner}`); return { area: S.ds.parcels[pi].area, jumps: r.jumps, linked: r.linked }; },
  unregSummary: ({ maxPts = 30, maxRatio = 6, minArea = 0 } = {}) => { const r = Core.unregSummary(S.ds, maxPts, maxRatio, minArea); return { parcels: r.parcels.map(p => ({ label: p.label, points: p.pts, ratio: p.ratio, area: p.area, over: p.over, tooLong: p.long })), gaps: r.gaps.map(g => ({ points: g.ids, area: g.area })) }; },
  absorbSlivers: ({ minArea = 50 } = {}) => { const r = Core.absorbSlivers(S.ds, minArea); pushMulti(r.deltas, '碎塊併入相鄰未登記地'); refresh(); return { merged: r.merged, left: r.left }; },
  splitParcel: ({ parcel, maxPts = 30, maxRatio = 6, minArea = 0 }) => { const p = findPar(parcel); if (!p) throw new Error('找不到地號 ' + parcel); const r = Core.splitParcel(S.ds, p.idx, maxPts, maxRatio, { minArea }); if (r.delta) pushStruct(r.delta, `分割 ${parcel}`); return { pieces: r.pieces, addedPoints: r.delta ? r.delta.added.map(q => q.id) : [], unresolved: r.unresolved }; },
  mergeParcels: ({ parcels }) => { const idx = parcels.map(l => { const p = findPar(l); if (!p) throw new Error('找不到地號 ' + l); return p.idx; }); const r = Core.mergeParcels(S.ds, idx); pushStruct(r.delta, '合併 ' + parcels.join('、')); return { keep: r.keep, merged: r.merged }; },
  seamGaps: () => { if (!S.ds) throw new Error('尚未載入圖資'); return Core.seamGaps(S.ds, nbArgs()).map(g => ({ area: g.area, points: g.nodes.length, new_points: g.nodes.filter(n => n.id == null).length })); },
  fillSeamGaps: ({ mother = 9001 } = {}) => { const ds = S.ds, deltas = [], labels = []; for (const g of Core.seamGaps(ds, nbArgs())) { const r = Core.fillSeamGap(ds, g, mother); deltas.push(r.delta); labels.push(r.label); } pushMulti(deltas, '與鄰段之間的空隙建為新地號'); return { labels }; },
  closePocket: ({ chords, mother = 9001 }) => { const g = Core.pocketRegion(S.ds, chords), r = Core.fillRegion(S.ds, g.ids, mother); pushStruct(r.delta, `凹口建為 ${r.label}`); return { label: r.label, area: g.area, points: g.ids.length }; },
  deleteParcel: ({ parcel }) => { const p = findPar(parcel); if (!p) throw new Error('找不到地號 ' + parcel); const r = Core.deleteParcel(S.ds, p.idx); pushStruct(r.delta, `刪除宗地 ${parcel}`); return { into: r.into, removedPoints: r.removedPoints }; },
  deleteHoleParcel: ({ parcel }) => { const p = findPar(parcel); if (!p) throw new Error('找不到地號 ' + parcel); const r = Core.deleteHoleParcel(S.ds, p.idx); pushStruct(r.delta, `刪除地中地 ${parcel}`); return { into: r.into, removedPoints: r.removedPoints }; },
  pointsToLine: ({ ids, a, b }) => { const r = pointsToLine(ids, a, b); return { moved: r.moved, skipped: r.skipped }; },
  setRing: ({ parcel, ids }) => { const p = S.ds.parcels.find(q => q.label === parcel || q.oldLabel === parcel); if (!p) throw new Error('找不到地號 ' + parcel); const r = Core.setRing(S.ds, p.idx, ids); pushStruct(r.delta, `重繪界址串 ${parcel}`); return { area: p.area, points: p.ids.length }; },
  exportD13: () => { if (!S.dbf.bnd) throw new Error('主要測區不是由 D13 載入'); const r = Core.exportD13(S.dbf.bnd, S.ds); let bin = ''; for (let i = 0; i < r.bytes.length; i += 8192) bin += String.fromCharCode.apply(null, r.bytes.subarray(i, i + 8192)); return { name: S.names.d13, base64: btoa(bin), parcels: r.parcels, rewritten: r.rewritten, appended: r.appended }; },
  getStyle: () => cloneStyle(S.style), setStyle: (patch = {}) => { for (const k of Object.keys(patch)) if (S.style[k]) Object.assign(S.style[k], patch[k]); saveStyle(); draw(); return cloneStyle(S.style); },
  undo: () => (undo(), api.getState()), redo: () => (redo(), api.getState()),
  exportSession: () => Core.exportSession(S.ds || Core.newDataset('', ''), { files: S.names, control_points: [...S.controls.values()].map(p => ({ name: p.name, y: p.y, x: p.x, source: p.src })), neighbors: S.nb.map(n => n.name), seam_report: S.seam }, S.survey),
  // 待修清單（給 AI 逐筆修）：source 同工具箱下拉 chk／neg／area／unreg／ring／sheet；省略＝目前選的
  listFixQueue: ({ source, limit = 100 } = {}) => { tqSetSrc(source); const l = tqLive(); return { source: $('tqSrc').value, total: l.length, items: l.slice(0, limit).map(x => ({ label: x.label, text: x.text, note: S.notes[x.label] || '' })) }; },
  gotoFixItem: ({ source, label }) => { tqSetSrc(source); const l = tqLive(), i = l.findIndex(x => x.label === String(label)); if (i < 0) throw new Error('待修清單沒有 ' + label); S.tq.i = i; tqGo(0); return { ...l[i], rings: undefined, key: undefined, position: `${i + 1} / ${l.length}` }; },
  markFixed: ({ source, label, note }) => { tqSetSrc(source); const it = tqLive().find(x => x.label === String(label)); if (!it) throw new Error('待修清單沒有 ' + label); if (note) S.notes[it.label] = S.notes[it.label] ? S.notes[it.label] + '／' + note : note;
    if (it.key.startsWith('chk|')) S.chk.ok.add(it.label); else S.tq.done.add(it.key); projDirty(); tqPanel(); refresh(); return { label: it.label, remaining: tqLive().length }; },
  listMethods: () => Object.keys(api).map(m => ({ method: m, modifies: !aiReadOnly(m) })),
};
window.CadastralAPI = api;
// ── AI 橋接（MCP）：頁面主動連到本機 tools/mcp-bridge.mjs 的 WebSocket，收 {id,method,params}、回 {id,result|error} ──
// 權限由使用者在「說明 → 連接 AI（MCP）」決定：唯讀／每次問我／直接修改。AI 的每個修改都進作業紀錄、可 Ctrl+Z
const AI_READ = /^(get|list|find|check|compare|export|toLatLon|liveCheck|batchFind|seamPointPairs|seamGaps|ringIssues|unregSummary|saveProjectJson|benchRender|select|gotoFixItem|setBasemap|setStyle)/;
function aiReadOnly(m) { return AI_READ.test(m) && m !== 'checkUpdate'; }
const AI = { ws: null, want: false, mode: 'ask', url: 'ws://127.0.0.1:8765', calls: [], timer: null };
try { const j = JSON.parse(localStorage.getItem('cw.ai') || 'null'); if (j) { if (j.url) AI.url = j.url; if (['read', 'ask', 'write'].includes(j.mode)) AI.mode = j.mode; } } catch (e) { /* ignore */ }
const aiSave = () => { try { localStorage.setItem('cw.ai', JSON.stringify({ url: AI.url, mode: AI.mode })); } catch (e) { /* ignore */ } };
function aiPanel() {
  const st = AI.ws && AI.ws.readyState === 1 ? '<b style="color:#2f9e44">已連線</b>' : AI.want ? '<span style="color:#f59f00">連線中…（請先在本機啟動 MCP 橋接程式）</span>' : '<span class="muted">未連線</span>';
  $('aiStatus').innerHTML = st; $('aiConn').textContent = AI.want ? '中斷' : '連線'; $('aiUrl').value = AI.url; $('aiMode').value = AI.mode;
  $('aiCalls').innerHTML = AI.calls.slice().reverse().map(c => `<tr><td>${c.t}</td><td>${esc(c.method)}</td><td>${c.modifies ? '改圖' : '讀取'}</td><td>${c.err ? `<span style="color:#e03131" title="${esc(c.err)}">${esc(c.err.length > 30 ? c.err.slice(0, 30) + '…' : c.err)}</span>` : c.ok ? '完成' : '…'}</td></tr>`).join('') || '<tr><td class="muted">還沒有 AI 呼叫</td></tr>';
}
function aiConnect() {
  clearTimeout(AI.timer); if (!AI.want) return; let ws; try { ws = new WebSocket(AI.url); } catch (e) { msg('AI 橋接位址不正確：' + e.message); AI.want = false; aiPanel(); return; }
  AI.ws = ws;
  ws.onopen = () => { msg('AI 橋接已連線'); ws.send(JSON.stringify({ hello: 'cadastral-resurvey-workstation', version: APP_VERSION, mode: AI.mode })); aiPanel(); };
  ws.onclose = () => { if (AI.ws === ws) AI.ws = null; if (AI.want) AI.timer = setTimeout(aiConnect, 3000); aiPanel(); };
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id == null || !m.method) return;
    const modifies = !aiReadOnly(m.method), c = { t: new Date().toTimeString().slice(0, 8), method: m.method, modifies }; AI.calls.push(c); if (AI.calls.length > 50) AI.calls.shift();
    const reply = o => { if (ws.readyState === 1) ws.send(JSON.stringify({ id: m.id, ...o })); if ($('dlgAi').open) aiPanel(); };
    Promise.resolve().then(() => {
      if (typeof api[m.method] !== 'function') throw new Error('沒有這個方法：' + m.method + '（用 listMethods 看清單）');
      if (modifies && AI.mode === 'read') throw new Error('使用者設定為唯讀：AI 不能修改圖資（' + m.method + '）。請使用者在「說明 → 連接 AI」改成「每次問我」或「直接修改」');
      if (modifies && AI.mode === 'ask' && !confirm(`AI 要執行：${m.method}\n${JSON.stringify(m.params || {}).slice(0, 400)}\n\n允許嗎？（之後可 Ctrl+Z 復原）`)) throw new Error('使用者拒絕了這個修改（' + m.method + '）');
      return api[m.method](m.params);
    }).then(result => { c.ok = true; reply({ result: result === undefined ? null : result }); }, err => { c.err = String(err && err.message || err); reply({ error: c.err }); });
    if ($('dlgAi').open) aiPanel(); };
}
$('aiConn').onclick = () => { AI.url = $('aiUrl').value.trim() || AI.url; aiSave(); if (AI.want) { AI.want = false; clearTimeout(AI.timer); if (AI.ws) AI.ws.close(); } else { AI.want = true; aiConnect(); } aiPanel(); };
$('aiMode').onchange = () => { AI.mode = $('aiMode').value; aiSave(); if (AI.ws && AI.ws.readyState === 1) AI.ws.send(JSON.stringify({ hello: 'mode', mode: AI.mode })); aiPanel(); };
const bridge = new URLSearchParams(location.search).get('bridge');
if (bridge) { AI.url = bridge; AI.want = true; aiConnect(); }   // 例：?bridge=ws://127.0.0.1:8765（網址指定時沿用上次的權限，預設每次問我）
resize(); panel();
})();
