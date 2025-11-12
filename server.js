// server.js
// Install: npm init -y && npm install express socket.io
// Run: node server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* ===== World constants ===== */
const mapWidth = 7200;
const mapHeight = 5400;
const ENTITY_IDS = { player: "player", boss: "boss", superBoss: "superBoss" };
let nextEntityId = 1;

/* ===== World state ===== */
const world = {
  mapWidth, mapHeight,
  players: new Map(), // socket.id -> player state
  shapes: [],
  boss: {
    id: ENTITY_IDS.boss, x: 300, y: 300, r: 60, hp: 1000, maxHp: 1000,
    angle: 0, rotationSpeed: 0.01, bullets: [], speed: 1.5
  },
  superBoss: {
    id: ENTITY_IDS.superBoss,
    x: 1200, y: 900,
    rBottom: 150, rMiddle: 112.5, rTop: 90,
    hp: 10000, maxHp: 10000,
    angleBottom: 0, angleMiddle: 0, angleTop: 0,
    rotBottom: 0.005, rotMiddle: -0.007, rotTop: 0.005,
    speed: 0.8,
    bullets: [], drones: []
  },
  damagePopups: [], // server creates, client animates
  prompt: null, // { type: "path" | "subUpgrade", level?: number }
  gameOver: false
};

/* ===== Utilities ===== */
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function now() { return performance.now ? performance.now() : Date.now(); } // Node 18+ has performance
const PERF = (typeof performance !== "undefined" && performance.now) ? performance : { now: () => Date.now() };

/* ===== Entity helpers ===== */
function makeDefaultPlayer() {
  return {
    id: ENTITY_IDS.player,
    x: mapWidth / 2, y: mapHeight / 2, r: 20, speed: 3,
    angle: 0, bullets: [], hp: 100, maxHp: 100, xp: 0, level: 1,
    path: null, mainGunEnabled: true,

    // Base gun stats
    barrels: 1,
    bulletSize: 5,
    bulletDamage: 10,
    baseBasicDamage: 10,
    bulletDamageWall: 3,

    fireDelay: 300, nextFireTime: 0,

    // Multi flags
    alternatingFire: false, rotaryTurret: false, sideSponsons: false,
    scattershot: false, quadCore: false, artillery: false,
    wallOfLead: false, precisionBattery: false,

    // Big flags
    dualBig: false, megaBullet: false, impactExplosive: false,
    piercingShells: false, clusterBomb: false, siegeMode: false,
    titanShell: false, twinSiege: false, shockwaveRound: false,

    // Drone flags
    drones: [], droneMax: 10, droneRadius: 8, droneSpeed: 4,
    droneDamage: 6,
    droneKamikazeBoost: false, droneGuardian: false, droneShooter: false,
    hiveExpansion: false, armoredDrones: false, snareDrones: false,
    droneCommander: false, explosiveDrones: false, hybridDrones: false,

    // Trap Layer flags
    trapLayer: false,
    traps: [],
    trapMax: 10,
    trapBaseDamage: 10,
    trapBaseSize: 12,
    trapBaseCooldown: 2000,
    nextTrapTime: 0,
    trapDoubleLayer: false,
    trapBig: false,
    trapQuad: false,
    trapHuge: false,
    trapCluster: false,
    trapSentry: false,

    // client input cache
    input: { keys: { w: false, a: false, s: false, d: false }, mouse: { x: 0, y: 0 }, camera: { x: 0, y: 0 } }
  };
}

function addDamagePopup(x, y, amount, color = "white", duration = 1000) {
  world.damagePopups.push({
    x, y,
    text: `${Math.max(1, Math.round(amount))}`,
    color,
    duration
  });
}

function spawnShape() {
  const types = ["square", "triangle", "pentagon"];
  const baseType = types[Math.floor(Math.random() * types.length)];
  const baseSize = baseType === "pentagon" ? 30 : baseType === "triangle" ? 20 : 15;

  const variants = [
    { variant: "normal", weight: 1.0, sizeScale: 1.0, hpMult: 1, xpMult: 1 },
    { variant: "beta",   weight: 1.0/3.0, sizeScale: 1.2, hpMult: 3, xpMult: 3 },
    { variant: "aptha",  weight: 1.0/10.0, sizeScale: 1.0, hpMult: 10, xpMult: 10 }
  ];
  const totalW = variants.reduce((s, v) => s + v.weight, 0);
  let r = Math.random() * totalW;
  let chosen = variants[0];
  for (const v of variants) { if (r <= v.weight) { chosen = v; break; } r -= v.weight; }

  const size = Math.round(baseSize * chosen.sizeScale);
  const baseHp = baseSize * 2;
  const hp = baseHp * chosen.hpMult;
  const xp = 10 * chosen.xpMult;

  world.shapes.push({
    id: nextEntityId++,
    x: Math.random() * mapWidth, y: Math.random() * mapHeight,
    r: size, type: baseType, variant: chosen.variant,
    hp, maxHp: hp, xp,
    dx: (Math.random() - 0.5) * 1.5, dy: (Math.random() - 0.5) * 1.5,
    angle: 0, rotationSpeed: (Math.random() - 0.5) * 0.05
  });
}

function shootBullet(x, y, angle, speed = 6, source = "player", radiusOverride = null, damageOverride = null, extra = {}) {
  const dx = Math.cos(angle) * speed;
  const dy = Math.sin(angle) * speed;
  const r = radiusOverride ?? (source === "player" ? 5 : 5);
  const baseDmg = damageOverride ?? (source === "player" ? 10 : 2);
  const bullet = {
    x, y, dx, dy, r, source,
    dmg: baseDmg,
    spawnTime: PERF.now(),
    lifeTime: 2000,
    explosive: !!extra.explosive,
    pierce: extra.pierce ?? 0,
    shockwave: !!extra.shockwave,
    hitCooldown: {}
  };
  if (source === "player") activePlayer().bullets.push(bullet);
  else if (source === "boss") world.boss.bullets.push(bullet);
  else if (source === "superBoss") world.superBoss.bullets.push(bullet);
}

function hardResetCombatState(player) {
  player.bullets = [];
  player.drones = [];
  player.traps = [];
  player.mainGunEnabled = true;

  player.barrels = 1;
  player.bulletSize = 5;
  player.bulletDamage = 10;
  player.baseBasicDamage = 10;
  player.bulletDamageWall = Math.round(player.baseBasicDamage / 3);

  player.fireDelay = 300;
  player.alternatingFire = false;
  player.rotaryTurret = false;
  player.sideSponsons = false;
  player.scattershot = false;
  player.quadCore = false;
  player.artillery = false;
  player.wallOfLead = false;
  player.precisionBattery = false;

  player.dualBig = false;
  player.megaBullet = false;
  player.impactExplosive = false;
  player.piercingShells = false;
  player.clusterBomb = false;
  player.siegeMode = false;
  player.titanShell = false;
  player.twinSiege = false;
  player.shockwaveRound = false;

  player.droneMax = 10; player.droneRadius = 8; player.droneSpeed = 4; player.droneDamage = 6;
  player.droneKamikazeBoost = false; player.droneGuardian = false; player.droneShooter = false;
  player.hiveExpansion = false; player.armoredDrones = false; player.snareDrones = false;
  player.droneCommander = false; player.explosiveDrones = false; player.hybridDrones = false;

  player.trapLayer = false;
  player.trapMax = 10;
  player.trapBaseDamage = 10;
  player.trapBaseSize = 12;
  player.trapBaseCooldown = 2000;
  player.nextTrapTime = 0;
  player.trapDoubleLayer = false;
  player.trapBig = false;
  player.trapQuad = false;
  player.trapHuge = false;
  player.trapCluster = false;
  player.trapSentry = false;
}

/* ===== Path switching and upgrades (authoritative) ===== */
function switchPath(player, newPath) {
  hardResetCombatState(player);
  player.path = newPath;

  if (newPath === "multi") {
    player.mainGunEnabled = true; player.barrels = 3;
  } else if (newPath === "big") {
    player.mainGunEnabled = true; player.bulletSize = 12; player.bulletDamage = 25;
    player.baseBasicDamage = 10; player.bulletDamageWall = Math.round(player.baseBasicDamage / 3);
  } else if (newPath === "drone") {
    player.mainGunEnabled = false;
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      player.drones.push({
        x: player.x + Math.cos(ang) * (player.r + 12),
        y: player.y + Math.sin(ang) * (player.r + 12),
        r: player.droneRadius, speed: player.droneSpeed, hp: player.armoredDrones ? 2 : 1,
        nextShootTime: PERF.now() + 1800
      });
    }
  } else if (newPath === "trap") {
    player.mainGunEnabled = true;
    player.trapLayer = true;
    player.trapBaseDamage = 10;
    player.trapBaseSize = 12;
    player.trapBaseCooldown = 2000;
    player.nextTrapTime = 0;
  }
}

function applyUpgrade(player, key) {
  // Drone branch
  if (key === "droneKamikazeBoost") player.droneKamikazeBoost = true;
  if (key === "droneGuardian") player.droneGuardian = true;
  if (key === "droneShooter") {
    player.droneShooter = true;
    const nowT = PERF.now();
    for (const d of player.drones) d.nextShootTime = nowT + 1800;
  }
  if (key === "hiveExpansion") { player.hiveExpansion = true; player.droneMax = 15; }
  if (key === "armoredDrones") player.armoredDrones = true;
  if (key === "snareDrones") player.snareDrones = true;
  if (key === "droneCommander") { player.droneCommander = true; player.droneMax = 20; }
  if (key === "explosiveDrones") player.explosiveDrones = true;
  if (key === "hybridDrones") {
    player.hybridDrones = true;
    const nowT = PERF.now();
    for (const d of player.drones) d.nextShootTime = nowT + 1800;
  }

  // Multi branch
  if (key === "alternatingFire") player.alternatingFire = true;
  if (key === "rotaryTurret") player.rotaryTurret = true;
  if (key === "sideSponsons") player.sideSponsons = true;
  if (key === "scattershot") player.scattershot = true;
  if (key === "quadCore") { player.quadCore = true; player.barrels = Math.min(player.barrels + 1, 6); }
  if (key === "artillery") { player.artillery = true; player.fireDelay = Math.round(player.fireDelay * 1.2); }
  if (key === "wallOfLead") { player.wallOfLead = true; player.barrels = Math.min(player.barrels + 2, 8); player.bulletDamageWall = Math.round(player.baseBasicDamage / 3); }
  if (key === "precisionBattery") player.precisionBattery = true;
  if (key === "piercingShells") player.piercingShells = true;

  // Big branch
  if (key === "dualBig") player.dualBig = true;
  if (key === "megaBullet") { player.megaBullet = true; player.bulletSize += 4; player.bulletDamage += 10; }
  if (key === "impactExplosive") player.impactExplosive = true;
  if (key === "clusterBomb") player.clusterBomb = true;
  if (key === "siegeMode") { player.siegeMode = true; player.bulletDamage += 8; player.fireDelay = Math.round(player.fireDelay * 1.3); }
  if (key === "titanShell") { player.titanShell = true; player.bulletSize += 4; player.bulletDamage += 12; }
  if (key === "twinSiege") player.twinSiege = true;
  if (key === "shockwaveRound") player.shockwaveRound = true;

  // Trap branch
  if (key === "trapDoubleLayer") player.trapDoubleLayer = true;
  if (key === "trapBig") player.trapBig = true;
  if (key === "trapQuad") player.trapQuad = true;
  if (key === "trapHuge") player.trapHuge = true;
  if (key === "trapCluster") { player.trapCluster = true; player.trapHuge = true; }
  if (key === "trapSentry") player.trapSentry = true;
}

/* ===== Trap placement ===== */
function tryPlaceTrap(player) {
  if (!player.trapLayer) return;
  if (player.traps.length >= player.trapMax) return;
  const nowT = PERF.now();
  if (nowT < player.nextTrapTime) return;

  let count = 1;
  let dmg = player.trapBaseDamage;
  let size = player.trapBaseSize;
  let cooldown = player.trapBaseCooldown;
  let hp = 60;

  if (player.trapDoubleLayer) count = 2;
  if (player.trapBig) { dmg *= 3; size = 16; cooldown = Math.max(cooldown, 3000); hp = 120; }
  if (player.trapQuad) { count = 4; dmg = Math.floor(dmg * 0.8); }
  if (player.trapHuge) { dmg = player.trapBaseDamage * 9; size = 20; cooldown = Math.max(cooldown, 4000); hp = 500; }

  const isCluster = player.trapCluster;
  const isSentry = player.trapSentry;
  if (isCluster) { size = 20; hp = 500; cooldown = Math.max(cooldown, 4000); }

  const spread = count > 1 ? 0.2 : 0;
  const flySpeed = 6;
  const flyDuration = 300;

  for (let i = 0; i < count; i++) {
    const offset = (i - (count - 1) / 2) * spread;
    const ang = player.angle + offset;
    const tx = player.x + Math.cos(ang) * (player.r + 30);
    const ty = player.y + Math.sin(ang) * (player.r + 30);
    player.traps.push({
      x: tx, y: ty, r: size, dmg,
      hp,
      cluster: isCluster,
      sentry: isSentry,
      nextSentryShot: PERF.now() + 1500,
      vx: Math.cos(ang) * flySpeed,
      vy: Math.sin(ang) * flySpeed,
      stopTime: PERF.now() + flyDuration
    });
  }
  player.nextTrapTime = nowT + cooldown;
}

/* ===== Cluster utilities ===== */
function trapClusterExplode(player, t) {
  const count = 10;
  const shardDamage = 5;
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dx = Math.cos(ang) * 7;
    const dy = Math.sin(ang) * 7;
    player.bullets.push({
      x: t.x, y: t.y, dx, dy,
      r: 3, source: "player", dmg: shardDamage,
      spawnTime: PERF.now(),
      lifeTime: 500,
      explosive: false, pierce: 0, shockwave: false, hitCooldown: {}
    });
  }
}
function spawnFragments(player, x, y, baseDmg) {
  const count = 10;
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dx = Math.cos(ang) * 6;
    const dy = Math.sin(ang) * 6;
    player.bullets.push({
      x, y, dx, dy,
      r: 3, source: "player", dmg: Math.floor(baseDmg * 0.4),
      spawnTime: PERF.now(),
      lifeTime: 500,
      explosive: false, pierce: 0, shockwave: false, hitCooldown: {}
    });
  }
}

/* ===== Targeting utilities ===== */
function getClosestTarget(x, y) {
  const candidates = [];
  // prefer active player for boss AI
  const p = activePlayer();
  if (p) candidates.push({ x: p.x, y: p.y, type: "player", ref: p });
  if (p && p.path === "drone") for (const d of p.drones) candidates.push({ x: d.x, y: d.y, type: "drone", ref: d });
  if (world.boss.hp > 0) candidates.push({ x: world.boss.x, y: world.boss.y, type: "boss", ref: world.boss });
  if (world.shapes.length) {
    let nearest = null; let minD = Infinity;
    for (const s of world.shapes) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < minD) { minD = d; nearest = s; }
    }
    if (nearest) candidates.push({ x: nearest.x, y: nearest.y, type: "shape", ref: nearest });
  }
  let best = candidates[0]; if (!best) return null;
  let bestD = Math.hypot(best.x - x, best.y - y);
  for (let i = 1; i < candidates.length; i++) {
    const t = candidates[i];
    const d = Math.hypot(t.x - x, t.y - y);
    if (d < bestD) { best = t; bestD = d; }
  }
  return best;
}
function resolveTarget(type, ref) {
  if (type === "player") return activePlayer();
  if (type === "boss") return world.boss.hp > 0 ? world.boss : null;
  if (type === "shape") return world.shapes.includes(ref) ? ref : null;
  if (type === "drone") {
    const p = activePlayer();
    return (p && p.drones.includes(ref)) ? ref : null;
  }
  return null;
}

/* ===== Firing logic (player main gun, authoritative) ===== */
let altIndex = 0;
function firePlayerGuns(player) {
  if (!player.mainGunEnabled) return;

  let spread = player.precisionBattery ? 0.12 : 0.2;
  if (player.scattershot) spread += 0.05;
  const timeOffset = player.rotaryTurret ? (Math.sin(PERF.now() / 300) * 0.15) : 0;
  const totalBarrels = player.barrels;
  const startAngle = player.angle + timeOffset - (spread * (totalBarrels - 1) / 2);

  const fireBarrel = (angle) => {
    let shotAngle = angle;
    if (player.scattershot) shotAngle += (Math.random() - 0.5) * 0.25;
    const multiDamageOverride = (player.wallOfLead ? player.bulletDamageWall : null);

    if (player.path === "big") {
      if (player.titanShell) {
        shootBullet(player.x + Math.cos(shotAngle) * player.r, player.y + Math.sin(shotAngle) * player.r, shotAngle, 3.8, "player", player.bulletSize + 4, player.bulletDamage + 12);
      } else if (player.megaBullet) {
        shootBullet(player.x + Math.cos(shotAngle) * player.r, player.y + Math.sin(shotAngle) * player.r, shotAngle, 4, "player", player.bulletSize + 4, player.bulletDamage + 10);
      } else if (player.dualBig || player.twinSiege) {
        const lateral = 8;
        const lx = player.x + Math.cos(shotAngle + Math.PI / 2) * lateral;
        const ly = player.y + Math.sin(shotAngle + Math.PI / 2) * lateral;
        const rx = player.x + Math.cos(shotAngle - Math.PI / 2) * lateral;
        const ry = player.y + Math.sin(shotAngle - Math.PI / 2) * lateral;
        const speed = player.twinSiege ? 4.5 : 5;
        const size = player.twinSiege ? (player.bulletSize + 2) : player.bulletSize;
        const dmg  = player.twinSiege ? (player.bulletDamage + 6) : player.bulletDamage;
        shootBullet(lx + Math.cos(shotAngle) * player.r, ly + Math.sin(shotAngle) * player.r, shotAngle, speed, "player", size, dmg);
        shootBullet(rx + Math.cos(shotAngle) * player.r, ry + Math.sin(shotAngle) * player.r, shotAngle, speed, "player", size, dmg);
      } else {
        shootBullet(player.x + Math.cos(shotAngle) * player.r, player.y + Math.sin(shotAngle) * player.r, shotAngle);
      }
    } else {
      shootBullet(
        player.x + Math.cos(shotAngle) * player.r,
        player.y + Math.sin(shotAngle) * player.r,
        shotAngle,
        undefined, "player",
        undefined,
        multiDamageOverride !== null ? multiDamageOverride : undefined
      );
    }
  };

  if (player.alternatingFire) {
    const angle = startAngle + altIndex * spread;
    fireBarrel(angle);
    altIndex = (altIndex + 1) % totalBarrels;
  } else {
    for (let i = 0; i < totalBarrels; i++) {
      const angle = startAngle + i * spread;
      fireBarrel(angle);
    }
  }

  if (player.sideSponsons) {
    const leftAngle = player.angle - Math.PI / 2;
    const rightAngle = player.angle + Math.PI / 2;
    fireBarrel(leftAngle);
    fireBarrel(rightAngle);
  }
}

/* ===== Collisions and updates ===== */
function resolveEntityCollisions(player) {
  const entities = [];
  entities.push({ ref: player, type: "player", x: player.x, y: player.y, r: player.r, mass: 1.0, movable: true });

  if (world.boss.hp > 0) entities.push({ ref: world.boss, type: "boss", x: world.boss.x, y: world.boss.y, r: world.boss.r, mass: 3.0, movable: true });
  if (world.superBoss.hp > 0) entities.push({ ref: world.superBoss, type: "superBoss", x: world.superBoss.x, y: world.superBoss.y, r: world.superBoss.rBottom, mass: 5.0, movable: true });

  for (const s of world.shapes) entities.push({ ref: s, type: "shape", x: s.x, y: s.y, r: s.r, mass: 0.8, movable: true });
  for (const d of player.drones) entities.push({ ref: d, type: "playerDrone", x: d.x, y: d.y, r: d.r, mass: 0.3, movable: true });
  for (const t of player.traps) entities.push({ ref: t, type: "playerTrap", x: t.x, y: t.y, r: t.r, mass: 0.6, movable: true });

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const A = entities[i], B = entities[j];
      const dx = B.ref.x - A.ref.x;
      const dy = B.ref.y - A.ref.y;
      const dist = Math.hypot(dx, dy);
      const minDist = A.r + B.r;

      if (dist > 0 && dist < minDist) {
        const overlap = minDist - dist;
        const ux = dx / dist, uy = dy / dist;

        let moveA = (B.mass / (A.mass + B.mass)) * overlap;
        let moveB = (A.mass / (A.mass + B.mass)) * overlap;

        // No self-push for player vs playerDrone/playerTrap
        if ((A.type === "player" && (B.type === "playerDrone" || B.type === "playerTrap"))) {
          moveA = 0; moveB = overlap;
        } else if ((B.type === "player" && (A.type === "playerDrone" || A.type === "playerTrap"))) {
          moveB = 0; moveA = overlap;
        }

        if (A.movable) {
          A.ref.x -= ux * moveA;
          A.ref.y -= uy * moveA;
          A.ref.x = clamp(A.ref.x, A.r, mapWidth - A.r);
          A.ref.y = clamp(A.ref.y, A.r, mapHeight - A.r);
        }
        if (B.movable) {
          B.ref.x += ux * moveB;
          B.ref.y += uy * moveB;
          B.ref.x = clamp(B.ref.x, B.r, mapWidth - B.r);
          B.ref.y = clamp(B.ref.y, B.r, mapHeight - B.r);
        }
      }
    }
  }
}

/* ===== Game loop update (authoritative) ===== */
function updatePlayerInputs(player) {
  const { keys, mouse, camera } = player.input;
  // Move
  if (keys.w) player.y -= player.speed;
  if (keys.s) player.y += player.speed;
  if (keys.a) player.x -= player.speed;
  if (keys.d) player.x += player.speed;
  player.x = clamp(player.x, player.r, mapWidth - player.r);
  player.y = clamp(player.y, player.r, mapHeight - player.r);

  // Aim (server uses client mouse + camera to compute world aim)
  const dxAim = mouse.x + (camera?.x || 0) - player.x;
  const dyAim = mouse.y + (camera?.y || 0) - player.y;
  player.angle = Math.atan2(dyAim, dxAim);
}

function bossAI() {
  if (world.boss.hp <= 0) return;
  const tgtObj = getClosestTarget(world.boss.x, world.boss.y);
  if (!tgtObj) return;
  const dx = tgtObj.x - world.boss.x;
  const dy = tgtObj.y - world.boss.y;
  const dist = Math.hypot(dx, dy);
  const wobble = Math.sin(PERF.now() / 800) * 0.5;
  if (dist > 1) {
    world.boss.x += (dx / dist) * world.boss.speed + Math.cos(PERF.now() / 500) * 0.2;
    world.boss.y += (dy / dist) * world.boss.speed + Math.sin(PERF.now() / 600) * 0.2 + wobble * 0.05;
  }
  world.boss.angle += world.boss.rotationSpeed;
  world.boss.x = clamp(world.boss.x, world.boss.r, mapWidth - world.boss.r);
  world.boss.y = clamp(world.boss.y, world.boss.r, mapHeight - world.boss.r);
}

function superBossAI() {
  if (world.superBoss.hp <= 0) return;
  const tgtObj = getClosestTarget(world.superBoss.x, world.superBoss.y);
  if (tgtObj) {
    const dx = tgtObj.x - world.superBoss.x;
    const dy = tgtObj.y - world.superBoss.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1) {
      world.superBoss.x += (dx / dist) * world.superBoss.speed;
      world.superBoss.y += (dy / dist) * world.superBoss.speed;
    }
  }
  const maxR = world.superBoss.rBottom;
  world.superBoss.x = clamp(world.superBoss.x, maxR, mapWidth - maxR);
  world.superBoss.y = clamp(world.superBoss.y, maxR, mapHeight - maxR);

  // rotation
  world.superBoss.angleBottom += world.superBoss.rotBottom;
  world.superBoss.angleMiddle += world.superBoss.rotMiddle;
  world.superBoss.angleTop += world.superBoss.rotTop;

  // superBoss drones homing
  for (let i = world.superBoss.drones.length - 1; i >= 0; i--) {
    const d = world.superBoss.drones[i];
    const target = resolveTarget(d.targetType, d.targetRef);
    if (!target) { world.superBoss.drones.splice(i, 1); continue; }
    const dx = target.x - d.x, dy = target.y - d.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1) { d.x += (dx / dist) * d.speed; d.y += (dy / dist) * d.speed; }
    const targetR = (target.r ?? 10);
    if (dist < d.r + targetR) {
      if (d.targetType === "player") {
        activePlayer().hp = Math.max(0, activePlayer().hp - d.dmg);
      } else if (d.targetType === "boss") {
        world.boss.hp = Math.max(0, world.boss.hp - d.dmg);
      } else if (d.targetType === "shape") {
        target.hp -= d.dmg;
        addDamagePopup(target.x, target.y - target.r - 12, d.dmg, "#ff66ff");
        if (target.hp <= 0) {
          const idx = world.shapes.indexOf(target);
          if (idx !== -1) world.shapes.splice(idx, 1);
        }
      } else if (d.targetType === "drone") {
        const p = activePlayer();
        const idx = p.drones.indexOf(target);
        if (idx !== -1) p.drones.splice(idx, 1);
      }
      world.superBoss.drones.splice(i, 1);
    }
  }
}

function updateShapes() {
  for (let si = world.shapes.length - 1; si >= 0; si--) {
    const s = world.shapes[si];
    s.x += s.dx; s.y += s.dy; s.angle += s.rotationSpeed;
    if (s.x < s.r || s.x > mapWidth - s.r) s.dx *= -1;
    if (s.y < s.r || s.y > mapHeight - s.r) s.dy *= -1;
  }
}

function updatePlayerBullets(player) {
  for (let i = player.bullets.length - 1; i >= 0; i--) {
    const b = player.bullets[i];
    if (PERF.now() - b.spawnTime > b.lifeTime) { player.bullets.splice(i, 1); continue; }
    b.x += b.dx; b.y += b.dy;
    if (b.x < 0 || b.y < 0 || b.x > mapWidth || b.y > mapHeight) { player.bullets.splice(i, 1); continue; }

    const tryExplodeSplash = () => {
      if (!b.explosive) return;
      for (let si = world.shapes.length - 1; si >= 0; si--) {
        const s = world.shapes[si];
        const d = Math.hypot(s.x - b.x, s.y - b.y);
        if (d < 40) {
          const dmg = Math.floor(player.bulletDamage * 0.6);
          s.hp -= dmg;
          addDamagePopup(s.x, s.y - s.r - 12, dmg, "#ffcc66");
        }
        if (s.hp <= 0) { world.shapes.splice(si, 1); player.xp += s.xp ?? 10; }
      }
    };

    const IMMUNITY_MS = 500;

    // superBoss hit
    if (world.superBoss.hp > 0) {
      const entityId = world.superBoss.id;
      const immuneUntil = b.hitCooldown[entityId] ?? 0;
      if (PERF.now() >= immuneUntil) {
        const d = Math.hypot(world.superBoss.x - b.x, world.superBoss.y - b.y);
        if (d < world.superBoss.rBottom + b.r) {
          world.superBoss.hp = Math.max(0, world.superBoss.hp - b.dmg);
          addDamagePopup(world.superBoss.x, world.superBoss.y - world.superBoss.rBottom - 12, b.dmg, "#ff66ff");
          tryExplodeSplash();
          if (player.clusterBomb) spawnFragments(player, b.x, b.y, b.dmg);
          b.hitCooldown[entityId] = PERF.now() + IMMUNITY_MS;
          if (b.pierce > 0) b.pierce--; else player.bullets.splice(i, 1);
          continue;
        }
      }
    }

    // boss hit
    if (world.boss.hp > 0) {
      const entityId = world.boss.id;
      const immuneUntil = b.hitCooldown[entityId] ?? 0;
      if (PERF.now() >= immuneUntil) {
        const distBoss = Math.hypot(world.boss.x - b.x, world.boss.y - b.y);
        if (distBoss < world.boss.r + b.r) {
          world.boss.hp = Math.max(0, world.boss.hp - b.dmg);
          addDamagePopup(world.boss.x, world.boss.y - world.boss.r - 12, b.dmg, "#ffffff");
          if (b.shockwave) { world.boss.x += b.dx * 2; world.boss.y += b.dy * 2; }
          tryExplodeSplash();
          if (player.clusterBomb) spawnFragments(player, b.x, b.y, b.dmg);
          b.hitCooldown[entityId] = PERF.now() + IMMUNITY_MS;
          if (b.pierce > 0) b.pierce--; else player.bullets.splice(i, 1);
          continue;
        }
      }
    }

    // shapes hit
    for (let si = world.shapes.length - 1; si >= 0; si--) {
      const s = world.shapes[si];
      const entityId = s.id;
      const immuneUntil = b.hitCooldown[entityId] ?? 0;
      if (PERF.now() < immuneUntil) continue;
      const dist = Math.hypot(s.x - b.x, s.y - b.y);
      if (dist < s.r + b.r) {
        s.hp -= b.dmg;
        const color = s.variant === "aptha" ? "#ff80ff" : s.variant === "beta" ? "#ffd480" : "#ff9966";
        addDamagePopup(s.x, s.y - s.r - 12, b.dmg, color);
        tryExplodeSplash();
        if (player.clusterBomb) spawnFragments(player, b.x, b.y, b.dmg);
        b.hitCooldown[entityId] = PERF.now() + IMMUNITY_MS;
        if (s.hp <= 0) { world.shapes.splice(si, 1); player.xp += s.xp ?? 10; }
        if (b.pierce > 0) b.pierce--; else player.bullets.splice(i, 1);
        break;
      }
    }
  }
}

function updateEnemyBullets(player) {
  const enemyBulletSets = [world.boss.bullets, world.superBoss.bullets];
  for (const set of enemyBulletSets) {
    for (let i = set.length - 1; i >= 0; i--) {
      const b = set[i];
      if (PERF.now() - b.spawnTime > b.lifeTime) { set.splice(i, 1); continue; }
      b.x += b.dx; b.y += b.dy;
      if (b.x < 0 || b.y < 0 || b.x > mapWidth || b.y > mapHeight) { set.splice(i, 1); continue; }

      const distP = Math.hypot(player.x - b.x, player.y - b.y);
      if (distP < player.r + b.r) { player.hp = Math.max(0, player.hp - b.dmg); set.splice(i, 1); continue; }

      if (set === world.superBoss.bullets) {
        let hit = false;
        for (let si = world.shapes.length - 1; si >= 0; si--) {
          const s = world.shapes[si];
          const distS = Math.hypot(s.x - b.x, s.y - b.y);
          if (distS < s.r + b.r) {
            s.hp -= b.dmg;
            addDamagePopup(s.x, s.y - s.r - 12, b.dmg, "#ff66ff");
            if (s.hp <= 0) { world.shapes.splice(si, 1); }
            set.splice(i, 1);
            hit = true;
            break;
          }
        }
        if (hit) continue;

        if (world.boss.hp > 0) {
          const distB = Math.hypot(world.boss.x - b.x, world.boss.y - b.y);
          if (distB < world.boss.r + b.r) {
            world.boss.hp = Math.max(0, world.boss.hp - b.dmg);
            addDamagePopup(world.boss.x, world.boss.y - world.boss.r - 12, b.dmg, "#ff66ff");
            set.splice(i, 1); continue;
          }
        }

        for (let di = player.drones.length - 1; di >= 0; di--) {
          const d = player.drones[di];
          const distD = Math.hypot(d.x - b.x, d.y - b.y);
          if (distD < d.r + b.r) { player.drones.splice(di, 1); set.splice(i, 1); break; }
        }
      }
    }
  }
}

function removeDroneOnHit(player, di) {
  const d = player.drones[di];
  // Splash if explosive drones
  if (player.explosiveDrones) {
    for (let si = world.shapes.length - 1; si >= 0; si--) {
      const s = world.shapes[si];
      const dist = Math.hypot(s.x - d.x, s.y - d.y);
      if (dist < 40) {
        s.hp -= 10;
        addDamagePopup(s.x, s.y - s.r - 12, 10, "yellow");
        if (s.hp <= 0) { world.shapes.splice(si, 1); player.xp += s.xp ?? 10; }
      }
    }
  }

  // Armored drones can survive 2 hits
  if (player.armoredDrones && d.hp > 1) {
    d.hp -= 1;
  } else {
    player.drones.splice(di, 1);
  }
}

function updatePlayerDrones(player) {
  if (player.path !== "drone") return;

  for (let di = player.drones.length - 1; di >= 0; di--) {
    const d = player.drones[di];

    // Server uses player's input camera+mouse to target
    const dx = player.input.mouse.x + player.input.camera.x - d.x;
    const dy = player.input.mouse.y + player.input.camera.y - d.y;
    const distToMouse = Math.hypot(dx, dy);
    if (distToMouse > 1) { d.x += (dx / distToMouse) * d.speed; d.y += (dy / distToMouse) * d.speed; }
    d.x = clamp(d.x, d.r, mapWidth - d.r);
    d.y = clamp(d.y, d.r, mapHeight - d.r);

    // Shape collisions
    let collided = false;
    for (let si = world.shapes.length - 1; si >= 0; si--) {
      const s = world.shapes[si];
      const dist = Math.hypot(s.x - d.x, s.y - d.y);
      if (dist < s.r + d.r) {
        const dmg = player.droneKamikazeBoost ? Math.round(player.droneDamage * 1.5) : player.droneDamage;
        s.hp -= dmg;
        addDamagePopup(s.x, s.y - s.r - 12, dmg, "yellow");
        if (player.snareDrones) { s.dx *= 0.8; s.dy *= 0.8; }
        if (s.hp <= 0) { world.shapes.splice(si, 1); player.xp += s.xp ?? 10; }
        removeDroneOnHit(player, di);
        collided = true;
        break;
      }
    }
    if (collided) continue;

    // Boss collisions
    if (world.boss.hp > 0) {
      const distB = Math.hypot(world.boss.x - d.x, world.boss.y - d.y);
      if (distB < world.boss.r + d.r) {
        const dmg = player.droneKamikazeBoost ? Math.round(player.droneDamage * 1.5) : player.droneDamage;
        world.boss.hp = Math.max(0, world.boss.hp - dmg);
        addDamagePopup(world.boss.x, world.boss.y - world.boss.r - 12, dmg, "yellow");
        removeDroneOnHit(player, di);
        continue;
      }
    }

    // SuperBoss collisions
    if (world.superBoss.hp > 0) {
      const distSB = Math.hypot(world.superBoss.x - d.x, world.superBoss.y - d.y);
      if (distSB < world.superBoss.rBottom + d.r) {
        const dmg = player.droneKamikazeBoost ? Math.round(player.droneDamage * 1.5) : player.droneDamage;
        world.superBoss.hp = Math.max(0, world.superBoss.hp - dmg);
        addDamagePopup(world.superBoss.x, world.superBoss.y - world.superBoss.rBottom - 12, dmg, "yellow");
        removeDroneOnHit(player, di);
        continue;
      }
    }
  }

  // Guardian slows enemy bullets
  const enemyBulletSetsLocal = [world.boss.bullets, world.superBoss.bullets];
  if (player.droneGuardian) {
    for (const d of player.drones) {
      for (const set of enemyBulletSetsLocal) {
        for (const b of set) {
          const dist = Math.hypot(d.x - b.x, d.y - b.y);
          if (dist < d.r + b.r) { b.dx *= 0.7; b.dy *= 0.7; }
        }
      }
    }
  }

  // Shooter/hybrid drones
  if ((player.droneShooter || player.hybridDrones) && player.drones.length) {
    for (const d of player.drones) {
      if (!d.nextShootTime) d.nextShootTime = PERF.now() + 1800;
      if (PERF.now() >= d.nextShootTime) {
        const angleToMouse = Math.atan2(player.input.mouse.y + player.input.camera.y - d.y, player.input.mouse.x + player.input.camera.x - d.x);
        player.bullets.push({
          x: d.x, y: d.y, dx: Math.cos(angleToMouse) * 7, dy: Math.sin(angleToMouse) * 7,
          r: 4, source: "player", dmg: 3, explosive: false, pierce: 0,
          spawnTime: PERF.now(), lifeTime: 2000, hitCooldown: {}
        });
        d.nextShootTime = PERF.now() + 1800;
      }
    }
  }
}

function updateTraps(player) {
  for (let ti = player.traps.length - 1; ti >= 0; ti--) {
    const t = player.traps[ti];

    if (t.stopTime && PERF.now() < t.stopTime) {
      t.x += t.vx; t.y += t.vy;
      t.x = clamp(t.x, t.r, mapWidth - t.r);
      t.y = clamp(t.y, t.r, mapHeight - t.r);
    } else { t.vx = 0; t.vy = 0; t.stopTime = 0; }

    if (t.sentry) {
      const nowShot = PERF.now();
      if (nowShot >= t.nextSentryShot) {
        const target = getClosestTarget(t.x, t.y);
        if (target) {
          const ang = Math.atan2(target.y - t.y, target.x - t.x);
          shootBullet(t.x, t.y, ang, 5.5, "player", 4, 3);
        }
        t.nextSentryShot = nowShot + 1500;
      }
    }

    // Trap vs enemy bullets
    for (const set of [world.boss.bullets, world.superBoss.bullets]) {
      for (let bi = set.length - 1; bi >= 0; bi--) {
        const b = set[bi];
        const dist = Math.hypot(t.x - b.x, t.y - b.y);
        if (dist < t.r + b.r) {
          t.hp -= b.dmg;
          if (t.hp <= 0) {
            if (t.cluster) trapClusterExplode(activePlayer(), t);
            player.traps.splice(ti, 1);
          }
          set.splice(bi, 1);
        }
      }
    }
    if (!player.traps[ti]) continue;

    // Trap vs shapes (detonation)
    for (let si = world.shapes.length - 1; si >= 0; si--) {
      const s = world.shapes[si];
      const dist = Math.hypot(t.x - s.x, t.y - s.y);
      if (dist < t.r + s.r) {
        s.hp -= t.dmg;
        addDamagePopup(s.x, s.y - s.r - 12, t.dmg, "#66ff66");
        if (s.hp <= 0) { world.shapes.splice(si, 1); activePlayer().xp += s.xp ?? 10; }
        if (t.cluster) trapClusterExplode(activePlayer(), t);
        player.traps.splice(ti, 1);
        break;
      }
    }
    if (!player.traps[ti]) continue;

    // Trap vs boss/superBoss
    if (world.boss.hp > 0) {
      const distB = Math.hypot(t.x - world.boss.x, t.y - world.boss.y);
      if (distB < t.r + world.boss.r) {
        world.boss.hp = Math.max(0, world.boss.hp - t.dmg);
        addDamagePopup(world.boss.x, world.boss.y - world.boss.r - 12, t.dmg, "#66ff66");
        if (t.cluster) trapClusterExplode(activePlayer(), t);
        player.traps.splice(ti, 1);
        continue;
      }
    }

    if (world.superBoss.hp > 0) {
      const distSB = Math.hypot(t.x - world.superBoss.x, t.y - world.superBoss.y);
      if (distSB < t.r + world.superBoss.rBottom) {
        world.superBoss.hp = Math.max(0, world.superBoss.hp - t.dmg);
        addDamagePopup(world.superBoss.x, world.superBoss.y - world.superBoss.rBottom - 12, t.dmg, "#66ff66");
        if (t.cluster) trapClusterExplode(activePlayer(), t);
        player.traps.splice(ti, 1);
        continue;
      }
    }

    // Trap vs player drones
    for (let di = activePlayer().drones.length - 1; di >= 0; di--) {
      const d = activePlayer().drones[di];
      const distD = Math.hypot(t.x - d.x, t.y - d.y);
      if (distD < t.r + d.r) { activePlayer().drones.splice(di, 1); }
    }
  }
}

function checkLevelMilestones(player) {
  const threshold = player.level * 50;
  if (player.level < 12 && player.xp >= threshold) {
    player.level++;
    player.hp = player.maxHp;
    if (!player.path && player.level >= 3 && player.level % 3 === 0) {
      world.prompt = { type: "path" };
    } else if (player.path && player.level % 3 === 0) {
      world.prompt = { type: "subUpgrade", level: player.level };
    }
  }
}

function checkDeath(player) {
  if (player.hp <= 0 && !world.gameOver) {
    world.gameOver = true;
  }
}

/* ===== Enemy firing timers ===== */
function bossFire() {
  if (world.gameOver || world.boss.hp <= 0) return;
  const tgt = getClosestTarget(world.boss.x, world.boss.y);
  if (!tgt) return;
  const aimBase = Math.atan2(tgt.y - world.boss.y, tgt.x - world.boss.x);
  for (let i = 0; i < 5; i++) {
    const gunAngle = world.boss.angle + i * (Math.PI * 2 / 5);
    const wiggle = (Math.random() - 0.5) * 0.15;
    const aimAngle = aimBase + wiggle;
    shootBullet(world.boss.x + Math.cos(gunAngle) * world.boss.r, world.boss.y + Math.sin(gunAngle) * world.boss.r, aimAngle, 4, "boss");
  }
}
function superBossFireBottom() {
  if (world.gameOver || world.superBoss.hp <= 0) return;
  for (let i = 0; i < 6; i++) {
    const ang = world.superBoss.angleBottom + i * (Math.PI * 2 / 6);
    const b = {
      x: world.superBoss.x + Math.cos(ang) * world.superBoss.rBottom,
      y: world.superBoss.y + Math.sin(ang) * world.superBoss.rBottom
    };
    shootBullet(b.x, b.y, ang, 10, "superBoss", 20, 70);
  }
}
function superBossFireMiddle() {
  if (world.gameOver || world.superBoss.hp <= 0) return;
  for (let i = 0; i < 15; i++) {
    const ang = world.superBoss.angleMiddle + i * (Math.PI * 2 / 15);
    const b = {
      x: world.superBoss.x + Math.cos(ang) * world.superBoss.rMiddle,
      y: world.superBoss.y + Math.sin(ang) * world.superBoss.rMiddle
    };
    shootBullet(b.x, b.y, ang, 9, "superBoss", 8, 10);
  }
}
function superBossSpawnDrone() {
  if (world.gameOver || world.superBoss.hp <= 0) return;
  const target = getClosestTarget(world.superBoss.x, world.superBoss.y);
  if (target) {
    world.superBoss.drones.push({
      x: world.superBoss.x, y: world.superBoss.y, r: 15, speed: 2, dmg: 99,
      targetType: target.type, targetRef: target.ref
    });
  }
}

/* ===== Player firing cadence ===== */
function playerFireTick(player) {
  const t = PERF.now();
  if (player.mainGunEnabled && t >= player.nextFireTime) {
    firePlayerGuns(player);
    player.nextFireTime = t + player.fireDelay;
  }
}

/* ===== Game tick ===== */
function activePlayer() {
  // Single-player focus; use first connected player
  const first = world.players.values().next();
  return first.done ? null : first.value;
}

function buildSnapshot() {
  const player = activePlayer();
  return {
    mapWidth: world.mapWidth,
    mapHeight: world.mapHeight,
    player,
    boss: world.boss,
    superBoss: world.superBoss,
    shapes: world.shapes,
    damagePopups: world.damagePopups.splice(0), // send and clear
    prompt: world.prompt,
    gameOver: world.gameOver
  };
}

function tick() {
  const player = activePlayer();
  if (player && !world.gameOver) {
    updatePlayerInputs(player);
    bossAI();
    superBossAI();
    updateShapes();
    playerFireTick(player);
    updatePlayerBullets(player);
    updateEnemyBullets(player);
    updatePlayerDrones(player);
    updateTraps(player);
    resolveEntityCollisions(player);
    checkLevelMilestones(player);
    checkDeath(player);
  }
  // broadcast snapshot
  io.emit("state", buildSnapshot());
}

setInterval(() => { if (!world.gameOver && world.shapes.length < 90) spawnShape(); }, 500);
setInterval(bossFire, 1000);
setInterval(superBossFireBottom, 2500);
setInterval(superBossFireMiddle, 1000);
setInterval(superBossSpawnDrone, 8000);
setInterval(() => {
  const p = activePlayer();
  if (p && p.path === "drone" && !world.prompt) {
    if (p.drones.length < p.droneMax) {
      const angle = Math.random() * Math.PI * 2;
      const spawnDist = p.r + 12;
      const nx = p.x + Math.cos(angle) * spawnDist;
      const ny = p.y + Math.sin(angle) * spawnDist;
      const newDrone = { x: nx, y: ny, r: p.droneRadius, speed: p.droneSpeed, hp: p.armoredDrones ? 2 : 1, nextShootTime: PERF.now() + 1800 };
      let collides = false;
      for (const d of p.drones) {
        if (Math.hypot(d.x - newDrone.x, d.y - newDrone.y) < d.r + newDrone.r) { collides = true; break; }
      }
      if (!collides) p.drones.push(newDrone);
    }
  }
}, 1000);

setInterval(tick, 1000 / 30); // 30 Hz

/* ===== Networking ===== */
io.on("connection", socket => {
  // Create player
  const player = makeDefaultPlayer();
  player.nextFireTime = PERF.now();
  world.players.set(socket.id, player);

  // Seed shapes
  if (world.shapes.length === 0) {
    for (let i = 0; i < 30; i++) spawnShape();
  }

  socket.on("input", payload => {
    if (!world.players.has(socket.id)) return;
    const p = world.players.get(socket.id);
    p.input = payload;
  });

  socket.on("switchPath", key => {
    const p = world.players.get(socket.id);
    if (!p) return;
    switchPath(p, key);
    world.prompt = null;
  });

  socket.on("applyUpgrade", key => {
    const p = world.players.get(socket.id);
    if (!p) return;
    applyUpgrade(p, key);
    world.prompt = null;
  });

  socket.on("tryPlaceTrap", () => {
    const p = world.players.get(socket.id);
    if (!p) return;
    tryPlaceTrap(p);
  });

  socket.on("respawn", () => {
    const p = world.players.get(socket.id);
    if (!p) return;
    // Reset player
    p.x = mapWidth / 2; p.y = mapHeight / 2;
    p.hp = 100; p.maxHp = 100; p.xp = 0; p.level = 1;
    p.path = null; p.mainGunEnabled = true;

    hardResetCombatState(p);

    // Reset bosses
    world.boss.x = 300; world.boss.y = 300; world.boss.hp = world.boss.maxHp; world.boss.angle = 0; world.boss.bullets = [];
    world.superBoss.x = 1200; world.superBoss.y = 900; world.superBoss.hp = world.superBoss.maxHp;
    world.superBoss.angleBottom = 0; world.superBoss.angleMiddle = 0; world.superBoss.angleTop = 0;
    world.superBoss.bullets = []; world.superBoss.drones = [];

    // Reset shapes
    world.shapes.length = 0;
    for (let i = 0; i < 30; i++) spawnShape();

    world.damagePopups.length = 0;
    world.prompt = null;
    world.gameOver = false;
  });

  socket.on("disconnect", () => {
    world.players.delete(socket.id);
  });
});

/* ===== Serve static (optional local testing) ===== */
app.get("/", (req, res) => {
  res.send("Server running");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
