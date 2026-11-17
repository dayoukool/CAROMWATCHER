// Simulateur de billard (physique glissement/roulement + rendu caméra en perspective)
// Sert à vérifier le moteur d'analyse sans table réelle.
const E = require('../engine.js');
const L = 2.84, W = 1.42, R = E.BALL_R, D = E.BALL_D, G = 9.81, MU = 0.2, MUR = 0.012;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/** Simule un coup. balls: [[x,y]×3]; strike: {cue, dir(rad), v0, spin}. Renvoie {samples(t)->pos, events, truth} */
function simulate(balls, strike, tMax = 12) {
  const st = balls.map((p) => ({ p: p.slice(), v: [0, 0], w: [0, 0] }));
  const c = strike.cue, d = [Math.cos(strike.dir), Math.sin(strike.dir)];
  st[c].v = [strike.v0 * d[0], strike.v0 * d[1]];
  st[c].w = [strike.spin * st[c].v[0], strike.spin * st[c].v[1]];
  const dt = 0.0004, hist = [], events = [];
  let t = 0, truth = null, pending = null;
  const finalize = (settled) => { const b = st[c], vf = [(5 * b.v[0] + 2 * b.w[0]) / 7, (5 * b.v[1] + 2 * b.w[1]) / 7]; pending.kNow = (b.v[0] * pending.u[0] + b.v[1] * pending.u[1]) / pending.a; pending.k = (vf[0] * pending.u[0] + vf[1] * pending.u[1]) / pending.a; pending.done = true; pending.settled = settled; };
  hist.push({ t: 0, pos: st.map((b) => b.p.slice()) });
  while (t < tMax) {
    for (const b of st) {
      const s = [b.v[0] - b.w[0], b.v[1] - b.w[1]], sm = Math.hypot(s[0], s[1]);
      if (sm > 2e-3) {
        const sh = [s[0] / sm, s[1] / sm], dv = MU * G * dt;
        if (3.5 * dv >= sm) { const vf = [(5 * b.v[0] + 2 * b.w[0]) / 7, (5 * b.v[1] + 2 * b.w[1]) / 7]; b.v = vf; b.w = vf.slice(); }
        else { b.v[0] -= dv * sh[0]; b.v[1] -= dv * sh[1]; b.w[0] += 2.5 * dv * sh[0]; b.w[1] += 2.5 * dv * sh[1]; }
      } else {
        const sp = Math.hypot(b.v[0], b.v[1]);
        if (sp < 0.004) { b.v = [0, 0]; b.w = [0, 0]; }
        else { const f = Math.max(0, sp - MUR * G * dt) / sp; b.v = [b.v[0] * f, b.v[1] * f]; b.w = b.v.slice(); }
      }
      b.p[0] += b.v[0] * dt; b.p[1] += b.v[1] * dt;
    }
    t += dt;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const a = st[i], b = st[j], dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], dd = Math.hypot(dx, dy);
      if (dd < D) {
        const n = [dx / dd, dy / dd], rel = (a.v[0] - b.v[0]) * n[0] + (a.v[1] - b.v[1]) * n[1];
        if (rel > 0) {
          if ((i === c || j === c) && pending && !pending.done) finalize(false);
          const imp = rel * (1 + 0.94) / 2;
          a.v[0] -= imp * n[0]; a.v[1] -= imp * n[1]; b.v[0] += imp * n[0]; b.v[1] += imp * n[1];
          events.push({ t, type: 'bille', i, j });
          if (!truth && (i === c || j === c)) {
            const o = i === c ? j : i, u = i === c ? n : [-n[0], -n[1]];
            const vin = [st[c].v[0] + imp * u[0], st[c].v[1] + imp * u[1]];
            pending = { u, a: vin[0] * u[0] + vin[1] * u[1], t, obj: o };
            truth = pending;
          }
        }
        const ov = (D - dd) / 2; a.p[0] -= ov * n[0]; a.p[1] -= ov * n[1]; b.p[0] += ov * n[0]; b.p[1] += ov * n[1];
      }
    }
    st.forEach((b, i) => {
      const hit = (ax) => { if (i === c && pending && !pending.done) finalize(false); b.v[ax] = -0.8 * b.v[ax]; b.w[ax] = -0.3 * b.w[ax]; events.push({ t, type: 'bande', i }); };
      if (b.p[0] < R && b.v[0] < 0) hit(0); if (b.p[0] > L - R && b.v[0] > 0) hit(0);
      if (b.p[1] < R && b.v[1] < 0) hit(1); if (b.p[1] > W - R && b.v[1] > 0) hit(1);
    });
    // vérité terrain de l'effet : vitesse de la bille jouée quand elle finit de glisser
    if (pending && !pending.done) {
      const b = st[c], s = Math.hypot(b.v[0] - b.w[0], b.v[1] - b.w[1]);
      if (s < 3e-3 || t - pending.t > 1.5) finalize(s < 3e-3);
    }
    hist.push({ t, pos: st.map((b) => b.p.slice()) });
    if (t > 0.3 && st.every((b) => b.v[0] === 0 && b.v[1] === 0)) break;
  }
  hist.push({ t, pos: st.map((b) => b.p.slice()) });
  const sample = (tq) => {
    if (tq <= 0) return hist[0].pos;
    let lo = 0, hi = hist.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (hist[m].t <= tq) lo = m; else hi = m - 1; }
    if (lo >= hist.length - 1) return hist[lo].pos;
    const a = hist[lo], b = hist[lo + 1], f = (tq - a.t) / (b.t - a.t);
    return a.pos.map((p, i) => [p[0] + f * (b.pos[i][0] - p[0]), p[1] + f * (b.pos[i][1] - p[1])]);
  };
  return { sample, events, truth, tEnd: t, hist };
}

// ---------- rendu ----------
const IW = 640, IH = 360;
const CORNERS = [[96, 58], [548, 60], [612, 330], [28, 326]];
const COL = { cloth: [38, 92, 168], rail: [92, 58, 30], floor: [40, 40, 44], ball: [[238, 238, 228], [236, 196, 36], [196, 28, 34]], cue: [214, 182, 132], hand: [196, 148, 118] };

/** Points de calibrage vus par la caméra (coins + milieux des bandes), objectif k1 compris. */
function calibPoints(k1 = 0) {
  const ideal = E.makeProjector(IW, IH, CORNERS, { L, W }, 0), lens = E.makeLens(IW, IH, k1);
  const im = (p) => { const q = ideal.toImage(p[0], p[1]); return lens.dist(q[0], q[1]); };
  return { corners: [[0, 0], [L, 0], [L, W], [0, W]].map(im), mids: [[L / 2, 0], [L, W / 2], [L / 2, W], [0, W / 2]].map(im) };
}

function makeRenderer(seed, k1 = 0) {
  // CORNERS = coins dans l'image idéale (sans déformation) ; l'objectif k1 déforme ensuite l'image
  const H = E.homography(CORNERS, [[0, 0], [L, 0], [L, W], [0, W]]), lens = E.makeLens(IW, IH, k1);
  const n = IW * IH, tx = new Float32Array(n), ty = new Float32Array(n);
  for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) { const q = lens.undist(x + 0.5, y + 0.5); const p = E.project(H, q[0], q[1]); tx[y * IW + x] = p[0]; ty[y * IW + x] = p[1]; }
  const r = rng(seed);
  const noise = new Int8Array(n * 3 * 4); for (let i = 0; i < noise.length; i++) noise[i] = Math.round(gauss(r) * 5);
  let frameNo = 0;
  return function render(pos, cue) {
    const img = new Uint8ClampedArray(n * 4), off = (frameNo++ % 4) * n * 3;
    for (let i = 0; i < n; i++) {
      const X = tx[i], Y = ty[i];
      let c;
      const out = Math.max(-X, X - L, -Y, Y - W);
      if (out > 0.13) c = COL.floor; else if (out > 0) c = COL.rail; else {
        c = COL.cloth;
        for (let b = 0; b < 3; b++) {
          const dx = X - pos[b][0], dy = Y - pos[b][1], d2 = dx * dx + dy * dy;
          if (d2 < R * R) {
            const sh = 0.78 + 0.3 * (1 - d2 / (R * R));
            const hl = (dx + 0.009) ** 2 + (dy + 0.009) ** 2 < 0.00003;
            c = hl ? [255, 255, 250] : COL.ball[b].map((v) => v * sh);
            break;
          }
        }
      }
      if (cue) {
        // main de pont (ellipse) puis queue (segment s'élargissant)
        const hx = X - cue.hand[0], hy = Y - cue.hand[1];
        const ha = hx * cue.u[0] + hy * cue.u[1], hb = -hx * cue.u[1] + hy * cue.u[0];
        if ((ha / 0.05) ** 2 + (hb / 0.045) ** 2 < 1) c = COL.hand;
        const qx = X - cue.tip[0], qy = Y - cue.tip[1];
        const along = -(qx * cue.u[0] + qy * cue.u[1]), perp = Math.abs(-qx * cue.u[1] + qy * cue.u[0]);
        if (along >= 0 && along < 1.45 && perp < 0.0065 + along * 0.0058) c = along > 0.8 && along < 0.83 ? [30, 20, 15] : COL.cue;
      }
      img[4 * i] = c[0] + noise[off + 3 * i]; img[4 * i + 1] = c[1] + noise[off + 3 * i + 1]; img[4 * i + 2] = c[2] + noise[off + 3 * i + 2]; img[4 * i + 3] = 255;
    }
    return { data: img, width: IW, height: IH };
  };
}

/** Mouvement de queue avant la frappe. irregular : rythme et direction instables */
function cueMotion(ball, dir, irregular, seed) {
  const r = rng(seed);
  const strokes = [];
  let total = 0;
  for (let i = 0; i < 3; i++) { const p = 0.75 * (irregular ? 1 + (r() - 0.5) * 0.8 : 1); strokes.push({ p, a: 0.11 * (irregular ? 1 + (r() - 0.5) * 0.7 : 1) }); total += p; }
  const finalBack = 0.55; total += finalBack;
  const wob = irregular ? 2.2 : 0.25, latw = irregular ? 0.008 : 0.001;
  const phase = r() * 6;
  return function (t) { // t<0 : avant la frappe (t=0)
    const tt = t + total;
    if (tt < 0) return null;
    let gap;
    if (tt >= total - finalBack) { const f = (tt - (total - finalBack)) / finalBack; gap = 0.13 * Math.sin(Math.PI * Math.min(f, 1) * 0.999) * (f < 0.5 ? 1 : 1) ; if (f > 0.5) gap = 0.13 * (1 - (f - 0.5) / 0.5) ** 1.5; }
    else { let acc = 0, k = 0; while (k < strokes.length - 1 && tt > acc + strokes[k].p) { acc += strokes[k].p; k++; } const f = (tt - acc) / strokes[k].p; gap = 0.02 + strokes[k].a * (1 - Math.cos(2 * Math.PI * f)) / 2; }
    const ang = dir + (wob * Math.PI / 180) * Math.sin(2 * Math.PI * tt / 0.9 + phase);
    const u = [Math.cos(ang), Math.sin(ang)];
    const lat = latw * Math.sin(2 * Math.PI * tt / 1.3 + phase);
    const nrm = [-u[1], u[0]];
    const base = [ball[0] + lat * nrm[0], ball[1] + lat * nrm[1]];
    const tip = [base[0] - u[0] * (R + gap), base[1] - u[1] * (R + gap)];
    const hand = [ball[0] - u[0] * 0.2, ball[1] - u[1] * 0.2];
    return { tip, u, hand };
  };
}

module.exports = { simulate, makeRenderer, cueMotion, calibPoints, CORNERS, L, W, R, D, IW, IH, rng };
