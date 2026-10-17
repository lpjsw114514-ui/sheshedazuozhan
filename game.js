'use strict';

/* =========================================================
   蛇蛇大作战 · 离线版 · 1600×1600 · 自定义食物密度
   ========================================================= */

/* ---------------- 常量 ---------------- */
const W = 1600, H = 1600;
const CELL = 20;
const TICK_MS = 90;
const FOOD_TYPES = ['🍎', '🍌', '🍅'];
const COLORS = ['#5ee7a0','#5bc8ff','#a78bfa','#ffd93d','#ff7b7b','#ff9f5b','#4de3d1','#f472b6'];
const START_LEN = 5;
const AI_COUNT = 5;
const RESPAWN_MS = 3000;
const NICK_KEY = 'snake_arena_nick';
const FOOD_SETTING_KEY = 'snake_arena_food_setting';

/* 食物密度默认值：每 5×5 区域 1~7 个 */
const FOOD_GRID = 5;
const DEFAULT_FOOD_MIN = 1;
const DEFAULT_FOOD_MAX = 7;

/* 空间哈希桶 */
const BUCKET_SIZE = 16;

const DIRS = {
  up:    { x: 0, y: -1 },
  down:  { x: 0, y: 1 },
  left:  { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/* ---------------- DOM ---------------- */
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

/* ---------------- 状态 ---------------- */
const S = {
  screen: 'name',
  nick: '',
  game: null,
  paused: false,
  camX: 0, camY: 0,
  camInit: false,
  tickTimer: null,
  renderRunning: false,
  lastTickTime: 0,
  // 食物密度设置
  foodMin: DEFAULT_FOOD_MIN,
  foodMax: DEFAULT_FOOD_MAX,
};

let foodId = 0;

/* ---------------- 工具 ---------------- */
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function inBounds(x, y){ return x >= 0 && x < W && y >= 0 && y < H; }

let toastTimer = null;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}
function showScreen(name){
  S.screen = name;
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  const el = document.getElementById('scr-' + name);
  if (el) el.classList.add('active');
}
function loadNick(){
  try { return localStorage.getItem(NICK_KEY) || ''; } catch(e){ return ''; }
}
function saveNick(n){
  try { localStorage.setItem(NICK_KEY, n); } catch(e){}
}

/* ---------- 食物密度设置持久化 ---------- */
function loadFoodSetting(){
  try {
    const raw = localStorage.getItem(FOOD_SETTING_KEY);
    if (raw){
      const obj = JSON.parse(raw);
      if (typeof obj.min === 'number' && typeof obj.max === 'number'){
        S.foodMin = clamp(obj.min, 1, 7);
        S.foodMax = clamp(obj.max, 1, 7);
        if (S.foodMin > S.foodMax) S.foodMin = S.foodMax;
        return;
      }
    }
  } catch(e){}
  S.foodMin = DEFAULT_FOOD_MIN;
  S.foodMax = DEFAULT_FOOD_MAX;
}
function saveFoodSetting(){
  try {
    localStorage.setItem(FOOD_SETTING_KEY, JSON.stringify({
      min: S.foodMin, max: S.foodMax,
    }));
  } catch(e){}
}

/* =========================================================
   空间哈希：食物桶
   ========================================================= */
function bucketKey(x, y){
  return Math.floor(x / BUCKET_SIZE) + ',' + Math.floor(y / BUCKET_SIZE);
}
function addFoodToBucket(f){
  const k = bucketKey(f.x, f.y);
  let set = S.game.foodBuckets.get(k);
  if (!set){ set = new Set(); S.game.foodBuckets.set(k, set); }
  set.add(f);
}
function removeFoodFromBucket(f){
  const k = bucketKey(f.x, f.y);
  const set = S.game.foodBuckets.get(k);
  if (set){
    set.delete(f);
    if (set.size === 0) S.game.foodBuckets.delete(k);
  }
}
function findNearestFood(x, y, maxRadius){
  const cx = Math.floor(x / BUCKET_SIZE);
  const cy = Math.floor(y / BUCKET_SIZE);
  for (let r = 0; r <= maxRadius; r++){
    let best = null, bestDist = Infinity;
    for (let bx = cx - r; bx <= cx + r; bx++){
      for (let by = cy - r; by <= cy + r; by++){
        if (r > 0 && Math.abs(bx - cx) !== r && Math.abs(by - cy) !== r) continue;
        const set = S.game.foodBuckets.get(bx + ',' + by);
        if (!set) continue;
        for (const f of set){
          const d = Math.abs(f.x - x) + Math.abs(f.y - y);
          if (d < bestDist){ bestDist = d; best = f; }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/* =========================================================
   游戏引擎
   ========================================================= */
function allSnakes(){
  if (!S.game) return [];
  return [S.game.player, ...S.game.ai];
}

function makeSnake(isPlayer, color){
  return {
    isPlayer, color,
    snake: [], prevSnake: [],
    dir: { x: 1, y: 0 }, nextDir: null,
    alive: true, score: 0, respawnAt: 0,
    eatenTypes: [],
  };
}

function findSpawn(){
  for (let attempt = 0; attempt < 300; attempt++){
    const x = 12 + Math.floor(Math.random() * (W - 24));
    const y = 12 + Math.floor(Math.random() * (H - 24));
    let ok = true;
    for (const s of allSnakes()){
      if (!s.alive || !s.snake.length) continue;
      const h = s.snake[0];
      let dx = Math.abs(h.x - x); dx = Math.min(dx, W - dx);
      let dy = Math.abs(h.y - y); dy = Math.min(dy, H - dy);
      if (dx < 15 && dy < 15){ ok = false; break; }
    }
    if (ok) return { x, y };
  }
  return {
    x: 20 + Math.floor(Math.random() * (W - 40)),
    y: 20 + Math.floor(Math.random() * (H - 40)),
  };
}

function respawnSnake(s){
  const pos = findSpawn();
  const body = [];
  for (let i = 0; i < START_LEN; i++){
    let x = pos.x - i;
    if (x < 0) x = 0;
    body.push({ x, y: pos.y });
  }
  s.snake = body;
  s.prevSnake = body.map(p => ({ ...p }));
  s.dir = { x: 1, y: 0 };
  s.nextDir = null;
  s.alive = true;
  s.score = 0;
  s.respawnAt = 0;
  s.eatenTypes = [];
}

/* ---------- 批量生成食物：使用当前设置的密度 ---------- */
function generateAllFood(){
  S.game.foods.clear();
  S.game.foodBuckets.clear();

  const cols = Math.ceil(W / FOOD_GRID);
  const rows = Math.ceil(H / FOOD_GRID);
  const min = S.foodMin;
  const max = S.foodMax;
  const range = Math.max(1, max - min + 1);

  for (let cx = 0; cx < cols; cx++){
    for (let cy = 0; cy < rows; cy++){
      const count = min + Math.floor(Math.random() * range);
      for (let i = 0; i < count; i++){
        let placed = false;
        for (let attempt = 0; attempt < 8; attempt++){
          const x = cx * FOOD_GRID + Math.floor(Math.random() * FOOD_GRID);
          const y = cy * FOOD_GRID + Math.floor(Math.random() * FOOD_GRID);
          if (x >= W || y >= H) continue;
          const key = x + ',' + y;
          if (S.game.foods.has(key)) continue;
          const f = {
            id: ++foodId, x, y,
            e: Math.floor(Math.random() * FOOD_TYPES.length),
          };
          S.game.foods.set(key, f);
          addFoodToBucket(f);
          placed = true;
          break;
        }
        if (!placed) break;
      }
    }
  }
}

function respawnFoodNear(cx, cy){
  for (let attempt = 0; attempt < 20; attempt++){
    const x = clamp(cx + Math.floor(Math.random() * 11) - 5, 0, W - 1);
    const y = clamp(cy + Math.floor(Math.random() * 11) - 5, 0, H - 1);
    const key = x + ',' + y;
    if (S.game.foods.has(key)) continue;
    const f = {
      id: ++foodId, x, y,
      e: Math.floor(Math.random() * FOOD_TYPES.length),
    };
    S.game.foods.set(key, f);
    addFoodToBucket(f);
    return;
  }
}

function createGame(){
  S.game = {
    player: makeSnake(true, COLORS[0]),
    ai: [],
    foods: new Map(),
    foodBuckets: new Map(),
  };
  for (let i = 0; i < AI_COUNT; i++){
    S.game.ai.push(makeSnake(false, COLORS[(i + 1) % COLORS.length]));
  }
  respawnSnake(S.game.player);
  for (const a of S.game.ai) respawnSnake(a);
  generateAllFood();
  S.lastTickTime = performance.now();
  S.camInit = false;
}

function findFoodAt(x, y){
  return S.game.foods.get(x + ',' + y);
}

function dropEatenFood(s){
  const g = S.game;
  if (!g) return;
  const types = s.eatenTypes || [];
  for (const seg of s.snake){
    const key = seg.x + ',' + seg.y;
    if (g.foods.has(key)) continue;
    const e = types.length > 0
      ? types.pop()
      : Math.floor(Math.random() * FOOD_TYPES.length);
    const f = { id: ++foodId, x: seg.x, y: seg.y, e };
    g.foods.set(key, f);
    addFoodToBucket(f);
  }
  s.eatenTypes = [];
}

/* =========================================================
   AI 思考
   ========================================================= */
function aiChooseDir(ai){
  const head = ai.snake[0];
  const nearest = findNearestFood(head.x, head.y, 6);

  const dirs = [
    { x: 1, y: 0 }, { x: -1, y: 0 },
    { x: 0, y: 1 }, { x: 0, y: -1 },
  ];

  const scored = [];
  for (const d of dirs){
    if (d.x === -ai.dir.x && d.y === -ai.dir.y) continue;
    const nx = head.x + d.x;
    const ny = head.y + d.y;

    if (!inBounds(nx, ny)){
      scored.push({ d, score: -9999 });
      continue;
    }

    let collision = false;
    for (const s of allSnakes()){
      if (!s.alive || !s.snake.length) continue;
      const start = (s === ai) ? 1 : 0;
      for (let i = start; i < s.snake.length; i++){
        if (s.snake[i].x === nx && s.snake[i].y === ny){ collision = true; break; }
      }
      if (collision) break;
    }

    let score;
    if (collision){
      score = -9999;
    } else if (nearest){
      const dist = Math.abs(nearest.x - nx) + Math.abs(nearest.y - ny);
      score = -dist + Math.random() * 4;
    } else {
      score = Math.random() * 3;
    }
    scored.push({ d, score });
  }

  if (!scored.length) return ai.dir;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].d;
}

/* =========================================================
   逻辑 tick
   ========================================================= */
function tick(){
  if (!S.game || S.paused) return;
  const g = S.game;

  for (const s of allSnakes()){
    if (!s.alive) continue;
    if (s.nextDir){
      if (!(s.nextDir.x === -s.dir.x && s.nextDir.y === -s.dir.y)){
        s.dir = s.nextDir;
      }
      s.nextDir = null;
    }
  }

  for (const ai of g.ai){
    if (!ai.alive) continue;
    ai.dir = aiChooseDir(ai);
  }

  const newHeads = new Map();
  for (const s of allSnakes()){
    if (!s.alive) continue;
    const h = s.snake[0];
    newHeads.set(s, { x: h.x + s.dir.x, y: h.y + s.dir.y });
  }

  const dead = new Set();
  for (const s of allSnakes()){
    if (!s.alive) continue;
    const nh = newHeads.get(s);

    if (!inBounds(nh.x, nh.y)){ dead.add(s); continue; }

    for (let i = 1; i < s.snake.length; i++){
      if (s.snake[i].x === nh.x && s.snake[i].y === nh.y){ dead.add(s); break; }
    }

    for (const o of allSnakes()){
      if (o === s || !o.alive) continue;
      for (let i = 0; i < o.snake.length; i++){
        if (o.snake[i].x === nh.x && o.snake[i].y === nh.y){
          dead.add(s);
          if (i === 0) dead.add(o);
          break;
        }
      }
    }
  }

  const now = performance.now();
  for (const s of allSnakes()){
    if (!s.alive) continue;
    s.prevSnake = s.snake;

    if (dead.has(s)){
      dropEatenFood(s);
      s.alive = false;
      s.score = 0;
      s.snake = [];
      s.respawnAt = now + RESPAWN_MS;
      continue;
    }

    const nh = newHeads.get(s);
    const newSnake = [nh, ...s.snake];
    const f = findFoodAt(nh.x, nh.y);
    if (f){
      g.foods.delete(nh.x + ',' + nh.y);
      removeFoodFromBucket(f);
      s.score++;
      s.eatenTypes.push(f.e);
      respawnFoodNear(nh.x, nh.y);
    } else {
      newSnake.pop();
    }
    s.snake = newSnake;
  }

  const now2 = performance.now();
  for (const s of allSnakes()){
    if (!s.alive && s.respawnAt && now2 >= s.respawnAt) respawnSnake(s);
  }

  S.lastTickTime = now2;
}

/* =========================================================
   渲染
   ========================================================= */
function resizeCanvas(){
  const maxW = Math.min(1280, window.innerWidth - 20);
  const maxH = Math.min(820, window.innerHeight - 20);
  canvas.width = Math.max(320, Math.floor(maxW));
  canvas.height = Math.max(240, Math.floor(maxH));
  canvas.style.width = canvas.width + 'px';
  canvas.style.height = canvas.height + 'px';
  S.camInit = false;
}
window.addEventListener('resize', () => {
  if (S.screen === 'game') resizeCanvas();
});

function updateCamera(){
  if (!S.game) return;
  const p = S.game.player;
  if (!p.snake.length) return;
  const h = p.snake[0];
  const worldW = W * CELL, worldH = H * CELL;
  const tx = clamp(h.x * CELL + CELL / 2 - canvas.width / 2, 0, Math.max(0, worldW - canvas.width));
  const ty = clamp(h.y * CELL + CELL / 2 - canvas.height / 2, 0, Math.max(0, worldH - canvas.height));
  if (!S.camInit){ S.camX = tx; S.camY = ty; S.camInit = true; }
  else {
    S.camX += (tx - S.camX) * 0.22;
    S.camY += (ty - S.camY) * 0.22;
  }
}

function shade(hex, amt){
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = clamp(Math.round(r + r * amt), 0, 255);
  g = clamp(Math.round(g + g * amt), 0, 255);
  b = clamp(Math.round(b + b * amt), 0, 255);
  return `rgb(${r},${g},${b})`;
}

function roundRect(x, y, w, h, r){
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSnake(s, t){
  const cur = s.snake;
  const prev = s.prevSnake;
  const n = cur.length;
  if (!n) return;
  const canLerp = prev && prev.length === n;

  for (let i = n - 1; i >= 0; i--){
    const c = cur[i];
    let px = c.x, py = c.y;
    if (canLerp){
      const p = prev[i];
      const dx = c.x - p.x, dy = c.y - p.y;
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1){
        px = p.x + dx * t;
        py = p.y + dy * t;
      }
    }
    const x = px * CELL;
    const y = py * CELL;
    const pad = 1.5;

    if (i === 0 && s.isPlayer){
      ctx.shadowColor = s.color; ctx.shadowBlur = 18;
    } else if (i === 0){
      ctx.shadowColor = s.color; ctx.shadowBlur = 8;
    } else {
      ctx.shadowBlur = 0;
    }

    ctx.fillStyle = i === 0 ? s.color : shade(s.color, -0.3);
    roundRect(x + pad, y + pad, CELL - pad * 2, CELL - pad * 2, i === 0 ? 7 : 4);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  const h = cur[0];
  let hx = h.x * CELL + CELL / 2, hy = h.y * CELL + CELL / 2;
  if (canLerp){
    const p = prev[0];
    const dx = h.x - p.x, dy = h.y - p.y;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1){
      hx = (p.x + dx * t) * CELL + CELL / 2;
      hy = (p.y + dy * t) * CELL + CELL / 2;
    }
  }
  const d = s.dir;
  const perpX = -d.y, perpY = d.x;
  const fx = d.x * CELL * 0.16, fy = d.y * CELL * 0.16;
  const ox = perpX * CELL * 0.2, oy = perpY * CELL * 0.2;

  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(hx + fx + ox, hy + fy + oy, 2.8, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(hx + fx - ox, hy + fy - oy, 2.8, 0, 7); ctx.fill();
  ctx.fillStyle = '#0a0f1e';
  ctx.beginPath(); ctx.arc(hx + fx + ox + d.x * 1, hy + fy + oy + d.y * 1, 1.4, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(hx + fx - ox + d.x * 1, hy + fy - oy + d.y * 1, 1.4, 0, 7); ctx.fill();

  if (s.isPlayer){
    ctx.font = 'bold 11px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText('你', hx, hy - CELL * 0.8);
  }
}

function draw(now){
  const cw = canvas.width, ch = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a0f1e';
  ctx.fillRect(0, 0, cw, ch);

  if (!S.game) return;
  updateCamera();

  ctx.save();
  ctx.translate(-Math.round(S.camX), -Math.round(S.camY));

  const x0 = Math.floor(S.camX / CELL) - 1;
  const x1 = Math.ceil((S.camX + cw) / CELL) + 1;
  const y0 = Math.floor(S.camY / CELL) - 1;
  const y1 = Math.ceil((S.camY + ch) / CELL) + 1;

  ctx.strokeStyle = 'rgba(90,130,200,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 4;
  for (let x = Math.max(0, Math.ceil(x0 / step) * step); x <= x1; x += step){
    if (x < 0 || x > W) continue;
    ctx.moveTo(x * CELL + .5, Math.max(0, y0 * CELL));
    ctx.lineTo(x * CELL + .5, Math.min(H * CELL, y1 * CELL));
  }
  for (let y = Math.max(0, Math.ceil(y0 / step) * step); y <= y1; y += step){
    if (y < 0 || y > H) continue;
    ctx.moveTo(Math.max(0, x0 * CELL), y * CELL + .5);
    ctx.lineTo(Math.min(W * CELL, x1 * CELL), y * CELL + .5);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(120,170,255,0.55)';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, W * CELL, H * CELL);

  ctx.font = Math.round(CELL * 0.86) + 'px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const b0x = Math.floor(x0 / BUCKET_SIZE);
  const b1x = Math.floor(x1 / BUCKET_SIZE);
  const b0y = Math.floor(y0 / BUCKET_SIZE);
  const b1y = Math.floor(y1 / BUCKET_SIZE);

  for (let bx = b0x; bx <= b1x; bx++){
    for (let by = b0y; by <= b1y; by++){
      const set = S.game.foodBuckets.get(bx + ',' + by);
      if (!set) continue;
      for (const f of set){
        if (f.x < x0 || f.x > x1 || f.y < y0 || f.y > y1) continue;
        ctx.fillText(FOOD_TYPES[f.e], f.x * CELL + CELL / 2, f.y * CELL + CELL / 2 + 1);
      }
    }
  }

  const t = clamp((now - S.lastTickTime) / TICK_MS, 0, 1);
  for (const ai of S.game.ai){
    if (ai.alive && ai.snake.length) drawSnake(ai, t);
  }
  if (S.game.player.alive && S.game.player.snake.length){
    drawSnake(S.game.player, t);
  }

  ctx.restore();
  drawMinimap();
}

function drawMinimap(){
  const size = 160, pad = 16;
  const mx = canvas.width - size - pad;
  const my = canvas.height - size - pad;

  ctx.fillStyle = 'rgba(10,16,30,0.86)';
  roundRect(mx, my, size, size, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(96,140,210,0.35)';
  ctx.lineWidth = 1;
  roundRect(mx + .5, my + .5, size - 1, size - 1, 10); ctx.stroke();

  if (!S.game) return;
  const k = size / Math.max(W, H);

  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    mx + (S.camX / CELL) * k,
    my + (S.camY / CELL) * k,
    (canvas.width / CELL) * k,
    (canvas.height / CELL) * k
  );

  for (const s of allSnakes()){
    if (!s.alive || !s.snake.length) continue;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(mx + (s.snake[0].x + 0.5) * k, my + (s.snake[0].y + 0.5) * k, s.isPlayer ? 4 : 2.6, 0, 7);
    ctx.fill();
    if (s.isPlayer){
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  ctx.fillStyle = 'rgba(150,170,200,0.7)';
  ctx.font = '10px system-ui,sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const p = S.game.player;
  if (p.snake.length){
    ctx.fillText(`(${p.snake[0].x},${p.snake[0].y})`, mx + 6, my + 6);
  }
}

/* ---------------- 渲染循环 ---------------- */
let loopRunning = false;
function startRender(){
  if (loopRunning) return;
  loopRunning = true;
  requestAnimationFrame(renderLoop);
}
function renderLoop(now){
  if (S.screen !== 'game'){ loopRunning = false; return; }
  draw(now);
  updateUI();
  requestAnimationFrame(renderLoop);
}

function updateUI(){
  if (!S.game) return;
  const p = S.game.player;
  document.getElementById('hudScore').textContent = p.score;
  document.getElementById('hudLength').textContent = p.alive ? p.snake.length : 0;

  const alive = allSnakes().filter(s => s.alive);
  const sorted = [...alive].sort((a, b) => b.score - a.score || b.snake.length - a.snake.length);
  const rank = sorted.indexOf(p) + 1;
  document.getElementById('hudRank').textContent = p.alive ? rank : '-';
  document.getElementById('hudTotal').textContent = alive.length;

  const panel = document.getElementById('playersPanel');
  const list = allSnakes().filter(s => s.alive || s.isPlayer);
  const sorted2 = [...list].sort((a, b) => b.score - a.score);
  panel.innerHTML = sorted2.map(s => `
    <div class="pp-row ${s.isPlayer ? 'me' : ''} ${s.alive ? '' : 'dead'}">
      <span class="pp-dot" style="background:${s.color}"></span>
      <span class="pp-nick">${s.isPlayer ? '你' : 'AI'}</span>
      <span class="pp-score">${s.score}</span>
    </div>
  `).join('');

  const ov = document.getElementById('respawnOverlay');
  if (p.alive){
    ov.classList.remove('show');
  } else {
    const remain = Math.max(0, (p.respawnAt - performance.now()) / 1000);
    document.getElementById('respawnCount').textContent = remain.toFixed(1);
    ov.classList.add('show');
  }
}

/* =========================================================
   食物密度设置 UI
   ========================================================= */
const foodMinInput = document.getElementById('foodMin');
const foodMaxInput = document.getElementById('foodMax');
const minValueEl = document.getElementById('minValue');
const maxValueEl = document.getElementById('maxValue');
const summaryEl = document.getElementById('settingSummary');

function refreshSettingUI(){
  minValueEl.textContent = S.foodMin;
  maxValueEl.textContent = S.foodMax;
  foodMinInput.value = S.foodMin;
  foodMaxInput.value = S.foodMax;
  summaryEl.innerHTML = `当前设置：每 25 格 <b>${S.foodMin} ~ ${S.foodMax}</b> 个食物`;

  // 同步滑块样式（用渐变填充表示选择范围）
  updateSliderFill(foodMinInput);
  updateSliderFill(foodMaxInput);
}

function updateSliderFill(input){
  const min = +input.min, max = +input.max, v = +input.value;
  const pct = ((v - min) / (max - min)) * 100;
  input.style.background = `linear-gradient(to right, #3ecf8e 0%, #2aa9e0 ${pct}%, rgba(96,140,210,.3) ${pct}%, rgba(96,140,210,.3) 100%)`;
}

foodMinInput.addEventListener('input', () => {
  S.foodMin = +foodMinInput.value;
  if (S.foodMin > S.foodMax){
    S.foodMax = S.foodMin;
    foodMaxInput.value = S.foodMax;
  }
  refreshSettingUI();
  saveFoodSetting();
});
foodMaxInput.addEventListener('input', () => {
  S.foodMax = +foodMaxInput.value;
  if (S.foodMax < S.foodMin){
    S.foodMin = S.foodMax;
    foodMinInput.value = S.foodMin;
  }
  refreshSettingUI();
  saveFoodSetting();
});

document.getElementById('btnResetSetting').addEventListener('click', () => {
  S.foodMin = DEFAULT_FOOD_MIN;
  S.foodMax = DEFAULT_FOOD_MAX;
  refreshSettingUI();
  saveFoodSetting();
  toast('食物密度已重置为默认值 1 ~ 7');
});

/* =========================================================
   游戏控制
   ========================================================= */
function startGame(){
  createGame();
  resizeCanvas();
  showScreen('game');
  S.paused = false;
  document.getElementById('pauseOverlay').classList.remove('show');
  // HUD 显示当前食物设置
  document.getElementById('hudFoodRange').textContent = `${S.foodMin}~${S.foodMax}`;

  if (S.tickTimer) clearInterval(S.tickTimer);
  S.tickTimer = setInterval(tick, TICK_MS);
  startRender();
}

function stopGame(){
  if (S.tickTimer){ clearInterval(S.tickTimer); S.tickTimer = null; }
  S.game = null;
  loopRunning = false;
}

function backToMenu(){
  stopGame();
  showScreen('menu');
}

function togglePause(){
  if (!S.game) return;
  S.paused = !S.paused;
  const ov = document.getElementById('pauseOverlay');
  if (S.paused) ov.classList.add('show');
  else ov.classList.remove('show');
}

/* =========================================================
   输入
   ========================================================= */
const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
};

function sendDir(d){
  if (!S.game || !S.game.player.alive || S.paused) return;
  const dir = DIRS[d];
  if (!dir) return;
  const p = S.game.player;
  if (dir.x === -p.dir.x && dir.y === -p.dir.y) return;
  p.nextDir = dir;
}

window.addEventListener('keydown', e => {
  if (S.screen !== 'game') return;
  if (e.key === ' ' || e.key === 'p' || e.key === 'P'){
    e.preventDefault();
    togglePause();
    return;
  }
  const d = KEYMAP[e.key];
  if (d){ e.preventDefault(); sendDir(d); }
}, { passive: false });

let touchStart = null;
canvas.addEventListener('touchstart', e => {
  const t = e.touches[0];
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });
canvas.addEventListener('touchmove', e => { e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchend', e => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return;
  if (Math.abs(dx) > Math.abs(dy)) sendDir(dx > 0 ? 'right' : 'left');
  else sendDir(dy > 0 ? 'down' : 'up');
}, { passive: true });

/* =========================================================
   UI 事件
   ========================================================= */
document.getElementById('btnEnter').addEventListener('click', () => {
  const raw = document.getElementById('nickInput').value.trim();
  if (!raw){ toast('请先取个名字'); return; }
  const chars = Array.from(raw);
  if (chars.length > 8){ toast('昵称最多 8 位'); return; }
  S.nick = chars.join('');
  saveNick(S.nick);
  document.getElementById('menuNick').textContent = S.nick;
  showScreen('menu');
});
document.getElementById('nickInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnEnter').click();
});

document.getElementById('btnOffline').addEventListener('click', startGame);
document.getElementById('btnOnline').addEventListener('click', () => {
  toast('在线对战暂未支持，敬请期待');
});

document.getElementById('btnExitGame').addEventListener('click', backToMenu);
document.getElementById('btnPause').addEventListener('click', togglePause);
document.getElementById('btnResume').addEventListener('click', togglePause);
document.getElementById('btnRestart').addEventListener('click', startGame);

/* =========================================================
   启动
   ========================================================= */
(function init(){
  const saved = loadNick();
  if (saved){
    document.getElementById('nickInput').value = saved;
    S.nick = saved;
    document.getElementById('menuNick').textContent = saved;
  }
  // 加载食物密度设置
  loadFoodSetting();
  refreshSettingUI();
  document.getElementById('nickInput').focus();
})();