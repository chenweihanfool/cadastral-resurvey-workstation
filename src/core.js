/* core.js — 地籍圖資料核心：讀寫 NECEXE 的 DBF(D檔) 與 KC 文字檔(COA/BNP/PAR)、幾何、面積。
 * 純函式、不碰 DOM，瀏覽器與 Node 共用。座標慣例：y = 縱坐標(北, TWD97 ~2.7e6)、x = 橫坐標(東)。
 * 資料模型與驗證依據見 NECEXE_findings.md。 */
const Core = (() => {
  'use strict';
  const CHG = 1e-6;   // 面積變動判定門檻（m²），低於此視為未變動

  const dec = (u8, label = 'big5') => new TextDecoder(label).decode(u8);

  // ── DBF 讀取 ─────────────────────────────────────────────────────────────
  function parseDbf(buf) {
    const u8 = buf instanceof Uint8Array ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);   // 一律轉成一般 Uint8Array：Node 的 Buffer.slice 是共用記憶體的視圖，樣板列會互相覆蓋
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

  // 邊與「點所屬宗地」：由各宗地的環推得。編修界址點後可重複呼叫（不會重設面積基準）
  function buildTopology(ds) {
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
  }
  // 圓弧：mid[i] 為弧中點，前後頂點為弧端；弦邊標記 arcPart，繪圖時改畫弧
  function buildArcs(ds) {
    ds.arcs = new Map();
    for (const p of ds.parcels) if (p.mid) {
      const n = p.ids.length;
      p.mid.forEach((m, i) => {
        if (!m) return; const a = p.ids[(i - 1 + n) % n], b = p.ids[i], c = p.ids[(i + 1) % n];
        ds.arcs.set(a + '|' + b + '|' + c, { a, b, c });
        for (const [u, v] of [[a, b], [b, c]]) { const e = ds.edges.get(u < v ? u + '-' + v : v + '-' + u); if (e) e.arcPart = true; }
      });
    }
  }
  function finalize(ds) {
    buildTopology(ds);
    // 地中地：外圈地號面積 = 外圈 − 內圈（holeKeys 為內圈地號鍵）
    const byKey = new Map(ds.parcels.map(p => [p.key, p]));
    for (const p of ds.parcels) {
      p.holes = []; p.containers = p.containers || [];
    }
    for (const p of ds.parcels) for (const hk of p.holeKeys || []) {
      const h = byKey.get(hk); if (h && h !== p) { p.holes.push(h.idx); h.containers.push(p.idx); }
    }
    for (const p of ds.parcels) { p.areaOrig = parcelArea(ds, p); p.area = p.areaOrig; }
    buildArcs(ds);
    // 載入時的原貌：「還原全部」用（點位、各宗地的環）
    if (!ds.orig) ds.orig = { points: [...ds.points.values()].map(q => ({ ...q })), rings: ds.parcels.map(p => ({ ids: p.ids.slice(), mid: p.mid ? p.mid.slice() : null, holes: p.holes.slice() })) };
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
    if (par) par.rows.forEach((r, i) => { if (!r._deleted) { r._row = i; attr.set(`${r.SECTION_O}|${r.PAR_O_M}|${r.PAR_O_C}`, r); } });
    const groups = new Map();
    bnd.rows.forEach((r, ri) => {
      if (r._deleted) return;
      const k = `${r.O_SECTION}|${r.O_PARCEL}|${r.O_PARCEL_E}`;
      let g = groups.get(k); if (!g) groups.set(k, g = { sec: r.O_SECTION, m: r.O_PARCEL, c: r.O_PARCEL_E, ids: [], mid: [], arcs: false, rows: [] });
      g.rows.push(ri);
      for (let i = 1; i <= 8; i++) {
        const id = r['COORD_' + i];
        if (id) { g.ids.push(id); g.mid.push(!!r['MIDARC_' + i]); if (r['MIDARC_' + i]) g.arcs = true; }
      }
    });
    const holeMap = new Map();   // 外圈鍵 → [內圈鍵]
    if (d12) for (const r of d12.rows) {
      if (r._deleted) continue;
      const ok = `${r.O_SECTION}|${r.O_PARCEL}|${r.O_PARCEL_E}`, ik = `${r.I_SECTION}|${r.I_PARCEL}|${r.I_PARCEL_E}`;
      let l = holeMap.get(ok); if (!l) holeMap.set(ok, l = []); l.push(ik);
    }
    const fmtN = r => `${r.PAR_N_M}-${r.PAR_N_C || 0}-${r.SECTION_N}`;
    ds.meta.noRing = []; ds.meta.badRing = []; ds.meta.dupAttr = [];
    for (const [k, g] of groups) {
      if (!g.sec && !g.m && !g.c) continue;   // 地號全為 0＝無宗地身分的線串（如 D2B 舊圖數化），不是界址環；線改由 D2D 讀（datasetFromLines）
      if (g.ids.length < 3 || g.ids.some(id => !ds.points.has(id))) {
        const ar = attr.get(k); ds.meta.badRing.push({ label: ar ? fmtN(ar) : `${g.m}-${g.c || 0}-${g.sec}`, count: g.ids.length, missing: g.ids.filter(id => !ds.points.has(id)) }); continue;
      }
      const a = attr.get(k);
      const fmt = (m, c) => (c ? `${m}-${c}` : `${m}`);
      ds.parcels.push({
        key: k, section: g.sec, label: a ? fmt(a.PAR_N_M, a.PAR_N_C) : fmt(g.m, g.c), oldLabel: fmt(g.m, g.c),
        ids: g.ids, mid: g.mid, hasArc: g.arcs, holeKeys: holeMap.get(k), rows: g.rows, ids0: g.ids.slice(), mid0: g.mid.slice(),
        attrRow: a ? a._row : null,                                    // D11 列索引（刪除宗地時改寫面積／中心）
        areaRef: a ? Math.round(a.AREA_NEW * 1e10) / 1e6 : null,      // AREA_NEW 公頃 → m²
        areaReg: a ? Math.round(a.AREA_OLD * 1e10) / 1e6 : null,      // AREA_OLD 登記面積 m²
      });
    }
    // D11 有、但 D13 沒有界址環的地號（NECEXE 報表「無地號界址」）
    if (par) { const built = new Set(ds.parcels.map(p => p.key)); for (const [k, r] of attr) if (!built.has(k) && !ds.meta.badRing.some(b => b.label === fmtN(r)) && r.PAR_N_M > 0 && !(r.AREA_NEW === 0 && !r.CENTER_Y)) ds.meta.noRing.push({ label: fmtN(r) }); }   // 新面積 0 且中心坐標 0＝已刪除的宗地（NECEXE 刪宗地後保留這種 D11 列）
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
      const lb = g.sub ? `${g.sec}-${g.sub}` : `${g.sec}`;   // BNP 前兩欄是地號母號、子號（變數名沿用舊稱 sec/sub）
      ds.parcels.push({ key: k, section: g.sec, label: lb, oldLabel: lb, ids,
        areaRef: r ? r.calc : null, areaReg: r ? r.reg : null });
    }
    return finalize(ds);
  }

  // ── 幾何 ────────────────────────────────────────────────────────────────
  // 有號面積（逆時針為正）。相對第一個頂點計算：座標 ~1e6 量級時，避免大數相減造成浮點誤差
  function signedArea(ids, points) {
    if (ids.length < 3) return 0;   // 已刪除的宗地（環為空）面積 0
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
    const o = ds.orig, st = o && structSummary(ds);
    if (o && (st.added || st.removed || st.rings || st.holes || st.deleted)) {
      ds.points = new Map(o.points.map(q => [q.id, { ...q }]));
      ds.parcels.forEach((p, i) => { if (!o.rings[i]) { p.ids = []; p.mid = []; p.deleted = true; return; } p.ids = o.rings[i].ids.slice(); if (o.rings[i].mid) p.mid = o.rings[i].mid.slice(); });
      for (const p of ds.parcels) { p.deleted = !!p.created; for (const hi of (p.holes || []).slice()) linkHole(ds, p.idx, hi, false); }
      ds.parcels.forEach((p, i) => { for (const hi of (o.rings[i] && o.rings[i].holes) || []) linkHole(ds, i, hi, true); });
      buildTopology(ds); buildArcs(ds);
    }
    for (const p of ds.points.values()) { p.y = p.y0; p.x = p.x0; }
    for (const pc of ds.parcels) pc.area = pc.areaOrig;
  }
  const isMoved = p => Math.abs(p.y - p.y0) > 1e-6 || Math.abs(p.x - p.x0) > 1e-6;   // 容差 1e-6 m，忽略來回旋轉的浮點殘差
  function movedPoints(ds) { return [...ds.points.values()].filter(isMoved); }

  // ── 界址點編修（新增／刪除）：維持宗地完整 ─────────────────────────────────
  // 原則：點的增減一律同步到「所有」含該點的宗地環（共用界址點不會只改一邊）；圓弧相關的點不動；
  // 刪除後環不得少於 3 點。每次編修回傳 delta，供復原／重做（applyDelta）。
  const newDelta = () => ({ parcels: new Map(), added: [], removed: [] });
  function mergeDelta(d, d2) {   // 把後一步 d2 併入 d：各宗地保留最早的「前」狀態，「後」狀態由 closeDelta 重算
    for (const [i, t] of d2.parcels) if (!d.parcels.has(i)) d.parcels.set(i, { ids0: t.ids0, mid0: t.mid0 });
    d.added.push(...d2.added); d.removed.push(...d2.removed); return d;
  }
  function touchParcel(d, p) { if (!d.parcels.has(p.idx)) d.parcels.set(p.idx, { ids0: p.ids.slice(), mid0: p.mid ? p.mid.slice() : null }); }
  function closeDelta(ds, d) {
    for (const [i, t] of d.parcels) { const p = ds.parcels[i]; t.ids1 = p.ids.slice(); t.mid1 = p.mid ? p.mid.slice() : null; }
    buildTopology(ds); buildArcs(ds); recalc(ds, new Set(d.parcels.keys())); return d;
  }
  function applyDelta(ds, d, dir) {
    const undo = dir === 'undo';
    for (const [i, t] of d.parcels) { const p = ds.parcels[i]; p.ids = (undo ? t.ids0 : t.ids1).slice(); const m = undo ? t.mid0 : t.mid1; if (m) p.mid = m.slice(); }
    for (const p of d.added) undo ? ds.points.delete(p.id) : ds.points.set(p.id, p);
    for (const p of d.removed) undo ? ds.points.set(p.id, p) : ds.points.delete(p.id);
    for (const l of d.holes || []) linkHole(ds, l.p, l.h, undo ? !l.on : l.on);
    for (const i of d.deleted || []) ds.parcels[i].deleted = !undo;
    for (const i of d.created || []) ds.parcels[i].deleted = undo;
    buildTopology(ds); buildArcs(ds); recalc(ds, new Set(d.parcels.keys()));
  }
  const nextPointId = ds => { let m = 0; for (const id of ds.points.keys()) if (id > m) m = id; return m + 1; };
  const segKey = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
  // 在界址線 a–b 上新增點：預設取 (y,x) 在線上的垂足（面積不變）；opt.project=false 則放在指定位置。所有以此線為界的宗地都會插入新點。
  function insertPoint(ds, a, b, y, x, opt = {}) {
    const e = ds.edges.get(segKey(a, b)); if (!e) throw new Error(`找不到界址線 ${a}–${b}`);
    if (e.arcPart) throw new Error('圓弧上的線段暫不支援加點');
    const A = ds.points.get(e.a), B = ds.points.get(e.b);
    let py = y, px = x;
    if (opt.project !== false) {
      const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy; if (!l2) throw new Error('線長為 0');
      const t = Math.max(0.001, Math.min(0.999, ((x - A.x) * dx + (y - A.y) * dy) / l2)); py = A.y + t * dy; px = A.x + t * dx;
    }
    const id = opt.id != null ? opt.id : nextPointId(ds); if (ds.points.has(id)) throw new Error(`點號 ${id} 已存在`);
    const np = { id, y: py, x: px, y0: py, x0: px, row: null, added: true }, d = newDelta();
    for (const pi of e.parcels) {
      const p = ds.parcels[pi], n = p.ids.length; let done = false;
      for (let i = 0; i < n && !done; i++) {
        const u = p.ids[i], v = p.ids[(i + 1) % n];
        if ((u === e.a && v === e.b) || (u === e.b && v === e.a)) { touchParcel(d, p); p.ids.splice(i + 1, 0, id); if (p.mid) p.mid.splice(i + 1, 0, false); done = true; }
      }
    }
    ds.points.set(id, np); d.added.push(np);
    return { id, delta: closeDelta(ds, d) };
  }
  // 點移到直線 a–b 的垂足：回傳 {entries:[[id,y,x]], moved:[{id,d,out}], skipped:[{id,reason}]}（不修改資料，交給 setPoints）。out＝垂足在線段延長線上
  function footsOnLine(ds, ids, a, b) {
    const A = ds.points.get(a), B = ds.points.get(b); if (!A || !B) throw new Error('找不到線的端點');
    const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy; if (!l2) throw new Error(`${a} 與 ${b} 位置相同，無法定出直線`);
    const entries = [], moved = [], skipped = [];
    for (const id of ids) {
      if (id === a || id === b) { skipped.push({ id, reason: '是線的端點' }); continue; }
      const P = ds.points.get(id); if (!P) { skipped.push({ id, reason: '找不到此點' }); continue; }
      const t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / l2, x = A.x + t * dx, y = A.y + t * dy, d = Math.hypot(x - P.x, y - P.y);
      entries.push([id, y, x]); moved.push({ id, d, out: t < 0 || t > 1 });
    }
    return { entries, moved, skipped };
  }
  // 孤立點（不屬於任何宗地）：新增點位
  function addFreePoint(ds, y, x, id) {
    id = id != null ? id : nextPointId(ds); if (ds.points.has(id)) throw new Error(`點號 ${id} 已存在`);
    const np = { id, y, x, y0: y, x0: x, row: null, added: true }, d = newDelta(); ds.points.set(id, np); d.added.push(np); return { id, delta: closeDelta(ds, d) };
  }
  // 能否從所有環移除此點？回傳 null＝可以，否則為原因
  function removeBlocker(ds, id) {
    for (const pi of ds.pointParcels.get(id) || []) {
      const p = ds.parcels[pi], n = p.ids.length; let occ = 0;
      for (let i = 0; i < n; i++) if (p.ids[i] === id) { occ++; if (p.mid && (p.mid[i] || p.mid[(i + n - 1) % n] || p.mid[(i + 1) % n])) return '圓弧上的點'; }
      if (n - occ < 3) return `宗地 ${p.label} 只剩 ${n - occ} 點`;
    }
    return null;
  }
  // 刪除多個點（內部用：不重建拓撲）。回傳 {done, skipped:[{id,reason}]}
  function removeInto(ds, ids, d) {
    const done = [], skipped = [];
    for (const id of ids) {
      const pt = ds.points.get(id); if (!pt) continue;
      const why = removeBlocker(ds, id); if (why) { skipped.push({ id, reason: why }); continue; }
      for (const pi of ds.pointParcels.get(id) || []) {
        const p = ds.parcels[pi]; touchParcel(d, p);
        for (let i = p.ids.length - 1; i >= 0; i--) if (p.ids[i] === id) { p.ids.splice(i, 1); if (p.mid) p.mid.splice(i, 1); }
      }
      ds.points.delete(id); d.removed.push(pt); done.push(id);
    }
    return { done, skipped };
  }
  function removePoints(ds, ids) {
    const d = newDelta(), r = removeInto(ds, ids, d); closeDelta(ds, d); return { ...r, delta: d };
  }
  const usedIds = ds => { const s = new Set(); for (const p of ds.parcels) for (const id of p.ids) s.add(id); return s; };
  // 沒有任何宗地使用的界址點（沒有宗地時不判斷，避免整批誤刪）
  function unusedPoints(ds) {
    if (!ds.parcels.length) return []; const u = usedIds(ds); return [...ds.points.keys()].filter(id => !u.has(id));
  }
  // 直線上的多餘點：點 B 與前後鄰點 A、C 組成三角形，B 到 AC 的高 h ≤ 門檻 → 多餘。
  // 門檻＝ratio × 三角形最長邊（相對值，長線容許較大偏差），可再用 maxAbs（公尺）封頂。含此點的「每一個」環都必須是直線通過才算，
  // 所以轉角點、T 字路口的點不會被刪。回傳 {h, L} 或 null。
  const COLLINEAR_DEFAULT = { ratio: 0.001, maxAbs: 0.05 };
  function collinearCheck(ds, id, opt) {
    const pps = ds.pointParcels.get(id); if (!pps || !pps.length) return null;
    const ratio = opt.ratio, cap = opt.maxAbs > 0 ? opt.maxAbs : Infinity; let worst = 0, Lw = 0;
    // 三叉點：各環看到的前後鄰點不是同一組（接出去的界址線多於 2 條）→ 各環各自走不同的弦會留下縫，不可刪（真實案件 KC0336 的 5236）
    const nbr = new Set();
    for (const pi of pps) { const p = ds.parcels[pi], n = p.ids.length; for (let i = 0; i < n; i++) if (p.ids[i] === id) { nbr.add(p.ids[(i + n - 1) % n]); nbr.add(p.ids[(i + 1) % n]); } }
    if (nbr.size > 2) return null;
    for (const pi of pps) {
      const p = ds.parcels[pi], n = p.ids.length; if (n < 4) return null;
      let hit = false;
      for (let i = 0; i < n; i++) {
        if (p.ids[i] !== id) continue; hit = true;
        const ia = (i + n - 1) % n, ic = (i + 1) % n;
        if (p.mid && (p.mid[i] || p.mid[ia] || p.mid[ic])) return null;
        const A = ds.points.get(p.ids[ia]), B = ds.points.get(id), C = ds.points.get(p.ids[ic]); if (!A || !C || p.ids[ia] === p.ids[ic]) return null;
        const ab = Math.hypot(B.x - A.x, B.y - A.y), bc = Math.hypot(C.x - B.x, C.y - B.y), ac = Math.hypot(C.x - A.x, C.y - A.y), L = Math.max(ab, bc, ac);
        if (!L) return null;
        const h = distToSeg(B.x, B.y, A.x, A.y, C.x, C.y);
        if (h > Math.min(ratio * L, cap)) return null;
        if (h > worst) { worst = h; Lw = L; }
      }
      if (!hit) return null;
    }
    return { h: worst, L: Lw };
  }
  function collinearCandidates(ds, opt = {}) {
    const o = { ...COLLINEAR_DEFAULT, ...opt }, out = [];
    for (const id of ds.pointParcels.keys()) { const r = collinearCheck(ds, id, o); if (r) out.push({ id, ...r, protected: !!(o.protect && o.protect.has(id)) }); }
    return out.sort((a, b) => a.h - b.h);
  }
  // 鄰段接縫守則：鄰段在接縫上有界址點的位置，測區也必須有點。
  // protect＝測區中與鄰段界址點相距 ≤ 半徑（max(重合容差, 吸附上限)）的點（即使在直線上也不可刪）；
  // adds＝鄰段有點、測區在該處的界線上沒有點（missing_in_main）→ 需要補點。
  function seamGuard(main, neighbors, opt = {}) {
    neighbors = neighbors.filter(n => seamMode(n) === 'numeric');   // 只有數值區要照抄鄰段的點；圖解區接縫上的直線點照去雜點原則處理
    const params = { ...SEAM_DEFAULT, ...opt }, radius = Math.max(params.tol, params.snap || 0), protect = new Set(), adds = [], seen = new Set();
    for (const n of neighbors) {
      const chk = seamCheck(main, n.ds, params);
      for (const r of chk.points) if (r.vertex_dist <= radius) protect.add(r.id);
      for (const q of chk.neighbor_points) {
        if (q.status !== 'missing_in_main') continue;
        const k = q.x.toFixed(4) + ',' + q.y.toFixed(4); if (seen.has(k)) continue; seen.add(k);
        adds.push({ y: q.y, x: q.x, neighbor: n.name, neighbor_point: q.id });
      }
    }
    return { protect, adds, radius, tol: params.tol };
  }
  // 把 adds 補進測區界線（只補在單一宗地的段界直線段上，投影到線上，面積不變）
  function addSeamPoints(ds, adds, tol, d, out) {
    for (const a of adds) {
      let best = null, bd = Infinity;
      for (const e of ds.edges.values()) {
        if (e.parcels.length !== 1 || e.arcPart) continue; const p = ds.parcels[e.parcels[0]]; if (p.containers && p.containers.length) continue;
        const A = ds.points.get(e.a), B = ds.points.get(e.b), dd = distToSeg(a.x, a.y, A.x, A.y, B.x, B.y); if (dd < bd) { bd = dd; best = e; }
      }
      if (!best || bd > tol) { out.skippedAdds.push({ neighbor: a.neighbor, neighbor_point: a.neighbor_point, reason: '測區該處是圓弧或找不到界線' }); continue; }
      const r = insertPoint(ds, best.a, best.b, a.y, a.x); mergeDelta(d, r.delta); out.added.push({ id: r.id, neighbor: a.neighbor, neighbor_point: a.neighbor_point }); out.protect.add(r.id);
    }
  }
  // 一鍵清理：① 補上鄰段有、測區缺的接縫點（opt.adds）② 沒有宗地使用的點 ③ 直線上的多餘點；opt.protect 內的點一律不刪。
  // 逐點以「目前」的鄰點重新判斷（連續多點共線時不會累積漂移）。
  // 回傳 {added, unused, collinear, skipped, skippedAdds, kept, delta}；呼叫端自行決定是否保留（預覽時用 applyDelta(…,'undo') 還原）。
  // 點格網（查詢範圍內的點）
  function pointGrid(ds, cell = 10) {
    const g = new Map(), cc = v => Math.floor(v / cell);
    for (const p of ds.points.values()) { const k = cc(p.x) + ',' + cc(p.y); let l = g.get(k); if (!l) g.set(k, l = []); l.push(p.id); }
    return { query(x0, y0, x1, y1) { const out = []; for (let i = cc(x0); i <= cc(x1); i++) for (let j = cc(y0); j <= cc(y1); j++) { const l = g.get(i + ',' + j); if (l) out.push(...l); } return out; } };
  }
  // 移除點 B 會讓各環改走弦 AC：若三角形 ABC（含邊界）裡有「不在這些環內」的別宗地界址點，弦會跨過它，造成交錯。回傳擋住的點號或 null。
  function sweepBlocker(ds, grid, id) {
    const pps = ds.pointParcels.get(id) || [], inB = new Set(pps), B = ds.points.get(id);
    for (const pi of pps) {
      const p = ds.parcels[pi], n = p.ids.length, i = p.ids.indexOf(id), A = ds.points.get(p.ids[(i + n - 1) % n]), C = ds.points.get(p.ids[(i + 1) % n]);
      if (distToSeg(B.x, B.y, A.x, A.y, C.x, C.y) <= 1e-4) continue;   // 幾乎在線上：掃過的面積可忽略
      const cr = (u, v, w) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x), t = Math.sign(cr(A, B, C)), tol = 1e-6 * Math.max(Math.hypot(B.x - A.x, B.y - A.y), Math.hypot(C.x - B.x, C.y - B.y), Math.hypot(C.x - A.x, C.y - A.y));
      for (const q of grid.query(Math.min(A.x, B.x, C.x), Math.min(A.y, B.y, C.y), Math.max(A.x, B.x, C.x), Math.max(A.y, B.y, C.y))) {
        if (q === A.id || q === B.id || q === C.id || !ds.points.has(q)) continue;
        const qq = ds.pointParcels.get(q); if (!qq || qq.every(x => inB.has(x))) continue;   // 沒有宗地用、或只屬於同樣要簡化的環：不擋
        const X = ds.points.get(q);
        if (t * cr(A, B, X) >= -tol && t * cr(B, C, X) >= -tol && t * cr(C, A, X) >= -tol) return q;
      }
    }
    return null;
  }
  function cleanupPoints(ds, opt = {}) {
    const protect = new Set(opt.protect || []), o = { unused: true, collinear: true, ...COLLINEAR_DEFAULT, ...opt, protect }, d = newDelta();
    const res = { added: [], unused: [], collinear: [], skipped: [], skippedAdds: [], kept: 0, blocked: [], protect };
    if (opt.adds && opt.adds.length) addSeamPoints(ds, opt.adds, opt.tol != null ? opt.tol : SEAM_DEFAULT.tol, d, res);
    if (o.unused) { const r = removeInto(ds, unusedPoints(ds).filter(id => !protect.has(id)), d); res.unused = r.done; res.skipped.push(...r.skipped); }
    if (o.collinear) {
      const grid = pointGrid(ds);
      for (const c of collinearCandidates(ds, o)) {
        if (c.protected) { res.kept++; continue; }
        if (!collinearCheck(ds, c.id, o)) continue;
        const bl = sweepBlocker(ds, grid, c.id); if (bl != null) { res.blocked.push({ id: c.id, by: bl }); continue; }
        const r = removeInto(ds, [c.id], d); res.collinear.push(...r.done); res.skipped.push(...r.skipped);
      }
    }
    closeDelta(ds, d); res.delta = d; return res;
  }
  // 結構是否有異動（新增／刪除點、環改變）
  function structSummary(ds) {
    const o = ds.orig; if (!o) return { added: 0, removed: 0, rings: 0, holes: 0, deleted: 0, created: 0 };
    const was = new Set(o.points.map(p => p.id)); let added = 0, removed = 0, rings = 0;
    for (const id of ds.points.keys()) if (!was.has(id)) added++;
    for (const id of was) if (!ds.points.has(id)) removed++;
    ds.parcels.forEach((p, i) => { const r = o.rings[i]; if (p.created && p.deleted) return; if (!r || r.ids.length !== p.ids.length || r.ids.some((v, k) => v !== p.ids[k])) rings++; });
    let holes = 0; ds.parcels.forEach((p, i) => { const a = (o.rings[i] && o.rings[i].holes) || [], b = p.holes || []; if (a.length !== b.length || a.some(v => !b.includes(v))) holes++; });
    const deleted = ds.parcels.filter(p => p.deleted && !p.created).length, created = ds.parcels.filter(p => p.created && !p.deleted).length;
    return { added, removed, rings, holes, deleted, created };
  }

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
  // 鄰段種類（v0.24.0）：numeric＝數值區（接邊界址點完全照抄）、graphic＝圖解區（平移比形狀，只防重疊）、none＝只比對。舊的 authoritative 旗標相容：false＝none
  const seamMode = n => n.mode || (n.authoritative === false ? 'none' : 'numeric');
  const shiftedDataset = (ds, dx, dy) => ({ ...ds, points: new Map([...ds.points].map(([k, p]) => [k, { ...p, x: p.x + dx, y: p.y + dy }])) });
  // 圖解區鄰段的平移量：本段段界點到鄰段段界線（點到線 ICP，只平移）。opt.graphicSearch：找接縫點的距離（預設 10 m）
  function seamShift(main, nb, opt = {}) {
    const search = opt.graphicSearch ?? 10, nbb = boundarySegments(nb), idx = segIndex(nbb.segs, Math.max(search, 1));
    const V = [...boundarySegments(main).vids].map(id => main.points.get(id)).filter(Boolean); let dx = 0, dy = 0, used = 0, med = 0;
    for (let it = 0; it < 10; it++) {
      const res = []; for (const P of V) { const s = idx.nearest(P.x - dx, P.y - dy, search); if (s) res.push({ ex: P.x - dx - s.fx, ey: P.y - dy - s.fy, d: s.dist }); }
      if (res.length < 3) return { dx: 0, dy: 0, n: res.length, median: null };
      med = median(res.map(r => r.d)); const lim = Math.max(3 * med, 0.3), use = res.filter(r => r.d <= lim); used = use.length; if (!used) break;
      const mx = use.reduce((t, r) => t + r.ex, 0) / used, my = use.reduce((t, r) => t + r.ey, 0) / used; dx += mx; dy += my; if (Math.hypot(mx, my) < 0.001) break;
    }
    return { dx, dy, n: used, median: med };
  }
  function seamAnalyze(main, neighbors, opt = {}) {
    const params = { ...SEAM_DEFAULT, ...opt };
    const list = neighbors.map(n => { const mode = seamMode(n), sh = mode === 'graphic' ? (n.shift || seamShift(main, n.ds, params)) : null;   // 圖解區：對平移後的鄰段判斷重疊／脫開（n.shift：沿用先前算好的平移量，接合後不因點位改變而漂移）
      return { name: n.name, mode, authoritative: mode === 'numeric', shift: sh, ...seamCheck(main, sh ? shiftedDataset(n.ds, sh.dx, sh.dy) : n.ds, params) }; });
    const sum = k => list.reduce((s, n) => s + n.summary[k], 0);
    return { generated: new Date().toISOString(), main: main.name, params, neighbors: list,
      totals: { checked: sum('checked'), coincide: sum('coincide'), overlap: sum('overlap'), gap: sum('gap'), neighbor_missing_in_main: sum('neighbor_missing_in_main') } };
  }
  // 自動接合：逐一對「以鄰段為準」的鄰段吸附，回傳 { before, after, moves, unresolved }；點位已就地修改（呼叫端負責復原快照）
  function seamJoin(main, neighbors, opt = {}) {
    const params = { ...SEAM_DEFAULT, ...opt }, before = seamAnalyze(main, neighbors, params), moves = [], unresolved = [], shifts = {};
    neighbors = neighbors.map(n => (seamMode(n) === 'graphic' && !n.shift ? { ...n, shift: before.neighbors.find(b => b.name === n.name).shift } : n));   // 圖解區平移量以接合前為準
    for (const n of neighbors) {
      const mode = seamMode(n); if (mode === 'none') continue;
      if (mode === 'graphic') {   // 圖解區：位置不照抄、不補點；平移鄰段比形狀後，只把跑進鄰段宗地的點推回鄰段界線上，脫開不動
        const sh = n.shift || seamShift(main, n.ds, params), chk = seamCheck(main, shiftedDataset(n.ds, sh.dx, sh.dy), params), entries = []; shifts[n.name] = sh;
        for (const r of chk.points) { if (r.status !== 'overlap') continue;
          if (r.dist > params.snap) { unresolved.push({ id: r.id, reason: 'beyond_snap', status: 'overlap', gap_m: r.gap_m, neighbor: n.name }); continue; }
          moves.push({ id: r.id, neighbor: n.name, type: 'push', from: { y: r.y, x: r.x }, to: r.foot, dist: r.dist, status: 'overlap' }); entries.push([r.id, r.foot.y, r.foot.x]); }
        setPoints(main, entries); continue;
      }
      const chk = seamCheck(main, n.ds, params), plan = seamPlan(chk, params), entries = [];
      for (const [vid, c] of plan.claim) {
        const v = n.ds.points.get(vid), p = main.points.get(c.r.id);
        moves.push({ id: p.id, neighbor: n.name, type: 'vertex', neighbor_point: vid, from: { y: p.y, x: p.x }, to: { y: v.y, x: v.x }, dist: c.r.vertex_dist, status: c.r.status }); entries.push([p.id, v.y, v.x]);
      }
      for (const m of plan.moves) { moves.push({ ...m, neighbor: n.name }); entries.push([m.id, m.to.y, m.to.x]); }
      for (const u of plan.unresolved) unresolved.push({ ...u, neighbor: n.name });
      setPoints(main, entries);
    }
    return { before, after: seamAnalyze(main, neighbors, params), moves, unresolved, shifts };
  }
  // 數值區鄰段（v0.24.0）：接邊界址點與鄰段「不多不少、完全照抄」。seamJoin 吸附之後呼叫：
  // ① 鄰段在接縫上有點、本段界線上沒有 → 補點；② 本段點在鄰段界線上、鄰段沒有對應點 → 刪除（只屬於一宗、刪後界線仍是直線）。
  // T 字點（本段內部界線接到接縫，屬於兩宗以上）刪不得，列在 kept。回傳 {delta, added, removed, kept, skippedAdds}
  function seamExact(main, neighbors, opt = {}) {
    const params = { ...SEAM_DEFAULT, ...opt }, nbs = neighbors.filter(n => seamMode(n) === 'numeric'), d = newDelta(), out = { added: [], skippedAdds: [], protect: new Set() }, removed = [], kept = [];
    if (nbs.length) {
      const g = seamGuard(main, nbs, params); addSeamPoints(main, g.adds, params.tol, d, out);
      const nbV = nbs.flatMap(n => [...boundarySegments(n.ds).vids].map(id => n.ds.points.get(id)).filter(Boolean)), col = { ratio: 0.001, maxAbs: 0.05 }, seen = new Set();
      const cand = []; for (const n of nbs) for (const r of seamCheck(main, n.ds, params).points) if (r.status === 'coincide' && r.kind === 'line') cand.push(r);   // 先找齊再刪（刪點時邊表尚未重建）
      for (const r of cand) {
        if (seen.has(r.id) || !main.points.has(r.id)) continue; seen.add(r.id);
        if (nbV.some(v => Math.hypot(v.x - r.x, v.y - r.y) <= params.tol)) continue;
        if ((main.pointParcels.get(r.id) || []).length !== 1) { kept.push({ id: r.id, reason: 'T 字點（本段內部界線接到這裡）' }); continue; }
        if (!collinearCheck(main, r.id, col) || sweepBlocker(main, pointGrid(main), r.id) != null) { kept.push({ id: r.id, reason: '刪了會改變形狀' }); continue; }
        const rr = removeInto(main, [r.id], d); removed.push(...rr.done);
      }
    }
    closeDelta(main, d); return { delta: d, added: out.added, skippedAdds: out.skippedAdds, removed, kept };
  }
  const f3 = v => (v == null ? '' : Number(v).toFixed(3));
  function seamReportText(rep) {
    const L = [`鄰段接合報告　主要測區：${rep.main}　容差 ${rep.params.tol} m／搜尋 ${rep.params.search} m／吸附 ${rep.params.snap} m`, `合計：檢查 ${rep.totals.checked} 點；重合 ${rep.totals.coincide}、重疊 ${rep.totals.overlap}、脫開 ${rep.totals.gap}；鄰段點在主區界線上但主區無對應點 ${rep.totals.neighbor_missing_in_main}`];
    for (const n of rep.neighbors) {
      const s = n.summary;
      L.push('', `■ 鄰段 ${n.name}${n.mode === 'graphic' ? `（圖解區：平移 ΔE ${f3(n.shift && n.shift.dx)}、ΔN ${f3(n.shift && n.shift.dy)} m 後比對）` : n.authoritative ? '（數值區：照抄）' : '（僅比對）'}：檢查 ${s.checked} 點；重合 ${s.coincide}（點上 ${s.coincide_vertex}／線上 ${s.coincide_line}）、重疊 ${s.overlap}（最大 ${f3(s.max_overlap_m)} m）、脫開 ${s.gap}（最大 ${f3(s.max_gap_m)} m）；鄰段缺點 ${s.neighbor_missing_in_main}、無對應 ${s.neighbor_unmatched}`);
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

  // ── 界址線的交錯／重疊偵測（NECEXE 報表的「交錯」「重疊」）─────────────────────
  // 交錯＝兩條不共端點的線相交或共線重疊；重疊＝共一個端點且共線重疊。同一條線（兩端點相同）不算。圓弧的弦不檢查。
  function edgeRelation(ds, e1, e2, eps = 1e-3) {
    const a = ds.points.get(e1.a), b = ds.points.get(e1.b), c = ds.points.get(e2.a), d = ds.points.get(e2.b);
    const shared = (e1.a === e2.a) + (e1.a === e2.b) + (e1.b === e2.a) + (e1.b === e2.b); if (shared >= 2) return null;
    const bx = b.x - a.x, by = b.y - a.y, dx = d.x - c.x, dy = d.y - c.y, L1 = Math.hypot(bx, by), L2 = Math.hypot(dx, dy); if (!L1 || !L2) return null;
    const cr = (ux, uy, vx, vy) => ux * vy - uy * vx;
    const o1 = cr(bx, by, c.x - a.x, c.y - a.y) / L1, o2 = cr(bx, by, d.x - a.x, d.y - a.y) / L1, o3 = cr(dx, dy, a.x - c.x, a.y - c.y) / L2, o4 = cr(dx, dy, b.x - c.x, b.y - c.y) / L2;
    if (Math.abs(o1) < eps && Math.abs(o2) < eps) {   // 共線：看投影重疊長度
      const tc = ((c.x - a.x) * bx + (c.y - a.y) * by) / L1, td = ((d.x - a.x) * bx + (d.y - a.y) * by) / L1, ov = Math.min(L1, Math.max(tc, td)) - Math.max(0, Math.min(tc, td));
      return ov > eps ? (shared ? 'overlap' : 'cross') : null;
    }
    if (!shared && o1 * o2 < 0 && o3 * o4 < 0 && Math.min(Math.abs(o1), Math.abs(o2), Math.abs(o3), Math.abs(o4)) > eps) return 'cross';
    return null;
  }
  const freeRegions = ds => outlineLoops(ds, ds.parcels.filter(p => !(p.containers && p.containers.length)).map(p => p.idx)).filter(l => l.area < -1e-6);
  function ringConflicts(ds) {
    const edges = [...ds.edges.values()].filter(e => !e.arcPart), cell = 10, grid = new Map(), cc = v => Math.floor(v / cell), out = { cross: [], overlap: [] }, seen = new Set();
    edges.forEach((e, n) => {
      const a = ds.points.get(e.a), b = ds.points.get(e.b);
      for (let i = cc(Math.min(a.x, b.x)); i <= cc(Math.max(a.x, b.x)); i++) for (let j = cc(Math.min(a.y, b.y)); j <= cc(Math.max(a.y, b.y)); j++) { const k = i + ',' + j; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(n); }
    });
    for (const l of grid.values()) for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      const k = l[i] < l[j] ? l[i] * 1e7 + l[j] : l[j] * 1e7 + l[i]; if (seen.has(k)) continue; seen.add(k);
      const r = edgeRelation(ds, edges[l[i]], edges[l[j]]); if (r) out[r === 'cross' ? 'cross' : 'overlap'].push([edges[l[i]], edges[l[j]]]);
    }
    return out;
  }

  // ── 宗地關係偵錯報表（仿 NECEXE 的 .ERR）─────────────────────────────────────
  // 各宗地輪廓的外圍環：取每個環（轉成逆時針）的有向邊，抵消掉有反向邊的（內部共邊），剩下的接成環。
  // 回傳 [{ids, area}]，area 有號（外圍為正、內部空洞為負），由大到小。弧線以弦計。
  function outlineLoops(ds, idxs) {
    const half = new Map();
    for (const i of idxs) {
      const p = ds.parcels[i]; let ids = p.ids; if (signedArea(ids, ds.points) < 0) ids = ids.slice().reverse();
      for (let k = 0; k < ids.length; k++) { const a = ids[k], b = ids[(k + 1) % ids.length]; if (a !== b) half.set(a + '>' + b, [a, b]); }
    }
    // 邊界有向邊（宗地在左側）。外圍＝順著邊界追蹤；自由閉合區（空隙）＝把邊反向、追蹤空隙那一側的面。
    // 在有多條出邊的點（面只在一點相接），選「最左轉」的出邊，才會各自貼著各自的面、拆成獨立的環
    const bnd = [...half.values()].filter(([a, b]) => !half.has(b + '>' + a)), P = id => ds.points.get(id);
    const trace = edges => {
      const out = new Map(), res = [];
      for (const [a, b] of edges) { let l = out.get(a); if (!l) out.set(a, l = []); l.push({ b, used: false }); }
      for (const [a0, list] of out) for (const e0 of list) {
        if (e0.used) continue; e0.used = true;
        const ids = [a0]; let cur = e0, from = a0;
        for (let guard = 0; guard < 1e6; guard++) {
          const to = cur.b; if (to === a0) break; ids.push(to);
          const cand = (out.get(to) || []).filter(e => !e.used); if (!cand.length) break;
          const ux = P(to).x - P(from).x, uy = P(to).y - P(from).y; let best = null, ba = -Infinity;
          for (const e of cand) { const vx = P(e.b).x - P(to).x, vy = P(e.b).y - P(to).y, ang = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); if (ang > ba) { ba = ang; best = e; } }
          best.used = true; from = to; cur = best;
        }
        if (ids.length >= 3) res.push({ ids, area: signedArea(ids, ds.points) });
      }
      return res;
    };
    const loops = trace(bnd).filter(l => l.area > 0);
    for (const l of trace(bnd.map(([a, b]) => [b, a])).filter(l => l.area > 0)) loops.push({ ids: l.ids.slice().reverse(), area: -l.area });
    return loops.sort((x, y) => y.area - x.area);
  }
  const pad = (v, n) => String(v).padStart(n, ' ');
  const idLines = ids => { const o = []; for (let i = 0; i < ids.length; i += 10) o.push(ids.slice(i, i + 10).map(v => pad(v, 7) + ' ').join('')); return o; };
  const parLabelFull = p => { const l = String(p.label); return `${l.includes('-') ? l : l + '-0'}-${p.section}`; };
  // opt: {name, date(Date), pts:{confirmed, refs}}；回傳文字（換行 \n）。NECEXE 讀取調查情形、界址查註、坐標來源等欄位的區塊，本程式未讀取，會明確註明略過。
  function errReport(ds, opt = {}) {
    const L = [], bar = '-'.repeat(80), eq = t => `${'='.repeat(25)} ${t} ${'='.repeat(25)}`, d = opt.date || new Date(), name = opt.name || ds.name || '';
    L.push(`${'='.repeat(30)} 重測成果檢核 ${name} (${d.getFullYear() - 1911}.${pad(d.getMonth() + 1, 2)}.${pad(d.getDate(), 2)}) ${'='.repeat(30)}`);
    // 界址點號檢核
    const idsAll = [...ds.points.keys()].sort((a, b) => a - b); L.push(' 界址點號檢核 (列出空號超出 50 點者)');
    for (let i = 0; i + 1 < idsAll.length; i++) if (idsAll[i + 1] - idsAll[i] - 1 > 50) L.push(` 界址點號 ${idsAll[i] + 1} - ${idsAll[i + 1] - 1} 為空號`);
    const maxId = idsAll.length ? idsAll[idsAll.length - 1] : 0; L.push(` 最大界址點號 ${maxId} `); if (maxId > 7500) L.push(' 超出 7500 點上限');
    L.push('='.repeat(30));
    // 面積
    L.push(bar);
    const sumNew = ds.parcels.reduce((s, p) => s + p.area, 0), refs = ds.parcels.filter(p => p.areaRef != null);
    L.push(`各筆宗地實際新面積總和 = ${sumNew.toFixed(2)} ㎡`);
    // 宗地面積為 0、界址線交錯／重疊（NECEXE 同樣列在這裡）
    for (const p of ds.parcels) if (!p.deleted && p.area < 0.005 && !(p.areaRef === 0)) L.push(` ${parLabelFull(p)} 地號新面積為 0.00 且未設定合併關係`);
    const cf = ringConflicts(ds), pl = e => { const p = ds.parcels[e.parcels[0]]; return `${parLabelFull(p)} 地號 /${e.a},${e.b}`; };
    for (const [kind, word] of [['cross', '交錯'], ['overlap', '重疊']]) for (const [e1, e2] of cf[kind]) L.push(`${pl(e1)} 與 ${pl(e2)} ${word}`);
    L.push(refs.length ? `各筆宗地登記新面積總和 = ${refs.reduce((s, p) => s + p.areaRef, 0).toFixed(2)} ㎡` : '各筆宗地登記新面積總和 = （無 D11 新面積）');
    L.push(bar);
    const allLoops = outlineLoops(ds, ds.parcels.filter(p => !(p.containers && p.containers.length)).map(p => p.idx)).filter(l => Math.abs(l.area) > 1e-6).sort((x, y) => Math.abs(y.area) - Math.abs(x.area));
    for (const l of allLoops) { L.push(`${l.area > 0 ? '段外圍面積' : '自由閉合區面積'} = ${Math.abs(l.area).toFixed(2)} ㎡`); L.push(...idLines(l.ids)); }   // 自由閉合區＝宗地之間沒被任何宗地涵蓋的封閉空隙
    for (const p of ds.parcels) {
      if (!p.holes || !p.holes.length) continue;
      L.push(bar); L.push(`-- 父地 ${parLabelFull(p)} 的地中地外圍檢核 --`);
      for (const l of outlineLoops(ds, p.holes).filter(x => x.area > 0)) { L.push(`  地中地外圍面積 = ${l.area.toFixed(2)} ㎡`); L.push(...idLines(l.ids)); }
    }
    L.push('');
    // 逐項檢核
    L.push(eq('調查情形欄與經界線糾紛設定檢核')); L.push('（本工作站未讀取調查情形欄位，略過；請在 NECEXE 執行此項檢核）');
    L.push(eq('宗地資料與地號界址'));
    for (const r of ds.meta.noRing || []) L.push(`宗地地號 ${r.label} 無地號界址`);
    for (const r of ds.meta.badRing || []) L.push(`宗地地號 ${r.label} 界址環不完整（${r.count} 點${r.missing.length ? `，點檔缺 ${r.missing.slice(0, 5).join('、')}${r.missing.length > 5 ? '…' : ''}` : '，不足 3 點'}）`);
    L.push(eq('新地號重覆檢核'));
    const cnt = new Map(); for (const p of ds.parcels) cnt.set(parLabelFull(p), (cnt.get(parLabelFull(p)) || 0) + 1); for (const r of ds.meta.noRing || []) cnt.set(r.label, (cnt.get(r.label) || 0) + 1);
    for (const [k, v] of cnt) if (v > 1) L.push(`新地號 ${k} 重覆 ${v} 筆`);
    L.push(eq('界址點重覆觀測統計'));
    const pc = opt.pts ? opt.pts.confirmed : ds.points.size, pr = opt.pts ? opt.pts.refs : 0;
    L.push(`  確定點計 ${pc} 點 , 參考點計 ${pr} 點 , 合計 ${pc + pr} 點`); L.push('  （坐標來源欄位本工作站未解讀，略過）');
    L.push(eq('宗地資料檢核')); L.push('（地目、查註欄位本工作站未讀取，略過；請在 NECEXE 執行此項檢核）');
    L.push(eq('查註資料統計')); L.push(`已用經界線共  ${ds.edges.size}  線段`);
    // 補充檢核
    L.push(eq('本工作站補充檢核'));
    const un = unusedPoints(ds); L.push(`未被任何宗地使用的界址點 ${un.length} 個` + (un.length ? '：' + un.slice(0, 20).join('、') + (un.length > 20 ? '…' : '') : ''));
    const col = collinearCandidates(ds); L.push(`直線上疑似多餘的點 ${col.length} 個（三角形高不超過最長邊的千分之 ${COLLINEAR_DEFAULT.ratio * 1000}，且不超過 ${COLLINEAR_DEFAULT.maxAbs} m）`);
    const big = ds.parcels.filter(p => p.areaRef != null && Math.abs(p.area - p.areaRef) > 0.2);
    L.push(`實際面積與 D11 新面積相差超過 0.20 ㎡ 者 ${big.length} 宗`); for (const p of big.slice(0, 200)) L.push(`  ${pad(parLabelFull(p), 14)} 實際 ${p.area.toFixed(2)}  登記 ${p.areaRef.toFixed(2)}  差 ${(p.area - p.areaRef >= 0 ? '+' : '') + (p.area - p.areaRef).toFixed(2)}`);
    for (const t of ringIssueText(ds)) L.push(t);
    const dupIn = ds.parcels.filter(p => new Set(p.ids).size !== p.ids.length); L.push(`界址環內有重複點號的宗地 ${dupIn.length} 宗` + (dupIn.length ? '：' + dupIn.slice(0, 10).map(parLabelFull).join('、') : ''));
    L.push(eq(`${name} (END)`)); L.push('');
    return L.join('\n');
  }

  // ── 界址串檢查與編修（v0.11.0）：地中地被寫進外圈的界址串、環自我接觸／交錯、疑似未設定的地中地 ──────────
  // 典型情形：外圈地號的界址串依序接著「外圈 … 跳到內圈 … 繞內圈一圈 … 跳回外圈」，圖上多出兩條跳線（或一點進出的細縫）。
  // embeddedRuns 找出 p 的環中「另一宗地 h 的整圈」連續出現的位置（可旋轉、可反向，可含回到起點的重複點）。
  function embeddedRuns(ds, p) {
    const n = p.ids.length, pset = new Set(p.ids), out = [], seen = new Set();
    for (const id of pset) for (const hi of ds.pointParcels.get(id) || []) {
      if (hi === p.idx || seen.has(hi)) continue; seen.add(hi);
      const h = ds.parcels[hi], hs = h.ids, m = hs.length; if (m < 3 || n - m < 3 || !hs.every(q => pset.has(q))) continue;
      const pos = new Map(hs.map((q, j) => [q, j])); let found = null;
      for (let i = 0; i < n && !found; i++) {
        const j = pos.get(p.ids[i]); if (j == null) continue;
        for (const dir of [1, -1]) {
          let k = 0; while (k < m && p.ids[(i + k) % n] === hs[(((j + dir * k) % m) + m) % m]) k++;
          if (k < m) continue;
          let s = i, len = m;   // 往前延伸到真正的起點，再看是否有回到起點的重複點
          while (len <= m && p.ids[(s - 1 + n) % n] === hs[(((pos.get(p.ids[s]) - dir) % m) + m) % m]) { s = (s - 1 + n) % n; len++; }
          if (len === m && p.ids[(s + m) % n] === p.ids[s]) len++;
          found = { h: hi, start: s, len: Math.min(len, m + 1), dir }; break;
        }
      }
      if (found) out.push(found);
    }
    return out;
  }
  // 把 run 從環中移除，回傳剩下的外圈（去掉連續重複點）；mid 同步。
  // 通道端點：跳線接回外圈的點若只屬於 p、且離內圈 ≤ tol（預設 1 m），表示它只是通道的一角（真實案件 KC0336 的 6159，離 1092-5 僅 0.24 m），
  // 一併移除，讓外圈直接接回真正的界址點——與 NECEXE 中人工修正的結果相同。
  function cutRun(ds, p, run, tol = 1) {
    const n = p.ids.length, h = ds.parcels[run.h], P = ds.points, seq = [];
    for (let k = 0; k < n - run.len; k++) { const i = (run.start + run.len + k) % n; seq.push([p.ids[i], p.mid ? !!p.mid[i] : false, i]); }
    const dH = id => { const q = P.get(id); let m = Infinity; for (let i = 0; i < h.ids.length; i++) { const a = P.get(h.ids[i]), b = P.get(h.ids[(i + 1) % h.ids.length]); m = Math.min(m, distToSeg(q.x, q.y, a.x, a.y, b.x, b.y)); } return m; };
    const corner = ([id, mid]) => !mid && (ds.pointParcels.get(id) || []).length === 1 && dH(id) <= tol, trimmed = [];
    const jumps = [[seq[seq.length - 1][0], p.ids[run.start]], [p.ids[(run.start + run.len - 1) % n], seq[0][0]]];
    while (seq.length > 3 && corner(seq[0])) { trimmed.push(seq[0][0]); jumps.push([seq[0][0], seq[1][0]]); seq.shift(); }
    while (seq.length > 3 && corner(seq[seq.length - 1])) { trimmed.push(seq[seq.length - 1][0]); jumps.push([seq[seq.length - 2][0], seq[seq.length - 1][0]]); seq.pop(); }
    seq.sort((u, v) => u[2] - v[2]);   // 維持原本的起點與順序（剩下的是連續的一段，依原索引排序即可）
    const ids = seq.map(x => x[0]), mid = seq.map(x => x[1]);
    for (let i = ids.length - 1; i >= 0 && ids.length > 1; i--) { const j = (i + 1) % ids.length; if (ids[i] === ids[j]) { ids.splice(i, 1); mid.splice(i, 1); } }
    return { ids, mid, trimmed, jumps: jumps.filter(([a, b]) => a !== b) };
  }
  // run 是否真的是「地中地 + 跳線」：兩條跳線只屬於 p（不是與鄰地共用的界址線），且 h 沒被 p 走過的邊只屬於 h。
  // 否則是相鄰宗地剛好整圈貼著 p 的凹口（KC0336 有 24 處這種情形，都不是錯誤）。
  function isHoleRun(ds, p, run) {
    const n = p.ids.length, h = ds.parcels[run.h], only = (a, b, who) => { const e = ds.edges.get(segKey(a, b)); return e && e.parcels.length === 1 && e.parcels[0] === who; };
    const before = p.ids[(run.start - 1 + n) % n], after = p.ids[(run.start + run.len) % n], first = p.ids[run.start], last = p.ids[(run.start + run.len - 1) % n];
    if ((before !== first && !only(before, first, p.idx)) || (after !== last && !only(last, after, p.idx))) return false;
    const pe = new Set(); for (let i = 0; i < n; i++) pe.add(segKey(p.ids[i], p.ids[(i + 1) % n]));
    for (let i = 0; i < h.ids.length; i++) { const a = h.ids[i], b = h.ids[(i + 1) % h.ids.length]; if (!pe.has(segKey(a, b)) && !only(a, b, h.idx)) return false; }
    return true;
  }
  // h 是否「確實在」拆出後的外圈 ring 之內：形心在內，且 h 每一點離外圈邊界 ≥ margin（段界上的凹口，h 的點會落在外圈邊界上）
  function holeInside(ds, ring, h, margin = 0.5) {
    const P = ds.points, c = polyCentroid(h.ids, P); if (ring.length < 3 || !pointInRing(ring, P, c.y, c.x)) return 'outside';
    for (const id of h.ids) { const q = P.get(id); if (!pointInRing(ring, P, q.y, q.x)) return 'edge';
      for (let i = 0; i < ring.length; i++) { const a = P.get(ring[i]), b = P.get(ring[(i + 1) % ring.length]); if (distToSeg(q.x, q.y, a.x, a.y, b.x, b.y) < margin) return 'edge'; } }
    return 'inside';
  }
  const polyCentroid = (ids, points) => {   // 多邊形形心（相對第一點，避免大數）
    if (!ids.length) return { x: 0, y: 0 };
    const o = points.get(ids[0]); let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ids.length; i++) { const p = points.get(ids[i]), q = points.get(ids[(i + 1) % ids.length]); const px = p.x - o.x, py = p.y - o.y, qx = q.x - o.x, qy = q.y - o.y, c = px * qy - qx * py; a += c; cx += (px + qx) * c; cy += (py + qy) * c; }
    return Math.abs(a) < 1e-12 ? { x: o.x, y: o.y } : { x: o.x + cx / (3 * a), y: o.y + cy / (3 * a) };
  };
  // 回傳 [{kind, p, ...}]：kind＝embedded（內含別宗的整圈）、repeat（環重複經過同一點）、selfcross（環自己的邊相交）、missinghole（別宗整個在環內但未設地中地）
  function ringIssues(ds) {
    const out = [], P = ds.points;
    for (const p of ds.parcels) {
      if (p.deleted) continue;
      const runs = embeddedRuns(ds, p).filter(r => isHoleRun(ds, p, r)), inRun = new Set();
      for (const r of runs) {
        const h = ds.parcels[r.h], c = cutRun(ds, p, r), where = holeInside(ds, c.ids, h);
        if (where === 'edge') continue;   // 段界上的凹口：h 貼在外圈邊界上，不是地中地
        for (let k = 0; k < r.len; k++) inRun.add((r.start + k) % p.ids.length);
        const inside = where === 'inside';
        const same = Math.sign(signedArea(c.ids, P)) === Math.sign(signedArea(h.ids, P)) * r.dir,   // 內圈在 p 環中的走向＝h 本身走向 × dir
          isHole = (p.holes || []).includes(h.idx);
        const fixed = inside ? ringAreaArc(c.ids, c.mid, P) - ringAreaArc(h.ids, h.mid, P) - (p.holes || []).filter(x => x !== h.idx).reduce((s, x) => s + ringAreaArc(ds.parcels[x].ids, ds.parcels[x].mid, P), 0) : null;
        out.push({ kind: 'embedded', p: p.idx, h: h.idx, inside, sameDir: same, d12: isHole, jumps: c.jumps, trimmed: c.trimmed, areaNow: p.area, areaFixed: fixed });
      }
      const cnt = new Map(); p.ids.forEach((id, i) => { if (!inRun.has(i)) cnt.set(id, (cnt.get(id) || 0) + 1); });
      const rep = [...cnt].filter(([, v]) => v > 1).map(([k]) => k); if (rep.length) out.push({ kind: 'repeat', p: p.idx, ids: rep });
      if (!runs.length) {   // 環自己的邊相交（不相鄰的兩邊）
        const n = p.ids.length, xs = [];
        if (n <= 400) for (let i = 0; i < n && xs.length < 5; i++) for (let j = i + 2; j < n && xs.length < 5; j++) {
          if (i === 0 && j === n - 1) continue;
          const e1 = { a: p.ids[i], b: p.ids[(i + 1) % n] }, e2 = { a: p.ids[j], b: p.ids[(j + 1) % n] };
          if (e1.a === e1.b || e2.a === e2.b) continue; if (edgeRelation(ds, e1, e2) === 'cross') xs.push([e1, e2]);
        }
        if (xs.length) out.push({ kind: 'selfcross', p: p.idx, pairs: xs.map(([a, b]) => [[a.a, a.b], [b.a, b.b]]) });
      }
    }
    // 疑似未設定的地中地：h 整個在 p 環內（只與 p 共用至多一點）、h 不是任何宗地的地中地、也沒被寫進 p 的環；同一個 h 只報最小的外圈
    const embeddedPair = new Set(out.filter(o => o.kind === 'embedded').map(o => o.p + '>' + o.h)), bb = ds.parcels.map(q => ringBox(q, P)), best = new Map();
    for (const h of ds.parcels) {
      if (h.deleted || (h.containers || []).length) continue; const B = bb[h.idx], c = polyCentroid(h.ids, P);
      for (const p of ds.parcels) {
        if (h === p || p.deleted || embeddedPair.has(p.idx + '>' + h.idx)) continue;
        const A = bb[p.idx]; if (B.x0 < A.x0 || B.x1 > A.x1 || B.y0 < A.y0 || B.y1 > A.y1 || B.area >= A.area) continue;
        if (h.ids.filter(id => p.ids.includes(id)).length > 1) continue;   // 共邊＝相鄰，不是地中地
        if (!pointInRing(p.ids, P, c.y, c.x) || h.ids.some(id => !p.ids.includes(id) && !pointInRing(p.ids, P, P.get(id).y, P.get(id).x))) continue;
        if ((p.holes || []).some(x => pointInRing(ds.parcels[x].ids, P, c.y, c.x))) continue;   // 在 p 的地中地裡面，不屬於 p
        const cur = best.get(h.idx); if (!cur || A.area < bb[cur].area) best.set(h.idx, p.idx);
      }
    }
    for (const [hi, pi] of best) out.push({ kind: 'missinghole', p: pi, h: hi });
    return out;
  }
  // 給 .ERR 與面板用的一行說明
  function ringIssueLine(ds, o) {
    const p = ds.parcels[o.p], h = o.h != null ? ds.parcels[o.h] : null, f = parLabelFull;
    if (o.kind === 'embedded') return `${f(p)} 的界址串內含 ${f(h)} 的整圈（${o.sameDir ? '與外圈同向，面積被加入' : '與外圈反向，面積被扣除'}${o.d12 ? '；D12 也已設為地中地，等於重複計算' : ''}${o.jumps.length ? '；跳線 ' + o.jumps.map(j => j.join('–')).join('、') : ''}）` + (o.inside ? `，拆出地中地後面積 ${o.areaFixed.toFixed(2)} ㎡（現 ${o.areaNow.toFixed(2)}）；兩條跳線之間原本不屬於任何宗地的通道` + (o.sameDir || o.d12 ? '' : `（約 ${(o.areaFixed - o.areaNow).toFixed(2)} ㎡）`) + `會併入本宗` + (o.trimmed.length ? `，通道端點 ${o.trimmed.join('、')} 一併移除` : '') : '，不在外圈內＝多部分宗地');
    if (o.kind === 'repeat') return `${f(p)} 的界址串重複經過界址點 ${o.ids.slice(0, 8).join('、')}（環自我接觸）`;
    if (o.kind === 'selfcross') return `${f(p)} 的界址串自我交錯：${o.pairs.map(([a, b]) => `/${a.join(',')} 與 /${b.join(',')}`).join('；')}`;
    return `${f(h)} 位於 ${f(p)} 之內，但未設定為地中地（${f(p)} 面積未扣除 ${f(h)}）`;
  }
  const ringIssueText = ds => { const r = ringIssues(ds); return [`界址串問題 ${r.length} 項（內含別宗整圈、自我接觸、自我交錯、未設定的地中地）`, ...r.slice(0, 200).map(o => '  ' + ringIssueLine(ds, o))]; };
  function ringBox(p, P) { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const id of p.ids) { const q = P.get(id); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); } return { x0, x1, y0, y1, area: ringArea(p.ids, P) }; }
  // 地中地關係的增減（供 delta 與復原）
  function linkHole(ds, pi, hi, on) {
    const p = ds.parcels[pi], h = ds.parcels[hi]; p.holes = p.holes || []; h.containers = h.containers || []; p.holeKeys = p.holeKeys || [];
    const rm = (a, v) => { const k = a.indexOf(v); if (k >= 0) a.splice(k, 1); };
    if (on) { if (!p.holes.includes(hi)) p.holes.push(hi); if (!h.containers.includes(pi)) h.containers.push(pi); if (!p.holeKeys.includes(h.key)) p.holeKeys.push(h.key); }
    else { rm(p.holes, hi); rm(h.containers, pi); rm(p.holeKeys, h.key); }
  }
  // 拆出地中地：把 h 的整圈與兩條跳線從 p 的環移除，並設定 h 為 p 的地中地（p 面積＝外圈 − h）。
  // 沒有內含整圈時（只是未設定關係）只設定地中地關係。回傳 {delta, jumps, linked}
  function splitHole(ds, pi, hi) {
    const p = ds.parcels[pi], h = ds.parcels[hi]; if (!p || !h || p === h) throw new Error('宗地不正確');
    const run = embeddedRuns(ds, p).find(r => r.h === hi && isHoleRun(ds, p, r)), d = newDelta(); let jumps = [], trimmed = [];
    if (run) {
      const c = cutRun(ds, p, run); if (c.ids.length < 3) throw new Error(`拆出後 ${p.label} 剩不到 3 點`);
      const where = holeInside(ds, c.ids, h); if (where !== 'inside') throw new Error(where === 'edge' ? `${h.label} 貼在 ${p.label} 的外圈邊界上（凹口），不是地中地` : `${h.label} 不在 ${p.label} 外圈之內，不是地中地（可能是多部分宗地，請用「重繪界址串」）`);
      const n = p.ids.length, nb = [(run.start - 1 + n) % n, (run.start + run.len) % n];
      if (p.mid && nb.some(i => p.mid[i] || p.mid[(i + n - 1) % n] || p.mid[(i + 1) % n])) throw new Error('跳線接在圓弧上，請用「重繪界址串」處理');
      touchParcel(d, p); p.ids = c.ids; if (p.mid) p.mid = c.mid; jumps = c.jumps; trimmed = c.trimmed;
      for (const id of trimmed) { const q = ds.points.get(id); if (q) { ds.points.delete(id); d.removed.push(q); } }   // 通道端點只屬於 p，移除後不再有宗地使用
    } else if ((p.holes || []).includes(hi)) throw new Error(`${h.label} 已是 ${p.label} 的地中地`);
    else touchParcel(d, p);
    const linked = !(p.holes || []).includes(hi); if (linked) { linkHole(ds, pi, hi, true); d.holes = [{ p: pi, h: hi, on: true }]; }
    return { delta: closeDelta(ds, d), jumps, trimmed, linked };
  }
  // 重繪界址串：以使用者依序點選的既有界址點取代 p 的環。圓弧中點旗標只在前後鄰點與原本相同時保留。
  function setRing(ds, pi, ids) {
    const p = ds.parcels[pi]; if (!p) throw new Error('宗地不正確');
    ids = ids.filter((id, i) => id !== ids[(i + 1) % ids.length]);
    if (ids.length < 3) throw new Error('界址串至少要 3 點'); const miss = ids.filter(id => !ds.points.has(id)); if (miss.length) throw new Error('找不到界址點 ' + miss.join('、'));
    if (new Set(ids).size !== ids.length) throw new Error('同一點不可重複點選（地中地請用「拆出地中地」）');
    const old = new Map(); if (p.mid) p.ids.forEach((id, i) => { if (p.mid[i]) old.set(id, p.ids[(i - 1 + p.ids.length) % p.ids.length] + '|' + p.ids[(i + 1) % p.ids.length]); });
    const n = ids.length, mid = ids.map((id, i) => { const k = old.get(id), a = ids[(i - 1 + n) % n], b = ids[(i + 1) % n]; return !!k && (k === a + '|' + b || k === b + '|' + a); });
    const d = newDelta(); touchParcel(d, p); p.ids = ids; p.mid = mid; p.hasArc = mid.some(Boolean);
    return { delta: closeDelta(ds, d) };
  }
  // 刪除宗地（v0.16.0）。地中地＝面積併入外圈（仿 NECEXE，KC0336 刪 9012-5004 併入 76-17 驗證）：解除地中地關係（外圈面積＝外圈 − 其餘地中地）；
  // 一般宗地（例：與鄰段重疊的外圍未登記地）直接刪除，原本的範圍變成空地／段外，面積不轉給任何宗地。兩者都清空界址串並標為已刪除，只屬於它的界址點一併刪除。
  // 輸出時 D13 該宗整宗移除、D21 移除或改寫它的經界線（鄰宗那側改為段外）、D11 一般地號新面積／中心坐標／LIMIT 改 0（9000 號以上整筆移除）；D12 的關係列照 NECEXE 保留。
  function deleteParcel(ds, hi) {
    const h = ds.parcels[hi]; if (!h || h.deleted) throw new Error('宗地不存在或已刪除');
    if ((h.holes || []).length) throw new Error(`${h.label} 本身還有地中地（${h.holes.map(i => ds.parcels[i].label).join('、')}），請先處理內層`);
    const d = newDelta(); touchParcel(d, h); d.holes = []; d.deleted = [hi];
    for (const ci of (h.containers || []).slice()) { touchParcel(d, ds.parcels[ci]); linkHole(ds, ci, hi, false); d.holes.push({ p: ci, h: hi, on: false }); }
    const only = h.ids.filter((id, i, a) => a.indexOf(id) === i && (ds.pointParcels.get(id) || []).every(x => x === hi));
    h.ids = []; h.mid = []; h.deleted = true;
    for (const id of only) { const q = ds.points.get(id); if (q) { ds.points.delete(id); d.removed.push(q); } }
    const into = d.holes.map(l => ds.parcels[l.p].label);
    return { delta: closeDelta(ds, d), into, removedPoints: only };
  }
  function deleteHoleParcel(ds, hi) {   // 舊名：只接受地中地
    const h = ds.parcels[hi]; if (h && !h.deleted && !(h.containers || []).length) throw new Error(`${h.label} 不是地中地（沒有外圈）；一般宗地請用 deleteParcel`);
    return deleteParcel(ds, hi);
  }
  // ── 未登記土地（9000 號以上）：清單、合併、每筆 ≤ N 點分割、空隙與凹口建為新地號（v0.15.0）──────────
  // 分割演算法移植自 116 倉庫 tools/kc0336_step4b_split.py（KC0336 當時把 23 筆 9000 系切成每塊 ≤10 點）：
  // 反覆在環上取連續 m 個點（m 盡量 = N）以一條連接既有界址點的弦切下一塊；弦必須完全在宗地內、除兩端外不碰邊界，
  // 以「弦長 / √(新塊面積)」最小者優先（避免細長薄片）。新塊編新子號（同母號、子號接續該母號已用最大子號），剩餘部分保留原地號。
  const UNREG_MIN = 9000;
  const mainNo = p => parseInt(String(p.label), 10), subNo = p => { const m = /-(\d+)$/.exec(String(p.label)); return m ? +m[1] : 0; };
  const isUnreg = p => !p.deleted && mainNo(p) >= UNREG_MIN;
  function unregSummary(ds, maxPts = 10, maxRatio = 0, minArea = 0) {   // minArea：面積不到 2 倍者不算太細長（切了會小於最小面積）
    const parcels = ds.parcels.filter(isUnreg).map(p => { const ratio = p.ids.length >= 3 ? shapeRatio(p.ids, ds.points) : 0, overPts = p.ids.length > maxPts, long = maxRatio > 0 && ratio > maxRatio * 1.01 && !(minArea && p.area < 2 * minArea);   // 與 splitParcel 相同的 1% 容差
      return { idx: p.idx, label: p.label, pts: p.ids.length, area: p.area, ratio, overPts, long, over: overPts || long, nested: !!((p.holes || []).length || (p.containers || []).length), arc: !!(p.mid && p.mid.some(Boolean)) }; });
    const gaps = freeRegions(ds).map(l => ({ ids: l.ids.slice().reverse(), area: Math.abs(l.area) }));   // 宗地之間封閉的空隙（逆時針）
    return { parcels, gaps };
  }
  function nextSub(ds, mother) {
    let m = 0; for (const p of ds.parcels) if (!(p.created && p.deleted) && mainNo(p) === mother) m = Math.max(m, subNo(p));
    for (const r of ds.meta.noRing || []) { const q = /^(\d+)-(\d+)/.exec(r.label); if (q && +q[1] === mother) m = Math.max(m, +q[2]); }
    return m + 1;
  }
  // 新宗地（未登記地）：附加到 ds.parcels，復原時標為已刪除
  function createParcel(ds, d, mother, ids, like, opt = {}) {   // opt.sub：指定子號（復原遺漏地號）；opt.areaReg：登記面積 m²
    const sec = like ? like.section : (ds.parcels.find(p => p.section) || {}).section || 0, c = opt.sub != null ? opt.sub : nextSub(ds, mother), label = c ? `${mother}-${c}` : `${mother}`;
    const p = { idx: ds.parcels.length, key: `${sec}|${mother}|${c}`, section: sec, label, oldLabel: label, ids: [], mid: [], hasArc: false, holeKeys: [], rows: [], ids0: [], mid0: [],
      areaRef: null, areaReg: opt.areaReg || 0, attrRow: null, created: true, like: like ? like.idx : null, holes: [], containers: [], areaOrig: 0, area: 0, unregEdit: true };
    ds.parcels.push(p); touchParcel(d, p); p.ids = ids.slice(); p.mid = ids.map(() => false); (d.created = d.created || []).push(p.idx);
    return p;
  }
  const ccwIds = (ids, P) => (signedArea(ids, P) < 0 ? ids.slice().reverse() : ids.slice());
  // 線段 a–b（ring 的第 i、j 點）是否為合格的切分弦：完全在環內、除兩端外不碰任何邊
  function chordInside(ring, i, j, P) {
    const A = P.get(ring[i]), B = P.get(ring[j]), L = Math.hypot(B.x - A.x, B.y - A.y); if (L < 0.05) return false;
    const n = ring.length, cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x), eps = 1e-9 * Math.max(1, L * L);
    const onSeg = (p, a, b) => Math.abs(cr(a, b, p)) <= eps && Math.min(a.x, b.x) - 1e-9 <= p.x && p.x <= Math.max(a.x, b.x) + 1e-9 && Math.min(a.y, b.y) - 1e-9 <= p.y && p.y <= Math.max(a.y, b.y) + 1e-9;
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n, C = P.get(ring[k]), D = P.get(ring[k2]);
      if (k !== i && k !== j && onSeg(C, A, B)) return false;            // 別的界址點落在弦上
      if (k === i || k === j || k2 === i || k2 === j) {                    // 與弦共端點的邊：不可與弦共線重疊
        const o = (k === i || k2 === i) ? A : B, t = o === A ? B : A, q = (k === i || k === j) ? D : C;
        if (Math.abs(cr(o, t, q)) <= eps && (q.x - o.x) * (t.x - o.x) + (q.y - o.y) * (t.y - o.y) > 0) return false;
        continue;
      }
      const d1 = cr(A, B, C), d2 = cr(A, B, D), d3 = cr(C, D, A), d4 = cr(C, D, B);
      if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return false;
      if (onSeg(A, C, D) || onSeg(B, C, D)) return false;
    }
    return pointInRing(ring, P, (A.y + B.y) / 2, (A.x + B.x) / 2);
  }
  // ── 形狀（v0.17.0）：調查表略圖框約 143×137 mm（A3，量自 KC 調查表樣本），略圖縮放到框內列印，所以只看長寬比 ──
  // 細長度＝max(最小外接矩形 長÷短, 長²÷面積÷2)。後者讓彎曲或 L 形的細長條（外接矩形接近方形、實際很細）也算細長；矩形與三角形兩者相同。
  function hullOf(pts) {
    const a = pts.slice().sort((p, q) => p.x - q.x || p.y - q.y); if (a.length < 3) return a;
    const cr = (o, p, q) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x), lo = [], up = [];
    for (const p of a) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = a.length - 1; i >= 0; i--) { const p = a[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  // 最小面積外接矩形：{long, short, ux, uy（長邊方向單位向量，x＝東、y＝北）}
  function minRect(ids, P) {
    const h = hullOf(ids.map(id => P.get(id))); let best = null;
    for (let i = 0; i < h.length; i++) {
      const A = h[i], B = h[(i + 1) % h.length], L = Math.hypot(B.x - A.x, B.y - A.y); if (L < 1e-9) continue;
      const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const q of h) { const u = q.x * ux + q.y * uy, v = -q.x * uy + q.y * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      const w = u1 - u0, t = v1 - v0; if (!best || w * t < best.w * best.t) best = { w, t, ux, uy };
    }
    if (!best) return { long: 0, short: 0, ux: 1, uy: 0 };
    return best.w >= best.t ? { long: best.w, short: best.t, ux: best.ux, uy: best.uy } : { long: best.t, short: best.w, ux: -best.uy, uy: best.ux };
  }
  function shapeRatio(ids, P) {
    const r = minRect(ids, P), A = Math.abs(signedArea(ids, P)); if (!(r.short > 1e-9) || !(A > 1e-9)) return Infinity;
    return Math.max(r.long / r.short, r.long * r.long / A / 2);
  }
  // 以直線 {p：p·u = s}（u＝單位向量）切開環 cur（逆時針）。直線可能多次穿過環（彎曲的長條）：交點沿直線排序後，第 1–2、3–4…個交點之間各是一條在環內的弦，每條弦都是一個候選。
  // 交點離既有點 ≤ snap 公尺就用既有點，否則是新點（{y,x,edge:[a,b]}，暫代號 'n0'、'n1'）。回傳 [{piece（投影較小的一側）, rest, news, PP（含暫代點的查詢）}]
  function perpCuts(cur, P, ux, uy, s, snap = 0.3) {
    const n = cur.length, eps = 1e-6, dv = cur.map(id => { const q = P.get(id); return q.x * ux + q.y * uy - s; }), out = [];
    { let c = 0; for (let i = 0; i < n; i++) { const da = dv[i], db = dv[(i + 1) % n]; if (Math.abs(da) < eps || (Math.abs(db) >= eps && da * db < 0)) c++; } if (c < 2) return out; }   // 快速排除
    const sgn = i => { for (let k = 1; k < n; k++) { const v = dv[(i + k) % n]; if (Math.abs(v) >= eps) return Math.sign(v); } return 0; };
    const sgp = i => { for (let k = 1; k < n; k++) { const v = dv[(i - k + n) % n]; if (Math.abs(v) >= eps) return Math.sign(v); } return 0; };
    const hits = [], w = (y, x) => -x * uy + y * ux;
    for (let i = 0; i < n; i++) {
      const a = cur[i], b = cur[(i + 1) % n], da = dv[i], db = dv[(i + 1) % n];
      if (Math.abs(da) < eps) { if (sgp(i) * sgn(i) < 0) { const A = P.get(a); hits.push({ i, id: a, w: w(A.y, A.x) }); } continue; }   // 頂點剛好在線上：兩側異號才算穿過
      if (Math.abs(db) < eps || da * db > 0) continue;
      const A = P.get(a), B = P.get(b), t = da / (da - db), y = A.y + t * (B.y - A.y), x = A.x + t * (B.x - A.x), L = Math.hypot(B.x - A.x, B.y - A.y);
      if (t * L <= snap) hits.push({ i, id: a, w: w(A.y, A.x) }); else if ((1 - t) * L <= snap) hits.push({ i: (i + 1) % n, id: b, w: w(B.y, B.x) }); else hits.push({ i, t, y, x, edge: [a, b], w: w(y, x) });
    }
    if (hits.length % 2) return out;
    hits.sort((p, q) => p.w - q.w);
    for (let k = 0; k + 1 < hits.length; k += 2) {
      const pair = [hits[k], hits[k + 1]]; if (pair[0].id != null && pair[0].id === pair[1].id) continue;
      const tmp = new Map(), news = [], ring = [];
      for (let i = 0; i < n; i++) {
        ring.push(cur[i]);
        for (const h of pair) if (h.id == null && h.i === i) { const id = 'n' + news.length; tmp.set(id, { id, y: h.y, x: h.x }); news.push({ id, y: h.y, x: h.x, edge: h.edge }); h.tid = id; ring.push(id); }
      }
      const PP = { get: id => tmp.get(id) || P.get(id) }, at = pair.map(h => ring.indexOf(h.id != null ? h.id : h.tid)).sort((x, y) => x - y), [i0, i1] = at, m = ring.length;
      for (const h of pair) delete h.tid;
      if (i0 === i1 || m < 4 || !chordInside(ring, i0, i1, PP)) continue;
      const c1 = ring.slice(i0, i1 + 1), c2 = ring.slice(i1).concat(ring.slice(0, i0 + 1)); if (c1.length < 3 || c2.length < 3) continue;
      const side = ids => ids.reduce((t, id) => { const q = PP.get(id); return t + q.x * ux + q.y * uy - s; }, 0) / ids.length;
      const [piece, rest] = side(c1) < side(c2) ? [c1, c2] : [c2, c1];
      out.push({ piece, rest, news, PP });
    }
    return out;
  }
  // 把新點（perpCut 的暫代點）寫入：點號接續最大號，所有含該界址線的宗地環都插入（鄰宗面積不變）；回傳暫代號 → 新點號
  function commitNewPoints(ds, d, news, ring) {
    const map = new Map();
    for (const q of news) {
      const id = nextPointId(ds), np = { id, y: q.y, x: q.x, y0: q.y, x0: q.x, row: null, added: true }; ds.points.set(id, np); d.added.push(np); map.set(q.id, id);
      const [a, b] = q.edge;
      for (const p of ds.parcels) {
        if (p.deleted) continue; const k = p.ids.length;
        for (let i = 0; i < k; i++) { const u = p.ids[i], v = p.ids[(i + 1) % k]; if ((u === a && v === b) || (u === b && v === a)) { touchParcel(d, p); p.ids.splice(i + 1, 0, id); if (p.mid) p.mid.splice(i + 1, 0, false); break; } }
      }
    }
    return ring.map(id => (map.has(id) ? map.get(id) : id));
  }
  // 圓弧相關的界址線（新點不可插在上面）：分割前建一次，之後 O(1) 查詢
  function arcEdgeSet(ds) {
    const out = new Set();
    for (const p of ds.parcels) { if (p.deleted || !p.mid || !p.mid.some(Boolean)) continue; const k = p.ids.length;
      for (let i = 0; i < k; i++) if (p.mid[i] || p.mid[(i + 1) % k]) out.add(segKey(p.ids[i], p.ids[(i + 1) % k])); }
    return out;
  }
  // 把宗地切成每塊 ≤ maxPts 點、細長度 ≤ maxRatio（0＝不限形狀）。回傳 {delta, pieces:[地號…], unresolved（形狀仍超過時的細長度）}；地中地、圓弧、與地中地相關者不處理。
  // 點數：以連接既有界址點的弦切下（116 倉庫演算法）。形狀：先試既有點的弦，切不出合格的才垂直長軸切開（大約等分，交點新增界址點，鄰宗同步插入）。
  // opt.minArea（m²，v0.24.0）：切下的塊與剩餘部分都不小於此面積；為了不小於它，細長條的長寬比上限自動放寬（寬 1 m 的水溝照長寬比切會變成一堆幾 m² 的碎塊）。
  //   面積不到 2 倍 minArea 的宗地不為形狀而切。opt.thin（預設有 minArea 時 0.6）：切下的塊與剩餘部分的平均寬（2×面積÷周長）不小於 min(原本的 thin 倍, 1.5 m)，切線長不超過切下那塊短邊的 1.5 倍（橫切，避免順著長邊切出細長三角）。
  function splitParcel(ds, pi, maxPts = 10, maxRatio = 0, opt = {}) { const g = splitSteps(ds, pi, maxPts, maxRatio, opt); let r; while (!(r = g.next()).done); return r.value; }
  // 同 splitParcel，但每切一刀 yield 一次，讓介面能分段執行（大宗地不會讓瀏覽器判定沒有回應）
  function* splitSteps(ds, pi, maxPts = 10, maxRatio = 0, opt = {}) {
    const p = ds.parcels[pi], P = ds.points; if (!p || p.deleted) throw new Error('宗地不存在');
    if (maxPts < 3) throw new Error('每筆至少 3 點');
    if ((p.holes || []).length || (p.containers || []).length) throw new Error(`${p.label} 含地中地或本身是地中地，尚未支援自動分割`);
    if (p.mid && p.mid.some(Boolean)) throw new Error(`${p.label} 含圓弧，尚未支援自動分割`);
    const minA = Math.max(0, opt.minArea || 0), thinK = opt.thin ?? (minA > 0 ? 0.6 : 0), AREA = (ids, PP = P) => Math.abs(signedArea(ids, PP));
    const thick = (ids, PP = P) => { let per = 0; for (let i = 0; i < ids.length; i++) { const a = PP.get(ids[i]), b = PP.get(ids[(i + 1) % ids.length]); per += Math.hypot(b.x - a.x, b.y - a.y); } return per ? 2 * AREA(ids, PP) / per : 0; };   // 平均寬
    const lim = maxRatio > 0 ? Math.max(1.05, maxRatio) * (1 + 1e-6) : 0, tooLong = ids => lim && shapeRatio(ids, P) > lim * 1.01 && !(minA && AREA(ids) < 2 * minA);   // 切下的塊嚴格 ≤ 上限；剩餘部分超過不到 1% 就不再切（避免切出零碎小塊）
    if (p.ids.length <= maxPts && !tooLong(p.ids)) return { delta: null, pieces: [] };
    const d = newDelta(), pieces = []; touchParcel(d, p);
    let cur = ccwIds(p.ids, P), unresolved = null; const arcs = lim ? arcEdgeSet(ds) : null;
    for (let guard = 0; guard < 500 && (cur.length > maxPts || tooLong(cur)); guard++) {
      if (guard) yield guard;
      const n = cur.length, overPts = n > maxPts, areaCur = signedArea(cur, P), k0 = Math.max(overPts ? 1 : 2, lim ? Math.ceil(shapeRatio(cur, P) / lim * 0.97) : 1);
      const kMax = minA ? Math.floor(areaCur / minA) : Infinity, k = Math.max(1, Math.min(k0, kMax)), target = areaCur / Math.max(1, k), wCur = thick(cur);
      if (!overPts && k < 2) { unresolved = shapeRatio(cur, P); break; }   // 再切就小於最小面積
      const limP = !lim ? 0 : k < k0 && wCur > 0 ? Math.max(lim, 1.5 * Math.max(target, minA) / (wCur * wCur)) : lim;   // 受最小面積限制時，塊的長寬比上限放寬到「寬 × 目標面積」的形狀
      // 橫切：切線長 ≤ 1.5 × 切下那塊（外接矩形）的短邊，避免順著長邊斜切出細長三角
      const okThin = (piece, rest, PP = P, a = piece[0], b = piece[piece.length - 1]) => { if (!thinK) return true; const wMin = Math.min(thinK * wCur, 1.5); if (thick(piece, PP) < wMin || thick(rest, PP) < wMin) return false;
        const A = PP.get(a), B = PP.get(b), r = minRect(piece, PP); return Math.hypot(B.x - A.x, B.y - A.y) <= 1.5 * r.short + 0.05; };
      let best = null, free = null;
      // 連續 m 點的面積用鞋帶公式前綴和 O(1) 求得，通過篩選才建陣列
      const X = cur.map(id => P.get(id).x), Yv = cur.map(id => P.get(id).y), cs = [0];
      for (let q = 0; q < 2 * n; q++) cs.push(cs[q] + X[q % n] * Yv[(q + 1) % n] - X[(q + 1) % n] * Yv[q % n]);
      const segArea = (i, m) => { const j = (i + m - 1) % n; return (cs[i + m - 1] - cs[i] + X[j] * Yv[i] - X[i] * Yv[j]) / 2; };
      for (let m = Math.min(maxPts, n - 2); m > 2 && !best; m--) {
        for (let i = 0; i < n; i++) {
          const j = (i + m - 1) % n, u = cur[i], v = cur[j]; if (ds.edges.has(segKey(u, v))) continue;
          const area = segArea(i, m); if (area < 1) continue;
          if (!overPts && (area < 0.6 * target || area > 1.4 * target)) continue;
          if (minA && (area < minA || areaCur - area < minA)) { if (!overPts) continue; }
          const piece = []; for (let q = 0; q < m; q++) piece.push(cur[(i + q) % n]);
          if (!overPts && (area < 0.6 * target || area > 1.4 * target)) continue;   // 只為形狀切時，避免切下零碎小塊（先做便宜的面積篩選）
          const needFree = overPts && (!free || free.m === m);   // 原演算法只用「有合格弦的最大 m」，找到後較小的 m 不必再算
          if (lim && !needFree && shapeRatio(piece, P) > limP) continue;   // 形狀比弦檢查便宜，先篩
          if (!chordInside(cur, i, j, P)) continue;
          const sizeOk = !minA || (area >= minA && areaCur - area >= minA);
          if (thinK || minA) { const rest = []; for (let t = 0; t <= (i - j + n) % n; t++) rest.push(cur[(j + t) % n]); if (!sizeOk || !okThin(piece, rest)) { if (!overPts) continue; if (needFree && (!free || free.bad)) { /* 不合格只當最後手段 */ const a2 = P.get(u), b2 = P.get(v), sc2 = Math.hypot(a2.x - b2.x, a2.y - b2.y) / Math.sqrt(area); if (!free || sc2 < free.sc) free = { sc: sc2, i, j, piece, m, bad: true }; } continue; } }
          const a = P.get(u), b = P.get(v), sc = Math.hypot(a.x - b.x, a.y - b.y) / Math.sqrt(area);
          if (needFree && (!free || free.bad || sc < free.sc)) free = { sc, i, j, piece, m };   // 不看形狀的原演算法（備用）
          if (lim && needFree && shapeRatio(piece, P) > limP) continue;
          const key = overPts ? sc : Math.abs(area - target) / target + sc * 1e-3;
          if (!best || key < best.key) best = { key, i, j, piece };
        }
        if (!overPts && best) break;
      }
      if (best) {
        const q = createParcel(ds, d, mainNo(p), best.piece, p); pieces.push(q.label);
        const rest = []; for (let t = 0; t <= (best.i - best.j + n) % n; t++) rest.push(cur[(best.j + t) % n]); cur = rest; continue;
      }
      let cut = null;
      if (lim) {   // 垂直長軸切：從投影最小的一端切下約 1/k
        // 切線方向：最小外接矩形的長、短軸，以及最長幾條邊的方向（L 形、彎曲長條的外接矩形近乎方形，要沿邊的方向切）；每個方向兩端都試
        const r = minRect(cur, P), dirs = [[r.ux, r.uy], [-r.uy, r.ux]];
        cur.map((id, i) => { const A = P.get(id), B = P.get(cur[(i + 1) % n]), L = Math.hypot(B.x - A.x, B.y - A.y); return { L, ux: (B.x - A.x) / L, uy: (B.y - A.y) / L }; })
          .filter(e => e.L > 1e-6).sort((x, y) => y.L - x.L).slice(0, 4).forEach(e => { if (dirs.length < 4 && !dirs.some(([x, y]) => Math.abs(x * e.ux + y * e.uy) > 0.996)) dirs.push([e.ux, e.uy]); });
        const evalCut = c => {   // 合格回傳與目標面積的相對差，否則 null
          if (c.piece.length > maxPts || c.news.some(q => arcs.has(segKey(q.edge[0], q.edge[1])))) return null;
          const area = signedArea(c.piece, c.PP), floor = Math.max(1, minA); if (area < floor || areaCur - area < floor) return null;
          if (thinK && !okThin(c.piece, c.rest, c.PP)) return null;
          return shapeRatio(c.piece, c.PP) > limP ? null : Math.abs(area - target) / target;
        };
        // 切下的塊約占 1/k：只在靠近起點的 2.5/k 範圍取樣 24 處，再在最佳位置兩側細搜（長條很長時大幅減少計算）
        const span = Math.min(1, 2.5 / k);
        for (const [di, [dx, dy]] of dirs.entries()) for (const sg of [1, -1]) {
          if (di > 0 && cut && cut.key < 0.1) break;   // 長軸切得出接近目標的塊就不試其他方向（L 形、彎曲長條才需要）
          const ux = dx * sg, uy = dy * sg; let t0 = Infinity, t1 = -Infinity; for (const id of cur) { const q = P.get(id), t = q.x * ux + q.y * uy; t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
          let mine = null;
          const at = f => { if (f <= 0 || f >= 1) return; for (const c of perpCuts(cur, P, ux, uy, t0 + f * (t1 - t0))) { const k = evalCut(c); if (k != null && (!mine || k < mine.key)) mine = { key: k, f, ...c }; } };
          const step = span / 24; for (let g = 1; g <= 24; g++) at(g * step);
          if (mine) { const f0 = mine.f; for (let h = -20; h <= 20; h++) at(f0 + h * step / 20); }   // 細搜，避免取樣間距累積的誤差讓剩餘部分略超過上限
          if (mine && (!cut || mine.key < cut.key - 1e-9)) cut = mine;
        }
        if (!cut) {   // 其他方向都切不出合格的塊（彎曲的長條）：從每個既有點垂直於相鄰邊切（跟著局部走向）
          for (let i = 0; i < n; i++) { const V = P.get(cur[i]);
            for (const j of [(i + n - 1) % n, (i + 1) % n]) { const Q = P.get(cur[j]), L = Math.hypot(Q.x - V.x, Q.y - V.y); if (L < 1e-6) continue; const ux = (Q.x - V.x) / L, uy = (Q.y - V.y) / L;
              for (const sg of [1, -1]) for (const c of perpCuts(cur, P, sg * ux, sg * uy, sg * (V.x * ux + V.y * uy))) { const k = evalCut(c); if (k != null && (!cut || k < cut.key - 1e-9)) cut = { key: k, ...c }; } } }
        }
      }
      if (cut) {
        const ring = commitNewPoints(ds, d, cut.news, cut.piece.concat(['|'], cut.rest)), sep = ring.indexOf('|');
        const q = createParcel(ds, d, mainNo(p), ring.slice(0, sep), p); pieces.push(q.label); cur = ring.slice(sep + 1); continue;
      }
      if (free) { const q = createParcel(ds, d, mainNo(p), free.piece, p); pieces.push(q.label); const rest = []; for (let t = 0; t <= (free.i - free.j + n) % n; t++) rest.push(cur[(free.j + t) % n]); cur = rest; continue; }
      if (overPts) { applyDelta(ds, closeDelta(ds, d), 'undo'); throw new Error(`${p.label} 找不到可用的切分弦（剩 ${n} 點）`); }
      unresolved = shapeRatio(cur, P); break;   // 形狀切不開：保留剩餘部分，回報
    }
    if (!pieces.length && unresolved != null) { applyDelta(ds, closeDelta(ds, d), 'undo'); return { delta: null, pieces: [], unresolved }; }
    p.ids = cur; p.mid = cur.map(() => false); p.unregEdit = true;
    return { delta: closeDelta(ds, d), pieces, unresolved };
  }
  // 合併相連的宗地成一筆：外圍必須是單一環、中間不可有空洞；保留 keep（預設子號最小、已有 D11 記錄者），其餘標為已刪除。
  // 只屬於這些宗地、合併後不在外圍上的界址點一併刪除。
  // T 字接點：宗地 A 的界址點落在宗地 B 的邊上（≤ tol 公尺），B 卻沒有這一點，兩宗沿線相鄰但沒有共用的界址線，合併時外圍抵消不掉。
  // 把這種點插入 B 的邊（所有使用該邊的宗地一併插入；點原本就在線上，面積幾乎不變）。只看 idxs 內的點與邊。回傳插入次數
  function healJunctions(ds, d, idxs, tol = 0.02) {
    const P = ds.points, pts = [...new Set(idxs.flatMap(i => ds.parcels[i].ids))]; let count = 0;
    for (let pass = 0; pass < 5; pass++) {
      let changed = false;
      for (const i of idxs) {
        const p = ds.parcels[i];
        for (let k = 0; k < p.ids.length; k++) {
          const n = p.ids.length, u = p.ids[k], v = p.ids[(k + 1) % n]; if (p.mid && (p.mid[k] || p.mid[(k + 1) % n])) continue;
          const A = P.get(u), B = P.get(v), bx = B.x - A.x, by = B.y - A.y, L2 = bx * bx + by * by; if (L2 < 1e-6) continue;
          let best = null, bt = Infinity;
          for (const q of pts) {
            if (q === u || q === v) continue; const Q = P.get(q); if (!Q) continue;
            const t = ((Q.x - A.x) * bx + (Q.y - A.y) * by) / L2; if (t <= 1e-6 || t >= 1 - 1e-6 || t >= bt) continue;
            if (Math.abs(bx * (Q.y - A.y) - by * (Q.x - A.x)) / Math.sqrt(L2) <= tol) { best = q; bt = t; }
          }
          if (best == null) continue;
          for (const r of ds.parcels) {   // 所有使用 u–v 這條邊的宗地都插入
            if (r.deleted) continue; const m = r.ids.length;
            for (let j = 0; j < m; j++) { const a = r.ids[j], b = r.ids[(j + 1) % m]; if ((a === u && b === v) || (a === v && b === u)) { touchParcel(d, r); r.ids.splice(j + 1, 0, best); if (r.mid) r.mid.splice(j + 1, 0, false); break; } }
          }
          count++; changed = true;
        }
      }
      if (!changed) break;
    }
    if (count) buildTopology(ds);
    return count;
  }
  // 兩宗是否沿線相鄰：共用界址線，或有邊彼此共線重疊（T 字接點，≤ tol 公尺）。供「合併」自動分組
  function parcelsTouch(ds, i, j, tol = 0.02) {
    const P = ds.points, a = ds.parcels[i], b = ds.parcels[j], edges = p => p.ids.map((id, k) => [id, p.ids[(k + 1) % p.ids.length]]);
    const ea = edges(a), eb = edges(b), keys = new Set(ea.map(([u, v]) => segKey(u, v)));
    if (eb.some(([u, v]) => keys.has(segKey(u, v)))) return true;
    for (const [u, v] of ea) { const A = P.get(u), B = P.get(v), L = Math.hypot(B.x - A.x, B.y - A.y); if (L < 1e-9) continue; const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
      const off = Q => Math.abs(ux * (Q.y - A.y) - uy * (Q.x - A.x)), at = Q => (Q.x - A.x) * ux + (Q.y - A.y) * uy;
      for (const [w, z] of eb) { const C = P.get(w), D = P.get(z); if (off(C) > tol || off(D) > tol) continue;   // C–D 在 A–B 的直線上
        if (Math.min(L, Math.max(at(C), at(D))) - Math.max(0, Math.min(at(C), at(D))) > tol) return true; } }   // 且重疊長度 > tol
    return false;
  }
  // 自動合併分組：相連的同母號宗地可能圍成一圈（中間是別的宗地），整組合併會留下空洞而失敗。
  // 先補 T 字接點，再從第一筆開始逐筆加入相鄰的宗地，只有加入後外圍仍是單一環、沒有空洞才收；收不進來的留給下一群。回傳 {delta（補點）, clusters:[[idx…]]}
  function mergeClusters(ds, idxs) {
    const d = newDelta(); healJunctions(ds, d, idxs);
    const ok = g => { const l = outlineLoops(ds, g).filter(x => Math.abs(x.area) > 1e-6); return l.length === 1 && l[0].area > 0; };
    const left = new Set(idxs), clusters = [];
    while (left.size) {
      const seed = left.values().next().value, g = [seed]; left.delete(seed);
      for (let grew = true; grew;) {
        grew = false;
        for (const j of [...left]) if (g.some(i => parcelsTouch(ds, i, j)) && ok([...g, j])) { g.push(j); left.delete(j); grew = true; }
      }
      clusters.push(g);
    }
    return { delta: d.parcels.size ? closeDelta(ds, d) : null, clusters };
  }
  function mergeParcels(ds, idxs, keep) {
    idxs = [...new Set(idxs)]; if (idxs.length < 2) throw new Error('至少選兩筆');
    for (const i of idxs) { const p = ds.parcels[i]; if (!p || p.deleted) throw new Error('宗地不存在');
      if ((p.holes || []).length || (p.containers || []).length) throw new Error(`${p.label} 含地中地或本身是地中地，尚未支援合併`);
      if (p.mid && p.mid.some(Boolean)) throw new Error(`${p.label} 含圓弧，尚未支援合併`); }
    const d = newDelta(); d.deleted = []; healJunctions(ds, d, idxs);
    const loops = outlineLoops(ds, idxs).filter(l => Math.abs(l.area) > 1e-6);
    if (loops.length !== 1 || loops[0].area <= 0) {
      if (d.parcels.size) applyDelta(ds, closeDelta(ds, d), 'undo');
      throw new Error(loops.some(l => l.area < 0) ? '合併後中間會有空洞，請連空洞一起處理' : `選取的宗地沒有全部相連（外圍 ${loops.filter(l => l.area > 0).length} 個環；可能有縫隙或重疊）`);
    }
    const order = idxs.map(i => ds.parcels[i]).sort((a, b) => (a.created - b.created) || (mainNo(a) - mainNo(b)) || (subNo(a) - subNo(b)));
    const k = keep != null ? ds.parcels[keep] : order[0];
    const inGroup = new Set(idxs), onLoop = new Set(loops[0].ids), drop = new Set();
    for (const i of idxs) { const p = ds.parcels[i]; touchParcel(d, p); for (const id of p.ids) if (!onLoop.has(id) && (ds.pointParcels.get(id) || []).every(x => inGroup.has(x))) drop.add(id); }
    for (const i of idxs) { const p = ds.parcels[i]; if (p === k) continue; p.ids = []; p.mid = []; p.deleted = true; d.deleted.push(i); }
    k.ids = loops[0].ids.slice(); k.mid = k.ids.map(() => false); k.unregEdit = true;
    for (const id of drop) { const q = ds.points.get(id); if (q) { ds.points.delete(id); d.removed.push(q); } }
    return { delta: closeDelta(ds, d), keep: k.label, merged: idxs.filter(i => i !== k.idx).map(i => ds.parcels[i].label), removedPoints: [...drop] };
  }
  // 碎塊歸併（v0.24.0）：面積 < minArea 的未登記地併入「共用界線最長」的相鄰未登記地（保留鄰宗地號）。地中地、圓弧略過；
  // 只與登記地相鄰的碎塊不動（併進登記地會改變登記地面積），列在 left。idxs：只處理這些宗地（省略＝全部未登記地）。回傳 {deltas, merged:[{from, into}], left:[地號]}
  function absorbSlivers(ds, minArea, idxs = null) {
    const ok = p => isUnreg(p) && !(p.holes || []).length && !(p.containers || []).length && !(p.mid && p.mid.some(Boolean)), only = idxs ? new Set(idxs) : null;
    const deltas = [], merged = [];
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      const small = ds.parcels.filter(p => ok(p) && p.area < minArea && (!only || only.has(p.idx))).sort((a, b) => a.area - b.area);
      for (const p of small) {
        if (p.deleted || p.area >= minArea) continue;
        const share = new Map();
        for (let i = 0; i < p.ids.length; i++) { const a = p.ids[i], b = p.ids[(i + 1) % p.ids.length], e = ds.edges.get(segKey(a, b)); if (!e) continue; const A = ds.points.get(a), B = ds.points.get(b), L = Math.hypot(B.x - A.x, B.y - A.y);
          for (const j of e.parcels) { const q = ds.parcels[j]; if (j !== p.idx && ok(q)) share.set(j, (share.get(j) || 0) + L); } }
        const best = [...share].sort((u, v) => v[1] - u[1])[0]; if (!best) continue;
        try { const from = p.label, r = mergeParcels(ds, [p.idx, best[0]], best[0]); deltas.push(r.delta); merged.push({ from, into: r.keep }); changed = true; } catch (e) { /* 合併後會有空洞或不相連：留著 */ }
      }
      if (!changed) break;
    }
    const left = ds.parcels.filter(p => ok(p) && p.area < minArea && (!only || only.has(p.idx))).map(p => p.label);
    return { deltas, merged, left };
  }
  // 空隙或凹口建為新的未登記地
  function fillRegion(ds, ids, mother) {
    if (ids.length < 3) throw new Error('範圍至少 3 點'); const d = newDelta(), p = createParcel(ds, d, mother, ccwIds(ids, ds.points), null);
    return { delta: closeDelta(ds, d), label: p.label };
  }
  // ── 與鄰段之間的封閉空隙（v0.19.0）：主測區段外圍與已載入鄰段的段界之間，沒有任何宗地的封閉範圍 ──
  // 把主測區段外圍邊（帶點號）與鄰段段界線段（只有坐標）放進同一張平面圖：端點相距 ≤ tol 視為同一點（主測區點優先），交點與落在線上的點把線段切開；
  // 去掉懸空的線後追蹤每個有界的面，留下「同時用到主測區與鄰段的邊、內部不在任何宗地內、面積 ≥ minArea、平均寬（2×面積÷周長）≥ minWidth」者。
  // 回傳 [{nodes:[{id（主測區點號，新點為 null）, x, y, onMain（落在主測區段外圍的邊上時為 true）}], area, perim}]，不修改資料
  function seamGaps(ds, nbs, opt = {}) {
    nbs = nbs.filter(n => seamMode(n) !== 'graphic');   // 圖解區鄰段：脫開是好事，縫不建為新地號
    const tol = opt.tol != null ? opt.tol : 0.05, minArea = opt.minArea != null ? opt.minArea : 1, minWidth = opt.minWidth != null ? opt.minWidth : 0.5, P = ds.points;
    const nodes = [], cs = Math.max(4 * tol, 1), grid = new Map(), gk = (i, j) => i + ',' + j, byId = new Map();
    const near = (x, y) => { let best = null, bd = tol; const i0 = Math.floor(x / cs), j0 = Math.floor(y / cs);
      for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const n of grid.get(gk(i, j)) || []) { const dd = Math.hypot(n.x - x, n.y - y); if (dd <= bd) { bd = dd; best = n; } }
      return best; };
    const put = n => { n.k = nodes.length; nodes.push(n); const k = gk(Math.floor(n.x / cs), Math.floor(n.y / cs)); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(n); return n; };
    const mainNode = id => { let n = byId.get(id); if (!n) { const q = P.get(id); n = put({ id, x: q.x, y: q.y }); byId.set(id, n); } return n; };
    const freeNode = (x, y) => near(x, y) || put({ id: null, x, y });
    const segs = [];
    for (const e of ds.edges.values()) {   // 主測區段外圍（只屬於一宗、且不是地中地內圈的邊；圓弧以弦計）
      if (e.parcels.length !== 1) continue; const p = ds.parcels[e.parcels[0]]; if (!p || p.deleted || (p.containers && p.containers.length)) continue;
      segs.push({ a: mainNode(e.a), b: mainNode(e.b), main: true });
    }
    if (!segs.length) return [];
    const nbRings = [];
    for (const nb of nbs) {
      for (const sg of boundarySegments(nb.ds).segs) { const a = freeNode(sg.ax, sg.ay), b = freeNode(sg.bx, sg.by); if (a !== b) segs.push({ a, b, main: false }); }
      for (const p of nb.ds.parcels) if (!p.deleted && p.ids.length >= 3) nbRings.push(p.ids.map(id => nb.ds.points.get(id)));
    }
    // 線段格網（找交點、找落在線上的點）
    const sgrid = new Map(), cellsOf = (A, B) => { const out = []; for (let i = Math.floor((Math.min(A.x, B.x) - tol) / cs); i <= Math.floor((Math.max(A.x, B.x) + tol) / cs); i++) for (let j = Math.floor((Math.min(A.y, B.y) - tol) / cs); j <= Math.floor((Math.max(A.y, B.y) + tol) / cs); j++) out.push(gk(i, j)); return out; };
    segs.forEach((sg, n) => { for (const k of cellsOf(sg.a, sg.b)) { let l = sgrid.get(k); if (!l) sgrid.set(k, l = []); l.push(n); } });
    const seen = new Set();
    for (const l of sgrid.values()) for (let x = 0; x < l.length; x++) for (let y = x + 1; y < l.length; y++) {
      const i = l[x], j = l[y], key = i < j ? i * 1e7 + j : j * 1e7 + i; if (seen.has(key)) continue; seen.add(key);
      const s1 = segs[i], s2 = segs[j]; if (s1.main && s2.main) continue;
      if (s1.a === s2.a || s1.a === s2.b || s1.b === s2.a || s1.b === s2.b) continue;
      const A = s1.a, B = s1.b, C = s2.a, D = s2.b, rx = B.x - A.x, ry = B.y - A.y, sx = D.x - C.x, sy = D.y - C.y, den = rx * sy - ry * sx; if (Math.abs(den) < 1e-12) continue;
      const t = ((C.x - A.x) * sy - (C.y - A.y) * sx) / den, u = ((C.x - A.x) * ry - (C.y - A.y) * rx) / den; if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) continue;
      freeNode(A.x + t * rx, A.y + t * ry);   // 交點（接近既有點時併入）
    }
    // 把落在線段上的點切進去；新點落在主測區邊上時投影到線上並記下
    const edges = new Map(), addEdge = (a, b, main) => { if (a === b) return; const k = a.k < b.k ? a.k + '-' + b.k : b.k + '-' + a.k; const e = edges.get(k); if (e) { e.main = e.main || main; e.nb = e.nb || !main; } else edges.set(k, { a, b, main, nb: !main }); };
    for (const sg of segs) {
      const A = sg.a, B = sg.b, L2 = (B.x - A.x) ** 2 + (B.y - A.y) ** 2; if (L2 < 1e-12) continue; const on = [];
      for (const k of cellsOf(A, B)) for (const n of grid.get(k) || []) {
        if (n === A || n === B) continue; const t = ((n.x - A.x) * (B.x - A.x) + (n.y - A.y) * (B.y - A.y)) / L2; if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        if (Math.abs((B.x - A.x) * (n.y - A.y) - (B.y - A.y) * (n.x - A.x)) / Math.sqrt(L2) > tol) continue;
        if (sg.main && n.id == null) { n.x = A.x + t * (B.x - A.x); n.y = A.y + t * (B.y - A.y); n.onMain = true; }
        if (!on.some(o => o.n === n)) on.push({ n, t });
      }
      on.sort((p, q) => p.t - q.t); let prev = A; for (const o of on) { addEdge(prev, o.n, sg.main); prev = o.n; } addEdge(prev, B, sg.main);
    }
    // 去掉懸空的線（度數 1 的點）
    const adj = new Map(); for (const e of edges.values()) { for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) { let l = adj.get(x); if (!l) adj.set(x, l = new Map()); l.set(y, e); } }
    for (let changed = true; changed;) { changed = false; for (const [v, l] of adj) if (l.size < 2) { for (const w of l.keys()) adj.get(w).delete(v); adj.delete(v); changed = true; } }
    // 追蹤面：沿 u→v 到 v 後取「順時針方向緊接 u 的下一條邊」，面在左側；有界面為逆時針（面積 > 0）
    const order = new Map(); for (const [v, l] of adj) order.set(v, [...l.keys()].sort((p, q) => Math.atan2(p.y - v.y, p.x - v.x) - Math.atan2(q.y - v.y, q.x - v.x)));
    const used = new Set(), out = [], hk = (u, v) => u.k + '>' + v.k;
    const inRing = (pts, x, y) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
    for (const [u0, l] of adj) for (const v0 of l.keys()) {
      if (used.has(hk(u0, v0))) continue; const ring = [u0]; let u = u0, v = v0, main = false, nb = false, ok = true;
      for (let g = 0; g < 100000; g++) {
        used.add(hk(u, v)); const e = adj.get(u).get(v); main = main || e.main; nb = nb || e.nb;
        if (v === u0) break; ring.push(v);
        const ord = order.get(v), i = ord.indexOf(u), w = ord[(i - 1 + ord.length) % ord.length]; u = v; v = w;
        if (g === 99999) ok = false;
      }
      if (!ok || ring.length < 3 || !main || !nb) continue;
      let A2 = 0, per = 0; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; A2 += a.x * b.y - b.x * a.y; per += Math.hypot(b.x - a.x, b.y - a.y); }
      const area = A2 / 2; if (area < minArea || 2 * area / per < minWidth) continue;
      const tmp = new Map(ring.map((n, i) => [i, n])), ip = interiorPoint(ring.map((n, i) => i), tmp);
      if (ds.parcels.some(p => !p.deleted && p.ids.length >= 3 && pointInRing(p.ids, P, ip.y, ip.x))) continue;   // 在主測區宗地內
      if (nbRings.some(r => inRing(r, ip.x, ip.y))) continue;   // 在鄰段宗地內
      out.push({ nodes: ring.map(n => ({ id: n.id, x: n.x, y: n.y, onMain: !!n.onMain })), area, perim: per });
    }
    return out.sort((a, b) => b.area - a.area);
  }
  // 把 seamGaps 找到的一處建為新的未登記地：新點加入主測區點檔（落在段外圍邊上的插入該宗界址串，面積不變），再建宗地
  function fillSeamGap(ds, gap, mother) {
    const d = newDelta(), P = ds.points;
    const ids = gap.nodes.map(n => {
      if (n.id != null) return n.id;
      for (const q of P.values()) if (Math.abs(q.x - n.x) < 1e-4 && Math.abs(q.y - n.y) < 1e-4) return q.id;   // 相鄰的空隙共用的新點：先建的那一處已加入
      const id = nextPointId(ds), np = { id, y: n.y, x: n.x, y0: n.y, x0: n.x, row: null, added: true }; ds.points.set(id, np); d.added.push(np);
      if (n.onMain) for (const p of ds.parcels) {
        if (p.deleted) continue; const k = p.ids.length;
        for (let i = 0; i < k; i++) { const A = P.get(p.ids[i]), B = P.get(p.ids[(i + 1) % k]); if (p.ids[i] === id || p.ids[(i + 1) % k] === id) continue;
          if (distToSeg(n.x, n.y, A.x, A.y, B.x, B.y) < 1e-4 && Math.hypot(A.x - n.x, A.y - n.y) > 1e-4 && Math.hypot(B.x - n.x, B.y - n.y) > 1e-4) { touchParcel(d, p); p.ids.splice(i + 1, 0, id); if (p.mid) p.mid.splice(i + 1, 0, false); break; } }
      }
      return id;
    });
    const p = createParcel(ds, d, mother, ccwIds(ids, P), null);
    return { delta: closeDelta(ds, d), label: p.label, added: d.added.map(q => q.id) };
  }
  // 凹口：在段外圍（測區邊界）上畫一條或多條封口線（每條連兩個既有界址點），圍出位於所有宗地之外、且每條封口線都在其邊上的最小範圍。
  // 做法：段外圍的邊反向（段外在左）加上封口線的雙向邊，以「最左轉」追蹤出各個面；取面積為正（有界）且用到所有封口線者。回傳 {ids（逆時針）, area}，不修改資料
  function pocketRegion(ds, chords) {
    if (!chords.length) throw new Error('請至少畫一條封口線'); const P = ds.points;
    const top = ds.parcels.filter(p => !p.deleted && !(p.containers && p.containers.length)).map(p => p.idx), loops = outlineLoops(ds, top).filter(l => l.area > 0), onOut = new Set(loops.flatMap(l => l.ids));
    for (const [a, b] of chords) {
      if (a === b) throw new Error('封口線的兩端不可相同'); if (!onOut.has(a) || !onOut.has(b)) throw new Error(`${!onOut.has(a) ? a : b} 不在段外圍（測區邊界）上`);
      if (ds.edges.has(segKey(a, b))) throw new Error(`${a}–${b} 已是界址線`);
      for (const f of ds.edges.values()) if (f.a !== a && f.a !== b && f.b !== a && f.b !== b && edgeRelation(ds, { a, b }, f) === 'cross') throw new Error(`封口線 ${a}–${b} 與界址線 ${f.a}–${f.b} 交錯`);
      const A = P.get(a), B = P.get(b), my = (A.y + B.y) / 2, mx = (A.x + B.x) / 2; if (ds.parcels.some(p => !p.deleted && p.ids.length && pointInRing(p.ids, P, my, mx))) throw new Error(`封口線 ${a}–${b} 穿過宗地內部`);
    }
    const out = new Map(), add = (u, v) => { let l = out.get(u); if (!l) out.set(u, l = []); l.push({ v, used: false }); };
    for (const l of loops) for (let k = 0; k < l.ids.length; k++) add(l.ids[(k + 1) % l.ids.length], l.ids[k]);   // 段外圍反向：段外在左
    for (const [a, b] of chords) { add(a, b); add(b, a); }
    const faces = [];
    for (const [u0, list] of out) for (const e0 of list) {
      if (e0.used) continue; e0.used = true; const ids = [u0]; let from = u0, cur = e0;
      for (let g = 0; g < 1e6; g++) {
        const to = cur.v; if (to === u0) break; ids.push(to);
        const cand = (out.get(to) || []).filter(e => !e.used && e.v !== from || (!e.used && (out.get(to) || []).filter(x => !x.used).length === 1)); if (!cand.length) break;
        const F = P.get(from), T = P.get(to), ux = T.x - F.x, uy = T.y - F.y; let best = null, ba = -Infinity;
        for (const e of cand) { const V = P.get(e.v), vx = V.x - T.x, vy = V.y - T.y, ang = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); if (ang > ba) { ba = ang; best = e; } }
        best.used = true; from = to; cur = best;
      }
      if (ids.length >= 3) faces.push({ ids, area: signedArea(ids, P) });
    }
    const uses = (ids, a, b) => ids.some((v, k) => { const w = ids[(k + 1) % ids.length]; return (v === a && w === b) || (v === b && w === a); });
    const ok = faces.filter(f => f.area > 1e-6 && chords.every(([a, b]) => uses(f.ids, a, b))).sort((x, y) => x.area - y.area);
    if (!ok.length) throw new Error('封口線沒有圍出位於宗地之外的範圍（兩端是否都在同一個凹口的兩岸？）');
    return { ids: ok[0].ids, area: ok[0].area };
  }
  // D11：已刪除的宗地，新面積、中心坐標、LIMIT 改 0（其餘欄位與記錄不動，同 NECEXE）
  // 未登記地工具動過的宗地（新建、分割剩餘、合併保留者）：新面積（公頃 6 位）、LIMIT（中心到最遠界址點）重算，中心不在宗地內就移進來（比照 116 的 update_d11）。
  // 新宗地附加一筆，沿用來源宗地（或任一 9000 號）的記錄當樣板，換上地號；登記面積 0、圖解面積＝新面積。
  function interiorPoint(ids, P) {
    const c = polyCentroid(ids, P); if (pointInRing(ids, P, c.y, c.x)) return c;
    let y0 = Infinity, y1 = -Infinity; for (const id of ids) { const q = P.get(id); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    let best = null;
    for (const f of [0.5, 0.3, 0.7, 0.2, 0.8]) { const y = y0 + (y1 - y0) * f, xs = [];
      for (let i = 0; i < ids.length; i++) { const a = P.get(ids[i]), b = P.get(ids[(i + 1) % ids.length]); if ((a.y > y) !== (b.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y)); }
      xs.sort((u, v) => u - v); for (let k = 0; k + 1 < xs.length; k += 2) if (!best || xs[k + 1] - xs[k] > best.w) best = { w: xs[k + 1] - xs[k], x: (xs[k] + xs[k + 1]) / 2, y }; }
    return best ? { x: best.x, y: best.y } : c;
  }
  function d11Targets(ds) {
    const o = ds.orig; return ds.parcels.filter(p => !p.deleted && (p.created || (p.unregEdit && (() => { const r = o && o.rings[p.idx]; return !r || r.ids.length !== p.ids.length || r.ids.some((v, k) => v !== p.ids[k]); })())));
  }
  // 已刪除的未登記地（9000 號以上）：D11 整筆移除（116 倉庫「刪除無地號界址的 6 筆區外土地」同作法；保留記錄的話 NECEXE 每次報表都列「無地號界址」）。
  // 包含本次刪除／合併掉的，以及檔案裡原本就有的「新面積 0、中心 0、沒有界址串」的 9000 號記錄（例如先前在 NECEXE 刪掉的）。一般地號仍照 NECEXE 保留記錄、新面積改 0。
  function removedUnregKeys(ds, par) {
    const live = new Set(ds.parcels.filter(p => !p.deleted).map(p => p.key)), out = new Set();
    for (const p of ds.parcels) if (p.deleted && !p.created && mainNo(p) >= UNREG_MIN) out.add(p.key);
    if (par) for (const r of par.rows) { const k = `${r.SECTION_O}|${r.PAR_O_M}|${r.PAR_O_C}`; if (!r._deleted && r.PAR_O_M >= UNREG_MIN && r.AREA_NEW === 0 && !r.CENTER_Y && !live.has(k)) out.add(k); }
    return out;
  }
  function exportD11(par, ds) {
    let out = new Uint8Array(par.u8), n = 0, upd = 0; const recs = [], P = ds.points, has = f => par.fields.some(x => x.name === f);
    const rmKeys = removedUnregKeys(ds, par), drop = new Set(); par.rows.forEach((r, i) => { if (!r._deleted && rmKeys.has(`${r.SECTION_O}|${r.PAR_O_M}|${r.PAR_O_C}`)) drop.add(i); });
    for (const p of ds.parcels) if (p.deleted && !p.created && p.attrRow != null && !drop.has(p.attrRow)) { for (const f of ['AREA_NEW', 'CENTER_Y', 'CENTER_X', 'LIMIT']) if (has(f)) patchDbfNumber(out, par, p.attrRow, f, 0); n++; }
    const fill = (u8, t, row, p, old) => {
      const ha = Math.round(p.area / 1e4 * 1e6) / 1e6; let c = old && old.CENTER_Y ? { y: old.CENTER_Y, x: old.CENTER_X } : null;
      if (!c || !pointInRing(p.ids, P, c.y, c.x)) { const q = interiorPoint(p.ids, P); c = { y: Math.round(q.y * 1000) / 1000, x: Math.round(q.x * 1000) / 1000 }; }
      let lim = 0; for (const id of p.ids) { const q = P.get(id); lim = Math.max(lim, Math.hypot(q.x - c.x, q.y - c.y)); }
      const set = (f, v) => { if (has(f)) patchDbfNumber(u8, t, row, f, v); };
      set('AREA_NEW', ha); set('CENTER_Y', c.y); set('CENTER_X', c.x); set('LIMIT', Math.round(lim * 1000) / 1000); return ha;
    };
    for (const p of d11Targets(ds)) {
      if (p.created) {
        const lk = p.like != null ? ds.parcels[p.like] : null, tr = lk && lk.attrRow != null ? lk.attrRow : par.rows.findIndex(r => !r._deleted && r.PAR_N_M >= UNREG_MIN);
        const rec = tr >= 0 ? par.u8.slice(par.hl + tr * par.rl, par.hl + (tr + 1) * par.rl) : blankRecord(par), t = { ...par, hl: 0 }; rec[0] = 0x20;
        const [sec, m, c] = p.key.split('|').map(Number);
        for (const [f, v] of [['PAR_O_M', m], ['PAR_O_C', c], ['PAR_N_M', m], ['PAR_N_C', c], ['SECTION_O', sec], ['AREA_OLD', Math.round((p.areaReg || 0) / 1e4 * 1e6) / 1e6]]) if (has(f)) patchDbfNumber(rec, t, 0, f, v);   // 復原的遺漏地號帶登記面積
        const ha = fill(rec, t, 0, p, null); if (has('AREA_DIG')) patchDbfNumber(rec, t, 0, 'AREA_DIG', ha); recs.push(rec);
      } else if (p.attrRow != null) { fill(out, par, p.attrRow, p, par.rows[p.attrRow]); upd++; }
    }
    return { bytes: layoutDbf(par, out, JUNK.d11, { drop, append: recs }), cleared: n, removed: drop.size, updated: upd, added: recs.length };
  }
  // D21（經界線）：由目前的界址串推出每條線的左右宗地（環逆時針＝內部在左；地中地的線另一側是外圈；段外＝0），與原檔比對：
  // 左右不同就改寫、已不存在的線把端點清成 0（NECEXE 自己也留這種列，讀取時忽略）、新的線附加在檔尾。圓弧（LIN_MID）的列不動。
  // KC0336 驗證：未修改時推得的 8712 條與 D21 全部一致。
  function exportD21(lin, ds) {
    const P = ds.points, side = new Map(), put = (k, L, who) => { let e = side.get(k); if (!e) side.set(k, e = { L: null, R: null }); if (L) { if (!e.L) e.L = who; } else if (!e.R) e.R = who; };
    for (const p of ds.parcels) {
      if (p.deleted || p.ids.length < 3) continue; const ccw = signedArea(p.ids, P) > 0, n = p.ids.length;
      for (let i = 0; i < n; i++) { const a = p.ids[i], b = p.ids[(i + 1) % n]; if (a === b) continue; put(a + '>' + b, ccw, p); put(b + '>' + a, !ccw, p); }
    }
    for (const h of ds.parcels) for (const ci of h.deleted ? [] : h.containers || []) {
      const c = ds.parcels[ci]; if (c.deleted) continue; const n = h.ids.length;
      for (let i = 0; i < n; i++) for (const k of [h.ids[i] + '>' + h.ids[(i + 1) % n], h.ids[(i + 1) % n] + '>' + h.ids[i]]) { const e = side.get(k); if (!e) continue; if (e.L === h && !e.R) e.R = c; else if (e.R === h && !e.L) e.L = c; }
    }
    const kp = p => (p ? p.key.split('|').map(Number) : [0, 0, 0]), out = new Uint8Array(lin.u8), has = new Set(), drop = new Set(); let patched = 0, cleared = 0;
    const setSide = (u8, row, S, p) => { const [a, b, c] = kp(p); patchDbfNumber(u8, { ...lin, u8 }, row, S + '_SECTION', a); patchDbfNumber(u8, { ...lin, u8 }, row, S + '_PARCEL', b); patchDbfNumber(u8, { ...lin, u8 }, row, S + '_PARCEL_E', c); };
    lin.rows.forEach((r, i) => {
      if (r._deleted || !r.LIN_TOP || !r.LIN_BOT || r.LIN_MID) return;
      const e = side.get(r.LIN_TOP + '>' + r.LIN_BOT); has.add(segKey(r.LIN_TOP, r.LIN_BOT));
      if (!e) { drop.add(i); cleared++; return; }   // 已不存在的線整列移除（不就地清 0）
      const same = (S, p) => { const [a, b, c] = kp(p); return (r[S + '_PARCEL'] || 0) === b && (r[S + '_PARCEL_E'] || 0) === c && (!b || r[S + '_SECTION'] === a); };
      if (!same('L', e.L) || !same('R', e.R)) { setSide(out, i, 'L', e.L); setSide(out, i, 'R', e.R); patched++; }
    });
    for (const r of lin.rows) if (!r._deleted && r.LIN_MID) { has.add(segKey(r.LIN_TOP, r.LIN_MID)); has.add(segKey(r.LIN_MID, r.LIN_BOT)); }
    const tmpl = lin.rows.findIndex(r => !r._deleted && r.LIN_TOP && !r.LIN_MID), recs = [];
    for (const e of ds.edges.values()) {
      if (e.arcPart || has.has(e.key)) continue; const sd = side.get(e.a + '>' + e.b); if (!sd) continue;
      const rec = tmpl >= 0 ? lin.u8.slice(lin.hl + tmpl * lin.rl, lin.hl + (tmpl + 1) * lin.rl) : blankRecord(lin); rec[0] = 0x20;
      const tmp = { ...lin, hl: 0, u8: rec }; patchDbfNumber(rec, tmp, 0, 'LIN_TOP', e.a); patchDbfNumber(rec, tmp, 0, 'LIN_MID', 0); patchDbfNumber(rec, tmp, 0, 'LIN_BOT', e.b);
      for (const [S, p] of [['L', sd.L], ['R', sd.R]]) { const [a, b, c] = kp(p); patchDbfNumber(rec, tmp, 0, S + '_SECTION', a); patchDbfNumber(rec, tmp, 0, S + '_PARCEL', b); patchDbfNumber(rec, tmp, 0, S + '_PARCEL_E', c); }
      for (const f of lin.fields) if (f.type === 'C') for (let k = 0; k < f.len; k++) rec[f.off + k] = 0x20;   // 查註、識別欄位留白
      recs.push(rec);
    }
    let sorted = true, pk = null; for (const r of lin.rows) { if (JUNK.d21(r)) continue; const k = [r.LIN_TOP, r.LIN_BOT]; if (pk && (k[0] < pk[0] || (k[0] === pk[0] && k[1] < pk[1]))) { sorted = false; break; } pk = k; }   // 原檔依端點排序（NECEXE 寫出的是）就保持排序
    return { bytes: layoutDbf(lin, out, JUNK.d21, { drop, append: recs, key: sorted ? b => [numAt(lin, b, 'LIN_TOP'), numAt(lin, b, 'LIN_BOT')] : null }), patched, cleared, added: recs.length };
  }
  // D12（地中地）：目前關係中檔案沒有的，附加記錄（沿用第一筆當樣板，只改 O_*／I_* 六欄）；檔案有而目前已解除的，六欄清成 0。
  function exportD12(d12, ds, par) {
    const keyOf = r => `${r.O_SECTION}|${r.O_PARCEL}|${r.O_PARCEL_E}>${r.I_SECTION}|${r.I_PARCEL}|${r.I_PARCEL_E}`, have = new Map();
    d12.rows.forEach((r, i) => { if (!r._deleted) have.set(keyOf(r), i); });
    const want = new Map(); for (const p of ds.parcels) for (const hi of p.holes || []) { const h = ds.parcels[hi]; want.set(p.key + '>' + h.key, [p.key, h.key]); }
    const put = (u8, base, name, v) => { const f = d12.fields.find(x => x.name === name); if (!f) throw new Error('D12 缺欄位 ' + name);
      const s = f.type === 'N' || f.type === 'F' ? Number(v || 0).toFixed(f.dec).padStart(f.len, ' ') : String(v ?? '').padEnd(f.len, ' ');
      if (s.length > f.len) throw new Error(`${name} 值 ${v} 超出欄寬`); for (let i = 0; i < f.len; i++) u8[base + f.off + i] = s.charCodeAt(i); };
    const six = (u8, base, ok, ik) => { const [a, b, c] = ok.split('|'), [e, f, g] = ik.split('|'); put(u8, base, 'O_SECTION', a); put(u8, base, 'O_PARCEL', b); put(u8, base, 'O_PARCEL_E', c); put(u8, base, 'I_SECTION', e); put(u8, base, 'I_PARCEL', f); put(u8, base, 'I_PARCEL_E', g); };
    let out = new Uint8Array(d12.u8), cleared = 0; const recs = [];
    const gone = new Set(ds.parcels.filter(p => p.deleted).map(p => p.key));   // 內圈已刪除：關係列照 NECEXE 保留不動
    const rmKeys = removedUnregKeys(ds, par);   // 內圈是已移除的未登記地：關係一併移除（不留指向不存在地號的列）
    const drop = new Set(); for (const [k, i] of have) { const ik = k.split('>')[1]; if (!want.has(k) && (!gone.has(ik) || rmKeys.has(ik))) { drop.add(i); cleared++; } }   // 解除的關係整列移除（不就地清 0）
    const first = d12.rows.findIndex(r => !r._deleted), tmpl = first >= 0 ? d12.u8.slice(d12.hl + first * d12.rl, d12.hl + (first + 1) * d12.rl) : blankRecord(d12);
    for (const [k, [ok, ik]] of want) if (!have.has(k)) { const rec = new Uint8Array(tmpl); rec[0] = 0x20; six(rec, 0, ok, ik); recs.push(rec); }
    out = layoutDbf(d12, out, JUNK.d12, { drop, append: recs });
    return { bytes: out, added: recs.length, cleared };
  }

  // ── 輸出 ────────────────────────────────────────────────────────────────
  // 在 DBF 尾端附加整筆記錄（recs＝每筆 rl 位元組），更新筆數。結尾 0x1A 照原檔：原檔有才加（NECEXE 寫出的 D 檔沒有，KC0336 驗證 NECEXE 改後的 D12 與本程式輸出逐位元組相同）。
  function appendRecords(u8, dbf, recs) {
    if (!recs.length) return u8;
    const end = dbf.hl + dbf.n * dbf.rl, eof = u8.length > end && u8[end] === 0x1a, out = new Uint8Array(end + recs.length * dbf.rl + (eof ? 1 : 0));
    out.set(u8.subarray(0, end)); recs.forEach((r, i) => out.set(r, end + i * dbf.rl)); if (eof) out[out.length - 1] = 0x1a;
    new DataView(out.buffer).setUint32(4, dbf.n + recs.length, true); return out;
  }
  const blankRecord = dbf => { const r = new Uint8Array(dbf.rl).fill(0x20); return r; };
  // 重排 DBF 記錄（比照 NECEXE 自己寫出的 D 檔）：鍵值為 0 的空列一律留在檔尾、不可夾在有效記錄之間——
  // KC0336 實測：D13 中間留了地號 0 的列（刪除宗地時就地清 0），NECEXE 載入時把它刪掉往前遞補，但內部記的列位置沒跟著改，
  // 經界線左右地號整批錯位（1022-0 被讀成 1021-8），數百宗變成「無地號界址」。D11／D14 原本檔尾就有空列，新記錄也必須插在空列之前。
  // opt：drop＝要移除的列、replace＝某列換成多筆（宗地點數變多時連續寫入）、append＝新記錄（放在最後一筆有效記錄之後）、key＝有效記錄排序鍵（原檔有排序時保持排序）
  function layoutDbf(dbf, u8, isJunk, opt = {}) {
    const drop = opt.drop || new Set(), rep = opt.replace || new Map(), live = [], junk = [];
    for (let i = 0; i < dbf.n; i++) {
      if (drop.has(i)) continue;
      if (rep.has(i)) { live.push(...rep.get(i)); continue; }
      const b = u8.slice(dbf.hl + i * dbf.rl, dbf.hl + (i + 1) * dbf.rl); (isJunk(dbf.rows[i]) ? junk : live).push(b);
    }
    live.push(...(opt.append || []));
    if (opt.key) { const k = live.map((b, i) => [opt.key(b), i]); k.sort((x, y) => (x[0][0] - y[0][0]) || (x[0][1] - y[0][1]) || (x[1] - y[1])); const l2 = k.map(([, i]) => live[i]); live.length = 0; live.push(...l2); }
    const recs = [...live, ...junk], end = dbf.hl + dbf.n * dbf.rl, eof = u8.length > end && u8[end] === 0x1a, out = new Uint8Array(dbf.hl + recs.length * dbf.rl + (eof ? 1 : 0));
    out.set(u8.subarray(0, dbf.hl)); recs.forEach((r, i) => out.set(r, dbf.hl + i * dbf.rl)); if (eof) out[out.length - 1] = 0x1a;
    new DataView(out.buffer).setUint32(4, recs.length, true); return out;
  }
  const numAt = (dbf, rec, name) => { const f = dbf.fields.find(x => x.name === name); return Number(String.fromCharCode(...rec.subarray(f.off, f.off + f.len)).trim()) || 0; };
  const JUNK = { d11: r => !r.PAR_O_M && !r.PAR_N_M, d12: r => !r.O_PARCEL && !r.I_PARCEL, d13: r => !r.O_PARCEL && !r.O_PARCEL_E, d14: r => !r.COT_NUMBER, d21: r => !r.LIN_TOP || !r.LIN_BOT };
  // 回傳新的 D14 位元組：被移動點只改 COT_Y/COT_X（其餘位元組不動）；新增的點附加在檔尾（REF=0）。
  // 刪除的點不從檔案移除（保留孤立記錄，避免索引不一致），數量見 orphans。
  function exportD14(pts, ds) {
    let out = new Uint8Array(pts.u8), n = 0;
    for (const p of movedPoints(ds)) {
      if (p.row == null || p.added) continue;
      patchDbfNumber(out, pts, p.row, 'COT_Y', p.y); patchDbfNumber(out, pts, p.row, 'COT_X', p.x); n++;
    }
    const add = [...ds.points.values()].filter(p => p.row == null && p.added);
    if (add.length) {   // 新增點插在檔尾空列之前
      const t = { ...pts, hl: 0 }, recs = add.map(p => { const r = blankRecord(pts); patchDbfNumber(r, t, 0, 'COT_NUMBER', p.id); patchDbfNumber(r, t, 0, 'COT_REF', 0); patchDbfNumber(r, t, 0, 'COT_Y', p.y); patchDbfNumber(r, t, 0, 'COT_X', p.x); return r; });
      out = layoutDbf(pts, out, JUNK.d14, { append: recs });
    }
    const orphans = structSummary(ds).removed;
    return { bytes: out, changed: n, added: add.length, orphans };
  }
  // D13（界址串）：環有增減點的宗地，依序改寫其記錄的 COORD_1..8／MIDARC_n；點數變多時在該宗原有記錄後面接著寫（同一宗的記錄保持連續），
  // 縮短時多出的列把 COORD 清成 0、保留地號鍵（與 NECEXE 寫出的相同：1092-2 驗證逐位元組一致；不用刪除旗標，NECEXE 不看旗標）。
  // 已刪除的宗地整宗移除記錄（不可就地清 0，見 layoutDbf）；新宗地接在最後一筆有效記錄之後。
  function exportD13(bnd, ds) {
    const out = new Uint8Array(bnd.u8); let patched = 0, appended = 0, parcels = 0; const setRec = (u8, base, k, id, mid) => {
      const fc = bnd.fields.find(f => f.name === 'COORD_' + k), fm = bnd.fields.find(f => f.name === 'MIDARC_' + k);
      const s = String(id).padStart(fc.len, ' '); for (let i = 0; i < fc.len; i++) u8[base + fc.off + i] = s.charCodeAt(i);
      if (fm) { const t = (mid ? 'T' : 'F').padEnd(fm.len, ' '); for (let i = 0; i < fm.len; i++) u8[base + fm.off + i] = t.charCodeAt(i); }
    };
    const drop = new Set(), replace = new Map(), append = [], row = i => out.slice(bnd.hl + i * bnd.rl, bnd.hl + (i + 1) * bnd.rl);
    const tmplRow = bnd.rows.findIndex(r => !r._deleted && r.O_PARCEL);
    for (const p of ds.parcels) {
      if (!p.rows || !p.ids0 || (p.created && p.deleted)) continue;
      const same = p.ids.length === p.ids0.length && p.ids.every((v, i) => v === p.ids0[i]); if (same) continue; parcels++;
      if (p.deleted) { for (const ri of p.rows) drop.add(ri); continue; }
      const n = p.ids.length, need = Math.ceil(n / 8), have = p.rows.length, recs = [];
      for (let r = 0; r < Math.max(need, have); r++) {
        let rec;
        if (r < have) { rec = row(p.rows[r]); patched++; }
        else { rec = have ? row(p.rows[have - 1]) : row(tmplRow); rec[0] = 0x20; appended++;
          if (!have) { const [a, b, c] = p.key.split('|').map(Number), t = { ...bnd, hl: 0 }; patchDbfNumber(rec, t, 0, 'O_SECTION', a); patchDbfNumber(rec, t, 0, 'O_PARCEL', b); patchDbfNumber(rec, t, 0, 'O_PARCEL_E', c); } }
        for (let k = 0; k < 8; k++) { const i = r * 8 + k; setRec(rec, 0, k + 1, i < n ? p.ids[i] : 0, i < n && p.mid ? p.mid[i] : false); }
        recs.push(rec);
      }
      if (!have) append.push(...recs); else { replace.set(p.rows[0], recs); for (const ri of p.rows.slice(1)) drop.add(ri); }
    }
    return { bytes: layoutDbf(bnd, out, JUNK.d13, { drop, replace, append }), rewritten: patched, appended, parcels };
  }
  // ── ZIP（不壓縮，store）：輸出完整案件資料夾的備援格式（瀏覽器不支援直接寫入資料夾時）──────────
  // files: [{name:'KC0336/KC0336.D14', data:Uint8Array}]；檔名以 UTF-8 標記（bit 11），中文檔名在 Windows 10 以上的檔案總管可正確解開。
  let crcTable = null;
  function crc32(u8) {
    if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
    let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
  }
  function makeZip(files, date = new Date()) {
    const enc = new TextEncoder(), dt = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
      dd = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
    const locals = [], central = []; let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data, crc = crc32(data), lh = new Uint8Array(30 + name.length), v = new DataView(lh.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true); v.setUint16(10, dt, true); v.setUint16(12, dd, true);
      v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, name.length, true); lh.set(name, 30);
      const ch = new Uint8Array(46 + name.length), w = new DataView(ch.buffer);
      w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true); w.setUint16(12, dt, true); w.setUint16(14, dd, true);
      w.setUint32(16, crc, true); w.setUint32(20, data.length, true); w.setUint32(24, data.length, true); w.setUint16(28, name.length, true); w.setUint32(42, off, true); ch.set(name, 46);
      locals.push(lh, data); central.push(ch); off += lh.length + data.length;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    const out = new Uint8Array(off + cdSize + 22); let p = 0; for (const c of [...locals, ...central, end]) { out.set(c, p); p += c.length; } return out;
  }
  // 有改動的 D 檔：{ 副檔名: {bytes, note} }。dbf＝{pts, bnd, d12}（原檔解析結果）
  function changedDFiles(ds, dbf) {
    const out = {}, st = structSummary(ds);
    if (dbf.pts && (movedPoints(ds).length || st.added)) { const r = exportD14(dbf.pts, ds); out.d14 = { bytes: r.bytes, note: `改 ${r.changed} 點坐標` + (r.added ? `、附加 ${r.added} 點` : '') }; }
    if (dbf.bnd && (st.rings || st.created)) { const r = exportD13(dbf.bnd, ds); out.d13 = { bytes: r.bytes, note: `改寫 ${r.parcels} 宗界址串` }; }
    const rmN = dbf.par ? removedUnregKeys(ds, dbf.par).size : 0;
    if (dbf.d12 && (st.holes || rmN)) { const r = exportD12(dbf.d12, ds, dbf.par); if (r.added || r.cleared) out.d12 = { bytes: r.bytes, note: `地中地 +${r.added}` + (r.cleared ? ` −${r.cleared}` : '') }; }
    if (dbf.par && (st.deleted || st.created || rmN || d11Targets(ds).length)) { const r = exportD11(dbf.par, ds); if (r.cleared || r.removed || r.updated || r.added) out.d11 = { bytes: r.bytes, note: [r.removed ? `移除 ${r.removed} 筆已刪除的未登記地` : '', r.cleared ? `刪除 ${r.cleared} 宗（新面積改 0）` : '', r.added ? `新增 ${r.added} 宗` : '', r.updated ? `更新 ${r.updated} 宗面積` : ''].filter(Boolean).join('、') }; }
    if (dbf.lin && (st.rings || st.holes || st.deleted || st.created || st.added || st.removed)) { const r = exportD21(dbf.lin, ds); if (r.patched || r.cleared || r.added) out.d21 = { bytes: r.bytes, note: `經界線 改 ${r.patched}、移除 ${r.cleared}、新增 ${r.added}` }; }
    return { files: out, needD12: !dbf.d12 && st.holes > 0 };
  }

  // 供 AI/外部程式讀取的中繼資料（JSON，自帶欄位說明）
  // ── Access 資料庫（.MDB，Jet 4）讀取：只讀使用者資料表的文字與數值欄（地政 EXAM.MDB 用）──────────────
  // 頁 4096 bytes。系統目錄 MSysObjects 的表定義在第 2 頁；使用者表＝Type 1、Flags 0，Id 低 24 位＝表定義頁。
  // 資料頁（type 1）在 offset 4 記錄所屬表定義頁，掃描全部資料頁即可取得各表的列（刪除列 0x8000、轉址列 0x4000 略過）。
  // 列：開頭 2 bytes 欄數；固定長度欄在 2＋offset_F；尾端依序往前是 null 遮罩（每欄 1 bit，1＝有值）、可變欄數、可變欄位移表。
  // Jet 4 文字為 UCS-2；以 0xFF 0xFE 開頭為壓縮格式（0x00 切換單位元組／雙位元組）。驗證：KC0336 EXAM.MDB 兩表與 mdb-export 逐欄相同。
  function parseMdb(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), PG = 4096;
    if (u8.length < PG * 3 || dv.getUint32(0, true) !== 0x100 || dv.getUint8(0x14) < 1) throw new Error('不是 Access 2000 以後（Jet 4）的 MDB 檔');
    const npg = Math.floor(u8.length / PG), u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true);
    const ucs = (o, n) => { let s = ''; for (let i = 0; i + 1 < n; i += 2) s += String.fromCharCode(u16(o + i)); return s; };
    const text = (o, n) => {
      if (n >= 2 && u8[o] === 0xff && u8[o + 1] === 0xfe) { let s = '', i = o + 2, wide = false; const e = o + n;
        while (i < e) { if (u8[i] === 0 && !(wide && i + 1 < e)) { wide = !wide; i++; continue; } if (wide) { if (u8[i] === 0 && i + 1 < e && u8[i + 1] === 0) { wide = false; i++; continue; } s += String.fromCharCode(u8[i] | (u8[i + 1] << 8)); i += 2; } else { if (u8[i] === 0) { wide = true; i++; continue; } s += String.fromCharCode(u8[i]); i++; } }
        return s; }
      return ucs(o, n);
    };
    function tdef(pg) {
      const parts = []; let p = pg;
      for (let g = 0; p && g < 64; g++) { const o = p * PG; if (u8[o] !== 2) throw new Error(`第 ${p} 頁不是表定義頁`); parts.push(g ? u8.subarray(o + 8, o + PG) : u8.subarray(o, o + PG)); p = u32(o + 4); }
      const t = new Uint8Array(parts.reduce((s, a) => s + a.length, 0)); let k = 0; for (const a of parts) { t.set(a, k); k += a.length; }
      const tv = new DataView(t.buffer), nCols = tv.getUint16(0x2d, true), nRealIdx = tv.getUint32(0x33, true);
      let o = 0x3f + nRealIdx * 12; const cols = [];
      for (let i = 0; i < nCols; i++, o += 25) cols.push({ type: t[o], num: tv.getUint16(o + 5, true), varIdx: tv.getUint16(o + 7, true), fixed: !!(t[o + 15] & 1), fixOff: tv.getUint16(o + 21, true), len: tv.getUint16(o + 23, true) });
      for (const c of cols) { const n = tv.getUint16(o, true); let s = ''; for (let i = 0; i < n; i += 2) s += String.fromCharCode(tv.getUint16(o + 2 + i, true)); c.name = s; o += 2 + n; }
      return cols.sort((a, b) => a.num - b.num);   // 依欄號（＝Access 裡的欄位順序）
    }
    function value(c, rs, re, nullMask, varOff, nVar) {
      const present = (nullMask[c.num >> 3] >> (c.num & 7)) & 1;
      if (c.type === 1) return !!present;
      if (!present) return null;
      let o, n;
      if (c.fixed) { o = rs + 2 + c.fixOff; n = c.len; }
      else { if (c.varIdx >= nVar) return null; o = rs + varOff[c.varIdx]; n = varOff[c.varIdx + 1] - varOff[c.varIdx]; if (n <= 0) return c.type === 10 ? '' : null; }
      if (o + n > re) return null;
      switch (c.type) {
        case 2: return u8[o]; case 3: return dv.getInt16(o, true); case 4: return dv.getInt32(o, true);
        case 6: return dv.getFloat32(o, true); case 7: return dv.getFloat64(o, true);
        case 5: return Number(dv.getBigInt64(o, true)) / 1e4;
        case 8: return new Date(Date.UTC(1899, 11, 30) + dv.getFloat64(o, true) * 864e5);
        case 10: return text(o, n);
        default: return null;   // 備忘、OLE、GUID、數值（decimal）等本工具用不到
      }
    }
    function rows(pg, cols) {
      const out = [];
      for (let p = 1; p < npg; p++) {
        const o = p * PG; if (u8[o] !== 1 || u32(o + 4) !== pg) continue;
        const n = u16(o + 12); let prevStart = PG;
        for (let i = 0; i < n; i++) {
          const raw = u16(o + 14 + i * 2), start = raw & 0x1fff, end = prevStart; prevStart = start;
          if (raw & 0xc000 || start >= end) continue;   // 刪除或轉址
          const rs = o + start, re = o + end, nc = u16(rs), maskLen = (nc + 7) >> 3, mask = u8.subarray(re - maskLen, re);
          const nVar = u16(re - maskLen - 2), varOff = []; for (let k = 0; k <= nVar; k++) varOff.push(u16(re - maskLen - 4 - k * 2));
          const r = {}; for (const c of cols) r[c.name] = value(c, rs, re, mask, varOff, nVar); out.push(r);
        }
      }
      return out;
    }
    const sysCols = tdef(2), sys = rows(2, sysCols), tables = {};
    for (const r of sys) if (r.Type === 1 && !(r.Flags & 0x80000002) && r.Name && !/^MSys/i.test(r.Name)) {
      const pg = r.Id & 0xffffff; try { const cols = tdef(pg); tables[r.Name] = { columns: cols.map(c => c.name), rows: rows(pg, cols) }; } catch (e) { tables[r.Name] = { error: e.message, columns: [], rows: [] }; }
    }
    return tables;
  }
  // ── 所有權人分析（EXAM.MDB：土地標示資料表、權利人與土地關係資料表）──────────────────────────
  // 以原段號＋原母號＋原子號對應宗地鍵（D13 的 O_SECTION|O_PARCEL|O_PARCEL_E）。只計「所有權」，抵押權等他項權利另計。
  const PUBLIC_RE = /國有|省有|縣有|市有|鄉有|鎮有|縣市有|鄉鎮市有|公有/;
  function ownerTables(tables) {
    const find = re => Object.keys(tables).find(n => re.test(n)), lt = find(/土地標示/), ot = find(/權利人/);
    if (!lt && !ot) throw new Error('MDB 裡沒有「土地標示資料表」或「權利人與土地關係資料表」');
    const key = r => `${parseInt(r['原段號'], 10)}|${r['原母號']}|${r['原子號'] || 0}`;
    const land = new Map(), own = new Map();
    for (const r of lt ? tables[lt].rows : []) land.set(key(r), { zone: r['使用分區'] || '', use: r['使用地類別'] || '', other: r['有無他項權利'] === '1', bldg: r['有無建物登記'] === '1' });
    for (const r of ot ? tables[ot].rows : []) { const k = key(r); (own.get(k) || own.set(k, []).get(k)).push({ no: r['錄號'], scope: r['權利範圍'] || '', den: r['權利範圍分母'] || '', num: r['權利範圍分子'] || '', right: r['權利種類'] || '', kind: r['權利人類別'] || '', name: r['權利人姓名'] || '', mgr: r['管理者姓名'] || '' }); }
    return { land, own, landRows: lt ? tables[lt].rows.length : 0, ownRows: ot ? tables[ot].rows.length : 0 };
  }
  // 宗地的所有權型態：無所有權人／公有／單獨所有／分別共有／公同共有／法人等
  function ownerClass(list) {
    const o = (list || []).filter(x => x.right === '所有權'); if (!o.length) return 'none';
    if (o.some(x => PUBLIC_RE.test(x.kind) || PUBLIC_RE.test(x.name))) return 'public';
    if (o.some(x => x.scope === '公同共有')) return 'joint';
    if (o.length > 1 || o.some(x => x.scope === '分別共有')) return 'shared';
    return /人$/.test(o[0].kind) && !/法人/.test(o[0].kind) ? 'single' : 'corp';
  }
  const OWNER_CLASS = { none: '無所有權人', public: '公有', single: '單獨所有（自然人）', corp: '法人／祭祀公業等', shared: '分別共有', joint: '公同共有' };
  // 持分合計（BigInt 分數）；含公同共有者每人都記 1/1，不檢查
  function shareSum(list) {
    const g = (a, b) => { while (b) [a, b] = [b, a % b]; return a < 0n ? -a : a; };
    let n = 0n, d = 1n;
    for (const x of list) { if (!/^\d+$/.test(x.num) || !/^\d+$/.test(x.den) || x.den === '0') return null; const a = BigInt(x.num), b = BigInt(x.den); n = n * b + a * d; d *= b; const k = g(n, d); n /= k; d /= k; }
    return { n, d };
  }
  function ownerAnalysis(ds, ot) {
    const parcels = [], noOwner = [], noLand = [], shareBad = [], onMap = new Set(), counts = {};
    for (const p of ds.parcels) {
      if (p.deleted || p.ids.length < 3) continue; const no = parcelNo(p); if (!no || !no.m) continue;
      onMap.add(p.key); const list = ot.own.get(p.key) || [], o = list.filter(x => x.right === '所有權'), cls = no.m >= UNREG_MIN ? 'unreg' : ownerClass(list), land = ot.land.get(p.key) || null;
      counts[cls] = (counts[cls] || 0) + 1; parcels.push({ idx: p.idx, cls });
      if (cls === 'none') noOwner.push({ idx: p.idx, label: p.label, oldLabel: p.oldLabel, area: p.area, reg: p.areaReg, inLand: !!land, others: list.length });
      if (no.m < UNREG_MIN && o.length && !o.some(x => x.scope === '公同共有')) { const s = shareSum(o); if (s && !(s.n === s.d)) shareBad.push({ idx: p.idx, label: p.label, sum: `${s.n}/${s.d}`, owners: o.length }); }
    }
    for (const k of new Set([...ot.land.keys(), ...ot.own.keys()])) if (!onMap.has(k)) { const [, m, c] = k.split('|'); noLand.push({ key: k, label: +c ? `${m}-${c}` : m, owners: (ot.own.get(k) || []).filter(x => x.right === '所有權').length }); }
    const byNo = (u, v) => String(u.oldLabel || u.label).localeCompare(String(v.oldLabel || v.label), 'en', { numeric: true });
    noOwner.sort(byNo); noLand.sort(byNo); shareBad.sort(byNo);
    return { parcels, noOwner, noLand, shareBad, counts };
  }
  // 名字或統一編號以外的條件查詢：回傳權利人姓名含 q 的宗地索引
  function findOwner(ds, ot, q) {
    q = String(q || '').trim(); if (!q) return [];
    return ds.parcels.filter(p => !p.deleted && (ot.own.get(p.key) || []).some(x => x.name.includes(q) || x.mgr.includes(q))).map(p => p.idx);
  }

  // ── 接圖前圖資比對：齊全檢查（遺漏）＋面積較差超限 ─────────────────────
  // 參考圖資＝接圖前的分幅資料（可多份，例如各分幅資料夾，或「分幅都放在一起、分幅線還在」的整份 D 檔）。
  // 分幅切開的同一地號以子號 +1000、+2000… 編號（48-15 → 48-1015、48-2015），比對前併回原地號、面積相加。
  // 參考圖資可能是 TWD67：以同地號宗地的形心擬合六參數轉換到作業圖坐標（剔除離群後最小二乘），之後才套疊。
  const AREA_TOL = { a: 0.25, b: 0.07 };   // 地籍測量實施規則第 243 條，1/1,200：(0.25 + 0.07·⁴√F)·√F，F＝登記面積 m²
  const areaTol = (F, a = AREA_TOL.a, b = AREA_TOL.b) => (a + b * Math.pow(F, 0.25)) * Math.sqrt(F);
  function parcelNo(p) { const m = /^(\d+)(?:-(\d+))?$/.exec(String(p.label).trim()); return m ? { m: +m[1], c: +(m[2] || 0) } : null; }
  const noLabel = (m, c) => (c ? `${m}-${c}` : `${m}`);
  // 六參數轉換 x' = a·x + b·y + c、y' = d·x + e·y + f；迭代剔除殘差 > max(3×中位數, 2 m)
  function fitAffine(src, dst) {
    const n = src.length; if (n < 3) return null;
    const solve = (use, k) => {   // 3×3 正規方程式（相對形心，避免大數）
      let mx = 0, my = 0, mt = 0, c = 0; for (let i = 0; i < n; i++) if (use[i]) { mx += src[i].x; my += src[i].y; mt += dst[i][k]; c++; }
      mx /= c; my /= c; mt /= c; let sxx = 0, sxy = 0, syy = 0, sxt = 0, syt = 0;
      for (let i = 0; i < n; i++) if (use[i]) { const x = src[i].x - mx, y = src[i].y - my, t = dst[i][k] - mt; sxx += x * x; sxy += x * y; syy += y * y; sxt += x * t; syt += y * t; }
      const det = sxx * syy - sxy * sxy; if (Math.abs(det) < 1e-9) return null;
      const a = (sxt * syy - syt * sxy) / det, b = (syt * sxx - sxt * sxy) / det; return [a, b, mt - a * mx - b * my];
    };
    let use = new Array(n).fill(true), X, Y, res = [];
    for (let it = 0; it < 8; it++) {
      X = solve(use, 'x'); Y = solve(use, 'y'); if (!X || !Y) return null;
      res = src.map((s, i) => Math.hypot(X[0] * s.x + X[1] * s.y + X[2] - dst[i].x, Y[0] * s.x + Y[1] * s.y + Y[2] - dst[i].y));
      const med = median(res.filter((_, i) => use[i])), lim = Math.max(3 * med, 2), nu = res.map(r => r < lim);
      if (nu.filter(Boolean).length < 3 || nu.every((v, i) => v === use[i])) break; use = nu;
    }
    const inl = res.filter((_, i) => use[i]);
    return { X, Y, used: inl.length, total: n, median: median(inl), max: Math.max(...inl), apply: (x, y) => ({ x: X[0] * x + X[1] * y + X[2], y: Y[0] * x + Y[1] * y + Y[2] }) };
  }
  const median = a => { if (!a.length) return 0; const s = a.slice().sort((u, v) => u - v), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  // 參考圖資依地號分組：{ key:'m-c', m, c, reg, area, pieces:[{ring:[{x,y}], holes:[[{x,y}]], area}] }（坐標已轉到作業圖）
  function baselineGroups(refs, tf, merge = true) {
    const groups = new Map();
    for (const ds of refs) for (const p of ds.parcels) {
      if (p.deleted || p.ids.length < 3) continue; const no = parcelNo(p); if (!no) continue;
      const c = merge && no.c >= 1000 ? no.c % 1000 : no.c, k = noLabel(no.m, c);
      let g = groups.get(k); if (!g) groups.set(k, g = { key: k, m: no.m, c, reg: null, area: 0, pieces: [], src: new Set() });
      const T = q => (tf ? tf(q.x, q.y) : { x: q.x, y: q.y });
      g.pieces.push({ ring: p.ids.map(id => T(ds.points.get(id))), holes: (p.holes || []).map(hi => ds.parcels[hi].ids.map(id => T(ds.points.get(id)))), area: p.area, label: p.label });
      g.area += p.area; g.src.add(ds.name); if (p.areaReg > 0) g.reg = Math.max(g.reg || 0, p.areaReg);
    }
    return groups;
  }
  // 兩個簡單多邊形（{x,y} 陣列）的交集面積，精確計算：交集的邊界＝A 在 B 內的邊段＋B 在 A 內的邊段，對這些邊段做鞋帶積分。
  // 兩者重合的同向邊段只算一次（取 A 的），反向的重合邊段（只相接）不算。坐標先減去共同原點，避免大數。
  function intersectArea(A, B) {
    const ox = A[0].x, oy = A[0].y, rel = R => { const o = R.map(q => ({ x: q.x - ox, y: q.y - oy })); let s = 0; for (let i = 0; i < o.length; i++) { const p = o[i], q = o[(i + 1) % o.length]; s += p.x * q.y - q.x * p.y; } return s < 0 ? o.reverse() : o; };
    const a = rel(A), b = rel(B), E = 1e-7;
    const inside = (P, x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const p = P[i], q = P[j]; if ((p.y > y) !== (q.y > y) && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) c = !c; } return c; };
    const onEdge = (P, x, y) => { for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length], dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy; if (!l2) continue;
      const t = ((x - p.x) * dx + (y - p.y) * dy) / l2; if (t < -E || t > 1 + E) continue; const ex = p.x + t * dx - x, ey = p.y + t * dy - y; if (ex * ex + ey * ey < 1e-10) return { dx, dy }; } return null; };
    const pass = (P, Q, first) => {
      let s = 0;
      for (let i = 0; i < P.length; i++) {
        const p = P[i], q = P[(i + 1) % P.length], dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy; if (!l2) continue;
        const ts = [0, 1];
        for (let j = 0; j < Q.length; j++) {
          const c = Q[j], d = Q[(j + 1) % Q.length], ex = d.x - c.x, ey = d.y - c.y, den = dx * ey - dy * ex;
          if (Math.abs(den) > 1e-12 * Math.sqrt(l2 * (ex * ex + ey * ey))) {
            const t = ((c.x - p.x) * ey - (c.y - p.y) * ex) / den, u = ((c.x - p.x) * dy - (c.y - p.y) * dx) / den;
            if (t > E && t < 1 - E && u > -E && u < 1 + E) ts.push(t);
          } else for (const r of [c, d]) { const t = ((r.x - p.x) * dx + (r.y - p.y) * dy) / l2, fx = p.x + t * dx - r.x, fy = p.y + t * dy - r.y; if (t > E && t < 1 - E && fx * fx + fy * fy < 1e-10) ts.push(t); }
        }
        ts.sort((u, v) => u - v);
        for (let k = 0; k + 1 < ts.length; k++) {
          const t0 = ts[k], t1 = ts[k + 1]; if (t1 - t0 < E) continue;
          const mx = p.x + (t0 + t1) / 2 * dx, my = p.y + (t0 + t1) / 2 * dy, on = onEdge(Q, mx, my);
          if (on ? !(first && on.dx * dx + on.dy * dy > 0) : !inside(Q, mx, my)) continue;
          const x0 = p.x + t0 * dx, y0 = p.y + t0 * dy, x1 = p.x + t1 * dx, y1 = p.y + t1 * dy; s += x0 * y1 - x1 * y0;
        }
      }
      return s;
    };
    return Math.max(0, (pass(a, b, true) + pass(b, a, false)) / 2);
  }
  // 參考宗地（各塊、扣地中地）與作業圖宗地的精確交集：回傳 { inside: 落在作業圖宗地內的比例, cover: [{p, area}] 依面積排序 }
  function coverOf(g, cur, cand) {
    const hits = new Map(); let total = 0, inside = 0;
    const xy = p => p.ids.map(id => cur.points.get(id));
    for (const pc of g.pieces) {
      total += pc.area;
      for (const p of cand(pc.ring)) {
        let a = intersectArea(pc.ring, xy(p));
        if (a <= 0) continue;
        for (const hi of p.holes || []) a -= intersectArea(pc.ring, xy(cur.parcels[hi]));   // 作業圖的地中地另算在內圈宗地
        for (const h of pc.holes) { let ah = intersectArea(h, xy(p)); for (const hi of p.holes || []) ah -= intersectArea(h, xy(cur.parcels[hi])); a -= ah; }   // 參考宗地的地中地不算
        if (a > 1e-6) { inside += a; hits.set(p, (hits.get(p) || 0) + a); }
      }
    }
    return { inside: total ? Math.min(1, inside / total) : 0, cover: [...hits].map(([p, area]) => ({ p, area })).sort((u, v) => v.area - u.area) };
  }
  // 作業圖宗地的外框索引：回傳 ring → 外框重疊的宗地
  function parcelBoxIndex(ds, cell = 100) {
    const grid = new Map(), box = new Map();
    for (const p of ds.parcels) { if (p.deleted || p.ids.length < 3) continue; const b = ringBox(p, ds.points); box.set(p, b);
      for (let gx = Math.floor(b.x0 / cell); gx <= Math.floor(b.x1 / cell); gx++) for (let gy = Math.floor(b.y0 / cell); gy <= Math.floor(b.y1 / cell); gy++) { const k = gx + ',' + gy; (grid.get(k) || grid.set(k, []).get(k)).push(p); } }
    return ring => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const q of ring) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
      const out = new Set();
      for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) for (const p of grid.get(gx + ',' + gy) || []) { const b = box.get(p); if (b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1) out.add(p); }
      return out; };
  }
  // 作業圖宗地依地號分組：'m-c' → [宗地]
  function curByLabel(cur) { const curBy = new Map(); for (const p of cur.parcels) { if (p.deleted || p.ids.length < 3) continue; const no = parcelNo(p); if (no) { const k = noLabel(no.m, no.c); (curBy.get(k) || curBy.set(k, []).get(k)).push(p); } } return curBy; }
  // 接圖前圖資 → 作業圖的坐標轉換：同地號（非未登記地）形心，各組一起擬合（各組應同一坐標系統）。擬合不可靠就回傳 null（不轉換）
  function baselineFit(cur, sets, merge = true, curBy = curByLabel(cur)) {
    const src = [], dst = [];
    for (const set of sets) for (const g of baselineGroups(set, null, merge).values()) { if (g.m >= UNREG_MIN || !curBy.has(g.key)) continue; const ps = curBy.get(g.key);
      let sx = 0, sy = 0, sa = 0; for (const pc of g.pieces) { const c = ringCentroidXY(pc.ring); sx += c.x * pc.area; sy += c.y * pc.area; sa += pc.area; }
      let tx = 0, ty = 0, ta = 0; for (const p of ps) { const c = polyCentroid(p.ids, cur.points); tx += c.x * p.area; ty += c.y * p.area; ta += p.area; }
      if (sa > 0 && ta > 0) { src.push({ x: sx / sa, y: sy / sa }); dst.push({ x: tx / ta, y: ty / ta }); } }
    const fit = fitAffine(src, dst);
    return fit && !(fit.median > 5 || fit.used < Math.min(10, src.length * 0.5)) ? fit : null;
  }
  // cur：作業圖（接完圖、刪完點、補完未登記地）。refs：接圖前圖資，每個元素是一組（一個資料集，或幾個資料集組成的陣列，例如 18 個單幅資料夾）。
  // 遺漏看所有組的聯集；面積原因取「該地號塊數最少」的那一組（例如同時載入切過版本與整幅時，以整幅的完整宗地判斷）。
  function compareBaseline(cur, refs, opt = {}) {
    const a = opt.a ?? AREA_TOL.a, b = opt.b ?? AREA_TOL.b, ratio = opt.ratio ?? 5, minIn = opt.minInside ?? 0.5, minTouch = opt.minTouch ?? 0.02, merge = opt.merge !== false;
    const sets = refs.map(r => (Array.isArray(r) ? r : [r])).filter(r => r.length), isU = no => no.m >= UNREG_MIN;
    const curBy = curByLabel(cur);
    // 1. 坐標轉換
    const fit = opt.identity ? null : baselineFit(cur, sets, merge, curBy);
    // 各組分組後合併：同一地號取塊數最少的那組（相同時取先載入的）
    const groups = new Map();
    for (const set of sets) for (const [k, g] of baselineGroups(set, fit ? fit.apply : null, merge)) { const o = groups.get(k); if (!o || g.pieces.length < o.pieces.length) groups.set(k, g); }
    const cand = parcelBoxIndex(cur);
    const brief = (cover, whole = 0) => cover.filter((h, i) => !i || h.area >= Math.max(1, whole * 0.01)).slice(0, 5).map(h => ({ label: h.p.label, idx: h.p.idx, area: h.area }));   // 不列 1 m²／1% 以下的邊緣碎片
    const missing = [], partial = [], outside = [], unreg = [], occupied = [], extra = [], area = [];
    // 2. 遺漏：參考有、作業圖沒有的地號
    for (const g of groups.values()) {
      if (curBy.has(g.key)) continue;
      if (!g.m) continue;   // 地號 0＝空殘列
      const sc = coverOf(g, cur, cand), item = { label: g.key, reg: g.reg, area: g.area, inside: sc.inside, cover: brief(sc.cover, g.area), pieces: g.pieces.length, rings: g.pieces.map(pc => pc.ring) };
      if (isU(g)) { if (sc.inside >= minTouch) unreg.push(item); continue; }   // 未登記地：作業圖通常另編 9000 號，不算遺漏
      (sc.inside >= minIn ? missing : sc.inside >= minTouch ? partial : outside).push(item);
    }
    // 3. 參考圖資的登記地被作業圖的未登記地（9000 號以上）佔用，超過該宗公差才列
    for (const g of groups.values()) {
      if (isU(g) || !curBy.has(g.key)) continue;
      const sc = coverOf(g, cur, cand), occ = sc.cover.filter(h => mainNo(h.p) >= UNREG_MIN), s = occ.reduce((t, h) => t + h.area, 0), F = g.reg || g.area, t = areaTol(F, a, b);
      if (s > Math.max(t, 5)) occupied.push({ label: g.key, idx: curBy.get(g.key)[0].idx, idxs: curBy.get(g.key).map(p => p.idx), reg: F, occ: s, tol: t, cover: brief(occ), rings: g.pieces.map(pc => pc.ring) });
    }
    occupied.sort((u, v) => v.occ / v.tol - u.occ / u.tol);
    // 4. 作業圖有、參考圖資沒有（非未登記地）
    for (const [k, ps] of curBy) { const no = parcelNo(ps[0]); if (no.m && !groups.has(k) && !isU(no)) extra.push({ label: k, idx: ps[0].idx }); }
    // 5. 面積較差：作業圖面積 − 登記面積，與公差比較；參考圖資的面積（分幅併回）判斷是接圖前就不符，還是接圖後才產生
    for (const [k, ps] of curBy) {
      const no = parcelNo(ps[0]); if (!no.m || isU(no)) continue;
      const reg = ps.find(p => p.areaReg > 0); if (!reg) continue;
      const F = reg.areaReg, A = ps.reduce((t, p) => t + p.area, 0), t = areaTol(F, a, b), r = Math.abs(A - F) / t, g = groups.get(k);
      // 跨分幅（參考圖資裡有好幾塊）：各分幅還沒接合，塊與塊之間常有縫或重疊，面積相加不可靠，不據以判斷原因
      const refArea = g ? g.area : null, refRatio = g ? Math.abs(g.area - F) / t : null, split = g ? g.pieces.length > 1 : false;
      const flag = r > ratio, cause = !flag ? '' : !g ? '接圖前無此宗' : split ? '跨分幅，請人工判斷' : refRatio > ratio && (g.area - F) * (A - F) > 0 ? '接圖前即不符' : '接圖後產生';
      area.push({ label: k, idx: ps[0].idx, idxs: ps.map(p => p.idx), reg: F, area: A, diff: A - F, tol: t, ratio: r, refArea, refRatio, pieces: g ? g.pieces.length : 0, flag, cause, rings: flag && g ? g.pieces.map(pc => pc.ring) : [] });
    }
    area.sort((u, v) => v.ratio - u.ratio);
    const byNo = (u, v) => u.label.localeCompare(v.label, 'en', { numeric: true });
    [missing, partial, unreg, extra].forEach(l => l.sort(byNo));
    return { opt: { a, b, ratio, minInside: minIn }, fit: fit ? { X: fit.X, Y: fit.Y, used: fit.used, total: fit.total, median: fit.median, max: fit.max } : null,
      refParcels: sets.flat().reduce((t, d) => t + d.parcels.filter(p => !p.deleted).length, 0), refSets: sets.length, refGroups: groups.size, curParcels: [...curBy.values()].reduce((t, l) => t + l.length, 0),
      missing, partial, outside: outside.length, unreg, occupied, extra, area, flagged: area.filter(r => r.flag) };
  }
  // ── 遺漏地號復原（v0.21.0）：依接圖前界址（已轉到作業圖坐標的 rings）從蓋住它的未登記地切出，建回原地號 ──
  // 平面圖做法（同 seamGaps）：候選宗地的界址線＋接圖前界址線；接圖前的界址點離既有界址點 ≤ snap 就用既有點，離界址線 ≤ snap 就投影到線上成新點，
  // 接圖前界址線經過既有點（≤ onLine）就從該點過，與界址線相交處新增點（新點插入所有含該線的宗地環，鄰宗面積不變）。
  // 追蹤每個面、判斷屬於哪一宗（原本的環）與是否在接圖前界址內：在界址內且屬未登記地（9000 號以上）的面合成新宗地；
  // 在界址內但屬登記地的面超過 max(1 m², 1%) 就停下不做（只從未登記地切）。未登記地剩下的部分保留原地號，被切成幾塊時其餘編新子號，整宗被切走就標為已刪除；
  // 接圖前界址整個在某宗未登記地內部時，新宗地設為它的地中地。回傳 {delta, label, from:[{label, area}], pieces:[新子號], deleted:[], added:[點號]}
  function restoreMissing(ds, item, opt = {}) {
    const snap = opt.snap ?? 0.5, onLine = opt.onLine ?? 0.3, P = ds.points, E = 1e-9, no = /^(\d+)(?:-(\d+))?$/.exec(String(item.label));
    if (!no) throw new Error('地號格式不正確：' + item.label);
    const M = +no[1], C = +(no[2] || 0);
    if (ds.parcels.some(p => !p.deleted && parcelNo(p) && parcelNo(p).m === M && parcelNo(p).c === C)) throw new Error(`${item.label} 已存在`);
    const rings = (item.rings || []).filter(r => r.length >= 3); if (!rings.length) throw new Error('沒有接圖前界址');
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity; for (const r of rings) for (const q of r) { bx0 = Math.min(bx0, q.x); bx1 = Math.max(bx1, q.x); by0 = Math.min(by0, q.y); by1 = Math.max(by1, q.y); }
    const cand = ds.parcels.filter(p => { if (p.deleted || p.ids.length < 3) return false; const b = ringBox(p, P); return b.x1 >= bx0 - snap && b.x0 <= bx1 + snap && b.y1 >= by0 - snap && b.y0 <= by1 + snap; });
    // 節點與線段
    const nodes = [], byId = new Map(), node = id => { let n = byId.get(id); if (!n) { const q = P.get(id); n = { k: nodes.length, id, x: q.x, y: q.y }; nodes.push(n); byId.set(id, n); } return n; };
    const free = (x, y) => { const n = { k: nodes.length, id: null, x, y }; nodes.push(n); return n; };
    const segs = [], segOf = new Map(), arcs = arcEdgeSet(ds);
    for (const p of cand) for (let i = 0; i < p.ids.length; i++) { const a = p.ids[i], b = p.ids[(i + 1) % p.ids.length]; if (a === b) continue; const k = segKey(a, b); if (segOf.has(k)) continue;
      const sg = { a: node(a), b: node(b), R: false, on: [], key: k, arc: arcs.has(k) }; segOf.set(k, sg); segs.push(sg); }
    const cSegs = segs.slice();
    const projT = (n, A, B) => { const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy; if (!l2) return null; const t = ((n.x - A.x) * dx + (n.y - A.y) * dy) / l2; return { t, d: Math.hypot(A.x + t * dx - n.x, A.y + t * dy - n.y) }; };
    const rRings = rings.map(r => {
      let ids = r.map(q => {   // 接圖前界址點 → 既有點／線上新點／自由新點
        let best = null; for (const n of nodes) { if (n.id == null) continue; const dd = Math.hypot(n.x - q.x, n.y - q.y); if (dd <= snap && (!best || dd < best.d)) best = { n, d: dd }; }
        if (best) return best.n;
        let bs = null; for (const sg of cSegs) { const r2 = projT(q, sg.a, sg.b); if (r2 && r2.t > 1e-6 && r2.t < 1 - 1e-6 && r2.d <= snap && (!bs || r2.d < bs.d)) bs = { sg, ...r2 }; }
        if (bs) { if (bs.sg.arc) throw new Error(`接圖前界址點落在圓弧 ${bs.sg.key} 上，暫不支援`); const n = free(bs.sg.a.x + bs.t * (bs.sg.b.x - bs.sg.a.x), bs.sg.a.y + bs.t * (bs.sg.b.y - bs.sg.a.y)); bs.sg.on.push(n); return n; }
        return free(q.x, q.y);
      });
      ids = ids.filter((n, i) => n !== ids[(i + 1) % ids.length]); return ids;
    }).filter(r => r.length >= 3);
    const rSegs = [];
    for (const r of rRings) for (let i = 0; i < r.length; i++) { const sg = { a: r[i], b: r[(i + 1) % r.length], R: true, on: [] }; rSegs.push(sg); segs.push(sg); }
    // 接圖前界址線經過既有點；與界址線相交
    for (const sg of rSegs) {
      for (const n of nodes) { if (n === sg.a || n === sg.b) continue; const r2 = projT(n, sg.a, sg.b); if (r2 && r2.t > 1e-6 && r2.t < 1 - 1e-6 && r2.d <= (n.id != null ? onLine : 1e-6)) sg.on.push(n); }
      for (const cs of cSegs) {
        const A = sg.a, B = sg.b, Cc = cs.a, D = cs.b; if (A === Cc || A === D || B === Cc || B === D) continue;
        if (sg.on.includes(Cc) || sg.on.includes(D) || cs.on.includes(A) || cs.on.includes(B)) continue;
        const rx = B.x - A.x, ry = B.y - A.y, sx = D.x - Cc.x, sy = D.y - Cc.y, den = rx * sy - ry * sx; if (Math.abs(den) < 1e-12) continue;
        const t = ((Cc.x - A.x) * sy - (Cc.y - A.y) * sx) / den, u = ((Cc.x - A.x) * ry - (Cc.y - A.y) * rx) / den; if (t <= E || t >= 1 - E || u <= E || u >= 1 - E) continue;
        const x = A.x + t * rx, y = A.y + t * ry, L = Math.hypot(sx, sy);
        if (u * L < 0.01) { sg.on.push(Cc); continue; } if ((1 - u) * L < 0.01) { sg.on.push(D); continue; }
        if (cs.arc) throw new Error(`接圖前界址與圓弧 ${cs.key} 相交，暫不支援`);
        const n = free(x, y); sg.on.push(n); cs.on.push(n);
      }
    }
    // 切開線段、建圖
    const adj = new Map(), link = (a, b, R) => { if (a === b) return; for (const [x, y] of [[a, b], [b, a]]) { let l = adj.get(x); if (!l) adj.set(x, l = new Map()); l.set(y, (l.get(y) || false) || R); } };
    const splitOrder = new Map();
    for (const sg of segs) {
      const on = [...new Set(sg.on)].map(n => ({ n, t: projT(n, sg.a, sg.b).t })).sort((u, v) => u.t - v.t);
      if (!sg.R && on.length) splitOrder.set(sg.key, { a: sg.a, list: on.map(o => o.n) });
      let prev = sg.a; for (const o of on) { link(prev, o.n, sg.R); prev = o.n; } link(prev, sg.b, sg.R);
    }
    for (let changed = true; changed;) { changed = false; for (const [v, l] of adj) if (l.size < 2) { for (const w of l.keys()) adj.get(w).delete(v); adj.delete(v); changed = true; } }
    // 接圖前界址整圈都不碰既有界址線：整個落在某一宗內部 → 建為它的地中地
    const cNodes = new Set(); for (const sg of cSegs) { cNodes.add(sg.a); cNodes.add(sg.b); for (const n of sg.on) cNodes.add(n); }
    const touches = r => { const seen = new Set(r), st = [...r]; while (st.length) { const v = st.pop(); if (cNodes.has(v)) return true; for (const w of (adj.get(v) || new Map()).keys()) if (!seen.has(w)) { seen.add(w); st.push(w); } } return false; };
    if (rRings.some(r => !touches(r))) {
      if (rRings.length !== 1) throw new Error(`${item.label} 有好幾塊、且有塊不接既有界址線，請人工處理`);
      const r = rRings[0], tmp = new Map(r.map((n, i) => [i, n])), ip = interiorPoint(r.map((_, i) => i), tmp), inR = (x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
      let U = null; for (const p of cand) if (pointInRing(p.ids, P, ip.y, ip.x) && (!U || ringArea(p.ids, P) < ringArea(U.ids, P))) U = p;
      if (!U) throw new Error(`${item.label} 的位置不在任何宗地內`); if (mainNo(U) < UNREG_MIN) throw new Error(`${item.label} 的位置是登記地 ${U.label}，只從未登記地切，請先人工處理`);
      if (cand.some(p => p !== U && p.ids.some(id => { const q = P.get(id); return inR(q.x, q.y); }))) throw new Error(`${item.label} 的範圍內有其他宗地，請人工處理`);
      const d = newDelta(); for (const n of r) { const id = nextPointId(ds), np = { id, y: n.y, x: n.x, y0: n.y, x0: n.x, row: null, added: true }; ds.points.set(id, np); d.added.push(np); n.id = id; }
      const like = ds.parcels.find(p => !p.deleted && p.attrRow != null && mainNo(p) === M) || ds.parcels.find(p => !p.deleted && p.attrRow != null && mainNo(p) < UNREG_MIN && mainNo(p) > 0) || null;
      const np = createParcel(ds, d, M, ccwIds(r.map(n => n.id), P), like, { sub: C, areaReg: item.reg || 0 }); np.restored = true;
      touchParcel(d, U); U.unregEdit = true; linkHole(ds, U.idx, np.idx, true); d.holes = [{ p: U.idx, h: np.idx, on: true }]; closeDelta(ds, d);
      return { delta: d, label: np.label, idx: np.idx, area: np.area, from: [{ label: U.label, area: np.area }], pieces: [], deleted: [], added: d.added.map(q => q.id), removedPoints: [], hole: true };
    }
    const order = new Map(); for (const [v, l] of adj) order.set(v, [...l.keys()].sort((p, q) => Math.atan2(p.y - v.y, p.x - v.x) - Math.atan2(q.y - v.y, q.x - v.x)));
    const nextCw = (u, v, ok) => { const ord = order.get(v), i = ord.indexOf(u); for (let k = 1; k <= ord.length; k++) { const w = ord[(i - k + ord.length) % ord.length]; if (!ok || ok(v, w)) return w; } return null; };
    // 追蹤面（面在左側；有界面為逆時針）
    const used = new Set(), hk = (u, v) => u.k + '>' + v.k, faces = [];
    for (const [u0, l] of adj) for (const v0 of l.keys()) {
      if (used.has(hk(u0, v0))) continue; const ring = [u0]; let u = u0, v = v0;
      for (let g = 0; g < 200000; g++) { used.add(hk(u, v)); if (v === u0) break; ring.push(v); const w = nextCw(u, v); u = v; v = w; }
      let A2 = 0; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; A2 += (a.x - ring[0].x) * (b.y - ring[0].y) - (b.x - ring[0].x) * (a.y - ring[0].y); }
      if (ring.length >= 3 && A2 > 1e-9) faces.push({ ring, area: A2 / 2 });
    }
    const rCoords = rRings.map(r => r.map(n => ({ x: n.x, y: n.y })));
    const inPolyXY = (arr, x, y) => { let c = false; for (let i = 0, j = arr.length - 1; i < arr.length; j = i++) { const a = arr[i], b = arr[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
    const boxA = new Map(cand.map(p => [p, ringArea(p.ids, P)]));
    for (const f of faces) {
      const tmp = new Map(f.ring.map((n, i) => [i, n])), ip = interiorPoint(f.ring.map((_, i) => i), tmp);
      f.inR = rCoords.some(r => inPolyXY(r, ip.x, ip.y)); let own = null;
      for (const p of cand) if (pointInRing(p.ids, P, ip.y, ip.x) && (!own || boxA.get(p) < boxA.get(own))) own = p;
      f.owner = own;
    }
    const take = faces.filter(f => f.inR && f.owner && mainNo(f.owner) >= UNREG_MIN), regIn = faces.filter(f => f.inR && f.owner && mainNo(f.owner) < UNREG_MIN);
    const total = take.reduce((t, f) => t + f.area, 0), regA = regIn.reduce((t, f) => t + f.area, 0);
    if (!take.length) throw new Error(`${item.label} 的位置沒有未登記地可切`);
    if (regA > Math.max(1, 0.01 * (total + regA))) { const by = new Map(); for (const f of regIn) by.set(f.owner.label, (by.get(f.owner.label) || 0) + f.area); throw new Error(`${item.label} 的位置有 ${regA.toFixed(1)} m² 是登記地（${[...by].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, a]) => `${l} ${a.toFixed(1)} m²`).join('、')}），只從未登記地切，請先人工處理`); }
    for (const f of take) if (f.owner.mid && f.owner.mid.some(Boolean)) throw new Error(`${f.owner.label} 含圓弧，暫不支援`);
    // 細碎面（< 0.5 m²、在界址外、屬同一宗未登記地、與新宗地相鄰）併入新宗地，避免剩下零碎小塊
    const takeSet = new Set(take), edgeOf = new Map(); for (const f of faces) for (let i = 0; i < f.ring.length; i++) edgeOf.set(hk(f.ring[i], f.ring[(i + 1) % f.ring.length]), f);
    const takeOwners = new Set(take.map(f => f.owner));
    for (let changed = true; changed;) { changed = false;
      for (const f of faces) { if (takeSet.has(f) || f.inR || f.area >= 0.5 || !takeOwners.has(f.owner)) continue;
        if (f.ring.some((n, i) => takeSet.has(edgeOf.get(hk(f.ring[(i + 1) % f.ring.length], n))))) { takeSet.add(f); changed = true; } } }
    // 面集合的邊界環
    const loopsOf = set => {
      const out = new Map(); for (const f of set) for (let i = 0; i < f.ring.length; i++) { const a = f.ring[i], b = f.ring[(i + 1) % f.ring.length]; out.set(hk(a, b), [a, b]); }
      for (const k of [...out.keys()]) { if (!out.has(k)) continue; const [a, b] = out.get(k); if (out.has(hk(b, a))) { out.delete(k); out.delete(hk(b, a)); } }
      const from = new Map(); for (const [a, b] of out.values()) (from.get(a) || from.set(a, []).get(a)).push(b);
      const loops = [], done = new Set();
      for (const [a0, b0] of out.values()) { if (done.has(hk(a0, b0))) continue; const ring = [a0]; let u = a0, v = b0;
        for (let g = 0; g < 200000; g++) { done.add(hk(u, v)); if (v === a0) break; ring.push(v); const outs = (from.get(v) || []).filter(w => !done.has(hk(v, w))); const w = outs.length === 1 ? outs[0] : nextCw(u, v, (x, y) => outs.includes(y)); if (!w) break; u = v; v = w; }
        let A2 = 0; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; A2 += (a.x - ring[0].x) * (b.y - ring[0].y) - (b.x - ring[0].x) * (a.y - ring[0].y); }
        loops.push({ ring, area: A2 / 2 }); }
      return loops;
    };
    const newLoops = loopsOf(takeSet);
    if (newLoops.filter(l => l.area > 0).length !== 1) throw new Error(`${item.label} 切出後不是一整塊（${newLoops.filter(l => l.area > 0).length} 塊），請人工處理`);
    if (newLoops.some(l => l.area < 0)) throw new Error(`${item.label} 的範圍內有其他宗地，請人工處理`);
    // 寫入：新點編號、鄰宗插入新點（中途出錯就全部還原）
    const d = newDelta(), owners = [...new Set([...takeSet].map(f => f.owner))];
    let res;
    try {
    for (const n of nodes) if (n.id == null && adj.has(n)) { const id = nextPointId(ds), np = { id, y: n.y, x: n.x, y0: n.y, x0: n.x, row: null, added: true }; ds.points.set(id, np); d.added.push(np); n.id = id; }
    for (const p of cand) { if (owners.includes(p)) continue; const out = [];
      for (let i = 0; i < p.ids.length; i++) { const a = p.ids[i], b = p.ids[(i + 1) % p.ids.length]; out.push(a); const so = splitOrder.get(segKey(a, b)); if (!so) continue; const l = so.list.map(n => n.id); out.push(...(so.a.id === a ? l : l.slice().reverse())); }
      if (out.length !== p.ids.length) { if (p.mid && p.mid.some(Boolean)) throw new Error(`${p.label} 含圓弧，暫不支援`); touchParcel(d, p); p.ids = out; p.mid = out.map(() => false); } }
    const ids = l => l.ring.map(n => n.id);
    const like = ds.parcels.find(p => !p.deleted && p.attrRow != null && mainNo(p) === M) || ds.parcels.find(p => !p.deleted && p.attrRow != null && mainNo(p) < UNREG_MIN && mainNo(p) > 0) || null;
    const np = createParcel(ds, d, M, ids(newLoops.find(l => l.area > 0)), like, { sub: C, areaReg: item.reg || 0 }); np.restored = true;
    const from = [], pieces = [], deleted = []; d.holes = [];
    for (const U of owners) {
      const rest = faces.filter(f => f.owner === U && !takeSet.has(f)), loops = loopsOf(rest), outer = loops.filter(l => l.area > 0).sort((a, b) => b.area - a.area);
      from.push({ label: U.label, area: [...takeSet].filter(f => f.owner === U).reduce((t, f) => t + f.area, 0) });
      touchParcel(d, U); U.unregEdit = true;
      if (!outer.length) { if ((U.holes || []).length) throw new Error(`${U.label} 整宗被切走但還有地中地，請人工處理`); U.ids = []; U.mid = []; U.deleted = true; (d.deleted = d.deleted || []).push(U.idx); deleted.push(U.label); continue; }
      U.ids = ids(outer[0]); U.mid = U.ids.map(() => false);
      for (const o of outer.slice(1)) pieces.push(createParcel(ds, d, mainNo(U), ids(o), U).label);
      const nk = new Set(np.ids); if (loops.some(l => l.area < 0 && l.ring.length === np.ids.length && l.ring.every(n => nk.has(n.id)))) { linkHole(ds, U.idx, np.idx, true); d.holes.push({ p: U.idx, h: np.idx, on: true }); }
    }
    // 不再有宗地使用的點（原本只屬於被切的未登記地、現在落在新宗地內部）
    const usedNow = new Set(); for (const p of ds.parcels) if (!p.deleted) for (const id of p.ids) usedNow.add(id);
    const dropped = []; for (const U of owners) for (const id of d.parcels.get(U.idx).ids0) if (!usedNow.has(id) && ds.points.has(id)) { d.removed.push(ds.points.get(id)); ds.points.delete(id); dropped.push(id); }
    closeDelta(ds, d);
    res = { np, from, pieces, deleted, dropped };
    } catch (e) { closeDelta(ds, d); applyDelta(ds, d, 'undo'); throw e; }
    const { np, from, pieces, deleted, dropped } = res;
    return { delta: d, label: np.label, idx: np.idx, area: np.area, from, pieces, deleted, added: d.added.map(q => q.id), removedPoints: dropped, hole: d.holes.length > 0 };
  }
  const ringCentroidXY = arr => { const o = arr[0]; let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < arr.length; i++) { const p = arr[i], q = arr[(i + 1) % arr.length], px = p.x - o.x, py = p.y - o.y, qx = q.x - o.x, qy = q.y - o.y, c = px * qy - qx * py; A += c; cx += (px + qx) * c; cy += (py + qy) * c; }
    return A ? { x: o.x + cx / (3 * A), y: o.y + cy / (3 * A) } : { x: o.x, y: o.y }; };
  // ── 舊圖檢核（v0.23.0）：作業圖的每條界址線對照「分幅舊圖向量」與「舊圖掃描影像」──────────
  // 共同的取樣：作業圖每條界址線（圓弧以弦代）每 step m 取一點；兩側都是未登記地（9000 號以上）的線是分割時新畫的，舊圖本來就沒有，不檢查。
  function checkSegments(cur, step = 1) {
    const own = new Map();
    for (const p of cur.parcels) { if (p.deleted || p.ids.length < 3) continue;
      for (let i = 0; i < p.ids.length; i++) { const a = p.ids[i], b = p.ids[(i + 1) % p.ids.length]; if (a === b) continue; const k = segKey(a, b); let e = own.get(k); if (!e) own.set(k, e = { key: k, a, b, ps: [] }); if (!e.ps.includes(p.idx)) e.ps.push(p.idx); } }
    const segs = [];
    for (const e of own.values()) {
      const A = cur.points.get(e.a), B = cur.points.get(e.b), len = Math.hypot(B.x - A.x, B.y - A.y); if (!len) continue;
      const skip = e.ps.length === 2 && e.ps.every(i => mainNo(cur.parcels[i]) >= UNREG_MIN), n = Math.max(1, Math.round(len / step)), smp = [];
      for (let j = 0; j < n; j++) { const t = (j + 0.5) / n; smp.push({ x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y), t }); }
      segs.push({ key: e.key, a: e.a, b: e.b, A: { x: A.x, y: A.y }, B: { x: B.x, y: B.y }, len, ps: e.ps, skip, smp, w: len / n });
    }
    return segs;
  }
  // 線段格網索引：q(x, y, r) → 外框與該點 r 範圍重疊的線段
  function segGrid(list, cell = 25) {
    const g = new Map(), key = (i, j) => i + ',' + j;
    for (const s of list) { for (let i = Math.floor(Math.min(s.A.x, s.B.x) / cell); i <= Math.floor(Math.max(s.A.x, s.B.x) / cell); i++) for (let j = Math.floor(Math.min(s.A.y, s.B.y) / cell); j <= Math.floor(Math.max(s.A.y, s.B.y) / cell); j++) { const k = key(i, j); (g.get(k) || g.set(k, []).get(k)).push(s); } }
    return (x, y, r) => { const out = new Set(); for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++) for (let j = Math.floor((y - r) / cell); j <= Math.floor((y + r) / cell); j++) for (const s of g.get(key(i, j)) || []) out.add(s); return out; };
  }
  const nearestOn = (x, y, cands) => { let best = null; for (const s of cands) { const dx = s.B.x - s.A.x, dy = s.B.y - s.A.y, l2 = dx * dx + dy * dy; let t = l2 ? ((x - s.A.x) * dx + (y - s.A.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); const px = s.A.x + t * dx, py = s.A.y + t * dy, d = Math.hypot(px - x, py - y); if (!best || d < best.d) best = { d, x: px, y: py, s }; } return best; };
  // 連續的「不符」取樣併成線段（圖上標示用）：runs([{x,y,bad}]) → [[{x,y},{x,y}]]
  function badRuns(seg, flags, dx = 0, dy = 0) {
    const out = []; let st = -1; const at = t => ({ x: seg.A.x + t * (seg.B.x - seg.A.x) + dx, y: seg.A.y + t * (seg.B.y - seg.A.y) + dy }), n = flags.length;
    for (let j = 0; j <= n; j++) { if (j < n && flags[j]) { if (st < 0) st = j; } else if (st >= 0) { out.push([at(st / n), at(j / n)]); st = -1; } }
    return out;
  }
  // 宗地所在（點 → 包含它的最小宗地，地中地優先）
  function parcelLocator(cur) {
    const idx = parcelBoxIndex(cur, 50);
    return (x, y) => { let best = null; for (const p of idx([{ x, y }])) if (pointInRing(p.ids, cur.points, y, x) && (!best || p.area < best.area)) best = p; return best; };
  }
  // 嚴重度：不符長度對門檻的倍數；≥1 列出、≥2 紅色
  const SHAPE_DEFAULT = { tol: 1.0, search: 6, maxShift: 5, step: 1, innerTol: 2.5, minLen: 3, ratio: 0.15, sliver: 30 };
  // 分幅舊圖向量比對：refs 同 compareBaseline（每組一個或多個資料集）。舊圖坐標以同地號形心擬合轉到作業圖（TWD67 也可）；
  // 分幅切開的同一地號（子號 +1000k 併回後相同）之間的切線不是界址，不當成舊圖界線。
  // 每宗先做局部平移（ICP，只平移、上限 maxShift）讓界址線最貼近舊圖界線，再量：
  //   off＝離舊圖界線超過 tol 的界址線長度（作業圖有、舊圖沒有：多畫或形狀跑掉）
  //   inner＝舊圖界線穿過宗地內部（離作業圖界址線超過 innerTol）的長度（舊圖有、作業圖沒有：少分、併錯）
  function shapeCheck(cur, refs, opt = {}) {
    const o = { ...SHAPE_DEFAULT, ...opt }, sets = refs.map(r => (Array.isArray(r) ? r : [r])).filter(r => r.length);
    if (!sets.length) throw new Error('沒有分幅舊圖向量');
    const fit = o.identity ? null : (o.fit || baselineFit(cur, sets, o.merge !== false));
    const T = fit ? fit.apply : (x, y) => ({ x, y });
    // 舊圖界線（去重、去分幅切線）
    const refSegs = [], seen = new Set(), rk = q => Math.round(q.x * 100) + ',' + Math.round(q.y * 100);
    for (const set of sets) {
      const groups = baselineGroups(set, T, o.merge !== false);
      for (const g of groups.values()) for (const pc of g.pieces) {
        const others = g.pieces.filter(q => q !== pc);
        for (let i = 0; i < pc.ring.length; i++) {
          const A = pc.ring[i], B = pc.ring[(i + 1) % pc.ring.length], len = Math.hypot(B.x - A.x, B.y - A.y); if (len < 1e-6) continue;
          const k = [rk(A), rk(B)].sort().join('|'); if (seen.has(k)) continue;
          if (others.length) { const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, nx = -(B.y - A.y) / len * 0.3, ny = (B.x - A.x) / len * 0.3, inP = (r, x, y) => { let c = false; for (let a = 0, b = r.length - 1; a < r.length; b = a++) { const p = r[a], q = r[b]; if ((p.y > y) !== (q.y > y) && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) c = !c; } return c; };
            if (others.some(q => inP(q.ring, mx + nx, my + ny) || inP(q.ring, mx - nx, my - ny))) continue; }   // 另一側是同地號的另一塊＝分幅切線
          seen.add(k); refSegs.push({ A, B, len, label: g.key });
        }
      }
    }
    const refQ = segGrid(refSegs), segs = checkSegments(cur, o.step), curQ = segGrid(segs);
    const res = new Map(), get = i => { let r = res.get(i); if (!r) { const p = cur.parcels[i]; res.set(i, r = { idx: i, label: p.label, area: p.area, perimeter: 0, checked: 0, offLen: 0, innerLen: 0, maxDev: 0, shift: { dx: 0, dy: 0 }, offSegs: [], innerSegs: [], offEdges: [] }); } return r; };
    // 1. 每宗局部平移
    const bySeg = new Map(); for (const s of segs) for (const i of s.ps) { (bySeg.get(i) || bySeg.set(i, []).get(i)).push(s); get(i).perimeter += s.len; }
    for (const [i, list] of bySeg) {
      const smp = []; for (const s of list) if (!s.skip) for (const q of s.smp) smp.push({ x: q.x, y: q.y, w: s.w });
      const r = get(i); if (!smp.length) continue; let tx = 0, ty = 0;
      for (let it = 0; it < 6; it++) {
        const ds = []; for (const q of smp) { const x = q.x + tx, y = q.y + ty, nb = nearestOn(x, y, refQ(x, y, o.search)); if (nb && nb.d < o.search) ds.push({ dx: nb.x - x, dy: nb.y - y, d: nb.d, w: q.w }); }
        if (ds.length < 3) break; const md = median(ds.map(d => d.d)), lim = Math.max(3 * md, o.tol); let sw = 0, sx = 0, sy = 0;
        for (const d of ds) if (d.d <= lim) { sx += d.dx * d.w; sy += d.dy * d.w; sw += d.w; }
        if (!sw) break; tx += sx / sw; ty += sy / sw; const m = Math.hypot(tx, ty); if (m > o.maxShift) { tx *= o.maxShift / m; ty *= o.maxShift / m; }
        if (Math.hypot(sx / sw, sy / sw) < 0.01) break;
      }
      r.shift = { dx: tx, dy: ty };
    }
    // 2. 界址線離舊圖界線的距離（各宗用自己的平移）
    for (const s of segs) { if (s.skip) continue;
      for (const i of s.ps) { const r = get(i), { dx, dy } = r.shift, flags = s.smp.map(q => { const x = q.x + dx, y = q.y + dy, nb = nearestOn(x, y, refQ(x, y, o.search)), d = nb ? nb.d : o.search; r.maxDev = Math.max(r.maxDev, d); return d > o.tol; });
        r.checked += s.len; const bad = flags.filter(Boolean).length * s.w; if (bad) { r.offLen += bad; r.offSegs.push(...badRuns(s, flags)); if (bad >= s.len / 2) r.offEdges.push(s.key); } } }
    // 3. 舊圖界線穿過宗地內部
    const loc = parcelLocator(cur);
    for (const s of refSegs) {
      const n = Math.max(1, Math.round(s.len / o.step)), w = s.len / n; let run = null;
      const flush = () => { if (run) { const r = get(run.p.idx); r.innerLen += run.len; r.innerSegs.push([run.a, run.b]); run = null; } };
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n, x = s.A.x + t * (s.B.x - s.A.x), y = s.A.y + t * (s.B.y - s.A.y), nb = nearestOn(x, y, curQ(x, y, o.innerTol));
        const p = nb && nb.d <= o.innerTol ? null : loc(x, y);
        if (!p) { flush(); continue; }
        const a = { x: s.A.x + (j / n) * (s.B.x - s.A.x), y: s.A.y + (j / n) * (s.B.y - s.A.y) }, b = { x: s.A.x + ((j + 1) / n) * (s.B.x - s.A.x), y: s.A.y + ((j + 1) / n) * (s.B.y - s.A.y) };
        if (run && run.p === p) { run.b = b; run.len += w; } else { flush(); run = { p, a, b, len: w }; }
      }
      flush();
    }
    // 4. 判定
    const list = [];
    for (const r of res.values()) {
      const offLim = Math.max(o.minLen, o.ratio * r.checked), innerLim = 2 * o.minLen;
      r.score = Math.max(r.checked ? r.offLen / offLim : 0, r.innerLen / innerLim);
      r.level = r.score >= 2 ? 'red' : r.score >= 1 ? 'yellow' : '';
      r.sliver = r.area < o.sliver;
      if (r.level) list.push(r);
    }
    list.sort((u, v) => v.score - u.score);
    const slivers = [...res.values()].filter(r => r.sliver).sort((u, v) => u.area - v.area);
    return { opt: o, fit: fit ? { X: fit.X, Y: fit.Y, used: fit.used, total: fit.total, median: fit.median, max: fit.max } : null, refSegs: refSegs.length, parcels: res.size, flagged: list, slivers,
      counts: { red: list.filter(r => r.level === 'red').length, yellow: list.filter(r => r.level === 'yellow').length, slivers: slivers.length } };
  }

  // 影像墨線檢核：掃描舊圖上，作業圖的界址線底下應該有墨線（黑線或紅線）。
  // 影像很大（整段可達上億像素），所以分塊：以 block m 方格為單位，每塊讀一個視窗（方格外擴 block/2＋搜尋範圍）的像素，
  // 1. 墨線遮罩：亮度比周圍（半徑 bg m 的平均）暗 dark 以上，或紅色（R−G）比周圍高 red 以上；
  // 2. 距離場：每個像素到最近墨線的距離（倒角距離，像素）；
  // 3. 塊內平移：在 ±shift m 內找讓視窗內界址線最貼墨線的平移（舊圖紙張伸縮、掃描定位誤差；相鄰圖幅各自偏移，所以方格要小）；
  // 4. 方格內的界址線逐點看平移後離墨線是否 ≤ tol m，支持比例 < 0.5 的線段列為「影像上沒有墨線」。
  //    整個視窗平移後仍有一半以上的取樣找不到墨線（minFit）＝這一帶影像對不上（對位偏太多、空白、不是同一張圖），不判斷，另列「對位不良」。
  const INK_DEFAULT = { block: 50, shift: 5, shiftStep: 0.25, cap: 2, tol: 0.6, bg: 3, dark: 14, red: 22, step: 0.4, minLen: 5, ratio: 0.3, minSup: 0.5, minFit: 0.5 };   // 影像比向量雜（文字、汙點、後來的分割線），門檻較寬：無墨線 ≥ 30% 且 ≥ 5 m 才列
  function inkMask(rgba, w, h, opt = {}) {
    const o = { ...INK_DEFAULT, ...opt }, N = w * h, L = new Float32Array(N), RG = new Float32Array(N), rad = Math.max(2, Math.round(o.bgPx || 12));
    for (let i = 0; i < N; i++) { const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2]; L[i] = 0.299 * r + 0.587 * g + 0.114 * b; RG[i] = r - g; }
    const blur = src => { const W1 = w + 1, I = new Float64Array(W1 * (h + 1)); for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += src[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + s; } }
      const out = new Float32Array(N); for (let y = 0; y < h; y++) { const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1); for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1); out[y * w + x] = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((y1 - y0) * (x1 - x0)); } } return out; };
    const bL = blur(L), bR = blur(RG), m = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (rgba[4 * i + 3] > 0 && (bL[i] - L[i] > o.dark || RG[i] - bR[i] > o.red)) m[i] = 1;
    return m;
  }
  // 倒角距離（兩趟，斜向 √2），單位像素
  function distanceField(mask, w, h) {
    const N = w * h, D = new Float32Array(N), S2 = Math.SQRT2; for (let i = 0; i < N; i++) D[i] = mask[i] ? 0 : 1e9;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; let v = D[i]; if (x > 0) v = Math.min(v, D[i - 1] + 1); if (y > 0) { v = Math.min(v, D[i - w] + 1); if (x > 0) v = Math.min(v, D[i - w - 1] + S2); if (x < w - 1) v = Math.min(v, D[i - w + 1] + S2); } D[i] = v; }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { const i = y * w + x; let v = D[i]; if (x < w - 1) v = Math.min(v, D[i + 1] + 1); if (y < h - 1) { v = Math.min(v, D[i + w] + 1); if (x < w - 1) v = Math.min(v, D[i + w + 1] + S2); if (x > 0) v = Math.min(v, D[i + w - 1] + S2); } D[i] = v; }
    return D;
  }
  // 分塊計畫：回傳 { segs, blocks:[{key, x0,y0,x1,y1（方格）, wx0,wy0,wx1,wy1（要讀的視窗）}] }
  function inkPlan(cur, opt = {}) {
    const o = { ...INK_DEFAULT, ...opt }, segs = checkSegments(cur, o.step).filter(s => !s.skip), B = o.block, blocks = new Map();
    for (const s of segs) { const mx = (s.A.x + s.B.x) / 2, my = (s.A.y + s.B.y) / 2, i = Math.floor(mx / B), j = Math.floor(my / B), k = i + ',' + j; s.block = k;
      if (!blocks.has(k)) { const m = B / 2 + o.shift + o.cap + 2; blocks.set(k, { key: k, x0: i * B, y0: j * B, x1: (i + 1) * B, y1: (j + 1) * B, wx0: i * B - m, wy0: j * B - m, wx1: (i + 1) * B + m, wy1: (j + 1) * B + m, segs: [] }); }
      blocks.get(k).segs.push(s); }
    const list = [...blocks.values()];
    const q = segGrid(segs, B / 2); for (const b of list) b.win = [...q((b.wx0 + b.wx1) / 2, (b.wy0 + b.wy1) / 2, (b.wx1 - b.wx0) / 2)].filter(s => Math.max(s.A.x, s.B.x) >= b.wx0 && Math.min(s.A.x, s.B.x) <= b.wx1 && Math.max(s.A.y, s.B.y) >= b.wy0 && Math.min(s.A.y, s.B.y) <= b.wy1);
    return { opt: o, segs, blocks: list };
  }
  // 處理一塊：region＝{ rgba, w, h, wf }（視窗的像素與它的 world file）；沒有影像（region 為 null）的塊不判定
  function inkBlock(plan, b, region) {
    const o = plan.opt; if (!region) { b.none = true; return b; }
    const { rgba, w, h, wf } = region, px = Math.hypot(wf.a, wf.d), det = wf.a * wf.e - wf.b * wf.d;
    const D = distanceField(inkMask(rgba, w, h, { ...o, bgPx: o.bg / px }), w, h);
    const dist = (x, y) => { const X = x - wf.c, Y = y - wf.f, u = Math.round((wf.e * X - wf.b * Y) / det), v = Math.round((-wf.d * X + wf.a * Y) / det); return u < 0 || v < 0 || u >= w || v >= h ? null : D[v * w + u] * px; };
    let n0 = 0; const cost = (dx, dy) => { let c = 0, n = 0; for (const s of b.win) for (const q of s.smp) { const d = dist(q.x + dx, q.y + dy); if (d == null) continue; c += Math.min(d, o.cap); n++; } n0 = n; return n ? c / n : o.cap; };
    let best = { dx: 0, dy: 0, c: cost(0, 0) };
    if (n0) {   // 先 1 m 間距粗搜，再在最佳點 ±1 m 內以 shiftStep 細搜
      const scan = (cx, cy, r, st) => { for (let dx = cx - r; dx <= cx + r + 1e-9; dx += st) for (let dy = cy - r; dy <= cy + r + 1e-9; dy += st) { if (Math.abs(dx) > o.shift + 1e-9 || Math.abs(dy) > o.shift + 1e-9) continue; const c = cost(dx, dy); if (c < best.c - 1e-9) best = { dx, dy, c }; } };
      scan(0, 0, Math.ceil(o.shift), 1); const b0 = best; scan(b0.dx, b0.dy, 1, o.shiftStep);
    }
    b.shift = { dx: best.dx, dy: best.dy }; b.cost = best.c;
    let ok = 0, all = 0; for (const s of b.win) for (const q of s.smp) { const d = dist(q.x + best.dx, q.y + best.dy); if (d == null) continue; all++; if (d <= o.tol) ok++; }
    b.fit = all ? ok / all : 0; b.poor = b.fit < o.minFit;
    if (b.poor) { for (const s of b.segs) { s.flags = s.smp.map(() => null); s.sup = null; s.shift = b.shift; } return b; }
    for (const s of b.segs) { s.flags = s.smp.map(q => { const d = dist(q.x + best.dx, q.y + best.dy); return d == null ? null : d > o.tol; }); const known = s.flags.filter(f => f != null); s.sup = known.length ? known.filter(f => !f).length / known.length : null; s.shift = b.shift; }
    return b;
  }
  // 彙整各宗：無墨線長度（支持比例 < minSup 的線段）、判定等級
  function inkResult(cur, plan) {
    const o = plan.opt, res = new Map(), get = i => { let r = res.get(i); if (!r) { const p = cur.parcels[i]; res.set(i, r = { idx: i, label: p.label, area: p.area, checked: 0, offLen: 0, offSegs: [], offEdges: [], unknown: 0 }); } return r; };
    for (const s of plan.segs) for (const i of s.ps) { const r = get(i); if (s.sup == null) { r.unknown += s.len; continue; } r.checked += s.len; if (s.sup < o.minSup) { r.offLen += s.len; r.offSegs.push([{ x: s.A.x, y: s.A.y }, { x: s.B.x, y: s.B.y }]); r.offEdges.push(s.key); } }
    const list = [];
    for (const r of res.values()) { const lim = Math.max(o.minLen, o.ratio * r.checked); r.score = r.checked ? r.offLen / lim : 0; r.level = r.score >= 2 ? 'red' : r.score >= 1 ? 'yellow' : ''; r.sliver = r.area < (o.sliver ?? SHAPE_DEFAULT.sliver); if (r.level || (r.sliver && r.offLen > 0)) list.push(r); }
    list.sort((u, v) => v.score - u.score);
    const blocks = plan.blocks.filter(b => !b.none && !b.poor), shifts = blocks.map(b => Math.hypot(b.shift.dx, b.shift.dy)), poor = plan.blocks.filter(b => b.poor);
    return { opt: o, blocks: plan.blocks.length, covered: blocks.length, poor: poor.length, poorBoxes: poor.map(b => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, fit: b.fit })), shiftMedian: median(shifts), checkedLen: plan.segs.filter(s => s.sup != null).reduce((t, s) => t + s.len, 0), offLen: plan.segs.filter(s => s.sup != null && s.sup < o.minSup).reduce((t, s) => t + s.len, 0),
      flagged: list, counts: { red: list.filter(r => r.level === 'red').length, yellow: list.filter(r => r.level === 'yellow').length, slivers: list.filter(r => r.sliver).length } };
  }
  // 同步版（Node 測試或已在記憶體的影像）：getRegion(x0, y0, x1, y1) → { rgba, w, h, wf } 或 null
  function inkCheck(cur, getRegion, opt = {}) { const plan = inkPlan(cur, opt); for (const b of plan.blocks) inkBlock(plan, b, getRegion(b.wx0, b.wy0, b.wx1, b.wy1)); return inkResult(cur, plan); }
  // 兩項檢核合併成一張表（每宗一列）：level 取較嚴重者
  function oldMapReport(shape, ink) {
    const rows = new Map(), rank = { red: 2, yellow: 1, '': 0 };
    const row = r => { let x = rows.get(r.idx); if (!x) rows.set(r.idx, x = { idx: r.idx, label: r.label, area: r.area, level: '', score: 0, vec: null, img: null }); return x; };
    if (shape) for (const r of shape.flagged.concat(shape.slivers)) { const x = row(r); x.vec = r; }
    if (ink) for (const r of ink.flagged) { const x = row(r); x.img = r; }
    for (const x of rows.values()) { for (const r of [x.vec, x.img]) if (r && rank[r.level] > rank[x.level]) x.level = r.level; x.score = Math.max(x.vec ? x.vec.score : 0, x.img ? x.img.score : 0); x.sliver = x.area < SHAPE_DEFAULT.sliver; }
    return [...rows.values()].filter(x => x.level || (x.sliver && (x.img ? x.img.offLen > 0 : false))).sort((u, v) => rank[v.level] - rank[u.level] || v.score - u.score);
  }
  // ── 比對報告（v0.24.0）：接圖前比對（＋舊圖檢核）輸出成單一 HTML，每筆一張卡片附局部圖；可篩選、勾「已處理」、寫備註（存在瀏覽器）、列印／另存 PDF ──
  // r：compareBaseline 結果；chk：oldMapReport 列（可省略）。opt：{ title, caseName, version, date }
  function baselineReportHtml(cur, r, opt = {}) {
    r = r || { missing: [], flagged: [], occupied: [], partial: [], extra: [], fit: null, opt: { a: AREA_TOL.a, b: AREA_TOL.b, ratio: 5 } };
    const E = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const f = (v, d = 1) => (v == null || !isFinite(v) ? '—' : v.toFixed(d)), sg = (v, d = 1) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d));
    const live = cur.parcels.filter(p => !p.deleted && p.ids.length >= 3), ringOf = p => p.ids.map(id => cur.points.get(id));
    const boxes = new Map(live.map(p => [p, ringBox(p, cur.points)]));
    const ctr = q => { let x = 0, y = 0; for (const p of q) { x += p.x; y += p.y; } return { x: x / q.length, y: y / q.length }; };
    // 局部圖：目前的圖（灰）、本筆宗地（藍）、接圖前界址（紅虛線）、問題線段（各色）
    const svg = it => {
      const pts = [...it.cur.flatMap(ringOf), ...it.ref.flat(), ...(it.segs || []).flatMap(s => s.list.flat())]; if (!pts.length) return '';
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const q of pts) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
      const pad = Math.max(12, 0.25 * Math.max(x1 - x0, y1 - y0)); x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
      const w = x1 - x0, h = y1 - y0, sz = Math.max(w, h), R = v => v.toFixed(2), P = q => `${R(q.x - x0)},${R(y1 - q.y)}`, poly = q => q.map(P).join(' ');
      const ctx = live.filter(p => { const b = boxes.get(p); return b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1; }), mine = new Set(it.cur);
      const fs = sz / 38, lab = ctx.filter(p => { const b = boxes.get(p); return Math.max(b.x1 - b.x0, b.y1 - b.y0) > sz / 12 || mine.has(p); }).map(p => { const c = ctr(ringOf(p)); return c.x > x0 && c.x < x1 && c.y > y0 && c.y < y1 ? `<text x="${R(c.x - x0)}" y="${R(y1 - c.y)}" font-size="${R(mine.has(p) ? fs * 1.25 : fs)}" class="${mine.has(p) ? 'lm' : 'lc'}">${E(p.label)}</text>` : ''; }).join('');
      const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find(v => v >= sz / 6) || 1000;
      return `<svg viewBox="0 0 ${R(w)} ${R(h)}" preserveAspectRatio="xMidYMid meet">` +
        ctx.filter(p => !mine.has(p)).map(p => `<polygon points="${poly(ringOf(p))}" class="pc"/>`).join('') +
        it.cur.map(p => `<polygon points="${poly(ringOf(p))}" class="pm"/>`).join('') +
        it.ref.map(q => `<polygon points="${poly(q)}" class="pr"/>`).join('') +
        (it.segs || []).map(s => s.list.map(([a, b]) => `<line x1="${R(a.x - x0)}" y1="${R(y1 - a.y)}" x2="${R(b.x - x0)}" y2="${R(y1 - b.y)}" class="${s.cls}"/>`).join('')).join('') + lab +
        `<g class="sb"><line x1="${R(fs)}" y1="${R(h - fs)}" x2="${R(fs + nice)}" y2="${R(h - fs)}"/><text x="${R(fs)}" y="${R(h - fs * 1.6)}" font-size="${R(fs)}">${nice} m</text></g>` +
        `<text x="${R(w - fs * 1.5)}" y="${R(fs * 2)}" font-size="${R(fs * 1.4)}" class="na">N↑</text></svg>`;
    };
    const byIdx = i => cur.parcels[i], parcelsOf = l => (l || []).map(byIdx).filter(p => p && !p.deleted);
    const cov = l => (l || []).map(h => `${E(h.label)}（${f(h.area, 0)} ㎡）`).join('、') || '—';
    const items = [];
    const add = (cat, catName, x, rows, extra = {}) => items.push({ id: `${cat}-${items.length}`, cat, catName, label: x.label, rows, ...extra });
    for (const m of r.missing) add('missing', '遺漏', m, [['登記面積', f(m.reg, 2) + ' ㎡'], ['接圖前面積', f(m.area, 2) + ' ㎡'], ['在目前的圖內', (m.inside * 100).toFixed(0) + '%'], ['現屬', cov(m.cover)]], { cur: parcelsOf(m.cover.map(h => h.idx)), ref: m.rings, sev: 3, note: '接圖前有、目前的圖沒有（常見是被補成未登記地）。可在工作站「接圖前比對」一鍵修復。' });
    for (const x of r.flagged) add('area', '面積超限', x, [['登記面積', f(x.reg, 2) + ' ㎡'], ['現面積', f(x.area, 2) + ' ㎡'], ['較差', sg(x.diff, 2) + ' ㎡'], ['公差', f(x.tol, 2) + ' ㎡'], ['倍數', f(x.ratio, 1)], ['接圖前倍數', x.refRatio == null ? '—' : f(x.refRatio, 1) + (x.pieces > 1 ? `（${x.pieces} 塊）` : '')], ['原因', x.cause]], { cur: parcelsOf(x.idxs || [x.idx]), ref: x.rings || [], sev: x.cause === '接圖後產生' ? 3 : 2, ratio: x.ratio });
    for (const o of r.occupied) add('occupied', '被未登記地佔用', o, [['登記面積', f(o.reg, 2) + ' ㎡'], ['被佔面積', f(o.occ, 2) + ' ㎡'], ['公差', f(o.tol, 2) + ' ㎡'], ['佔用的未登記地', cov(o.cover)]], { cur: parcelsOf(o.idxs || [o.idx]).concat(parcelsOf(o.cover.map(h => h.idx))), ref: o.rings || [], sev: 2 });
    for (const m of r.partial) add('partial', '部分在區內', m, [['接圖前面積', f(m.area, 2) + ' ㎡'], ['在目前的圖內', (m.inside * 100).toFixed(1) + '%'], ['區內部分現屬', cov(m.cover)]], { cur: parcelsOf(m.cover.map(h => h.idx)), ref: m.rings, sev: 1, note: '只有一部分落在目前的圖內，請確認區界。' });
    for (const e of r.extra) add('extra', '接圖前沒有', e, [['說明', '目前的圖有、接圖前沒有（非未登記地）']], { cur: parcelsOf([e.idx]), ref: [], sev: 1 });
    for (const x of opt.chk || []) add('chk', '舊圖檢核', x, [['面積', f(x.area, 2) + ' ㎡'], ['等級', x.level === 'red' ? '紅' : x.level === 'yellow' ? '黃' : '碎片'], ['離舊圖線', x.vec ? f(x.vec.offLen) + ' m' : '—'], ['舊圖線穿過內部', x.vec ? f(x.vec.innerLen) + ' m' : '—'], ['影像無墨線', x.img ? `${f(x.img.offLen)} / ${f(x.img.checked)} m` : '—'], ['建議', x.fix ? `併入 ${E(x.fix.label)}` : '人工判斷']],
      { cur: parcelsOf([x.idx]), ref: [], sev: x.level === 'red' ? 3 : x.level === 'yellow' ? 2 : 1, segs: [x.img && { cls: 'si', list: x.img.offSegs }, x.vec && { cls: 'sv', list: x.vec.offSegs }, x.vec && { cls: 'sn', list: x.vec.innerSegs }].filter(Boolean) });
    const cats = [['missing', '遺漏'], ['area', '面積超限'], ['occupied', '被未登記地佔用'], ['partial', '部分在區內'], ['extra', '接圖前沒有'], ['chk', '舊圖檢核']].filter(([c]) => items.some(i => i.cat === c));
    const count = c => items.filter(i => i.cat === c).length, key = E(opt.caseName || 'case');
    const card = it => `<article class="card s${it.sev}" id="${it.id}" data-cat="${it.cat}" data-label="${E(it.label)}"><header><span class="cat">${E(it.catName)}</span><h2>${E(it.label)}</h2>` +
      `<label class="done"><input type="checkbox" data-k="${E(it.cat + '|' + it.label)}">已處理</label></header><div class="body"><div class="map">${svg(it)}</div><div class="info"><table>${it.rows.map(([k, v]) => `<tr><th>${E(k)}</th><td>${String(v).includes('<') ? v : E(v)}</td></tr>`).join('')}</table>` +
      (it.note ? `<p class="note">${E(it.note)}</p>` : '') + `<textarea data-n="${E(it.cat + '|' + it.label)}" placeholder="備註（處理方式、待查事項…）"></textarea></div></div></article>`;
    const fit = r.fit ? `坐標轉換：${r.fit.used}/${r.fit.total} 宗同地號擬合，殘差中位數 ${f(r.fit.median, 2)} m` : '坐標轉換：無（同坐標系）';
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${E(opt.title || '接圖前比對報告')}</title><style>
:root{--bg:#f4f5f7;--panel:#fff;--ink:#1d2330;--muted:#69718a;--line:#d9dde6;--accent:#1f6feb;--bad:#d1242f;--warn:#b7791f}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#14171d;--panel:#1c2029;--ink:#e6e9f0;--muted:#98a1b6;--line:#2c3240;--accent:#4c8dff;--bad:#ff6b73;--warn:#e0a34a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif}
.top{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 16px}.top h1{font-size:18px;margin:0 0 4px}.meta{color:var(--muted);font-size:12px}
.bar{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-top:8px;font-size:13px}.bar input[type=search]{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;padding:4px 8px;width:160px}
.bar button{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}.bar button.p{background:var(--accent);border-color:var(--accent);color:#fff}
main{max-width:1180px;margin:0 auto;padding:12px 16px 40px}.sum{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 14px}.sum a{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 12px;color:inherit;text-decoration:none}.sum b{font-size:18px;margin-right:4px}
.card{background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--line);border-radius:10px;margin:0 0 14px;overflow:hidden;break-inside:avoid}.card.s3{border-left-color:var(--bad)}.card.s2{border-left-color:var(--warn)}
.card header{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line)}.card h2{font-size:16px;margin:0}.cat{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:10px;padding:0 8px}.done{margin-left:auto;font-size:13px;cursor:pointer}
.card.is-done{opacity:.55}.body{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:12px;padding:10px 12px}.map svg{width:100%;height:300px;display:block;border:1px solid var(--line);border-radius:6px;background:#fbfaf7}
.info table{border-collapse:collapse;width:100%;font-size:13px}.info th{text-align:left;color:var(--muted);font-weight:500;padding:3px 8px 3px 0;white-space:nowrap;vertical-align:top}.info td{padding:3px 0;font-variant-numeric:tabular-nums}
.note{font-size:12px;color:var(--muted);margin:6px 0}textarea{width:100%;min-height:56px;margin-top:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit;font-size:13px;padding:6px}
svg .pc{fill:none;stroke:#8a93a6;stroke-width:1;vector-effect:non-scaling-stroke}svg .pm{fill:rgba(31,111,235,.18);stroke:#1f6feb;stroke-width:2;vector-effect:non-scaling-stroke}
svg .pr{fill:rgba(209,36,47,.08);stroke:#d1242f;stroke-width:2;stroke-dasharray:6 4;vector-effect:non-scaling-stroke}svg .si{stroke:rgba(209,36,47,.75);stroke-width:5;vector-effect:non-scaling-stroke}svg .sv{stroke:#ae3ec9;stroke-width:2.5;vector-effect:non-scaling-stroke}svg .sn{stroke:#1c7ed6;stroke-width:2.5;stroke-dasharray:7 5;vector-effect:non-scaling-stroke}
svg text{font-family:sans-serif;text-anchor:middle;dominant-baseline:middle}svg .lc{fill:#69718a}svg .lm{fill:#0b3d91;font-weight:700}svg .sb line{stroke:#1d2330;stroke-width:2;vector-effect:non-scaling-stroke}svg .sb text{text-anchor:start;fill:#1d2330}svg .na{fill:#1d2330;font-weight:700}
.legend{font-size:12px;color:var(--muted);margin:0 0 12px}.legend i{display:inline-block;width:22px;height:0;border-top:2px solid;vertical-align:middle;margin:0 4px 0 10px}
.hide{display:none}@media (max-width:760px){.body{grid-template-columns:1fr}.map svg{height:240px}}
@media print{body{background:#fff;color:#000}.top{position:static;border:0}.bar,.done{display:none}.card.is-done header::after{content:"✓ 已處理";margin-left:auto;font-size:12px}.map svg{height:240px}.card{border-color:#999;box-shadow:none;page-break-inside:avoid}.card.is-done{opacity:1}textarea{border:1px dashed #999;background:#fff}textarea:placeholder-shown{display:none}main{max-width:none;padding:0}@page{size:A4;margin:12mm}}
</style></head><body><div class="top"><h1>${E(opt.title || '接圖前比對報告')}</h1><div class="meta">${E(opt.caseName || '')}　產出：${E(opt.date || '')}　${E(opt.version || '')}　${E(fit)}　公差 (${r.opt.a}＋${r.opt.b}·⁴√F)·√F，超過 ${r.opt.ratio} 倍標記</div>
<div class="bar">${cats.map(([c, n]) => `<label><input type="checkbox" data-f="${c}" checked> ${n}（${count(c)}）</label>`).join('')}<label><input type="checkbox" id="undone"> 只看未處理</label><input type="search" id="q" placeholder="找地號"><span id="cnt" class="meta"></span><span style="flex:1"></span><button id="csv">匯出備註 CSV</button><button class="p" onclick="print()">列印／另存 PDF</button></div></div>
<main><div class="sum">${cats.map(([c, n]) => `<a href="#${(items.find(i => i.cat === c) || {}).id}"><b>${count(c)}</b>${n}</a>`).join('')}</div>
<p class="legend">圖例：<i style="border-color:#1f6feb"></i>本筆（目前的圖）<i style="border-color:#d1242f;border-top-style:dashed"></i>接圖前界址<i style="border-color:#8a93a6"></i>其他宗地` + (items.some(i => i.cat === 'chk') ? `<i style="border-color:rgba(209,36,47,.75);border-top-width:5px"></i>影像無墨線<i style="border-color:#ae3ec9"></i>離舊圖線<i style="border-color:#1c7ed6;border-top-style:dashed"></i>舊圖線穿過內部` : '') + `</p>
${items.length ? items.map(card).join('') : '<p>沒有需要處理的項目。</p>'}</main>
<script>(()=>{const K='cwreport:${key.replace(/'/g, '')}:',S={get:k=>{try{return localStorage.getItem(K+k)}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(K+k,v)}catch(e){}}};
const cards=[...document.querySelectorAll('.card')];
for(const c of document.querySelectorAll('[data-k]')){c.checked=S.get('d|'+c.dataset.k)==='1';c.closest('.card').classList.toggle('is-done',c.checked);c.onchange=()=>{S.set('d|'+c.dataset.k,c.checked?'1':'0');c.closest('.card').classList.toggle('is-done',c.checked);run()}}
for(const t of document.querySelectorAll('[data-n]')){t.value=S.get('n|'+t.dataset.n)||'';t.oninput=()=>S.set('n|'+t.dataset.n,t.value)}
const run=()=>{const on=new Set([...document.querySelectorAll('[data-f]')].filter(x=>x.checked).map(x=>x.dataset.f)),q=document.getElementById('q').value.trim(),u=document.getElementById('undone').checked;let n=0;
for(const c of cards){const v=on.has(c.dataset.cat)&&(!q||c.dataset.label.startsWith(q))&&!(u&&c.classList.contains('is-done'));c.classList.toggle('hide',!v);if(v)n++}document.getElementById('cnt').textContent='顯示 '+n+' / '+cards.length+' 筆'};
document.querySelectorAll('[data-f],#undone').forEach(x=>x.onchange=run);document.getElementById('q').oninput=run;run();
document.getElementById('csv').onclick=()=>{const q=v=>'"'+String(v).replace(/"/g,'""')+'"',rows=[['類別','地號','已處理','備註'].join(',')];
for(const c of cards){const k=c.querySelector('[data-k]').dataset.k;rows.push([c.querySelector('.cat').textContent,c.dataset.label,c.querySelector('[data-k]').checked?'是':'',c.querySelector('textarea').value].map(q).join(','))}
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\\ufeff'+rows.join('\\r\\n')],{type:'text/csv'}));a.download='${key.replace(/'/g, '')}_比對備註.csv';a.click()};})();</script></body></html>`;
  }
  function baselineCsv(r) {
    const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)), f = (v, d = 2) => (v == null ? '' : v.toFixed(d));
    const cov = l => l.map(h => `${h.label}(${h.area.toFixed(0)})`).join(' ');
    const out = [['類別', '地號', '登記面積㎡', '接圖前面積㎡', '現面積㎡', '較差㎡', '公差㎡', '較差/公差', '接圖前較差/公差', '原因／說明'].join(',')];
    for (const m of r.missing) out.push(['遺漏', m.label, f(m.reg), f(m.area), '', '', '', '', '', `${(m.inside * 100).toFixed(0)}% 在作業圖內；現屬 ${cov(m.cover)}`].map(q).join(','));
    for (const m of r.partial) out.push(['部分在區內', m.label, f(m.reg), f(m.area), '', '', '', '', '', `${(m.inside * 100).toFixed(1)}% 在作業圖內；現屬 ${cov(m.cover)}`].map(q).join(','));
    for (const o of r.occupied) out.push(['被未登記地佔用', o.label, f(o.reg), '', '', '', f(o.tol), f(o.occ / o.tol), '', `被佔 ${o.occ.toFixed(1)}㎡：${cov(o.cover)}`].map(q).join(','));
    for (const m of r.unreg) out.push(['接圖前的未登記地', m.label, '', f(m.area), '', '', '', '', '', `作業圖另編號：${cov(m.cover)}`].map(q).join(','));
    for (const e of r.extra) out.push(['接圖前沒有', e.label, '', '', '', '', '', '', '', ''].map(q).join(','));
    for (const x of r.area) out.push([x.flag ? '面積超限' : '面積', x.label, f(x.reg), f(x.refArea), f(x.area), f(x.diff), f(x.tol), f(x.ratio), f(x.refRatio), x.cause].map(q).join(','));
    return out.join('\r\n') + '\r\n';
  }

  function exportSession(ds, extra = {}, sv = null) {
    return {
      format: 'cadastral-workbench/session@1',
      description: '地籍圖調整工作階段。y=縱坐標(北), x=橫坐標(東), 單位公尺, TWD97。area 單位 m²。',
      crs: 'EPSG:3826', source: ds.source,
      structure: (() => { const st = structSummary(ds), was = new Set((ds.orig ? ds.orig.points : []).map(q => q.id)); return { ...st, points_added: [...ds.points.values()].filter(q => q.added).map(q => ({ id: q.id, y: q.y, x: q.x })), points_removed: [...was].filter(id => !ds.points.has(id)) }; })(),
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
    buildTopology, applyDelta, seamGuard, insertPoint, addFreePoint, footsOnLine, removePoints, removeBlocker, unusedPoints, collinearCandidates, collinearCheck, cleanupPoints, structSummary, COLLINEAR_DEFAULT,
    bounds, movePoints, setPoints, parcelArea, ringAreaArc, arcPolyline, newDataset, setPoint, resetAll, movedPoints, isMoved, exportD14, exportD13, exportD12, exportD11, exportD21, deleteParcel, deleteHoleParcel, unregSummary, splitParcel, splitSteps, parcelsTouch, healJunctions, mergeClusters, absorbSlivers, seamGaps, fillSeamGap, shapeRatio, minRect, mergeParcels, fillRegion, pocketRegion, chordInside, nextSub, makeZip, crc32, changedDFiles, ringIssues, ringIssueLine, embeddedRuns, splitHole, setRing, outlineLoops, errReport, ringConflicts, freeRegions, exportSession, finalize,
    xform, transformPoints, centroidOf, twoPointFit, parseAngle, parsePoints, parseObservations, polarReduce, azimuth, parseMac, reduceMac, parseCtl, latLonToTm2, tm2ToLatLon, compareVersions,
    newSurvey, addSurveyPoints, addLine, lineStats, SEAM_DEFAULT, boundarySegments, seamCheck, seamPlan, seamAnalyze, seamJoin, seamExact, seamShift, seamMode, seamReportText, seamReportCsv, movedPointsCsv, parseWorldFile, worldFileText, imageCorners, imageBounds, imageSize,
    AREA_TOL, areaTol, parcelNo, fitAffine, intersectArea, compareBaseline, baselineCsv, baselineReportHtml, restoreMissing,
    baselineFit, checkSegments, SHAPE_DEFAULT, shapeCheck, INK_DEFAULT, inkMask, distanceField, inkPlan, inkBlock, inkResult, inkCheck, oldMapReport,
    parseMdb, ownerTables, ownerClass, OWNER_CLASS, shareSum, ownerAnalysis, findOwner };
})();
if (typeof module !== 'undefined') module.exports = Core;
