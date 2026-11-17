// Banc d'essai : génère des coups simulés, les filme virtuellement et compare l'analyse à la vérité.
const E = require('../engine.js');
const S = require('./sim.js');
const { L, W, D } = S;
const TABLE = { L, W };
const effOf = (k) => (k < -0.06 ? 'retro' : k <= 0.13 ? 'amorti' : k <= 0.37 ? 'naturel' : 'coule');

function inTable(p) { return p[0] > 0.08 && p[0] < L - 0.08 && p[1] > 0.08 && p[1] < W - 0.08; }

/** Construit un coup : bille objet B1, direction de départ psi, angle de coupe phi, distance, effet. */
function build(sc) {
  const { cue, b1, psi, phi, dist, v0, spin, off } = sc;
  const B1 = sc.b1pos;
  const ps = psi * Math.PI / 180, al = (psi + phi) * Math.PI / 180;
  const Gp = [B1[0] - D * Math.cos(ps), B1[1] - D * Math.sin(ps)];
  const C = [Gp[0] - dist * Math.cos(al), Gp[1] - dist * Math.sin(al)];
  const third = [0, 1, 2].find((b) => b !== cue && b !== b1);
  const far = [[0.15, 0.15], [L - 0.15, 0.15], [L - 0.15, W - 0.15], [0.15, W - 0.15]].sort((a, b) => Math.hypot(b[0] - C[0], b[1] - C[1]) + Math.hypot(b[0] - B1[0], b[1] - B1[1]) - Math.hypot(a[0] - C[0], a[1] - C[1]) - Math.hypot(a[0] - B1[0], a[1] - B1[1]))[0];
  const balls = []; balls[cue] = C; balls[b1] = B1; balls[third] = far;
  if (!inTable(C)) return null;
  const strike = { cue, dir: al, v0, spin };
  const s1 = S.simulate(balls, strike);
  if (!s1.truth || s1.truth.obj !== b1) return null;
  // place la 3e bille sur la trajectoire de la bille jouée après le choc
  const t1 = s1.truth.t;
  const after = s1.hist.filter((h) => h.t > t1 + 0.12);
  const cp = s1.sample(t1)[cue];
  let pick = null;
  for (const h of after) {
    const p = h.pos[cue];
    if (Math.hypot(p[0] - cp[0], p[1] - cp[1]) < (sc.placeDist || 0.3)) continue;
    // vitesse locale pour le décalage perpendiculaire
    const h2 = s1.sample(h.t + 0.02)[cue];
    const v = [h2[0] - p[0], h2[1] - p[1]], vn = Math.hypot(v[0], v[1]);
    if (vn < 1e-5) break;
    const nrm = [-v[1] / vn, v[0] / vn];
    const cand = [p[0] + nrm[0] * (off + D * (sc.ahead ? 0 : 0)) + v[0] / vn * D * 1.1, p[1] + nrm[1] * off + v[1] / vn * D * 1.1];
    if (!inTable(cand)) continue;
    // ne doit pas gêner la trajectoire avant ce moment ni celle de B1
    const ok = s1.hist.every((g) => (g.t > h.t - 0.05 || Math.hypot(g.pos[cue][0] - cand[0], g.pos[cue][1] - cand[1]) > 1.25 * D) && (g.t > h.t + 0.3 || Math.hypot(g.pos[b1][0] - cand[0], g.pos[b1][1] - cand[1]) > 1.4 * D));
    if (ok) { pick = cand; break; }
  }
  if (!pick) return null;
  balls[third] = pick;
  const s2 = S.simulate(balls, strike);
  return { balls, strike, sim: s2, third };
}

function run(sc, verbose) {
  const b = build(sc);
  if (!b) return { skip: true };
  const { sim, balls, strike } = b;
  const fps = sc.fps;
  const render = S.makeRenderer(sc.seed || 1);
  const r = S.rng((sc.seed || 1) * 7 + 3);
  const corners = S.CORNERS.map((c) => [c[0] + (r() - 0.5) * 3, c[1] + (r() - 0.5) * 3]);
  const det = new E.Detector(S.IW, S.IH, corners, TABLE);
  const motion = S.cueMotion(balls[strike.cue], strike.dir, !!sc.irregular, sc.seed || 1);
  const t0 = -3.2;
  det.learnCloth(render(sim.sample(0), null));
  const ses = new E.Session(det, { player: sc.player != null ? sc.player : 'auto' });
  let result = null;
  const tEnd = sim.tEnd + 2.5;
  for (let k = 0; ; k++) {
    const t = t0 + k / fps;
    if (t > tEnd) break;
    const cue = t < 0 ? motion(t) : t < 0.04 ? motion(-1e-4) : null;
    const pos = sim.sample(t);
    const out = ses.process(render(pos, cue), t + 100);
    if (out.event && out.event.type === 'end') { result = out.event.result; break; }
  }
  // vérité terrain
  const cue = strike.cue;
  const touched = new Set(sim.events.filter((e) => e.type === 'bille' && (e.i === cue || e.j === cue)).map((e) => (e.i === cue ? e.j : e.i)));
  const truthValid = touched.size === 2;
  const truthEff = sim.truth && sim.truth.a / sc.v0 > 0.25 ? effOf(sim.truth.k) : null;
  return { result, truthValid, truthEff, kTrue: sim.truth && sim.truth.k, settled: sim.truth && sim.truth.settled };
}

function genScenarios() {
  const R = S.rng(42);
  const scs = [];
  const spins = [-1.6, -1.0, -0.5, 0, 0.6, 1.0, 1.6, 2.2];
  let id = 0;
  for (const fps of [30, 60, 120]) {
    for (let i = 0; i < 16; i++) {
      const b1 = R() < 0.5 ? 2 : (R() < 0.5 ? 1 : 0);
      let cue = R() < 0.6 ? 0 : 1; if (cue === b1) cue = b1 === 0 ? 1 : 0;
      scs.push({
        id: id++, fps, cue, b1, b1pos: [0.9 + R() * 1.0, 0.45 + R() * 0.5], psi: R() * 360, phi: (R() - 0.5) * 70,
        dist: 0.25 + R() * 0.5, v0: 1.0 + R() * 2.0, spin: spins[(R() * spins.length) | 0], off: R() < 0.7 ? (R() - 0.5) * 0.04 : (R() < 0.5 ? 1 : -1) * (0.075 + R() * 0.06),
        irregular: R() < 0.4, seed: id * 13 + 5, placeDist: 0.2 + R() * 0.3,
      });
    }
  }
  return scs;
}
module.exports = { build, run, genScenarios };

if (require.main === module) {
  const only = process.argv[2] ? process.argv[2].split(',').map(Number) : null;
  const scs = genScenarios().filter((s) => !only || only.includes(s.id));
  let n = 0, okV = 0, effN = 0, effOk = 0, skip = 0, missing = 0;
  const confusion = {};
  const gest = { reg: [], irr: [] };
  for (const sc of scs) {
    const o = run(sc);
    if (o.skip) { skip++; continue; }
    if (!o.result) { missing++; console.log(`#${sc.id} fps${sc.fps} PAS DE RÉSULTAT`); continue; }
    n++;
    const r = o.result;
    const vOk = r.valid === o.truthValid;
    if (vOk) okV++;
    let effStr = '';
    if (o.truthEff && r.effect.type !== 'indetermine') {
      effN++; const good = r.effect.type === o.truthEff; if (good) effOk++;
      const key = o.truthEff + '→' + r.effect.type; confusion[key] = (confusion[key] || 0) + 1;
      effStr = `effet vrai ${o.truthEff}(k=${o.kTrue.toFixed(2)}) mesuré ${r.effect.type}(k=${r.effect.k != null ? r.effect.k.toFixed(2) : '-'}) ${good ? '✓' : '✗'}`;
    } else effStr = `effet: ${r.effect.type} ${r.effect.note || ''} (vrai ${o.truthEff || 'n/a'})`;
    if (r.gesture && r.gesture.visible) (sc.irregular ? gest.irr : gest.reg).push(r.gesture);
    console.log(`#${sc.id} fps${sc.fps} ${vOk ? '✓' : '✗'} vrai=${o.truthValid ? 'POINT' : 'non'} | ${r.reason} [${r.confidence}] | ${effStr} | geste ${r.gesture.visible ? `rect ${r.gesture.straightness} rég ${r.gesture.regularity} dev ${r.gesture.deviation != null ? r.gesture.deviation.toFixed(1) : '-'}° (${sc.irregular ? 'irrég' : 'rég'})` : r.gesture.note}`);
  }
  console.log(`\nVerdict correct : ${okV}/${n}  (ignorés à la génération ${skip}, sans résultat ${missing})`);
  console.log(`Effet correct : ${effOk}/${effN}`, confusion);
  const avg = (a, f) => (a.length ? (a.reduce((s, g) => s + (f(g) || 0), 0) / a.length).toFixed(1) : '-');
  console.log(`Geste régulier : rectitude ${avg(gest.reg, (g) => g.straightness)} régularité ${avg(gest.reg, (g) => g.regularity)} (n=${gest.reg.length})`);
  console.log(`Geste irrégulier : rectitude ${avg(gest.irr, (g) => g.straightness)} régularité ${avg(gest.irr, (g) => g.regularity)} (n=${gest.irr.length})`);
}
