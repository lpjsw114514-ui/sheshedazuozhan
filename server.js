'use strict';
/* =========================================================
   蛇蛇大作战 · 本地联机服务器（1.exe 本体）
   ---------------------------------------------------------
   零依赖：仅使用 Node 内置模块。一个程序干两件事：

   ① 静态文件服务：把游戏页面发给局域网内的成员
      （打开 http://房主IP:端口 即玩，无需任何安装）
   ② WebSocket 中转：按 6 位房间号匹配房主与成员，
      之后所有游戏消息都经此转发——房主电脑即服务器。

   用法：
     双击运行 → 控制台会打印「房主打开 / 成员打开」两个网址
     1.exe --port 9600            自定义端口（默认 9600）
     1.exe --room 123456          自定义房间号（默认随机 6 位）
     1.exe --node 192.168.1.5:9600
                                 辅助节点模式：接入另一台跑着 1.exe 的主服务器，
                                 本机只接待成员并把消息中转给主服务器（接力带宽/
                                 分流主电脑连接负担）；可多台级联

   说明：
     - 每个 exe 实例 = 一个房间；关闭窗口 = 房间解散
     - 房主刷新页面有 60 秒宽限，期间成员保持连接等待
     - 辅助节点不接待房主（房主权威仍在主服务器那台电脑的浏览器）
   ========================================================= */
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ---------------- 参数 ---------------- */
function argOf(name, def){
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}
const PORT = Math.max(1, Math.min(65535, parseInt(argOf('port', process.env.PORT || '9600'), 10) || 9600));
let ROOM = String(argOf('room', '')).replace(/\D/g, '').slice(0, 6);
if (ROOM.length !== 6) ROOM = String(Math.floor(Math.random() * 900000) + 100000);
/* 辅助节点模式：--node 主服务器地址（host:port）。本机转为「成员中转站」 */
const NODE_MODE = String(argOf('node', '')).trim();
let MASTER_ROOM = ''; // 辅助节点：从主服务器同步到的房间号（注入页面用）

/* ---------------- 内嵌静态资源 ----------------
   构建 1.exe 时由构建脚本注入（gzip+base64）；
   ASSETS 为 null 时（开发模式）改为读取 exe 所在目录的文件。 */
const ASSETS = null; /*__ASSETS__*/

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico':  'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const ROOT = __dirname;

function lanAddresses(){
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)){
    for (const ni of ifs[name] || []){
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/* 向 HTML 注入房间信息，页面据此自动预填房间号/生成成员链接。
   辅助节点模式注入主服务器的房间号（本机不自行建房）。 */
function injectRoom(html){
  const ips = JSON.stringify(lanAddresses());
  const room = NODE_MODE ? (MASTER_ROOM || ROOM) : ROOM;
  const tag = '<script>window.LAN_SERVER={room:"' + room + '",port:' + PORT + ',ips:' + ips + (NODE_MODE ? ',node:true' : '') + '};</script>';
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, tag + '</head>');
  return tag + html;
}

/* 读取静态资源：先查内嵌，再查磁盘（含 1.exe 自身，供页面下载） */
function readAsset(reqPath){
  let p;
  try { p = decodeURIComponent(String(reqPath).split('?')[0]); }
  catch (e) { return null; }
  if (p === '/' || p === '') p = '/index.html';
  if (p.indexOf('..') >= 0) return null; // 目录穿越直接拒绝
  const name = path.basename(p);
  const ext = path.extname(p).toLowerCase();

  if (ASSETS && Object.prototype.hasOwnProperty.call(ASSETS, name)){
    return { buf: zlib.gunzipSync(Buffer.from(ASSETS[name], 'base64')), type: MIME[ext] || 'application/octet-stream' };
  }
  // 磁盘读取（带目录穿越防护）
  const norm = path.normalize(p).replace(/^([\\/]\.\.[\\/])+/, '');
  const file = path.join(ROOT, norm);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null;
  try {
    const st = fs.statSync(file);
    if (st.isFile() && st.size < 200 * 1024 * 1024){
      return { buf: fs.readFileSync(file), type: MIME[ext] || 'application/octet-stream' };
    }
  } catch (e) {}
  return null;
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz'){ res.writeHead(200, {'Content-Type':'text/plain'}); res.end('ok'); return; }
  const a = readAsset(req.url);
  if (!a){ res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('404 Not Found'); return; }
  let out = a.buf;
  const headers = { 'Content-Type': a.type, 'Cache-Control': 'no-cache' };
  if (a.type.indexOf('text/html') >= 0){
    out = Buffer.from(injectRoom(a.buf.toString('utf8')), 'utf8');
  }
  res.writeHead(200, headers);
  res.end(out);
});

/* =========================================================
   WebSocket（零依赖实现：文本帧 / 分片 / 关闭 / 心跳）
   ========================================================= */
function wsAccept(key){
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
function wsSend(sock, obj){
  let payload;
  try { payload = Buffer.from(JSON.stringify(obj), 'utf8'); }
  catch (e) { return; }
  const len = payload.length;
  let header;
  if (len < 126){
    header = Buffer.alloc(2); header[1] = len;
  } else if (len < 65536){
    header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + opcode text
  try { sock.write(Buffer.concat([header, payload])); } catch (e) {}
}
function wsClose(sock, code){
  try {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code || 1000, 0);
    const header = Buffer.alloc(2); header[0] = 0x88; header[1] = 2;
    sock.write(Buffer.concat([header, payload]));
    sock.end();
  } catch (e) {}
}

/* ---------------- 房间 ----------------
   host   房主浏览器 ws（游戏权威）
   guests 直连成员 ws（id -> sock）
   nodes  辅助节点 ws（nid -> sock）：本机成员经它转接到主服务器
   vguests 经辅助节点接入的虚拟成员（全局 id -> {node, localId}） */
const rooms = new Map(); // room -> { host, guests, nodes, vguests, seq, nodeSeq, graceTimer }
const HOST_GRACE_MS = 60000; // 房主刷新页面的宽限期

function getRoom(){
  let r = rooms.get(ROOM);
  if (!r){ r = { host: null, guests: new Map(), nodes: new Map(), vguests: new Map(), seq: 0, nodeSeq: 0, graceTimer: null }; rooms.set(ROOM, r); }
  return r;
}

/* 服务器/房主 → 指定成员：直连直发；辅助节点成员包装成 nodeMsg 经节点转送 */
function sendToRoomGuest(r, id, obj){
  const g = r.guests.get(id);
  if (g){ wsSend(g, obj); return; }
  const v = r.vguests.get(id);
  if (v) wsSend(v.node, { t: 'nodeMsg', to: id, data: obj });
}

/* 通知房主当前辅助节点列表（HUD 显示 🔀 辅助×N + 可分享的节点网址） */
function notifyNodes(r){
  if (!r.host || r.host.readyState === 'closed') return;
  const list = [];
  r.nodes.forEach(s => { list.push({ addr: s.__pubAddr || '', port: s.__pubPort || 0 }); });
  try { wsSend(r.host, { t: 'nodes', n: r.nodes.size, list }); } catch (e) {}
}

function onWsMessage(sock, msg){
  if (!msg || typeof msg.t !== 'string') return;

  /* ===== 辅助节点模式：本机只接待成员，全部转接主服务器 ===== */
  if (NODE_MODE){ onNodeRelay(sock, msg); return; }

  const r = getRoom();

  if (msg.t === 'create'){
    // 房主进入（刷新页面时重用宽限内的房间）
    if (r.host && r.host !== sock && r.host.readyState !== 'closed'){
      wsSend(sock, { t: 'err', err: '房间 ' + ROOM + ' 已有房主在线' });
      return;
    }
    if (r.graceTimer){ clearTimeout(r.graceTimer); r.graceTimer = null; }
    const reattach = r.guests.size > 0 || r.vguests.size > 0;
    r.host = sock;
    sock.__room = ROOM; sock.__role = 'host'; sock.__id = 0;
    wsSend(sock, { t: 'room', room: ROOM, role: 'host', port: PORT });
    console.log('[房间] 房主已进入房间 ' + ROOM + (reattach ? '（刷新重连）' : ''));
    if (reattach){
      r.guests.forEach(g => wsSend(g, { t: 'host-back' }));
      r.vguests.forEach((v, id) => wsSend(v.node, { t: 'nodeMsg', to: id, data: { t: 'host-back' } }));
      console.log('[房间] 已通知 ' + (r.guests.size + r.vguests.size) + ' 名成员：房主返回');
    }
    notifyNodes(r);
    return;
  }

  if (msg.t === 'join'){
    const target = rooms.get(String(msg.room || ''));
    if (!target){
      wsSend(sock, { t: 'err', err: '房间 ' + (msg.room || '?') + ' 不存在，请检查房间号' });
      return;
    }
    if (!target.host || target.host.readyState === 'closed'){
      wsSend(sock, { t: 'err', err: '房主不在线（房间未创建或已解散），请让房主先打开游戏页面' });
      return;
    }
    const id = ++target.seq;
    target.guests.set(id, sock);
    sock.__room = msg.room; sock.__role = 'guest'; sock.__id = id;
    wsSend(sock, { t: 'room', room: msg.room, role: 'guest', id, port: PORT });
    wsSend(target.host, { t: 'peer-join', id });
    console.log('[房间] 成员 #' + id + ' 加入');
    return;
  }

  if (msg.t === 'nodeJoin'){
    /* 辅助节点接入：把它 ws 服务器上的成员转接到本房间 */
    if (sock.__role === 'node') return;
    sock.__room = ROOM; sock.__role = 'node'; sock.__id = ++r.nodeSeq;
    sock.__vids = new Set();      // 经本节点接入的全局成员 id
    sock.__locals = new Map();    // 节点本地编号 -> 全局 id
    sock.__pubAddr = String(msg.addr || '').slice(0, 64);
    sock.__pubPort = Math.max(0, Math.min(65535, parseInt(msg.port, 10) || 0));
    r.nodes.set(sock.__id, sock);
    wsSend(sock, { t: 'nodeOk', room: ROOM, port: PORT, node: sock.__id });
    console.log('[房间] 辅助节点 #' + sock.__id + ' 已接入' + (sock.__pubAddr ? '（' + sock.__pubAddr + ':' + (sock.__pubPort || '?') + '）' : ''));
    notifyNodes(r);
    return;
  }

  if (msg.t === 'nodeMsg' && sock.__role === 'node'){
    /* 辅助节点转来的成员消息：join（分配全局 id）/ to（转发给房主） */
    const inner = msg.data;
    if (!inner || typeof inner.t !== 'string') return;
    if (inner.t === 'join'){
      if (String(inner.room || '') !== ROOM){
        wsSend(sock, { t: 'nodeMsg', local: msg.from, data: { t: 'err', err: '房间 ' + (inner.room || '?') + ' 不存在，请检查房间号' } });
        return;
      }
      if (!r.host || r.host.readyState === 'closed'){
        wsSend(sock, { t: 'nodeMsg', local: msg.from, data: { t: 'err', err: '房主不在线（房间未创建或已解散），请让房主先打开游戏页面' } });
        return;
      }
      const id = ++r.seq;
      r.vguests.set(id, { node: sock, localId: msg.from });
      sock.__vids.add(id);
      sock.__locals.set(msg.from, id);
      wsSend(sock, { t: 'nodeMsg', local: msg.from, to: id, data: { t: 'room', room: ROOM, role: 'guest', id, port: PORT } });
      wsSend(r.host, { t: 'peer-join', id });
      console.log('[房间] 成员 #' + id + ' 加入（经辅助节点 #' + sock.__id + '）');
    } else if (inner.t === 'to'){
      const id = sock.__locals.get(msg.from);
      if (id == null) return;
      if (r.host && r.host.readyState !== 'closed'){
        wsSend(r.host, { t: 'msg', from: id, data: inner.data });
      }
    }
    // 节点转来的其他消息类型忽略：只有房主能踢人
    return;
  }

  if (msg.t === 'nodeLeave' && sock.__role === 'node'){
    /* 辅助节点上的成员断开 */
    const id = Number(msg.id);
    const v = r.vguests.get(id);
    if (v && v.node === sock){
      r.vguests.delete(id);
      sock.__vids.delete(id);
      sock.__locals.delete(v.localId);
      if (r.host) wsSend(r.host, { t: 'peer-leave', id });
      console.log('[房间] 成员 #' + id + ' 离开（辅助节点 #' + sock.__id + '）');
    }
    return;
  }

  if (msg.t === 'kick'){
    // 房主踢人：仅房主可操作，向目标成员推送 kicked 后断开
    if (sock.__role === 'host' && msg.id){
      const id = Number(msg.id);
      const g = r.guests.get(id);
      if (g){
        try { wsSend(g, { t: 'msg', from: 'host', data: { t: 'kicked' } }); } catch (e) {}
        g.destroy();
      } else {
        // 经辅助节点接入的成员：通知节点转交 kicked 并断开其本地连接
        const v = r.vguests.get(id);
        if (v){
          try { wsSend(v.node, { t: 'nodeMsg', to: id, data: { t: 'msg', from: 'host', data: { t: 'kicked' } } }); } catch (e) {}
          try { wsSend(v.node, { t: 'nodeKick', to: id }); } catch (e) {}
          r.vguests.delete(id);
          v.node.__vids.delete(id);
          v.node.__locals.delete(v.localId);
          // 立即通知房主（节点侧 nodeLeave 异步到达时记录已删，收不到）
          if (r.host) wsSend(r.host, { t: 'peer-leave', id });
        }
      }
    }
    return;
  }
  if (msg.t === 'to'){
    if (sock.__role === 'host'){
      sendToRoomGuest(r, msg.to, { t: 'msg', from: 'host', data: msg.data });
    } else if (sock.__role === 'guest'){
      if (r.host && r.host.readyState !== 'closed'){
        wsSend(r.host, { t: 'msg', from: sock.__id, data: msg.data });
      }
    }
    return;
  }
}
function onWsClose(sock){
  clearInterval(sock.__hb);
  /* 辅助节点模式：本地成员断开 → 通知主服务器注销其全局 id */
  if (NODE_MODE && sock.__localId != null){
    const rec = nodeMembers.get(sock.__localId);
    if (rec){
      nodeMembers.delete(sock.__localId);
      if (rec.gid != null){ nodeLocals.delete(rec.gid); masterSend({ t: 'nodeLeave', id: rec.gid }); }
    }
    sock.__localId = null;
    return;
  }
  const room = sock.__room;
  const r = room ? rooms.get(room) : null;
  if (!r) return;
  if (sock.__role === 'host'){
    r.host = null;
    const total = r.guests.size + r.vguests.size;
    if (total > 0){
      // 宽限：房主可能只是刷新了页面（直连成员 + 经辅助节点的成员都通知）
      r.guests.forEach(g => wsSend(g, { t: 'host-away' }));
      r.vguests.forEach((v, id) => wsSend(v.node, { t: 'nodeMsg', to: id, data: { t: 'host-away' } }));
      console.log('[房间] 房主页面关闭，' + total + ' 名成员等待 ' + (HOST_GRACE_MS / 1000) + ' 秒…');
      r.graceTimer = setTimeout(() => {
        r.guests.forEach(g => { try { wsSend(g, { t: 'host-left' }); g.destroy(); } catch (e) {} });
        r.vguests.forEach((v, id) => {
          try { wsSend(v.node, { t: 'nodeMsg', to: id, data: { t: 'host-left' } }); } catch (e) {}
          try { wsSend(v.node, { t: 'nodeKick', to: id }); } catch (e) {}
        });
        r.guests.clear();
        r.vguests.clear();
        rooms.delete(room);
        console.log('[房间] 房主超时未返回，房间 ' + room + ' 已解散');
      }, HOST_GRACE_MS);
    } else {
      rooms.delete(room);
      console.log('[房间] 房间 ' + room + ' 已关闭');
    }
  } else if (sock.__role === 'guest'){
    r.guests.delete(sock.__id);
    if (r.host) wsSend(r.host, { t: 'peer-leave', id: sock.__id });
    console.log('[房间] 成员 #' + sock.__id + ' 离开');
  } else if (sock.__role === 'node'){
    // 辅助节点断开：它转接的所有成员一并离场，通知房主
    r.nodes.delete(sock.__id);
    const vids = sock.__vids ? Array.from(sock.__vids) : [];
    for (const id of vids){
      r.vguests.delete(id);
      if (r.host) wsSend(r.host, { t: 'peer-leave', id });
    }
    console.log('[房间] 辅助节点 #' + sock.__id + ' 断开，' + vids.length + ' 名转接成员离场');
    notifyNodes(r);
  }
}
function handleUpgrade(req, sock){
  const key = req.headers['sec-websocket-key'];
  if (!key){ sock.destroy(); return; }
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  sock.setNoDelay(true);
  sock.__room = null; sock.__role = null; sock.__id = 0;

  let buf = Buffer.alloc(0);
  let fragments = [];
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;){
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126){
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off); off += 2;
      } else if (len === 127){
        if (buf.length < off + 8) return;
        len = Number(buf.readBigUInt64BE(off)); off += 8;
      }
      let mask = null;
      if (masked){
        if (buf.length < off + 4) return;
        mask = buf.slice(off, off + 4); off += 4;
      }
      if (buf.length < off + len) return; // 等待完整帧
      let payload = buf.slice(off, off + len);
      if (mask){
        const u = Buffer.alloc(len);
        for (let i = 0; i < len; i++) u[i] = payload[i] ^ mask[i & 3];
        payload = u;
      }
      buf = buf.slice(off + len);

      if (opcode === 0x8){ wsClose(sock, 1000); sock.destroy(); return; }
      if (opcode === 0x9){ // ping -> pong
        const h = Buffer.alloc(2); h[0] = 0x8a; h[1] = payload.length;
        try { sock.write(Buffer.concat([h, payload])); } catch (e) {}
        continue;
      }
      if (opcode === 0xa){ sock.__alive = true; continue; }
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0){
        if (opcode === 0x0) fragments.push(payload);
        else fragments = [payload];
        if (!fin) continue;
        const full = Buffer.concat(fragments);
        fragments = [];
        let msg;
        try { msg = JSON.parse(full.toString('utf8')); } catch (e) { continue; }
        onWsMessage(sock, msg);
        continue;
      }
      // 其他 opcode 忽略
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => onWsClose(sock));

  // 心跳：30 秒无 pong 判定掉线
  sock.__alive = true;
  sock.__hb = setInterval(() => {
    if (!sock.__alive){ try { sock.destroy(); } catch (e) {} return; }
    sock.__alive = false;
    const h = Buffer.alloc(2); h[0] = 0x89; h[1] = 0;
    try { sock.write(h); } catch (e) {}
  }, 30000);
}

server.on('upgrade', (req, sock) => {
  const p = String(req.url || '').split('?')[0];
  if (p !== '/ws'){ sock.destroy(); return; }
  handleUpgrade(req, sock);
});

/* =========================================================
   辅助节点模式（--node 主服务器地址）
   ---------------------------------------------------------
   本机跑一个自己的 ws 服务器接待成员，但所有房间逻辑都转接
   主服务器：成员 join/to 经本机转发，主服务器的回包再转回成员。
   主服务器只看到「一个节点连接」，成员连接/消息负担落在本机。
   ========================================================= */
let masterWs = null;        // 到主服务器的 socket
let masterAlive = false;
let masterBuf = Buffer.alloc(0);
const nodeMembers = new Map(); // 本地编号 -> { sock, gid }
const nodeLocals = new Map();  // 全局 id -> 本地编号
let nodeLocalSeq = 0;

function masterAddrParsed(){
  const a = NODE_MODE.replace(/^wss?:\/\//i, '').replace(/\/+.*$/, '');
  const m = a.match(/^([^:]+)(?::(\d+))?$/);
  return { host: m ? m[1] : a, port: (m && m[2]) ? parseInt(m[2], 10) : 9600 };
}

/* 客户端帧必须掩码（RFC6455） */
function wsClientFrame(payload){
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126){ header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536){ header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x81;
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function masterSend(obj){
  if (!masterWs) return;
  try { masterWs.write(wsClientFrame(Buffer.from(JSON.stringify(obj), 'utf8'))); } catch (e) {}
}

function connectMaster(){
  const a = masterAddrParsed();
  const key = crypto.randomBytes(16).toString('base64');
  const req = http.request({
    host: a.host, port: a.port, path: '/ws',
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    },
  });
  req.on('upgrade', (res, sock) => {
    masterWs = sock; masterAlive = true; masterBuf = Buffer.alloc(0);
    sock.setNoDelay(true);
    console.log('[辅助节点] 已连接主服务器 ' + a.host + ':' + a.port);
    const ips = lanAddresses();
    masterSend({ t: 'nodeJoin', addr: ips[0] || '', port: PORT });
    sock.on('data', chunk => { masterBuf = Buffer.concat([masterBuf, chunk]); parseMasterFrames(); });
    sock.on('close', () => onMasterClose());
    sock.on('error', () => {});
  });
  req.on('error', () => { onMasterClose(); });
  req.end();
}

function parseMasterFrames(){
  for (;;){
    if (masterBuf.length < 2) return;
    const opcode = masterBuf[0] & 0x0f;
    const masked = (masterBuf[1] & 0x80) !== 0;
    let len = masterBuf[1] & 0x7f;
    let off = 2;
    if (len === 126){ if (masterBuf.length < off + 2) return; len = masterBuf.readUInt16BE(off); off += 2; }
    else if (len === 127){ if (masterBuf.length < off + 8) return; len = Number(masterBuf.readBigUInt64BE(off)); off += 8; }
    if (masked){ if (masterBuf.length < off + 4) return; off += 4; } // 服务器帧不带掩码，防御性跳过
    if (masterBuf.length < off + len) return;
    const payload = masterBuf.slice(off, off + len);
    masterBuf = masterBuf.slice(off + len);
    if (opcode === 0x8){ try { masterWs.destroy(); } catch (e) {} return; }
    if (opcode === 0x9){ // 主服务器 ping -> 回 pong
      try {
        const h = Buffer.alloc(2); h[0] = 0x8a; h[1] = payload.length;
        masterWs.write(Buffer.concat([h, payload]));
      } catch (e) {}
      continue;
    }
    if (opcode === 0xa) continue;
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0){
      let m; try { m = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      onMasterMessage(m);
    }
  }
}

function onMasterMessage(m){
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'nodeOk'){
    MASTER_ROOM = m.room || '';
    console.log('[辅助节点] 主服务器房间号：' + MASTER_ROOM + '（成员用这个房间号加入）');
  } else if (m.t === 'nodeMsg'){
    // 主服务器 → 本机成员：优先按 local（分配 id 前的回包），否则按全局 id
    const localId = (m.local != null) ? m.local : nodeLocals.get(m.to);
    const rec = nodeMembers.get(localId);
    if (!rec) return;
    if (m.to != null && rec.gid == null){ rec.gid = m.to; nodeLocals.set(m.to, localId); }
    try { wsSend(rec.sock, m.data); } catch (e) {}
  } else if (m.t === 'nodeKick'){
    const localId = nodeLocals.get(m.to);
    const rec = nodeMembers.get(localId);
    if (rec){
      try { rec.sock.destroy(); } catch (e) {}
      nodeMembers.delete(localId);
      nodeLocals.delete(m.to);
    }
  }
}

function onMasterClose(){
  const wasAlive = masterAlive;
  masterAlive = false; masterWs = null;
  if (wasAlive){
    console.log('[辅助节点] 与主服务器的连接断开，3 秒后重试…');
    nodeMembers.forEach(rec => {
      try { wsSend(rec.sock, { t: 'err', err: '主服务器连接中断，请稍等重连或刷新页面' }); } catch (e) {}
      try { rec.sock.destroy(); } catch (e) {}
    });
    nodeMembers.clear(); nodeLocals.clear();
  }
  setTimeout(() => { if (NODE_MODE) connectMaster(); }, 3000);
}

/* 辅助节点模式：本地成员消息 → 主服务器 */
function onNodeRelay(sock, msg){
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t === 'create'){
    wsSend(sock, { t: 'err', err: '这是辅助节点，不接待房主；请从主服务器那台电脑的网址打开房主页面' });
    return;
  }
  if (msg.t === 'join'){
    if (!masterAlive){
      wsSend(sock, { t: 'err', err: '主服务器不在线：请确认主机那台电脑已运行 1.exe 且本节点已连上' });
      return;
    }
    const localId = ++nodeLocalSeq;
    sock.__localId = localId;
    nodeMembers.set(localId, { sock, gid: null });
    masterSend({ t: 'nodeMsg', from: localId, data: msg });
    return;
  }
  if (msg.t === 'to'){
    if (sock.__localId != null && masterAlive){
      masterSend({ t: 'nodeMsg', from: sock.__localId, data: msg });
    }
    return;
  }
  // 节点上的成员发 kick 等：忽略（只有房主能踢人）
}
/* ---------------- 启动 ---------------- */
server.listen(PORT, () => {
  const ips = lanAddresses();
  const line = '==================================================';
  if (NODE_MODE){
    const a = masterAddrParsed();
    console.log('\n' + line);
    console.log('   🐍 蛇蛇大作战 · 辅助节点模式');
    console.log('   --------------------------------------------------');
    console.log('   主服务器：' + a.host + ':' + a.port);
    console.log('   本机端口：' + PORT + '（接待成员并转接主服务器）');
    console.log('   --------------------------------------------------');
    if (ips.length){
      ips.forEach(ip => {
        console.log('   成员打开： http://' + ip + ':' + PORT + '/?room=' + (MASTER_ROOM || '（主服务器房间号）'));
      });
    } else {
      console.log('   ⚠ 未检测到局域网 IP，请检查网络连接');
    }
    console.log('   保持此窗口打开 = 节点保持；关闭 = 本机成员离场');
    console.log('   房主请从主服务器那台电脑的网址打开（本节点不接待房主）');
    console.log(line + '\n');
    connectMaster();
    return;
  }
  console.log('\n' + line);
  console.log('   🐍 蛇蛇大作战 · 本地联机服务器已启动');
  console.log('   --------------------------------------------------');
  console.log('   房间号：' + ROOM);
  console.log('   --------------------------------------------------');
  if (ips.length){
    ips.forEach(ip => {
      console.log('   房主打开： http://' + ip + ':' + PORT);
      console.log('   成员打开： http://' + ip + ':' + PORT + '/?room=' + ROOM);
    });
  } else {
    console.log('   ⚠ 未检测到局域网 IP，请检查网络连接');
  }
  console.log('   本机调试： http://localhost:' + PORT);
  console.log('   --------------------------------------------------');
  console.log('   保持此窗口打开 = 房间保持；关闭 = 房间解散');
  console.log('   自定义：1.exe --port 9601 --room 123456');
  console.log(line + '\n');
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE'){
    console.error('❌ 端口 ' + PORT + ' 已被占用。换一个端口再试：1.exe --port 9601');
  } else {
    console.error('❌ 服务器错误：' + e.message);
  }
  process.exit(1);
});
