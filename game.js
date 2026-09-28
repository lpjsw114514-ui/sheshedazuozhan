/* =========================================================
   蛇蛇大作战 —— 纯前端无服务器版本
   通信：BroadcastChannel（同源标签页之间）
   ========================================================= */

/* ---------------- 世界常量 ---------------- */
const W = 400, H = 400;            // 世界大小（格）
const CELL = 16;                   // 每格像素
const TICK_MS = 100;               // 逻辑帧间隔
const RESPAWN_MS = 5000;           // 重生等待
const FOOD_COUNT = 1200;           // 食物数量
const FOOD_TYPES = ['🍎', '🍌', '🍅'];
const COLORS = ['#5ee7a0','#5bc8ff','#a78bfa','#ffd93d','#ff7b7b','#ff9f5b','#4de3d1','#f472b6'];
const START_LEN = 5;
const MAX_PLAYERS = 8;

const DIRS = {
  up:    { x: 0, y: -1 },
  down:  { x: 0, y: 1 },
  left:  { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/* ---------------- 全局状态 ---------------- */
const S = {
  screen: 'name',
  myId: 'p_' + Math.random().toString(36).slice(2, 10),
  myNick: '',
  room: null,          // { code, hostId, players: [{id,nick,color}] }
  game: null,          // 当前渲染用状态
  prevGame: null,
  stateTime: 0,
  lastDir: null,
};

const peers = new Map();   // id -> { nick, lastSeen, inRoom }
const foodMap = new Map(); // id -> { id, x, y, e }

let game = null;           // 房主端的权威游戏对象
let tickTimer = null;
let foodSeq = 0;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

/* ---------------- 工具 ---------------- */
function esc(s){
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }

let toastTimer = null;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}
function showScreen(name){
  S.screen = name;
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  const el = document.getElementById('scr-' + name);
  if (el) el.classList.add('active');
}

/* ---------------- 本地昵称存储 ---------------- */
const NICK_KEY = 'snake_arena_nick';
function loadNick(){
  try { return localStorage.getItem(NICK_KEY) || ''; } catch(e){ return ''; }
}
function saveNick(n){
  try { localStorage.setItem(NICK_KEY, n); } catch(e){}
}

/* ---------------- 通信层 ---------------- */
let bc = null;
function initChannel(){
  if (!('BroadcastChannel' in window)){
    document.getElementById('connStatus').textContent = '浏览器不支持本地联机';
    document.getElementById('connStatus').classList.add('off');
    return false;
  }
  bc = new BroadcastChannel('snake-arena-v1');
  bc.onmessage = e => handleMessage(e.data);
  document.getElementById('connStatus').textContent = '本地联机就绪';
  return true;
}
function post(msg){
  if (!bc) return;
  msg.from = S.myId;
  try { bc.postMessage(msg); } catch(e){}
}
function isHost(){ return !!(S.room && S.room.hostId === S.myId); }

/* ---------------- 心跳：发现在线玩家 ---------------- */
setInterval(() => {
  post({ t: 'ping', nick: S.myNick, inRoom: S.room ? S.room.code : null });
  const now = Date.now();
  let changed = false;
  for (const [id, p] of peers){
    if (now - p.lastSeen > 4000){ peers.delete(id); changed = true; }
  }
  if (changed) renderPeers();
}, 1500);

/* ---------------- 消息分发 ---------------- */
function handleMessage(m){
  if (!m || !m.t || m.from === S.myId) return;

  switch (m.t){

    case 'ping':
      if (!peers.has(m.from)){
        post({ t: 'ping', nick: S.myNick, inRoom: S.room ? S.room.code : null });
      }
      peers.set(m.from, { nick: m.nick, lastSeen: Date.now(), inRoom: m.inRoom });
      if (S.screen === 'menu') renderPeers();
      break;

    case 'bye':
      peers.delete(m.from);
      if (S.screen === 'menu') renderPeers();
      if (S.room){
        if (S.room.hostId === m.from){
          const wasGame = S.screen === 'game';
          leaveRoomLocal(true);
          toast(wasGame ? '房主已离开，对局结束' : '房主已离开，房间关闭');
        } else if (isHost() && game && game.players.has(m.from)){
          game.players.delete(m.from);
          if (game.running) publishState([], []);
          else broadcastRoom();
        }
      }
      break;

    case 'join':
      if (!isHost() || !game || m.code !== game.code) return;
      if (game.running){
        post({ t: 'join-fail', to: m.from, code: m.code, reason: '游戏已经开始' });
        return;
      }
      if (game.players.size >= MAX_PLAYERS){
        post({ t: 'join-fail', to: m.from, code: m.code, reason: '房间已满' });
        return;
      }
      addPlayer(m.from, m.nick);
      post({ t: 'join-ok', to: m.from, code: m.code, hostId: S.myId });
      broadcastRoom();
      break;

    case 'join-ok':
      if (m.to !== S.myId) return;
      S.room = { code: m.code, hostId: m.hostId, players: [] };
      showScreen('lobby');
      renderLobby();
      break;

    case 'join-fail':
      if (m.to !== S.myId) return;
      toast(m.reason || '无法加入房间');
      break;

    case 'room':
      if (!S.room || m.code !== S.room.code) return;
      S.room = m.room;
      if (S.screen === 'lobby') renderLobby();
      break;

    case 'start':
      if (!S.room || m.code !== S.room.code) return;
      initClientGame(m);
      showScreen('game');
      resizeCanvas();
      startLoop();
      break;

    case 'input':
      if (!isHost() || !game || !game.running || m.code !== game.code) return;
      {
        const p = game.players.get(m.from);
        if (p && DIRS[m.d]) p.nextDir = DIRS[m.d];
      }
      break;

    case 'state':
      if (!S.room || m.code !== S.room.code) return;
      if (S.screen !== 'game') return;
      applyState(m);
      break;
  }
}

/* ---------------- 玩家在线列表渲染 ---------------- */
function renderPeers(){
  const ul = document.getElementById('deviceList');
  const list = [...peers.entries()];
  document.getElementById('devCount').textContent = '(' + (list.length + 1) + ')';
  let html = `<li class="self"><span class="dot"></span><span class="nick">${esc(S.myNick)}</span>
              <span style="font-size:11px;color:#5ee7a0">(我)</span></li>`;
  for (const [id, p] of list){
    html += `<li><span class="dot"></span><span class="nick">${esc(p.nick)}</span>
             ${p.inRoom ? `<span style="font-size:11px;color:#7d94b8">房间${esc(p.inRoom)}</span>` : ''}</li>`;
  }
  ul.innerHTML = html;
}

/* ---------------- 房间大厅渲染 ---------------- */
function renderLobby(){
  const r = S.room;
  if (!r) return;
  document.getElementById('roomCode').textContent = r.code;
  document.getElementById('lobbyCount').textContent = '(' + r.players.length + ')';

  const host = r.hostId === S.myId;
  const btnStart = document.getElementById('btnStartGame');
  btnStart.style.display = host ? '' : 'none';
  document.getElementById('waitTip').textContent = host
    ? (r.players.length < 2 ? '可以开始，也可以等待更多玩家…' : '点击开始游戏')
    : '等待房主开始游戏…';

  document.getElementById('lobbyPlayers').innerHTML = r.players.map(p => `
    <li>
      <span class="pp-dot" style="background:${p.color};width:12px;height:12px;border-radius:50%;flex:0 0 12px"></span>
      <span class="nick">${esc(p.nick)}</span>
      ${p.id === r.hostId ? '<span class="tag">房主</span>' : ''}
      ${p.id === S.myId ? '<span class="tag me">我</span>' : ''}
    </li>`).join('');
}

/* =========================================================
   房主端：权威游戏逻辑
   ========================================================= */
function createRoom(){
  let code;
  let tries = 0;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
    tries++;
  } while (tries < 20 && [...peers.values()].some(p => p.inRoom === code));

  game = {
    code,
    hostId: S.myId,
    players: new Map(),
    foodPos: new Map(),
    running: false,
  };
  addPlayer(S.myId, S.myNick);
  broadcastRoom();
  showScreen('lobby');
}

function addPlayer(id, nick){
  if (game.players.has(id)) return;
  const color = COLORS[game.players.size % COLORS.length];
  game.players.set(id, {
    id, nick, color,
    snake: [], dir: { x: 1, y: 0 }, nextDir: null,
    alive: false, score: 0, respawnAt: 0,
  });
}

function broadcastRoom(){
  const players = [...game.players.values()].map(p => ({ id: p.id, nick: p.nick, color: p.color }));
  S.room = { code: game.code, hostId: S.myId, players };
  post({ t: 'room', code: game.code, room: S.room });
  renderLobby();
}

/* ---------- 出生点 ---------- */
function findSpawn(){
  for (let attempt = 0; attempt < 300; attempt++){
    const x = 15 + Math.floor(Math.random() * (W - 30));
    const y = 15 + Math.floor(Math.random() * (H - 30));
    let ok = true;
    for (const p of game.players.values()){
      if (!p.alive || !p.snake.length) continue;
      const h = p.snake[0];
      let dx = Math.abs(h.x - x); dx = Math.min(dx, W - dx);
      let dy = Math.abs(h.y - y); dy = Math.min(dy, H - dy);
      if (dx < 18 && dy < 18){ ok = false; break; }
    }
    if (ok) return { x, y };
  }
  return { x: 20 + Math.floor(Math.random() * (W - 40)),
           y: 20 + Math.floor(Math.random() * (H - 40)) };
}

function spawnPlayer(p){
  const pos = findSpawn();
  p.snake = [];
  for (let i = 0; i < START_LEN; i++){
    p.snake.push({ x: ((pos.x - i) % W + W) % W, y: pos.y });
  }
  p.dir = { x: 1, y: 0 };
  p.nextDir = null;
  p.alive = true;
  p.score = 0;
  p.respawnAt = 0;
}

/* ---------- 食物 ---------- */
function makeFood(){
  const f = {
    id: ++foodSeq,
    x: Math.floor(Math.random() * W),
    y: Math.floor(Math.random() * H),
    e: Math.floor(Math.random() * FOOD_TYPES.length),
  };
  game.foodPos.set(f.x + ',' + f.y, f);
  return f;
}

/* ---------- 开始游戏 ---------- */
function startGame(){
  if (!isHost() || !game) return;
  game.running = true;
  game.foodPos.clear();
  foodSeq = 0;

  for (const p of game.players.values()) spawnPlayer(p);
  for (let i = 0; i < FOOD_COUNT; i++) makeFood();

  const state = buildState([], []);
  const foods = [...game.foodPos.values()].map(f => [f.id, f.x, f.y, f.e]);

  S.prevGame = null;
  S.game = state;
  S.stateTime = performance.now();
  showScreen('game');
  resizeCanvas();
  startLoop();

  post({ t: 'start', code: game.code, players: state.players, foods });

  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, TICK_MS);
}

/* ---------- 每帧逻辑 ---------- */
function tick(){
  if (!game || !game.running) return;
  const now = Date.now();

  // 1. 重生
  for (const p of game.players.values()){
    if (!p.alive && p.respawnAt && now >= p.respawnAt) spawnPlayer(p);
  }

  // 2. 应用待处理方向（禁止 180° 掉头）
  for (const p of game.players.values()){
    if (!p.alive) continue;
    if (p.nextDir){
      const nd = p.nextDir;
      if (!(nd.x === -p.dir.x && nd.y === -p.dir.y)) p.dir = nd;
      p.nextDir = null;
    }
  }

  // 3. 计算所有新蛇头
  const heads = new Map();
  for (const p of game.players.values()){
    if (!p.alive) continue;
    const h = p.snake[0];
    heads.set(p.id, {
      x: ((h.x + p.dir.x) % W + W) % W,
      y: ((h.y + p.dir.y) % H + H) % H,
    });
  }

  // 4. 死亡判定
  const dead = new Set();
  for (const p of game.players.values()){
    if (!p.alive) continue;
    const nh = heads.get(p.id);
    // 撞自己
    for (let i = 1; i < p.snake.length; i++){
      if (p.snake[i].x === nh.x && p.snake[i].y === nh.y){ dead.add(p.id); break; }
    }
    // 撞别人
    for (const o of game.players.values()){
      if (o.id === p.id || !o.alive) continue;
      for (let i = 0; i < o.snake.length; i++){
        if (o.snake[i].x === nh.x && o.snake[i].y === nh.y){
          dead.add(p.id);
          if (i === 0) dead.add(o.id);   // 头碰头 → 双双死亡
          break;
        }
      }
    }
  }

  // 5. 移动 / 吃食物
  const eaten = [], spawned = [];
  for (const p of game.players.values()){
    if (!p.alive) continue;

    if (dead.has(p.id)){
      p.alive = false;
      p.score = 0;
      p.snake = [];
      p.respawnAt = now + RESPAWN_MS;
      continue;
    }

    const nh = heads.get(p.id);
    p.snake.unshift(nh);

    const key = nh.x + ',' + nh.y;
    const f = game.foodPos.get(key);
    if (f){
      game.foodPos.delete(key);
      eaten.push(f.id);
      p.score++;
      const nf = makeFood();
      spawned.push([nf.id, nf.x, nf.y, nf.e]);
    } else {
      p.snake.pop();
    }
  }

  publishState(eaten, spawned);
}

/* ---------- 构造并广播状态 ---------- */
function buildState(eaten, spawned){
  const now = Date.now();
  const players = [];
  for (const p of game.players.values()){
    const s = [];
    for (const seg of p.snake) s.push(seg.x, seg.y);
    players.push({
      id: p.id, nick: p.nick, color: p.color,
      s, dir: p.dir, alive: p.alive, score: p.score,
      respawnIn: p.alive ? 0 : Math.max(0, p.respawnAt - now),
    });
  }
  return { code: game.code, players, eaten, spawned };
}

function publishState(eaten, spawned){
  const state = buildState(eaten, spawned);
  S.prevGame = S.game;
  S.game = state;
  S.stateTime = performance.now();
  for (const id of eaten) foodMap.delete(id);
  for (const f of spawned) foodMap.set(f[0], { id: f[0], x: f[1], y: f[2], e: f[3] });
  post({ t: 'state', ...state });
}

/* =========================================================
   客户端：接收状态
   ========================================================= */
function initClientGame(m){
  foodMap.clear();
  for (const f of m.foods) foodMap.set(f[0], { id: f[0], x: f[1], y: f[2], e: f[3] });
  S.prevGame = null;
  S.game = { code: m.code, players: m.players, eaten: [], spawned: [] };
  S.stateTime = performance.now();
  S.lastDir = null;
  camInit = false;
}

function applyState(m){
  S.prevGame = S.game;
  S.game = m;
  S.stateTime = performance.now();
  if (m.eaten) for (const id of m.eaten) foodMap.delete(id);
  if (m.spawned) for (const f of m.spawned) foodMap.set(f[0], { id: f[0], x: f[1], y: f[2], e: f[3] });
}

/* =========================================================
   渲染
   ========================================================= */
let camX = 0, camY = 0, camInit = false;
let loopRunning = false;

function resizeCanvas(){
  const maxW = Math.min(1040, window.innerWidth - 20);
  const maxH = Math.min(720, window.innerHeight - 20);
  canvas.width  = Math.max(320, Math.floor(maxW));
  canvas.height = Math.max(240, Math.floor(maxH));
  canvas.style.width  = canvas.width + 'px';
  canvas.style.height = canvas.height + 'px';
  camInit = false;
}
window.addEventListener('resize', () => {
  if (S.screen === 'game') resizeCanvas();
});

function startLoop(){
  if (loopRunning) return;
  loopRunning = true;
  requestAnimationFrame(loop);
}
function loop(now){
  if (S.screen !== 'game'){ loopRunning = false; return; }
  draw(now);
  updateRespawnUI();
  renderPlayersPanel();
  requestAnimationFrame(loop);
}

function updateCamera(){
  const me = S.game ? S.game.players.find(p => p.id === S.myId) : null;
  let tx, ty;
  if (me && me.s.length >= 2){
    tx = me.s[0] * CELL + CELL / 2 - canvas.width / 2;
    ty = me.s[1] * CELL + CELL / 2 - canvas.height / 2;
  } else {
    tx = W * CELL / 2 - canvas.width / 2;
    ty = H * CELL / 2 - canvas.height / 2;
  }
  tx = clamp(tx, 0, Math.max(0, W * CELL - canvas.width));
  ty = clamp(ty, 0, Math.max(0, H * CELL - canvas.height));
  if (!camInit){ camX = tx; camY = ty; camInit = true; }
  else { camX += (tx - camX) * 0.25; camY += (ty - camY) * 0.25; }
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

/* 蛇身插值（让移动更顺滑） */
function getSnakePoints(p, t){
  const cur = p.s;
  const n = cur.length / 2;
  const prevP = S.prevGame ? S.prevGame.players.find(q => q.id === p.id) : null;
  const prev = prevP ? prevP.s : null;
  const canLerp = prev && prev.length === cur.length && cur.length > 0;
  const pts = [];
  for (let i = 0; i < n; i++){
    const cx = cur[i * 2], cy = cur[i * 2 + 1];
    if (canLerp){
      const px = prev[i * 2], py = prev[i * 2 + 1];
      const dx = cx - px, dy = cy - py;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1){
        pts.push({ x: cx, y: cy });          // 穿墙，不插值
      } else {
        pts.push({ x: px + dx * t, y: py + dy * t });
      }
    } else {
      pts.push({ x: cx, y: cy });
    }
  }
  return pts;
}

function draw(now){
  const cw = canvas.width, ch = canvas.height;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a0f1e';
  ctx.fillRect(0, 0, cw, ch);

  updateCamera();

  const t = S.prevGame ? clamp((now - S.stateTime) / TICK_MS, 0, 1) : 1;

  ctx.save();
  ctx.translate(-Math.round(camX), -Math.round(camY));

  // 可见格范围
  const x0 = Math.floor(camX / CELL) - 1;
  const x1 = Math.ceil((camX + cw) / CELL) + 1;
  const y0 = Math.floor(camY / CELL) - 1;
  const y1 = Math.ceil((camY + ch) / CELL) + 1;

  // 网格
  ctx.strokeStyle = 'rgba(90,130,200,0.09)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x <= x1; x++){
    if (x < 0 || x > W) continue;
    ctx.moveTo(x * CELL + .5, Math.max(0, y0 * CELL));
    ctx.lineTo(x * CELL + .5, Math.min(H * CELL, y1 * CELL));
  }
  for (let y = y0; y <= y1; y++){
    if (y < 0 || y > H) continue;
    ctx.moveTo(Math.max(0, x0 * CELL), y * CELL + .5);
    ctx.lineTo(Math.min(W * CELL, x1 * CELL), y * CELL + .5);
  }
  ctx.stroke();

  // 世界边界
  ctx.strokeStyle = 'rgba(120,170,255,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, W * CELL, H * CELL);

  if (!S.game) { ctx.restore(); return; }

  // 食物
  ctx.font = Math.round(CELL * 0.86) + 'px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const f of foodMap.values()){
    if (f.x < x0 || f.x > x1 || f.y < y0 || f.y > y1) continue;
    ctx.fillText(FOOD_TYPES[f.e], f.x * CELL + CELL / 2, f.y * CELL + CELL / 2 + 1);
  }

  // 蛇
  for (const p of S.game.players){
    if (!p.alive || !p.s || p.s.length < 2) continue;
    const pts = getSnakePoints(p, t);
    if (!pts.length) continue;
    const isMe = p.id === S.myId;

    if (isMe){
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 16;
    }
    for (let i = pts.length - 1; i >= 0; i--){
      const pt = pts[i];
      if (pt.x < x0 - 1 || pt.x > x1 + 1 || pt.y < y0 - 1 || pt.y > y1 + 1) continue;
      const pad = 1.2;
      ctx.fillStyle = i === 0 ? p.color : shade(p.color, -0.32);
      roundRect(pt.x * CELL + pad, pt.y * CELL + pad, CELL - pad * 2, CELL - pad * 2, i === 0 ? 6 : 4);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // 眼睛
    const h = pts[0];
    const hx = h.x * CELL + CELL / 2, hy = h.y * CELL + CELL / 2;
    const d = (p.dir && (p.dir.x || p.dir.y)) ? p.dir : { x: 1, y: 0 };
    const px = -d.y, py = d.x;
    const fx = d.x * CELL * 0.16, fy = d.y * CELL * 0.16;
    const ox = px * CELL * 0.2, oy = py * CELL * 0.2;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(hx + fx + ox, hy + fy + oy, 2.4, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(hx + fx - ox, hy + fy - oy, 2.4, 0, 7); ctx.fill();
    ctx.fillStyle = '#0a0f1e';
    ctx.beginPath(); ctx.arc(hx + fx + ox + d.x * 0.8, hy + fy + oy + d.y * 0.8, 1.2, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(hx + fx - ox + d.x * 0.8, hy + fy - oy + d.y * 0.8, 1.2, 0, 7); ctx.fill();

    // 昵称
    ctx.font = 'bold 12px system-ui,sans-serif';
    ctx.fillStyle = isMe ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.62)';
    ctx.fillText(p.nick, hx, hy - CELL * 0.95);
  }

  ctx.restore();

  drawMinimap();
}

/* ---------- 小地图 ---------- */
function drawMinimap(){
  const size = 138, pad = 16;
  const mx = canvas.width - size - pad;
  const my = canvas.height - size - pad;

  ctx.fillStyle = 'rgba(10,16,30,0.86)';
  roundRect(mx, my, size, size, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(96,140,210,0.35)';
  ctx.lineWidth = 1;
  roundRect(mx + .5, my + .5, size - 1, size - 1, 10); ctx.stroke();

  if (!S.game) return;
  const k = size / W;

  // 视口框
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    mx + (camX / CELL) * k,
    my + (camY / CELL) * k,
    (canvas.width / CELL) * k,
    (canvas.height / CELL) * k
  );

  // 玩家点
  for (const p of S.game.players){
    if (!p.alive || !p.s || p.s.length < 2) continue;
    const isMe = p.id === S.myId;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(mx + (p.s[0] + 0.5) * k, my + (p.s[1] + 0.5) * k, isMe ? 4 : 2.6, 0, 7);
    ctx.fill();
    if (isMe){
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }
}

/* ---------- 玩家面板 ---------- */
function renderPlayersPanel(){
  const el = document.getElementById('playersPanel');
  if (!S.game){ el.innerHTML = ''; return; }
  const list = [...S.game.players].sort((a, b) => b.score - a.score);
  el.innerHTML = list.map(p => `
    <div class="pp-row ${p.id === S.myId ? 'me' : ''} ${p.alive ? '' : 'dead'}">
      <span class="pp-dot" style="background:${p.color}"></span>
      <span class="pp-nick">${esc(p.nick)}</span>
      <span class="pp-score">${p.score}</span>
    </div>`).join('');

  const me = S.game.players.find(p => p.id === S.myId);
  document.getElementById('hudScore').textContent = me ? me.score : 0;
  if (S.room) document.getElementById('hudRoom').textContent = S.room.code;
}

/* ---------- 重生倒计时 ---------- */
let respawnBase = 0, respawnBaseTime = 0;
function updateRespawnUI(){
  const ov = document.getElementById('respawnOverlay');
  const me = S.game ? S.game.players.find(p => p.id === S.myId) : null;
  if (!me || me.alive){ ov.classList.remove('show'); respawnBase = 0; return; }

  if (me.respawnIn !== respawnBase){
    respawnBase = me.respawnIn || 0;
    respawnBaseTime = Date.now();
  }
  const remain = Math.max(0, (respawnBase - (Date.now() - respawnBaseTime)) / 1000);
  document.getElementById('respawnCount').textContent = remain.toFixed(1);
  ov.classList.add('show');
}

/* =========================================================
   输入
   ========================================================= */
const KEYMAP = {
  ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
  w:'up', s:'down', a:'left', d:'right',
  W:'up', S:'down', A:'left', D:'right',
};
window.addEventListener('keydown', e => {
  if (S.screen !== 'game') return;
  const d = KEYMAP[e.key];
  if (d){ e.preventDefault(); sendDir(d); }
}, { passive: false });

function sendDir(d){
  if (!S.room || S.screen !== 'game') return;
  if (d === S.lastDir) return;
  S.lastDir = d;
  if (isHost()){
    const p = game && game.players.get(S.myId);
    if (p) p.nextDir = DIRS[d];
  } else {
    post({ t: 'input', code: S.room.code, d });
  }
  setTimeout(() => { if (S.lastDir === d) S.lastDir = null; }, 60);
}

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
   离开 / 清理
   ========================================================= */
function leaveRoomLocal(silent){
  if (tickTimer){ clearInterval(tickTimer); tickTimer = null; }
  if (game) game.running = false;
  game = null;
  S.room = null;
  S.game = null;
  S.prevGame = null;
  foodMap.clear();
  camInit = false;
  loopRunning = false;
  document.getElementById('respawnOverlay').classList.remove('show');
  if (!silent) post({ t: 'bye', nick: S.myNick });
  showScreen('menu');
  renderPeers();
}

/* =========================================================
   UI 事件绑定
   ========================================================= */
document.getElementById('btnEnter').addEventListener('click', () => {
  const raw = document.getElementById('nickInput').value.trim();
  if (!raw){ toast('请先取个名字'); return; }
  const chars = Array.from(raw);
  if (chars.length > 8){ toast('昵称最多 8 位'); return; }
  S.myNick = chars.join('');
  saveNick(S.myNick);

  if (!initChannel()){ toast('当前浏览器不支持本地联机'); return; }

  document.getElementById('menuNick').textContent = S.myNick;
  showScreen('menu');
  renderPeers();
  post({ t: 'ping', nick: S.myNick, inRoom: null });
});
document.getElementById('nickInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnEnter').click();
});

document.getElementById('btnCreate').addEventListener('click', () => {
  if (!bc){ toast('联机未就绪'); return; }
  createRoom();
});

document.getElementById('btnJoin').addEventListener('click', () => {
  const code = document.getElementById('joinCode').value.trim();
  if (!/^\d{6}$/.test(code)){ toast('请输入 6 位数字房间号'); return; }
  if (!bc){ toast('联机未就绪'); return; }
  post({ t: 'join', code, nick: S.myNick });
  toast('正在加入房间 ' + code + '…');
  setTimeout(() => {
    if (S.screen === 'menu' && !S.room) toast('未找到该房间（请确认房主已创建且游戏未开始）');
  }, 1200);
});
document.getElementById('joinCode').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});
document.getElementById('joinCode').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnJoin').click();
});

document.getElementById('btnCopy').addEventListener('click', () => {
  const code = S.room ? S.room.code : '';
  if (navigator.clipboard){
    navigator.clipboard.writeText(code).then(
      () => toast('房间号已复制：' + code),
      () => toast('房间号：' + code)
    );
  } else {
    toast('房间号：' + code);
  }
});

document.getElementById('btnStartGame').addEventListener('click', () => {
  if (isHost()) startGame();
});

document.getElementById('btnLeave').addEventListener('click', () => {
  if (!S.room) { showScreen('menu'); return; }
  post({ t: 'bye', nick: S.myNick });
  leaveRoomLocal(true);
});

document.getElementById('btnExit').addEventListener('click', () => {
  post({ t: 'bye', nick: S.myNick });
  leaveRoomLocal(true);
});

window.addEventListener('beforeunload', () => {
  post({ t: 'bye', nick: S.myNick });
});

/* =========================================================
   启动
   ========================================================= */
(function init(){
  const saved = loadNick();
  if (saved){
    document.getElementById('nickInput').value = saved;
    S.myNick = saved;
    document.getElementById('menuNick').textContent = saved;
  }
  document.getElementById('nickInput').focus();
})();