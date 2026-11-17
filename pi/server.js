#!/usr/bin/env node
// Serveur Carambole pour Raspberry Pi : filme la table, analyse chaque coup avec engine.js,
// et sert l'application mobile (aperçu, étalonnage à distance, verdicts en direct) sur le Wi-Fi.
// Aucune dépendance npm : Node 18+ suffit.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../engine.js');
const { createSource } = require('./camera.js');
const { encodePNG } = require('./png.js');

// ---------- configuration ----------
const ROOT = __dirname;
const args = process.argv.slice(2);
const cfgPath = args.includes('--config') ? args[args.indexOf('--config') + 1] : path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (args.includes('--sim')) cfg.camera = Object.assign({ type: 'sim', fps: 60, k1: -0.12 }, cfg.simCamera || {});
if (process.env.PORT) cfg.port = +process.env.PORT;
const DATA = path.resolve(ROOT, cfg.dataDir || 'data');
const APP = path.resolve(ROOT, cfg.appDir || '../docs');
fs.mkdirSync(DATA, { recursive: true });

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return d; } };
const writeJSON = (f, v) => { const p = path.join(DATA, f); fs.writeFileSync(p + '.tmp', JSON.stringify(v)); fs.renameSync(p + '.tmp', p); };

// ---------- état persistant ----------
const state = Object.assign({
  calib: null, // {corners:[[u,v]×4 normalisés], mids, k1, residual, table}
  settings: { player: 'auto', gesture: true, sens: 0, table: 'match' },
}, readJSON('state.json', {}));
let history = readJSON('history.json', []);
const saveState = () => writeJSON('state.json', { calib: state.calib, settings: state.settings });
const saveHistory = () => writeJSON('history.json', history);

// ---------- analyse ----------
let det = null, ses = null, frameW = 0, frameH = 0, latest = null, lastFrameT = 0;
const stats = { frames: 0, fps: 0, procMs: 0, drops: 0, analyzing: false, cameraError: null, started: Date.now() };
let fpsCount = 0, fpsT0 = Date.now(), lastPosSent = 0, lastState = 'idle', gestureTick = 0;

function colorsFromSens(s) {
  return { wV: 0.62 - 0.04 * s, wS: 0.30 + 0.03 * s, yS: 0.42 - 0.04 * s, yV: 0.40 - 0.03 * s, rS: 0.48 - 0.04 * s, rV: 0.25 - 0.02 * s };
}
function tableDims() { return E.TABLES[state.settings.table] || E.TABLES.match; }

function buildEngine(learn) {
  det = null; ses = null;
  if (!state.calib || !frameW) return;
  const c = state.calib, px = (p) => [p[0] * frameW, p[1] * frameH];
  det = new E.Detector(frameW, frameH, c.corners.map(px), tableDims(), { k1: c.k1 || 0, colors: colorsFromSens(state.settings.sens) });
  if (learn !== false && latest) det.learnCloth({ data: latest, width: frameW, height: frameH });
  ses = new E.Session(det, { player: state.settings.player === 'auto' ? 'auto' : +state.settings.player, gesture: state.settings.gesture });
  // l'analyse du geste est la partie la plus coûteuse : on peut ne la faire qu'une image sur N
  const every = Math.max(1, cfg.gestureEvery || 1), orig = det.cueFeatures.bind(det);
  det.cueFeatures = (...a) => (gestureTick % every === 0 ? orig(...a) : null);
  log(`moteur prêt : ${frameW}×${frameH}, k1=${(c.k1 || 0).toFixed(3)}, table ${state.settings.table}`);
}

function handleFrame(f) {
  if (!f) { stats.drops++; return; }
  if (f.w !== frameW || f.h !== frameH) { frameW = f.w; frameH = f.h; latest = f.rgba; buildEngine(true); }
  latest = f.rgba; lastFrameT = f.t; stats.frames++; fpsCount++;
  const now = Date.now();
  if (now - fpsT0 >= 1000) { stats.fps = Math.round((fpsCount * 1000) / (now - fpsT0)); fpsCount = 0; fpsT0 = now; }
  if (!ses) return;
  if (det && !det.cloth) det.learnCloth({ data: latest, width: frameW, height: frameH });
  const t0 = process.hrtime.bigint();
  gestureTick++;
  const out = ses.process({ data: f.rgba, width: f.w, height: f.h }, f.t);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  stats.procMs = stats.procMs ? 0.95 * stats.procMs + 0.05 * ms : ms;
  if (out.event && out.event.type === 'start') broadcast('shot', { t: f.t });
  if (out.event && out.event.type === 'end') onResult(out.event.result);
  const interval = out.state === 'shot' ? 50 : 150;
  if (now - lastPosSent >= interval || out.state !== lastState) {
    lastPosSent = now; lastState = out.state;
    broadcast('pos', { pos: out.pos.map((p) => p && [+p[0].toFixed(4), +p[1].toFixed(4)]), state: out.state });
  }
}

function onResult(r) {
  if (r.ignored) { broadcast('ignored', { reason: r.reason }); return; }
  r.id = Date.now() + Math.random();
  r.time = Date.now();
  const c = E.compactResult(r, state.settings.table);
  history.unshift(c);
  if (history.length > (cfg.historyMax || 1000)) history.length = cfg.historyMax || 1000;
  saveHistory();
  broadcast('result', c);
  log(`coup : ${c.reason} | ${c.effect && c.effect.label} | confiance ${c.confidence}`);
}

// ---------- caméra ----------
const source = createSource(cfg.camera, log);
let syncQueue = null, busy = false;
function onFrame(f, sync) {
  if (sync) { handleFrame(f); return; }
  if (syncQueue) stats.drops++;
  syncQueue = f;
  if (!busy) { busy = true; setImmediate(drain); }
}
function drain() {
  const f = syncQueue; syncQueue = null;
  if (f !== null && f !== undefined) { try { handleFrame(f); } catch (e) { log('erreur analyse :', e.stack || e.message); } }
  if (syncQueue) setImmediate(drain); else busy = false;
}
source.start(onFrame);

// ---------- SSE ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); broadcast('stats', publicStats()); }, 2000);

function publicStats() {
  return {
    fps: stats.fps, procMs: +stats.procMs.toFixed(1), drops: stats.drops, frames: stats.frames,
    cameraError: source.error || null, uptime: Math.round((Date.now() - stats.started) / 1000),
  };
}
function publicState() {
  return {
    calibrated: !!(state.calib && det), calib: state.calib, settings: state.settings, w: frameW, h: frameH,
    state: ses ? ses.state : 'idle', stats: publicStats(), tables: E.TABLES, version: 1,
  };
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e6) { reject(new Error('trop gros')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}
const validPts = (a, n) => Array.isArray(a) && a.length === n && a.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(v) && v >= -0.1 && v <= 1.1));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    if (p === '/api/state') return send(res, 200, publicState());
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/frame.png') {
      if (!latest) return send(res, 503, { error: 'pas encore d\'image' });
      const full = url.searchParams.get('full') === '1';
      return send(res, 200, encodePNG(latest, frameW, frameH, full ? frameW : (cfg.previewWidth || 320)), 'image/png');
    }
    if (p === '/api/history') return send(res, 200, history);
    if (req.method === 'POST' && p === '/api/calibrate') {
      const b = await readBody(req);
      if (!validPts(b.corners, 4)) return send(res, 400, { error: 'Il faut 4 coins' });
      if (b.mids != null && !validPts(b.mids, 4)) return send(res, 400, { error: 'Il faut 4 milieux de bande' });
      if (b.table && E.TABLES[b.table]) state.settings.table = b.table;
      let k1 = 0, residual = null;
      if (b.mids) {
        const px = (q) => [q[0] * frameW, q[1] * frameH];
        const fit = E.fitDistortion(frameW, frameH, b.corners.map(px), b.mids.map(px));
        k1 = fit.k1; residual = fit.residual;
      }
      state.calib = { corners: b.corners, mids: b.mids || null, k1, residual };
      try { buildEngine(true); } catch (e) { state.calib = null; return send(res, 400, { error: e.message }); }
      saveState();
      broadcast('state', publicState());
      return send(res, 200, { ok: true, k1, residual });
    }
    if (req.method === 'POST' && p === '/api/settings') {
      const b = await readBody(req), st = state.settings;
      if (b.player != null && ['auto', '0', '1', 0, 1].includes(b.player)) st.player = String(b.player);
      if (b.gesture != null) st.gesture = !!b.gesture;
      if (b.sens != null && Number.isFinite(+b.sens)) st.sens = Math.max(-3, Math.min(3, +b.sens));
      if (b.table && E.TABLES[b.table]) st.table = b.table;
      saveState();
      if (state.calib) buildEngine(false);
      broadcast('state', publicState());
      return send(res, 200, { ok: true, settings: st });
    }
    if (req.method === 'POST' && p === '/api/correct') {
      const b = await readBody(req), h = history.find((x) => x.id === b.id);
      if (!h) return send(res, 404, { error: 'coup inconnu' });
      h.corrected = b.valid == null ? null : !!b.valid;
      saveHistory();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/history/clear') { history = []; saveHistory(); return send(res, 200, { ok: true }); }
    if (p === '/api/sim/truths' && source.truths) return send(res, 200, source.truths);
    // application web (servie depuis docs/)
    const file = path.normalize(path.join(APP, p === '/' ? 'index.html' : p));
    if (file.startsWith(APP) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }
    return send(res, 404, { error: 'introuvable' });
  } catch (e) {
    log('erreur HTTP :', e.message);
    return send(res, 500, { error: e.message });
  }
});

server.listen(cfg.port || 8080, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  log(`Carambole prêt sur le port ${cfg.port || 8080}. Dans l'application, adresse du Pi : ${ips.map((ip) => `${ip}:${cfg.port || 8080}`).join(' ou ') || 'localhost'}`);
  log(`caméra : ${cfg.camera.type}, ${cfg.camera.width || ''}×${cfg.camera.height || ''} @ ${cfg.camera.fps} i/s`);
});

function shutdown() { source.stop(); server.close(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
