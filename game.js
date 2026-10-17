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
  // 联机（WebRTC P2P，零服务器）
  online: false,
  role: null,           // 'host' 房主 | 'guest' 同学
  seed: 0,              // 世界种子（房主生成，同学端同步后生成完全相同的食物）
  rng: null,
  netPeers: new Map(),  // 房主：peerId -> 同学蛇对象
  peerMeta: new Map(),  // 房主：peerId -> { name, color }
  snapReceived: false,  // 同学：是否已收到第一个快照
};

let foodId = 0;

/* ---------- 联机工具 ---------- */
const MY_COLOR = COLORS[Math.floor(Math.random() * COLORS.length)];

/* 确定性随机：同一 seed 在房主/同学端生成完全相同的食物图 */
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
/* 蛇身编解码：[{x,y}...] <-> [x,y,x,y,...]（省流量） */
function packBody(s){
  const arr = [];
  for (const p of s.snake) arr.push(p.x, p.y);
  return arr;
}
function unpackBody(arr){
  const body = [];
  for (let i = 0; i < arr.length; i += 2) body.push({ x: arr[i], y: arr[i + 1] });
  return body;
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function copyText(ta){
  ta.select();
  ta.setSelectionRange(0, 1e9);
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(ta.value).catch(() => document.execCommand('copy'));
  } else {
    document.execCommand('copy');
  }
  toast('已复制到剪贴板');
}

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
  return [S.game.player, ...S.game.ai, ...S.game.remotes];
}

function makeSnake(isPlayer, color){
  return {
    isPlayer, color,
    name: '', sid: 0, isRemote: false,
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

/* ---------- 批量生成食物：使用当前设置的密度 ----------
   注意：必须使用 S.rng（种子随机），这样房主与同学端
   用同一 seed 能生成完全相同的食物图（id、位置、类型一致） */
function generateAllFood(){
  S.game.foods.clear();
  S.game.foodBuckets.clear();
  S.game.foodById.clear();

  const cols = Math.ceil(W / FOOD_GRID);
  const rows = Math.ceil(H / FOOD_GRID);
  const min = S.foodMin;
  const max = S.foodMax;
  const range = Math.max(1, max - min + 1);
  const rng = S.rng;

  for (let cx = 0; cx < cols; cx++){
    for (let cy = 0; cy < rows; cy++){
      const count = min + Math.floor(rng() * range);
      for (let i = 0; i < count; i++){
        let placed = false;
        for (let attempt = 0; attempt < 8; attempt++){
          const x = cx * FOOD_GRID + Math.floor(rng() * FOOD_GRID);
          const y = cy * FOOD_GRID + Math.floor(rng() * FOOD_GRID);
          if (x >= W || y >= H) continue;
          const key = x + ',' + y;
          if (S.game.foods.has(key)) continue;
          const f = {
            id: ++foodId, x, y,
            e: Math.floor(rng() * FOOD_TYPES.length),
          };
          S.game.foods.set(key, f);
          S.game.foodById.set(f.id, f);
          addFoodToBucket(f);
          placed = true;
          break;
        }
        if (!placed) break;
      }
    }
  }
  S.game.initFoodCount = foodId;
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
    S.game.foodById.set(f.id, f);
    addFoodToBucket(f);
    // 房主记录食物增量，随快照广播给同学
    if (S.online && S.role === 'host') S.game.foodEv.add.push([f.id, f.x, f.y, f.e]);
    return;
  }
}

function createGame(seed){
  foodId = 0; // 新世界从 1 开始编号，保证同学端按种子重建后 id 一致
  S.seed = (typeof seed === 'number') ? (seed >>> 0) : (Math.random() * 0xffffffff) >>> 0;
  S.rng = mulberry32(S.seed);
  S.game = {
    player: makeSnake(true, COLORS[0]),
    ai: [],
    aiMap: new Map(),     // 同学端：sid -> 蛇（AI 与其他同学）
    remotes: [],          // 房主端：同学蛇
    foods: new Map(),
    foodById: new Map(),  // id -> 食物（用于增量同步）
    foodBuckets: new Map(),
    foodEv: { add: [], del: [] }, // 房主：待广播的食物增减
    initFoodCount: 0,
  };
  S.game.player.name = S.nick || '你';
  if (!(S.online && S.role === 'guest')){
    for (let i = 0; i < AI_COUNT; i++){
      const a = makeSnake(false, COLORS[(i + 1) % COLORS.length]);
      a.name = 'AI';
      a.sid = 1000 + i;
      S.game.ai.push(a);
    }
  }
  respawnSnake(S.game.player);
  if (!(S.online && S.role === 'guest')){
    for (const a of S.game.ai) respawnSnake(a);
  }
  generateAllFood();
  S.lastTickTime = performance.now();
  S.camInit = false;
  S.snapReceived = false;
}

function findFoodAt(x, y){
  return S.game.foods.get(x + ',' + y);
}

function dropEatenFood(s){
  const g = S.game;
  if (!g) return;
  const types = s.eatenTypes || [];
  const record = S.online && S.role === 'host';
  for (const seg of s.snake){
    const key = seg.x + ',' + seg.y;
    if (g.foods.has(key)) continue;
    const e = types.length > 0
      ? types.pop()
      : Math.floor(Math.random() * FOOD_TYPES.length);
    const f = { id: ++foodId, x: seg.x, y: seg.y, e };
    g.foods.set(key, f);
    g.foodById.set(f.id, f);
    addFoodToBucket(f);
    if (record) g.foodEv.add.push([f.id, f.x, f.y, f.e]);
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
      g.foodById.delete(f.id);
      if (S.online && S.role === 'host') g.foodEv.del.push(f.id);
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
  // 房主：每 tick 向所有同学广播快照
  if (S.online && S.role === 'host') hostBroadcast();
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
  } else if (s.name && s.name !== 'AI'){
    ctx.font = 'bold 10px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText(s.name, hx, hy - CELL * 0.8);
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
      <span class="pp-nick">${escapeHtml(s.isPlayer ? '你' : (s.name || 'AI'))}</span>
      <span class="pp-score">${s.score}</span>
    </div>
  `).join('');

  // 联机状态
  const hudOnline = document.getElementById('hudOnline');
  if (S.online){
    hudOnline.hidden = false;
    document.getElementById('hudOnlineCount').textContent = S.role === 'host'
      ? allSnakes().length
      : 1 + S.game.ai.length;
    document.getElementById('hudOnlineRole').textContent = S.role === 'host' ? '房主' : '同学';
  } else {
    hudOnline.hidden = true;
  }

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
  if (!S.game) createGame();
  resizeCanvas();
  showScreen('game');
  S.paused = false;
  document.getElementById('pauseOverlay').classList.remove('show');
  // HUD 显示当前食物设置
  document.getElementById('hudFoodRange').textContent = `${S.foodMin}~${S.foodMax}`;

  if (S.tickTimer) clearInterval(S.tickTimer);
  // 同学端不跑本地模拟（权威在房主），只接收快照渲染
  if (!(S.online && S.role === 'guest')){
    S.tickTimer = setInterval(tick, TICK_MS);
  }
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
  if (S.online){ toast('联机模式下无法暂停'); return; }
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
  if (!S.game || S.paused) return;
  const dir = DIRS[d];
  if (!dir) return;
  const p = S.game.player;
  if (dir.x === -p.dir.x && dir.y === -p.dir.y) return;
  if (S.online){
    if (S.role === 'guest'){
      // 同学端：只把方向发给房主，由房主权威模拟
      if (!p.alive) return;
      Net.sendToHost({ t: 'input', d });
    } else {
      if (!p.alive) return;
      p.nextDir = dir;
    }
    return;
  }
  if (!p.alive) return;
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
  document.getElementById('onlineNick').textContent = S.nick;
  showScreen('online');
});

document.getElementById('btnExitGame').addEventListener('click', () => {
  if (S.online) leaveOnline();
  else backToMenu();
});
document.getElementById('btnPause').addEventListener('click', togglePause);
document.getElementById('btnResume').addEventListener('click', togglePause);
document.getElementById('btnRestart').addEventListener('click', () => {
  if (S.online){
    if (S.role === 'host') hostRestart();
    else toast('只有房主可以重新开始');
    return;
  }
  startGame();
});

/* =========================================================
   联机核心（WebRTC P2P · 房主权威 · 星型中继）
   ---------------------------------------------------------
   房主：跑完整模拟，每 tick 向每个同学广播快照（AOI 过滤）
         + 食物增减增量；同学只发方向指令。
   同学：用同一 seed 本地重建食物图，按快照渲染。
   ========================================================= */
function pickGuestColor(id){
  return COLORS[(id + 5) % COLORS.length];
}

function spawnRemoteSnake(peerId, name, color){
  const rs = makeSnake(false, color);
  rs.isRemote = true;
  rs.name = name;
  rs.sid = 5000 + peerId;
  respawnSnake(rs);
  return rs;
}

/* ---------- 房主：广播快照 ---------- */
function hostBroadcast(){
  const g = S.game;
  if (!g) return;
  const ev = { add: g.foodEv.add, del: g.foodEv.del };
  S.netPeers.forEach((rs, id) => {
    const head = (rs.alive && rs.snake.length) ? rs.snake[0] : null;
    // 同学自己的蛇：完整身体 + 朝向 + 状态
    const me = {
      body: packBody(rs),
      dir: rs.dir,
      alive: rs.alive,
      score: rs.score,
      respawnIn: rs.alive ? 0 : Math.max(0, Math.round(rs.respawnAt - performance.now())),
    };
    // 其他蛇：只发附近（AOI）的完整身体，远处的只发蛇头（供小地图）
    const others = [];
    for (const s of allSnakes()){
      if (s === rs) continue;
      const o = { id: s.sid, name: s.name || '', color: s.color, alive: s.alive, score: s.score };
      if (s.alive && s.snake.length){
        const h = s.snake[0];
        o.hx = h.x; o.hy = h.y; o.dir = s.dir;
        if (head && Math.abs(h.x - head.x) < 55 && Math.abs(h.y - head.y) < 55){
          o.body = packBody(s);
        }
      }
      others.push(o);
    }
    Net.sendToPeer(id, { t: 'snap', me, others, ev });
  });
  g.foodEv.add.length = 0;
  g.foodEv.del.length = 0;
}

/* ---------- 同学：应用食物增量 ---------- */
function applyFoodDelta(add, del){
  const g = S.game;
  if (!g) return;
  if (del){
    for (const id of del){
      const f = g.foodById.get(id);
      if (f){
        g.foods.delete(f.x + ',' + f.y);
        removeFoodFromBucket(f);
        g.foodById.delete(id);
      }
    }
  }
  if (add){
    for (const a of add){
      const f = { id: a[0], x: a[1], y: a[2], e: a[3] };
      const key = f.x + ',' + f.y;
      if (g.foods.has(key)) continue;
      g.foods.set(key, f);
      g.foodById.set(f.id, f);
      addFoodToBucket(f);
    }
  }
}

/* ---------- 同学：应用快照 ---------- */
function applySnap(msg){
  const g = S.game;
  if (!g) return;
  const p = g.player;

  p.prevSnake = p.snake;
  p.snake = unpackBody(msg.me.body || []);
  if (msg.me.dir) p.dir = msg.me.dir;
  p.alive = msg.me.alive;
  p.score = msg.me.score || 0;
  if (!p.alive) p.respawnAt = performance.now() + (msg.me.respawnIn || 0);

  const seen = new Set();
  for (const o of msg.others || []){
    seen.add(o.id);
    let s = g.aiMap.get(o.id);
    if (!s){
      s = makeSnake(false, o.color);
      s.sid = o.id;
      s.name = o.name;
      s.isRemote = true;
      g.aiMap.set(o.id, s);
      g.ai.push(s);
    }
    s.name = o.name;
    s.color = o.color;
    s.alive = o.alive;
    s.score = o.score || 0;
    if (o.alive && o.body){
      s.prevSnake = s.snake;
      s.snake = unpackBody(o.body);
      if (o.dir) s.dir = o.dir;
    } else if (!o.alive){
      s.snake = [];
      s.prevSnake = [];
    }
  }
  // 移除已不在场的蛇
  for (const [id, s] of Array.from(g.aiMap)){
    if (!seen.has(id)){
      g.aiMap.delete(id);
      const i = g.ai.indexOf(s);
      if (i >= 0) g.ai.splice(i, 1);
    }
  }

  applyFoodDelta(msg.ev && msg.ev.add, msg.ev && msg.ev.del);
  S.lastTickTime = performance.now();

  if (!S.snapReceived){
    S.snapReceived = true;
    toast('游戏开始！');
  }
}

/* ---------- 同学：收到房主欢迎（种子同步） ---------- */
function onWelcome(msg){
  foodId = 0;
  createGame(msg.seed);            // 同一 seed → 与房主完全相同的食物图
  foodId = msg.foodId || 0;        // 对齐房主计数器，之后新食物 id 由快照驱动
  applyFoodDelta(null, msg.eaten); // 剔除房主已吃掉的初始食物
  startGame();
  toast('已连接到房主');
}

/* ---------- 房主：重新开始（同步新种子） ---------- */
function hostRestart(){
  if (S.role !== 'host'){ toast('只有房主可以重新开始'); return; }
  const metas = Array.from(S.peerMeta.entries());
  createGame();
  S.netPeers.clear();
  for (const [id, meta] of metas){
    const rs = spawnRemoteSnake(id, meta.name, meta.color);
    S.netPeers.set(id, rs);
    Net.sendToPeer(id, { t: 'welcome', seed: S.seed, foodId: foodId, ai: AI_COUNT });
  }
  toast('已重新开始，新种子已同步');
}

/* ---------- 离开联机 ---------- */
function leaveOnline(){
  Net.closeAll();
  S.online = false;
  S.role = null;
  S.netPeers.clear();
  S.peerMeta.clear();
  stopGame();
  showScreen('menu');
}

/* ---------- Net 事件绑定 ---------- */
Net.on.peerOpen = (peerId) => {
  if (!S.game) createGame();
  const name = '同学' + peerId;
  const color = pickGuestColor(peerId);
  S.peerMeta.set(peerId, { name, color });
  const rs = spawnRemoteSnake(peerId, name, color);
  S.netPeers.set(peerId, rs);
  // 欢迎包：种子 + 食物计数器 + 已被吃掉的初始食物 id
  let eaten = null;
  if (S.game.initFoodCount && S.game.initFoodCount <= 4000){
    eaten = [];
    for (let id = 1; id <= S.game.initFoodCount; id++){
      if (!S.game.foodById.has(id)) eaten.push(id);
    }
  }
  Net.sendToPeer(peerId, { t: 'welcome', seed: S.seed, foodId: foodId, ai: AI_COUNT, eaten });
  toast(`同学${peerId} 已接入房间`);
};

Net.on.peerClose = (peerId) => {
  const rs = S.netPeers.get(peerId);
  if (rs && S.game){
    if (rs.alive && rs.snake.length) dropEatenFood(rs); // 掉食物，其他同学可见
    const i = S.game.remotes.indexOf(rs);
    if (i >= 0) S.game.remotes.splice(i, 1);
  }
  S.netPeers.delete(peerId);
  S.peerMeta.delete(peerId);
  if (S.online && S.role === 'host') toast(`同学${peerId} 已离开`);
};

Net.on.hostOpen = () => {
  Net.sendToHost({ t: 'hello', name: S.nick, color: MY_COLOR });
  toast('已连接到房主，等待同步…');
};

Net.on.hostClose = () => {
  if (S.role !== 'guest') return;
  toast('房主已离开，连接断开');
  leaveOnline();
};

Net.on.message = (peerId, msg) => {
  if (!msg) return;
  if (S.role === 'host'){
    if (msg.t === 'hello'){
      const name = (String(msg.name || '').slice(0, 8)) || ('同学' + peerId);
      const color = COLORS.includes(msg.color) ? msg.color : pickGuestColor(peerId);
      S.peerMeta.set(peerId, { name, color });
      const rs = S.netPeers.get(peerId);
      if (rs){ rs.name = name; rs.color = color; }
    } else if (msg.t === 'input'){
      const rs = S.netPeers.get(peerId);
      if (rs && rs.alive){
        const dir = DIRS[msg.d];
        if (dir && !(dir.x === -rs.dir.x && dir.y === -rs.dir.y)) rs.nextDir = dir;
      }
    }
  } else if (S.role === 'guest'){
    if (msg.t === 'welcome') onWelcome(msg);
    else if (msg.t === 'snap') applySnap(msg);
  }
};

/* ---------- 联机大厅 UI ---------- */
let hostWatchdog = null, guestWatchdog = null;

function showCodeLen(el, code){
  const kb = (code.length / 1024).toFixed(2);
  el.textContent = '码长 ' + kb + ' KB';
}

function switchOnlineTab(t){
  document.getElementById('tabHost').classList.toggle('active', t === 'host');
  document.getElementById('tabGuest').classList.toggle('active', t === 'guest');
  document.getElementById('paneHost').hidden = t !== 'host';
  document.getElementById('paneGuest').hidden = t !== 'guest';
}
document.getElementById('tabHost').addEventListener('click', () => switchOnlineTab('host'));
document.getElementById('tabGuest').addEventListener('click', () => switchOnlineTab('guest'));
document.getElementById('btnOnlineBack').addEventListener('click', leaveOnline);

document.getElementById('btnCreateRoom').addEventListener('click', async () => {
  S.online = true;
  S.role = 'host';
  if (!S.game) createGame();
  const r = await Net.createInvite(document.getElementById('hostIp').value);
  document.getElementById('inviteCode').value = r.code;
  showCodeLen(document.getElementById('inviteLen'), r.code);
  if (r.mdns) toast('房间已创建。注意：浏览器隐藏了本机 IP，若同学连不上请填写本机 IP 后重新创建');
  else toast('房间已创建，把邀请码发给同学');
});
document.getElementById('btnCopyInvite').addEventListener('click', () => copyText(document.getElementById('inviteCode')));
document.getElementById('btnAcceptAnswer').addEventListener('click', async () => {
  const r = await Net.acceptAnswer(document.getElementById('answerIn').value);
  if (r.ok){
    document.getElementById('answerIn').value = '';
    toast('已确认，等待同学接入…');
    clearTimeout(hostWatchdog);
    hostWatchdog = setTimeout(() => {
      if (!Net.isPeerOpen(r.id)){
        toast('连接超时：让同学检查邀请码是否复制完整；仍不行就双方填写本机 IP 后重试');
      }
    }, 15000);
  } else {
    toast(r.err);
  }
});
document.getElementById('btnHostStart').addEventListener('click', () => {
  if (!S.game) createGame();
  startGame();
});
document.getElementById('btnJoinRoom').addEventListener('click', async () => {
  S.online = true;
  S.role = 'guest';
  const r = await Net.joinWithCode(
    document.getElementById('inviteIn').value,
    document.getElementById('guestIp').value
  );
  if (!r.ok){
    S.online = false;
    S.role = null;
    toast(r.err);
    return;
  }
  document.getElementById('answerCode').value = r.code;
  showCodeLen(document.getElementById('answerLen'), r.code);
  if (r.mdns) toast('应答码已生成。注意：浏览器隐藏了本机 IP，若连不上请填写本机 IP 后重新生成');
  else toast('应答码已生成，发给房主后等待确认');
  clearTimeout(guestWatchdog);
  guestWatchdog = setTimeout(() => {
    if (!Net.hostReady()){
      toast('等待超时：请确认房主已点「确认连接」；仍不行就双方填写本机 IP 后重试');
    }
  }, 15000);
});
document.getElementById('btnCopyAnswer').addEventListener('click', () => copyText(document.getElementById('answerCode')));

addEventListener('beforeunload', () => { Net.closeAll(); });

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