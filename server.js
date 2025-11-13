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
let nextEntityId = 1;
const PERF = (typeof performance !== "undefined" && performance.now) ? performance : { now: () => Date.now() };

/* ===== World state ===== */
const world = {
  mapWidth, mapHeight,
  players: new Map(),
  shapes: [],
  boss: {
    id: "boss", x: 300, y: 300, r: 60, hp: 1000, maxHp: 1000,
    angle: 0, rotationSpeed: 0.01, bullets: [], speed: 1.5
  },
  superBoss: {
    id: "superBoss",
    x: 1200, y: 900,
    rBottom: 150, rMiddle: 112.5, rTop: 90,
    hp: 10000, maxHp: 10000,
    angleBottom: 0, angleMiddle: 0, angleTop: 0,
    rotBottom: 0.005, rotMiddle: -0.007, rotTop: 0.005,
    speed: 0.8,
    bullets: [], drones: []
  },
  damagePopups: []
};

/* ===== Utilities ===== */
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function addDamagePopup(x, y, amount, color = "white", duration = 1000) {
  world.damagePopups.push({ x, y, text: `${Math.max(1, Math.round(amount))}`, color, duration });
}
function randInRange(min, max) { return min + Math.random() * (max - min); }

/* ===== Player entity ===== */
function makeDefaultPlayer(id) {
  return {
    id,
    x: mapWidth / 2, y: mapHeight / 2, r: 20, speed: 3,
    angle: 0,
    hp: 100, maxHp: 100, xp: 0, level: 1, dead: false,
    bullets: [], drones: [], traps: [],
    path: null, mainGunEnabled: true,

    barrels: 1, bulletSize: 5, bulletDamage: 10,
    baseBasicDamage: 10, bulletDamageWall: 3,
    fireDelay: 300, nextFireTime: 0,

    alternatingFire: false, rotaryTurret: false, sideSponsons: false,
    scattershot: false, quadCore: false, artillery: false,
    wallOfLead: false, precisionBattery: false,

    dualBig: false, megaBullet: false, impactExplosive: false,
    piercingShells: false, clusterBomb: false, siegeMode: false,
    titanShell: false, twinSiege: false, shockwaveRound: false,

    // Drone path
    dronesEnabled: false,
    droneMax: 10, droneRadius: 8, droneSpeed: 4, droneDamage: 10,
    droneKamikazeBoost: false, droneGuardian: false, droneShooter: false,
    hiveExpansion: false, armoredDrones: false, snareDrones: false,
    droneCommander: false, explosiveDrones: false, hybridDrones: false,

    // Trap path
    trapLayer: false, trapMax: 10, trapBaseDamage: 10,
    trapBaseSize: 12, trapBaseCooldown: 2000, nextTrapTime: 0,
    trapDoubleLayer: false, trapBig: false, trapQuad: false,
    trapHuge: false, trapCluster: false, trapSentry: false,

    // Final forms
    isDreadnought: false,
    dreadType: null, // "cannon" | "drone"
    regenPerSec: 0,

    // Drone dread spawners + cap
    dreadDroneSpawnerA: 0, dreadDroneSpawnerB: 0,
    dreadDroneCap: 50, // HARD CAP set to 50 per your request

    _prompt: null,

    input: { keys: { w: false, a: false, s: false, d: false }, mouse: { x: 0, y: 0 }, camera: { x: 0, y: 0 } }
  };
}

function hardResetCombatState(p) {
  p.bullets = []; p.drones = []; p.traps = []; p.mainGunEnabled = true;

  p.barrels = 1; p.bulletSize = 5; p.bulletDamage = 10;
  p.baseBasicDamage = 10; p.bulletDamageWall = Math.round(p.baseBasicDamage / 3);
  p.fireDelay = 300;

  p.alternatingFire = false; p.rotaryTurret = false; p.sideSponsons = false;
  p.scattershot = false; p.quadCore = false; p.artillery = false;
  p.wallOfLead = false; p.precisionBattery = false;

  p.dualBig = false; p.megaBullet = false; p.impactExplosive = false;
  p.piercingShells = false; p.clusterBomb = false; p.siegeMode = false;
  p.titanShell = false; p.twinSiege = false; p.shockwaveRound = false;

  p.droneMax = 10; p.droneRadius = 8; p.droneSpeed = 4; p.droneDamage = 10;
  p.droneKamikazeBoost = false; p.droneGuardian = false; p.droneShooter = false;
  p.hiveExpansion = false; p.armoredDrones = false; p.snareDrones = false;
  p.droneCommander = false; p.explosiveDrones = false; p.hybridDrones = false;

  p.trapLayer = false; p.trapMax = 10; p.trapBaseDamage = 10; p.trapBaseSize = 12;
  p.trapBaseCooldown = 2000; p.nextTrapTime = 0;
  p.trapDoubleLayer = false; p.trapBig = false; p.trapQuad = false;
  p.trapHuge = false; p.trapCluster = false; p.trapSentry = false;

  p.isDreadnought = false; p.dreadType = null; p.regenPerSec = 0;
  p.dreadDroneSpawnerA = 0; p.dreadDroneSpawnerB = 0; p.dreadDroneCap = 50;

  p._prompt = null;
}

/* ===== Shapes ===== */
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
  let r = Math.random() * totalW, chosen = variants[0];
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

/* ===== Targeting helpers (kept for bosses/traps only) ===== */
function getClosestTarget(x, y, excludeOwnerId = null) {
  const candidates = [];
  for (const p of world.players.values()) {
    if (p.dead) continue;
    candidates.push({ x: p.x, y: p.y, type: "player", ref: p });
    if (p.path === "drone" || p.isDreadnought) {
      for (const d of p.drones) {
        candidates.push({ x: d.x, y: d.y, type: "drone", ref: { owner: p, d } });
      }
    }
  }
  if (world.boss.hp > 0) candidates.push({ x: world.boss.x, y: world.boss.y, type: "boss", ref: world.boss });

  if (world.shapes.length) {
    let nearest = null; let minD = Infinity;
    for (const s of world.shapes) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < minD) { minD = d; nearest = s; }
    }
    if (nearest) candidates.push({ x: nearest.x, y: nearest.y, type: "shape", ref: nearest });
  }

  if (!candidates.length) return null;
  let best = null, bestD = Infinity;
  for (const t of candidates) {
    if (excludeOwnerId && t.type === "player" && t.ref.id === excludeOwnerId) continue;
    const d = Math.hypot(t.x - x, t.y - y);
    if (d < bestD) { best = t; bestD = d; }
  }
  return best;
}
function resolveTarget(type, ref) {
  if (type === "player") return (ref && !ref.dead) ? ref : null;
  if (type === "boss") return world.boss.hp > 0 ? world.boss : null;
  if (type === "shape") return world.shapes.includes(ref) ? ref : null;
  if (type === "drone") {
    const owner = ref?.owner;
    const d = ref?.d;
    if (!owner || !d) return null;
    return owner.drones.includes(d) ? d : null;
  }
  return null;
}

/* ===== Shooting ===== */
function shootBulletForPlayer(player, x, y, angle, speed = 6, radiusOverride = null, damageOverride = null, extra = {}) {
  const dx = Math.cos(angle) * speed;
  const dy = Math.sin(angle) * speed;
  const r = radiusOverride ?? player.bulletSize;
  const baseDmg = damageOverride ?? player.bulletDamage;
  const bullet = {
    x, y, dx, dy, r, source: "player",
    dmg: baseDmg, ownerId: player.id,
    spawnTime: PERF.now(), lifeTime: 2000,
    explosive: player.impactExplosive || false,
    pierce: player.piercingShells ? 2 : 0,
    shockwave: player.shockwaveRound || false,
    hitCooldown: {},
    ...extra
  };
  player.bullets.push(bullet);
}

let altIndex = 0;
function firePlayerGuns(player) {
  if (!player.mainGunEnabled) return;

  // Dreadnought weapons
  if (player.isDreadnought && player.dreadType === "cannon") {
    const bx = player.x + Math.cos(player.angle) * player.r;
    const by = player.y + Math.sin(player.angle) * player.r;
    shootBulletForPlayer(player, bx, by, player.angle, 9, player.r * 0.9, 500, { lifeTime: 2200, pierce: 0 });
    return;
  }

  // Wall of Lead pattern
  if (player.wallOfLead) {
    for (let i = 0; i < 20; i++) {
      const offset = (i - 9.5) * 2;
      const bx = player.x + Math.cos(player.angle) * player.r + Math.cos(player.angle + Math.PI / 2) * offset;
      const by = player.y + Math.sin(player.angle) * player.r + Math.sin(player.angle + Math.PI / 2) * offset;
      shootBulletForPlayer(player, bx, by, player.angle, undefined, undefined, player.bulletDamageWall);
    }
    return;
  }

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
        shootBulletForPlayer(player, player.x + Math.cos(shotAngle) * player.r, player.y + Math.sin(shotAngle) * player.r, shotAngle, 3.8, player.bulletSize + 4, player.bulletDamage + 12);
      } else if (player.megaBullet) {
        shootBulletForPlayer(player, player.x + Math.cos(shotAngle) * player.r, player.y + Math.sin(shotAngle) * player.r, shotAngle, 4, player.bulletSize + 4, player.bulletDamage + 10);
      } else if (player.dualBig || player.twinSiege) {
        const lateral = 8;
        const lx = player.x + Math.cos(shotAngle + Math.PI / 2) * lateral;
        const ly = player.y + Math.sin(shotAngle + Math.PI / 2) * lateral;
        const rx = player.x + Math.cos(shotAngle - Math.PI / 2) * lateral;
        const ry = player.y + Math.sin(shotAngle - Math.PI / 2) * lateral;
        const speed = player.twinSiege ? 4.5 : 5;
        const size = player.twinSiege ? (player.bulletSize + 2) : player.bulletSize;
        const dmg  = player.twinSiege ? (player.bulletDamage + 6) : player.bulletDamage;
        shootBulletForPlayer(player, lx + Math.cos(shotAngle) * player.r, ly + Math.sin(shotAngle) * player.r, shotAngle, speed, size, dmg);
        shootBulletForPlayer(player, rx + Math.cos(shotAngle) * player.r, ry + Math.sin(shotAngle) * player.r, shotAngle, speed, size, dmg);
      } else {
        shootBulletForPlayer(player, player.x + Math.cos(shotAngle) * player.r, player.y + Math.sin(shotAngle) * player.r, shotAngle);
      }
    } else {
      shootBulletForPlayer(
        player,
        player.x + Math.cos(shotAngle) * player.r,
        player.y + Math.sin(shotAngle) * player.r,
        shotAngle,
        undefined,
        undefined,
        (multiDamageOverride !== null ? multiDamageOverride : undefined)
      );
    }
  };

  if (player.alternatingFire && !player.wallOfLead) {
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

/* ===== Traps ===== */
function tryPlaceTrap(player) {
  if (!player.trapLayer || player.dead) return;
  if (player.traps.length >= player.trapMax) return;
  const nowT = PERF.now();
  if (nowT < player.nextTrapTime) return;

  let count = 1;
  let dmg = player.trapBaseDamage;
  let size = player.trapBaseSize;
  let cooldown = player.trapBaseCooldown;
  let hp = 60;

  if (player.trapDoubleLayer) count = 2;
  if (player.trapBig) { dmg *= 3; size = 16; cooldown = Math.max(cooldown, 3000); hp = 200; }
  if (player.trapQuad) { count = 4; dmg = Math.floor(dmg * 0.8); }
  if (player.trapHuge) { dmg = player.trapBaseDamage * 9; size = 20; cooldown = Math.max(cooldown, 4000); hp = 200; }

  const isCluster = player.trapCluster;
  const isSentry = player.trapSentry;
  if (isCluster) { size = 20; hp = 200; cooldown = Math.max(cooldown, 4000); }

  const spread = count > 1 ? 0.2 : 0;
  const flySpeed = 6;
  const flyDuration = 300;

  for (let i = 0; i < count; i++) {
    const offset = (i - (count - 1) / 2) * spread;
    const ang = player.angle + offset;
    const tx = player.x + Math.cos(ang) * (player.r + 30);
    const ty = player.y + Math.sin(ang) * (player.r + 30);
    player.traps.push({
      x: tx, y: ty, r: size, dmg, hp, maxHp: hp,
      ownerId: player.id,
      cluster: isCluster, sentry: isSentry,
      nextSentryShot: PERF.now() + 1500,
      vx: Math.cos(ang) * flySpeed, vy: Math.sin(ang) * flySpeed,
      stopTime: PERF.now() + flyDuration,
      spawnTime: PERF.now()
    });
  }
  player.nextTrapTime = nowT + cooldown;
}

function trapClusterExplode(owner, t) {
  const count = 5;
  const shardDamage = 15;
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dx = Math.cos(ang) * 7;
    const dy = Math.sin(ang) * 7;
    owner.bullets.push({
      x: t.x, y: t.y, dx, dy,
      r: 3, source: "player", ownerId: owner.id, dmg: shardDamage,
      spawnTime: PERF.now(), lifeTime: 500, explosive: false, pierce: 0, shockwave: false, hitCooldown: {}
    });
  }
}
function spawnFragments(owner, x, y, baseDmg) {
  const count = 10;
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dx = Math.cos(ang) * 6;
    const dy = Math.sin(ang) * 6;
    owner.bullets.push({
      x, y, dx, dy,
      r: 3, source: "player", ownerId: owner.id, dmg: Math.floor(baseDmg * 0.4),
      spawnTime: PERF.now(), lifeTime: 500, explosive: false, pierce: 0, shockwave: false, hitCooldown: {}
    });
  }
}

/* ===== Movement & AI ===== */
function updatePlayerInputs(player) {
  if (player.dead) return;
  const { keys, mouse, camera } = player.input;
  if (keys.w) player.y -= player.speed;
  if (keys.s) player.y += player.speed;
  if (keys.a) player.x -= player.speed;
  if (keys.d) player.x += player.speed;
  player.x = clamp(player.x, player.r, mapWidth - player.r);
  player.y = clamp(player.y, player.r, mapHeight - player.r);

  // Aim follows mouse + camera offset
  const dxAim = mouse.x + (camera?.x || 0) - player.x;
  const dyAim = mouse.y + (camera?.y || 0) - player.y;
  player.angle = Math.atan2(dyAim, dxAim);
}

function bossAI() {
  if (world.boss.hp <= 0) return;
  const tgt = getClosestTarget(world.boss.x, world.boss.y);
  if (!tgt) return;
  const dx = tgt.x - world.boss.x;
  const dy = tgt.y - world.boss.y;
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

  world.superBoss.angleBottom += world.superBoss.rotBottom;
  world.superBoss.angleMiddle += world.superBoss.rotMiddle;
  world.superBoss.angleTop += world.superBoss.rotTop;

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
        target.hp = Math.max(0, target.hp - d.dmg);
        if (target.hp <= 0) target.dead = true;
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
        const owner = d.targetRef?.owner;
        const drone = d.targetRef?.d;
        if (owner && drone) {
          const idx = owner.drones.indexOf(drone);
          if (idx !== -1) owner.drones.splice(idx, 1);
        }
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

/* ===== Collisions & bullets ===== */
function awardBossKill(xpAward, killerId) {
  const killer = world.players.get(killerId);
  if (killer) killer.xp += xpAward;
  // 60-second respawn (cooldown)
  world.boss.hp = 0;
  world.boss.bullets = [];
  addDamagePopup(world.boss.x, world.boss.y - world.boss.r - 12, "Boss Defeated", "#ffffff");
  if (!world._bossRespawnTimer) {
    world._bossRespawnTimer = setTimeout(() => {
      world.boss.hp = world.boss.maxHp;
      world.boss.x = randInRange(world.boss.r, mapWidth - world.boss.r);
      world.boss.y = randInRange(world.boss.r, mapHeight - world.boss.r);
      world.boss.bullets = [];
      addDamagePopup(world.boss.x, world.boss.y - world.boss.r - 12, "Respawn", "#ffffff");
      world._bossRespawnTimer = null;
    }, 60000);
  }
}

function updatePlayerBullets() {
  for (const player of world.players.values()) {
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

      // SuperBoss hit
      if (world.superBoss.hp > 0) {
        const entityIdSB = world.superBoss.id;
        const immuneUntilSB = b.hitCooldown[entityIdSB] ?? 0;
        if (PERF.now() >= immuneUntilSB) {
          const d = Math.hypot(world.superBoss.x - b.x, world.superBoss.y - b.y);
          if (d < world.superBoss.rBottom + b.r) {
            world.superBoss.hp = Math.max(0, world.superBoss.hp - b.dmg);
            addDamagePopup(world.superBoss.x, world.superBoss.y - world.superBoss.rBottom - 12, b.dmg, "#ff66ff");
            tryExplodeSplash();
            if (player.clusterBomb) spawnFragments(player, b.x, b.y, b.dmg);
            b.hitCooldown[entityIdSB] = PERF.now() + IMMUNITY_MS;
            if (b.pierce > 0) b.pierce--; else player.bullets.splice(i, 1);
            continue;
          }
        }
      }

      // Boss hit
      if (world.boss.hp > 0) {
        const entityIdB = world.boss.id;
        const immuneUntilB = b.hitCooldown[entityIdB] ?? 0;
        if (PERF.now() >= immuneUntilB) {
          const distBoss = Math.hypot(world.boss.x - b.x, world.boss.y - b.y);
          if (distBoss < world.boss.r + b.r) {
            world.boss.hp = Math.max(0, world.boss.hp - b.dmg);
            addDamagePopup(world.boss.x, world.boss.y - world.boss.r - 12, b.dmg, "#ffffff");
            if (b.shockwave) { world.boss.x += b.dx * 2; world.boss.y += b.dy * 2; }
            tryExplodeSplash();
            if (player.clusterBomb) spawnFragments(player, b.x, b.y, b.dmg);
            b.hitCooldown[entityIdB] = PERF.now() + IMMUNITY_MS;

            if (world.boss.hp <= 0) {
              awardBossKill(2000, b.ownerId);
            }

            if (b.pierce > 0) b.pierce--; else player.bullets.splice(i, 1);
            continue;
          }
        }
      }

      // PvP
      for (const other of world.players.values()) {
        if (other.dead || other.id === player.id) continue;
        const entityId = other.id;
        const immuneUntil = b.hitCooldown[entityId] ?? 0;
        if (PERF.now() < immuneUntil) continue;
        const distP = Math.hypot(other.x - b.x, other.y - b.y);
        if (distP < other.r + b.r) {
          other.hp = Math.max(0, other.hp - b.dmg);
          addDamagePopup(other.x, other.y - other.r - 12, b.dmg, "#ffff66");
          b.hitCooldown[entityId] = PERF.now() + IMMUNITY_MS;
          if (other.hp <= 0) other.dead = true;
          if (player.clusterBomb) spawnFragments(player, b.x, b.y, b.dmg);
          if (b.pierce > 0) b.pierce--; else player.bullets.splice(i, 1);
          break;
        }
      }

      // Shapes
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
}

function updateEnemyBullets() {
  for (const set of [world.boss.bullets, world.superBoss.bullets]) {
    for (let i = set.length - 1; i >= 0; i--) {
      const b = set[i];
      if (PERF.now() - b.spawnTime > b.lifeTime) { set.splice(i, 1); continue; }
      b.x += b.dx; b.y += b.dy;
      if (b.x < 0 || b.y < 0 || b.x > mapWidth || b.y > mapHeight) { set.splice(i, 1); continue; }

      for (const player of world.players.values()) {
        if (player.dead) continue;
        const distP = Math.hypot(player.x - b.x, player.y - b.y);
        if (distP < player.r + b.r) { player.hp = Math.max(0, player.hp - b.dmg); set.splice(i, 1); if (player.hp <= 0) player.dead = true; break; }
      }

      if (set === world.superBoss.bullets) {
        let hit = false;
        for (let si = world.shapes.length - 1; si >= 0; si--) {
          const s = world.shapes[si];
          const distS = Math.hypot(s.x - b.x, s.y - b.y);
          if (distS < s.r + b.r) {
            s.hp -= b.dmg;
            addDamagePopup(s.x, s.y - s.r - 12, b.dmg, "#ff66ff");
            if (s.hp <= 0) { world.shapes.splice(si, 1); }
            set.splice(i, 1); hit = true; break;
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

        for (const owner of world.players.values()) {
          for (let di = owner.drones.length - 1; di >= 0; di--) {
            const d = owner.drones[di];
            const distD = Math.hypot(d.x - b.x, d.y - b.y);
            if (distD < d.r + b.r) { owner.drones.splice(di, 1); set.splice(i, 1); break; }
          }
        }
      }
    }
  }
}

/* ===== Drone Dread spawners ===== */
function spawnDreadDrone(owner, fromAngle) {
  const spawnDist = owner.r + 10;
  const dx = Math.cos(fromAngle), dy = Math.sin(fromAngle);
  const x = owner.x + dx * spawnDist, y = owner.y + dy * spawnDist;
  owner.drones.push({
    x, y, r: 10, speed: 4, hp: 1, spawnTime: PERF.now(),
    superDrone: true, contactDamage: 30,
    nextShootTime: PERF.now() + 3000, ownerId: owner.id
  });
}

/* ===== Drones & Traps updates ===== */
function removeDroneOnHit(owner, di) {
  const d = owner.drones[di];
  if (owner.explosiveDrones && !d.superDrone) {
    for (let si = world.shapes.length - 1; si >= 0; si--) {
      const s = world.shapes[si];
      const dist = Math.hypot(s.x - d.x, s.y - d.y);
      if (dist < 40) {
        s.hp -= 10;
        addDamagePopup(s.x, s.y - s.r - 12, 10, "yellow");
        if (s.hp <= 0) { world.shapes.splice(si, 1); owner.xp += s.xp ?? 10; }
      }
    }
  }
  if (!d.superDrone && owner.armoredDrones && d.hp > 1) d.hp -= 1;
  else owner.drones.splice(di, 1);
}

function updatePlayerDrones() {
  for (const owner of world.players.values()) {
    const isDroneClass = owner.path === "drone";
    const isDroneDread = owner.isDreadnought && owner.dreadType === "drone";
    if ((!isDroneClass && !isDroneDread) || owner.dead) continue;

    // Drone Dread spawners: respect CAP=50 and spawn rate (2 each every 0.5s)
    if (isDroneDread) {
      const now = PERF.now();
      if (owner.drones.length < owner.dreadDroneCap) {
        if (now >= owner.dreadDroneSpawnerA) {
          const angA = owner.angle - 0.25;
          spawnDreadDrone(owner, angA);
          spawnDreadDrone(owner, angA);
          owner.dreadDroneSpawnerA = now + 500;
        }
        if (now >= owner.dreadDroneSpawnerB) {
          const angB = owner.angle + 0.25;
          spawnDreadDrone(owner, angB);
          spawnDreadDrone(owner, angB);
          owner.dreadDroneSpawnerB = now + 500;
        }
      } else {
        owner.dreadDroneSpawnerA = now + 200;
        owner.dreadDroneSpawnerB = now + 200;
      }
    }

    for (let di = owner.drones.length - 1; di >= 0; di--) {
      const d = owner.drones[di];

      // Despawn after ~30s
      if (d.spawnTime && PERF.now() - d.spawnTime > 30000) { owner.drones.splice(di, 1); continue; }

      // Movement — ONLY follow mouse (ignore targets)
      const tx = owner.input.mouse.x + (owner.input.camera?.x || 0);
      const ty = owner.input.mouse.y + (owner.input.camera?.y || 0);
      const dx = tx - d.x, dy = ty - d.y;
      const distToMouse = Math.hypot(dx, dy);
      if (distToMouse > 0.001) { d.x += (dx / distToMouse) * d.speed; d.y += (dy / distToMouse) * d.speed; }
      d.x = clamp(d.x, d.r, mapWidth - d.r);
      d.y = clamp(d.y, d.r, mapHeight - d.r);

      let collided = false;

      // Contact with shapes
      for (let si = world.shapes.length - 1; si >= 0; si--) {
        const s = world.shapes[si];
        const dist = Math.hypot(s.x - d.x, s.y - d.y);
        if (dist < s.r + d.r) {
          const dmg = d.superDrone ? d.contactDamage : (owner.droneKamikazeBoost ? Math.round(owner.droneDamage * 1.5) : owner.droneDamage);
          s.hp -= dmg;
          addDamagePopup(s.x, s.y - s.r - 12, dmg, "yellow");
          if (owner.snareDrones) { s.dx *= 0.8; s.dy *= 0.8; }
          if (s.hp <= 0) { world.shapes.splice(si, 1); owner.xp += s.xp ?? 10; }
          removeDroneOnHit(owner, di);
          collided = true;
          break;
        }
      }
      if (collided) continue;

      // Contact with boss
      if (world.boss.hp > 0) {
        const distB = Math.hypot(world.boss.x - d.x, world.boss.y - d.y);
        if (distB < world.boss.r + d.r) {
          const dmg = d.superDrone ? d.contactDamage : (owner.droneKamikazeBoost ? Math.round(owner.droneDamage * 1.5) : owner.droneDamage);
          world.boss.hp = Math.max(0, world.boss.hp - dmg);
          addDamagePopup(world.boss.x, world.boss.y - world.boss.r - 12, dmg, "yellow");
          if (world.boss.hp <= 0) awardBossKill(2000, owner.id);
          removeDroneOnHit(owner, di);
          continue;
        }
      }

      // Contact with superBoss
      if (world.superBoss.hp > 0) {
        const distSB = Math.hypot(world.superBoss.x - d.x, world.superBoss.y - d.y);
        if (distSB < world.superBoss.rBottom + d.r) {
          const dmg = d.superDrone ? d.contactDamage : (owner.droneKamikazeBoost ? Math.round(owner.droneDamage * 1.5) : owner.droneDamage);
          world.superBoss.hp = Math.max(0, world.superBoss.hp - dmg);
          addDamagePopup(world.superBoss.x, world.superBoss.y - world.superBoss.rBottom - 12, dmg, "yellow");
          removeDroneOnHit(owner, di);
          continue;
        }
      }

      // Contact with other players
      for (const other of world.players.values()) {
        if (other.dead || other.id === owner.id) continue;
        const distO = Math.hypot(other.x - d.x, other.y - d.y);
        if (distO < other.r + d.r) {
          const dmg = d.superDrone ? d.contactDamage : (owner.droneKamikazeBoost ? Math.round(owner.droneDamage * 1.5) : owner.droneDamage);
          other.hp = Math.max(0, other.hp - dmg);
          addDamagePopup(other.x, other.y - other.r - 12, dmg, "yellow");
          if (other.hp <= 0) other.dead = true;
          removeDroneOnHit(owner, di);
          break;
        }
      }

      // Shooting — aim at mouse (ignore targets)
      const shooterEnabled = owner.droneShooter || owner.hybridDrones || d.superDrone;
      const shooterInterval = d.superDrone ? 3000 : 1800;
      const dmgPerShot = d.superDrone ? 10 : 6;
      if (shooterEnabled) {
        if (!d.nextShootTime) d.nextShootTime = PERF.now() + shooterInterval;
        if (PERF.now() >= d.nextShootTime) {
          const aimX = owner.input.mouse.x + (owner.input.camera?.x || 0);
          const aimY = owner.input.mouse.y + (owner.input.camera?.y || 0);
          const ang = Math.atan2(aimY - d.y, aimX - d.x);
          owner.bullets.push({
            x: d.x, y: d.y,
            dx: Math.cos(ang) * 7, dy: Math.sin(ang) * 7,
            r: 4, source: "player", ownerId: owner.id, dmg: dmgPerShot,
            explosive: false, pierce: 0,
            spawnTime: PERF.now(), lifeTime: 2000, hitCooldown: {}
          });
          d.nextShootTime = PERF.now() + shooterInterval;
        }
      }
    }

    // Guardian: slow enemy bullets on contact
    const enemySets = [world.boss.bullets, world.superBoss.bullets];
    if (owner.droneGuardian) {
      for (const d of owner.drones) {
        for (const set of enemySets) {
          for (const b of set) {
            const dist = Math.hypot(d.x - b.x, d.y - b.y);
            if (dist < d.r + b.r) { b.dx *= 0.7; b.dy *= 0.7; }
          }
        }
      }
    }
  }
}

function updateTraps() {
  for (const owner of world.players.values()) {
    for (let ti = owner.traps.length - 1; ti >= 0; ti--) {
      const t = owner.traps[ti];

      // Despawn after ~30s
      if (t.spawnTime && PERF.now() - t.spawnTime > 30000) { owner.traps.splice(ti, 1); continue; }

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
            owner.bullets.push({
              x: t.x, y: t.y, dx: Math.cos(ang) * 5.5, dy: Math.sin(ang) * 5.5,
              r: 4, source: "player", ownerId: owner.id, dmg: 3,
              spawnTime: PERF.now(), lifeTime: 2000, explosive: false, pierce: 0, hitCooldown: {}
            });
          }
          t.nextSentryShot = nowShot + 1500;
        }
      }

      // Enemy bullets vs traps
      for (const set of [world.boss.bullets, world.superBoss.bullets]) {
        for (let bi = set.length - 1; bi >= 0; bi--) {
          const b = set[bi];
          const dist = Math.hypot(t.x - b.x, t.y - b.y);
          if (dist < t.r + b.r) {
            t.hp -= b.dmg;
            if (t.hp <= 0) {
              if (t.cluster) trapClusterExplode(owner, t);
              owner.traps.splice(ti, 1);
            }
            set.splice(bi, 1);
          }
        }
      }
      if (!owner.traps[ti]) continue;

      // Trap contacts
      for (let si = world.shapes.length - 1; si >= 0; si--) {
        const s = world.shapes[si];
        const dist = Math.hypot(t.x - s.x, t.y - s.y);
        if (dist < t.r + s.r) {
          s.hp -= t.dmg;
          addDamagePopup(s.x, s.y - s.r - 12, t.dmg, "#66ff66");
          if (s.hp <= 0) { world.shapes.splice(si, 1); owner.xp += s.xp ?? 10; }
          if (t.cluster) trapClusterExplode(owner, t);
          owner.traps.splice(ti, 1);
          break;
        }
      }
      if (!owner.traps[ti]) continue;

      if (world.boss.hp > 0) {
        const distB = Math.hypot(t.x - world.boss.x, t.y - world.boss.y);
        if (distB < t.r + world.boss.r) {
          world.boss.hp = Math.max(0, world.boss.hp - t.dmg);
          addDamagePopup(world.boss.x, world.boss.y - world.boss.r - 12, t.dmg, "#66ff66");
          if (world.boss.hp <= 0) awardBossKill(2000, owner.id);
          if (t.cluster) trapClusterExplode(owner, t);
          owner.traps.splice(ti, 1);
          continue;
        }
      }

      if (world.superBoss.hp > 0) {
        const distSB = Math.hypot(t.x - world.superBoss.x, t.y - world.superBoss.y);
        if (distSB < t.r + world.superBoss.rBottom) {
          world.superBoss.hp = Math.max(0, world.superBoss.hp - t.dmg);
          addDamagePopup(world.superBoss.x, world.superBoss.y - world.superBoss.rBottom - 12, t.dmg, "#66ff66");
          if (t.cluster) trapClusterExplode(owner, t);
          owner.traps.splice(ti, 1);
          continue;
        }
      }

      for (const other of world.players.values()) {
        if (other.dead || other.id === owner.id) continue;
        const distO = Math.hypot(t.x - other.x, t.y - other.y);
        if (distO < t.r + other.r) {
          other.hp = Math.max(0, other.hp - t.dmg);
          addDamagePopup(other.x, other.y - other.r - 12, t.dmg, "#66ff66");
          if (other.hp <= 0) other.dead = true;
          if (t.cluster) trapClusterExplode(owner, t);
          owner.traps.splice(ti, 1);
          break;
        }
      }
    }
  }
}

function resolveEntityCollisions() {
  const entities = [];

  for (const p of world.players.values()) {
    if (p.dead) continue;
    entities.push({ ref: p, type: "player", ownerId: p.id, x: p.x, y: p.y, r: p.r, mass: 1.0, movable: true });

    for (const d of p.drones) entities.push({ ref: d, type: "playerDrone", ownerId: p.id, x: d.x, y: d.y, r: d.r, mass: 0.3, movable: true });
    for (const t of p.traps) entities.push({ ref: t, type: "playerTrap", ownerId: p.id, x: t.x, y: t.y, r: t.r, mass: 0.6, movable: true });
  }
  if (world.boss.hp > 0) entities.push({ ref: world.boss, type: "boss", ownerId: null, x: world.boss.x, y: world.boss.y, r: world.boss.r, mass: 3.0, movable: true });
  if (world.superBoss.hp > 0) entities.push({ ref: world.superBoss, type: "superBoss", ownerId: null, x: world.superBoss.x, y: world.superBoss.y, r: world.superBoss.rBottom, mass: 5.0, movable: true });
  for (const s of world.shapes) entities.push({ ref: s, type: "shape", ownerId: null, x: s.x, y: s.y, r: s.r, mass: 0.8, movable: true });

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

        if (A.type === "player" && (B.type === "playerDrone" || B.type === "playerTrap") && A.ownerId === B.ownerId) {
          moveA = 0; moveB = overlap;
        } else if (B.type === "player" && (A.type === "playerDrone" || A.type === "playerTrap") && B.ownerId === A.ownerId) {
          moveB = 0; moveA = overlap;
        }

        if (A.movable) {
          A.ref.x -= ux * moveA; A.ref.y -= uy * moveA;
          A.ref.x = clamp(A.ref.x, A.r, mapWidth - A.r); A.ref.y = clamp(A.ref.y, A.r, mapHeight - A.r);
        }
        if (B.movable) {
          B.ref.x += ux * moveB; B.ref.y += uy * moveB;
          B.ref.x = clamp(B.ref.x, B.r, mapWidth - B.r); B.ref.y = clamp(B.ref.y, B.r, mapHeight - B.r);
        }
      }
    }
  }
}

/* ===== Level, death, timers ===== */
function checkLevelMilestones(player) {
  if (player.dead) return;
  const threshold = player.level * 50;
  if (player.level < 100 && player.xp >= threshold) {
    player.level++;
    player.maxHp += 10;
    player.hp = player.maxHp;

    if (!player.path && player.level >= 3 && player.level % 3 === 0 && player.level <= 12) {
      player._prompt = { type: "path" };
    } else if (player.path && player.level % 3 === 0 && player.level <= 12) {
      player._prompt = { type: "subUpgrade", level: player.level };
    }
    if (player.level === 100 && !player.isDreadnought) {
      player._prompt = { type: "finalDread" };
    }
  }
}

function bossFire() {
  if (world.boss.hp <= 0) return;
  const tgt = getClosestTarget(world.boss.x, world.boss.y);
  if (!tgt) return;
  const aimBase = Math.atan2(tgt.y - world.boss.y, tgt.x - world.boss.x);
  for (let i = 0; i < 5; i++) {
    const gunAngle = world.boss.angle + i * (Math.PI * 2 / 5);
    const wiggle = (Math.random() - 0.5) * 0.15;
    const aimAngle = aimBase + wiggle;
    world.boss.bullets.push({
      x: world.boss.x + Math.cos(gunAngle) * world.boss.r,
      y: world.boss.y + Math.sin(gunAngle) * world.boss.r,
      dx: Math.cos(aimAngle) * 4, dy: Math.sin(aimAngle) * 4,
      r: 5, dmg: 10, spawnTime: PERF.now(), lifeTime: 2000
    });
  }
}
function superBossFireBottom() {
  if (world.superBoss.hp <= 0) return;
  for (let i = 0; i < 6; i++) {
    const ang = world.superBoss.angleBottom + i * (Math.PI * 2 / 6);
    world.superBoss.bullets.push({
      x: world.superBoss.x + Math.cos(ang) * world.superBoss.rBottom,
      y: world.superBoss.y + Math.sin(ang) * world.superBoss.rBottom,
      dx: Math.cos(ang) * 10, dy: Math.sin(ang) * 10,
      r: 20, dmg: 70, spawnTime: PERF.now(), lifeTime: 2000
    });
  }
}
function superBossFireMiddle() {
  if (world.superBoss.hp <= 0) return;
  for (let i = 0; i < 15; i++) {
    const ang = world.superBoss.angleMiddle + i * (Math.PI * 2 / 15);
    world.superBoss.bullets.push({
      x: world.superBoss.x + Math.cos(ang) * world.superBoss.rMiddle,
      y: world.superBoss.y + Math.sin(ang) * world.superBoss.rMiddle,
      dx: Math.cos(ang) * 9, dy: Math.sin(ang) * 9,
      r: 8, dmg: 10, spawnTime: PERF.now(), lifeTime: 2000
    });
  }
}
function superBossSpawnDrone() {
  if (world.superBoss.hp <= 0) return;
  const target = getClosestTarget(world.superBoss.x, world.superBoss.y);
  if (target) {
    world.superBoss.drones.push({
      x: world.superBoss.x, y: world.superBoss.y, r: 15, speed: 2, dmg: 99,
      targetType: target.type, targetRef: target.ref
    });
  }
}

function firePlayerGunsTick(player) {
  const t = PERF.now();
  if (!player.dead && player.mainGunEnabled && t >= player.nextFireTime) {
    firePlayerGuns(player);
    const altActive = player.alternatingFire && !player.wallOfLead;
    const dreadDelay = (player.isDreadnought && player.dreadType === "cannon") ? 600 : player.fireDelay;
    player.nextFireTime = t + (altActive ? 100 : dreadDelay);
  }
}
function droneRespawnTick() {
  for (const p of world.players.values()) {
    if (p.dead) continue;
    if (p.path === "drone") {
      if (p.drones.length < p.droneMax) {
        const angle = Math.random() * Math.PI * 2;
        const spawnDist = p.r + 12;
        const nx = p.x + Math.cos(angle) * spawnDist;
        const ny = p.y + Math.sin(angle) * spawnDist;
        const newDrone = { x: nx, y: ny, r: p.droneRadius, speed: p.droneSpeed, hp: p.armoredDrones ? 2 : 1, nextShootTime: PERF.now() + 1800, spawnTime: PERF.now(), ownerId: p.id };
        let collides = false;
        for (const d of p.drones) {
          if (Math.hypot(d.x - newDrone.x, d.y - newDrone.y) < d.r + newDrone.r) { collides = true; break; }
        }
        if (!collides) p.drones.push(newDrone);
      }
    }
  }
}

/* ===== Snapshot ===== */
function updateCrowns() {
  let best = null;
  for (const p of world.players.values()) {
    if (p.dead) continue;
    if (!best || p.xp > best.xp) best = p;
  }
  for (const p of world.players.values()) {
    p.hasCrown = (best && p.id === best.id);
  }
}
function buildSnapshotForClient(forPlayerId) {
  updateCrowns();
  return {
    mapWidth: world.mapWidth,
    mapHeight: world.mapHeight,
    players: Array.from(world.players.values()).map(p => ({
      id: p.id,
      x: p.x, y: p.y, r: p.r, angle: p.angle,
      hp: p.hp, maxHp: p.maxHp, xp: p.xp, level: p.level, dead: p.dead,
      path: p.path, mainGunEnabled: p.mainGunEnabled, barrels: p.barrels,
      bulletSize: p.bulletSize, bulletDamage: p.bulletDamage,
      precisionBattery: p.precisionBattery, sideSponsons: p.sideSponsons,
      traps: p.traps, drones: p.drones, bullets: p.bullets,
      trapLayer: p.trapLayer, trapMax: p.trapMax, nextTrapTime: p.nextTrapTime,
      wallOfLead: p.wallOfLead, alternatingFire: p.alternatingFire,
      isDreadnought: p.isDreadnought, dreadType: p.dreadType,
      hasCrown: p.hasCrown || false
    })),
    boss: world.boss,
    superBoss: world.superBoss,
    shapes: world.shapes,
    damagePopups: world.damagePopups.splice(0),
    prompt: world.players.get(forPlayerId)?._prompt || null,
    gameOver: false
  };
}

/* ===== Game tick ===== */
function tick() {
  for (const p of world.players.values()) {
    updatePlayerInputs(p);
    firePlayerGunsTick(p);
    checkLevelMilestones(p);

    // Cannon dread regen: 10 hp/sec
    if (p.isDreadnought && p.dreadType === "cannon" && !p.dead) {
      const regenPerTick = p.regenPerSec / 30;
      p.hp = Math.min(p.maxHp, p.hp + regenPerTick);
    }
  }
  bossAI();
  superBossAI();
  updateShapes();
  updatePlayerBullets();
  updateEnemyBullets();
  updatePlayerDrones();
  updateTraps();
  resolveEntityCollisions();

  for (const [id] of world.players) {
    const sock = io.sockets.sockets.get(id);
    if (sock) sock.emit("state", buildSnapshotForClient(id));
  }

  for (const p of world.players.values()) p._prompt = null;
}

/* ===== Spawners & tick timers ===== */
setInterval(() => { if (world.shapes.length < 180) spawnShape(); }, 250); // faster shapes, kept from your build
setInterval(bossFire, 1000);
setInterval(superBossFireBottom, 2500);
setInterval(superBossFireMiddle, 1000);
setInterval(superBossSpawnDrone, 8000);
setInterval(droneRespawnTick, 1000);
setInterval(tick, 1000 / 30);

/* ===== Networking ===== */
io.on("connection", socket => {
  const player = makeDefaultPlayer(socket.id);
  player.nextFireTime = PERF.now();
  world.players.set(socket.id, player);

  if (world.shapes.length === 0) for (let i = 0; i < 30; i++) spawnShape();

  socket.on("input", payload => {
    const p = world.players.get(socket.id);
    if (!p) return;
    if (!payload || !payload.keys || !payload.mouse || !payload.camera) return;
    p.input = payload;
  });

  socket.on("switchPath", key => {
    const p = world.players.get(socket.id);
    if (!p) return;
    hardResetCombatState(p);
    p.path = key;

    if (key === "multi") { p.mainGunEnabled = true; p.barrels = 3; }
    else if (key === "big") { p.mainGunEnabled = true; p.bulletSize = 12; p.bulletDamage = 25; p.baseBasicDamage = 10; p.bulletDamageWall = Math.round(p.baseBasicDamage / 3); }
    else if (key === "drone") {
      p.mainGunEnabled = false;
      for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * Math.PI * 2;
        p.drones.push({
          x: p.x + Math.cos(ang) * (p.r + 12),
          y: p.y + Math.sin(ang) * (p.r + 12),
          r: p.droneRadius, speed: p.droneSpeed, hp: p.armoredDrones ? 2 : 1,
          nextShootTime: PERF.now() + 1800,
          spawnTime: PERF.now(),
          ownerId: p.id
        });
      }
    } else if (key === "trap") {
      p.mainGunEnabled = true;
      p.trapLayer = true; p.trapBaseDamage = 10; p.trapBaseSize = 12; p.trapBaseCooldown = 2000; p.nextTrapTime = 0;
    }
  });

  socket.on("applyUpgrade", key => {
    const p = world.players.get(socket.id);
    if (!p) return;
    // Drone upgrades
    if (key === "droneKamikazeBoost") p.droneKamikazeBoost = true;
    if (key === "droneGuardian") p.droneGuardian = true;
    if (key === "droneShooter") { p.droneShooter = true; const t = PERF.now(); for (const d of p.drones) d.nextShootTime = t + 1800; }
    if (key === "hiveExpansion") { p.hiveExpansion = true; p.droneMax = 15; }
    if (key === "armoredDrones") p.armoredDrones = true;
    if (key === "snareDrones") p.snareDrones = true;
    if (key === "droneCommander") { p.droneCommander = true; p.droneMax = 30; }
    if (key === "explosiveDrones") p.explosiveDrones = true;
    if (key === "hybridDrones") { p.hybridDrones = true; const t = PERF.now(); for (const d of p.drones) d.nextShootTime = t + 1800; }
    // Multi
    if (key === "alternatingFire") p.alternatingFire = true;
    if (key === "rotaryTurret") p.rotaryTurret = true;
    if (key === "sideSponsons") p.sideSponsons = true;
    if (key === "scattershot") p.scattershot = true;
    if (key === "quadCore") { p.quadCore = true; p.barrels = Math.min(p.barrels + 1, 6); }
    if (key === "artillery") { p.artillery = true; p.fireDelay = Math.round(p.fireDelay * 1.2); }
    if (key === "wallOfLead") { p.wallOfLead = true; p.barrels = Math.min(p.barrels + 2, 8); p.bulletDamageWall = Math.round(p.baseBasicDamage / 3); }
    if (key === "precisionBattery") p.precisionBattery = true;
    if (key === "piercingShells") p.piercingShells = true;
    // Big
    if (key === "dualBig") p.dualBig = true;
    if (key === "megaBullet") { p.megaBullet = true; p.bulletSize += 4; p.bulletDamage += 10; }
    if (key === "impactExplosive") p.impactExplosive = true;
    if (key === "clusterBomb") p.clusterBomb = true;
    if (key === "siegeMode") { p.siegeMode = true; p.bulletDamage += 8; p.fireDelay = Math.round(p.fireDelay * 1.3); }
    if (key === "titanShell") { p.titanShell = true; p.bulletSize += 4; p.bulletDamage += 12; }
    if (key === "twinSiege") p.twinSiege = true;
    if (key === "shockwaveRound") p.shockwaveRound = true;
    // Trap
    if (key === "trapDoubleLayer") p.trapDoubleLayer = true;
    if (key === "trapBig") p.trapBig = true;
    if (key === "trapQuad") p.trapQuad = true;
    if (key === "trapHuge") p.trapHuge = true;
    if (key === "trapCluster") { p.trapCluster = true; p.trapHuge = true; }
    if (key === "trapSentry") p.trapSentry = true;
  });

  // Final form
  socket.on("finalPick", key => {
    const p = world.players.get(socket.id);
    if (!p || p.isDreadnought || p.level < 100) return;
    p.isDreadnought = true;
    p.path = null;
    if (key === "dreadCannon") {
      p.dreadType = "cannon";
      p.r = 20 * 4;
      p.speed = 3 * 0.9;
      p.maxHp = 3000; p.hp = p.maxHp;
      p.regenPerSec = 10;
      p.mainGunEnabled = true;
      p.barrels = 1; p.alternatingFire = false; p.wallOfLead = false;
    } else if (key === "dreadDrone") {
      p.dreadType = "drone";
      p.r = 20 * 4;
      p.speed = 3 * 0.9;
      p.maxHp = 2500; p.hp = p.maxHp;
      p.regenPerSec = 0;
      p.mainGunEnabled = false;
      p.dreadDroneSpawnerA = PERF.now();
      p.dreadDroneSpawnerB = PERF.now();
      p.dreadDroneCap = 50; // enforce cap
    }
  });

  // Place trap
  socket.on("tryPlaceTrap", () => {
    const p = world.players.get(socket.id);
    if (!p) return;
    tryPlaceTrap(p);
  });

  // Respawn
  socket.on("respawn", () => {
    const fresh = makeDefaultPlayer(socket.id);
    hardResetCombatState(fresh);
    fresh.nextFireTime = PERF.now();
    world.players.set(socket.id, fresh);
  });

  // Level to 99 (only if level >= 13) and sync XP
  socket.on("levelTo99", () => {
    const p = world.players.get(socket.id);
    if (!p) return;
    if (p.level >= 13 && p.level < 99) {
      const diff = 99 - p.level;
      p.level = 99;
      p.maxHp += diff * 10;
      p.hp = p.maxHp;
      p.xp = p.level * 50;
      p._prompt = null;
    }
  });

  socket.on("disconnect", () => {
    world.players.delete(socket.id);
  });
});

/* ===== Serve static ===== */
app.get("/", (req, res) => res.send("Server running"));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
