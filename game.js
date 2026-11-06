'use strict';

/* =========================================================
   蛇蛇大作战 · 离线版 · 1600×1600 · 自定义食物密度
   ========================================================= */

/* ---------------- 常量 ---------------- */
const CELL = 20;
const TICK_MS = 90;
const FOOD_TYPES = ['🍎', '🍌', '🍅'];
const COLORS = ['#5ee7a0','#5bc8ff','#a78bfa','#ffd93d','#ff7b7b','#ff9f5b','#4de3d1','#f472b6'];
const START_LEN = 5;
const AI_COUNT = 5;
const RESPAWN_MS = 3000;
/* 蛇的 sid 分配（面板行以 sid 为 key，必须全局唯一，否则行互相覆盖）：
   本地玩家 = PLAYER_SID；AI = 1000+i；远程成员 = 5000+peerId；
   快照里房主蛇用 HOST_SNAP_SID——成员端自己的 player 也是 PLAYER_SID，
   若房主 sid 与它相同，面板行会被覆盖（成员端看不到房主就是这么来的）。 */
const PLAYER_SID = 1;
const HOST_SNAP_SID = 100001;
/* 长度达到该值后获得"钢筋蛇身"：撞到自己不会死（撞别人/边界照死） */
const SELF_IMMUNE_LEN = 50;
/* 胜利长度：身长达到该值即胜利（防止无限增长占满地图），可自定义 */
const WIN_LEN_DEFAULT = 3000;
const WIN_LEN_MIN = 100;
const WIN_LEN_MAX = 100000;
const NICK_KEY = 'snake_arena_nick';
const FOOD_SETTING_KEY = 'snake_arena_food_setting';
const WIN_LEN_KEY = 'snake_arena_win_len';
const MAP_SIZE_KEY = 'snake_arena_map_size';

/* ---------------- 地图尺寸选择 ----------------
   世界按格计数（每格 CELL 像素），联机时随房主欢迎包同步。
   胜利长度 = 2 × 边长格数。artifact = 房主拥有神器面板。 */
const MAP_SIZES = [
  { cols: 200,  rows: 200,  win: 400,  artifact: false },
  { cols: 400,  rows: 400,  win: 800,  artifact: false },
  { cols: 800,  rows: 800,  win: 1600, artifact: false },
  { cols: 1600, rows: 1600, win: 2500, artifact: false },
  { cols: 1600, rows: 1600, win: 2500, artifact: true },
];
const DEFAULT_MAP_IDX = 0;

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
  role: null,           // 'host' 房主 | 'guest' 成员
  seed: 0,              // 世界种子（房主生成，成员端同步后生成完全相同的食物）
  rng: null,
  netPeers: new Map(),  // 房主：peerId -> 成员蛇对象
  peerMeta: new Map(),  // 房主：peerId -> { name, color }
  snapReceived: false,  // 成员：是否已收到第一个快照
  aiCount: AI_COUNT,    // 联机房间 AI 蛇数量（房主可自定义，0 = 纯玩家对战）
  hostAway: false,      // 成员：房主是否暂离
  immuneNotified: false, // 是否已提示过"钢筋蛇身"
  winLen: WIN_LEN_DEFAULT, // 胜利长度（按地图自动设定）
  roomNo: '',           // 房间号（6 位数字，仅作标识，与加入流程无关）
  winner: null,         // 胜利者信息 { name, color, len, isPlayer }
  continued: false,     // 本局是否已进入「继续」模式（胜利后不清场继续）
  enteredGame: false,   // 联机中是否已进入过游戏（控制主菜单房间条按钮语义）
  rejoining: false,     // 成员：是否正在请求重进（收到欢迎包时立即进房）
  pendingWelcome: false,// 成员：主菜单上有待处理的欢迎包（点了返回游戏才进）
  serverMode: false,    // 本地服务器模式（房主电脑运行 1.exe，消息经其中转）
  /* 地图尺寸（格） */
  world: { cols: 200, rows: 200, artifact: false },
  mapSizeIdx: DEFAULT_MAP_IDX,
  /* 神器（仅 artifact 地图，房主可用） */
  artifact: { immortal: false, magnet: false },
  /* 竞赛模式（仅房主在联机大厅配置，联机生效）：到时按身长排名结算 */
  comp: { on: false, minutes: 10, endAt: 0, over: false },
  blackout: false,      // 成员：被房主黑屏中
  snapWorldCols: 0,     // 房主：已广播给成员的世界列数（变化时才重发）
  snapWorldRows: 0,     // 房主：已广播给成员的世界行数
  manageOpen: null,     // 房主：玩家列表管理菜单打开的 peerId（null=关闭）
  mouse: { x: 0, y: 0, over: false }, // 鼠标在画布内的屏幕坐标（靠近蛇身弹信息卡用）
};

let foodId = 0;

/* ---------- 联机工具 ---------- */
const MY_COLOR = COLORS[Math.floor(Math.random() * COLORS.length)];

/* 确定性随机：同一 seed 在房主/成员端生成完全相同的食物图 */
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
/* 蛇的显示名：房主带「· 房主」，成员带「· 成员N」 */
function snakeLabel(s){
  let base;
  if (s.isPlayer){
    base = S.nick || '你';
    if (S.role === 'host') base += ' · 房主';
  } else if (s.isHost){
    base = (s.name || '房主') + ' · 房主';
  } else if (s.memberNo){
    base = (s.name || '成员' + s.memberNo) + ' · 成员' + s.memberNo;
  } else {
    base = s.name || '';
  }
  if (s.gifted) base += ' · 神器'; // 房主赠送的神器标识
  return base;
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
/* 世界尺寸（格），随地图像素/加长扩界动态变化 */
function worldCols(){ return S.world.cols; }
function worldRows(){ return S.world.rows; }
function inBounds(x, y){ return x >= 0 && x < S.world.cols && y >= 0 && y < S.world.rows; }

let toastTimer = null;
/* 本地服务器模式：从成员链接打开时，进菜单后自动加入房间 */
let pendingAutoJoin = null;
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
  // 离开游戏画面时收起所有覆盖层（暂停/死亡/等待/胜利/黑屏/神器面板），避免"未进游戏还显示"
  if (name !== 'game'){
    ['pauseOverlay', 'respawnOverlay', 'awayOverlay', 'winOverlay', 'blackOverlay', 'compOverlay'].forEach(id => {
      const ov = document.getElementById(id);
      if (ov) ov.classList.remove('show');
    });
    const ap = document.getElementById('artifactPanel');
    if (ap) ap.classList.remove('show');
    const si = document.getElementById('snakeInfo');
    if (si) si.classList.remove('show');
    S.mouse.over = false;
    hideRowDetail();   // 收起玩家面板 hover 详情卡
    hideManageMenu();  // 收起管理菜单
  }
  if (name === 'menu') refreshRoomBar();
}

/* ---------- 主菜单：房间状态条（退出游戏后连接仍保持） ---------- */
function refreshRoomBar(){
  const bar = document.getElementById('roomBar');
  if (!S.online){ bar.hidden = true; return; }
  bar.hidden = false;

  // 房间号（仅标识展示）
  const noWrap = document.getElementById('roomBarNo');
  if (S.roomNo){
    noWrap.hidden = false;
    document.getElementById('roomBarNoText').textContent = S.roomNo;
  } else {
    noWrap.hidden = true;
  }

  // 状态感知：没进入过游戏时不显示"返回游戏"，避免误导
  const btn = document.getElementById('btnBackToGame');
  const srv = S.serverMode ? ' · 服务器模式' : '';
  let text;
  if (S.role === 'host'){
    if (S.enteredGame){
      text = `房间进行中 · 你是房主 · ${1 + S.netPeers.size} 名玩家${srv}`;
      btn.textContent = '🎮 返回游戏';
    } else {
      text = '房间已创建 · 把邀请码发给成员' + srv;
      btn.textContent = '🎮 进入游戏';
    }
  } else {
    if (S.enteredGame){
      text = '房间进行中 · 你是成员 · 已连接房主' + srv;
      btn.textContent = '🎮 返回游戏';
    } else {
      text = '已连接房主 · 等待进入游戏' + srv;
      btn.textContent = '← 回到大厅';
    }
  }
  document.getElementById('roomBarText').textContent = text;
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

/* ---------- 胜利长度持久化 ---------- */
function loadWinLen(){
  try {
    const v = parseInt(localStorage.getItem(WIN_LEN_KEY), 10);
    if (Number.isFinite(v)) S.winLen = clamp(v, WIN_LEN_MIN, WIN_LEN_MAX);
  } catch(e){}
  if (!Number.isFinite(S.winLen)) S.winLen = WIN_LEN_DEFAULT;
}
function saveWinLen(){
  try { localStorage.setItem(WIN_LEN_KEY, String(S.winLen)); } catch(e){}
}

/* =========================================================
   地图尺寸选择（联机时随房主欢迎包同步）
   ========================================================= */
/* 尺寸地图无墙体：保留 isWall 供碰撞/生成逻辑统一判断，恒为 false */
function isWall(x, y){ return false; }
function isWallBlock(bx, by){ return false; }

/* 选择地图尺寸：重设世界尺寸与胜利长度 */
function setMapSize(idx, opts){
  const o = opts || {};
  const i = clamp(idx | 0, 0, MAP_SIZES.length - 1);
  const size = MAP_SIZES[i];
  S.mapSizeIdx = i;
  S.world = { cols: size.cols, rows: size.rows, artifact: !!size.artifact };
  S.winLen = size.win;
  S.artifact = { immortal: false, magnet: false };
  if (!o.silent){
    try { localStorage.setItem(MAP_SIZE_KEY, String(i)); } catch(e){}
    refreshMapUI();
    refreshWinLenUI();
  }
}
function loadMapSize(){
  let idx = DEFAULT_MAP_IDX;
  try {
    const v = parseInt(localStorage.getItem(MAP_SIZE_KEY), 10);
    if (Number.isFinite(v)) idx = clamp(v, 0, MAP_SIZES.length - 1);
  } catch(e){}
  setMapSize(idx, { silent: true });
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
    alive: true, score: START_LEN, respawnAt: 0, // score 语义=身长（与长度恒等）
    eatenTypes: [],
  };
}

/* 出生点必须与食物生成共用同一种子随机（S.rng）：
   这样"食物避开蛇身"的判定在房主/成员端看到完全相同的蛇身位置，
   消耗相同的随机序列，最终生成完全一致的食物图（联机同步的前提）。 */
function findSpawn(){
  const rng = S.rng || Math.random;
  for (let attempt = 0; attempt < 300; attempt++){
    const x = 12 + Math.floor(rng() * (S.world.cols - 24));
    const y = 12 + Math.floor(rng() * (S.world.rows - 24));
    let ok = true;
    for (const s of allSnakes()){
      if (!s.alive || !s.snake.length) continue;
      const h = s.snake[0];
      let dx = Math.abs(h.x - x); dx = Math.min(dx, S.world.cols - dx);
      let dy = Math.abs(h.y - y); dy = Math.min(dy, S.world.rows - dy);
      if (dx < 15 && dy < 15){ ok = false; break; }
    }
    if (ok) return { x, y };
  }
  // 兜底：远离所有蛇头的网格点（大地图按步长采样，开销可控）
  for (let y = 2; y < S.world.rows - 2; y += 3){
    for (let x = 2; x < S.world.cols - 2; x += 3){
      let free = true;
      for (const s of allSnakes()){
        if (!s.alive || !s.snake.length) continue;
        const h = s.snake[0];
        let dx = Math.abs(h.x - x); dx = Math.min(dx, S.world.cols - dx);
        let dy = Math.abs(h.y - y); dy = Math.min(dy, S.world.rows - dy);
        if (dx < 15 && dy < 15){ free = false; break; }
      }
      if (free) return { x, y };
    }
  }
  return { x: S.world.cols >> 1, y: S.world.rows >> 1 };
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
  s.score = START_LEN;   // score 语义=身长：与 snake.length 恒等
  s.respawnAt = 0;
  s.eatenTypes = [];
}

/* ---------- 批量生成食物：使用当前设置的密度 ----------
   注意1：必须使用 S.rng（种子随机），这样房主与成员端
   用同一 seed 能生成完全相同的食物图（id、位置、类型一致）
   注意2：避开所有蛇身，不在蛇下面生成食物 */
function generateAllFood(){
  S.game.foods.clear();
  S.game.foodBuckets.clear();
  S.game.foodById.clear();

  // 蛇身占用表：食物不生成在蛇身上（含出生时的身体）
  const occupied = new Set();
  for (const s of allSnakes()){
    if (!s.alive) continue;
    for (const p of s.snake) occupied.add(p.x + ',' + p.y);
  }

  const cols = Math.ceil(S.world.cols / FOOD_GRID);
  const rows = Math.ceil(S.world.rows / FOOD_GRID);
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
          if (x >= S.world.cols || y >= S.world.rows) continue;
          if (isWall(x, y)) continue;      // 墙里不放食物
          const key = x + ',' + y;
          if (S.game.foods.has(key)) continue;
          if (occupied.has(key)) continue;   // 蛇身上不放食物
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

function isOnSnake(x, y){
  for (const s of allSnakes()){
    if (!s.alive) continue;
    for (const p of s.snake){
      if (p.x === x && p.y === y) return true;
    }
  }
  return false;
}

function respawnFoodNear(cx, cy){
  for (let attempt = 0; attempt < 20; attempt++){
    const x = clamp(cx + Math.floor(Math.random() * 11) - 5, 0, S.world.cols - 1);
    const y = clamp(cy + Math.floor(Math.random() * 11) - 5, 0, S.world.rows - 1);
    if (isWall(x, y)) continue;         // 墙里不放食物
    const key = x + ',' + y;
    if (S.game.foods.has(key)) continue;
    if (isOnSnake(x, y)) continue;   // 不在蛇身上重生
    const f = {
      id: ++foodId, x, y,
      e: Math.floor(Math.random() * FOOD_TYPES.length),
    };
    S.game.foods.set(key, f);
    S.game.foodById.set(f.id, f);
    addFoodToBucket(f);
    // 房主记录食物增量，随快照广播给成员
    if (S.online && S.role === 'host') S.game.foodEv.add.push([f.id, f.x, f.y, f.e]);
    return;
  }
}

function createGame(seed){
  foodId = 0; // 新世界从 1 开始编号，保证成员端按种子重建后 id 一致
  S.seed = (typeof seed === 'number') ? (seed >>> 0) : (Math.random() * 0xffffffff) >>> 0;
  S.rng = mulberry32(S.seed);
  S.game = {
    player: makeSnake(true, COLORS[0]),
    ai: [],
    aiMap: new Map(),     // 成员端：sid -> 蛇（AI 与其他成员）
    remotes: [],          // 房主端：成员蛇
    foods: new Map(),
    foodById: new Map(),  // id -> 食物（用于增量同步）
    foodBuckets: new Map(),
    foodEv: { add: [], del: [] }, // 房主：待广播的食物增减
    initFoodCount: 0,
  };
  S.game.player.sid = PLAYER_SID; // 固定且唯一（面板行 key）
  S.game.player.name = S.nick || '你';
  /* AI 蛇创建策略：
     - 房主/离线：创建真实 AI 并重生
     - 成员端：先创建等量"占位 AI"并用同一种子重生——保证随机序列消耗、
       蛇身占用位置与房主完全一致（食物图同步的前提），随后清掉；
       真正的蛇由房主快照驱动进入 g.ai */
  const guest = S.online && S.role === 'guest';
  const n = Math.max(0, Math.min(AI_COUNT, S.aiCount | 0));
  for (let i = 0; i < n; i++){
    const a = makeSnake(false, COLORS[(i + 1) % COLORS.length]);
    a.name = 'AI';
    a.sid = 1000 + i;
    S.game.ai.push(a);
  }
  respawnSnake(S.game.player);
  for (const a of S.game.ai) respawnSnake(a);
  generateAllFood();
  // 注意：占位 AI 必须在食物生成之后再清除——
  // generateAllFood 的"避让蛇身"占用表要包含它们，才能与房主完全一致
  if (guest) S.game.ai.length = 0;
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
    if (isWall(nx, ny)){
      scored.push({ d, score: -9999 });   // 墙=死路，AI 不往墙里钻
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
    let nh = newHeads.get(s);
    /* 神器·不死：仅房主端权威生效（成员端跟随快照）。
       房主本人的不死由神器面板开关控制；成员被房主「赠送神器」后
       （rs.gifted）同样获得不死之身，不受房主开关影响。 */
    const im = !!S.world.artifact && S.role === 'host' &&
      ((s.isPlayer && S.artifact.immortal) || !!s.gifted);

    /* 房主不死：撞墙自动向两边转向（沿边界滑行，不死） */
    if (im && !inBounds(nh.x, nh.y)){
      const turns = s.dir.x !== 0 ? [{ x: 0, y: 1 }, { x: 0, y: -1 }] : [{ x: 1, y: 0 }, { x: -1, y: 0 }];
      let turned = false;
      for (const d of turns){
        const tx = s.snake[0].x + d.x, ty = s.snake[0].y + d.y;
        if (inBounds(tx, ty)){ s.dir = d; nh = { x: tx, y: ty }; newHeads.set(s, nh); turned = true; break; }
      }
      if (!turned) nh = { x: s.snake[0].x, y: s.snake[0].y }; // 极端角落：原地踏步
    }

    if (!im){
      if (!inBounds(nh.x, nh.y)){ dead.add(s); continue; }
      if (isWall(nh.x, nh.y)){ dead.add(s); continue; }   // 撞墙即死

      /* 长度达到 SELF_IMMUNE_LEN 后获得"钢筋蛇身"：撞到自己不会死。
         判定在房主端权威执行，成员端通过快照自动一致。 */
      if (s.snake.length < SELF_IMMUNE_LEN){
        for (let i = 1; i < s.snake.length; i++){
          if (s.snake[i].x === nh.x && s.snake[i].y === nh.y){ dead.add(s); break; }
        }
      }
    }

    for (const o of allSnakes()){
      if (o === s || !o.alive) continue;
      for (let i = 0; i < o.snake.length; i++){
        if (o.snake[i].x === nh.x && o.snake[i].y === nh.y){
          if (!im) dead.add(s);              // 房主不死：只死对方
          if (im || i === 0) dead.add(o);    // 神器：撞成员成员死（含头对头同归）
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
      s.score = START_LEN;   // 死亡瞬间 score 归初始身长（面板/HUD 与长度一致）
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

  /* 神器·吸附食物：房主蛇头 5×5 范围内的食物每 tick 飞向蛇头一步 */
  artifactMagnet();

  /* 胜利判定：身长达到设定值即获胜（房主/单机权威判定，成员端由房主广播）。
     防止蛇无限增长占满地图。 */
  if (!S.winner && !(S.online && S.role === 'guest')){
    let best = null;
    for (const s of allSnakes()){
      if (s.alive && s.snake.length >= S.winLen){
        if (!best || s.snake.length > best.snake.length) best = s;
      }
    }
    if (best){ triggerWin(best); return; } // 本 tick 已触发胜利，不再广播快照
  }

  /* 竞赛模式：时间到 → 房主权威结算（本 tick 不再广播） */
  if (S.comp.on && !S.comp.over && !S.winner && S.online && S.role === 'host'){
    if (performance.now() >= S.comp.endAt){ endCompetition(); return; }
  }

  // 房主：每 tick 向所有成员广播快照
  if (S.online && S.role === 'host') hostBroadcast();
}

/* =========================================================
   神器（仅 1600×1600 房主有神器版地图，房主端权威）
   ========================================================= */
function hostImmortal(){
  return !!S.world.artifact && S.role === 'host' && !!(S.game && S.game.player.alive) && S.artifact.immortal;
}

/* 吸附食物：范围 5×5，食物逐格飞向蛇头，飞到蛇头格即吃掉 */
/* 神器·磁吸：蛇头 5×5 范围内的食物每 tick 飞向蛇头一步，碰到即吃掉。
   目标 = 房主本人（神器面板开关控制）+ 被赠送神器的成员（常驻）。 */
function artifactMagnet(){
  if (!S.world.artifact || S.role !== 'host') return;
  const g = S.game;
  if (!g) return;
  const targets = [];
  const p = g.player;
  if (p && p.alive && p.snake.length && S.artifact.magnet) targets.push(p);
  for (const s of allSnakes()){
    if (s === p) continue;
    if (s.gifted && s.alive && s.snake.length) targets.push(s);
  }
  for (const t of targets) magnetFor(t);
}

function magnetFor(p){
  const g = S.game;
  const h = p.snake[0];
  const movers = [];
  for (let dy = -2; dy <= 2; dy++){
    for (let dx = -2; dx <= 2; dx++){
      if (dx === 0 && dy === 0) continue;
      const f = g.foods.get((h.x + dx) + ',' + (h.y + dy));
      if (f) movers.push(f);
    }
  }
  for (const f of movers){
    const nx = f.x + Math.sign(h.x - f.x);
    const ny = f.y + Math.sign(h.y - f.y);
    const fx = f.x + ',' + f.y;
    if (nx === h.x && ny === h.y){
      // 飞到蛇头格：直接吃掉（score 与长度必须同步 +1，否则「积分和长度不一样」）
      g.foods.delete(fx); removeFoodFromBucket(f); g.foodById.delete(f.id);
      g.foodEv.del.push(f.id);
      p.score++; p.eatenTypes.push(f.e);
      // 本 tick 身体已更新完，直接在尾部补一节（等效于吃到食物不缩尾）
      const tail = p.snake[p.snake.length - 1];
      if (tail) p.snake.push({ x: tail.x, y: tail.y });
      continue;
    }
    const nk = nx + ',' + ny;
    if (g.foods.has(nk)) continue; // 目标被占用则原地不动
    g.foods.delete(fx); removeFoodFromBucket(f);
    f.x = nx; f.y = ny;
    g.foods.set(nk, f); addFoodToBucket(f);
    g.foodEv.del.push(f.id);
    g.foodEv.add.push([f.id, f.x, f.y, f.e]);
  }
}

/* 神器·加长：蛇身 +n 格。
   头保持不动（杜绝"蛇头瞬间前移 100 格冲刺突破地图"），
   新节从尾部沿尾部当前走向继续向后延伸；
   整条蛇（旧身+新节）的包围盒必须留在地图内：
   - 右/下越界 → 地图向两边扩展（cols/rows 各 +50）
   - 左/上越界 → 整条蛇平移让出空间（平移后另一侧越界则再扩界）
   联机时新尺寸经快照 world 字段同步给成员。 */
function artifactExtend(n){
  if (!S.world.artifact || S.role !== 'host' || !S.game) return;
  const p = S.game.player;
  if (!p.alive || !p.snake.length) return;
  const body = p.snake;
  const tail = body[body.length - 1];
  const prev = body.length > 1 ? body[body.length - 2] : null;
  // 尾部走向：上一节 → 末节 的方向（蛇前进时尾巴正扫过的方向）
  let tx = prev ? Math.sign(tail.x - prev.x) : -p.dir.x;
  let ty = prev ? Math.sign(tail.y - prev.y) : -p.dir.y;
  if (tx === 0 && ty === 0){ tx = -p.dir.x; ty = -p.dir.y; }
  // 新节：从末节继续向后
  const add = [];
  let x = tail.x, y = tail.y;
  for (let i = 0; i < n; i++){
    x += tx; y += ty;
    add.push({ x, y });
  }
  // 旧身 + 新节的包围盒
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of body){
    if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
  }
  for (const s of add){
    if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
  }
  // 左/上越界：整体平移（留 2 格余量）
  const offX = minX < 0 ? -minX + 2 : 0;
  const offY = minY < 0 ? -minY + 2 : 0;
  if (offX || offY){
    for (const s of body){ s.x += offX; s.y += offY; }
    for (const s of add){ s.x += offX; s.y += offY; }
    minX += offX; maxX += offX; minY += offY; maxY += offY;
  }
  // 右/下越界：地图向两边扩展
  const needCols = maxX >= S.world.cols ? maxX + 1 : 0;
  const needRows = maxY >= S.world.rows ? maxY + 1 : 0;
  if (needCols || needRows){
    S.world.cols = Math.max(S.world.cols, needCols) + 50;
    S.world.rows = Math.max(S.world.rows, needRows) + 50;
    S.camInit = false;
    toast('🗺 地图已向两边扩展为 ' + S.world.cols + '×' + S.world.rows);
  }
  for (const s of add) body.push(s);
  // 同步插值基线：加长是瞬间完成的，不做补间
  p.prevSnake = body.map(s => ({ x: s.x, y: s.y }));
}

/* ---------- 胜利 ---------- */
function triggerWin(s){
  S.winner = {
    name: s.isPlayer ? (S.nick || '你') : (s.name || 'AI'),
    color: s.color,
    len: s.snake.length,
    isPlayer: !!s.isPlayer,
  };
  // 皇冠累计：该蛇本局夺冠次数 +1（继续模式下不清零，重开新局才清零）
  s.crowns = (s.crowns || 0) + 1;
  if (S.tickTimer){ clearInterval(S.tickTimer); S.tickTimer = null; }
  if (S.online && S.role === 'host'){
    Net.broadcast({ t: 'win', name: S.winner.name, len: S.winner.len, color: S.winner.color, crowns: s.crowns });
  }
  showWinOverlay();
  toast('🏆 ' + S.winner.name + ' 身长达到 ' + S.winner.len + '，获得胜利！');
}

/* ---------- 胜利后「继续」：不清场，夺冠蛇重置长度，累计皇冠 ---------- */
function continueGame(){
  if (!S.winner) return;
  S.winner = null;
  S.continued = true;
  document.getElementById('winOverlay').classList.remove('show');
  // 已达胜利长度的蛇重置为初始长度（分数清零，皇冠保留）
  for (const s of allSnakes()){
    if (s.alive && s.snake.length >= S.winLen) respawnSnake(s);
  }
  if (!(S.online && S.role === 'guest')){
    if (S.tickTimer) clearInterval(S.tickTimer);
    S.tickTimer = setInterval(tick, TICK_MS);
  }
  if (S.online && S.role === 'host') Net.broadcast({ t: 'continue' });
  toast('👑 继续！已夺冠的蛇已重置长度，冲向下一顶皇冠');
}

/* =========================================================
   竞赛模式（仅房主在联机大厅配置）：
   - 房主进游戏时开始倒计时，并向全员广播剩余秒数（不做时钟同步，
     成员以收到时刻为基准本地倒计时，局域网误差可忽略）
   - 时间到：房主权威结算，按身长排名，全员显示排名界面
   ========================================================= */
const COMP_MINUTES = [5, 10, 15, 20, 30, 60];

/* 从联机大厅读取竞赛配置（建房入口调用） */
function readCompSetting(){
  const onEl = document.getElementById('compOn');
  const minEl = document.getElementById('compMinutes');
  S.comp.on = !!(onEl && onEl.checked);
  S.comp.minutes = clamp(parseInt(minEl && minEl.value, 10) || 10, 1, 180);
  S.comp.endAt = 0;
  S.comp.over = false;
}

/* 房主：进入游戏时启动竞赛计时并广播 */
function startCompetition(){
  if (!S.comp.on) return;
  S.comp.over = false;
  S.comp.endAt = performance.now() + S.comp.minutes * 60000;
  document.getElementById('compOverlay').classList.remove('show');
  if (S.online && S.role === 'host'){
    Net.broadcast({ t: 'comp', on: true, secs: Math.round(S.comp.minutes * 60) });
  }
  toast(`🏁 竞赛模式开始：${S.comp.minutes} 分钟，时间到按身长排名`);
}

/* 房主：时间到，权威结算并广播排名 */
function endCompetition(){
  if (!S.comp.on || S.comp.over) return;
  S.comp.over = true;
  if (S.tickTimer){ clearInterval(S.tickTimer); S.tickTimer = null; }
  const ranks = allSnakes()
    .filter(s => s.alive)
    .sort((a, b) => b.score - a.score || b.snake.length - a.snake.length)
    .map(s => ({
      name: s.isPlayer ? (S.nick || '你') : (s.name || 'AI'),
      color: s.color,
      score: s.score,
      isPlayer: !!s.isPlayer,
      isHost: !!s.isHost,
      memberNo: (typeof s.memberNo === 'number') ? s.memberNo : null,
    }));
  if (S.online && S.role === 'host') Net.broadcast({ t: 'compEnd', ranks });
  showCompOverlay(ranks);
  toast('🏁 竞赛结束！');
}

function showCompOverlay(ranks){
  const ov = document.getElementById('compOverlay');
  const box = document.getElementById('compRanks');
  if (!ov || !box) return;
  const rows = (ranks || []).map((r, i) => {
    const tag = r.isPlayer ? '（你）' : (r.isHost ? ' · 房主' : (r.memberNo ? ' · 成员' + r.memberNo : ''));
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
    return `<div class="comp-rank-row">
      <span class="cr-medal">${medal}</span>
      <span class="cr-dot" style="background:${r.color}"></span>
      <span class="cr-name">${escapeHtml(r.name)}${tag}</span>
      <span class="cr-score">${r.score}</span>
    </div>`;
  }).join('');
  box.innerHTML = rows || '<div class="comp-empty">没有存活玩家</div>';
  ov.classList.add('show');
}

function hideCompOverlay(){
  const ov = document.getElementById('compOverlay');
  if (ov) ov.classList.remove('show');
}

/* 成员：房主开/关竞赛（含重新开始时的重播） */
function applyComp(msg){
  if (msg && msg.on && typeof msg.secs === 'number' && msg.secs > 0){
    S.comp.on = true;
    S.comp.over = false;
    S.comp.endAt = performance.now() + msg.secs * 1000;
    S.comp.minutes = Math.max(1, Math.round(msg.secs / 60));
    hideCompOverlay();
    toast(`🏁 竞赛模式开始：${S.comp.minutes} 分钟`);
  } else {
    S.comp.on = false;
  }
}

/* 成员：房主广播的最终排名 */
function applyCompEnd(msg){
  S.comp.over = true;
  showCompOverlay((msg && msg.ranks) || []);
}

/* HUD 倒计时（updateUI 每帧调用） */
function refreshCompTimer(){
  const el = document.getElementById('hudCompTimer');
  if (!el) return;
  if (S.comp.on && !S.comp.over){
    const remain = Math.max(0, (S.comp.endAt - performance.now()) / 1000);
    const mm = Math.floor(remain / 60), ss = Math.floor(remain % 60);
    el.textContent = '⏱ ' + mm + ':' + String(ss).padStart(2, '0');
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function showWinOverlay(){
  const ov = document.getElementById('winOverlay');
  if (!S.winner){ ov.classList.remove('show'); return; }
  document.getElementById('winMsg').textContent = S.winner.name + ' 获得胜利！';
  document.getElementById('winMsg').style.color = S.winner.color || '#ffd93d';
  document.getElementById('winLen').textContent = '身长 ' + S.winner.len + ' / ' + S.winLen;
  ov.classList.add('show');
}

function applyWin(msg){
  S.winner = {
    name: msg.name || '房主',
    color: msg.color || '#ffd93d',
    len: msg.len || 0,
    isPlayer: false,
    crowns: msg.crowns || 0,
  };
  showWinOverlay();
  toast('🏆 ' + S.winner.name + ' 获得胜利！');
}

/* 成员：房主点了「继续」——本地同步（房主权威模拟，快照会重置夺冠蛇长度） */
function applyContinue(){
  S.winner = null;
  S.continued = true;
  document.getElementById('winOverlay').classList.remove('show');
  toast('👑 房主选择了继续，冲下一顶皇冠！');
}

/* =========================================================
   渲染
   ========================================================= */
function resizeCanvas(){
  // 手机端留更小边距，尽量撑满屏幕
  const narrow = window.innerWidth < 640;
  const margin = narrow ? 10 : 20;
  const maxW = Math.min(1280, window.innerWidth - margin);
  const maxH = Math.min(820, window.innerHeight - margin);
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
  const worldWpx = S.world.cols * CELL, worldHpx = S.world.rows * CELL;
  const tx = clamp(h.x * CELL + CELL / 2 - canvas.width / 2, 0, Math.max(0, worldWpx - canvas.width));
  const ty = clamp(h.y * CELL + CELL / 2 - canvas.height / 2, 0, Math.max(0, worldHpx - canvas.height));
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
      ctx.shadowColor = n >= SELF_IMMUNE_LEN ? '#ffd93d' : s.color;
      ctx.shadowBlur = 18;
    } else if (i === 0){
      ctx.shadowColor = n >= SELF_IMMUNE_LEN ? '#ffd93d' : s.color;
      ctx.shadowBlur = 8;
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
    ctx.fillText(snakeLabel(s), hx, hy - CELL * 0.8);
  } else if (s.isRemote && s.name && s.name !== 'AI'){
    ctx.font = 'bold 10px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText(snakeLabel(s), hx, hy - CELL * 0.8);
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
    if (x < 0 || x > S.world.cols) continue;
    ctx.moveTo(x * CELL + .5, Math.max(0, y0 * CELL));
    ctx.lineTo(x * CELL + .5, Math.min(S.world.rows * CELL, y1 * CELL));
  }
  for (let y = Math.max(0, Math.ceil(y0 / step) * step); y <= y1; y += step){
    if (y < 0 || y > S.world.rows) continue;
    ctx.moveTo(Math.max(0, x0 * CELL), y * CELL + .5);
    ctx.lineTo(Math.min(S.world.cols * CELL, x1 * CELL), y * CELL + .5);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(120,170,255,0.55)';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, S.world.cols * CELL, S.world.rows * CELL);

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
  // 小地图随画布尺寸缩放（手机端更小）
  const size = Math.max(80, Math.min(160, Math.round(Math.min(canvas.width, canvas.height) * 0.3)));
  const pad = 16;
  const mx = canvas.width - size - pad;
  const my = canvas.height - size - pad;

  ctx.fillStyle = 'rgba(10,16,30,0.86)';
  roundRect(mx, my, size, size, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(96,140,210,0.35)';
  ctx.lineWidth = 1;
  roundRect(mx + .5, my + .5, size - 1, size - 1, 10); ctx.stroke();

  if (!S.game) return;
  const k = size / Math.max(S.world.cols, S.world.rows);

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

/* 玩家面板行缓存：sid -> { row, scoreEl, sig }（按 sid 复用 DOM，见 updateUI） */
const panelRowMap = new Map();
let panelOrderSig = ''; // 当前行的排序签名（变化时才移动行）

function updateUI(){
  if (!S.game) return;
  const p = S.game.player;
  const lenEl = document.getElementById('hudLength');
  lenEl.textContent = p.alive ? p.snake.length : 0;
  // 钢筋蛇身状态：HUD 长度变金 + 首次达成提示一次
  const immune = p.alive && p.snake.length >= SELF_IMMUNE_LEN;
  lenEl.classList.toggle('immune', immune);
  if (immune && !S.immuneNotified){
    S.immuneNotified = true;
    toast('🛡 身长达到 ' + SELF_IMMUNE_LEN + '，获得钢筋蛇身：撞到自己不会死了！');
  }
  if (!immune) S.immuneNotified = false;
  // 胜利目标长度
  document.getElementById('hudWinTarget').textContent = '/' + S.winLen;

  const alive = allSnakes().filter(s => s.alive);
  const sorted = [...alive].sort((a, b) => b.score - a.score || b.snake.length - a.snake.length);
  const rank = sorted.indexOf(p) + 1;
  document.getElementById('hudRank').textContent = p.alive ? rank : '-';
  document.getElementById('hudTotal').textContent = alive.length;

  /* 玩家面板：按 sid 复用行 DOM，绝不每帧 innerHTML 重建。
     每帧重建会销毁按钮——mousedown 后到 mouseup 前元素已被替换，
     click 事件不触发，表现为「管理点不动」。 */
  const panel = document.getElementById('playersPanel');
  const list = allSnakes().filter(s => s.alive || s.isPlayer || s.isRemote);
  const sorted2 = [...list].sort((a, b) => b.score - a.score);
  const seenIds = new Set();
  const seenMids = new Set();
  for (const s of sorted2){
    seenIds.add(s.sid);
    const mid = s.memberNo || s.sid;
    const isHostView = S.online && S.role === 'host';
    const canManage = isHostView && s.isRemote && !s.isHost;
    if (canManage) seenMids.add(mid);
    /* 行结构签名：只在这些属性变化时才重建行内容 */
    const rowSig = [
      s.isPlayer ? 1 : 0, s.isRemote ? 1 : 0, s.isHost ? 1 : 0,
      s.alive ? 1 : 0, s.crowns || 0, canManage ? 1 : 0,
      s.color, snakeLabel(s),
    ].join('|');
    let rec = panelRowMap.get(s.sid);
    const isNewRow = !rec;
    if (!rec){
      rec = { row: document.createElement('div'), scoreEl: null, sig: '' };
      panelRowMap.set(s.sid, rec);
    }
    if (rec.sig !== rowSig){
      rec.sig = rowSig;
      const name = escapeHtml(snakeLabel(s));
      const crown = (s.crowns || 0) > 0
        ? `<span class="pp-crown" title="本局累计夺冠 ${s.crowns} 次">👑${s.crowns}</span>` : '';
      /* 管理按钮：菜单本体是 fixed 浮动元素（见 openManageMenu）——
         行内 absolute 菜单会被面板 overflow-y:auto 裁掉（底部成员
         点开只看到半截，「没有黑屏按键」就是这么来的） */
      const mgr = canManage
        ? `<button class="pp-manage" data-mid="${mid}" title="管理该成员">管理</button>`
        : '';
      rec.row.className = `pp-row ${s.isPlayer ? 'me' : ''} ${s.alive ? '' : 'dead'}`;
      rec.row.dataset.sid = s.sid; // hover 详情委托靠它定位行（sid 不变，设一次即可）
      rec.row.innerHTML = `
        <span class="pp-dot" style="background:${s.color}"></span>
        <span class="pp-nick">${name}</span>
        ${crown}
        <span class="pp-score"></span>
        ${mgr}`;
      rec.scoreEl = rec.row.querySelector('.pp-score');
    }
    /* 分数高频变化：只更新文本，不动 DOM 结构 */
    if (rec.scoreEl) rec.scoreEl.textContent = s.score;
    if (isNewRow) panel.appendChild(rec.row); // 新行立即入列
  }
  /* 排序变化时才移动行；菜单打开/hover 详情期间冻结（移动行会中断进行中的点击）。
     已存在的节点仅调整顺序，不重建。 */
  if (S.manageOpen === null && hoverSid === null){
    const orderSig = sorted2.map(s => s.sid).join(',');
    if (orderSig !== panelOrderSig){
      panelOrderSig = orderSig;
      for (const s of sorted2) panel.appendChild(panelRowMap.get(s.sid).row);
    }
  }
  // 移除离场玩家的行
  for (const [sid, rec] of Array.from(panelRowMap)){
    if (!seenIds.has(sid)){
      if (hoverSid === sid) hideRowDetail();
      if (manageMenuRow === rec.row) hideManageMenu();
      if (rec.row.remove) rec.row.remove();
      panelRowMap.delete(sid);
    }
  }
  // 管理菜单指向的成员已离场：收起菜单
  if (S.manageOpen !== null && !seenMids.has(S.manageOpen)) hideManageMenu();

  // 联机状态
  const hudOnline = document.getElementById('hudOnline');
  if (S.online){
    hudOnline.hidden = false;
    document.getElementById('hudOnlineCount').textContent = S.role === 'host'
      ? allSnakes().length
      : 1 + S.game.ai.length;
    document.getElementById('hudOnlineRole').textContent = (S.role === 'host' ? '房主' : '成员') + (S.serverMode ? '·服务器' : '');
    document.getElementById('hudRoomNo').textContent = S.roomNo ? ' · 房号 ' + S.roomNo : '';
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

  updateSnakeInfo();
  refreshRowDetail();
  refreshManageMenu();
  refreshCompTimer();
}

/* =========================================================
   鼠标靠近某条蛇：屏幕左侧弹出该蛇信息卡
   （靠近 = 蛇头 8 格内，或身体抽样 8 格内；pointer-events 穿透不挡操作）
   ========================================================= */
let infoSid = null;
let infoStatusEl = null;
function updateSnakeInfo(){
  const box = document.getElementById('snakeInfo');
  if (!box) return;
  let target = null;
  if (S.game && S.mouse.over && S.screen === 'game'){
    const wx = (S.camX + S.mouse.x) / CELL;
    const wy = (S.camY + S.mouse.y) / CELL;
    let bestD2 = 8 * 8;
    for (const s of allSnakes()){
      if (!s.alive || !s.snake.length) continue;
      const h = s.snake[0];
      const d2 = (h.x - wx) * (h.x - wx) + (h.y - wy) * (h.y - wy);
      if (d2 < bestD2){ bestD2 = d2; target = s; continue; }
      // 头部不够近时抽样扫身体（每 4 节取 1），长蛇开销可控
      for (let i = 4; i < s.snake.length; i += 4){
        const b = s.snake[i];
        const b2 = (b.x - wx) * (b.x - wx) + (b.y - wy) * (b.y - wy);
        if (b2 < bestD2){ bestD2 = b2; target = s; break; }
      }
    }
  }
  if (!target){
    if (infoSid !== null){ infoSid = null; infoStatusEl = null; box.classList.remove('show'); }
    return;
  }
  if (infoSid !== target.sid){
    infoSid = target.sid;
    box.innerHTML = `
      <div class="si-head">
        <span class="si-dot" style="background:${target.color}"></span>
        <span class="si-name">${escapeHtml(snakeLabel(target))}</span>
      </div>
      <div class="si-grid">
        <span>得分</span><b>${target.score}</b>
        <span>长度</span><b>${target.alive ? target.snake.length : 0}</b>
        <span>状态</span><b class="si-status">存活</b>
        ${(target.crowns || 0) > 0 ? `<span>皇冠</span><b>👑${target.crowns}</b>` : ''}
      </div>`;
    infoStatusEl = box.querySelector('.si-status');
  }
  // 重生倒计时需要逐帧刷新
  if (!target.alive && infoStatusEl){
    infoStatusEl.textContent = '重生中 ' + Math.max(0, (target.respawnAt - performance.now()) / 1000).toFixed(1) + 's';
  } else if (target.alive && infoStatusEl){
    infoStatusEl.textContent = '存活';
  }
  box.classList.add('show');
}

/* =========================================================
   玩家面板 hover 详情：鼠标靠近（悬停）某个成员行，
   在该行左侧弹出完整信息卡（面板 overflow-y:auto 会裁行内卡片，
   故用 fixed 独立元素 + getBoundingClientRect 定位到行旁）
   ========================================================= */
let hoverSid = null;
let hoverDetailEl = null;
let hoverScoreEl = null, hoverLenEl = null, hoverStatusEl = null;
let hoverRowEl = null;
let hoverSig = '';

function getDetailBox(){
  if (!hoverDetailEl){
    hoverDetailEl = document.createElement('div');
    hoverDetailEl.className = 'pp-detail';
    document.body.appendChild(hoverDetailEl);
  }
  return hoverDetailEl;
}

function showRowDetail(sid){
  const id = Number(sid);
  if (!Number.isFinite(id)) return;
  const rec = panelRowMap.get(id);
  if (!rec || !rec.row) return;
  const s = allSnakes().find(x => x.sid === id);
  if (!s){ hideRowDetail(); return; }
  hoverSid = id;
  hoverRowEl = rec.row;
  const box = getDetailBox();
  /* 结构签名变化才重建内容（皇冠数/昵称/身份变色时） */
  const sig = [id, s.crowns || 0, snakeLabel(s), s.color].join('|');
  if (hoverSig !== sig){
    hoverSig = sig;
    const name = escapeHtml(snakeLabel(s));
    const crown = (s.crowns || 0) > 0
      ? `<span>皇冠</span><b>👑${s.crowns}</b>` : '';
    box.innerHTML = `
      <div class="pd-head">
        <span class="pd-dot" style="background:${s.color}"></span>
        <span class="pd-name">${name}</span>
      </div>
      <div class="pd-grid">
        <span>得分</span><b class="pd-score"></b>
        <span>长度</span><b class="pd-len"></b>
        <span>状态</span><b class="pd-status"></b>
        ${crown}
      </div>`;
    hoverScoreEl = box.querySelector('.pd-score');
    hoverLenEl = box.querySelector('.pd-len');
    hoverStatusEl = box.querySelector('.pd-status');
  }
  box.classList.add('show');
  refreshRowDetail();
}

function hideRowDetail(){
  hoverSid = null;
  hoverRowEl = null;
  hoverSig = '';
  if (hoverDetailEl){
    hoverDetailEl.classList.remove('show');
    hoverDetailEl.dataset.sid = '';
  }
}

function refreshRowDetail(){
  if (hoverSid === null || !hoverDetailEl) return;
  const s = allSnakes().find(x => x.sid === hoverSid);
  if (!s){ hideRowDetail(); return; }
  if (hoverScoreEl) hoverScoreEl.textContent = s.score;
  if (hoverLenEl) hoverLenEl.textContent = s.alive ? s.snake.length : 0;
  if (hoverStatusEl){
    hoverStatusEl.textContent = s.alive
      ? '存活'
      : '重生中 ' + Math.max(0, (s.respawnAt - performance.now()) / 1000).toFixed(1) + 's';
  }
  /* 位置跟随行（fixed 用视口坐标；排序变化/面板滚动每帧校正） */
  if (hoverRowEl && hoverRowEl.getBoundingClientRect){
    const r = hoverRowEl.getBoundingClientRect();
    if (!r.height && !r.width){ hideRowDetail(); return; } // 行已不可见（离场/画面切换）
    hoverDetailEl.style.right = (window.innerWidth - r.left + 10) + 'px';
    hoverDetailEl.style.top = (r.top + r.height / 2) + 'px';
  }
}

/* =========================================================
   房主管理菜单：fixed 浮动元素（挂在 body 下）
   行内 absolute 菜单会被 .players-panel 的 overflow-y:auto 裁剪——
   底部成员行点「管理」只露出半截甚至整体在可视区外，
   表现为「打不开 / 没有黑屏按键」。fixed + 每帧定位到行旁解决。
   ========================================================= */
let manageMenuEl = null;
let manageMenuRow = null; // 定位基准行（行被移除/离场时收起）

function getManageMenu(){
  if (!manageMenuEl){
    manageMenuEl = document.createElement('div');
    manageMenuEl.className = 'pp-menu-float';
    manageMenuEl.innerHTML = `
      <button class="pp-menu-item" data-act="reset">🔄 重置</button>
      <button class="pp-menu-item" data-act="black">🌑 黑屏</button>
      <button class="pp-menu-item danger" data-act="kick">⛔ 踢出</button>
      <button class="pp-menu-item gift" data-act="gift">🎁 赠送神器</button>`;
    document.body.appendChild(manageMenuEl);
    manageMenuEl.addEventListener('click', e => {
      const item = e.target && e.target.closest ? e.target.closest('.pp-menu-item') : null;
      if (!item) return;
      const mid = +item.dataset.mid;
      const act = item.dataset.act;
      hideManageMenu();
      if (Number.isFinite(mid) && act) manageMember(mid, act);
    });
  }
  return manageMenuEl;
}

function openManageMenu(mid, row){
  S.manageOpen = mid;
  manageMenuRow = row || null;
  const box = getManageMenu();
  const items = box.querySelectorAll('.pp-menu-item');
  for (let i = 0; i < items.length; i++) items[i].dataset.mid = mid;
  /* 赠送/收回文案随该成员当前状态切换 */
  const rs = S.netPeers.get(mid);
  const giftBtn = items[items.length - 1];
  if (giftBtn) giftBtn.textContent = (rs && rs.gifted) ? '💫 收回神器' : '🎁 赠送神器';
  box.classList.add('show');
  refreshManageMenu();
}

function hideManageMenu(){
  S.manageOpen = null;
  manageMenuRow = null;
  if (manageMenuEl) manageMenuEl.classList.remove('show');
}

function refreshManageMenu(){
  if (S.manageOpen === null || !manageMenuEl || !manageMenuRow) return;
  const r = manageMenuRow.getBoundingClientRect ? manageMenuRow.getBoundingClientRect() : null;
  if (!r || (!r.height && !r.width)){ hideManageMenu(); return; } // 行已离场不可见
  const h = manageMenuEl.offsetHeight || 104;
  manageMenuEl.style.right = (window.innerWidth - r.right + 6) + 'px';
  if (r.bottom + h + 12 <= window.innerHeight){
    manageMenuEl.style.top = (r.bottom + 4) + 'px';   // 默认下弹
    manageMenuEl.style.bottom = 'auto';
  } else {
    manageMenuEl.style.top = 'auto';                  // 贴近屏幕底部：改为上弹
    manageMenuEl.style.bottom = (window.innerHeight - r.top + 4) + 'px';
  }
}

/* =========================================================
   房主管理成员：重置 / 黑屏（开关式）/ 踢出
   ========================================================= */
function manageMember(peerId, act){
  if (S.role !== 'host' || !S.online) return;
  const rs = S.netPeers.get(peerId);
  if (act === 'reset'){
    if (rs && S.game){
      respawnSnake(rs);   // 权威端直接重生，下一 tick 快照同步到该成员
      toast(`已将 成员${peerId} 的蛇重置重生`);
    }
  } else if (act === 'black'){
    if (rs){
      rs.blackout = !rs.blackout;
      Net.sendToPeer(peerId, { t: 'blackout', on: !!rs.blackout });
      toast(rs.blackout ? `成员${peerId} 已被黑屏` : `成员${peerId} 黑屏已恢复`);
    }
  } else if (act === 'kick'){
    if (rs){
      Net.sendToPeer(peerId, { t: 'kicked' });
      Net.closePeer(peerId);   // P2P：关 DataChannel；服务器模式：服务器断开该成员
      toast(`成员${peerId} 已被踢出`);
    }
  } else if (act === 'gift'){
    /* 赠送神器：该成员获得不死之身 + 磁吸食物（不受房主神器开关影响） */
    if (rs){
      rs.gifted = !rs.gifted;
      Net.sendToPeer(peerId, { t: 'gift', on: !!rs.gifted });
      toast(rs.gifted
        ? `🎁 成员${peerId} 获得神器：不死之身 + 磁吸食物`
        : `已收回 成员${peerId} 的神器`);
    }
  }
  hideManageMenu();
}

/* 玩家面板事件委托（面板每帧重建，菜单开合状态存 S.manageOpen） */
const playersPanelEl = document.getElementById('playersPanel');
playersPanelEl.addEventListener('click', e => {
  const btn = e.target.closest('.pp-manage');
  if (btn){
    const mid = +btn.dataset.mid;
    if (S.manageOpen === mid){
      hideManageMenu();
    } else {
      openManageMenu(mid, btn.closest('.pp-row'));
    }
    return;
  }
  /* 点行空白处：触屏设备上切换该成员详情卡（桌面由 hover 触发） */
  const row = e.target.closest('.pp-row');
  if (row && playersPanelEl.contains(row)){
    const id = Number(row.dataset.sid);
    if (hoverSid === id) hideRowDetail(); else showRowDetail(id);
  }
  if (S.manageOpen !== null) hideManageMenu(); // 点了别处：收起管理菜单
});

/* 点面板/菜单之外的区域也收起管理菜单（fixed 菜单挂在 body 下） */
document.addEventListener('click', e => {
  if (S.manageOpen === null) return;
  const t = e.target;
  if (t && t.closest && (t.closest('.pp-manage') || t.closest('.pp-menu-float'))) return;
  hideManageMenu();
});

/* hover 详情（事件委托：行按 sid 复用，监听器不丢） */
playersPanelEl.addEventListener('mouseover', e => {
  const row = e.target && e.target.closest ? e.target.closest('.pp-row') : null;
  if (!row || !playersPanelEl.contains(row)) return;
  showRowDetail(row.dataset.sid);
});
playersPanelEl.addEventListener('mouseout', e => {
  const row = e.target && e.target.closest ? e.target.closest('.pp-row') : null;
  if (!row) return;
  const to = e.relatedTarget;
  if (to && row.contains(to)) return; // 行内子元素间移动不收起
  hideRowDetail();
});

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
  refreshWinLenUI();
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

/* ---------- 胜利长度设置 UI ---------- */
const winLenValueEl = document.getElementById('winLenValue');

/* 胜利长度随地图像素自动设定，此处只读刷新 */
function refreshWinLenUI(){
  winLenValueEl.textContent = S.winLen;
  const extra = document.getElementById('settingSummaryWin');
  if (extra) extra.innerHTML = `胜利长度 <b>${S.winLen}</b>（身长达到即胜利）`;
  const hint = document.getElementById('mapWinHint');
  if (hint) hint.textContent = '胜利长度 ' + S.winLen;
}

/* =========================================================
   游戏控制
   ========================================================= */
function startGame(){
  S.winner = null;
  S.pendingWelcome = false;
  document.getElementById('winOverlay').classList.remove('show');
  if (!S.game) createGame();
  // 新对局：快照世界尺寸基线复位（加长扩界才会重发）
  S.snapWorldCols = S.world.cols;
  S.snapWorldRows = S.world.rows;
  resizeCanvas();
  showScreen('game');
  S.paused = false;
  document.getElementById('pauseOverlay').classList.remove('show');
  // HUD 显示当前食物设置与胜利长度
  document.getElementById('hudFoodRange').textContent = `${S.foodMin}~${S.foodMax}`;
  document.getElementById('hudWinTarget').textContent = '/' + S.winLen;
  if (S.online) S.enteredGame = true;
  refreshPauseBtn();
  refreshMapUI();
  // 竞赛模式：房主端开始计时并广播（成员端由 applyComp 同步）
  if (S.online && S.role === 'host') startCompetition();

  if (S.tickTimer) clearInterval(S.tickTimer);
  // 成员端不跑本地模拟（权威在房主），只接收快照渲染
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
  document.getElementById('awayOverlay').classList.remove('show');
  if (S.online && S.role === 'host'){
    // 房主暂离：P2P 连接保持，通知成员等待（房主随时可返回）
    Net.broadcast({ t: 'hostAway', on: true });
  }
  showScreen('menu');
  refreshRoomBar();
}

function togglePause(){
  if (!S.game || S.winner) return;
  // 成员端无暂停权限（按钮已隐藏，P/空格同样不响应）
  if (S.online && S.role === 'guest') return;
  if (S.online){
    setPaused(!S.paused);
    Net.broadcast({ t: 'pause', on: S.paused });
    return;
  }
  setPaused(!S.paused);
}

function setPaused(on){
  S.paused = !!on;
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
  if (!S.game || S.paused || S.winner) return;
  const dir = DIRS[d];
  if (!dir) return;
  const p = S.game.player;
  if (dir.x === -p.dir.x && dir.y === -p.dir.y) return;
  if (S.online){
    if (S.role === 'guest'){
      // 成员端：只把方向发给房主，由房主权威模拟
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

/* 鼠标位置：靠近蛇身时左侧弹信息卡（canvas 样式尺寸与像素 1:1，无需缩放） */
canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  S.mouse.x = e.clientX - r.left;
  S.mouse.y = e.clientY - r.top;
  S.mouse.over = true;
});
canvas.addEventListener('mouseleave', () => { S.mouse.over = false; });

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
  // 从房主发的成员链接打开：名字取好后自动加入服务器房间
  if (pendingAutoJoin && !S.online){
    const room = pendingAutoJoin;
    pendingAutoJoin = null;
    document.getElementById('roomIn').value = room;
    document.getElementById('btnServerJoin').click();
  }
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
  // 联机中"退出"= 回到主菜单但保持 P2P 连接（房间条可一键返回）；
  // 真正断开请用主菜单房间条的「离开房间」
  backToMenu();
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

/* ---------- 胜利结算层 ---------- */
document.getElementById('btnWinRestart').addEventListener('click', () => {
  if (S.online){
    if (S.role === 'host'){ hostRestart(); startGame(); }
    else toast('只有房主可以重新开始');
    return;
  }
  startGame();
});
/* 胜利后「继续」：不清场，夺冠蛇重置长度，累计皇冠（房主/单机权威） */
document.getElementById('btnWinContinue').addEventListener('click', () => {
  if (S.online && S.role === 'guest'){
    Net.sendToHost({ t: 'continue' });
    toast('已请求房主继续…');
    return;
  }
  continueGame();
});
document.getElementById('btnWinMenu').addEventListener('click', backToMenu);

/* 竞赛结算按钮 */
document.getElementById('btnCompRestart').addEventListener('click', () => {
  if (S.online){
    if (S.role === 'host'){ hostRestart(); startGame(); }
    else toast('只有房主可以重新开始');
    return;
  }
  startGame();
});
document.getElementById('btnCompMenu').addEventListener('click', backToMenu);

/* ---------- 手机端：虚拟方向键 ---------- */
const dpad = document.getElementById('dpad');
if (dpad){
  dpad.addEventListener('pointerdown', e => {
    const btn = e.target.closest('.dpad-btn');
    if (!btn) return;
    e.preventDefault();
    sendDir(btn.dataset.dir);
  });
  dpad.addEventListener('contextmenu', e => e.preventDefault());
}

/* =========================================================
   联机核心（WebRTC P2P · 房主权威 · 星型中继）
   ---------------------------------------------------------
   房主：跑完整模拟，每 tick 向每个成员广播快照（AOI 过滤）
         + 食物增减增量；成员只发方向指令。
   成员：用同一 seed 本地重建食物图，按快照渲染。
   ========================================================= */
function pickGuestColor(id){
  return COLORS[(id + 5) % COLORS.length];
}

function spawnRemoteSnake(peerId, name, color){
  const rs = makeSnake(false, color);
  rs.isRemote = true;
  rs.name = name;
  rs.sid = 5000 + peerId;
  rs.memberNo = peerId;   // 玩家列表显示「昵称 · 成员N」
  respawnSnake(rs);
  return rs;
}

/* ---------- 房主：广播快照 ---------- */
function hostBroadcast(){
  const g = S.game;
  if (!g) return;
  const ev = { add: g.foodEv.add, del: g.foodEv.del };
  // 世界尺寸（加长扩界时同步；尺寸未变时发 null 省流量）
  const world = (S.world.cols !== S.snapWorldCols || S.world.rows !== S.snapWorldRows)
    ? { cols: S.world.cols, rows: S.world.rows }
    : null;
  if (world){ S.snapWorldCols = S.world.cols; S.snapWorldRows = S.world.rows; }
  S.netPeers.forEach((rs, id) => {
    // 成员自己的蛇：完整身体 + 朝向 + 状态 + 皇冠数 + 是否被赠送神器
    const me = {
      body: packBody(rs),
      dir: rs.dir,
      alive: rs.alive,
      score: rs.score,
      crowns: rs.crowns || 0,
      gift: !!rs.gifted,
      respawnIn: rs.alive ? 0 : Math.max(0, Math.round(rs.respawnAt - performance.now())),
    };
    // 其他蛇：全部发送完整身体（不再按距离过滤）。
    // 蛇身数据量很小（最长几十段 ×2 字节），DataChannel 完全扛得住；
    // 早期版本只在 55 格内发身体，成员看不到远处的蛇，小地图也点不亮。
    const others = [];
    for (const s of allSnakes()){
      if (s === rs) continue;
      const o = {
        // 房主蛇发 HOST_SNAP_SID：成员端自己的 player 也是 PLAYER_SID，
        // 若把房主 sid 原样发过去，成员端面板两行撞 key，房主行被覆盖
        id: s.isPlayer ? HOST_SNAP_SID : s.sid,
        name: s.name || '', color: s.color,
        alive: s.alive, score: s.score, crowns: s.crowns || 0,
        host: !!s.isPlayer,
        gift: !!s.gifted, // 被房主赠送神器（其他成员可见标识）
        memberNo: (typeof s.memberNo === 'number') ? s.memberNo : null,
      };
      if (s.alive && s.snake.length){
        const h = s.snake[0];
        o.hx = h.x; o.hy = h.y; o.dir = s.dir;
        o.body = packBody(s);
      }
      others.push(o);
    }
    Net.sendToPeer(id, { t: 'snap', me, others, ev, world });
  });
  g.foodEv.add.length = 0;
  g.foodEv.del.length = 0;
}

/* ---------- 成员：应用食物增量 ---------- */
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

/* ---------- 成员：应用快照 ---------- */
function applySnap(msg){
  const g = S.game;
  if (!g) return;
  const p = g.player;

  /* 房主加长扩界：同步世界尺寸（成员端只渲染，边界裁剪/相机要用） */
  if (msg.world && typeof msg.world.cols === 'number'
      && (msg.world.cols !== S.world.cols || msg.world.rows !== S.world.rows)){
    S.world.cols = msg.world.cols;
    S.world.rows = msg.world.rows;
    S.camInit = false;
  }

  p.prevSnake = p.snake;
  p.snake = unpackBody(msg.me.body || []);
  if (msg.me.dir) p.dir = msg.me.dir;
  p.alive = msg.me.alive;
  p.score = msg.me.score || 0;
  p.crowns = msg.me.crowns || 0;
  p.gifted = !!msg.me.gift; // 房主赠送的神器（不死+磁吸）
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
    s.crowns = o.crowns || 0;
    s.isHost = !!o.host;
    s.gifted = !!o.gift;
    if (typeof o.memberNo === 'number') s.memberNo = o.memberNo;
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

/* ---------- 成员：收到房主欢迎（种子同步） ---------- */
function onWelcome(msg){
  foodId = 0;
  if (typeof msg.ai === 'number') S.aiCount = msg.ai;
  if (typeof msg.winLen === 'number' && msg.winLen >= WIN_LEN_MIN) S.winLen = clamp(Math.round(msg.winLen), WIN_LEN_MIN, WIN_LEN_MAX);
  if (typeof msg.room === 'string') S.roomNo = msg.room;
  // 竞赛模式：房主进行中的剩余秒数（成员以收到时刻为基准本地倒计时）
  if (msg.comp && typeof msg.comp.secs === 'number' && msg.comp.secs > 0){
    S.comp.on = true;
    S.comp.over = false;
    S.comp.minutes = Math.max(1, Math.round(msg.comp.secs / 60));
    S.comp.endAt = performance.now() + msg.comp.secs * 1000;
  } else {
    S.comp.on = false;
  }
  // 房主的地图尺寸必须先应用：createGame 的出生避让/食物生成都依赖世界大小
  if (msg.world && typeof msg.world.cols === 'number'){
    S.world = { cols: msg.world.cols, rows: msg.world.rows, artifact: !!msg.world.artifact };
    S.mapSizeIdx = MAP_SIZES.findIndex(m => m.cols === msg.world.cols && m.rows === msg.world.rows && !!m.artifact === !!msg.world.artifact);
    if (S.mapSizeIdx < 0) S.mapSizeIdx = DEFAULT_MAP_IDX;
  }
  createGame(msg.seed);            // 同一 seed → 与房主完全相同的食物图
  foodId = msg.foodId || 0;        // 对齐房主计数器，之后新食物 id 由快照驱动
  applyFoodDelta(null, msg.eaten); // 剔除房主已吃掉的初始食物
  setPaused(false);                // 新对局以房主当前状态为准
  applyHostAway(false);
  S.continued = false;             // 新对局皇冠重新累计

  /* 是否立即进房：
     - 从未进过游戏（首次加入）→ 进
     - 成员主动点了「返回游戏」（rejoining）→ 进
     - 本来就在游戏画面中（房主重开）→ 进
     - 已进过游戏但当前在主菜单（房主擅自重开）→ 不抢画面，提示后等成员点「返回游戏」 */
  const wantStart = !S.enteredGame || S.rejoining || S.screen === 'game';
  S.rejoining = false;
  if (wantStart){
    startGame();
  } else {
    S.pendingWelcome = true;
    toast('房主已更新对局，点主菜单「返回游戏」加入');
  }
  // 房主已胜利时才加入的成员：直接展示结算
  if (msg.win) applyWin(msg.win);
  toast('已连接到房主');
}

/* ---------- 房主：重新开始（同步新种子） ---------- */
function hostRestart(){
  if (S.role !== 'host'){ toast('只有房主可以重新开始'); return; }
  S.winner = null;
  S.continued = false;
  document.getElementById('winOverlay').classList.remove('show');
  hideCompOverlay();
  rebuildWorld();
  // 竞赛模式：重新开始 = 新一轮计时
  if (S.comp.on && S.online){
    S.comp.over = false;
    S.comp.endAt = performance.now() + S.comp.minutes * 60000;
    Net.broadcast({ t: 'comp', on: true, secs: Math.round(S.comp.minutes * 60) });
  }
  // 复位暂停与暂离状态
  setPaused(false);
  Net.broadcast({ t: 'pause', on: false });
  Net.broadcast({ t: 'hostAway', on: false });
  toast('已重新开始，新种子已同步');
}

/* 竞赛剩余秒数（welcome 用；未开启返回 null） */
function compSecsLeft(){
  if (!S.comp.on) return null;
  return Math.max(0, Math.round((S.comp.endAt - performance.now()) / 1000));
}

/* ---------- 房主：重建世界（新种子），保留已连接成员 ---------- */
function rebuildWorld(){
  const metas = Array.from(S.peerMeta.entries());
  createGame();          // 新 seed + 按 S.aiCount 生成 AI
  S.netPeers.clear();
  for (const [id, meta] of metas){
    const rs = spawnRemoteSnake(id, meta.name, meta.color);
    S.netPeers.set(id, rs);
    S.game.remotes.push(rs);
    Net.sendToPeer(id, {
      t: 'welcome', seed: S.seed, foodId: foodId, ai: S.aiCount,
      winLen: S.winLen, room: S.roomNo,
      comp: (() => { const s = compSecsLeft(); return s !== null ? { secs: s } : null; })(),
      world: { cols: S.world.cols, rows: S.world.rows, artifact: S.world.artifact },
      artifact: { immortal: S.artifact.immortal, magnet: S.artifact.magnet },
      win: S.winner ? { name: S.winner.name, len: S.winner.len, color: S.winner.color, crowns: S.winner.crowns } : null,
    });
  }
}

/* ---------- 房主：当前已被吃掉的初始食物 id 列表 ---------- */
function currentEatenIds(){
  const g = S.game;
  if (!g || !g.initFoodCount || g.initFoodCount > 4000) return null;
  const eaten = [];
  for (let id = 1; id <= g.initFoodCount; id++){
    if (!g.foodById.has(id)) eaten.push(id);
  }
  return eaten;
}

/* ---------- 房主：向指定成员重发欢迎包（用于掉线重进） ---------- */
function resendWelcomeTo(peerId){
  if (!S.game) return;
  Net.sendToPeer(peerId, {
    t: 'welcome', seed: S.seed, foodId: foodId, ai: S.aiCount,
    winLen: S.winLen, room: S.roomNo,
    comp: (() => { const s = compSecsLeft(); return s !== null ? { secs: s } : null; })(),
    world: { cols: S.world.cols, rows: S.world.rows, artifact: S.world.artifact },
    artifact: { immortal: S.artifact.immortal, magnet: S.artifact.magnet },
    eaten: currentEatenIds(),
    win: S.winner ? { name: S.winner.name, len: S.winner.len, color: S.winner.color, crowns: S.winner.crowns } : null,
  });
}

/* ---------- 离开联机 ---------- */
function leaveOnline(){
  Net.closeAll();
  S.online = false;
  S.role = null;
  S.serverMode = false;
  S.netPeers.clear();
  S.peerMeta.clear();
  S.hostAway = false;
  S.enteredGame = false;
  S.rejoining = false;
  S.pendingWelcome = false;
  S.winner = null;
  S.continued = false;
  S.roomNo = '';
  S.blackout = false;
  const bo = document.getElementById('blackOverlay');
  if (bo) bo.classList.remove('show');
  document.getElementById('awayOverlay').classList.remove('show');
  document.getElementById('winOverlay').classList.remove('show');
  stopGame();
  refreshPauseBtn();
  showScreen('menu');
}

/* ---------- Net 事件绑定 ---------- */
Net.on.peerOpen = (peerId) => {
  if (!S.game) createGame();
  const name = '成员' + peerId;
  const color = pickGuestColor(peerId);
  S.peerMeta.set(peerId, { name, color });
  const rs = spawnRemoteSnake(peerId, name, color);
  rs.memberNo = peerId;   // 玩家列表显示「昵称 · 成员N」
  S.netPeers.set(peerId, rs);
  S.game.remotes.push(rs);   // 必须登记：allSnakes() 靠它遍历，否则房主不推进成员蛇
  // 欢迎包：种子 + 食物计数器 + 已被吃掉的初始食物 id + 胜利长度 + 房间号 + 世界尺寸/神器
  Net.sendToPeer(peerId, {
    t: 'welcome', seed: S.seed, foodId: foodId, ai: S.aiCount,
    winLen: S.winLen, room: S.roomNo,
    comp: (() => { const s = compSecsLeft(); return s !== null ? { secs: s } : null; })(),
    world: { cols: S.world.cols, rows: S.world.rows, artifact: S.world.artifact },
    artifact: { immortal: S.artifact.immortal, magnet: S.artifact.magnet },
    eaten: currentEatenIds(),
    win: S.winner ? { name: S.winner.name, len: S.winner.len, color: S.winner.color, crowns: S.winner.crowns } : null,
  });
  toast(`成员${peerId} 已接入房间`);
};

Net.on.peerClose = (peerId) => {
  const rs = S.netPeers.get(peerId);
  if (rs && S.game){
    if (rs.alive && rs.snake.length) dropEatenFood(rs); // 掉食物，其他成员可见
    const i = S.game.remotes.indexOf(rs);
    if (i >= 0) S.game.remotes.splice(i, 1);
  }
  S.netPeers.delete(peerId);
  S.peerMeta.delete(peerId);
  if (S.online && S.role === 'host') toast(`成员${peerId} 已离开`);
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

/* 服务器模式：房主页面关闭（宽限）或返回 */
Net.on.hostAway = (on) => {
  if (S.role !== 'guest') return;
  applyHostAway(on);
  if (on) toast('房主页面已关闭，连接保持中，等待房主返回…');
};

/* 服务器模式：ws 断开（房主超时未返回 / 网络中断） */
Net.on.serverClose = () => {
  if (!S.online || !S.serverMode) return;
  if (S.role === 'guest'){
    toast('与服务器的连接已断开');
    leaveOnline();
  } else if (S.role === 'host'){
    toast('与服务器的连接已断开，房间已关闭');
    leaveOnline();
  }
};

/* 服务器模式：服务器返回的错误（房间不存在/已有房主等） */
Net.on.serverError = (err) => {
  toast(err);
};

Net.on.message = (peerId, msg) => {
  if (!msg) return;
  if (S.role === 'host'){
    if (msg.t === 'hello'){
      const name = (String(msg.name || '').slice(0, 8)) || ('成员' + peerId);
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
    } else if (msg.t === 'pause'){
      // 成员请求暂停/恢复：房主权威切换并广播全员
      if (S.game && !S.winner){
        setPaused(!S.paused);
        Net.broadcast({ t: 'pause', on: S.paused });
        toast(S.paused ? `成员${peerId} 暂停了游戏` : `成员${peerId} 恢复了游戏`);
      }
    } else if (msg.t === 'rejoin'){
      // 成员退出后重新请求进入：用当前世界状态重发欢迎包
      if (S.game){
        resendWelcomeTo(peerId);
        toast(`成员${peerId} 返回了游戏`);
      } else {
        // 房主也暂离中：等房主自己返回，hostRestart 时会广播
        Net.sendToPeer(peerId, { t: 'wait' });
      }
    } else if (msg.t === 'continue'){
      // 成员请求「继续」：房主权威执行并广播全员
      if (S.winner) continueGame();
    }
  } else if (S.role === 'guest'){
    if (msg.t === 'welcome') onWelcome(msg);
    else if (msg.t === 'snap') applySnap(msg);
    else if (msg.t === 'pause') applyPause(msg.on);
    else if (msg.t === 'hostAway') applyHostAway(msg.on);
    else if (msg.t === 'win') applyWin(msg);
    else if (msg.t === 'continue') applyContinue();
    else if (msg.t === 'blackout') applyBlackout(msg.on);
    else if (msg.t === 'kicked') applyKicked();
    else if (msg.t === 'gift') applyGift(msg.on);
    else if (msg.t === 'comp') applyComp(msg);
    else if (msg.t === 'compEnd') applyCompEnd(msg);
    else if (msg.t === 'wait') toast('房主也暂时离开了，等他返回游戏你会自动进房');
  }
};

/* 成员：收到房主的神器赠送/收回 */
function applyGift(on){
  if (S.game) S.game.player.gifted = !!on;
  if (on) toast('🎁 你获得了房主赠送的神器：不死之身 + 磁吸食物！');
  else toast('房主收回了你的神器');
}

/* ---------- 成员：被房主黑屏（开关式，房主可随时恢复） ---------- */
function applyBlackout(on){
  S.blackout = !!on;
  const ov = document.getElementById('blackOverlay');
  if (ov) ov.classList.toggle('show', S.blackout);
  if (S.blackout) toast('你已被房主黑屏');
}

/* ---------- 成员：被房主踢出房间 ---------- */
function applyKicked(){
  toast('你已被房主踢出房间');
  leaveOnline();
}

/* ---------- 成员：应用暂停状态 ---------- */
function applyPause(on){
  setPaused(on);
}

/* ---------- 成员：房主暂离/返回 ---------- */
function applyHostAway(on){
  S.hostAway = !!on;
  const ov = document.getElementById('awayOverlay');
  if (S.hostAway) ov.classList.add('show');
  else ov.classList.remove('show');
}

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
  // 切换后把大厅卡片滚入可视区，避免"选了标签还要手动下滑"
  const card = document.querySelector('.online-card');
  if (card) card.scrollIntoView({ block: 'start', behavior: 'auto' });
}
document.getElementById('tabHost').addEventListener('click', () => switchOnlineTab('host'));
document.getElementById('tabGuest').addEventListener('click', () => switchOnlineTab('guest'));
document.getElementById('btnOnlineBack').addEventListener('click', () => {
  // 返回菜单但保持连接（真正断开请用主菜单房间条的「离开房间」）
  showScreen('menu');
});

document.getElementById('btnCreateRoom').addEventListener('click', async () => {
  // 房间号：6 位数字，仅作标识展示，与加入流程无关；留空则自动生成
  const noInput = document.getElementById('roomNo');
  let no = String(noInput.value || '').replace(/\D/g, '').slice(0, 6);
  if (no && no.length !== 6){
    toast('房间号需为 6 位数字（或留空自动生成）');
    return;
  }
  if (!no) no = String(Math.floor(Math.random() * 900000) + 100000);
  noInput.value = no;
  S.roomNo = no;

  const firstTime = !S.online || S.role !== 'host';
  S.online = true;
  S.role = 'host';
  readCompSetting(); // 竞赛模式配置（仅房主大厅可设）
  const want = Math.max(0, Math.min(AI_COUNT, parseInt(document.getElementById('aiCount').value, 10) || 0));
  // 首次建房、或修改了 AI 数量：重建世界（保留已连接成员并通知同步）
  if (firstTime || !S.game || S.game.ai.length !== want){
    S.aiCount = want;
    rebuildWorld();
  }
  const r = await Net.createInvite(document.getElementById('hostIp').value);
  document.getElementById('inviteCode').value = r.code;
  showCodeLen(document.getElementById('inviteLen'), r.code);
  if (r.mdns) toast(`房间 ${no} 已创建。注意：浏览器隐藏了本机 IP，若成员连不上请填写本机 IP 后重新创建`);
  else toast(`房间 ${no} 已创建，把邀请码发给成员`);
});
document.getElementById('btnCopyInvite').addEventListener('click', () => copyText(document.getElementById('inviteCode')));
document.getElementById('btnAcceptAnswer').addEventListener('click', async () => {
  const r = await Net.acceptAnswer(document.getElementById('answerIn').value);
  if (r.ok){
    document.getElementById('answerIn').value = '';
    toast('已确认，等待成员接入…');
    clearTimeout(hostWatchdog);
    hostWatchdog = setTimeout(() => {
      if (!Net.isPeerOpen(r.id)){
        toast('连接超时：让成员检查邀请码是否复制完整；仍不行就双方填写本机 IP 后重试');
      }
    }, 15000);
  } else {
    toast(r.err);
  }
});
document.getElementById('btnHostStart').addEventListener('click', () => {
  if (!S.game) createGame();
  readCompSetting(); // 房主可能建房后调整过竞赛配置，进游戏时以最新为准
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

/* =========================================================
   本地服务器模式（房主电脑运行 1.exe）
   ---------------------------------------------------------
   房主：运行 1.exe → 打开控制台打印的网址 → 点「创建服务器房间」
         → 把成员链接（http://IP:端口/?room=NNNNNN）发到群里
   成员：点开链接即入房（自动带房间号），无需复制任何码
   ========================================================= */
/* 房主：创建服务器房间 */
document.getElementById('btnServerCreate').addEventListener('click', async () => {
  if (!Net.serverSupported()){
    toast('当前是 HTTPS 页面，浏览器禁止连接局域网服务器。请从房主电脑运行 1.exe 后，用控制台打印的 http://IP:端口 网址打开');
    return;
  }
  // 房间号：输入框 > 服务器注入 > 随机
  const noInput = document.getElementById('roomNo');
  let no = String(noInput.value || '').replace(/\D/g, '').slice(0, 6);
  if (no && no.length !== 6){ toast('房间号需为 6 位数字（或留空自动生成）'); return; }
  if (!no) no = (window.LAN_SERVER && window.LAN_SERVER.room) || String(Math.floor(Math.random() * 900000) + 100000);
  noInput.value = no;
  S.roomNo = no;

  const addr = document.getElementById('serverHost').value;
  S.online = true; S.role = 'host'; S.serverMode = true;
  readCompSetting(); // 竞赛模式配置（仅房主大厅可设）
  try {
    await Net.connectServer(addr);
  } catch (e) {
    S.online = false; S.role = null; S.serverMode = false;
    toast(e.message);
    return;
  }
  // 按当前选择初始化世界（房主权威，房主的地图/胜利长度/食物密度）
  const want = Math.max(0, Math.min(AI_COUNT, parseInt(document.getElementById('aiCount').value, 10) || 0));
  S.aiCount = want;
  if (!S.game) createGame();
  Net.createServerRoom(no);
});

/* 服务器模式：房主房间就绪 → 生成成员链接 */
Net.on.serverHostOpen = (room) => {
  if (room) S.roomNo = room;
  let hostPart = location.host;
  const lan = window.LAN_SERVER;
  if (lan && Array.isArray(lan.ips) && lan.ips.length){
    hostPart = lan.ips[0] + ':' + (lan.port || 9600);
  }
  const url = 'http://' + hostPart + '/?room=' + S.roomNo;
  document.getElementById('serverShareUrl').value = url;
  document.getElementById('serverShare').hidden = false;
  toast('服务器房间 ' + S.roomNo + ' 已就绪，把成员链接发到群里');
  refreshRoomBar();
};
document.getElementById('btnCopyShareUrl').addEventListener('click', () => copyText(document.getElementById('serverShareUrl')));

/* 成员：加入服务器房间 */
document.getElementById('btnServerJoin').addEventListener('click', async () => {
  if (!Net.serverSupported()){
    toast('当前是 HTTPS 页面，浏览器禁止连接局域网服务器。请点开房主发的成员链接（http://IP:端口/?room=NNNNNN）');
    return;
  }
  const room = String(document.getElementById('roomIn').value || '').replace(/\D/g, '');
  if (room.length !== 6){ toast('请输入 6 位房间号'); return; }
  const addr = document.getElementById('serverHostG').value;
  S.online = true; S.role = 'guest'; S.serverMode = true; S.roomNo = room;
  try {
    await Net.connectServer(addr);
  } catch (e) {
    S.online = false; S.role = null; S.serverMode = false;
    toast(e.message);
    return;
  }
  Net.joinServerRoom(room);
  clearTimeout(guestWatchdog);
  guestWatchdog = setTimeout(() => {
    if (S.online && S.role === 'guest' && !S.enteredGame){
      toast('等待超时：请确认房主已打开游戏页面、房间号是否正确');
    }
  }, 15000);
});

/* ---------- 主菜单房间条：返回游戏 / 离开房间 ---------- */
document.getElementById('btnBackToGame').addEventListener('click', () => {
  if (!S.online) return;
  if (S.role === 'host'){
    if (S.enteredGame){
      // 房主返回：重建世界并同步新种子，全场重新开始
      hostRestart();
      startGame();
      toast('已返回游戏，新对局开始');
    } else {
      // 建房后从未进过游戏：直接进入
      startGame();
      toast('已进入游戏');
    }
  } else {
    if (S.enteredGame){
      // 成员返回：请求房主重发当前状态（房主暂离则等他返回后自动进房）
      S.rejoining = true;
      Net.sendToHost({ t: 'rejoin' });
      toast('已请求返回，等待房主同步…');
    } else {
      // 尚未进入过游戏：回大厅继续走加入流程
      switchOnlineTab('guest');
      showScreen('online');
    }
  }
});
document.getElementById('btnLeaveRoom').addEventListener('click', leaveOnline);

addEventListener('beforeunload', () => { Net.closeAll(); });

/* =========================================================
   地图选择 + 神器面板 UI
   ========================================================= */
function refreshMapUI(){
  const sel = document.getElementById('mapSize');
  if (sel) sel.value = String(S.mapSizeIdx);
  const size = MAP_SIZES[S.mapSizeIdx];
  const nameEl = document.getElementById('mapName');
  if (nameEl) nameEl.textContent = size.cols + '×' + size.rows + (size.artifact ? '（房主有神器）' : '');
  // 神器按钮仅神器版地图 + 房主身份显示
  const artBtn = document.getElementById('btnArtifact');
  if (artBtn) artBtn.hidden = !(S.world.artifact && S.role === 'host');
  const artPanel = document.getElementById('artifactPanel');
  if (artPanel && (!S.world.artifact || S.role !== 'host')) artPanel.classList.remove('show');
  refreshArtifactUI();
}

function refreshArtifactUI(){
  document.querySelectorAll('.art-switch').forEach(el => {
    const on = !!S.artifact[el.dataset.art];
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

/* 地图尺寸选择（联机中仅房主可改；改尺寸=重开对局） */
document.getElementById('mapSize').addEventListener('change', e => {
  if (S.online && S.role !== 'host'){ toast('联机中只有房主可以改地图'); refreshMapUI(); return; }
  setMapSize(+e.target.value);
  const size = MAP_SIZES[S.mapSizeIdx];
  toast('地图已选 ' + size.cols + '×' + size.rows + '，胜利长度 ' + size.win);
  if (S.online && S.role === 'host' && S.game){
    // 房主改地图：重开对局并同步（世界尺寸/胜利长度随欢迎包下发）
    hostRestart();
  }
});

/* 神器面板开关 */
document.getElementById('btnArtifact').addEventListener('click', () => {
  if (!S.world.artifact || S.role !== 'host') return;
  document.getElementById('artifactPanel').classList.toggle('show');
});
document.querySelectorAll('.art-switch').forEach(el => {
  el.addEventListener('click', () => {
    if (!S.world.artifact || S.role !== 'host') return;
    const k = el.dataset.art;
    S.artifact[k] = !S.artifact[k];
    refreshArtifactUI();
    // 神器状态变化同步给成员（成员端仅展示用，权威在房主）
    Net.broadcast({ t: 'artifact', immortal: S.artifact.immortal, magnet: S.artifact.magnet });
    toast((k === 'immortal' ? '房主不死' : '吸附食物') + (S.artifact[k] ? '已开启' : '已关闭'));
  });
});
document.getElementById('btnArtExtend').addEventListener('click', () => {
  if (!S.world.artifact || S.role !== 'host') return;
  artifactExtend(100);
  toast('🐍 房主已加长 100 格（当前 ' + S.game.player.snake.length + '）');
});

/* 成员端隐藏暂停按钮（房主端保留；P/空格同样不响应） */
function refreshPauseBtn(){
  const btn = document.getElementById('btnPause');
  if (btn) btn.hidden = !!(S.online && S.role === 'guest');
}
refreshPauseBtn();


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
  // 加载地图尺寸选择（胜利长度由地图自动决定，不再读旧存档）
  loadMapSize();
  refreshSettingUI();
  refreshMapUI();

  /* ---- 本地服务器模式预热 ---- */
  // 页面由 1.exe 提供时：预填服务器地址（ws 同源直连）
  if (window.LAN_SERVER){
    const hp = location.host;
    const hi = document.getElementById('serverHost');
    const gi = document.getElementById('serverHostG');
    if (hi) hi.value = hp;
    if (gi) gi.value = hp;
  }
  // HTTPS 页面禁止连接局域网 ws：显示说明，引导从房主网址打开
  if (!Net.serverSupported()){
    document.querySelectorAll('.server-mode-note').forEach(el => { el.hidden = false; });
  }
  // 链接带 ?room=NNNNNN（房主发的成员链接）：记住，进菜单后自动加入
  const m = location.search.match(/[?&]room=(\d{6})/);
  if (m && Net.serverSupported()){
    const room = m[1];
    if (window.LAN_SERVER && window.LAN_SERVER.room && window.LAN_SERVER.room !== room){
      toast('链接房间号与本服务器不一致，请联系房主');
    } else {
      pendingAutoJoin = room;
      const ri = document.getElementById('roomIn');
      if (ri) ri.value = room;
      if (!S.nick) toast('检测到房间号 ' + room + '，取个名字进入后将自动加入');
    }
  }

  document.getElementById('nickInput').focus();
})();