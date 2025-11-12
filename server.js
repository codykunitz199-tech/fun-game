/* server.js — Restored behavior to match original single-player feel with multiplayer wiring */
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

/* Optional: root message so visiting the URL doesn't show "Cannot GET /" */
app.get("/", (req, res) => res.send("Game server is running. Connect via client.html"));

/* ===== Constants & helpers ===== */
const TICK_RATE = 30;
const DT = 1000 / TICK_RATE;
const MAP_W = 7200, MAP_H = 5400;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const rand = (a, b) => a + Math.random() * (b - a);
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
const angleTo = (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax);
function addPopup(x, y, text, color = "white", duration = 800) {
  world.damagePopups.push({ x, y, text: String(text), color, duration });
}
function resolveOverlapCircle(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const minD = (a.r || 0) + (b.r || 0);
  if (d === 0 || d >= minD) return;
  const overlap = minD - d;
  const nx = dx / (d || 1), ny = dy / (d || 1);
  const push = overlap / 2;
  a.x -= nx * push; a.y -= ny * push;
  b.x += nx * push; b.y += ny * push;
  a.x = clamp(a.x, a.r, MAP_W - a.r);
  a.y = clamp(a.y, a.r, MAP_H - a.r);
  b.x = clamp(b.x, b.r, MAP_W - b.r);
  b.y = clamp(b.y, b.r, MAP_H - b.r);
}

/* ===== World ===== */
const world = {
  mapWidth: MAP_W,
  mapHeight: MAP_H,
  players: new Map(),
  shapes: [],
  boss: null,
  superBoss: null,
  damagePopups: []
};

/* ===== Player factory ===== */
function makePlayer(id) {
  return {
    id,
    x: rand(300, MAP_W - 300),
    y: rand(300, MAP_H - 300),
    r: 20,
    angle: 0,
    speed: 3,
    hp: 100,
    maxHp: 100,
    xp: 0,
    level: 1,
    dead: false,

    // gun
    mainGunEnabled: true,
    barrels: 1,
    bulletSpeed: 8,
    bulletDamage: 10,
    fireCooldown: 0,
    bullets: [],

    // path/upgrades
    path: null,
    precisionBattery: false,
    sideSponsons: false,

    // drones
    drones: [],
    maxDrones: 0,
    droneRespawn: 2800,
    droneGuardian: false,

    // traps
    traps: [],
    trapLayer: false,
    trapMax: 0,
    trapCooldown: 2400,
    nextTrapTime: 0,

    // prompt
    _prompt: null,

    // input
    input: { keys: { w:false,a:false,s:false,d:false }, mouse: { x:0,y:0 }, camera: { x:0,y:0 } }
  };
}

/* ===== Shapes: harmless floating ===== */
function spawnShapes(n = 200) {
  world.shapes = [];
  for (let i = 0; i < n; i++) {
    const tRoll = Math.random();
    const type = tRoll < 0.55 ? "square" : tRoll < 0.85 ? "triangle" : "pentagon";
    const base = type === "square" ? { r: 18, hp: 30 }
               : type === "triangle" ? { r: 22, hp: 60 }
               : { r: 26, hp: 120 };
    // harmless float velocity
    const speed = rand(0.4, 0.9);
    const ang = rand(0, Math.PI * 2);
    world.shapes.push({
      id: "shape_" + i + "_" + Date.now(),
      type,
      variant: Math.random() < 0.03 ? "beta" : Math.random() < 0.01 ? "aptha" : null,
      x: rand(200, MAP_W - 200),
      y: rand(200, MAP_H - 200),
      r: base.r,
      hp: base.hp,
      maxHp: base.hp,
      angle: ang,
      speed,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      driftTimer: rand(600, 1600)
    });
  }
}
function stepShapes() {
  for (const s of world.shapes) {
    s.driftTimer -= DT;
    if (s.driftTimer <= 0) {
      s.driftTimer = rand(800, 1800);
      const ang = rand(0, Math.PI * 2);
      s.vx = Math.cos(ang) * s.speed;
      s.vy = Math.sin(ang) * s.speed;
    }
    s.x += s.vx; s.y += s.vy;
    if (s.x <= s.r || s.x >= MAP_W - s.r) s.vx *= -1;
    if (s.y <= s.r || s.y >= MAP_H - s.r) s.vy *= -1;
    s.x = clamp(s.x, s.r, MAP_W - s.r);
    s.y = clamp(s.y, s.r, MAP_H - s.r);
  }
  // prevent shape-shape overlaps
  for (let i = 0; i < world.shapes.length; i++) {
    for (let j = i + 1; j < world.shapes.length; j++) {
      resolveOverlapCircle(world.shapes[i], world.shapes[j]);
    }
  }
}

/* ===== Boss (optional mid-boss, simple) ===== */
function spawnBoss() {
  world.boss = {
    x: MAP_W/2 - 600, y: MAP_H/2 - 350, r: 80,
    angle: 0, hp: 2200, maxHp: 2200,
    bullets: [],
    fireTimer: 0,
    vx: 0.6, vy: 0.5
  };
}
function stepBoss(boss) {
  if (!boss || boss.hp <= 0) return;
  boss.angle += 0.01;
  boss.x += boss.vx; boss.y += boss.vy;
  if (boss.x <= boss.r || boss.x >= MAP_W - boss.r) boss.vx *= -1;
  if (boss.y <= boss.r || boss.y >= MAP_H - boss.r) boss.vy *= -1;

  boss.fireTimer += DT;
  if (boss.fireTimer >= 900) {
    boss.fireTimer = 0;
    // aim at nearest player
    let target = null, best = Infinity;
    for (const p of world.players.values()) {
      if (p.dead) continue;
      const d = dist(boss.x, boss.y, p.x, p.y);
      if (d < best) { best = d; target = p; }
    }
    if (target) {
      const ang = angleTo(boss.x, boss.y, target.x, target.y);
      for (let i = -0.12; i <= 0.12; i += 0.12) {
        const a = ang + i;
        boss.bullets.push({
          x: boss.x + Math.cos(a) * boss.r,
          y: boss.y + Math.sin(a) * boss.r,
          r: 7, dx: Math.cos(a) * 7, dy: Math.sin(a) * 7,
          damage: 12, life: 1600
        });
      }
    }
  }
  // bullets hit players
  for (let i = boss.bullets.length - 1; i >= 0; i--) {
    const b = boss.bullets[i];
    b.x += b.dx; b.y += b.dy; b.life -= DT;
    if (b.life <= 0 || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) { boss.bullets.splice(i, 1); continue; }
    for (const p of world.players.values()) {
      if (p.dead) continue;
      if (dist(b.x, b.y, p.x, p.y) <= b.r + p.r) {
        p.hp -= b.damage;
        addPopup(p.x, p.y - p.r - 20, b.damage, "white", 900);
        boss.bullets.splice(i, 1);
        if (p.hp <= 0) killPlayer(p, null);
        break;
      }
    }
  }
}

/* ===== Super Boss: three layers, distinct attacks, moves toward nearest entity, spawns top big drones ===== */
function spawnSuperBoss() {
  world.superBoss = {
    x: MAP_W/2 + 600, y: MAP_H/2 + 250,
    rBottom: 120, rMiddle: 90, rTop: 60,
    angleBottom: 0, angleMiddle: 0, angleTop: 0,
    hp: 9000, maxHp: 9000,

    // attacks
    bullets: [],

    // drones from top (slow targeting)
    bigDrones: [],

    // timers
    timerBottom: 0,  // omega cannons
    timerMiddle: 0,  // radial bursts
    timerTop: 0,     // spawn big drone

    // movement
    vx: 0, vy: 0, speed: 0.55
  };
}
function nearestEntity(x, y) {
  let nearest = null, best = Infinity;
  for (const s of world.shapes) {
    const d = dist(x, y, s.x, s.y);
    if (d < best) { best = d; nearest = s; }
  }
  for (const p of world.players.values()) {
    if (p.dead) continue;
    const d = dist(x, y, p.x, p.y);
    if (d < best) { best = d; nearest = p; }
  }
  return nearest;
}
function stepSuperBoss(sb) {
  if (!sb || sb.hp <= 0) return;

  // movement: toward nearest entity (shape or player)
  const tgt = nearestEntity(sb.x, sb.y);
  if (tgt) {
    const ang = angleTo(sb.x, sb.y, tgt.x, tgt.y);
    sb.vx = Math.cos(ang) * sb.speed;
    sb.vy = Math.sin(ang) * sb.speed;
  }
  sb.x += sb.vx; sb.y += sb.vy;
  sb.x = clamp(sb.x, sb.rBottom, MAP_W - sb.rBottom);
  sb.y = clamp(sb.y, sb.rBottom, MAP_H - sb.rBottom);

  // rings rotate with distinct speeds/directions
  sb.angleBottom += 0.006;       // bottom: clockwise slow
  sb.angleMiddle -= 0.011;       // middle: counter-clockwise medium
  sb.angleTop += 0.019;          // top: clockwise fast

  // bottom: omega cannons — big fast balls, 50 dmg, slow cadence
  sb.timerBottom += DT;
  if (sb.timerBottom >= 1500) {
    sb.timerBottom = 0;
    const t = nearestEntity(sb.x, sb.y);
    if (t) {
      const baseA = angleTo(sb.x, sb.y, t.x, t.y);
      for (const off of [-0.05, 0.05]) {
        const a = baseA + off;
        sb.bullets.push({
          x: sb.x + Math.cos(a) * sb.rBottom,
          y: sb.y + Math.sin(a) * sb.rBottom,
          r: 10, dx: Math.cos(a) * 9.5, dy: Math.sin(a) * 9.5,
          damage: 50, life: 1800, layer: "bottom"
        });
      }
    }
  }

  // middle: radial bursts, consistent spread
  sb.timerMiddle += DT;
  if (sb.timerMiddle >= 800) {
    sb.timerMiddle = 0;
    for (let i = 0; i < 16; i++) {
      const a = sb.angleMiddle + i * (Math.PI * 2 / 16);
      sb.bullets.push({
        x: sb.x + Math.cos(a) * sb.rMiddle,
        y: sb.y + Math.sin(a) * sb.rMiddle,
        r: 6, dx: Math.cos(a) * 6.2, dy: Math.sin(a) * 6.2,
        damage: 8, life: 1500, layer: "middle"
      });
    }
  }

  // top: spawn big drone that slowly targets nearest entity
  sb.timerTop += DT;
  if (sb.timerTop >= 1800 && sb.bigDrones.length < 6) {
    sb.timerTop = 0;
    sb.bigDrones.push({
      x: sb.x + Math.cos(sb.angleTop) * (sb.rTop + 22),
      y: sb.y + Math.sin(sb.angleTop) * (sb.rTop + 22),
      r: 16, hp: 120, speed: 1.6
    });
  }

  // big drones: move toward nearest entity; contact damage to players; can be shot down
  for (let i = sb.bigDrones.length - 1; i >= 0; i--) {
    const d = sb.bigDrones[i];
    const t2 = nearestEntity(d.x, d.y);
    if (t2) {
      const ang = angleTo(d.x, d.y, t2.x, t2.y);
      d.x += Math.cos(ang) * d.speed;
      d.y += Math.sin(ang) * d.speed;
    }
    d.x = clamp(d.x, d.r, MAP_W - d.r);
    d.y = clamp(d.y, d.r, MAP_H - d.r);
    // contact damage to players only
    for (const p of world.players.values()) {
      if (p.dead) continue;
      if (dist(d.x, d.y, p.x, p.y) <= d.r + p.r) {
        p.hp -= 10;
        addPopup(p.x, p.y - p.r - 20, 10, "#ff66ff", 900);
        if (p.hp <= 0) killPlayer(p, null);
      }
    }
  }

  // bullets travel and hit players
  for (let i = sb.bullets.length - 1; i >= 0; i--) {
    const b = sb.bullets[i];
    b.x += b.dx; b.y += b.dy; b.life -= DT;
    if (b.life <= 0 || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) { sb.bullets.splice(i, 1); continue; }
    for (const p of world.players.values()) {
      if (p.dead) continue;
      if (dist(b.x, b.y, p.x, p.y) <= b.r + p.r) {
        p.hp -= b.damage;
        addPopup(p.x, p.y - p.r - 20, b.damage, "#ff66ff", 900);
        sb.bullets.splice(i, 1);
        if (p.hp <= 0) killPlayer(p, null);
        break;
      }
    }
  }

  // separation: prevent super boss overlapping shapes and players
  for (const s of world.shapes) resolveOverlapCircle(sb, s);
  for (const p of world.players.values()) resolveOverlapCircle(sb, p);
}

/* ===== XP & level milestones (prompts) ===== */
function addXP(p, amount) {
  if (!p) return;
  p.xp += amount;
  const thresholds = [0, 100, 250, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400, 6500];
  while (p.level < 12 && p.xp >= thresholds[p.level]) {
    p.level++;
    if (p.level === 3 && !p.path) p._prompt = { type: "path" };
    else if ([6, 9, 12].includes(p.level)) p._prompt = { type: "subUpgrade", level: p.level };
  }
}

/* ===== Upgrades: paths and sub‑upgrades (restored flags/values) ===== */
function applyPath(p, path) {
  p.path = path;
  if (path === "multi") {
    p.barrels = 3;
    p.bulletDamage = 7;
    p.bulletSpeed = 8;
  } else if (path === "big") {
    p.barrels = 1;
    p.bulletDamage = 24;
    p.bulletSpeed = 7;
  } else if (path === "drone") {
    p.maxDrones = 6;
    p.droneRespawn = 2600;
  } else if (path === "trap") {
    p.trapLayer = true;
    p.trapMax = 5;
  }
}
function applySubUpgrade(p, key) {
  switch (key) {
    // drones
    case "droneKamikazeBoost": p.bulletDamage += 4; break;
    case "droneGuardian": p.droneGuardian = true; break;
    case "droneShooter": p.maxDrones = Math.max(p.maxDrones, 8); p.droneRespawn = 2400; break;
    case "hiveExpansion": p.maxDrones = Math.max(p.maxDrones, 15); break;
    case "droneCommander": p.maxDrones = Math.max(p.maxDrones, 20); p.droneRespawn = 1800; break;
    case "hybridDrones": p.droneRespawn = 2200; break;

    // multi
    case "sideSponsons": p.sideSponsons = true; break;
    case "quadCore": p.barrels += 1; break;
    case "artillery": p.bulletSpeed = Math.max(6, p.bulletSpeed - 1); p.bulletDamage += 2; break;
    case "wallOfLead": p.barrels += 2; p.bulletDamage = Math.max(4, Math.floor(p.bulletDamage * 0.67)); break;
    case "precisionBattery": p.precisionBattery = true; break;

    // big
    case "dualBig": p.barrels = Math.max(p.barrels, 2); break;
    case "megaBullet": p.bulletDamage += 8; break;
    case "siegeMode": p.speed = Math.max(2, p.speed - 1); p.bulletDamage += 6; break;
    case "titanShell": p.bulletDamage += 12; p.bulletSpeed = Math.max(5, p.bulletSpeed - 1); break;
    case "twinSiege": p.barrels = Math.max(p.barrels, 2); p.bulletDamage += 6; break;

    // traps
    case "trapDoubleLayer": p.trapMax = Math.max(p.trapMax, 7); break;
    case "trapQuad": p.trapMax = Math.max(p.trapMax, 9); break;
    case "trapHuge": p.trapMax = Math.max(p.trapMax, 6); break;
    default: break;
  }
}

/* ===== Player runtime (movement, firing, drones, traps, collisions) ===== */
function updatePlayer(p) {
  const { keys, mouse, camera } = p.input;
  const sp = p.speed;
  if (keys.w) p.y -= sp;
  if (keys.s) p.y += sp;
  if (keys.a) p.x -= sp;
  if (keys.d) p.x += sp;
  p.x = clamp(p.x, p.r, MAP_W - p.r);
  p.y = clamp(p.y, p.r, MAP_H - p.r);

  // separate from shapes and super boss
  for (const s of world.shapes) resolveOverlapCircle(p, s);
  if (world.superBoss) resolveOverlapCircle(p, world.superBoss);

  // aim from client camera/mouse
  p.angle = angleTo(p.x, p.y, camera.x + mouse.x, camera.y + mouse.y);

  // auto-fire
  p.fireCooldown -= DT;
  if (!p.dead && p.fireCooldown <= 0) {
    firePlayerBullets(p);
    p.fireCooldown = 250;
  }

  // drones/traps upkeep
  stepPlayerDrones(p);
  for (let i = p.traps.length - 1; i >= 0; i--) { if (p.traps[i].hp <= 0) p.traps.splice(i, 1); }
}
function firePlayerBullets(p) {
  if (!p.mainGunEnabled) return;
  const spread = p.precisionBattery ? 0.12 : 0.2;
  const startAngle = -(spread * (p.barrels - 1) / 2);
  for (let i = 0; i < p.barrels; i++) {
    const ang = p.angle + startAngle + i * spread;
    p.bullets.push({
      x: p.x + Math.cos(ang) * p.r,
      y: p.y + Math.sin(ang) * p.r,
      r: 5,
      dx: Math.cos(ang) * p.bulletSpeed,
      dy: Math.sin(ang) * p.bulletSpeed,
      damage: p.bulletDamage,
      owner: p.id,
      life: 1200
    });
  }
  if (p.sideSponsons) {
    const angs = [p.angle - Math.PI/2, p.angle + Math.PI/2];
    for (const ang of angs) {
      p.bullets.push({
        x: p.x + Math.cos(ang) * p.r,
        y: p.y + Math.sin(ang) * p.r,
        r: 4,
        dx: Math.cos(ang) * (p.bulletSpeed - 1),
        dy: Math.sin(ang) * (p.bulletSpeed - 1),
        damage: Math.max(4, Math.floor(p.bulletDamage * 0.6)),
        owner: p.id, life: 900
      });
    }
  }
}
function stepPlayerBullets(p) {
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    const b = p.bullets[i];
    b.x += b.dx; b.y += b.dy; b.life -= DT;
    if (b.life <= 0 || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) { p.bullets.splice(i, 1); continue; }

    // hit shapes
    let hit = false;
    for (let j = world.shapes.length - 1; j >= 0; j--) {
      const s = world.shapes[j];
      if (dist(b.x, b.y, s.x, s.y) <= b.r + s.r) {
        s.hp -= b.damage;
        addPopup(s.x, s.y - s.r - 20, b.damage, "orange", 900);
        p.bullets.splice(i, 1); hit = true;
        if (s.hp <= 0) { s.hp = 0; addXP(getPlayerById(b.owner), s.maxHp); world.shapes.splice(j, 1); }
        break;
      }
    }
    if (hit) continue;

    // hit boss
    const boss = world.boss;
    if (boss && boss.hp > 0 && dist(b.x, b.y, boss.x, boss.y) <= b.r + boss.r) {
      boss.hp -= b.damage; addPopup(boss.x, boss.y - boss.r - 20, b.damage, "white", 900);
      p.bullets.splice(i, 1); if (boss.hp <= 0) boss.hp = 0; continue;
    }

    // hit super boss (use top radius as main collider)
    const sb = world.superBoss;
    if (sb && sb.hp > 0 && dist(b.x, b.y, sb.x, sb.y) <= b.r + sb.rTop) {
      sb.hp -= b.damage; addPopup(sb.x, sb.y - sb.rTop - 20, b.damage, "#ff66ff", 900);
      p.bullets.splice(i, 1); if (sb.hp <= 0) sb.hp = 0; continue;
    }

    // hit super boss big drones
    const sb2 = world.superBoss;
    if (sb2 && sb2.bigDrones.length) {
      for (let k = sb2.bigDrones.length - 1; k >= 0; k--) {
        const d = sb2.bigDrones[k];
        if (dist(b.x, b.y, d.x, d.y) <= b.r + d.r) {
          d.hp -= b.damage; addPopup(d.x, d.y - d.r - 16, b.damage, "#ff99ff", 900);
          p.bullets.splice(i, 1); if (d.hp <= 0) sb2.bigDrones.splice(k, 1); hit = true; break;
        }
      }
      if (hit) continue;
    }

    // hit other players
    for (const [pid, other] of world.players) {
      if (pid === p.id || other.dead) continue;
      if (dist(b.x, b.y, other.x, other.y) <= b.r + other.r) {
        other.hp -= b.damage; addPopup(other.x, other.y - other.r - 20, b.damage, "white", 900);
        p.bullets.splice(i, 1); if (other.hp <= 0) killPlayer(other, p); break;
      }
    }
  }
}
function stepPlayerDrones(p) {
  if (p.path !== "drone") return;
  if (!p._droneTimer) p._droneTimer = Date.now();
  if (p.drones.length < p.maxDrones && Date.now() - p._droneTimer >= p.droneRespawn) {
    p._droneTimer = Date.now();
    p.drones.push({ x: p.x + rand(-40, 40), y: p.y + rand(-40, 40), r: 6, hp: 40 });
  }
  // orbit around player; guardian intercepts hostile bullets
  for (const d of p.drones) {
    const toP = angleTo(d.x, d.y, p.x, p.y);
    d.x += Math.cos(toP) * 1.6;
    d.y += Math.sin(toP) * 1.6;
    resolveOverlapCircle(d, p);
    for (const s of world.shapes) resolveOverlapCircle(d, s);
    if (p.droneGuardian) {
      let best = 280, targetBullet = null;
      const cands = [];
      if (world.boss) cands.push(...world.boss.bullets);
      if (world.superBoss) cands.push(...world.superBoss.bullets);
      for (const b of cands) {
        const d2 = dist(d.x, d.y, b.x, b.y);
        if (d2 < best) { best = d2; targetBullet = b; }
      }
      if (targetBullet) {
        const a = angleTo(d.x, d.y, targetBullet.x, targetBullet.y);
        d.x += Math.cos(a) * 1.5;
        d.y += Math.sin(a) * 1.5;
        if (dist(d.x, d.y, targetBullet.x, targetBullet.y) <= d.r + targetBullet.r) {
          targetBullet.life = 0;
          addPopup(targetBullet.x, targetBullet.y, "blocked", "#99ff99", 700);
        }
      }
    }
  }
}
function placeTrap(p) {
  const now = Date.now();
  if (!p.trapLayer || p.traps.length >= p.trapMax || now < p.nextTrapTime) return;
  p.nextTrapTime = now + p.trapCooldown;
  const r = 12, hp = 60;
  const t = {
    x: p.x + Math.cos(p.angle) * (p.r + 20),
    y: p.y + Math.sin(p.angle) * (p.r + 20),
    r, hp
  };
  t.x = clamp(t.x, r, MAP_W - r);
  t.y = clamp(t.y, r, MAP_H - r);
  if (world.superBoss) resolveOverlapCircle(t, world.superBoss);
  for (const s of world.shapes) resolveOverlapCircle(t, s);
  for (const pl of world.players.values()) resolveOverlapCircle(t, pl);
  p.traps.push(t);
}

/* ===== Kill & respawn ===== */
function killPlayer(p, killer) {
  p.dead = true;
  p.hp = 0;
  p.bullets.length = 0;
  p.drones.length = 0;
  p.traps.length = 0;
  if (killer) addXP(killer, Math.max(50, Math.floor(p.level * 50)));
}
function respawnPlayer(p) {
  const fresh = makePlayer(p.id);
  world.players.set(p.id, fresh);
}

/* ===== Snapshot ===== */
function buildSnapshot() {
  return {
    mapWidth: world.mapWidth,
    mapHeight: world.mapHeight,
    players: Array.from(world.players.values()).map(p => ({
      id: p.id, x: p.x, y: p.y, r: p.r, angle: p.angle,
      hp: p.hp, maxHp: p.maxHp, xp: p.xp, level: p.level, dead: p.dead,
      path: p.path, mainGunEnabled: p.mainGunEnabled,
      barrels: p.barrels, bullets: p.bullets,
      traps: p.traps, trapLayer: p.trapLayer, trapMax: p.trapMax, nextTrapTime: p.nextTrapTime,
      drones: p.drones,
      precisionBattery: p.precisionBattery,
      sideSponsons: p.sideSponsons
    })),
    boss: world.boss,
    superBoss: world.superBoss,
    shapes: world.shapes,
    damagePopups: world.damagePopups.splice(0),
    prompt: Array.from(world.players.values()).find(p => p._prompt)?._prompt || null,
    gameOver: false
  };
}

/* ===== Tick ===== */
function tick() {
  try {
    // players
    for (const p of world.players.values()) {
      if (!p.dead) {
        updatePlayer(p);
        stepPlayerBullets(p);
      }
    }

    // shapes: harmless float
    stepShapes();

    // bosses
    stepBoss(world.boss);
    stepSuperBoss(world.superBoss);

    // maintain shape count
    if (world.shapes.length < 120) {
      for (let i = world.shapes.length; i < 140; i++) {
        const tRoll = Math.random();
        const type = tRoll < 0.55 ? "square" : tRoll < 0.85 ? "triangle" : "pentagon";
        const base = type === "square" ? { r: 18, hp: 30 }
                   : type === "triangle" ? { r: 22, hp: 60 }
                   : { r: 26, hp: 120 };
        const speed = rand(0.4, 0.9);
        const ang = rand(0, Math.PI * 2);
        world.shapes.push({
          id: "shape_re_" + Math.random().toString(36).slice(2),
          type, variant: null,
          x: rand(200, MAP_W - 200), y: rand(200, MAP_H - 200),
          r: base.r, hp: base.hp, maxHp: base.hp,
          angle: ang, speed, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
          driftTimer: rand(800, 1800)
        });
      }
    }

    // emit & clear prompts
    io.emit("state", buildSnapshot());
    for (const p of world.players.values()) p._prompt = null;
  } catch (e) {
    console.error("Tick error:", e);
  }
}

/* ===== Sockets ===== */
io.on("connection", socket => {
  const p = makePlayer(socket.id);
  world.players.set(socket.id, p);

  socket.on("input", payload => {
    const me = world.players.get(socket.id);
    if (!me) return;
    if (payload && payload.keys && payload.mouse && payload.camera) me.input = payload;
  });

  socket.on("switchPath", key => {
    const me = world.players.get(socket.id);
    if (!me || me.dead) return;
    if (!["multi","big","drone","trap"].includes(key)) return;
    applyPath(me, key);
  });

  socket.on("applyUpgrade", key => {
    const me = world.players.get(socket.id);
    if (!me || me.dead) return;
    applySubUpgrade(me, key);
  });

  socket.on("tryPlaceTrap", () => {
    const me = world.players.get(socket.id);
    if (!me || me.dead) return;
    placeTrap(me);
  });

  socket.on("respawn", () => {
    const me = world.players.get(socket.id);
    if (!me) return;
    respawnPlayer(me);
  });

  socket.on("disconnect", () => {
    world.players.delete(socket.id);
  });
});

/* ===== Boot ===== */
spawnShapes(200);
spawnBoss();        // optional
spawnSuperBoss();

server.listen(process.env.PORT || 3000, () => {
  console.log("Server listening on port", server.address().port);
});
setInterval(tick, DT);

/* ===== Helper ===== */
function getPlayerById(id) { return world.players.get(id); }
