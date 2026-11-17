// Sources d'images pour le serveur : la caméra du Pi (rpicam-vid) ou un simulateur (tests).
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');

/** YUV 4:2:0 planaire (sortie rpicam-vid --codec yuv420) → RGBA. Plage « vidéo » BT.601 (16–235). */
function yuv420ToRGBA(buf, w, h, out) {
  const ySize = w * h, cw = w >> 1, uOff = ySize, vOff = ySize + (ySize >> 2);
  for (let y = 0; y < h; y++) {
    const cRow = (y >> 1) * cw;
    for (let x = 0; x < w; x++) {
      const Y = 1.164 * (buf[y * w + x] - 16);
      const ci = cRow + (x >> 1), U = buf[uOff + ci] - 128, V = buf[vOff + ci] - 128;
      const o = (y * w + x) * 4;
      out[o] = Y + 1.596 * V;
      out[o + 1] = Y - 0.392 * U - 0.813 * V;
      out[o + 2] = Y + 2.017 * U;
      out[o + 3] = 255;
    }
  }
  return out;
}

function findBinary() {
  for (const b of ['rpicam-vid', 'libcamera-vid']) {
    try { execSync(`command -v ${b}`, { stdio: 'ignore' }); return b; } catch (e) { /* suivant */ }
  }
  return null;
}

/**
 * Caméra Raspberry Pi. Appelle onFrame({rgba, w, h, t}) pour chaque image complète.
 * Les images sont horodatées à leur arrivée (horloge monotone, en secondes).
 */
class RpicamSource {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.proc = null; this.stopped = false; }
  start(onFrame) {
    const c = this.cfg, w = c.width, h = c.height, size = w * h * 3 / 2;
    const bin = findBinary();
    if (!bin) { this.log('ERREUR : rpicam-vid introuvable (sudo apt install rpicam-apps)'); this.error = 'rpicam-vid introuvable'; return; }
    const args = ['-t', '0', '-n', '--codec', 'yuv420', '--width', String(w), '--height', String(h),
      '--framerate', String(c.fps), '--denoise', 'cdn_off', '-o', '-'];
    if (c.shutter) args.push('--shutter', String(c.shutter));
    if (c.focusDistance) args.push('--autofocus-mode', 'manual', '--lens-position', (1 / c.focusDistance).toFixed(3));
    if (Array.isArray(c.extraArgs)) args.push(...c.extraArgs);
    this.log(`caméra : ${bin} ${args.join(' ')}`);
    const rgba = new Uint8ClampedArray(w * h * 4);
    let acc = Buffer.alloc(size * 2), fill = 0;
    this.proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (d) => { const s = String(d).trim(); if (/error|ERROR|fail/i.test(s)) this.log('rpicam : ' + s.slice(0, 300)); });
    this.proc.stdout.on('data', (chunk) => {
      if (fill + chunk.length > acc.length) { const n = Buffer.alloc(fill + chunk.length + size); acc.copy(n, 0, 0, fill); acc = n; }
      chunk.copy(acc, fill); fill += chunk.length;
      let off = 0;
      while (fill - off >= size) {
        const t = Number(process.hrtime.bigint()) / 1e9;
        // Seule la dernière image complète du paquet est convertie (les autres seraient de toute façon sautées).
        if (fill - off < 2 * size) { yuv420ToRGBA(acc.subarray(off, off + size), w, h, rgba); onFrame({ rgba, w, h, t }); }
        else onFrame(null);
        off += size;
      }
      if (off) { acc.copy(acc, 0, off, fill); fill -= off; }
    });
    this.proc.on('exit', (code) => {
      if (this.stopped) return;
      this.log(`rpicam-vid s'est arrêté (code ${code}) ; redémarrage dans 3 s`);
      this.error = `caméra arrêtée (code ${code})`;
      setTimeout(() => { this.error = null; this.start(onFrame); }, 3000);
    });
  }
  stop() { this.stopped = true; if (this.proc) this.proc.kill(); }
}

/**
 * Caméra simulée : joue en boucle des coups générés par le simulateur de test.
 * Traitement synchrone (aucune image sautée) et horodatage simulé.
 */
class SimSource {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.stopped = false; this.truths = []; }
  start(onFrame) {
    const S = require(path.join(__dirname, '..', 'test', 'sim.js'));
    const R = require(path.join(__dirname, '..', 'test', 'run.js'));
    const fps = this.cfg.fps || 60, k1 = this.cfg.k1 || 0;
    this.w = S.IW; this.h = S.IH;
    this.calib = S.calibPoints(k1);
    const scenarios = R.genScenarios().filter((s) => s.fps === 60);
    const ids = this.cfg.scenarios || scenarios.map((s) => s.id);
    let si = 0, clock = 0;
    const render = S.makeRenderer(1, k1);
    const playShot = () => {
      if (this.stopped) return;
      let b = null, sc = null;
      for (let tries = 0; tries < scenarios.length && !b; tries++) {
        sc = scenarios.find((s) => s.id === ids[si % ids.length]); si++;
        b = sc && R.build(sc);
      }
      if (!b) { this.log('simulateur : aucun scénario constructible'); return; }
      const cue = b.strike.cue;
      const touched = new Set(b.sim.events.filter((e) => e.type === 'bille' && (e.i === cue || e.j === cue)).map((e) => (e.i === cue ? e.j : e.i)));
      this.truths.push({ id: sc.id, valid: touched.size === 2 });
      const motion = S.cueMotion(b.balls[cue], b.strike.dir, !!sc.irregular, sc.seed);
      const t0 = clock, tEnd = b.sim.tEnd + 2.0;
      let k = 0;
      const wall0 = Date.now();
      const step = () => {
        if (this.stopped) return;
        const ts = -3.2 + k / fps;
        if (ts > tEnd) { clock = t0 + (tEnd + 3.2) + 0.5; setTimeout(playShot, 10); return; }
        const pos = b.sim.sample(ts);
        const cueM = ts < 0 ? motion(ts) : ts < 0.04 ? motion(-1e-4) : null;
        const img = render(pos, cueM);
        onFrame({ rgba: img.data, w: this.w, h: this.h, t: t0 + ts + 3.2 }, true);
        k++;
        const due = wall0 + (k * 1000) / fps * (this.cfg.speed ? 1 / this.cfg.speed : 1);
        setTimeout(step, Math.max(0, due - Date.now()));
      };
      step();
    };
    playShot();
  }
  stop() { this.stopped = true; }
}

function createSource(cfg, log) {
  return cfg.type === 'sim' ? new SimSource(cfg, log) : new RpicamSource(cfg, log);
}

module.exports = { createSource, yuv420ToRGBA };
