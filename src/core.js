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
      ds.parcels.push({ key: k, section: g.sec, label: String(g.sub), oldLabel: String(g.sub), ids,
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
  function unregSummary(ds, maxPts = 10, maxRatio = 0) {
    const parcels = ds.parcels.filter(isUnreg).map(p => { const ratio = p.ids.length >= 3 ? shapeRatio(p.ids, ds.points) : 0, overPts = p.ids.length > maxPts, long = maxRatio > 0 && ratio > maxRatio * 1.01;   // 與 splitParcel 相同的 1% 容差
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
  function createParcel(ds, d, mother, ids, like) {
    const sec = like ? like.section : (ds.parcels.find(p => p.section) || {}).section || 0, c = nextSub(ds, mother), label = `${mother}-${c}`;
    const p = { idx: ds.parcels.length, key: `${sec}|${mother}|${c}`, section: sec, label, oldLabel: label, ids: [], mid: [], hasArc: false, holeKeys: [], rows: [], ids0: [], mid0: [],
      areaRef: null, areaReg: 0, attrRow: null, created: true, like: like ? like.idx : null, holes: [], containers: [], areaOrig: 0, area: 0, unregEdit: true };
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
  // 垂直於長軸、在投影位置 s 切開環 cur（逆時針）：切線與環恰交兩處才可用；交點離既有點 ≤ snap 公尺就用既有點，否則是新點（{y,x,edge:[a,b]}）。
  // 回傳 {piece, rest（皆為點號陣列，新點以 'n0'、'n1' 暫代）, news, PP（含暫代點的查詢）}；切不開回傳 null
  function perpCut(cur, P, ux, uy, s, snap = 0.3) {
    const n = cur.length, pr = id => { const q = P.get(id); return q.x * ux + q.y * uy - s; }, hits = [], eps = 1e-6;
    for (let i = 0; i < n; i++) {
      const a = cur[i], b = cur[(i + 1) % n], da = pr(a), db = pr(b);
      if (Math.abs(da) < eps) { hits.push({ i, id: a }); continue; }
      if (Math.abs(db) < eps || da * db > 0) continue;
      const A = P.get(a), B = P.get(b), t = da / (da - db), y = A.y + t * (B.y - A.y), x = A.x + t * (B.x - A.x), L = Math.hypot(B.x - A.x, B.y - A.y);
      if (t * L <= snap) hits.push({ i, id: a }); else if ((1 - t) * L <= snap) hits.push({ i: (i + 1) % n, id: b }); else hits.push({ i, t, y, x, edge: [a, b] });
    }
    const uniq = hits.filter((h, k) => h.id == null || hits.findIndex(g => g.id === h.id) === k); if (uniq.length !== 2) return null;
    if (uniq[0].id != null && uniq[0].id === uniq[1].id) return null;
    const tmp = new Map(), news = [], ring = [], at = [];
    for (let i = 0; i < n; i++) {
      ring.push(cur[i]); const h = uniq.find(g => g.id == null && g.i === i);
      if (h) { const id = 'n' + news.length; tmp.set(id, { id, y: h.y, x: h.x }); news.push({ id, y: h.y, x: h.x, edge: h.edge }); ring.push(id); }
    }
    for (const h of uniq) at.push(ring.indexOf(h.id != null ? h.id : news.find(q => q.edge[0] === h.edge[0] && q.edge[1] === h.edge[1]).id));
    const PP = { get: id => tmp.get(id) || P.get(id) }, m = ring.length, [i0, i1] = at.sort((x, y) => x - y);
    if (!chordInside(ring, i0, i1, PP)) return null;
    const c1 = ring.slice(i0, i1 + 1), c2 = ring.slice(i1).concat(ring.slice(0, i0 + 1));
    if (c1.length < 3 || c2.length < 3 || m < 4) return null;
    const side = ids => ids.reduce((t, id) => t + pr2(id), 0) / ids.length, pr2 = id => { const q = PP.get(id); return q.x * ux + q.y * uy - s; };
    const [piece, rest] = side(c1) < side(c2) ? [c1, c2] : [c2, c1];
    return { piece, rest, news, PP };
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
  // 新點要插入的界址線不可是圓弧的一部分
  const edgeOnArc = (ds, a, b) => ds.parcels.some(p => { if (p.deleted || !p.mid) return false; const k = p.ids.length;
    for (let i = 0; i < k; i++) { const u = p.ids[i], v = p.ids[(i + 1) % k]; if ((u === a && v === b) || (u === b && v === a)) return !!(p.mid[i] || p.mid[(i + 1) % k]); } return false; });
  // 把宗地切成每塊 ≤ maxPts 點、細長度 ≤ maxRatio（0＝不限形狀）。回傳 {delta, pieces:[地號…], unresolved（形狀仍超過時的細長度）}；地中地、圓弧、與地中地相關者不處理。
  // 點數：以連接既有界址點的弦切下（116 倉庫演算法）。形狀：先試既有點的弦，切不出合格的才垂直長軸切開（大約等分，交點新增界址點，鄰宗同步插入）。
  function splitParcel(ds, pi, maxPts = 10, maxRatio = 0) {
    const p = ds.parcels[pi], P = ds.points; if (!p || p.deleted) throw new Error('宗地不存在');
    if (maxPts < 3) throw new Error('每筆至少 3 點');
    if ((p.holes || []).length || (p.containers || []).length) throw new Error(`${p.label} 含地中地或本身是地中地，尚未支援自動分割`);
    if (p.mid && p.mid.some(Boolean)) throw new Error(`${p.label} 含圓弧，尚未支援自動分割`);
    const lim = maxRatio > 0 ? Math.max(1.05, maxRatio) * (1 + 1e-6) : 0, tooLong = ids => lim && shapeRatio(ids, P) > lim * 1.01;   // 切下的塊嚴格 ≤ 上限；剩餘部分超過不到 1% 就不再切（避免切出零碎小塊）
    if (p.ids.length <= maxPts && !tooLong(p.ids)) return { delta: null, pieces: [] };
    const d = newDelta(), pieces = []; touchParcel(d, p);
    let cur = ccwIds(p.ids, P), unresolved = null;
    for (let guard = 0; guard < 500 && (cur.length > maxPts || tooLong(cur)); guard++) {
      const n = cur.length, overPts = n > maxPts, areaCur = signedArea(cur, P), k = Math.max(overPts ? 1 : 2, lim ? Math.ceil(shapeRatio(cur, P) / lim * 0.97) : 1), target = areaCur / k;
      let best = null, free = null;
      for (let m = Math.min(maxPts, n - 2); m > 2 && !best; m--) {
        for (let i = 0; i < n; i++) {
          const j = (i + m - 1) % n, u = cur[i], v = cur[j]; if (ds.edges.has(segKey(u, v))) continue;
          if (!chordInside(cur, i, j, P)) continue;
          const piece = []; for (let q = 0; q < m; q++) piece.push(cur[(i + q) % n]);
          const area = signedArea(piece, P); if (area < 1) continue;
          const a = P.get(u), b = P.get(v), sc = Math.hypot(a.x - b.x, a.y - b.y) / Math.sqrt(area);
          if (overPts && (!free || sc < free.sc)) free = { sc, i, j, piece };   // 不看形狀的原演算法（備用）
          if (lim && shapeRatio(piece, P) > lim) continue;
          if (!overPts && (area < 0.6 * target || area > 1.4 * target)) continue;   // 只為形狀切時，避免切下零碎小塊
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
          .filter(e => e.L > 1e-6).sort((x, y) => y.L - x.L).slice(0, 4).forEach(e => { if (!dirs.some(([x, y]) => Math.abs(x * e.ux + y * e.uy) > 0.996)) dirs.push([e.ux, e.uy]); });
        for (const [dx, dy] of dirs) for (const sg of [1, -1]) {
          const ux = dx * sg, uy = dy * sg; let t0 = Infinity, t1 = -Infinity; for (const id of cur) { const q = P.get(id), t = q.x * ux + q.y * uy; t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
          let mine = null;
          const at = g => { const c = perpCut(cur, P, ux, uy, t0 + g / 200 * (t1 - t0)); if (!c) return;
            if (c.piece.length > maxPts || c.news.some(q => edgeOnArc(ds, q.edge[0], q.edge[1]))) return;
            const area = signedArea(c.piece, c.PP); if (area < 1 || areaCur - area < 1) return;
            if (shapeRatio(c.piece, c.PP) > lim) return;
            const key = Math.abs(area - target) / target; if (!mine || key < mine.key) mine = { key, g, ...c }; };
          for (let g = 4; g <= 196; g++) at(g);
          if (mine) { const g0 = mine.g; for (let h = -50; h <= 50; h++) at(g0 + h / 50); }   // 在最佳位置兩側細搜，避免取樣間距累積的誤差讓剩餘部分略超過上限
          if (mine && (!cut || mine.key < cut.key - 1e-9)) cut = mine;
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
  function mergeParcels(ds, idxs, keep) {
    idxs = [...new Set(idxs)]; if (idxs.length < 2) throw new Error('至少選兩筆');
    for (const i of idxs) { const p = ds.parcels[i]; if (!p || p.deleted) throw new Error('宗地不存在');
      if ((p.holes || []).length || (p.containers || []).length) throw new Error(`${p.label} 含地中地或本身是地中地，尚未支援合併`);
      if (p.mid && p.mid.some(Boolean)) throw new Error(`${p.label} 含圓弧，尚未支援合併`); }
    const loops = outlineLoops(ds, idxs).filter(l => Math.abs(l.area) > 1e-6);
    if (loops.length !== 1 || loops[0].area <= 0) throw new Error(loops.some(l => l.area < 0) ? '合併後中間會有空洞，請連空洞一起處理' : '選取的宗地沒有全部相連');
    const order = idxs.map(i => ds.parcels[i]).sort((a, b) => (a.created - b.created) || (mainNo(a) - mainNo(b)) || (subNo(a) - subNo(b)));
    const k = keep != null ? ds.parcels[keep] : order[0], d = newDelta(); d.deleted = [];
    const inGroup = new Set(idxs), onLoop = new Set(loops[0].ids), drop = new Set();
    for (const i of idxs) { const p = ds.parcels[i]; touchParcel(d, p); for (const id of p.ids) if (!onLoop.has(id) && (ds.pointParcels.get(id) || []).every(x => inGroup.has(x))) drop.add(id); }
    for (const i of idxs) { const p = ds.parcels[i]; if (p === k) continue; p.ids = []; p.mid = []; p.deleted = true; d.deleted.push(i); }
    k.ids = loops[0].ids.slice(); k.mid = k.ids.map(() => false); k.unregEdit = true;
    for (const id of drop) { const q = ds.points.get(id); if (q) { ds.points.delete(id); d.removed.push(q); } }
    return { delta: closeDelta(ds, d), keep: k.label, merged: idxs.filter(i => i !== k.idx).map(i => ds.parcels[i].label), removedPoints: [...drop] };
  }
  // 空隙或凹口建為新的未登記地
  function fillRegion(ds, ids, mother) {
    if (ids.length < 3) throw new Error('範圍至少 3 點'); const d = newDelta(), p = createParcel(ds, d, mother, ccwIds(ids, ds.points), null);
    return { delta: closeDelta(ds, d), label: p.label };
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
        for (const [f, v] of [['PAR_O_M', m], ['PAR_O_C', c], ['PAR_N_M', m], ['PAR_N_C', c], ['SECTION_O', sec], ['AREA_OLD', 0]]) if (has(f)) patchDbfNumber(rec, t, 0, f, v);
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
    bounds, movePoints, setPoints, parcelArea, ringAreaArc, arcPolyline, newDataset, setPoint, resetAll, movedPoints, isMoved, exportD14, exportD13, exportD12, exportD11, exportD21, deleteParcel, deleteHoleParcel, unregSummary, splitParcel, shapeRatio, minRect, mergeParcels, fillRegion, pocketRegion, chordInside, nextSub, makeZip, crc32, changedDFiles, ringIssues, ringIssueLine, embeddedRuns, splitHole, setRing, outlineLoops, errReport, ringConflicts, freeRegions, exportSession, finalize,
    xform, transformPoints, centroidOf, twoPointFit, parseAngle, parsePoints, parseObservations, polarReduce, azimuth, parseMac, reduceMac, parseCtl, latLonToTm2, tm2ToLatLon, compareVersions,
    newSurvey, addSurveyPoints, addLine, lineStats, SEAM_DEFAULT, boundarySegments, seamCheck, seamPlan, seamAnalyze, seamJoin, seamReportText, seamReportCsv, movedPointsCsv, parseWorldFile, worldFileText, imageCorners, imageBounds, imageSize };
})();
if (typeof module !== 'undefined') module.exports = Core;
