/* server.js */
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const TICK_RATE = 30; // Hz
const MAP_W = 7200, MAP_H = 5400;

/* ===== World state ===== */
const world = {
  mapWidth: MAP_W,
  mapHeight: MAP_H,
  players: new Map(), // id -> player
  shapes: [],
  boss: null,
  superBoss: null,
  damagePopups: [], // drained to client each tick
};

/* ===== Utility ===== */
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }
function angleTo(ax, ay, bx, by) { return Math.atan2(by - ay, bx - ax); }
function dist(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return Math.hypot(dx, dy); }
function addDamagePopup(x, y, text, color = "white", duration = 1000) {
  world.damagePopups.push({ x, y, text: String(text), color, duration });
}

/* ===== Player factory ===== */
function makeDefaultPlayer(id) {
  return {
    id,
    x: rand(100, MAP_W - 100),
    y: rand(100, MAP_H - 100),
    r: 20,
    angle: 0,
    speed: 3,
    hp: 100,
    maxHp: 100,
    xp: 0,
    level: 1,
    dead: false,

    // firing
    fireCooldown: 0,
    mainGunEnabled: true,
    barrels: 1,
    bulletSpeed: 8,
    bulletDamage: 10,
    bullets: [],

    // path & upgrades
    path: null, // "multi" | "big" | "drone" | "trap"
    // flags for upgrades
    precisionBattery: false,
    sideSponsons: false,

    // drones
    drones: [],
    maxDrones: 0,
    droneRespawn: 3000, // ms
    droneGuardian: false,

    // traps
    traps: [],
    trapLayer: false,
    trapMax: 0,
    nextTrapTime: 0,
    trapCooldown: 2500,

    // prompt for client
    _prompt: null,

    // inputs
    input: { keys: { w:false,a:false,s:false,d:false }, mouse: { x:0,y:0 }, camera: { x:0,y:0 } }
  };
}

/* ===== Shapes / Boss setup ===== */
function spawnShapes(count = 150) {
  world.shapes = [];
  const types = ["square", "triangle", "pentagon"];
  for (let i = 0; i < count; i++) {
    const type = types[Math.floor(rand(0, types.length))];
    const r = type === "square" ? 20 : type === "triangle" ? 24 : 28;
    const hp = type === "square" ? 30 : type === "triangle" ? 60 : 120;
    world.shapes.push({
      id: "s" + i + "_" + Date.now(),
      type,
      variant: Math.random() < 0.05 ? "beta" : Math.random() < 0.02 ? "aptha" : null,
      x: rand(200, MAP_W - 200),
      y: rand(200, MAP_H - 200),
      r,
      hp,
      maxHp: hp,
      angle: rand(0, Math.PI * 2),
    });
  }
}

function spawnBoss() {
  world.boss = {
    x: MAP_W/2, y: MAP_H/2, r: 80,
    angle: 0, hp: 2000, maxHp: 2000,
    bullets: [],
    fireTimer: 0
  };
}

function spawnSuperBoss() {
  world.superBoss = {
    x: MAP_W/2 + 800, y: MAP_H/2 + 400,
    rBottom: 120, rMiddle: 90, rTop: 60,
    angleBottom: 0, angleMiddle: 0, angleTop: 0,
    hp: 8000, maxHp: 8000,
    bullets: [],
    drones: [],
    fireTimer: 0
  };
}

/* ===== Leveling & prompts ===== */
function addXP(p, amount) {
  p.xp += amount;
  // Simple level thresholds (tweak as needed)
  const thresholds = [0, 100, 250, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400, 6500];
  while (p.level < 12 && p.xp >= thresholds[p.level]) {
    p.level++;
    checkLevelMilestones(p);
  }
}

function checkLevelMilestones(p) {
  if (p.level === 3 && !p.path) {
    p._prompt = { type: "path" };
  } else if ([6,9,12].includes(p.level)) {
    p._prompt = { type: "subUpgrade", level: p.level };
  }
}

/* ===== Upgrades application ===== */
function applyPath(p, path) {
  p.path = path;
  if (path === "multi") {
    p.barrels = 3;
    p.bulletDamage = 6;
  } else if (path === "big") {
    p.barrels = 1;
    p.bulletDamage = 24;
    p.bulletSpeed = 7;
  } else if (path === "drone") {
    p.maxDrones = 6;
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
    case "droneShooter": p.maxDrones = Math.max(p.maxDrones, 8); p.droneRespawn = 2500; break;
    case "hiveExpansion": p.maxDrones = Math.max(p.maxDrones, 15); break;
    case "armoredDrones": /* visual/logic left simple */ break;
    case "snareDrones": /* slow effect potential */ break;
    case "droneCommander": p.maxDrones = Math.max(p.maxDrones, 20); p.droneRespawn = 1800; break;
    case "explosiveDrones": /* AoE on death potential */ break;
    case "hybridDrones": p.droneRespawn = 2200; break;

    /* multi */
    case "alternatingFire": /* cadence tweak */ break;
    case "rotaryTurret": /* barrel rotation (client visual) */ break;
    case "sideSponsons": p.sideSponsons = true; break;
    case "scattershot": /* spread tweak */ break;
    case "quadCore": p.barrels += 1; break;
    case "artillery": p.bulletSpeed = Math.max(6, p.bulletSpeed - 1); p.bulletDamage += 2; break;
    case "wallOfLead": p.barrels += 2; p.bulletDamage = Math.max(4, Math.floor(p.bulletDamage * 0.67)); break;
    case "precisionBattery": p.precisionBattery = true; break;
    case "piercingShells": /* pierce potential */ break;

    /* big */
    case "dualBig": p.barrels = 2; break;
    case "megaBullet": p.bulletDamage += 8; break;
    case "impactExplosive": /* splash potential */ break;
    case "clusterBomb": /* split potential */ break;
    case "siegeMode": p.speed = Math.max(2, p.speed - 1); p.bulletDamage += 6; break;
    case "titanShell": p.bulletDamage += 12; p.bulletSpeed = Math.max(5, p.bulletSpeed - 1); break;
    case "twinSiege": p.barrels = Math.max(p.barrels, 2); p.bulletDamage += 6; break;
    case "shockwaveRound": /* knockback */ break;

    /* traps */
    case "trapDoubleLayer": p.trapMax = Math.max(p.trapMax, 7); break;
    case "trapBig": /* larger trap stats applied on placement */ break;
    case "trapQuad": p.trapMax = Math.max(p.trapMax, 9); break;
    case "trapHuge": p.trapMax = Math.max(p.trapMax, 6); break;
    case "trapCluster": /* special trap behavior */ break;
    case "trapSentry": /* sentry behavior flag applied on placement */ break;
    default: break;
  }
}

/* ===== Movement & combat ===== */
function updatePlayerInputs(p) {
  const { keys, mouse } = p.input;
  const speed = p.speed;
  if (keys.w) p.y -= speed;
  if (keys.s) p.y += speed;
  if (keys.a) p.x -= speed;
  if (keys.d) p.x += speed;

  p.x = clamp(p.x, p.r, MAP_W - p.r);
  p.y = clamp(p.y, p.r, MAP_H - p.r);

  const cx = p.x - p.input.camera.x;
  const cy = p.y - p.input.camera.y;
  // aim towards mouse in world coordinates
  p.angle = angleTo(p.x, p.y, p.input.camera.x + mouse.x, p.input.camera.y + mouse.y);

  // fire simple automatic shots
  if (!p.dead) {
    p.fireCooldown -= 1000 / TICK_RATE;
    if (p.fireCooldown <= 0) {
      firePlayerBullets(p);
      p.fireCooldown = 250; // ms between shots; tweak per path/upgrades
    }
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
      life: 1200 // ms
    });
  }
  if (p.sideSponsons) {
    const angLeft = p.angle - Math.PI / 2;
    const angRight = p.angle + Math.PI / 2;
    for (const ang of [angLeft, angRight]) {
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

function stepBullets(p) {
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    const b = p.bullets[i];
    b.x += b.dx; b.y += b.dy;
    b.life -= 1000 / TICK_RATE;
    if (b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H || b.life <= 0) {
      p.bullets.splice(i, 1); continue;
    }
    // collide with shapes
    for (let j = world.shapes.length - 1; j >= 0; j--) {
      const s = world.shapes[j];
      const d = dist(b.x, b.y, s.x, s.y);
      if (d <= b.r + s.r) {
        s.hp -= b.damage;
        addDamagePopup(s.x, s.y - s.r - 20, b.damage, "orange", 1000);
        p.bullets.splice(i, 1);
        if (s.hp <= 0) {
          addXP(getPlayerById(b.owner), s.maxHp);
          world.shapes.splice(j, 1);
        }
        break;
      }
    }
    // collide with boss
    const boss = world.boss;
    if (boss && boss.hp > 0) {
      const d = dist(b.x, b.y, boss.x, boss.y);
      if (d <= b.r + boss.r) {
        boss.hp -= b.damage;
        addDamagePopup(boss.x, boss.y - boss.r - 20, b.damage, "white", 1000);
        p.bullets.splice(i, 1);
      }
    }
    // collide with super boss
    const sb = world.superBoss;
    if (sb && sb.hp > 0) {
      const d = dist(b.x, b.y, sb.x, sb.y);
      if (d <= b.r + sb.rTop) {
        sb.hp -= b.damage;
        addDamagePopup(sb.x, sb.y - sb.rTop - 20, b.damage, "#ff66ff", 1000);
        p.bullets.splice(i, 1);
      }
    }
    // collide with other players (PvP)
    for (const [pid, other] of world.players) {
      if (pid === p.id || other.dead) continue;
      const d2 = dist(b.x, b.y, other.x, other.y);
      if (d2 <= b.r + other.r) {
        other.hp -= b.damage;
        addDamagePopup(other.x, other.y - other.r - 20, b.damage, "white", 1000);
        p.bullets.splice(i, 1);
        if (other.hp <= 0) killPlayer(other, p);
        break;
      }
    }
  }
}

/* ===== Drones & traps (simplified runtime) ===== */
function stepDrones(p) {
  // maintain drone count
  if (p.path === "drone" && p.maxDrones > 0) {
    // respawn placeholder drones over time
    if (!p._droneTimer) p._droneTimer = Date.now();
    if (Date.now() - p._droneTimer >= p.droneRespawn && p.drones.length < p.maxDrones) {
      p._droneTimer = Date.now();
      p.drones.push({ x: p.x + rand(-40, 40), y: p.y + rand(-40, 40), r: 6 });
    }
    // orbit around player
    for (let i = 0; i < p.drones.length; i++) {
      const d = p.drones[i];
      const ang = angleTo(d.x, d.y, p.x, p.y);
      d.x += Math.cos(ang) * 1.5;
      d.y += Math.sin(ang) * 1.5;
    }
  }
}

function stepTraps(p) {
  // traps are static; cooldown managed on placement
  for (let i = p.traps.length - 1; i >= 0; i--) {
    const t = p.traps[i];
    // basic decay or damage handling left simple
    if (t.hp <= 0) p.traps.splice(i, 1);
  }
}

/* ===== Boss logic (simple) ===== */
function stepBoss(boss) {
  if (!boss || boss.hp <= 0) return;
  boss.angle += 0.01;
  boss.fireTimer += 1000 / TICK_RATE;
  if (boss.fireTimer >= 800) {
    boss.fireTimer = 0;
    // fire towards nearest player
    let nearest = null, best = Infinity;
    for (const p of world.players.values()) {
      if (p.dead) continue;
      const d = dist(boss.x, boss.y, p.x, p.y);
      if (d < best) { best = d; nearest = p; }
    }
    if (nearest) {
      const ang = angleTo(boss.x, boss.y, nearest.x, nearest.y);
      boss.bullets.push({
        x: boss.x + Math.cos(ang) * boss.r,
        y: boss.y + Math.sin(ang) * boss.r,
        r: 7, dx: Math.cos(ang) * 7, dy: Math.sin(ang) * 7,
        damage: 10, life: 1600
      });
    }
  }
  // move bullets
  for (let i = boss.bullets.length - 1; i >= 0; i--) {
    const b = boss.bullets[i];
    b.x += b.dx; b.y += b.dy; b.life -= 1000 / TICK_RATE;
    if (b.life <= 0 || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) { boss.bullets.splice(i, 1); continue; }
    for (const p of world.players.values()) {
      if (p.dead) continue;
      if (dist(b.x, b.y, p.x, p.y) <= b.r + p.r) {
        p.hp -= b.damage;
        addDamagePopup(p.x, p.y - p.r - 20, b.damage, "white", 1000);
        boss.bullets.splice(i, 1);
        if (p.hp <= 0) killPlayer(p, null);
        break;
      }
    }
  }
}

function stepSuperBoss(sb) {
  if (!sb || sb.hp <= 0) return;
  sb.angleBottom += 0.008;
  sb.angleMiddle += 0.013;
  sb.angleTop += 0.02;
  sb.fireTimer += 1000 / TICK_RATE;
  if (sb.fireTimer >= 650) {
    sb.fireTimer = 0;
    // radial burst
    for (let i = 0; i < 12; i++) {
      const ang = i * (Math.PI * 2 / 12) + sb.angleTop;
      sb.bullets.push({
        x: sb.x + Math.cos(ang) * sb.rTop,
        y: sb.y + Math.sin(ang) * sb.rTop,
        r: 6, dx: Math.cos(ang) * 6.5, dy: Math.sin(ang) * 6.5,
        damage: 8, life: 1500
      });
    }
  }
  for (let i = sb.bullets.length - 1; i >= 0; i--) {
    const b = sb.bullets[i];
    b.x += b.dx; b.y += b.dy; b.life -= 1000 / TICK_RATE;
    if (b.life <= 0 || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) { sb.bullets.splice(i, 1); continue; }
    for (const p of world.players.values()) {
      if (p.dead) continue;
      if (dist(b.x, b.y, p.x, p.y) <= b.r + p.r) {
        p.hp -= b.damage;
        addDamagePopup(p.x, p.y - p.r - 20, b.damage, "#ff66ff", 1000);
        sb.bullets.splice(i, 1);
        if (p.hp <= 0) killPlayer(p, null);
        break;
      }
    }
  }
}

/* ===== Kill/respawn ===== */
function killPlayer(p, killer) {
  p.dead = true;
  p.hp = 0;
  p.bullets = [];
  p.drones = [];
  p.traps = [];
  // Optionally award XP to killer
  if (killer) addXP(killer, Math.max(50, Math.floor(p.level * 50)));
}

function respawnPlayer(p) {
  const fresh = makeDefaultPlayer(p.id);
  // preserve some XP/level if you want; here we reset
  world.players.set(p.id, fresh);
}

/* ===== Traps placement ===== */
function placeTrap(p) {
  const now = Date.now();
  if (!p.trapLayer) return;
  if (p.traps.length >= p.trapMax) return;
  if (now < p.nextTrapTime) return;
  p.nextTrapTime = now + p.trapCooldown;

  const big = false; // applied via upgrades if you want to branch
  const sentry = false;
  const cluster = false;

  const hp = big ? 120 : 60;
  const r = big ? 16 : 12;

  p.traps.push({
    x: p.x + Math.cos(p.angle) * (p.r + 20),
    y: p.y + Math.sin(p.angle) * (p.r + 20),
    r,
    hp,
    cluster,
    sentry
  });
}

/* ===== Snapshot ===== */
function buildSnapshotForClient() {
  return {
    mapWidth: world.mapWidth,
    mapHeight: world.mapHeight,
    players: Array.from(world.players.values()).map(p => ({
      id: p.id,
      x: p.x, y: p.y, r: p.r, angle: p.angle,
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
    damagePopups: world.damagePopups.splice(0), // drain each tick
    prompt: Array.from(world.players.values()).find(p => p._prompt)?._prompt || null,
    gameOver: false
  };
}

/* ===== Tick ===== */
function tick() {
  try {
    // Players
    for (const p of world.players.values()) {
      if (!p.dead) {
        updatePlayerInputs(p);
        stepBullets(p);
        stepDrones(p);
        stepTraps(p);
      }
    }
    // Bosses
    stepBoss(world.boss);
    stepSuperBoss(world.superBoss);

    // Respawn shapes if low
    if (world.shapes.length < 100) {
      for (let i = world.shapes.length; i < 120; i++) {
        const type = Math.random() < 0.6 ? "square" : Math.random() < 0.5 ? "triangle" : "pentagon";
        const r = type === "square" ? 20 : type === "triangle" ? 24 : 28;
        const hp = type === "square" ? 30 : type === "triangle" ? 60 : 120;
        world.shapes.push({
          id: "sx_" + Math.random().toString(36).slice(2),
          type, variant: null,
          x: rand(100, MAP_W - 100), y: rand(100, MAP_H - 100),
          r, hp, maxHp: hp, angle: rand(0, Math.PI * 2)
        });
      }
    }

    // Emit snapshot & clear prompt flags
    io.emit("state", buildSnapshotForClient());
    for (const p of world.players.values()) p._prompt = null;

  } catch (err) {
    console.error("Tick error:", err);
  }
}

/* ===== Socket handlers ===== */
io.on("connection", socket => {
  const p = makeDefaultPlayer(socket.id);
  world.players.set(socket.id, p);

  socket.on("input", payload => {
    const p = world.players.get(socket.id);
    if (!p) return;
    // Basic validation
    if (payload && payload.keys && payload.mouse && payload.camera) {
      p.input = payload;
    }
  });

  socket.on("switchPath", key => {
    const p = world.players.get(socket.id);
    if (!p || p.dead) return;
    if (!["multi","big","drone","trap"].includes(key)) return;
    applyPath(p, key);
  });

  socket.on("applyUpgrade", key => {
    const p = world.players.get(socket.id);
    if (!p || p.dead) return;
    applySubUpgrade(p, key);
  });

  socket.on("tryPlaceTrap", () => {
    const p = world.players.get(socket.id);
    if (!p || p.dead) return;
    placeTrap(p);
  });

  socket.on("respawn", () => {
    const p2 = world.players.get(socket.id);
    if (!p2) return;
    respawnPlayer(p2);
  });

  socket.on("disconnect", () => {
    world.players.delete(socket.id);
  });
});

/* ===== Boot ===== */
spawnShapes(180);
spawnBoss();
spawnSuperBoss();

server.listen(process.env.PORT || 3000, () => {
  console.log("Server listening on port", server.address().port);
});

setInterval(tick, 1000 / TICK_RATE);
