const fs = require('fs');
let src = fs.readFileSync('game.js', 'utf8');
let n = 0;
function rep(old, neo, label){
  if (!src.includes(old)) { console.error('MISS: ' + label); process.exit(1); }
  src = src.replace(old, neo); n++;
}

/* ---- 1. drawSnake: 棍母蛇头像（替换蛇头方块 + 眼睛） ---- */
rep(`  const h = cur[0];
  let hx = h.x * CELL + CELL / 2, hy = h.y * CELL + CELL / 2;`,
`  const h = cur[0];
  let hx = h.x * CELL + CELL / 2, hy = h.y * CELL + CELL / 2;
  /* 棍母蛇：蛇头用裁切照片（save/restore 隔离，避免 fillStyle 污染后续 emoji） */
  const headImg = (s.skin === 'gunma') ? getGunmaImg() : null;
  if (headImg && headImg.complete && headImg.naturalWidth){
    ctx.save();
    ctx.globalAlpha = (frozen || stunned) ? 0.45 : 1;
    const hs = CELL * 1.5;
    ctx.drawImage(headImg, hx - hs / 2, hy - hs / 2, hs, hs);
    ctx.restore();
  }`, 'gunma head draw');

/* ---- 2. eyes/name only if not gunma img? 保留眼睛无妨（画在照片上会突兀）→ 包一层判断 ---- */
rep(`  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(hx + fx + ox, hy + fy + oy, 2.8, 0, 7); ctx.fill();`,
`  const hasPhoto = !!(headImg && headImg.complete && headImg.naturalWidth);
  if (!hasPhoto){
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(hx + fx + ox, hy + fy + oy, 2.8, 0, 7); ctx.fill();`, 'eyes start');
rep(`  ctx.beginPath(); ctx.arc(hx + fx - ox + d.x * 1, hy + fy - oy + d.y * 1, 1.4, 0, 7); ctx.fill();

  if (s.isPlayer){`,
`  ctx.beginPath(); ctx.arc(hx + fx - ox + d.x * 1, hy + fy - oy + d.y * 1, 1.4, 0, 7); ctx.fill();
  }

  if (s.isPlayer){`, 'eyes end');

/* ---- 3. draw(): 隐身的蛇不渲染（自己除外，半透明） ---- */
rep(`  for (const ai of S.game.ai){
    if (ai.alive && ai.snake.length) drawSnake(ai, t);
  }
  if (S.game.player.alive && S.game.player.snake.length){
    drawSnake(S.game.player, t);
  }`,
`  for (const ai of S.game.ai){
    if (ai.alive && ai.snake.length && !cloakedActive(ai)) drawSnake(ai, t);
  }
  if (S.game.player.alive && S.game.player.snake.length){
    // 自己隐身时画半透明轮廓，方便知道自己位置（别人看不到）
    if (cloakedActive(S.game.player)){
      ctx.save(); ctx.globalAlpha = 0.3; drawSnake(S.game.player, t); ctx.restore();
    } else {
      drawSnake(S.game.player, t);
    }
  }`, 'draw cloak skip');

/* ---- 4. drawMinimap: 隐身蛇不点亮 ---- */
rep(`  for (const s of allSnakes()){
    if (!s.alive || !s.snake.length) continue;
    ctx.fillStyle = s.color;`,
`  for (const s of allSnakes()){
    if (!s.alive || !s.snake.length || cloakedActive(s)) continue;
    ctx.fillStyle = s.skin ? skinColor(s.skin) : s.color;`, 'minimap cloak + skin');

/* ---- 5. 信息卡：隐身蛇不显示 + 皮肤/队伍字段 ---- */
rep(`    for (const s of allSnakes()){
      if (!s.alive || !s.snake.length) continue;
      const h = s.snake[0];`,
`    for (const s of allSnakes()){
      if (!s.alive || !s.snake.length || cloakedActive(s)) continue;
      const h = s.snake[0];`, 'snakeInfo cloak');
rep(`      <div class="si-head">
        <span class="si-dot" style="background:${target.color}"></span>
        <span class="si-name">${escapeHtml(snakeLabel(target))}</span>
      </div>
      <div class="si-grid">
        <span>得分</span><b>${target.score}</b>
        <span>长度</span><b>${target.alive ? target.snake.length : 0}</b>
        <span>状态</span><b class="si-status">存活</b>
        ${(target.crowns || 0) > 0 ? \`<span>皇冠</span><b>👑\${target.crowns}</b>\` : ''}
      </div>\`;`,
`      <div class="si-head">
        <span class="si-dot" style="background:${target.color}"></span>
        <span class="si-name">${escapeHtml(snakeLabel(target))}</span>
      </div>
      <div class="si-grid">
        <span>得分</span><b>${target.score}</b>
        <span>长度</span><b>${target.alive ? target.snake.length : 0}</b>
        <span>状态</span><b class="si-status">存活</b>
        <span>皮肤</span><b>${skinOf(target.skin).name}</b>
        <span>队伍</span><b>${target.team ? '队' + target.team : '无'}</b>
        ${(target.crowns || 0) > 0 ? \`<span>皇冠</span><b>👑\${target.crowns}</b>\` : ''}
      </div>\`;` , 'snakeInfo fields');

fs.writeFileSync('game.js.new', src, 'utf8');
console.log('PATCH4 OK', n);
