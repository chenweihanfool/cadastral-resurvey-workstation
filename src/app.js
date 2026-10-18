/* app.js — 介面與互動。UI 與 AI/外部橋接共用同一組操作函式（見檔尾 CadastralAPI）。 */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const cv = $('cv'); let ctx = cv.getContext('2d');
const NL = String.fromCharCode(10);
const APP_VERSION = CHANGELOG[0].version;
const REPO = 'chenweihanfool/cadastral-resurvey-workstation';

const S = {
  ds: null, ref: null, dbf: { pts: null }, names: {},
  nb: [], seam: null, seamStale: false,      // 鄰段 [{name,ds,color,visible,authoritative,seg}]；接合檢查報告
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
  if (S.filter.edge) {
    let best = null, bd = 6 * px;
    for (const e of ds.edges.values()) {
      const a = ds.points.get(e.a), b = ds.points.get(e.b);
      const d = Core.distToSeg(wx, wy, a.x, a.y, b.x, b.y);
      if (d < bd) { bd = d; best = e; }
    }
    if (best) return { t: 'edge', k: best.key };
  }
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
function pushUndo(e) { S.seamStale = true; S.undo.push(e); if (S.undo.length > 500) S.undo.shift(); S.redo.length = 0; refresh(); }
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
function undo() { S.seamStale = true; const e = S.undo.pop(); if (!e) return; e.undoFn ? e.undoFn() : applyEntries(e.before); S.redo.push(e); refresh(); }
function redo() { S.seamStale = true; const e = S.redo.pop(); if (!e) return; e.redoFn ? e.redoFn() : applyEntries(e.after); S.undo.push(e); refresh(); }
function resetAll() { if (!S.ds) return; Core.resetAll(S.ds); S.undo.length = 0; S.redo.length = 0; refresh(); }

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
function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H);
  drawBasemap(); ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const ds = S.ds, sc = S.view.s;
  const cEdge = css('--edge'), cRef = css('--ref'), cSel = css('--sel'), cHov = css('--hover'), cChg = css('--changed'), cBad = css('--bad'), cSv = css('--survey');
  const tracePoly = (d, ids) => { ctx.beginPath(); ids.forEach((id, i) => { const p = d.points.get(id); i ? ctx.lineTo(toSx(p.x), toSy(p.y)) : ctx.moveTo(toSx(p.x), toSy(p.y)); }); ctx.closePath(); };
  // 舊圖
  if (S.ref && $('chkRef').checked) {
    ctx.strokeStyle = cRef; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.beginPath();
    for (const e of S.ref.edges.values()) { if (e.arcPart) continue; const a = S.ref.points.get(e.a), b = S.ref.points.get(e.b); ctx.moveTo(toSx(a.x), toSy(a.y)); ctx.lineTo(toSx(b.x), toSy(b.y)); }
    ctx.stroke(); ctx.setLineDash([]); strokeArcs(S.ref, cRef, 1, [5, 4]);
  }
  for (const n of S.nb) if (n.visible) drawNeighbor(n);
  if (ds) {
    // 已變動宗地底色
    ctx.fillStyle = cChg;
    for (const p of ds.parcels) if (Math.abs(p.area - p.areaOrig) > 1e-6) { tracePoly(ds, p.ids); ctx.fill(); }
    // 選取/懸停宗地
    ctx.fillStyle = cSel + '33';
    for (const i of S.sel.par) { tracePoly(ds, ds.parcels[i].ids); ctx.fill(); }
    if (S.hover && S.hover.t === 'par') { ctx.fillStyle = cHov + '22'; tracePoly(ds, ds.parcels[S.hover.k].ids); ctx.fill(); }
    // 邊
    ctx.strokeStyle = cEdge; ctx.lineWidth = 1; ctx.beginPath();
    for (const e of ds.edges.values()) { if (e.arcPart) continue; const a = ds.points.get(e.a), b = ds.points.get(e.b); ctx.moveTo(toSx(a.x), toSy(a.y)); ctx.lineTo(toSx(b.x), toSy(b.y)); }
    ctx.stroke(); strokeArcs(ds, cEdge, 1);
    const strokeEdges = (keys, color, w) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
      for (const k of keys) { const e = ds.edges.get(k); if (!e) continue; const a = ds.points.get(e.a), b = ds.points.get(e.b); ctx.moveTo(toSx(a.x), toSy(a.y)); ctx.lineTo(toSx(b.x), toSy(b.y)); } ctx.stroke(); };
    strokeEdges(S.sel.edge, cSel, 3);
    if (S.hover && S.hover.t === 'edge') strokeEdges([S.hover.k], cHov, 3);
    for (const i of S.sel.par) { ctx.strokeStyle = cSel; ctx.lineWidth = 2; tracePoly(ds, ds.parcels[i].ids); ctx.stroke(); }
    // 點
    if (sc > 0.6) {
      const r = sc > 8 ? 3 : 1.6;
      for (const p of ds.points.values()) {
        const sx = toSx(p.x), sy = toSy(p.y); if (sx < -5 || sy < -5 || sx > W + 5 || sy > H + 5) continue;
        ctx.fillStyle = Core.isMoved(p) ? cBad : cEdge; ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      }
    }
    const eff = selCount() ? effectiveIds() : [];
    ctx.fillStyle = cSel; for (const id of eff) { const p = ds.points.get(id); if (!p) continue; ctx.fillRect(toSx(p.x) - 4, toSy(p.y) - 4, 8, 8); }
    if (S.seam && $('chkSeam').checked && !S.printing) drawSeam();
    if (S.hover && S.hover.t === 'pt') { const p = ds.points.get(S.hover.k); ctx.strokeStyle = cHov; ctx.lineWidth = 2; ctx.strokeRect(toSx(p.x) - 6, toSy(p.y) - 6, 12, 12); }
    // 標註
    if ($('chkLabel').checked) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (sc > 1.2) {
        ctx.font = `${Math.min(15, Math.max(9, sc * 1.6))}px sans-serif`; ctx.fillStyle = cEdge;
        for (const p of ds.parcels) {
          const c = Core.centroidOf(ds.points, p.ids), sx = toSx(c.x), sy = toSy(c.y); if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
          ctx.fillText(p.label, sx, sy);
        }
      }
      // 圖上面積較差：有變動或已選取的宗地，在地號下方標示 Δ（紅=超過警示值）
      if ($('chkDelta').checked && sc > 0.25) {
        const mode = $('deltaMode').value, tol = parseFloat($('tol').value) || 0, bg = css('--canvas');
        ctx.font = `bold ${Math.min(14, Math.max(9, sc * 1.4))}px sans-serif`; ctx.textAlign = 'center'; ctx.lineJoin = 'round'; ctx.lineWidth = 3;
        for (const p of ds.parcels) {
          const changed = Math.abs(p.area - p.areaOrig) > 1e-6;
          if (!changed && !S.sel.par.has(p.idx)) continue;
          const base = mode === 'reg' ? p.areaReg : p.areaOrig; if (base == null) continue;
          const d = p.area - base, c = Core.centroidOf(ds.points, p.ids);
          const sx = toSx(c.x), sy = toSy(c.y) + Math.min(15, Math.max(9, sc * 1.6)) + 1; if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
          const t = (d >= 0 ? '+' : '') + d.toFixed(2);
          ctx.strokeStyle = bg; ctx.strokeText(t, sx, sy); ctx.fillStyle = Math.abs(d) > tol ? cBad : css('--ok'); ctx.fillText(t, sx, sy);
        }
      }
      if (sc > 14) {
        ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = cRef;
        for (const p of ds.points.values()) { const sx = toSx(p.x), sy = toSy(p.y); if (sx > 0 && sy > 0 && sx < W && sy < H) ctx.fillText(p.id, sx + 5, sy - 5); }
      }
    }
  }
  // 現況點與參考線
  const sv = S.survey;
  if (sv.lines.length) {
    for (const ln of sv.lines) {
      ctx.beginPath(); ln.points.forEach((n, i) => { const p = sv.points.get(n); i ? ctx.lineTo(toSx(p.x), toSy(p.y)) : ctx.moveTo(toSx(p.x), toSy(p.y)); });
      if (ln.closed) { ctx.closePath(); ctx.fillStyle = cSv + '22'; ctx.fill(); }
      ctx.strokeStyle = cSv; ctx.lineWidth = 2; ctx.stroke();
    }
  }
  if (S.draft && S.draft.names.length) {
    ctx.strokeStyle = cSv; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath();
    S.draft.names.forEach((n, i) => { const p = sv.points.get(n); i ? ctx.lineTo(toSx(p.x), toSy(p.y)) : ctx.moveTo(toSx(p.x), toSy(p.y)); });
    if (S.cursor) ctx.lineTo(toSx(S.cursor.x), toSy(S.cursor.y)); ctx.stroke(); ctx.setLineDash([]);
  }
  if (sv.points.size) {
    const showName = $('chkLabel').checked && sc > 1.5, inDraft = S.draft ? new Set(S.draft.names) : new Set();
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const p of sv.points.values()) {
      const sx = toSx(p.x), sy = toSy(p.y); if (sx < -8 || sy < -8 || sx > W + 8 || sy > H + 8) continue;
      ctx.fillStyle = inDraft.has(p.name) ? cSel : cSv; ctx.beginPath(); ctx.moveTo(sx, sy - 5); ctx.lineTo(sx + 5, sy); ctx.lineTo(sx, sy + 5); ctx.lineTo(sx - 5, sy); ctx.closePath(); ctx.fill();
      if (showName) { ctx.fillStyle = cSv; ctx.fillText(p.name, sx + 8, sy - 6); }
    }
    if (S.hover && S.hover.t === 'sp') { const p = sv.points.get(S.hover.k); if (p) { ctx.strokeStyle = cHov; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(toSx(p.x), toSy(p.y), 9, 0, 7); ctx.stroke(); } }
  }
  // 控制點／補點（綠色三角形）
  if (S.controls.size) {
    const cOk = css('--ok'), showName = $('chkLabel').checked && sc > 0.8;
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const p of S.controls.values()) {
      const sx = toSx(p.x), sy = toSy(p.y); if (sx < -8 || sy < -8 || sx > W + 8 || sy > H + 8) continue;
      ctx.fillStyle = cOk; ctx.beginPath(); ctx.moveTo(sx, sy - 6); ctx.lineTo(sx + 5.5, sy + 4); ctx.lineTo(sx - 5.5, sy + 4); ctx.closePath(); ctx.fill();
      if (showName) ctx.fillText(p.name, sx + 8, sy - 5);
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
function panel() {
  const ds = S.ds;
  $('btnUndo').disabled = !S.undo.length; $('btnRedo').disabled = !S.redo.length;
  $('btnReset').disabled = !ds || !Core.movedPoints(ds).length;
  $('btnExpD14').disabled = !ds || !S.dbf.pts || !Core.movedPoints(ds).length;
  $('btnExpJson').disabled = !ds && !S.survey.points.size;
  $('drop').style.display = (ds || S.survey.points.size || S.nb.length) ? 'none' : 'flex';
  lineList(); nbPanel();
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
  $('pivotInfo').textContent = S.pivot ? `樞紐：N ${S.pivot.y.toFixed(3)}  E ${S.pivot.x.toFixed(3)}（自訂）` : '樞紐：移動對象的中心（Alt+點擊可自訂）';
  // 較差表
  const scope = document.querySelector('input[name=scope]:checked').value, tol = parseFloat($('tol').value) || 0;
  const touched = new Set(); for (const id of ids) for (const pi of ds.pointParcels.get(id) || []) touched.add(pi);
  for (const i of S.sel.par) touched.add(i);
  const rows = scope === 'selected' ? [...touched] : ds.parcels.filter(p => Math.abs(p.area - p.areaOrig) > 1e-6).map(p => p.idx);
  for (const i of S.sel.par) if (!rows.includes(i)) rows.push(i);
  rows.sort((a, b) => Math.abs(ds.parcels[b].area - ds.parcels[b].areaOrig) - Math.abs(ds.parcels[a].area - ds.parcels[a].areaOrig));
  const cls = d => (Math.abs(d) > tol ? 'neg' : 'pos');
  $('tbody').innerHTML = rows.slice(0, 300).map(i => {
    const p = ds.parcels[i], d1 = p.area - p.areaOrig, d2 = p.areaReg == null ? null : p.area - p.areaReg;
    return `<tr data-i="${i}" class="${S.sel.par.has(i) ? 'sel' : ''}${d2 != null && Math.abs(d2) > tol ? ' warn' : ''}"><td>${p.label}</td><td>${f2(p.areaReg)}</td><td>${f2(p.areaOrig)}</td><td>${f2(p.area)}</td>` +
      `<td class="${cls(d1)}">${sgn(d1)}</td><td class="${d2 == null ? '' : cls(d2)}">${d2 == null ? '—' : sgn(d2)}</td></tr>`;
  }).join('');
  const changed = ds.parcels.filter(p => Math.abs(p.area - p.areaOrig) > 1e-6), tot = changed.reduce((s, p) => s + (p.area - p.areaOrig), 0);
  $('sumInfo').textContent = `共 ${changed.length} 宗地號面積有變動，合計 ${sgn(tot)} m²；已移動 ${Core.movedPoints(ds).length} 個界址點。` + (rows.length > 300 ? '（表格只列前 300 筆）' : '');
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

// ── 檢視 ───────────────────────────────────────────────────────────────────
function fit(box) {
  let b = box;
  if (!b) {
    b = S.ds ? Core.bounds(S.ds) : null;
    for (const n of S.nb) { const q = Core.bounds(n.ds); b = b ? { x0: Math.min(b.x0, q.x0), x1: Math.max(b.x1, q.x1), y0: Math.min(b.y0, q.y0), y1: Math.max(b.y1, q.y1) } : q; }
    if (S.survey.points.size) { const s = surveyBounds(); b = b ? { x0: Math.min(b.x0, s.x0), x1: Math.max(b.x1, s.x1), y0: Math.min(b.y0, s.y0), y1: Math.max(b.y1, s.y1) } : s; }
  }
  if (!b || !isFinite(b.x0)) return;
  const w = Math.max(b.x1 - b.x0, 1), h = Math.max(b.y1 - b.y0, 1);
  S.view.s = Math.min(W / w, H / h) * 0.9; S.view.cx = (b.x0 + b.x1) / 2; S.view.cy = (b.y0 + b.y1) / 2; draw();
}
function zoomTo(parIdx) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of parIdx) for (const id of S.ds.parcels[i].ids) { const p = S.ds.points.get(id); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  fit({ x0: x0 - 3, x1: x1 + 3, y0: y0 - 3, y1: y1 + 3 });
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
  if (S.align) { alignPick(mx, my); return; }
  if (S.tool === 'line') {
    const h = hitSurvey(mx, my); if (!h) return;
    if (!S.draft) S.draft = { names: [h.k] };
    else if (S.draft.names.length >= 3 && h.k === S.draft.names[0]) { finishDraft(true); return; }
    else if (S.draft.names[S.draft.names.length - 1] !== h.k) S.draft.names.push(h.k);
    setHint(`連線中：已選 ${S.draft.names.length} 點。繼續點選；Enter 完成、點回第一點閉合、Backspace 退一點、Esc 取消`); refresh(); return;
  }
  if (!S.ds) return;
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
    const h = S.align ? null : S.tool === 'line' ? hitSurvey(mx, my) : S.tool === 'select' && S.ds ? hitTest(mx, my) : null;
    if (JSON.stringify(h) !== JSON.stringify(S.hover)) { S.hover = h; draw(); }
    tip(h, e); if (S.draft || S.align) draw(); return;
  }
  if (d.kind === 'pan') { S.view.cx = d.cx - (mx - d.mx) / S.view.s; S.view.cy = d.cy + (my - d.my) / S.view.s; draw(); return; }
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
  else if (k === 'Escape') { if (S.align) cancelAlign(); else if (S.draft) { S.draft = null; setHint(''); draw(); } else { clearSel(); refresh(); } }
  else if (k === 'Enter') { if (S.align && S.align.step === 2) { finishAlign(); } else if (S.draft) finishDraft(false); }
  else if (k === 'Backspace' && S.draft) { S.draft.names.pop(); if (!S.draft.names.length) { S.draft = null; setHint(''); } draw(); }
  else if (k === 'v' || k === 'V') setTool('select'); else if (k === 'h' || k === 'H') setTool('pan'); else if (k === 'm' || k === 'M') setTool('layer'); else if (k === 'l' || k === 'L') setTool('line');
  else if (k === '1') toggleFilter('pt'); else if (k === '2') toggleFilter('edge'); else if (k === '3') toggleFilter('par');
  else if (k.startsWith('Arrow') && (selCount() || layerMode())) {
    e.preventDefault(); const st = parseFloat($('step').value) * (e.shiftKey ? 10 : 1);
    const dy = k === 'ArrowUp' ? st : k === 'ArrowDown' ? -st : 0, dx = k === 'ArrowRight' ? st : k === 'ArrowLeft' ? -st : 0;
    moveSelection(dy, dx, '微調');
  }
});
addEventListener('keyup', e => { if (e.key === ' ') S.space = false; });

// ── 工具列 ─────────────────────────────────────────────────────────────────
function setTool(t) {
  S.tool = t; if (t !== 'line' && S.draft) { S.draft = null; } if (t !== 'line' && !S.align) setHint('');
  document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  cv.style.cursor = t === 'pan' ? 'grab' : t === 'layer' ? 'move' : t === 'line' ? 'crosshair' : 'default';
  if (t === 'line') setHint('連線工具：依序點選現況點（Enter 完成、點回第一點閉合、Backspace 退一點、Esc 取消）'); refresh();
}
function toggleFilter(f) { S.filter[f] = !S.filter[f]; document.querySelector(`#filters [data-f=${f}]`).classList.toggle('on', S.filter[f]); }
document.querySelectorAll('#tools button').forEach(b => b.onclick = () => setTool(b.dataset.tool));
document.querySelectorAll('#filters button').forEach(b => b.onclick = () => toggleFilter(b.dataset.f));
$('btnUndo').onclick = undo; $('btnRedo').onclick = redo; $('btnReset').onclick = () => confirm('確定還原所有移動？') && resetAll();
$('btnFit').onclick = () => fit(); $('btnHelp').onclick = () => $('help').showModal();
$('chkRef').onchange = $('chkLabel').onchange = $('chkDelta').onchange = $('deltaMode').onchange = draw;
document.querySelectorAll('input[name=scope]').forEach(r => r.onchange = refresh); $('tol').oninput = refresh;
$('btnMove').onclick = () => { if (!moveSelection(parseFloat($('dN').value) || 0, parseFloat($('dE').value) || 0, '數值移動')) msg('請先選取要素，或切到「移圖」工具'); };
const rotAngle = () => { const v = Core.parseAngle($('rotDeg').value, 'auto'); return Number.isNaN(v) ? null : v; };
$('btnRotL').onclick = () => { const a = rotAngle(); if (a == null) return msg('旋轉角度格式不正確（例 0.5 或 0-30-00）'); if (!rotateSelection(a)) msg('請先選取要素，或切到「移圖」工具'); };
$('btnRotR').onclick = () => { const a = rotAngle(); if (a == null) return msg('旋轉角度格式不正確（例 0.5 或 0-30-00）'); if (!rotateSelection(-a)) msg('請先選取要素，或切到「移圖」工具'); };
$('btnPivotReset').onclick = () => { S.pivot = null; refresh(); };
$('btnAlign').onclick = startAlign;
$('find').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !S.ds) return; const q = $('find').value.trim();
  const p = S.ds.parcels.find(p => p.label === q || p.oldLabel === q); if (!p) return msg(`找不到地號 ${q}`);
  clearSel(); S.sel.par.add(p.idx); zoomTo([p.idx]); refresh();
});
const msg = t => { $('stMsg').textContent = t; clearTimeout(msg.t); msg.t = setTimeout(() => $('stMsg').textContent = '', 9000); };

// ── 輸出 ───────────────────────────────────────────────────────────────────
function download(name, data, type = 'application/octet-stream') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
$('btnExpD14').onclick = () => {
  const r = Core.exportD14(S.dbf.pts, S.ds); download(S.names.d14 || 'out.D14', r.bytes);
  msg(`已輸出 ${S.names.d14}：只改動 ${r.changed} 個點的坐標。覆蓋原檔前請先備份案件資料夾。`);
};
$('btnExpJson').onclick = () => download((S.names.d14 || 'session').replace(/\.\w+$/, '') + '.adjust.json', JSON.stringify(Core.exportSession(S.ds || Core.newDataset('', ''), { files: S.names, control_points: [...S.controls.values()].map(p => ({ name: p.name, y: p.y, x: p.x, source: p.src })) }, S.survey), null, 2), 'application/json');

// ── 載入檔案 ───────────────────────────────────────────────────────────────
const extOf = n => (n.split('.').pop() || '').toLowerCase();
const readBuf = f => f.arrayBuffer().then(b => new Uint8Array(b));
const readText = f => readBuf(f).then(u => { try { return new TextDecoder('utf-8', { fatal: true }).decode(u); } catch { return new TextDecoder('big5').decode(u); } });
async function loadFiles(files) {
  const by = {}, dup = [], texts = [], macs = [], ctlFiles = [];
  for (const f of files) {
    const x = extOf(f.name);
    if (/^(txt|csv|xyz|pts|dat|asc)$/.test(x)) { texts.push(f); continue; }
    if (x === 'mac') { macs.push(f); continue; }
    if (/^(ctl|ct2|cen|l02)$/.test(x)) { ctlFiles.push(f); continue; }
    if (!/^(d11|d12|d13|d14|d20|d2b|d2c|d2d|coa|bnp|par)$/.test(x)) continue; if (by[x]) dup.push(f.name); else by[x] = f;
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
    ds = await DS(by.d14, by.d13, { par, d12, name: by.d14.name, source: 'D14/D13 新成果' }); S.dbf.pts = Core.parseDbf(await readBuf(by.d14));
    names.d14 = by.d14.name; names.d13 = by.d13.name; if (by.d11) names.d11 = by.d11.name; if (by.d12) names.d12 = by.d12.name;
    if (has('d2c', 'd2d')) { ref = await DL(by.d2c, by.d2d, { name: 'old', source: 'D2C/D2D 舊圖線' }); names.d2c = by.d2c.name; names.d2d = by.d2d.name; }
    else if (has('d2c', 'd2b')) { ref = await DS(by.d2c, by.d2b, { name: 'old', source: 'D2C/D2B 舊圖' }); names.d2c = by.d2c.name; names.d2b = by.d2b.name; }
  } else if (has('coa', 'bnp')) {
    ds = Core.datasetFromKC({ coa: await readText(by.coa), bnp: await readText(by.bnp), par: by.par ? await readText(by.par) : null }); S.dbf.pts = null;
    names.coa = by.coa.name; names.bnp = by.bnp.name; if (by.par) names.par = by.par.name;
  } else if (has('d2c', 'd2b')) {
    ds = await DS(by.d2c, by.d2b, { name: by.d2c.name, source: 'D2C/D2B 舊圖' }); S.dbf.pts = Core.parseDbf(await readBuf(by.d2c));
    names.d14 = by.d2c.name; names.d2c = by.d2c.name; names.d2b = by.d2b.name;
  }
  if (!ds) {
    if (macs.length) { openImport(await readText(macs[0]), macs[0].name, 'mac'); return true; }
    if (texts.length) { openImport(await readText(texts[0]), texts[0].name); return true; }
    if (ctlMsg) return true;
    msg('缺少必要檔案：需要 D14+D13，或 COA+BNP，或 D2C+D2B；控制點用 CTL/CT2/D20；現況點請用「匯入現況點」'); return false;
  }
  S.seam = null; S.ds = ds; S.ref = ref; S.names = names; S.undo.length = S.redo.length = 0; clearSel(); S.hover = null; S.pivot = null; S.align = null;
  fit(); refresh();
  msg(`已載入 ${ds.parcels.length} 宗地號／${ds.points.size} 點` + (ctlMsg ? `；已知點：${ctlMsg}` : '') + (dup.length ? `（同副檔名重複，略過：${dup.slice(0, 3).join('、')}）` : ''));
  return true;
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
  e.shiftKey ? loadNeighbors(files) : loadFiles(files);
});

// ── 鄰段：同時載入相鄰地段、以不同顏色區分，並檢查／接合段界 ───────────────────
const NB_COLORS = ['#e8590c', '#1c7ed6', '#9c36b5', '#2f9e44', '#c2255c', '#b08900', '#0c8599', '#6741d9'];
const SEAM_COLOR = { coincide: '#1a7f37', overlap: '#d1242f', gap: '#f08c00', missing_in_main: '#9c36b5', unmatched: '#9c36b5' };
const SEAM_TEXT = { coincide: '重合', overlap: '重疊', gap: '脫開', missing_in_main: '主區缺點', unmatched: '無對應' };
const nbDirOf = f => { const p = f.webkitRelativePath || f._path || ''; return p.slice(0, p.lastIndexOf('/') + 1); };
const nbArgs = () => S.nb.map(n => ({ name: n.name, ds: n.ds, authoritative: n.authoritative }));
const seamOpts = (o = {}) => { const v = (id, k) => { const x = parseFloat($(id).value); return Number.isFinite(x) && x >= 0 ? x : Core.SEAM_DEFAULT[k]; };
  return { tol: o.tol ?? v('seamTol', 'tol'), search: o.search ?? v('seamSearch', 'search'), snap: o.snap ?? v('seamSnap', 'snap') }; };
// 以「同資料夾＋同主檔名」分組，一次可加入多個地段（例如選取含多個案件資料夾的上層資料夾）
async function loadNeighbors(files) {
  const groups = new Map();
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
    const n = { name: g.name, ds, color: old >= 0 ? S.nb[old].color : NB_COLORS[S.nb.length % NB_COLORS.length], visible: true, authoritative: true, seg: Core.boundarySegments(ds) };
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
function drawNeighbor(n) {
  const d = n.ds, c = n.color, sc = S.view.s;
  ctx.fillStyle = c + '22'; ctx.beginPath();
  for (const p of d.parcels) p.ids.forEach((id, i) => { const q = d.points.get(id); i ? ctx.lineTo(toSx(q.x), toSy(q.y)) : ctx.moveTo(toSx(q.x), toSy(q.y)); }), ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = c; ctx.lineWidth = 1.2; ctx.beginPath();
  for (const e of d.edges.values()) { if (e.arcPart) continue; const a = d.points.get(e.a), b = d.points.get(e.b); ctx.moveTo(toSx(a.x), toSy(a.y)); ctx.lineTo(toSx(b.x), toSy(b.y)); }
  ctx.stroke(); strokeArcs(d, c, 1.2);
  if (sc > 3) { ctx.fillStyle = c; const r = sc > 8 ? 2.5 : 1.8; for (const id of n.seg.vids) { const p = d.points.get(id); ctx.fillRect(toSx(p.x) - r, toSy(p.y) - r, r * 2, r * 2); } }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (sc > 1.2) { ctx.font = `${Math.min(14, Math.max(9, sc * 1.4))}px sans-serif`; ctx.fillStyle = c; for (const p of d.parcels) { const q = Core.centroidOf(d.points, p.ids), sx = toSx(q.x), sy = toSy(q.y); if (sx > 0 && sy > 0 && sx < W && sy < H) ctx.fillText(p.label, sx, sy); } }
  const b = Core.bounds(d); ctx.font = 'bold 16px sans-serif'; ctx.fillStyle = c; ctx.fillText(n.name, toSx((b.x0 + b.x1) / 2), toSy((b.y0 + b.y1) / 2));
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
  S.seam = Core.seamAnalyze(S.ds, nbArgs(), seamOpts(o)); S.seamStale = false; refresh(); return S.seam;
}
function joinSeam(o = {}) {
  if (!S.ds) throw new Error('請先載入主要測區'); if (!S.nb.length) throw new Error('請先加入鄰段');
  const j = Core.seamJoin(S.ds, nbArgs(), seamOpts(o)), first = new Map();
  for (const m of j.moves) if (!first.has(m.id)) first.set(m.id, m.from);
  const before = [...first].map(([id, f]) => [id, f.y, f.x]), after = [...first.keys()].map(id => { const p = S.ds.points.get(id); return [id, p.y, p.x]; });
  commit(before, after, '鄰段接合');
  S.seam = { ...j.after, join: { before: j.before.totals, moves: j.moves, unresolved: j.unresolved } }; S.seamStale = false; refresh();
  msg(`鄰段接合：移動 ${first.size} 點；仍有 ${j.after.totals.overlap + j.after.totals.gap} 點重疊／脫開（未處理 ${j.unresolved.length}）`);
  return { before: j.before.totals, after: j.after.totals, moves: j.moves, unresolved: j.unresolved, report: S.seam };
}
function nbPanel() {
  const sgn = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(3);
  $('nbList').innerHTML = S.nb.length ? S.nb.map((n, i) => `<div class="row" style="margin:3px 0"><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${n.color}"></span><b>${esc(n.name)}</b>` +
    `<span class="muted">${n.ds.parcels.length} 宗／${n.ds.points.size} 點</span><label class="chk"><input type="checkbox" data-nb="${i}" data-k="visible"${n.visible ? ' checked' : ''}>顯示</label>` +
    `<label class="chk" title="已重測的鄰段：段界以鄰段為準，主要測區的段界點會被吸附過去"><input type="checkbox" data-nb="${i}" data-k="authoritative"${n.authoritative ? ' checked' : ''}>以鄰段為準</label>` +
    `<button class="btn nbfit" data-nb="${i}">縮放</button><button class="btn nbdel" data-nb="${i}">✕</button></div>`).join('') : '<span class="muted">尚未加入鄰段 — 先開主要測區，再「加入鄰段」（可一次選含多個案件資料夾的上層資料夾）</span>';
  $('btnSeamChk').disabled = $('btnSeamJoin').disabled = !S.ds || !S.nb.length; $('btnNbFit').disabled = !S.nb.length;
  const s = S.seam; $('btnSeamCsv').disabled = $('btnSeamJson').disabled = !s;
  if (!s) { $('seamSum').textContent = S.ds && S.nb.length ? '按「檢查接合」逐點檢查主區段界點與鄰段段界是否重合、重疊或脫開' : ''; $('seamTbl').innerHTML = ''; return; }
  const t = s.totals;
  $('seamSum').innerHTML = `檢查 ${t.checked} 點：<span style="color:${SEAM_COLOR.coincide}">重合 ${t.coincide}</span>／<span style="color:${SEAM_COLOR.overlap}">重疊 ${t.overlap}</span>／<span style="color:${SEAM_COLOR.gap}">脫開 ${t.gap}</span>；鄰段點主區缺 ${t.neighbor_missing_in_main}` +
    (S.seamStale ? ' <b class="neg">（點位已變動，請重新檢查）</b>' : '') + (s.join ? `<br>上次接合：移動 ${new Set(s.join.moves.map(m => m.id)).size} 點，未處理 ${s.join.unresolved.length}` : '');
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
$('nbList').addEventListener('change', e => { const i = e.target.dataset.nb; if (i == null) return; S.nb[i][e.target.dataset.k] = e.target.checked; if (e.target.dataset.k === 'authoritative') S.seamStale = !!S.seam; refresh(); });
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
$('btnImp').onclick = $('btnImp2').onclick = () => openImport();
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
  if (S.ref && $('chkRef').checked) item('舊圖', (x, y) => { ctx.strokeStyle = '#8a93a6'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 20, y); ctx.stroke(); ctx.setLineDash([]); });
  if (changed) item('面積變動', (x, y) => { ctx.fillStyle = 'rgba(255,160,0,.45)'; ctx.fillRect(x, y - 5, 20, 10); });
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
  const u = S.update, b = $('btnVer'); b.textContent = APP_VERSION + (u ? ' ↑' : ''); b.classList.toggle('primary', !!u); b.title = u ? `有新版本 ${u.tag}` : '版本歷程與更新';
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
$('btnVer').onclick = () => { $('chkAutoUpd').checked = autoUpdOn(); renderTimeline(); renderUpdate(); $('verDlg').showModal(); };
$('verClose').onclick = e => { e.preventDefault(); $('verDlg').close(); };
$('verQ').oninput = () => { verState.q = $('verQ').value; renderTimeline(); };
$('verTypes').onclick = e => { const t = e.target.dataset && e.target.dataset.t; if (!t) return; verState.type = t; document.querySelectorAll('#verTypes button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); renderTimeline(); };
$('verAll').onclick = () => { const es = verFilter(), all = es.every(e => verState.open.has(e.version)); es.forEach(e => (all ? verState.open.delete(e.version) : verState.open.add(e.version))); renderTimeline(); };
$('verList').onclick = e => { const li = e.target.closest('li[data-v]'); if (!li || !e.target.closest('.head')) return; const v = li.dataset.v; verState.open.has(v) ? verState.open.delete(v) : verState.open.add(v); renderTimeline(); };
$('chkAutoUpd').onchange = () => { try { localStorage.setItem('cw.autoUpdate', $('chkAutoUpd').checked ? '1' : '0'); } catch (e) { /* ignore */ } };
$('btnCheckUpd').onclick = () => checkUpdate();
renderUpdate();
if (autoUpdOn() && /^(https?|file):$/.test(location.protocol)) setTimeout(() => checkUpdate({ silent: true }), 2500);

// ── AI / MCP 預留介面 ─────────────────────────────────────────────────────
const findPar = q => S.ds.parcels.find(p => p.label === String(q) || p.oldLabel === String(q));
const api = {
  getState: () => ({ loaded: !!S.ds, source: S.ds && S.ds.source, points: S.ds ? S.ds.points.size : 0, parcels: S.ds ? S.ds.parcels.length : 0,
    moved_points: S.ds ? Core.movedPoints(S.ds).length : 0, control_points: S.controls.size, survey_points: S.survey.points.size, reference_lines: S.survey.lines.length,
    selection: { points: [...S.sel.pt], edges: [...S.sel.edge], parcels: S.ds ? [...S.sel.par].map(i => S.ds.parcels[i].label) : [] } }),
  setBasemap: ({ provider = 'none', opacity, cm } = {}) => { if (provider !== 'none' && !PROVIDERS[provider]) throw new Error('provider 需為 none/osm/emap/photo'); S.basemap.provider = provider; if (opacity != null) S.basemap.opacity = opacity; if (cm != null) S.basemap.cm = cm; $('bmSel').value = provider; saveBasemap(); draw(); return { ...S.basemap }; },
  toLatLon: ({ y, x }) => Core.tm2ToLatLon(y, x, S.basemap.cm),
  getVersion: () => ({ version: APP_VERSION, changelog: CHANGELOG, update: S.update }),
  checkUpdate: o => checkUpdate(o || {}),
  getView: () => ({ cx: S.view.cx, cy: S.view.cy, px_per_m: S.view.s, width: W, height: H, note: 'screen_x=(E-cx)*px_per_m+width/2, screen_y=height/2-(N-cy)*px_per_m' }),
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
  listNeighbors: () => S.nb.map(n => ({ name: n.name, source: n.ds.source, parcels: n.ds.parcels.length, points: n.ds.points.size, boundary_points: n.seg.vids.size, visible: n.visible, authoritative: n.authoritative, color: n.color })),
  // files: [{name:'KC1120.D14', base64:'…'} | {name:'KC1120.BNP', text:'…'}]，需 D14+D13（建議 D11、D12）或 COA+BNP
  addNeighbor: ({ files = [] } = {}) => loadNeighbors(files.map(f => new File([f.base64 ? Uint8Array.from(atob(f.base64), c => c.charCodeAt(0)) : new TextEncoder().encode(f.text || '')], f.name))),
  removeNeighbor: ({ name }) => { const i = S.nb.findIndex(n => n.name.toLowerCase() === String(name).toLowerCase()); if (i < 0) throw new Error('找不到鄰段 ' + name); S.nb.splice(i, 1); S.seam = null; refresh(); return api.listNeighbors(); },
  setNeighbor: ({ name, visible, authoritative }) => { const n = S.nb.find(n => n.name.toLowerCase() === String(name).toLowerCase()); if (!n) throw new Error('找不到鄰段 ' + name); if (visible != null) n.visible = !!visible; if (authoritative != null) n.authoritative = !!authoritative; refresh(); return api.listNeighbors(); },
  // 參數：tol 重合容差、search 搜尋距離、snap 吸附上限（公尺）；省略用畫面上的設定
  checkSeam: o => runSeam(o || {}),
  joinSeam: o => joinSeam(o || {}),
  getSeamReport: ({ format = 'json' } = {}) => { if (!S.seam) throw new Error('尚未檢查接合'); return format === 'text' ? Core.seamReportText(S.seam) : format === 'csv' ? Core.seamReportCsv(S.seam) : S.seam; },
  undo: () => (undo(), api.getState()), redo: () => (redo(), api.getState()),
  exportSession: () => Core.exportSession(S.ds || Core.newDataset('', ''), { files: S.names, control_points: [...S.controls.values()].map(p => ({ name: p.name, y: p.y, x: p.x, source: p.src })), neighbors: S.nb.map(n => n.name), seam_report: S.seam }, S.survey),
};
window.CadastralAPI = api;
const bridge = new URLSearchParams(location.search).get('bridge');
if (bridge) {   // 例：?bridge=ws://127.0.0.1:8765 ；收 {id,method,params}，回 {id,result|error}
  const ws = new WebSocket(bridge);
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; }
    Promise.resolve().then(() => api[m.method](m.params)).then(result => ws.send(JSON.stringify({ id: m.id, result })), err => ws.send(JSON.stringify({ id: m.id, error: String(err) }))); };
  ws.onopen = () => msg('AI 橋接已連線');
}
resize(); panel();
})();
