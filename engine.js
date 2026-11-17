/*
 * Carambole — moteur d'analyse (partie libre)
 * Détection des 3 billes par couleur, suivi, détection des chocs et des bandes,
 * validation du point, classification de l'effet, analyse du geste.
 * JavaScript pur : fonctionne dans le navigateur et sous Node (tests).
 * Unités : mètres, secondes. Repère table : x le long de la grande bande, y en largeur.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CaramboleEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BALL_D = 0.0615, BALL_R = BALL_D / 2;
  const TABLES = {
    match: { L: 2.84, W: 1.42, label: 'Match 2,84 × 1,42 m' },
    m260: { L: 2.60, W: 1.30, label: '2,60 × 1,30 m' },
    m240: { L: 2.40, W: 1.20, label: '2,40 × 1,20 m' },
    m210: { L: 2.10, W: 1.05, label: '2,10 × 1,05 m' },
  };
  const NAMES = ['blanche', 'jaune', 'rouge'];
  const EFFECTS = {
    retro: 'Rétro', amorti: 'Amorti', naturel: 'Coup naturel', coule: 'Coulé', indetermine: 'Indéterminé',
  };
  const DEFAULT_COLORS = {
    wS: 0.30, wV: 0.62,                 // blanche : peu saturée, claire
    yH0: 38, yH1: 72, yS: 0.42, yV: 0.40, // jaune
    rH0: 14, rH1: 338, rS: 0.48, rV: 0.25, // rouge (teinte autour de 0°)
  };

  // ---------- géométrie ----------
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      const tmp = M[c]; M[c] = M[p]; M[p] = tmp;
      const d = M[c][c];
      if (Math.abs(d) < 1e-12) throw new Error('Calibrage impossible (points alignés)');
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / d;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    return solve(A, b).concat([1]);
  }
  function project(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }
  const hyp = Math.hypot;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const norm = (a) => hyp(a[0], a[1]);
  const median = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
  const std = (arr) => { const m = mean(arr); return Math.sqrt(mean(arr.map((v) => (v - m) ** 2))); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- détection image ----------
  class Detector {
    /**
     * @param {number} w,h taille de l'image analysée
     * @param {Array} corners 4 coins intérieurs (nez de bande) en pixels :
     *   1 et 2 = une même grande bande, puis 3, 4 en continuant le tour.
     * @param {{L:number,W:number}} table
     */
    constructor(w, h, corners, table, opts = {}) {
      this.w = w; this.h = h; this.table = table; this.corners = corners;
      this.colors = Object.assign({}, DEFAULT_COLORS, opts.colors || {});
      const { L, W } = table, tc = [[0, 0], [L, 0], [L, W], [0, W]];
      this.H = homography(corners, tc);
      this.Hi = homography(tc, corners);
      const cx = mean(corners.map((c) => c[0])), cy = mean(corners.map((c) => c[1]));
      const H = this.H, wSign = Math.sign(H[6] * cx + H[7] * cy + H[8]);
      const n = w * h;
      this.tx = new Float32Array(n); this.ty = new Float32Array(n);
      this.zone = new Uint8Array(n); // 1 = zone billes (élargie), 2 = drap strict
      const list = [], m = 0.025, ins = 0.015;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, ww = H[6] * (x + 0.5) + H[7] * (y + 0.5) + H[8];
        if (Math.sign(ww) !== wSign) continue;
        const X = (H[0] * (x + 0.5) + H[1] * (y + 0.5) + H[2]) / ww;
        const Y = (H[3] * (x + 0.5) + H[4] * (y + 0.5) + H[5]) / ww;
        this.tx[i] = X; this.ty[i] = Y;
        if (X > -m && X < L + m && Y > -m && Y < W + m) {
          this.zone[i] = 1; list.push(i);
          if (X > ins && X < L - ins && Y > ins && Y < W - ins) this.zone[i] = 2;
        }
      }
      this.idx = Int32Array.from(list);
      this.cls = new Uint8Array(n);
      this.parent = new Int32Array(n);
      this.cloth = null;
    }

    localRadius(X, Y) {
      const c = project(this.Hi, X, Y);
      const a = project(this.Hi, X + BALL_R, Y), b = project(this.Hi, X, Y + BALL_R);
      return [hyp(a[0] - c[0], a[1] - c[1]), hyp(b[0] - c[0], b[1] - c[1])];
    }

    classifyPixel(r, g, b) {
      const C = this.colors;
      const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const v = max / 255, s = max ? (max - min) / max : 0;
      if (v >= C.wV && s <= C.wS) return 1;
      if (s < Math.min(C.yS, C.rS)) return 0;
      const dlt = max - min;
      let h;
      if (max === r) h = 60 * (((g - b) / dlt) % 6);
      else if (max === g) h = 60 * ((b - r) / dlt + 2);
      else h = 60 * ((r - g) / dlt + 4);
      if (h < 0) h += 360;
      if (h >= C.yH0 && h <= C.yH1 && s >= C.yS && v >= C.yV) return 2;
      if ((h <= C.rH0 || h >= C.rH1) && s >= C.rS && v >= C.rV) return 3;
      return 0;
    }

    /** Couleur de référence du drap (à appeler table vide de joueur). */
    learnCloth(img) {
      const d = img.data, nr = [], ng = [], sm = [];
      for (let k = 0; k < this.idx.length; k += 5) {
        const i = this.idx[k];
        if (this.zone[i] !== 2) continue;
        const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2];
        if (this.classifyPixel(r, g, b)) continue;
        const s = r + g + b + 1;
        nr.push(r / s); ng.push(g / s); sm.push(s);
      }
      this.cloth = { nr: median(nr), ng: median(ng), sum: median(sm) };
    }

    /** Renvoie les taches candidates par couleur : [blanches, jaunes, rouges]. */
    detect(img) {
      const d = img.data, w = this.w, cls = this.cls, idx = this.idx, par = this.parent, zone = this.zone;
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        cls[i] = this.classifyPixel(d[4 * i], d[4 * i + 1], d[4 * i + 2]);
      }
      const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k], c = cls[i];
        if (!c) continue;
        par[i] = i;
        if (i % w && zone[i - 1] && cls[i - 1] === c) { const a = find(i - 1); par[a] = i; }
        if (i >= w && zone[i - w] && cls[i - w] === c) { const a = find(i - w), b = find(i); if (a !== b) par[a] = b; }
      }
      const stats = new Map();
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k], c = cls[i];
        if (!c) continue;
        const r = find(i);
        let s = stats.get(r);
        if (!s) { s = { c, area: 0, sx: 0, sy: 0, x0: 1e9, x1: -1, y0: 1e9, y1: -1 }; stats.set(r, s); }
        const x = i % w, y = (i / w) | 0;
        s.area++; s.sx += x; s.sy += y;
        if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
      }
      const out = [[], [], []];
      for (const s of stats.values()) {
        if (s.area < 4) continue;
        const ix = s.sx / s.area + 0.5, iy = s.sy / s.area + 0.5;
        const [X, Y] = project(this.H, ix, iy);
        const [rx, ry] = this.localRadius(X, Y);
        const expA = Math.PI * rx * ry;
        const ratio = s.area / expA;
        if (ratio < 0.28 || ratio > 2.8) continue;
        const bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1;
        if (bw > 5 * rx + 3 || bh > 5 * ry + 3) continue;
        out[s.c - 1].push({ x: X, y: Y, ix, iy, area: s.area, score: Math.abs(Math.log(ratio)) });
      }
      return out;
    }

    /**
     * Repère la queue près d'une bille (vue de dessus) : ligne droite fine
     * de pixels « non-drap » pointant vers la bille (RANSAC).
     */
    cueFeatures(img, ball, balls) {
      if (!this.cloth || !ball) return null;
      const Z = 0.5, d = img.data, w = this.w, h = this.h, cl = this.cloth;
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let a = 0; a < 16; a++) {
        const p = project(this.Hi, ball[0] + Z * Math.cos(a * Math.PI / 8), ball[1] + Z * Math.sin(a * Math.PI / 8));
        x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      }
      x0 = clamp(Math.floor(x0), 0, w - 1); x1 = clamp(Math.ceil(x1), 0, w - 1);
      y0 = clamp(Math.floor(y0), 0, h - 1); y1 = clamp(Math.ceil(y1), 0, h - 1);
      const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 9000)));
      const pts = [], excl = (1.7 * BALL_R) ** 2;
      for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
        const i = y * w + x;
        if (this.zone[i] !== 2) continue;
        const X = this.tx[i], Y = this.ty[i];
        const dx = X - ball[0], dy = Y - ball[1];
        if (dx * dx + dy * dy > Z * Z) continue;
        let near = false;
        for (const b of balls) if (b && (X - b[0]) ** 2 + (Y - b[1]) ** 2 < excl) { near = true; break; }
        if (near) continue;
        const r = d[4 * i], g = d[4 * i + 1], bb = d[4 * i + 2], s = r + g + bb + 1;
        const dc = hyp(r / s - cl.nr, g / s - cl.ng);
        if (dc > 0.07 || s > 1.6 * cl.sum) pts.push([X, Y]);
      }
      if (pts.length < 20) return null;
      // RANSAC
      let best = null, bestN = 0;
      const tol = 0.011;
      let seed = 12345;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let it = 0; it < 160; it++) {
        const a = pts[(rnd() * pts.length) | 0], b = pts[(rnd() * pts.length) | 0];
        const dir = sub(b, a), L = norm(dir);
        if (L < 0.04) continue;
        const u = [dir[0] / L, dir[1] / L], nrm = [-u[1], u[0]];
        if (Math.abs(dot(sub(ball, a), nrm)) > 0.05) continue;
        let cnt = 0;
        for (const p of pts) if (Math.abs(dot(sub(p, a), nrm)) < tol) cnt++;
        if (cnt > bestN) { bestN = cnt; best = { a, u, nrm }; }
      }
      if (!best || bestN < 22) return null;
      const inl = pts.filter((p) => Math.abs(dot(sub(p, best.a), best.nrm)) < tol);
      // affinage ACP
      const mx = mean(inl.map((p) => p[0])), my = mean(inl.map((p) => p[1]));
      let sxx = 0, sxy = 0, syy = 0;
      for (const p of inl) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      let u = [Math.cos(th), Math.sin(th)];
      if (dot(sub(ball, [mx, my]), u) < 0) u = [-u[0], -u[1]]; // vers la bille
      const along = inl.map((p) => dot(sub(ball, p), u)).filter((s) => s > 0);
      if (along.length < 12) return null;
      along.sort((a, b) => a - b);
      const span = along[along.length - 1] - along[0];
      if (span < 0.08) return null;
      const tip = along[Math.floor(along.length * 0.03)];
      const nrm = [-u[1], u[0]];
      const offset = dot(sub(ball, [mx, my]), nrm); // >0 : bille à gauche de l'axe
      return { angle: Math.atan2(u[1], u[0]), offset, tipGap: tip - BALL_R, n: inl.length, span };
    }
  }

  // ---------- outils séries ----------
  function linFit(ts, ps, i0, i1) {
    let n = 0, st = 0, sx = 0, sy = 0;
    for (let i = i0; i <= i1; i++) { n++; st += ts[i]; sx += ps[i][0]; sy += ps[i][1]; }
    if (n < 2) return null;
    const tm = st / n, mx = sx / n, my = sy / n;
    let stt = 0, stx = 0, sty = 0;
    for (let i = i0; i <= i1; i++) { const dt = ts[i] - tm; stt += dt * dt; stx += dt * (ps[i][0] - mx); sty += dt * (ps[i][1] - my); }
    if (stt < 1e-12) return null;
    return { tm, p: [mx, my], v: [stx / stt, sty / stt], at(t) { return [mx + this.v[0] * (t - tm), my + this.v[1] * (t - tm)]; } };
  }
  function interpolate(raw, ts) {
    const n = raw.length, out = new Array(n);
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (!raw[i]) continue;
      if (last < 0) for (let k = 0; k < i; k++) out[k] = raw[i].slice();
      else for (let k = last + 1; k < i; k++) {
        const f = (ts[k] - ts[last]) / (ts[i] - ts[last]);
        out[k] = [raw[last][0] + f * (raw[i][0] - raw[last][0]), raw[last][1] + f * (raw[i][1] - raw[last][1])];
      }
      out[i] = raw[i].slice(); last = i;
    }
    if (last < 0) return null;
    for (let k = last + 1; k < n; k++) out[k] = raw[last].slice();
    return out;
  }

  // ---------- analyse d'un coup ----------
  /**
   * @param frames [{t, pos:[[x,y]|null ×3], feats?:[f|null,f|null]}] du repos avant le coup jusqu'à l'arrêt
   * @param opts {table, tStart, player:'auto'|0|1, mug, prep:[frames avant le coup]}
   */
  function analyzeShot(frames, opts) {
    const table = opts.table, L = table.L, W = table.W, D = BALL_D, R = BALL_R;
    const mug = opts.mug || 1.96;
    const n = frames.length;
    const T = frames.map((f) => f.t);
    const res = { valid: false, reason: '', confidence: 'faible', contacts: [], cushions: [], notes: [] };
    if (n < 8) { res.reason = 'Séquence trop courte'; res.ignored = true; return res; }
    const P = [0, 1, 2].map((b) => interpolate(frames.map((f) => f.pos[b]), T));
    const dts = []; for (let i = 1; i < n; i++) dts.push(T[i] - T[i - 1]);
    const dt = median(dts), fps = 1 / dt;
    res.fps = Math.round(fps);
    const win = Math.max(3, Math.round(0.05 * fps));
    const tStart = opts.tStart != null ? opts.tStart : T[0];

    // positions de repos
    const rest = P.map((ps) => {
      if (!ps) return null;
      const pre = []; for (let i = 0; i < n && T[i] < tStart - 0.02; i++) pre.push(ps[i]);
      const src = pre.length >= 2 ? pre : ps.slice(0, 3);
      return [median(src.map((p) => p[0])), median(src.map((p) => p[1]))];
    });
    if (rest.some((r) => !r)) { res.reason = 'Les trois billes ne sont pas toutes visibles'; res.ignored = true; return res; }

    // départs depuis le repos
    const dep = [0, 1, 2].map((b) => {
      const ps = P[b];
      for (let i = 0; i + win < n; i++) {
        const d0 = norm(sub(ps[i], rest[b]));
        if (d0 > 0.008 && norm(sub(ps[i + win], rest[b])) > d0 + 0.004) {
          const f = linFit(T, ps, i, Math.min(n - 1, i + win));
          if (!f) return null;
          const sp = norm(f.v);
          if (sp < 0.02) return null;
          let tc = f.tm - dot(sub(f.p, rest[b]), f.v) / (sp * sp);
          tc = clamp(tc, T[Math.max(0, i - 1)] - dt, T[i]);
          return { k: i, t: tc, v: f.v, speed: sp };
        }
      }
      return null;
    });

    // bille jouée
    let cue = -1;
    const order = [0, 1, 2].filter((b) => dep[b]).sort((a, b) => dep[a].t - dep[b].t);
    if (!order.length) { res.reason = 'Aucun mouvement de bille'; res.ignored = true; return res; }
    if (opts.player === 0 || opts.player === 1) {
      cue = opts.player;
      if (!dep[cue] || order[0] !== cue && dep[order[0]].t < dep[cue].t - 0.02) {
        res.foul = true; res.cue = order[0];
        res.reason = `Faute : la bille ${NAMES[order[0]]} est partie en premier (bille du joueur : ${NAMES[cue]})`;
        res.traj = P.map((ps) => ps && ps.filter((_, i) => i % 2 === 0));
        return res;
      }
    } else {
      cue = order[0];
    }
    res.cue = cue;
    if (cue === 2) res.notes.push('La rouge a bougé en premier : vérifiez la détection ou la bille jouée.');
    const others = [0, 1, 2].filter((b) => b !== cue);

    // position estimée d'une bille à l'instant t (avant tout choc à t)
    const idxBefore = (t) => { let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m] <= t) lo = m; else hi = m - 1; } return lo; };
    function posAt(b, t) {
      const dp = dep[b];
      if (!dp || t <= dp.t) return rest[b];
      const j = idxBefore(t);
      const i0 = Math.max(dp.k, j - win + 1);
      if (j - i0 < 1) return [rest[b][0] + dp.v[0] * (t - dp.t), rest[b][1] + dp.v[1] * (t - dp.t)];
      const f = linFit(T, P[b], i0, j);
      return f ? f.at(t) : P[b][j];
    }
    function velBefore(b, t) {
      const dp = dep[b];
      if (!dp || t <= dp.t) return [0, 0];
      const j = idxBefore(t), i0 = Math.max(dp.k, j - win + 1);
      if (j - i0 < 1) return dp.v;
      const f = linFit(T, P[b], i0, j);
      return f ? f.v : dp.v;
    }
    function findHitter(b, t, pb, dv) {
      let best = null;
      for (let c = 0; c < 3; c++) {
        if (c === b) continue;
        const pc = posAt(c, t), rel = sub(pb, pc), d = norm(rel);
        if (d > 1.42 * D || d < 0.5 * D) continue;
        if (dot(dv, rel) < 0.45 * norm(dv) * d) continue;
        if (!best || Math.abs(d - D) < Math.abs(best.d - D)) best = { c, d };
      }
      return best;
    }

    const rawContacts = [], cushions = [];
    let strikeFound = false;
    // 1) départs
    for (const b of [0, 1, 2]) {
      const dp = dep[b];
      if (!dp) continue;
      const h = findHitter(b, dp.t, rest[b], dp.v);
      if (h) rawContacts.push({ t: dp.t, a: b, b: h.c, d: h.d, p: rest[b] });
      else if (b === cue) strikeFound = true;
      else res.notes.push(`Départ inexpliqué de la ${NAMES[b]}`);
    }
    // 2) changements brusques de vitesse (chocs en mouvement, bandes)
    for (const b of [0, 1, 2]) {
      const dp = dep[b];
      if (!dp) continue;
      const cand = [];
      for (let j = dp.k + win + 1; j + win < n; j++) {
        const fb = linFit(T, P[b], j - win, j - 1), fa = linFit(T, P[b], j + 1, j + win);
        if (!fb || !fa) continue;
        const dv = sub(fa.v, fb.v), mag = norm(dv);
        const sp = Math.max(norm(fa.v), norm(fb.v));
        const thr = Math.max(0.10 + 0.12 * sp, 1.6 * mug * (fa.tm - fb.tm) + 0.04);
        if (mag > thr) cand.push({ j, r: mag / thr, fb, fa, dv });
      }
      const kept = cand.filter((c) => !cand.some((o) => o !== c && Math.abs(o.j - c.j) <= win && (o.r > c.r || (o.r === c.r && o.j < c.j))));
      for (const c of kept) {
        const dvv = sub(c.fb.v, c.fa.v);
        // instant où les deux droites (avant/après) se croisent le mieux
        const den = dot(dvv, dvv);
        let tc = den > 1e-9 ? -(dot(sub([c.fb.p[0] - c.fb.v[0] * c.fb.tm, c.fb.p[1] - c.fb.v[1] * c.fb.tm], [c.fa.p[0] - c.fa.v[0] * c.fa.tm, c.fa.p[1] - c.fa.v[1] * c.fa.tm]), dvv)) / den : T[c.j];
        tc = clamp(tc, T[c.j - 1], T[c.j + 1]);
        const pb = c.fb.at(tc);
        const h = findHitter(b, tc, pb, c.dv);
        if (h) { rawContacts.push({ t: tc, a: b, b: h.c, d: h.d, p: pb }); continue; }
        const rails = [
          { id: 'gauche', d: pb[0] - R, n: [1, 0] }, { id: 'droite', d: L - R - pb[0], n: [-1, 0] },
          { id: 'haut', d: pb[1] - R, n: [0, 1] }, { id: 'bas', d: W - R - pb[1], n: [0, -1] },
        ].sort((x, y) => x.d - y.d);
        const rl = rails[0];
        if (rl.d < 0.045 && dot(c.dv, rl.n) > 0.55 * norm(c.dv)) cushions.push({ t: tc, ball: b, rail: rl.id, p: pb });
      }
    }
    // fusion des doublons (un même choc vu par les deux billes)
    rawContacts.sort((x, y) => x.t - y.t);
    const contacts = [];
    for (const c of rawContacts) {
      const dup = contacts.find((o) => Math.abs(o.t - c.t) < 0.1 && ((o.a === c.a && o.b === c.b) || (o.a === c.b && o.b === c.a)));
      if (dup) { if (Math.abs(c.d - D) < Math.abs(dup.d - D)) { dup.d = c.d; dup.t = c.t; } }
      else contacts.push(Object.assign({}, c));
    }
    const cushionsM = [];
    for (const c of cushions.sort((x, y) => x.t - y.t)) {
      if (!cushionsM.some((o) => o.ball === c.ball && o.rail === c.rail && Math.abs(o.t - c.t) < 0.12)) cushionsM.push(c);
    }
    res.contacts = contacts; res.cushions = cushionsM;
    if (!strikeFound && !contacts.some((c) => c.a === cue || c.b === cue)) res.notes.push('Frappe de queue non identifiée');

    // séquence de la bille jouée
    const cueEvents = [];
    for (const c of contacts) if (c.a === cue || c.b === cue) cueEvents.push({ t: c.t, type: 'bille', ball: c.a === cue ? c.b : c.a, d: c.d, p: c.p });
    for (const c of cushionsM) if (c.ball === cue) cueEvents.push({ t: c.t, type: 'bande', rail: c.rail, p: c.p });
    cueEvents.sort((x, y) => x.t - y.t);
    res.sequence = cueEvents;

    // sortie de table
    for (let b = 0; b < 3; b++) {
      let lastSeen = -1;
      for (let i = 0; i < n; i++) if (frames[i].pos[b]) lastSeen = i;
      if (lastSeen >= 0 && T[n - 1] - T[lastSeen] > 0.6 && dep[b]) {
        const p = frames[lastSeen].pos[b];
        const edge = Math.min(p[0], L - p[0], p[1], W - p[1]);
        if (edge < 0.06) { res.jumped = b; res.notes.push(`La ${NAMES[b]} semble avoir quitté la table`); }
      }
    }

    // verdict (partie libre : la bille jouée doit toucher les deux autres)
    const touched = [];
    for (const e of cueEvents) if (e.type === 'bille' && !touched.some((x) => x.ball === e.ball)) touched.push(e);
    const nbBandes = (t) => cueEvents.filter((e) => e.type === 'bande' && e.t < t).length;
    // distance minimale d'approche pour les billes non touchées
    function minApproach(b) {
      let best = 1e9;
      for (let i = 0; i + 1 < n; i++) {
        const r0 = sub(P[cue][i], P[b][i]), r1 = sub(P[cue][i + 1], P[b][i + 1]), dr = sub(r1, r0);
        const den = dot(dr, dr), s = den > 1e-12 ? clamp(-dot(r0, dr) / den, 0, 1) : 0;
        best = Math.min(best, norm([r0[0] + s * dr[0], r0[1] + s * dr[1]]));
      }
      return best;
    }
    if (res.jumped != null) {
      res.valid = false; res.foul = true;
      res.reason = `Faute : bille ${NAMES[res.jumped]} sortie de la table`;
    } else if (touched.length >= 2) {
      res.valid = true;
      const [a, b] = touched;
      const k = nbBandes(b.t);
      res.reason = `Point : ${NAMES[a.ball]} puis ${NAMES[b.ball]}` + (k ? ` (${k} bande${k > 1 ? 's' : ''} avant la 2e bille)` : '');
    } else {
      const miss = others.filter((o) => !touched.some((x) => x.ball === o));
      const near = miss.map((o) => ({ o, d: minApproach(o) })).sort((x, y) => x.d - y.d)[0];
      res.reason = touched.length ? `Pas de point : seulement la ${NAMES[touched[0].ball]}` : 'Pas de point : aucune bille touchée';
      if (near) {
        res.closest = { ball: near.o, gap: Math.max(0, near.d - D) };
        res.reason += ` — la ${NAMES[near.o]} est passée à ${(Math.max(0, near.d - D) * 100).toFixed(1).replace('.', ',')} cm`;
      }
    }
    // confiance
    {
      const ds = touched.map((e) => e.d / D);
      let worst = ds.length ? Math.max(...ds.map((x) => Math.abs(x - 1))) : 0;
      let conf = worst < 0.2 ? 3 : worst < 0.33 ? 2 : 1;
      if (!res.valid && res.closest && res.closest.gap < 0.012) conf = Math.min(conf, 1);
      if (fps < 25) conf = Math.min(conf, 2);
      res.confidence = ['faible', 'faible', 'moyenne', 'haute'][conf];
      if (conf === 1) res.notes.push('Contact serré : à revoir au ralenti');
    }

    // ---------- effet ----------
    res.effect = { type: 'indetermine' };
    const first = cueEvents.find((e) => e.type === 'bille');
    if (first) {
      const t1 = first.t;
      const vin = velBefore(cue, t1), pc = posAt(cue, t1), pb = posAt(first.ball, t1);
      const u0 = sub(pb, pc), du = norm(u0), u = [u0[0] / du, u0[1] / du];
      const sp = norm(vin), a = dot(vin, u);
      const cut = Math.acos(clamp(a / (sp || 1), -1, 1)) * 180 / Math.PI;
      const next = cueEvents.find((e) => e.t > t1 + 0.02);
      const ts = t1 + Math.max(1.5 * dt, 0.02);
      let te = Math.min(t1 + 0.9, next ? next.t - 0.03 : 1e9, T[n - 1]);
      const ids = [];
      for (let i = 0; i < n; i++) if (T[i] >= ts && T[i] <= te) ids.push(i);
      // arrêter quand la bille est quasi immobile
      const eff = { type: 'indetermine', speed: sp, cut, conf: 'faible' };
      if (sp < 0.08) eff.note = 'Vitesse trop faible';
      else if (a < 0.25 * sp) eff.note = 'Touche trop fine pour juger l\'effet';
      else if (ids.length < 5 || T[ids[ids.length - 1]] - T[ids[0]] < 0.1) eff.note = 'Trajectoire après le choc trop courte (bande ou bille trop proche)';
      else {
        const i0 = ids[0], i1 = ids[ids.length - 1];
        const m = Math.max(win, Math.round(ids.length / 3));
        const fl = linFit(T, P[cue], Math.max(i0, i1 - m + 1), i1);
        const fe = linFit(T, P[cue], i0, Math.min(i1, i0 + m - 1));
        const vl = dot(fl.v, u), ve = dot(fe.v, u);
        const accU = (vl - ve) / Math.max(1e-3, fl.tm - fe.tm);
        // accélération sur la fin de fenêtre (glissement encore actif ?)
        const half = Math.max(i0, i1 - m + 1), mid = Math.round((half + i1) / 2);
        let accLate = 0;
        if (mid - half >= 2 && i1 - mid >= 2) {
          const f1 = linFit(T, P[cue], half, mid), f2 = linFit(T, P[cue], mid, i1);
          accLate = (dot(f2.v, u) - dot(f1.v, u)) / Math.max(1e-3, f2.tm - f1.tm);
        }
        const k = vl / a;
        let type = k < -0.06 ? 'retro' : k <= 0.13 ? 'amorti' : k <= 0.37 ? 'naturel' : 'coule';
        // durée de glissement attendue après le choc pour un coup naturel (bille qui roulait)
        const tNat = a / (3.5 * mug);
        // accélération de la bille jouée juste avant le choc (glissement encore actif ?)
        let accPre = 0;
        {
          const jb = idxBefore(t1 - 0.01), span = Math.max(2 * win, Math.round(0.16 * fps));
          const ja = Math.max(dep[cue].k + 1, jb - span + 1), jm = Math.round((ja + jb) / 2);
          if (jm - ja >= 2 && jb - jm >= 2) {
            const d0 = [vin[0] / sp, vin[1] / sp];
            const f1 = linFit(T, P[cue], ja, jm), f2 = linFit(T, P[cue], jm, jb);
            const noCushion = !cueEvents.some((e) => e.t > T[ja] && e.t < t1 - 0.005);
            if (f1 && f2 && noCushion) accPre = (dot(f2.v, d0) - dot(f1.v, d0)) / Math.max(1e-3, f2.tm - f1.tm);
          }
        }
        // stabilisé = plus d'accélération ET (aucune accélération du tout, ou fenêtre plus longue que le glissement d'un coup naturel)
        const settled = Math.abs(accLate) < 0.35 * mug && (Math.abs(accU) < 0.35 * mug || T[i1] - t1 > tNat);
        if (!settled) {
          if ((accLate > 0.4 * mug && T[i1] - t1 > 1.15 * tNat) || (accPre > 0.5 * mug && Math.max(accLate, accU) > 0.4 * mug)) type = 'coule';
          else if (accLate > 0.4 * mug && type === 'amorti') type = 'naturel';
          if (accLate < -0.4 * mug && (type === 'amorti' || type === 'naturel')) type = 'retro';
        }
        Object.assign(eff, { type, k, accU, accPre, conf: settled && T[i1] - T[i0] > 0.25 ? 'haute' : 'moyenne' });
      }
      eff.label = EFFECTS[eff.type];
      res.effect = eff;
    } else res.effect.label = EFFECTS.indetermine;

    // ---------- geste ----------
    res.gesture = analyzeGesture(opts.prep || [], cue, dep[cue] ? dep[cue].t : tStart, dep[cue] ? dep[cue].v : null);

    res.traj = P.map((ps) => ps && ps.filter((_, i) => i % Math.max(1, Math.round(fps / 30)) === 0));
    res.rest = rest;
    res.duration = T[n - 1] - tStart;
    return res;
  }

  function analyzeGesture(prep, cue, tHit, v0) {
    const g = { visible: false };
    if (cue > 1) { g.note = 'Bille rouge jouée'; return g; }
    let s = prep.filter((f) => f.t > tHit - 3.0 && f.t < tHit - 0.005 && f.feats && f.feats[cue]).map((f) => Object.assign({ t: f.t }, f.feats[cue]));
    const wrap = (d) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
    if (s.length >= 6) {
      // rejet des détections aberrantes (autre objet pris pour la queue)
      const a0 = s[0].angle, med = a0 + median(s.map((f) => wrap(f.angle - a0)));
      const kept = s.filter((f) => Math.abs(wrap(f.angle - med)) < 6 * Math.PI / 180);
      g.reliability = kept.length / s.length;
      s = kept;
    }
    if (s.length < 6 || s[s.length - 1].t - s[0].t < 0.4 || g.reliability < 0.6) { g.note = 'Queue peu visible avant la frappe'; return g; }
    g.visible = true;
    // angles déroulés autour de la médiane
    const ref = s[0].angle + median(s.map((f) => wrap(f.angle - s[0].angle)));
    const ang = s.map((f) => { let d = f.angle - ref; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; });
    const angStd = std(ang) * 180 / Math.PI;
    const offs = s.map((f) => f.offset * 100);
    g.angleStd = angStd;
    g.offsetMean = mean(offs);
    g.offsetStd = std(offs);
    // va-et-vient : extrema de la distance procédé–bille
    // série lissée (médiane sur 3) : la compression vidéo crée de faux petits va-et-vient
    const raw = s.map((f) => f.tipGap);
    const gaps = raw.map((v, i) => (i && i < raw.length - 1 ? median([raw[i - 1], v, raw[i + 1]]) : v));
    const hy = 0.02, ext = [];
    let dir = 0, ei = 0;
    for (let i = 1; i < gaps.length; i++) {
      if (dir >= 0) { if (gaps[i] > gaps[ei]) ei = i; else if (gaps[ei] - gaps[i] > hy) { ext.push({ type: 'max', i: ei }); dir = -1; ei = i; } }
      if (dir < 0) { if (gaps[i] < gaps[ei]) ei = i; else if (gaps[i] - gaps[ei] > hy) { ext.push({ type: 'min', i: ei }); dir = 1; ei = i; } }
    }
    // le dernier recul est la reprise avant la frappe : on l'écarte du calcul du rythme
    const maxs = ext.filter((e) => e.type === 'max').slice(0, -1);
    g.strokes = maxs.length;
    if (maxs.length >= 2) {
      const per = []; for (let i = 1; i < maxs.length; i++) per.push(s[maxs[i].i].t - s[maxs[i - 1].i].t);
      const amps = maxs.map((m) => gaps[m.i] - Math.min(...gaps.slice(m.i)));
      g.period = mean(per);
      g.periodCV = per.length > 1 ? std(per) / mean(per) : 0;
      g.ampCV = std(amps) / (mean(amps) || 1);
      g.amp = mean(amps) * 100;
    }
    if (v0) {
      const meanAng = ref + Math.atan2(mean(ang.map(Math.sin)), mean(ang.map(Math.cos)));
      const dv = Math.atan2(v0[1], v0[0]);
      let dev = dv - meanAng; while (dev > Math.PI) dev -= 2 * Math.PI; while (dev < -Math.PI) dev += 2 * Math.PI;
      g.deviation = dev * 180 / Math.PI;
    }
    g.straightness = Math.round(clamp(100 - g.angleStd * 14 - g.offsetStd * 18 - Math.abs(g.deviation || 0) * 6, 0, 100));
    g.regularity = g.periodCV != null ? Math.round(clamp(100 - g.periodCV * 140 - g.ampCV * 70, 0, 100)) : null;
    const c = [];
    c.push(g.angleStd < 0.6 ? 'Queue très stable en direction' : g.angleStd < 1.5 ? 'Direction de queue correcte' : 'La queue change de direction pendant les va-et-vient');
    if (g.offsetStd > 0.4) c.push('Le procédé se déplace latéralement par rapport à la bille');
    if (g.deviation != null && Math.abs(g.deviation) > 1.5) c.push(`La bille part ${g.deviation > 0 ? 'à gauche' : 'à droite'} de l'axe de la queue (${Math.abs(g.deviation).toFixed(1)}°) : effet latéral ou geste qui croise`);
    if (g.strokes >= 2 && g.periodCV > 0.25) c.push('Rythme des va-et-vient irrégulier');
    else if (g.strokes >= 2) c.push('Rythme des va-et-vient régulier');
    if (g.strokes < 2) c.push('Pas assez de va-et-vient visibles pour juger le rythme');
    g.comments = c;
    return g;
  }

  // ---------- session temps réel ----------
  class Session {
    constructor(detector, cfg = {}) {
      this.det = detector;
      this.cfg = Object.assign({ player: 'auto', mug: 1.96, gesture: true }, cfg);
      this.state = 'idle';
      this.buf = [];
      this.track = [null, null, null];
      this.moveCount = [0, 0, 0];
      this.shot = null;
    }
    reset() { this.state = 'idle'; this.buf = []; this.track = [null, null, null]; this.shot = null; }

    _assign(blobs, t) {
      const pos = [null, null, null];
      for (let b = 0; b < 3; b++) {
        const tr = this.track[b], cands = blobs[b];
        if (!cands.length) { if (tr) tr.miss++; continue; }
        let best = null, bestS = 1e9;
        if (tr && tr.miss < 30) {
          const dtt = Math.min(0.2, t - tr.t);
          const pred = [tr.p[0] + tr.v[0] * dtt, tr.p[1] + tr.v[1] * dtt];
          const gate = 0.07 + norm(tr.v) * dtt * 1.5 + 0.02 * tr.miss;
          for (const c of cands) {
            const d = hyp(c.x - pred[0], c.y - pred[1]);
            if (d > gate) continue;
            const s = d + 0.02 * c.score;
            if (s < bestS) { bestS = s; best = c; }
          }
        }
        if (!best && (!tr || tr.miss >= 3)) {
          for (const c of cands) { const s = c.score - 0.0005 * c.area; if (s < bestS) { bestS = s; best = c; } }
        }
        if (!best) { if (tr) tr.miss++; continue; }
        const p = [best.x, best.y];
        if (tr && tr.miss < 10 && t > tr.t) {
          const v = [(p[0] - tr.p[0]) / (t - tr.t), (p[1] - tr.p[1]) / (t - tr.t)];
          tr.v = [0.5 * tr.v[0] + 0.5 * v[0], 0.5 * tr.v[1] + 0.5 * v[1]];
          tr.p = p; tr.t = t; tr.miss = 0;
        } else this.track[b] = { p, v: [0, 0], t, miss: 0 };
        pos[b] = p;
      }
      return pos;
    }

    /** Traite une image ; renvoie {pos, state, event?} */
    process(img, t) {
      const blobs = this.det.detect(img);
      const pos = this._assign(blobs, t);
      let feats = null;
      if (this.state === 'idle' && this.cfg.gesture && this.det.cloth) {
        feats = [0, 1].map((b) => (pos[b] ? this.det.cueFeatures(img, pos[b], pos) : null));
      }
      const fr = { t, pos, feats };
      let event = null;
      if (this.state === 'idle') {
        this.buf.push(fr);
        while (this.buf.length && t - this.buf[0].t > 3.6) this.buf.shift();
        // repos = médiane des 0,4 s précédentes (hors image courante)
        const past = this.buf.filter((f) => f !== fr && t - f.t < 0.6 && t - f.t > 0.08);
        let start = false;
        for (let b = 0; b < 3; b++) {
          const ps = past.map((f) => f.pos[b]).filter(Boolean);
          if (!pos[b] || ps.length < 3) { this.moveCount[b] = 0; continue; }
          const r = [median(ps.map((p) => p[0])), median(ps.map((p) => p[1]))];
          if (hyp(pos[b][0] - r[0], pos[b][1] - r[1]) > 0.012) this.moveCount[b]++; else this.moveCount[b] = 0;
          if (this.moveCount[b] >= 2) start = true;
        }
        if (start) {
          this.state = 'shot';
          const tStart = t - 0.1;
          this.shot = { tStart, frames: this.buf.filter((f) => f.t >= tStart - 0.5), prep: this.buf.slice() };
          event = { type: 'start' };
          this.moveCount = [0, 0, 0];
        }
      } else if (this.state === 'shot') {
        this.shot.frames.push(fr);
        const fs = this.shot.frames, recent = fs.filter((f) => t - f.t <= 0.6);
        let still = t - this.shot.tStart > 0.8 && recent.length >= 4 && fs[0] && t - recent[0].t > 0.45;
        if (still) for (let b = 0; b < 3; b++) {
          const ps = recent.map((f) => f.pos[b]).filter(Boolean);
          if (ps.length < 2) continue;
          const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
          if (Math.max(...xs) - Math.min(...xs) > 0.012 || Math.max(...ys) - Math.min(...ys) > 0.012) { still = false; break; }
        }
        if (still || t - this.shot.tStart > 25) {
          const result = analyzeShot(this.shot.frames, {
            table: this.det.table, tStart: this.shot.tStart, player: this.cfg.player, mug: this.cfg.mug, prep: this.shot.prep,
          });
          result.time = Date.now();
          event = { type: 'end', result };
          this.state = 'idle';
          this.buf = this.shot.frames.slice(-5).map((f) => ({ t: f.t, pos: f.pos, feats: null }));
          this.shot = null;
        }
      }
      return { pos, state: this.state, event, blobs };
    }
  }

  return { Detector, Session, analyzeShot, analyzeGesture, homography, project, TABLES, NAMES, EFFECTS, BALL_D, BALL_R, DEFAULT_COLORS };
});
