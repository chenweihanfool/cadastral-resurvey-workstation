/* core.js — 地籍圖資料核心：讀寫 NECEXE 的 DBF(D檔) 與 KC 文字檔(COA/BNP/PAR)、幾何、面積。
 * 純函式、不碰 DOM，瀏覽器與 Node 共用。座標慣例：y = 縱坐標(北, TWD97 ~2.7e6)、x = 橫坐標(東)。
 * 資料模型與驗證依據見 NECEXE_findings.md。 */
const Core = (() => {
  'use strict';
  const CHG = 1e-6;   // 面積變動判定門檻（m²），低於此視為未變動

  const dec = (u8, label = 'big5') => new TextDecoder(label).decode(u8);

  // ── DBF 讀取 ─────────────────────────────────────────────────────────────
  function parseDbf(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = dv.getUint32(4, true), hl = dv.getUint16(8, true), rl = dv.getUint16(10, true);
    const fields = [];
    let off = 1;
    for (let o = 32; u8[o] !== 0x0d && o < hl; o += 32) {
      const name = dec(u8.subarray(o, o + 11)).split('\0')[0];
      const f = { name, type: String.fromCharCode(u8[o + 11]), len: u8[o + 16], dec: u8[o + 17], off };
      off += f.len; fields.push(f);
    }
    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
      const base = hl + i * rl, row = { _deleted: u8[base] === 0x2a };
      for (const f of fields) {
        const s = dec(u8.subarray(base + f.off, base + f.off + f.len)).trim();
        if (f.type === 'N' || f.type === 'F') { const v = s === '' ? NaN : Number(s); row[f.name] = Number.isNaN(v) ? null : v; }
        else if (f.type === 'L') row[f.name] = /^[TtYy]$/.test(s);
        else row[f.name] = s;
      }
      rows[i] = row;
    }
    return { fields, rows, hl, rl, n, u8 };
  }

  // 就地修改數值欄位（右靠齊、補空白），回傳新的 Uint8Array；不改動其他位元組。
  function patchDbfNumber(u8, dbf, rowIndex, fieldName, value) {
    const f = dbf.fields.find(x => x.name === fieldName);
    if (!f) throw new Error('無此欄位 ' + fieldName);
    const s = value.toFixed(f.dec);
    if (s.length > f.len) throw new Error(`${fieldName} 值 ${s} 超出欄寬 ${f.len}`);
    const base = dbf.hl + rowIndex * dbf.rl + f.off;
    const padded = s.padStart(f.len, ' ');
    for (let i = 0; i < f.len; i++) u8[base + i] = padded.charCodeAt(i);
  }

  // ── 資料集 ───────────────────────────────────────────────────────────────
  // dataset = { name, source, points: Map(id→{id,y,x,y0,x0}), parcels: [{idx,key,label,oldLabel,ids,areaRef,areaOrig}],
  //             edges: Map("a-b"→{a,b,parcels:[idx]}), pointParcels: Map(id→[idx]) }
  function newDataset(name, source) {
    return { name, source, points: new Map(), parcels: [], edges: new Map(), pointParcels: new Map(), meta: {} };
  }

  function finalize(ds) {
    ds.edges = new Map(); ds.pointParcels = new Map();
    ds.parcels.forEach((p, idx) => {
      p.idx = idx;
      const ids = p.ids, n = ids.length;
      for (let i = 0; i < n; i++) {
        const a = ids[i], b = ids[(i + 1) % n];
        if (a === b) continue;
        const k = a < b ? a + '-' + b : b + '-' + a;
        let e = ds.edges.get(k);
        if (!e) ds.edges.set(k, e = { key: k, a: Math.min(a, b), b: Math.max(a, b), parcels: [] });
        if (!e.parcels.includes(idx)) e.parcels.push(idx);
        let pp = ds.pointParcels.get(a); if (!pp) ds.pointParcels.set(a, pp = []);
        if (!pp.includes(idx)) pp.push(idx);
      }
    });
    // 地中地：外圈地號面積 = 外圈 − 內圈（holeKeys 為內圈地號鍵）
    const byKey = new Map(ds.parcels.map(p => [p.key, p]));
    for (const p of ds.parcels) {
      p.holes = []; p.containers = p.containers || [];
    }
    for (const p of ds.parcels) for (const hk of p.holeKeys || []) {
      const h = byKey.get(hk); if (h && h !== p) { p.holes.push(h.idx); h.containers.push(p.idx); }
    }
    for (const p of ds.parcels) { p.areaOrig = parcelArea(ds, p); p.area = p.areaOrig; }
    // 圓弧：mid[i] 為弧中點，前後頂點為弧端；弦邊標記 arcPart，繪圖時改畫弧
    ds.arcs = new Map();
    for (const p of ds.parcels) if (p.mid) {
      const n = p.ids.length;
      p.mid.forEach((m, i) => {
        if (!m) return; const a = p.ids[(i - 1 + n) % n], b = p.ids[i], c = p.ids[(i + 1) % n];
        ds.arcs.set(a + '|' + b + '|' + c, { a, b, c });
        for (const [u, v] of [[a, b], [b, c]]) { const e = ds.edges.get(u < v ? u + '-' + v : v + '-' + u); if (e) e.arcPart = true; }
      });
    }
    return ds;
  }

  // 從 D 檔建立：D14(點) + D13(界址串)，可選 D11(屬性)。pts/bnd/par 為 parseDbf 結果。
  function datasetFromD({ pts, bnd, par, d12, name = 'D', source = 'D檔' }) {
    const ds = newDataset(name, source);
    pts.rows.forEach((r, i) => {
      if (r._deleted || r.COT_REF !== 0 || r.COT_NUMBER == null || !r.COT_Y || !r.COT_X) return;   // 排除 (0,0) 空白佔位點
      ds.points.set(r.COT_NUMBER, { id: r.COT_NUMBER, y: r.COT_Y, x: r.COT_X, y0: r.COT_Y, x0: r.COT_X, row: i });
    });
    const attr = new Map();
    if (par) for (const r of par.rows) if (!r._deleted) attr.set(`${r.SECTION_O}|${r.PAR_O_M}|${r.PAR_O_C}`, r);
    const groups = new Map();
    for (const r of bnd.rows) {
      if (r._deleted) continue;
      const k = `${r.O_SECTION}|${r.O_PARCEL}|${r.O_PARCEL_E}`;
      let g = groups.get(k); if (!g) groups.set(k, g = { sec: r.O_SECTION, m: r.O_PARCEL, c: r.O_PARCEL_E, ids: [], mid: [], arcs: false });
      for (let i = 1; i <= 8; i++) {
        const id = r['COORD_' + i];
        if (id) { g.ids.push(id); g.mid.push(!!r['MIDARC_' + i]); if (r['MIDARC_' + i]) g.arcs = true; }
      }
    }
    const holeMap = new Map();   // 外圈鍵 → [內圈鍵]
    if (d12) for (const r of d12.rows) {
      if (r._deleted) continue;
      const ok = `${r.O_SECTION}|${r.O_PARCEL}|${r.O_PARCEL_E}`, ik = `${r.I_SECTION}|${r.I_PARCEL}|${r.I_PARCEL_E}`;
      let l = holeMap.get(ok); if (!l) holeMap.set(ok, l = []); l.push(ik);
    }
    for (const [k, g] of groups) {
      if (!g.sec && !g.m && !g.c) continue;   // 地號全為 0＝無宗地身分的線串（如 D2B 舊圖數化），不是界址環；線改由 D2D 讀（datasetFromLines）
      if (g.ids.length < 3 || g.ids.some(id => !ds.points.has(id))) continue;
      const a = attr.get(k);
      const fmt = (m, c) => (c ? `${m}-${c}` : `${m}`);
      ds.parcels.push({
        key: k, section: g.sec, label: a ? fmt(a.PAR_N_M, a.PAR_N_C) : fmt(g.m, g.c), oldLabel: fmt(g.m, g.c),
        ids: g.ids, mid: g.mid, hasArc: g.arcs, holeKeys: holeMap.get(k),
        areaRef: a ? Math.round(a.AREA_NEW * 1e10) / 1e6 : null,      // AREA_NEW 公頃 → m²
        areaReg: a ? Math.round(a.AREA_OLD * 1e10) / 1e6 : null,      // AREA_OLD 登記面積 m²
      });
    }
    return finalize(ds);
  }

  // 從點表＋界址線表建立「只有線、沒有宗地」的資料集（D2C＋D2D 舊圖數化）。
  // 每筆線 LIN_TOP→LIN_BOT；LIN_MID 非 0 時為圓弧中點。lin 為 parseDbf 結果。
  function datasetFromLines({ pts, lin, name = 'D', source = 'D檔線' }) {
    const ds = newDataset(name, source); ds.arcs = new Map();
    pts.rows.forEach((r, i) => {
      if (r._deleted || r.COT_REF !== 0 || r.COT_NUMBER == null || !r.COT_Y || !r.COT_X) return;
      ds.points.set(r.COT_NUMBER, { id: r.COT_NUMBER, y: r.COT_Y, x: r.COT_X, y0: r.COT_Y, x0: r.COT_X, row: i });
    });
    for (const r of lin.rows) {
      if (r._deleted) continue;
      const a = r.LIN_TOP, c = r.LIN_BOT, m = r.LIN_MID;
      if (!a || !c || a === c || !ds.points.has(a) || !ds.points.has(c)) continue;
      const k = a < c ? a + '-' + c : c + '-' + a;
      const e = ds.edges.get(k) || { key: k, a: Math.min(a, c), b: Math.max(a, c), parcels: [] };
      ds.edges.set(k, e);
      if (m && ds.points.has(m)) { e.arcPart = true; ds.arcs.set(a + '|' + m + '|' + c, { a, b: m, c }); }
    }
    return ds;
  }

  // ── KC 文字檔 (COA/BNP/PAR) ──────────────────────────────────────────────
  const lines = t => (t.includes('\r\n') ? t.split('\r\n') : t.split(/\n/)).filter((l, i, a) => !(i === a.length - 1 && l === ''));

  function parseCoa(text) {
    const pts = new Map(), L = lines(text);
    for (let i = 1; i < L.length; i++) {
      const l = L[i]; if (l.length < 37) continue;
      const id = parseInt(l.slice(0, 5), 10); if (Number.isNaN(id)) continue;
      const y = parseFloat(l.slice(6, 22)), x = parseFloat(l.slice(22, 37));
      if (Number.isNaN(y) || Number.isNaN(x)) continue;
      pts.set(id, { id, y, x, y0: y, x0: x });
    }
    return pts;
  }
  function parseBnp(text) {
    const parcels = new Map(), L = lines(text);
    for (let i = 1; i < L.length; i++) {
      const l = L[i]; if (l.length < 15 || !l.trim()) continue;
      const sec = parseInt(l.slice(0, 4), 10), sub = parseInt(l.slice(4, 8), 10), seq = parseInt(l.slice(8, 11), 10);
      if ([sec, sub, seq].some(Number.isNaN)) continue;
      const ids = [], rest = l.slice(15);
      for (let j = 0; j < rest.length; j += 6) {
        const m = /^\s*(\d+)/.exec(rest.slice(j, j + 6)); if (m) ids.push(parseInt(m[1], 10));
      }
      const k = sec + '|' + sub; let g = parcels.get(k); if (!g) parcels.set(k, g = { sec, sub, parts: new Map() });
      g.parts.set(seq, ids);
    }
    return parcels;
  }
  function parsePar(text) {
    const recs = new Map(), L = lines(text);
    for (let i = 1; i < L.length; i++) {
      const l = L[i]; if (l.length < 40) continue;
      const sec = parseInt(l.slice(0, 4), 10), sub = parseInt(l.slice(4, 8), 10);
      const reg = parseFloat(l.slice(12, 22)), calc = parseFloat(l.slice(30, 40));
      if ([sec, sub, reg, calc].some(Number.isNaN)) continue;
      recs.set(sec + '|' + sub, { reg, calc });
    }
    return recs;
  }
  function datasetFromKC({ coa, bnp, par, name = 'KC', source = 'COA/BNP/PAR' }) {
    const ds = newDataset(name, source);
    ds.points = parseCoa(coa);
    const bn = parseBnp(bnp), pr = par ? parsePar(par) : new Map();
    for (const [k, g] of bn) {
      const ids = []; for (const s of [...g.parts.keys()].sort((a, b) => a - b)) ids.push(...g.parts.get(s));
      if (ids.length < 3 || ids.some(id => !ds.points.has(id))) continue;
      const r = pr.get(k);
      ds.parcels.push({ key: k, section: g.sec, label: String(g.sub), oldLabel: String(g.sub), ids,
        areaRef: r ? r.calc : null, areaReg: r ? r.reg : null });
    }
    return finalize(ds);
  }

  // ── 幾何 ────────────────────────────────────────────────────────────────
  // 有號面積（逆時針為正）。相對第一個頂點計算：座標 ~1e6 量級時，避免大數相減造成浮點誤差
  function signedArea(ids, points) {
    let s = 0; const n = ids.length, o = points.get(ids[0]);
    for (let i = 0; i < n; i++) {
      const p = points.get(ids[i]), q = points.get(ids[(i + 1) % n]);
      s += (p.x - o.x) * (q.y - o.y) - (q.x - o.x) * (p.y - o.y);
    }
    return s / 2;
  }
  const ringArea = (ids, points) => Math.abs(signedArea(ids, points));
  // mid[i]=true 表示頂點 i 是一段圓弧的中點（前後頂點為弧的兩端）；面積 = 折線多邊形 ± (弓形 − 三角形)
  function ringAreaArc(ids, mid, points) {
    let a = ringArea(ids, points); if (!mid || !mid.some(Boolean)) return a;
    const n = ids.length, ccw = signedArea(ids, points) >= 0;
    for (let i = 0; i < n; i++) {
      if (!mid[i]) continue;
      const A = points.get(ids[(i - 1 + n) % n]), B = points.get(ids[i]), C = points.get(ids[(i + 1) % n]);
      const ab = Math.hypot(B.x - A.x, B.y - A.y), bc = Math.hypot(C.x - B.x, C.y - B.y), ca = Math.hypot(A.x - C.x, A.y - C.y);
      const cr = (C.x - A.x) * (B.y - A.y) - (C.y - A.y) * (B.x - A.x), T = Math.abs(cr) / 2;
      if (T < 1e-9) continue;
      const R = (ab * bc * ca) / (4 * T), beta = Math.acos(Math.max(-1, Math.min(1, (ab * ab + bc * bc - ca * ca) / (2 * ab * bc))));
      const theta = 2 * Math.PI - 2 * beta, seg = (R * R / 2) * (theta - Math.sin(theta));
      const inward = ccw ? cr > 0 : cr < 0;
      a += inward ? -(seg - T) : (seg - T);
    }
    return a;
  }
  // 過 A、B、C 三點的圓弧（A→B→C），取樣成折線供繪圖
  function arcPolyline(A, B, C, n = 24) {
    const bx = B.x - A.x, by = B.y - A.y, cx = C.x - A.x, cy = C.y - A.y, d = 2 * (bx * cy - by * cx);
    if (Math.abs(d) < 1e-12) return [A, B, C];
    const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy, ux = (cy * b2 - by * c2) / d, uy = (bx * c2 - cx * b2) / d;
    const R = Math.hypot(ux, uy), a0 = Math.atan2(-uy, -ux), norm = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const sB = norm(Math.atan2(by - uy, bx - ux) - a0), sC = norm(Math.atan2(cy - uy, cx - ux) - a0), sweep = sB < sC ? sC : sC - 2 * Math.PI;
    const out = []; for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; out.push({ x: A.x + ux + R * Math.cos(a), y: A.y + uy + R * Math.sin(a) }); }
    return out;
  }
  function parcelArea(ds, p) {
    let a = ringAreaArc(p.ids, p.mid, ds.points);
    for (const hi of p.holes || []) { const h = ds.parcels[hi]; a -= ringAreaArc(h.ids, h.mid, ds.points); }
    return a;
  }
  function pointInRing(ids, points, y, x) {
    let inside = false; const n = ids.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const p = points.get(ids[i]), q = points.get(ids[j]);
      if ((p.y > y) !== (q.y > y) && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) inside = !inside;
    }
    return inside;
  }
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function bounds(ds) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ds.pointParcels.keys()) { const p = ds.points.get(id); if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    return { x0, y0, x1, y1 };
  }

  // ── 編輯：移動點集合（共點自動連動鄰地）；回傳受影響宗地索引 ───────────────
  function movePoints(ds, ids, dy, dx) {
    const affected = new Set();
    for (const id of ids) {
      const p = ds.points.get(id); if (!p) continue;
      p.y += dy; p.x += dx;
      for (const pi of ds.pointParcels.get(id) || []) affected.add(pi);
    }
    return recalc(ds, affected);
  }
  // 重算受影響宗地面積；內圈（地中地）受影響時，外圈一併重算
  function recalc(ds, affected) {
    for (const pi of [...affected]) for (const c of ds.parcels[pi].containers || []) affected.add(c);
    for (const pi of affected) { const pc = ds.parcels[pi]; pc.area = parcelArea(ds, pc); }
    return affected;
  }
  // 批次設定位置 entries=[[id,y,x],...]；每個受影響宗地只重算一次面積
  function setPoints(ds, entries) {
    const affected = new Set();
    for (const [id, y, x] of entries) {
      const p = ds.points.get(id); if (!p) continue;
      p.y = y; p.x = x;
      for (const pi of ds.pointParcels.get(id) || []) affected.add(pi);
    }
    return recalc(ds, affected);
  }
  function setPoint(ds, id, y, x) { const p = ds.points.get(id); return movePoints(ds, [id], y - p.y, x - p.x); }
  function resetAll(ds) {
    for (const p of ds.points.values()) { p.y = p.y0; p.x = p.x0; }
    for (const pc of ds.parcels) pc.area = pc.areaOrig;
  }
  const isMoved = p => Math.abs(p.y - p.y0) > 1e-6 || Math.abs(p.x - p.x0) > 1e-6;   // 容差 1e-6 m，忽略來回旋轉的浮點殘差
  function movedPoints(ds) { return [...ds.points.values()].filter(isMoved); }

  // ── 變換（平移＋旋轉）─────────────────────────────────────────────────────
  // T = { dy, dx, angle (弧度，逆時針為正，北向上俯視), pivot: {y, x} }：先繞 pivot 旋轉，再平移 (dy,dx)
  function xform(p, T) {
    const pv = T.pivot || { y: 0, x: 0 }, c = Math.cos(T.angle || 0), s = Math.sin(T.angle || 0), rx = p.x - pv.x, ry = p.y - pv.y;
    return { y: pv.y + s * rx + c * ry + (T.dy || 0), x: pv.x + c * rx - s * ry + (T.dx || 0) };
  }
  function transformPoints(ds, ids, T) {
    const entries = [];
    for (const id of ids) { const p = ds.points.get(id); if (!p) continue; const q = xform(p, T); entries.push([id, q.y, q.x]); }
    return setPoints(ds, entries);
  }
  function centroidOf(points, ids) {
    let y = 0, x = 0, n = 0;
    for (const id of ids) { const p = points.get(id); if (p) { y += p.y; x += p.x; n++; } }
    return n ? { y: y / n, x: x / n } : { y: 0, x: 0 };
  }
  // 兩點對位：把來源 a→A、b→B。回傳 T（旋轉+平移，不縮放）與 scale（|AB|/|ab|，供檢查品質）
  function twoPointFit(a, b, A, B) {
    const ang = Math.atan2(B.y - A.y, B.x - A.x) - Math.atan2(b.y - a.y, b.x - a.x);
    const la = Math.hypot(b.x - a.x, b.y - a.y), lA = Math.hypot(B.x - A.x, B.y - A.y);
    return { T: { pivot: { y: a.y, x: a.x }, angle: ang, dy: A.y - a.y, dx: A.x - a.x }, scale: la ? lA / la : NaN, angle: ang, residual_b: null };
  }

  // ── 角度與座標文字解析 ───────────────────────────────────────────────────
  // fmt: 'auto'（含 - ° ' " 視為度分秒，否則十進位度）| 'dms' | 'ddmmss'（ddd.mmss，測量常用）| 'deg' | 'gon'
  function parseAngle(str, fmt = 'auto') {
    let s = String(str).trim(); if (!s) return NaN;
    let sign = 1; if (s[0] === '-' && /^-\s*\d/.test(s) && !/[°'"′″]|\d-\d/.test(s)) { sign = -1; s = s.slice(1); }
    if (fmt === 'gon') return sign * Number(s) * 0.9;
    const dmsLike = /[°'"′″]|\d-\d/.test(s) || fmt === 'dms';
    if (dmsLike) {
      const t = s.split(/[-°'"′″\s]+/).filter(Boolean).map(Number); if (t.some(Number.isNaN)) return NaN;
      return sign * ((t[0] || 0) + (t[1] || 0) / 60 + (t[2] || 0) / 3600);
    }
    if (fmt === 'ddmmss') {
      const m = /^(\d+)(?:\.(\d*))?$/.exec(s); if (!m) return NaN;
      const frac = (m[2] || '').padEnd(4, '0'), mm = Number(frac.slice(0, 2)), ss = Number(frac.slice(2, 4) + (frac.length > 4 ? '.' + frac.slice(4) : ''));
      return sign * (Number(m[1]) + mm / 60 + ss / 3600);
    }
    const v = Number(s); return Number.isNaN(v) ? NaN : sign * v;
  }
  const num = t => (t !== '' && t != null && /^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(t) ? Number(t) : NaN);
  const splitTok = l => l.trim().split(/[\s,;\t]+/).filter(t => t !== '');

  // 現況點座標檔：「點號,N,E[,H,代碼…]」或「N,E」；CSV/TXT/空白/Tab 分隔皆可。
  // order: 'auto'（較大者視為縱坐標N，台灣 TM 坐標 N~2.7e6 > E~2e5）| 'NE' | 'EN'
  function parsePoints(text, { order = 'auto' } = {}) {
    const points = [], skipped = []; let auto = 0, usedOrder = order;
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim() || /^\s*(#|\/\/|;)/.test(line)) return;
      const t = splitTok(line); let name, a, b, rest;
      if (t.length >= 3 && !Number.isNaN(num(t[1])) && !Number.isNaN(num(t[2]))) { name = t[0]; a = num(t[1]); b = num(t[2]); rest = t.slice(3); }
      else if (t.length >= 2 && !Number.isNaN(num(t[0])) && !Number.isNaN(num(t[1]))) { name = String(++auto); a = num(t[0]); b = num(t[1]); rest = t.slice(2); }
      else { if (points.length || i > 0) skipped.push({ line: i + 1, text: line.slice(0, 60) }); return; }   // 標題列或無法解析
      let o = order; if (o === 'auto') o = Math.abs(a) >= Math.abs(b) ? 'NE' : 'EN'; usedOrder = o;
      const y = o === 'NE' ? a : b, x = o === 'NE' ? b : a;
      const pt = { name, y, x }; const h = num(rest[0]); if (!Number.isNaN(h)) { pt.h = h; rest = rest.slice(1); } if (rest.length) pt.code = rest.join(' ');
      points.push(pt);
    });
    return { points, skipped, order: usedOrder };
  }
  // 測站觀測：每行「點號 水平角 [天頂距] 距離」。水平角自後視方向起順時針量。
  function parseObservations(text, { angleFmt = 'auto' } = {}) {
    const obs = [], skipped = [];
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return; const t = splitTok(line);
      if (t.length < 3) { skipped.push({ line: i + 1, text: line.slice(0, 60) }); return; }
      const h = parseAngle(t[1], angleFmt), dist = num(t.length > 3 ? t[3] : t[2]);
      const z = t.length > 3 ? parseAngle(t[2], angleFmt) : null;
      if (Number.isNaN(h) || Number.isNaN(dist) || (z != null && Number.isNaN(z))) { skipped.push({ line: i + 1, text: line.slice(0, 60) }); return; }
      obs.push({ name: t[0], h, z, dist, note: t.slice(t.length > 3 ? 4 : 3).join(' ') });
    });
    return { obs, skipped };
  }
  // 極座標化算：station{y,x}、backAz（後視方位角，度）、obs[]、slope=true 表示距離為斜距（需天頂距）
  function polarReduce({ station, backAz, obs, slope = true }) {
    return obs.map(o => {
      const hz = o.z != null && slope ? o.dist * Math.sin(o.z * Math.PI / 180) : o.dist;
      const az = (((backAz + o.h) % 360) + 360) % 360 * Math.PI / 180;
      return { name: o.name, y: station.y + hz * Math.cos(az), x: station.x + hz * Math.sin(az), note: o.note || undefined };
    });
  }
  const azimuth = (a, b) => ((Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI) + 360) % 360;   // 由 a 看 b，自北順時針

  // ── 控制點檔：CTL（控制點）、CT2（補點）、CEN、L02 ─────────────────────────
  // 首行為案號；其後每行「點名 縱坐標Y 橫坐標X」。NECEXE 輸出用定寬格式，Y 與 X 可能緊貼無空白，故以小數三位切分。
  function parseCtl(text) {
    const points = [], skipped = []; let code = '';
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      let t = splitTok(line);
      if (t.length === 2 && /^-?\d+\.\d{3}-?\d+\.\d{3}$/.test(t[1])) { const m = /^(-?\d+\.\d{3})(-?\d+\.\d{3})$/.exec(t[1]); t = [t[0], m[1], m[2]]; }
      const nums = []; for (let k = t.length - 1; k >= 1 && nums.length < 2; k--) { if (/^-?\d+\.\d+$/.test(t[k])) nums.unshift(Number(t[k])); else break; }
      if (nums.length === 2) { points.push({ name: t[0], y: nums[0], x: nums[1] }); return; }
      if (i === 0 && t.length === 1) { code = t[0]; return; }
      skipped.push({ line: i + 1, text: line.slice(0, 60) });
    });
    return { code, points, skipped };
  }

  // ── MAC 手簿檔（測站 角度 距離）──────────────────────────────────────────
  // 格式：首行 "LS ()" 為標頭；其後每段以「測站 後視」兩欄開頭，接著每行「點號 水平角(ddd.mmss) 距離」。
  // 水平角自後視方向起順時針量；後視點本身角度為 0.0000（其距離作為檢核）。距離視為平距（檔內無天頂距）。
  function parseMac(text, { angleFmt = 'ddmmss' } = {}) {
    const blocks = [], skipped = []; let cur = null;
    text.split(/\r?\n/).forEach((line, i) => {
      const t = splitTok(line); if (!t.length) return;
      if (i === 0 && /^LS\b/i.test(t[0])) return;
      if (t.length === 2 && Number.isNaN(num(t[1]))) { cur = { station: t[0], back: t[1], obs: [], line: i + 1 }; blocks.push(cur); return; }
      if (t.length >= 3 && cur) {
        const h = parseAngle(t[1], angleFmt), dist = num(t[2]);
        if (!Number.isNaN(h) && !Number.isNaN(dist)) { cur.obs.push({ name: t[0], h, dist, line: i + 1 }); return; }
      }
      skipped.push({ line: i + 1, text: line.slice(0, 60) });
    });
    return { blocks, skipped };
  }
  // 逐段化算。known：Map(點號→{y,x})（已知控制點）；段內新點會登錄，供後續測站使用（如 QC1）。
  function reduceMac(blocks, known) {
    const dict = new Map(known), points = [], checks = [], unresolved = [], stations = [];
    for (const b of blocks) {
      const st = dict.get(b.station), bk = dict.get(b.back);
      if (!st || !bk) { unresolved.push({ station: b.station, back: b.back, line: b.line, missing: [!st && b.station, !bk && b.back].filter(Boolean) }); continue; }
      const backAz = azimuth(st, bk); stations.push({ name: b.station, y: st.y, x: st.x, back: b.back, back_azimuth: backAz });
      for (const o of b.obs) {
        if (o.name === b.back && Math.abs(o.h) < 1e-9) {   // 後視檢核
          const dc = Math.hypot(bk.x - st.x, bk.y - st.y); checks.push({ station: b.station, back: b.back, measured: o.dist, computed: dc, diff: o.dist - dc }); continue;
        }
        const az = (((backAz + o.h) % 360) + 360) % 360 * Math.PI / 180;
        const p = { name: o.name, y: st.y + o.dist * Math.cos(az), x: st.x + o.dist * Math.sin(az), note: `測站${b.station}` };
        points.push(p); dict.set(o.name, { y: p.y, x: p.x });
      }
    }
    return { points, checks, unresolved, stations };
  }

  // ── 現況點與參考線 ───────────────────────────────────────────────────────
  const newSurvey = () => ({ points: new Map(), lines: [], seq: 0 });
  function addSurveyPoints(sv, pts) {
    const added = [];
    for (const p of pts) {
      let n = String(p.name), k = 2; while (sv.points.has(n)) n = `${p.name}_${k++}`;
      sv.points.set(n, { name: n, y: p.y, x: p.x, h: p.h, code: p.code, note: p.note }); added.push(n);
    }
    return added;
  }
  function addLine(sv, names, { name, closed = false } = {}) {
    const ids = names.filter(n => sv.points.has(String(n))).map(String); if (ids.length < 2) return null;
    const ln = { id: ++sv.seq, name: name || `參考線${sv.seq}`, points: ids, closed: !!closed }; sv.lines.push(ln); return ln;
  }
  function lineStats(sv, ln) {
    let len = 0; const pts = ln.points.map(n => sv.points.get(n)), n = pts.length;
    for (let i = 0; i < n - 1; i++) len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (ln.closed && n > 2) len += Math.hypot(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y);
    let area = null;
    if (ln.closed && n > 2) { let s = 0; for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; s += (p.x - pts[0].x) * (q.y - pts[0].y) - (q.x - pts[0].x) * (p.y - pts[0].y); } area = Math.abs(s) / 2; }
    return { length: len, area };
  }

  // ── 版本號比較：'v1.2.3' / '1.2.3'；a>b 回傳正數 ───────────────────────────
  function compareVersions(a, b) {
    const p = v => String(v).replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
    const x = p(a), y = p(b); for (let i = 0; i < Math.max(x.length, y.length, 3); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0;
  }

  // ── 坐標轉換：TWD97 TM2（EPSG:3826/3825）↔ WGS84 經緯度（GRS80，k0=0.9999，FE=250000）──
  // 中央經線：本島 121°（3826），澎湖金門馬祖 119°（3825）。TWD67 與 TWD97 約差 800 m，不可混用。
  const GRS = { a: 6378137, f: 1 / 298.257222101 };
  GRS.e2 = 2 * GRS.f - GRS.f * GRS.f; GRS.ep2 = GRS.e2 / (1 - GRS.e2);
  const D2R = Math.PI / 180, K0 = 0.9999, FE = 250000;
  function meridianArc(phi) {
    const { a, e2 } = GRS, e4 = e2 * e2, e6 = e4 * e2;
    return a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi) +
      (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
  }
  function latLonToTm2(lat, lon, cm = 121) {   // → { y: 縱坐標N, x: 橫坐標E }
    const { a, e2, ep2 } = GRS, phi = lat * D2R, sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
    const N = a / Math.sqrt(1 - e2 * sin * sin), T = tan * tan, C = ep2 * cos * cos, A = (lon - cm) * D2R * cos;
    const x = K0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
    const y = K0 * (meridianArc(phi) + N * tan * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    return { y, x: x + FE };
  }
  function tm2ToLatLon(y, x, cm = 121) {       // → { lat, lon }（度）
    const { a, e2, ep2 } = GRS, e4 = e2 * e2, e6 = e4 * e2, X = x - FE;
    const mu = (y / K0) / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256)), e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const sin = Math.sin(phi1), cos = Math.cos(phi1), tan = Math.tan(phi1), C1 = ep2 * cos * cos, T1 = tan * tan;
    const N1 = a / Math.sqrt(1 - e2 * sin * sin), R1 = a * (1 - e2) / Math.pow(1 - e2 * sin * sin, 1.5), D = X / (N1 * K0);
    const lat = phi1 - (N1 * tan / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
    const lon = (cm * D2R) + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / cos;
    return { lat: lat / D2R, lon: lon / D2R };
  }

  // ── 鄰段接合 ─────────────────────────────────────────────────────────────
  // 主要測區（main）與已載入的鄰段（nb）：以主區「段界點」（外圍邊上的點）逐點檢查與鄰段段界的關係。
  //   重合 coincide：落在鄰段界址點上（kind=vertex），或在鄰段界線上但鄰段無此點（kind=line）
  //   重疊 overlap ：點在鄰段宗地內，且離鄰段界線超過容差（gap_m 為負）
  //   脫開 gap     ：點在鄰段宗地外，離鄰段界線超過容差（gap_m 為正）
  // 已重測的鄰段以鄰段為準：seamJoin 把脫開／重疊的主區點吸附到鄰段界址點（或界線上的垂足）。
  const SEAM_DEFAULT = { tol: 0.01, search: 3, snap: 1 };   // 重合容差、搜尋距離、吸附上限（公尺）
  const SEAM_LABEL = { coincide: '重合', overlap: '重疊', gap: '脫開' };

  // 段界邊：只屬於一個宗地、且該宗地不是地中地內圈的邊；圓弧段界以弧取樣成折線
  function boundarySegments(ds) {
    const keys = new Set(), edges = [];
    for (const e of ds.edges.values()) {
      if (e.parcels.length !== 1) continue;
      const p = ds.parcels[e.parcels[0]]; if (p.containers && p.containers.length) continue;
      keys.add(e.key); edges.push(e);
    }
    const key = (u, v) => (u < v ? u + '-' + v : v + '-' + u), skip = new Set(), segs = [], vids = new Set();
    for (const ar of ds.arcs ? ds.arcs.values() : []) {
      const k1 = key(ar.a, ar.b), k2 = key(ar.b, ar.c); if (!keys.has(k1) || !keys.has(k2)) continue;
      skip.add(k1); skip.add(k2);
      const pl = arcPolyline(ds.points.get(ar.a), ds.points.get(ar.b), ds.points.get(ar.c), 16);
      for (let i = 1; i < pl.length; i++) segs.push({ ax: pl[i - 1].x, ay: pl[i - 1].y, bx: pl[i].x, by: pl[i].y });
      vids.add(ar.a); vids.add(ar.b); vids.add(ar.c);
    }
    for (const e of edges) {
      if (skip.has(e.key)) continue;
      const a = ds.points.get(e.a), b = ds.points.get(e.b); segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y }); vids.add(e.a); vids.add(e.b);
    }
    return { segs, vids };
  }
  // 線段格網索引：nearest(x,y,r) 回傳 r 內最近線段 {dist, fx, fy}（垂足），沒有則 null
  function segIndex(segs, cell) {
    const grid = new Map(), cc = v => Math.floor(v / cell);
    segs.forEach((s, n) => {
      for (let i = cc(Math.min(s.ax, s.bx)); i <= cc(Math.max(s.ax, s.bx)); i++) for (let j = cc(Math.min(s.ay, s.by)); j <= cc(Math.max(s.ay, s.by)); j++) {
        const k = i + ',' + j; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(n);
      }
    });
    return {
      nearest(x, y, r) {
        let best = null; const seen = new Set();
        for (let i = cc(x - r); i <= cc(x + r); i++) for (let j = cc(y - r); j <= cc(y + r); j++) for (const n of grid.get(i + ',' + j) || []) {
          if (seen.has(n)) continue; seen.add(n);
          const s = segs[n], dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / l2)) : 0, fx = s.ax + t * dx, fy = s.ay + t * dy, d = Math.hypot(x - fx, y - fy);
          if (d <= r && (!best || d < best.dist)) best = { dist: d, fx, fy };
        }
        return best;
      },
    };
  }
  const nearestVertex = (list, x, y) => { let best = null, bd = Infinity; for (const v of list) { const d = Math.hypot(v.x - x, v.y - y); if (d < bd) { bd = d; best = v; } } return { v: best, d: bd }; };

  // 逐點檢查主區段界點對一個鄰段的關係。回傳 { points:[…主區點…], neighbor_points:[…鄰段點無對應…], summary }
  function seamCheck(main, nb, opt = {}) {
    const { tol, search } = { ...SEAM_DEFAULT, ...opt };
    const mb = boundarySegments(main), nbb = boundarySegments(nb), cell = Math.max(search, 1);
    const nbIdx = segIndex(nbb.segs, cell), mIdx = segIndex(mb.segs, cell);
    const nbV = [...nbb.vids].map(id => nb.points.get(id)).filter(Boolean), mV = [...mb.vids].map(id => main.points.get(id)).filter(Boolean);
    const boxes = nb.parcels.map(p => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const id of p.ids) { const q = nb.points.get(id); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); } return { x0, y0, x1, y1 }; });
    const inNb = (x, y) => nb.parcels.some((p, i) => { const b = boxes[i]; return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && pointInRing(p.ids, nb.points, y, x); });
    const points = [];
    for (const P of mV) {
      const sg = nbIdx.nearest(P.x, P.y, search); if (!sg) continue;      // 離鄰段段界太遠：不是接縫上的點
      const { v, d: dv } = nearestVertex(nbV, P.x, P.y);
      const row = { id: P.id, y: P.y, x: P.x, dist: sg.dist, vertex: v ? v.id : null, vertex_dist: dv, foot: { y: sg.fy, x: sg.fx } };
      if (dv <= tol) { row.status = 'coincide'; row.kind = 'vertex'; row.gap_m = dv; }
      else if (sg.dist <= tol) { row.status = 'coincide'; row.kind = 'line'; row.gap_m = sg.dist; }
      else if (inNb(P.x, P.y)) { row.status = 'overlap'; row.gap_m = -sg.dist; }
      else { row.status = 'gap'; row.gap_m = sg.dist; }
      points.push(row);
    }
    const neighbor_points = [];
    for (const V of nbV) {
      if (nearestVertex(mV, V.x, V.y).d <= tol) continue;
      const sg = mIdx.nearest(V.x, V.y, search); if (!sg) continue;
      neighbor_points.push({ id: V.id, y: V.y, x: V.x, dist: sg.dist, status: sg.dist <= tol ? 'missing_in_main' : 'unmatched' });
    }
    const cnt = s => points.filter(r => r.status === s).length;
    return { points, neighbor_points, summary: {
      checked: points.length, coincide: cnt('coincide'), coincide_vertex: points.filter(r => r.kind === 'vertex').length, coincide_line: points.filter(r => r.kind === 'line').length,
      overlap: cnt('overlap'), gap: cnt('gap'), max_overlap_m: Math.max(0, ...points.filter(r => r.status === 'overlap').map(r => -r.gap_m)), max_gap_m: Math.max(0, ...points.filter(r => r.status === 'gap').map(r => r.gap_m)),
      neighbor_missing_in_main: neighbor_points.filter(r => r.status === 'missing_in_main').length, neighbor_unmatched: neighbor_points.filter(r => r.status === 'unmatched').length } };
  }
  // 依檢查結果規劃吸附：脫開／重疊的點 → 吸附上限內最近的鄰段界址點，否則鄰段界線上的垂足。多點搶同一鄰段點時只讓最近的一點過去（避免宗地塌縮）
  function seamPlan(check, opt = {}) {
    const { snap } = { ...SEAM_DEFAULT, ...opt }, moves = [], unresolved = [], claim = new Map();
    for (const r of check.points) {
      if (r.status === 'coincide') continue;
      if (r.vertex_dist <= snap) {
        const c = claim.get(r.vertex);
        if (!c || r.vertex_dist < c.r.vertex_dist) { if (c) unresolved.push({ id: c.r.id, reason: 'conflict', status: c.r.status, gap_m: c.r.gap_m, vertex: r.vertex }); claim.set(r.vertex, { r }); }
        else unresolved.push({ id: r.id, reason: 'conflict', status: r.status, gap_m: r.gap_m, vertex: r.vertex });
      } else if (r.dist <= snap) moves.push({ id: r.id, type: 'line', to: r.foot, from: { y: r.y, x: r.x }, dist: r.dist, status: r.status });
      else unresolved.push({ id: r.id, reason: 'beyond_snap', status: r.status, gap_m: r.gap_m });
    }
    return { moves, unresolved, claim };
  }
  // 完整分析：對每個鄰段檢查；回傳可序列化報告
  function seamAnalyze(main, neighbors, opt = {}) {
    const params = { ...SEAM_DEFAULT, ...opt };
    const list = neighbors.map(n => ({ name: n.name, authoritative: n.authoritative !== false, ...seamCheck(main, n.ds, params) }));
    const sum = k => list.reduce((s, n) => s + n.summary[k], 0);
    return { generated: new Date().toISOString(), main: main.name, params, neighbors: list,
      totals: { checked: sum('checked'), coincide: sum('coincide'), overlap: sum('overlap'), gap: sum('gap'), neighbor_missing_in_main: sum('neighbor_missing_in_main') } };
  }
  // 自動接合：逐一對「以鄰段為準」的鄰段吸附，回傳 { before, after, moves, unresolved }；點位已就地修改（呼叫端負責復原快照）
  function seamJoin(main, neighbors, opt = {}) {
    const params = { ...SEAM_DEFAULT, ...opt }, before = seamAnalyze(main, neighbors, params), moves = [], unresolved = [];
    for (const n of neighbors) {
      if (n.authoritative === false) continue;
      const chk = seamCheck(main, n.ds, params), plan = seamPlan(chk, params), entries = [];
      for (const [vid, c] of plan.claim) {
        const v = n.ds.points.get(vid), p = main.points.get(c.r.id);
        moves.push({ id: p.id, neighbor: n.name, type: 'vertex', neighbor_point: vid, from: { y: p.y, x: p.x }, to: { y: v.y, x: v.x }, dist: c.r.vertex_dist, status: c.r.status }); entries.push([p.id, v.y, v.x]);
      }
      for (const m of plan.moves) { moves.push({ ...m, neighbor: n.name }); entries.push([m.id, m.to.y, m.to.x]); }
      for (const u of plan.unresolved) unresolved.push({ ...u, neighbor: n.name });
      setPoints(main, entries);
    }
    return { before, after: seamAnalyze(main, neighbors, params), moves, unresolved };
  }
  const f3 = v => (v == null ? '' : Number(v).toFixed(3));
  function seamReportText(rep) {
    const L = [`鄰段接合報告　主要測區：${rep.main}　容差 ${rep.params.tol} m／搜尋 ${rep.params.search} m／吸附 ${rep.params.snap} m`, `合計：檢查 ${rep.totals.checked} 點；重合 ${rep.totals.coincide}、重疊 ${rep.totals.overlap}、脫開 ${rep.totals.gap}；鄰段點在主區界線上但主區無對應點 ${rep.totals.neighbor_missing_in_main}`];
    for (const n of rep.neighbors) {
      const s = n.summary;
      L.push('', `■ 鄰段 ${n.name}${n.authoritative ? '（以鄰段為準）' : '（僅比對）'}：檢查 ${s.checked} 點；重合 ${s.coincide}（點上 ${s.coincide_vertex}／線上 ${s.coincide_line}）、重疊 ${s.overlap}（最大 ${f3(s.max_overlap_m)} m）、脫開 ${s.gap}（最大 ${f3(s.max_gap_m)} m）；鄰段缺點 ${s.neighbor_missing_in_main}、無對應 ${s.neighbor_unmatched}`);
      for (const r of n.points.filter(r => r.status !== 'coincide')) L.push(`  點 ${r.id}　${SEAM_LABEL[r.status]} ${f3(Math.abs(r.gap_m))} m　最近鄰段點 ${r.vertex}（${f3(r.vertex_dist)} m）`);
    }
    if (rep.join) {
      const ids = new Set(rep.join.moves.map(m => m.id));
      L.push('', `■ 自動接合：移動 ${ids.size} 點（吸附到鄰段界址點 ${rep.join.moves.filter(m => m.type === 'vertex').length}、鄰段界線垂足 ${rep.join.moves.filter(m => m.type === 'line').length}）；接合前 重疊 ${rep.join.before.overlap}／脫開 ${rep.join.before.gap}；未處理 ${rep.join.unresolved.length}`);
      for (const u of rep.join.unresolved) L.push(`  點 ${u.id}　未處理（${u.reason === 'conflict' ? '多點對應同一鄰段點' : '超出吸附上限'}）`);
    }
    return L.join('\n');
  }
  function seamReportCsv(rep) {
    const rows = [['鄰段', '類別', '點號', '狀態', '種類', '偏差m(脫開+/重疊-)', '縱坐標y', '橫坐標x', '最近鄰段點', '距鄰段點m']];
    for (const n of rep.neighbors) {
      for (const r of n.points) rows.push([n.name, '主區點', r.id, SEAM_LABEL[r.status], r.kind === 'vertex' ? '鄰段點上' : r.kind === 'line' ? '鄰段線上' : '', f3(r.gap_m), r.y.toFixed(3), r.x.toFixed(3), r.vertex, f3(r.vertex_dist)]);
      for (const r of n.neighbor_points) rows.push([n.name, '鄰段點', r.id, r.status === 'missing_in_main' ? '主區缺點' : '無對應', '', f3(r.dist), r.y.toFixed(3), r.x.toFixed(3), '', '']);
    }
    return rows.map(r => r.join(',')).join('\n');
  }

  // 異動點位表（CSV）：原坐標→新坐標、位移、相關地號；join 為 seamJoin 的結果時附上接合原因
  function movedPointsCsv(ds, join = null) {
    const why = new Map(); for (const m of join ? join.moves : []) why.set(m.id, m);
    const rows = [['點號', '原縱坐標y', '原橫坐標x', '新縱坐標y', '新橫坐標x', 'Δy北', 'Δx東', '位移m', '相關地號', '原因', '鄰段', '鄰段點號']];
    for (const p of movedPoints(ds)) {
      const m = why.get(p.id), lab = (ds.pointParcels.get(p.id) || []).map(i => ds.parcels[i].label).join('、');
      rows.push([p.id, p.y0.toFixed(3), p.x0.toFixed(3), p.y.toFixed(3), p.x.toFixed(3), (p.y - p.y0).toFixed(3), (p.x - p.x0).toFixed(3), Math.hypot(p.y - p.y0, p.x - p.x0).toFixed(3), lab,
        m ? (m.type === 'vertex' ? '鄰段接合：吸附到鄰段界址點' : '鄰段接合：吸附到鄰段界線') : '手動調整', m ? m.neighbor : '', m && m.neighbor_point != null ? m.neighbor_point : '']);
    }
    return rows.map(r => r.map(v => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v)).join(',')).join('\n');
  }
  // ── 影像定位檔（World file：JGW／PGW／WLD）────────────────────────────────
  // 六行：A（x 方向像元大小）、D（y 方向旋轉）、B（x 方向旋轉）、E（y 方向像元大小，通常為負）、C（左上像元「中心」的 x＝橫坐標 E）、F（左上像元中心的 y＝縱坐標 N）。
  //   X = A·col + B·row + C ；Y = D·col + E·row + F（col、row 為像元中心）。
  function parseWorldFile(text) {
    const v = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l !== '').slice(0, 6).map(Number);
    if (v.length < 6 || v.some(x => !Number.isFinite(x))) throw new Error('定位檔需要 6 行數字（A D B E C F）');
    const [a, d, b, e, c, f] = v;
    if (Math.abs(a * e - b * d) < 1e-18) throw new Error('定位檔的像元大小為 0');
    return { a, d, b, e, c, f };
  }
  const worldFileText = wf => [wf.a, wf.d, wf.b, wf.e, wf.c, wf.f].map(n => n.toFixed(10)).join('\r\n') + '\r\n';
  // 影像四個角（邊緣，不是像元中心）的世界坐標：左上、右上、右下、左下
  function imageCorners(wf, w, h) {
    const at = (u, v) => ({ x: wf.a * (u - 0.5) + wf.b * (v - 0.5) + wf.c, y: wf.d * (u - 0.5) + wf.e * (v - 0.5) + wf.f });
    return [at(0, 0), at(w, 0), at(w, h), at(0, h)];
  }
  function imageBounds(wf, w, h) {
    const q = imageCorners(wf, w, h), xs = q.map(p => p.x), ys = q.map(p => p.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  // 只讀檔頭取影像尺寸（JPEG 的 SOF、PNG 的 IHDR），不必解碼整張圖；讀不出來回傳 null
  function imageSize(u8) {
    if (u8.length > 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return { w: ((u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19]) >>> 0, h: ((u8[20] << 24) | (u8[21] << 16) | (u8[22] << 8) | u8[23]) >>> 0 };
    if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < u8.length) {
      if (u8[i] !== 0xff) { i++; continue; }
      const m = u8[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (u8[i + 5] << 8) | u8[i + 6], w: (u8[i + 7] << 8) | u8[i + 8] };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + ((u8[i + 2] << 8) | u8[i + 3]);
    }
    return null;
  }

  // ── 輸出 ────────────────────────────────────────────────────────────────
  // 回傳新的 D14 位元組：只改動 REF=0 且被移動的點的 COT_Y/COT_X。
  function exportD14(pts, ds) {
    const out = new Uint8Array(pts.u8); let n = 0;
    for (const p of movedPoints(ds)) {
      if (p.row == null) continue;
      patchDbfNumber(out, pts, p.row, 'COT_Y', p.y); patchDbfNumber(out, pts, p.row, 'COT_X', p.x); n++;
    }
    return { bytes: out, changed: n };
  }
  // 供 AI/外部程式讀取的中繼資料（JSON，自帶欄位說明）
  function exportSession(ds, extra = {}, sv = null) {
    return {
      format: 'cadastral-workbench/session@1',
      description: '地籍圖調整工作階段。y=縱坐標(北), x=橫坐標(東), 單位公尺, TWD97。area 單位 m²。',
      crs: 'EPSG:3826', source: ds.source,
      points_moved: movedPoints(ds).map(p => ({ id: p.id, from: { y: p.y0, x: p.x0 }, to: { y: p.y, x: p.x }, shift_m: Math.hypot(p.y - p.y0, p.x - p.x0) })),
      parcels_changed: ds.parcels.filter(p => Math.abs(p.area - p.areaOrig) > CHG).map(p => ({
        label: p.label, old_label: p.oldLabel, key: p.key, area_before: p.areaOrig, area_after: p.area,
        delta: p.area - p.areaOrig, area_ref: p.areaRef, delta_vs_ref: p.areaRef == null ? null : p.area - p.areaRef })),
      survey_points: sv ? [...sv.points.values()].map(p => ({ name: p.name, y: p.y, x: p.x, h: p.h, code: p.code })) : [],
      reference_lines: sv ? sv.lines.map(l => ({ name: l.name, points: l.points, closed: l.closed, ...lineStats(sv, l) })) : [],
      ...extra,
    };
  }

  return { parseDbf, patchDbfNumber, datasetFromD, datasetFromLines, datasetFromKC, parseCoa, parseBnp, parsePar, ringArea, pointInRing, distToSeg,
    bounds, movePoints, setPoints, parcelArea, ringAreaArc, arcPolyline, newDataset, setPoint, resetAll, movedPoints, isMoved, exportD14, exportSession, finalize,
    xform, transformPoints, centroidOf, twoPointFit, parseAngle, parsePoints, parseObservations, polarReduce, azimuth, parseMac, reduceMac, parseCtl, latLonToTm2, tm2ToLatLon, compareVersions,
    newSurvey, addSurveyPoints, addLine, lineStats, SEAM_DEFAULT, boundarySegments, seamCheck, seamPlan, seamAnalyze, seamJoin, seamReportText, seamReportCsv, movedPointsCsv, parseWorldFile, worldFileText, imageCorners, imageBounds, imageSize };
})();
if (typeof module !== 'undefined') module.exports = Core;
