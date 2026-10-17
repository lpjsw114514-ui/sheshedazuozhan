'use strict';
/* =========================================================
   零服务器 P2P 联机层（WebRTC DataChannel + 手动信令）
   ---------------------------------------------------------
   - 不依赖任何服务器，不做内网穿透
   - 信令（邀请码 / 应答码）通过 QQ、微信等任意方式传递
   - 拓扑：星型，房主为中转；数据全部 P2P 直连
   - 同一局域网（教室 / 宿舍）留空 iceServers 即可直连
   ========================================================= */
const Net = (function () {

  /* 同一局域网留空即可（host candidate 直连）。
     若好友不在同一局域网、需要跨 NAT 直连，可取消下一行注释：
     STUN 仅用于发现公网地址，数据仍走 P2P，不经过服务器转发。 */
  const CFG = { iceServers: [] };
  // const CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  let role = null;            // 'host' | 'guest'
  let peerSeq = 0;            // 房主侧同学编号
  const peers = new Map();    // host: id -> { pc, dc }
  let guestPC = null, guestDC = null;

  const on = {
    message:   null,   // (peerId|null, msg)
    peerOpen:  null,   // host: (peerId)
    peerClose: null,   // host: (peerId)
    hostOpen:  null,   // guest
    hostClose: null,   // guest
  };

  /* ---------- 编解码：SDP <-> 可复制文本 ---------- */
  function enc(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function dec(str) {
    const bin = atob(String(str).trim());
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function newPC() { return new RTCPeerConnection(CFG); }

  /* 等待 ICE 候选收集完毕，把完整 SDP 打进邀请码 */
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
      setTimeout(finish, 2500); // 兜底超时
    });
  }

  /* ================= 房主 ================= */
  async function createInvite() {
    role = 'host';
    const id = ++peerSeq;
    const pc = newPC();
    const dc = pc.createDataChannel('game', { ordered: true });
    const peer = { pc, dc, id };
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
    return enc({ v: 1, role: 'offer', id, sdp: pc.localDescription });
  }

  async function acceptAnswer(codeStr) {
    let data;
    try { data = dec(codeStr); } catch (e) { return { ok: false, err: '应答码解析失败，请检查是否复制完整' }; }
    if (data.role !== 'answer') return { ok: false, err: '这不是应答码' };
    const peer = peers.get(data.id);
    if (!peer) return { ok: false, err: '找不到对应邀请（页面可能刷新过，请重新生成邀请码）' };
    try {
      await peer.pc.setRemoteDescription(data.sdp);
      return { ok: true };
    } catch (e) {
      return { ok: false, err: '连接失败：' + e.message };
    }
  }

  /* ================= 同学 ================= */
  async function joinWithCode(codeStr) {
    let invite;
    try { invite = dec(codeStr); } catch (e) { return { ok: false, err: '邀请码解析失败，请检查是否复制完整' }; }
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
    await pc.setRemoteDescription(invite.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    return { ok: true, code: enc({ v: 1, role: 'answer', id: invite.id, sdp: pc.localDescription }) };
  }

  /* ================= 发送 ================= */
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
  };
})();
