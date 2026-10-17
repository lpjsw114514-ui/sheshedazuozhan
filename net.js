'use strict';
/* =========================================================
   零服务器 P2P 联机层（WebRTC DataChannel + 手动信令）
   ---------------------------------------------------------
   - 不依赖任何服务器，不做内网穿透
   - 信令码经 deflate 压缩：3~6KB → 约 1~1.5KB
   - 码格式：S1.<校验>.<base64(deflate(JSON))>
            不支持压缩的浏览器降级为 S0.<校验>.<base64(JSON)>
   - 码内置 FNV 校验，复制截断会明确提示，不再莫名"连接失败"
   - 支持手动填写本机 IP 注入 SDP，绕过浏览器 mDNS 隐藏 IP
     （校园网/教室 multicast 不通时的主要失败原因）
   ========================================================= */
const Net = (function () {

  /* 同一局域网留空即可（host candidate 直连）。
     若好友不在同一局域网、需要跨 NAT 直连，可取消下一行注释：
     STUN 仅用于发现公网地址，数据仍走 P2P，不经过服务器转发。 */
  const CFG = { iceServers: [] };
  // const CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  const ICE_WAIT_MS = 3000; // 等待 ICE 候选收集完的上限

  let role = null;            // 'host' | 'guest'
  let peerSeq = 0;            // 房主侧同学编号
  const peers = new Map();    // host: id -> { pc, dc, id, answered }
  let guestPC = null, guestDC = null;

  const on = {
    message:   null,   // (peerId|null, msg)
    peerOpen:  null,   // host: (peerId)
    peerClose: null,   // host: (peerId)
    hostOpen:  null,   // guest
    hostClose: null,   // guest
  };

  /* ================= 压缩 / 编码 ================= */
  async function pipeThrough(stream, bytes) {
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const reader = stream.readable.getReader();
    const chunks = [];
    let len = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      len += value.length;
    }
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try { return await pipeThrough(new CompressionStream('deflate-raw'), bytes); }
    catch (e) { return null; }
  }
  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') return null;
    try { return await pipeThrough(new DecompressionStream('deflate-raw'), bytes); }
    catch (e) { return null; }
  }

  /* FNV-1a 校验：防止码被截断/复制不全 */
  function fnv1a(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }
  function b64encode(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function b64decode(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /* obj -> 短码 */
  async function enc(obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    const comp = await deflate(raw);
    if (comp && comp.length < raw.length) {
      return 'S1.' + fnv1a(comp) + '.' + b64encode(comp);
    }
    return 'S0.' + fnv1a(raw) + '.' + b64encode(raw);
  }
  /* 短码 -> obj（带完整性校验） */
  async function dec(str) {
    str = String(str || '').trim();
    const m = str.match(/^S([01])\.([0-9a-z]+)\.([A-Za-z0-9+/=]+)$/);
    if (!m) throw new Error('码格式不正确（不是本工具生成的联机码）');
    const mode = m[1], sum = m[2], payload = m[3];
    let bytes;
    try { bytes = b64decode(payload); }
    catch (e) { throw new Error('码已损坏，请重新复制'); }
    if (fnv1a(bytes) !== sum) throw new Error('码不完整或被截断，请重新复制');
    let raw = bytes;
    if (mode === '1') {
      const out = await inflate(bytes);
      if (!out) throw new Error('当前浏览器不支持解压，请换 Chrome / Edge');
      raw = out;
    }
    try { return JSON.parse(new TextDecoder().decode(raw)); }
    catch (e) { throw new Error('码内容解析失败，请重新复制'); }
  }

  /* ================= 本机 IP 注入 SDP ================= */
  /* Chrome 默认把本机 IP 替换成 xxx.local（mDNS），校园网里
     multicast 常不通导致连不上。填入真实 IP 后：
     ① 已有的 .local 候选地址替换为真实 IP；② 没有 host 候选则补一条 */
  function injectIp(sdp, ip) {
    ip = String(ip || '').trim();
    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return sdp;
    const nl = sdp.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const lines = sdp.split(/\r?\n/);
    let hasHost = false;
    const out = lines.map(line => {
      const m = line.match(/^a=candidate:(\S+ \S+ \S+ \d+ )(\S+?)(\.local)?( .*)$/);
      if (!m) return line;
      if (/ typ host( |$)/.test(line)) hasHost = true;
      return 'a=candidate:' + m[1] + (m[3] ? ip : m[2]) + m[4];
    });
    if (!hasHost) {
      out.push('a=candidate:1 1 UDP 2122197243 ' + ip + ' 9 typ host');
    }
    return out.join(nl);
  }
  function hasMdnsCandidate(sdp) {
    return /\.local/.test(sdp || '');
  }

  /* ================= WebRTC 基础 ================= */
  function newPC() { return new RTCPeerConnection(CFG); }

  /* 等待 ICE 候选收集完毕，把完整 SDP 打进联机码 */
  function waitIce(pc) {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(finish, ICE_WAIT_MS); // 兜底超时
    });
  }

  /* ================= 房主 ================= */
  async function createInvite(myIp) {
    role = 'host';
    const id = ++peerSeq;
    const pc = newPC();
    const dc = pc.createDataChannel('game', { ordered: true });
    const peer = { pc, dc, id, answered: false };
    peers.set(id, peer);

    dc.onopen = () => { if (on.peerOpen) on.peerOpen(id); };
    dc.onclose = () => {
      peers.delete(id);
      if (on.peerClose) on.peerClose(id);
    };
    dc.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (on.message) on.message(id, m);
    };

    await pc.setLocalDescription(await pc.createOffer());
    await waitIce(pc);
    const rawSdp = pc.localDescription.sdp;
    const code = await enc({
      v: 2, role: 'offer', id,
      sdp: { type: 'offer', sdp: injectIp(rawSdp, myIp) },
    });
    return { code, mdns: hasMdnsCandidate(rawSdp) };
  }

  async function acceptAnswer(codeStr) {
    let data;
    try { data = await dec(codeStr); }
    catch (e) { return { ok: false, err: e.message }; }
    if (data.role !== 'answer') return { ok: false, err: '这不是应答码（应是同学生成的回传码）' };
    const peer = peers.get(data.id);
    if (!peer) return { ok: false, err: '找不到对应邀请（页面刷新过或邀请码已过期，请重新创建房间）' };
    if (peer.answered) return { ok: false, err: '该同学已确认过，请勿重复粘贴' };
    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp.sdp });
      peer.answered = true;
      return { ok: true, id: peer.id };
    } catch (e) {
      return { ok: false, err: '连接失败：应答码无效或与邀请码不配对（' + e.message + '）' };
    }
  }

  /* ================= 同学 ================= */
  async function joinWithCode(codeStr, myIp) {
    let invite;
    try { invite = await dec(codeStr); }
    catch (e) { return { ok: false, err: e.message }; }
    if (invite.role !== 'offer') return { ok: false, err: '这不是邀请码（应由房主生成）' };

    role = 'guest';
    const pc = newPC();
    guestPC = pc;
    pc.ondatachannel = e => {
      const dc = e.channel;
      guestDC = dc;
      dc.onopen = () => { if (on.hostOpen) on.hostOpen(); };
      dc.onclose = () => { guestDC = null; if (on.hostClose) on.hostClose(); };
      dc.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch (err) { return; }
        if (on.message) on.message(null, m);
      };
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: invite.sdp.sdp });
    } catch (e) {
      return { ok: false, err: '连接失败：邀请码无效（' + e.message + '）' };
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    const rawSdp = pc.localDescription.sdp;
    const code = await enc({
      v: 2, role: 'answer', id: invite.id,
      sdp: { type: 'answer', sdp: injectIp(rawSdp, myIp) },
    });
    return { ok: true, code, mdns: hasMdnsCandidate(rawSdp) };
  }

  /* ================= 发送 / 状态 ================= */
  function sendToPeer(id, obj) {
    const p = peers.get(id);
    if (p && p.dc && p.dc.readyState === 'open') {
      try { p.dc.send(JSON.stringify(obj)); } catch (e) {}
    }
  }
  function broadcast(obj, exceptId) {
    peers.forEach((p, id) => { if (id !== exceptId) sendToPeer(id, obj); });
  }
  function sendToHost(obj) {
    if (guestDC && guestDC.readyState === 'open') {
      try { guestDC.send(JSON.stringify(obj)); } catch (e) {}
    }
  }
  function isPeerOpen(id) {
    const p = peers.get(id);
    return !!(p && p.dc && p.dc.readyState === 'open');
  }
  function hostReady() {
    return !!(guestDC && guestDC.readyState === 'open');
  }

  function closeAll() {
    peers.forEach(p => { try { p.dc.close(); } catch (e) {} try { p.pc.close(); } catch (e) {} });
    peers.clear();
    if (guestDC) { try { guestDC.close(); } catch (e) {} guestDC = null; }
    if (guestPC) { try { guestPC.close(); } catch (e) {} guestPC = null; }
    role = null;
  }

  return {
    on,
    createInvite, acceptAnswer, joinWithCode,
    sendToPeer, broadcast, sendToHost, closeAll,
    isPeerOpen, hostReady,
    _debug: { enc, dec, injectIp, hasMdnsCandidate }, // 供测试/调试
  };
})();
