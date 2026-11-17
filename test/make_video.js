// Génère une vidéo MP4 d'un coup simulé (pour tester la page de bout en bout).
// Usage : node test/make_video.js <id scénario> <sortie.mp4>
const { spawn } = require('child_process');
const S = require('./sim.js');
const { build, genScenarios } = require('./run.js');

const id = +(process.argv[2] || 16), out = process.argv[3] || '/tmp/coup.mp4';
const sc = genScenarios().find((s) => s.id === id);
const b = build(sc);
if (!b) { console.error('scénario non constructible'); process.exit(1); }
const fps = sc.fps, render = S.makeRenderer(sc.seed);
const motion = S.cueMotion(b.balls[b.strike.cue], b.strike.dir, !!sc.irregular, sc.seed);
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${S.IW}x${S.IH}`, '-r', String(fps), '-i', '-',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
(async () => {
  for (let t = -3.2; t < b.sim.tEnd + 1.5; t += 1 / fps) {
    const cue = t < 0 ? motion(t) : t < 0.04 ? motion(-1e-4) : null;
    const img = render(b.sim.sample(t), cue);
    if (!ff.stdin.write(Buffer.from(img.data.buffer))) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
})();
ff.on('close', (c) => console.log(c === 0 ? `ok ${out} (scénario ${id}, ${fps} i/s)` : 'ffmpeg erreur ' + c));
