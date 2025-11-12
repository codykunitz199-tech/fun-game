/* server.js — Restored full gameplay */
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

/* Optional homepage so you don’t see “Cannot GET /” */
app.get("/", (req, res) => res.send("Game server is running. Connect via your client."));

/* ===== Constants ===== */
const TICK_RATE = 30; // Hz
const DT = 1000 / TICK_RATE; // ms
const MAP_W = 7200, MAP_H = 5400;

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

/* ===== Utils ===== */
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const rand = (a, b) => a + Math.random() * (b - a);
const rngSign = () => (Math.random() < 0.5 ? -1 : 1);
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
const angleTo = (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax);
function addPopup(x, y, text, color = "white", duration = 900) {
  world.damagePopups.push({ x, y, text: String(text), color, duration });
}

/* ===== Players ===== */
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

    // firing
    mainGunEnabled: true,
    barrels: 1,
    bulletSpeed: 8,
    bulletDamage: 10,
    fireCooldown: 0,
    bullets: [],

    // paths & flags
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

/* ===== Shapes (mobs) ===== */
function spawnShapes(n = 180) {
  world.shapes = [];
  for (let i = 0; i < n; i++) {
    const typeRoll = Math.random();
    const type = typeRoll < 0.5 ? "square" : typeRoll < 0.8 ? "triangle" : "pentagon";
    const base = type === "square" ? { r: 18, hp: 30, speed: 1.1 }
               : type === "triangle" ? { r: 22, hp: 60, speed: 1.5 }
               : { r: 26, hp: 120, speed: 0.9 };
    world.shapes.push({
      id: "mob_" + i + "_" + Date.now(),
      type,
      variant: Math.random() < 0.03 ? "beta" : Math.random() < 0.01 ? "aptha" : null,
      x: rand(200, MAP_W - 200),
      y: rand(200, MAP_H - 200),
      r: base.r,
      hp: base.hp,
      maxHp: base.hp,
      angle: rand(0, Math.PI * 2),
      speed: base.speed,
      vx: rand(-0.5, 0.5),
      vy: rand(-0.5, 0.5),
      aiTimer: rand(300, 1200)
    });
  }
}

function stepShapes() {
  for (const s of world.shapes) {
    // basic AI: wander, occasionally seek nearest player if close
    s.aiTimer -= DT;
    if (s.aiTimer <= 0) {
      s.aiTimer = rand(400, 1400);
      // 40% chance re-randomize, 60% chance seek nearest player if within 600 px
      if (Math.random() < 0.4) {
        s.vx = rand(-1, 1) * s.speed;
        s.vy = rand(-1, 1) * s.speed;
      } else {
        let near = null, best = 600;
        for (const p of world.players.values()) {
          if (p.dead) continue;
          const d = dist(s.x, s.y, p.x, p.y);
          if (d < best) { best = d; near = p; }
        }
        if (near) {
          const ang = angleTo(s.x, s.y, near.x, near.y);
          s.vx = Math.cos(ang) * s.speed;
          s.vy = Math.sin(ang) * s.speed;
          s.angle = ang;
        }
      }
    }
    s.x += s.vx;
    s.y += s.vy;
    if (s.x <= s.r || s.x >= MAP_W - s.r) s.vx *= -1;
    if (s.y <= s.r || s.y >= MAP_H - s.r) s.vy *= -1;
    s.x = clamp(s.x, s.r, MAP_W - s.r);
    s.y = clamp(s.y, s.r, MAP_H - s.r);
  }
}

/* ===== Bosses ===== */
function spawnBoss() {
  world.boss = {
    x: MAP_W/2 - 500, y: MAP_H/2 - 300, r: 80,
    angle: 0, hp: 2200, maxHp: 2200,
    bullets: [],
    fireTimer: 0,
    vx: 0.6 * rngSign(), vy: 0.5 * rngSign()
  };
}

function stepBoss(boss) {
  if (!boss || boss.hp <= 0) return;
  boss.angle += 0.01;
  boss.x += boss.vx; boss.y += boss.vy;
  if (boss.x <= boss.r || boss.x >= MAP_W - boss.r) boss.vx *= -1;
  if (boss.y <= boss.r || boss.y >= MAP_H - boss.r) boss.vy *= -1;

  boss.fireTimer += DT;
  if (boss.fireTimer >= 800) {
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
      for (let i = -0.15; i <= 0.15; i += 0.15) {
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
  // bullets move and hit players
  for (let i = boss.bullets.length - 1; i >= 0; i--) {
    const b = boss.bullets[i];
    b.x += b.dx; b.y += b.dy; b.life -= DT;
    if (b.life <= 0 || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) { boss.bullets.splice(i, 1); continue; }
    for (const p of world.players.values()) {
      if (p.dead) continue;
      if (dist(b.x, b.y, p.x, p.y) <= b.r + p.r) {
        p.hp -= b.damage;
        addPopup(p.x, p.y - p.r - 20, b.damage, "white", 1000);
        boss.bullets.splice(i, 1);
        if (p.hp <= 0) killPlayer(p, null);
        break;
      }
    }
  }
}

function spawnSuperBoss() {
  world.superBoss = {
    x: MAP_W/2 + 700, y: MAP_H/2 + 300,
    rBottom: 120, rMiddle: 90, rTop: 60,
    angleBottom: 0, angleMiddle: 0, angleTop: 0,
    hp: 9000, maxHp: 9000,
    bullets: [],
    drones: [],
    fireTimerBottom: 0,
    fireTimerMiddle: 0,
    fireTimerTop: 0,
    droneTimer: 0,
    vx: 0.4 * rngSign(), vy: 0.35 * rngSign()
  };
}

function stepSuperBoss(sb) {
  if (!sb || sb.hp <= 0) return;
  // movement
  sb.x += sb.vx; sb.y += sb.vy;
  if (sb.x <= sb.rBottom || sb.x >= MAP_W - sb.rBottom) sb.vx *= -1;
  if (sb.y <= sb.rBottom || sb.y >= MAP_H - sb.rBottom) sb.vy *= -1;

  // ring rotations (different directions/speeds)
  sb.angleBottom += 0.006;       // clockwise slow
  sb.angleMiddle -= 0.011;       // counter-clockwise medium
  sb.angleTop += 0.019;          // clockwise fast

  // bottom cannons: targeted volleys
  sb.fireTimerBottom += DT;
  if (sb.fireTimerBottom >= 900) {
    sb.fireTimerBottom = 0;
    let target = null, best = Infinity;
    for (const p of world.players.values()) {
      if (p.dead) continue;
      const d = dist(sb.x, sb.y, p.x, p.y);
      if (d < best) { best = d; target = p; }
    }
    if (target) {
      const baseAng = angleTo(sb.x, sb.y, target.x, target.y);
      for (let i = 0; i < 6; i++) {
        const a = baseAng + (i - 2.5) * 0.06;
        sb.bullets.push({
          x: sb.x + Math.cos(a) * sb.rBottom,
          y: sb.y + Math.sin(a) * sb.rBottom,
          r: 7, dx: Math.cos(a) * 7.2, dy: Math.sin(a) * 7.2,
          damage: 10, life: 1700
        });
      }
    }
  }

  // middle ring: radial bursts
  sb.fireTimerMiddle += DT;
  if (sb.fireTimerMiddle >= 700) {
    sb.fireTimerMiddle = 0;
    for (let i = 0; i < 14; i++) {
      const a = sb.angleMiddle + i * (Math.PI * 2 / 14);
      sb.bullets.push({
        x: sb.x + Math.cos(a) * sb.rMiddle,
        y: sb.y + Math.sin(a) * sb.rMiddle,
        r: 6, dx: Math.cos(a) * 6.5, dy: Math.sin(a) * 6.5,
        damage: 8, life: 1500
      });
    }
  }

  // top ring: quick snaps toward nearest player, lower damage
  sb.fireTimerTop += DT;
  if (sb.fireTimerTop >= 500) {
    sb.fireTimerTop = 0;
    let target = null, best = Infinity;
    for (const p of world.players.values()) {
      if (p.dead) continue;
      const d = dist(sb.x, sb.y, p.x, p.y);
      if (d < best) { best = d; target = p; }
    }
    if (target) {
      const a = angleTo(sb.x, sb.y, target.x, target.y) + rand(-0.08, 0.08);
      for (let i = 0; i < 6; i++) {
        const ang = a + i * 0.02;
        sb.bullets.push({
          x: sb.x + Math.cos(ang) * sb.rTop,
          y: sb.y + Math.sin(ang) * sb.rTop,
          r: 5, dx: Math.cos(ang) * 6, dy: Math.sin(ang) * 6,
          damage: 6, life: 1300
        });
      }
    }
  }

  // drones: orbit + chase bursts toward players
  sb.droneTimer += DT;
  if (sb.droneTimer >= 1400 && sb.drones.length < 12) {
    sb.droneTimer = 0;
    const ang = rand(0, Math.PI * 2);
    sb.drones.push({
      x: sb.x + Math.cos(ang) * (sb.rMiddle + 40),
      y: sb.y + Math.sin(ang) * (sb.rMiddle + 40),
      r: 8,
      vx: 0, vy: 0,
      ai: { state: "orbit", timer: 600 }
    });
  }
  for (const d of sb.drones) {
    d.ai.timer -= DT;
    const aOrbit = angleTo(d.x, d.y, sb.x, sb.y) + Math.PI / 2; // orbit tangent
    if (d.ai.state === "orbit") {
      d.vx = Math.cos(aOrbit) * 2.2;
      d.vy = Math.sin(aOrbit) * 2.2;
      if (d.ai.timer <= 0) { d.ai.state = "burst"; d.ai.timer = 500; }
    } else {
      // burst towards nearest player then return to orbit
      let target = null, best = 800;
      for (const p of world.players.values()) {
        if (p.dead) continue;
        const d2 = dist(d.x, d.y, p.x, p.y);
        if (d2 < best) { best = d2; target = p; }
      }
      const aim = target ? angleTo(d.x, d.y, target.x, target.y) : aOrbit;
      d.vx = Math.cos(aim) * 3.2;
      d.vy = Math.sin(aim) * 3.2;
      if (d.ai.timer <= 0) { d.ai.state = "orbit"; d.ai.timer = 800; }
    }
    d.x += d.vx; d.y += d.vy;
    // hit players
    for (const p of world.players.values()) {
      if (p.dead) continue;
      if (dist(d.x, d.y, p.x, p.y) <= d.r + p.r) {
        p.hp -= 4;
        addPopup(p.x, p.y - p.r - 20, 4, "#ff66ff", 900);
        // small knockback
        const a = angleTo(sb.x, sb.y, p.x, p.y);
        p.x += Math.cos(a) * 3;
        p.y += Math.sin(a) * 3;
        if (p.hp <= 0) killPlayer(p, null);
      }
    }
  }

  // bullets move + hit players
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
}

/* ===== XP & Leveling ===== */
function addXP(p, amount) {
  if (!p) return;
  p.xp += amount;
  const thresholds = [0, 100, 250, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400, 6500];
  while (p.level < 12 && p.xp >= thresholds[p.level]) {
    p.level++;
    checkLevelMilestones(p);
  }
}

function checkLevelMilestones(p) {
  if (p.level === 3 && !p.path) {
    p._prompt = { type: "path" };
  } else if ([6, 9, 12].includes(p.level)) {
    p._prompt = { type: "subUpgrade", level: p.level };
  }
}

/* ===== Upgrades ===== */
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
    /* drones */
    case "droneKamikazeBoost": p.bulletDamage += 4; break;
    case "droneGuardian": p.droneGuardian = true; break;
    case "droneShooter": p.maxDrones = Math.max(p.maxDrones, 8); p.droneRespawn = 2400; break;
    case "hiveExpansion": p.maxDrones = Math.max(p.maxDrones, 15); break;
    case "armoredDrones": /* keep in future */ break;
    case "snareDrones": /* keep in future */ break;
    case "droneCommander": p.maxDrones = Math.max(p.maxDrones, 20); p.droneRespawn = 1800; break;
    case "explosiveDrones": /* AoE future */ break;
    case "hybridDrones": p.droneRespawn = 2200; break;

    /* multi */
    case "alternatingFire": /* cadence future */ break;
    case "rotaryTurret": /* client visual future */ break;
    case "sideSponsons": p.sideSponsons = true; break;
    case "scattershot": /* spread future */ break;
    case "quadCore": p.barrels += 1; break;
    case "artillery": p.bulletSpeed = Math.max(6, p.bulletSpeed - 1); p.bulletDamage += 2; break;
    case "wallOfLead": p.barrels += 2; p.bulletDamage = Math.max(4, Math.floor(p.bulletDamage * 0.67)); break;
    case "precisionBattery": p.precisionBattery = true; break;
    case "piercingShells": /* pierce future */ break;

    /* big */
    case "dualBig": p.barrels = Math.max(p.barrels, 2); break;
    case "megaBullet": p.bulletDamage += 8; break;
    case "impactExplosive": /* splash future */ break;
    case "clusterBomb": /* split future */ break;
    case "siegeMode": p.speed = Math.max(2, p.speed - 1); p.bulletDamage += 6; break;
    case "titanShell": p.bulletDamage += 12; p.bulletSpeed = Math.max(5, p.bulletSpeed - 1); break;
    case "twinSiege": p.barrels = Math.max(p.barrels, 2); p.bulletDamage += 6; break;
    case "shockwaveRound": /* knockback future */ break;

    /* traps */
    case "trapDoubleLayer": p.trapMax = Math.max(p.trapMax, 7); break;
    case "trapBig": /* applied on placement path */ break;
    case "trapQuad": p.trapMax = Math.max(p.trapMax, 9); break;
    case "trapHuge": p.trapMax = Math.max(p.trapMax, 6); break;
    case "trapCluster": /* behavior future */ break;
    case "trapSentry": /* behavior future */ break;
  }
}

/* ===== Player runtime ===== */
function updatePlayer(p) {
  const { keys, mouse, camera } = p.input;
  const sp = p.speed;
  if (keys.w) p.y -= sp;
  if (keys.s) p.y += sp;
  if (keys.a) p.x -= sp;
  if (keys.d) p.x += sp;
  p.x = clamp(p.x, p.r, MAP_W - p.r);
  p.y = clamp(p.y, p.r, MAP_H - p.r);

  // aim based on client camera/mouse (world coords derived by client)
  p.angle = angleTo(p.x, p.y, camera.x + mouse.x, camera.y + mouse.y);

  // auto-fire
  p.fireCooldown -= DT;
  if (!p.dead && p.fireCooldown <= 0) {
    firePlayerBullets(p);
    p.fireCooldown = 250;
  }

  // drones maintenance
  stepPlayerDrones(p);

  // traps upkeep
  for (let i = p.traps.length - 1; i >= 0; i--) {
    const t = p.traps[i];
    if (t.hp <= 0) p.traps.splice(i, 1);
  }
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
        owner: p.id,
        life: 900
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
        addPopup(s.x, s.y - s.r - 20, b.damage, "orange", 950);
        p.bullets.splice(i, 1); hit = true;
        if (s.hp <= 0) {
          s.hp = 0;
          addXP(getPlayerById(b.owner), s.maxHp);
          world.shapes.splice(j, 1);
        }
        break;
      }
    }
    if (hit) continue;

    // hit boss
    const boss = world.boss;
    if (boss && boss.hp > 0 && dist(b.x, b.y, boss.x, boss.y) <= b.r + boss.r) {
      boss.hp -= b.damage;
      addPopup(boss.x, boss.y - boss.r - 20, b.damage, "white", 950);
      p.bullets.splice(i, 1);
      if (boss.hp <= 0) boss.hp = 0;
      continue;
    }

    // hit super boss (top ring collision radius)
    const sb = world.superBoss;
    if (sb && sb.hp > 0 && dist(b.x, b.y, sb.x, sb.y) <= b.r + sb.rTop) {
      sb.hp -= b.damage;
      addPopup(sb.x, sb.y - sb.rTop - 20, b.damage, "#ff66ff", 950);
      p.bullets.splice(i, 1);
      if (sb.hp <= 0) sb.hp = 0;
      continue;
    }

    // hit super boss drones
    const sb2 = world.superBoss;
    if (sb2 && sb2.drones.length) {
      for (let k = sb2.drones.length - 1; k >= 0; k--) {
        const d = sb2.drones[k];
        if (dist(b.x, b.y, d.x, d.y) <= b.r + d.r) {
          // drones have small health pool
          addPopup(d.x, d.y - d.r - 16, b.damage, "#ff99ff", 900);
          sb2.drones.splice(k, 1);
          p.bullets.splice(i, 1);
          hit = true;
          break;
        }
      }
      if (hit) continue;
    }

    // hit other players (PvP)
    for (const [pid, other] of world.players) {
      if (pid === p.id || other.dead) continue;
      if (dist(b.x, b.y, other.x, other.y) <= b.r + other.r) {
        other.hp -= b.damage;
        addPopup(other.x, other.y - other.r - 20, b.damage, "white", 950);
        p.bullets.splice(i, 1);
        if (other.hp <= 0) killPlayer(other, p);
        break;
      }
    }
  }
}

function stepPlayerDrones(p) {
  if (p.path !== "drone") return;
  if (!p._droneTimer) p._droneTimer = Date.now();
  if (p.drones.length < p.maxDrones && Date.now() - p._droneTimer >= p.droneRespawn) {
    p._droneTimer = Date.now();
    p.drones.push({ x: p.x + rand(-40, 40), y: p.y + rand(-40, 40), r: 6 });
  }
  // orbit around player, simple intercept if guardian
  for (const d of p.drones) {
    const toP = angleTo(d.x, d.y, p.x, p.y);
    d.x += Math.cos(toP) * 1.6;
    d.y += Math.sin(toP) * 1.6;
    if (p.droneGuardian) {
      // nudge towards nearest hostile bullet (boss/super)
      let targetBullet = null, best = 300;
      const candidates = [];
      if (world.boss) candidates.push(...world.boss.bullets);
      if (world.superBoss) candidates.push(...world.superBoss.bullets);
      for (const b of candidates) {
        const d2 = dist(d.x, d.y, b.x, b.y);
        if (d2 < best) { best = d2; targetBullet = b; }
      }
      if (targetBullet) {
        const a = angleTo(d.x, d.y, targetBullet.x, targetBullet.y);
        d.x += Math.cos(a) * 1.8;
        d.y += Math.sin(a) * 1.8;
        // intercept
        if (dist(d.x, d.y, targetBullet.x, targetBullet.y) <= d.r + targetBullet.r) {
          targetBullet.life = 0; // delete by life in boss step
        }
      }
    }
  }
}

/* ===== Traps ===== */
function placeTrap(p) {
  const now = Date.now();
  if (!p.trapLayer) return;
  if (p.traps.length >= p.trapMax) return;
  if (now < p.nextTrapTime) return;
  p.nextTrapTime = now + p.trapCooldown;

  const hp = 60, r = 12;
  p.traps.push({
    x: p.x + Math.cos(p.angle) * (p.r + 20),
    y: p.y + Math.sin(p.angle) * (p.r + 20),
    r, hp, cluster: false, sentry: false
  });
}

/* ===== Death & respawn ===== */
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
  // optional: keep xp/level; here reset for simplicity
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

    // mobs
    stepShapes();

    // bosses
    stepBoss(world.boss);
    stepSuperBoss(world.superBoss);

    // clean up out-of-range shapes; respawn if low
    if (world.shapes.length < 100) {
      for (let i = world.shapes.length; i < 120; i++) {
        const tRoll = Math.random();
        const type = tRoll < 0.55 ? "square" : tRoll < 0.85 ? "triangle" : "pentagon";
        const base = type === "square" ? { r: 18, hp: 30, speed: 1.1 }
                   : type === "triangle" ? { r: 22, hp: 60, speed: 1.5 }
                   : { r: 26, hp: 120, speed: 0.9 };
        world.shapes.push({
          id: "mob2_" + Math.random().toString(36).slice(2),
          type, variant: null,
          x: rand(200, MAP_W - 200), y: rand(200, MAP_H - 200),
          r: base.r, hp: base.hp, maxHp: base.hp, angle: rand(0, Math.PI * 2),
          speed: base.speed, vx: rand(-0.5, 0.5), vy: rand(-0.5, 0.5), aiTimer: rand(300, 1200)
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

/* ===== Startup ===== */
spawnShapes(180);
spawnBoss();
spawnSuperBoss();

server.listen(process.env.PORT || 3000, () => {
  console.log("Server listening on port", server.address().port);
});
setInterval(tick, DT);

/* ===== Helper ===== */
function getPlayerById(id) { return world.players.get(id); }

