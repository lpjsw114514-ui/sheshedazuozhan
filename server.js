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

   说明：
     - 每个 exe 实例 = 一个房间；关闭窗口 = 房间解散
     - 房主刷新页面有 60 秒宽限，期间成员保持连接等待
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

/* 向 HTML 注入房间信息，页面据此自动预填房间号/生成成员链接 */
function injectRoom(html){
  const ips = JSON.stringify(lanAddresses());
  const tag = '<script>window.LAN_SERVER={room:"' + ROOM + '",port:' + PORT + ',ips:' + ips + '};</script>';
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

/* ---------------- 房间 ---------------- */
const rooms = new Map(); // room -> { host, guests:Map(id->sock), seq, graceTimer }
const HOST_GRACE_MS = 60000; // 房主刷新页面的宽限期

function getRoom(){
  let r = rooms.get(ROOM);
  if (!r){ r = { host: null, guests: new Map(), seq: 0, graceTimer: null }; rooms.set(ROOM, r); }
  return r;
}

function onWsMessage(sock, msg){
  if (!msg || typeof msg.t !== 'string') return;
  const r = getRoom();

  if (msg.t === 'create'){
    // 房主进入（刷新页面时重用宽限内的房间）
    if (r.host && r.host !== sock && r.host.readyState !== 'closed'){
      wsSend(sock, { t: 'err', err: '房间 ' + ROOM + ' 已有房主在线' });
      return;
    }
    if (r.graceTimer){ clearTimeout(r.graceTimer); r.graceTimer = null; }
    const reattach = r.guests.size > 0;
    r.host = sock;
    sock.__room = ROOM; sock.__role = 'host'; sock.__id = 0;
    wsSend(sock, { t: 'room', room: ROOM, role: 'host', port: PORT });
    console.log('[房间] 房主已进入房间 ' + ROOM + (reattach ? '（刷新重连）' : ''));
    if (reattach){
      for (const [, g] of r.guests) wsSend(g, { t: 'host-back' });
      console.log('[房间] 已通知 ' + r.guests.size + ' 名成员：房主返回');
    }
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

  if (msg.t === 'kick'){
    // 房主踢人：仅房主可操作，向目标成员推送 kicked 后断开
    if (sock.__role === 'host' && msg.id){
      const g = r.guests.get(Number(msg.id));
      if (g){
        try { wsSend(g, { t: 'msg', from: 'host', data: { t: 'kicked' } }); } catch (e) {}
        g.destroy();
      }
    }
    return;
  }

  if (msg.t === 'to'){
    if (sock.__role === 'host'){
      const g = r.guests.get(msg.to);
      if (g) wsSend(g, { t: 'msg', from: 'host', data: msg.data });
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
  const room = sock.__room;
  const r = room ? rooms.get(room) : null;
  if (!r) return;
  if (sock.__role === 'host'){
    r.host = null;
    if (r.guests.size > 0){
      // 宽限：房主可能只是刷新了页面
      for (const [, g] of r.guests) wsSend(g, { t: 'host-away' });
      console.log('[房间] 房主页面关闭，' + r.guests.size + ' 名成员等待 ' + (HOST_GRACE_MS / 1000) + ' 秒…');
      r.graceTimer = setTimeout(() => {
        for (const [, g] of r.guests){
          try { wsSend(g, { t: 'host-left' }); g.destroy(); } catch (e) {}
        }
        r.guests.clear();
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

/* ---------------- 启动 ---------------- */
server.listen(PORT, () => {
  const ips = lanAddresses();
  const line = '==================================================';
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
