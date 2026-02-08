// server/src/GameRoom.ts
import { WebSocket } from "ws";
import type {
  PlayerState,
  MoveMessage,
  ClientMessage,
  SetNameMessage,
} from "./types.js";

// Arena
const ARENA_RADIUS = 30;

// Movement
const PLAYER_SPEED = 8;
const GRAVITY = 16;
const JUMP_VELOCITY = 8.5;

// Dodge
const DODGE_SPEED = 18;
const DODGE_DURATION = 280; // ms
const DODGE_COOLDOWN = 800; // ms
const DODGE_STAMINA_COST = 25;
const DODGE_IFRAME_DURATION = 200; // invincibility frames in ms

// Combat
const ATTACK_DAMAGE = 22;
const BLOCK_DAMAGE_REDUCTION = 0.75;
const ATTACK_RANGE = 2.8;
const ATTACK_ARC = Math.PI / 2; // 90 degrees
const COMBO_STEPS = [
  { duration: 480, hitTime: 170, dmg: 1.0 },
  { duration: 500, hitTime: 190, dmg: 1.15 },
  { duration: 620, hitTime: 240, dmg: 1.35 },
] as const;
const COMBO_CHAIN_WINDOW = [
  { start: 150, end: 400 },
  { start: 170, end: 440 },
] as const;
const COMBO_COOLDOWN = 600; // ms cooldown after full combo finishes
const ATTACK_STAMINA_COST = 12;
const BLOCK_STAMINA_DRAIN = 8; // per second while blocking

// Stamina
const MAX_STAMINA = 100;
const STAMINA_REGEN_RATE = 18; // per second
const STAMINA_REGEN_DELAY = 800; // ms delay after stamina use before regen starts

// Health
const MAX_HEALTH = 100;
const RESPAWN_TIME = 3000;

// Network
const TICK_RATE = 30;
const BROADCAST_RATE = 20;
const MAX_INPUT_RATE = 66; // max client input messages per second (slightly above 60fps)

const PLAYER_COLORS = [
  "#e74c3c", "#3498db", "#2ecc71", "#f39c12",
  "#9b59b6", "#1abc9c", "#e67e22", "#ecf0f1",
  "#e84393", "#00cec9", "#fdcb6e", "#6c5ce7",
  "#ff7675", "#74b9ff", "#55efc4", "#ffeaa7",
];

interface ServerPlayer {
  ws: WebSocket;
  state: PlayerState;
  input: { forward: number; right: number; rotation: number; dt: number };
  attackHitChecked: boolean;
  respawnTimer: number | null;
  lastInputTime: number;
  yVelocity: number;
  // Stamina tracking
  lastStaminaUseTime: number;
  // Combo cooldown
  comboCooldownUntil: number;
  // Dodge tracking
  dodgeStartTime: number;
  dodgeDir: { x: number; z: number };
  lastDodgeTime: number;
  // Input rate limiting
  inputCount: number;
  inputCountResetTime: number;
  // Input sequence for client prediction
  lastSeq: number;
}

export class GameRoom {
  maxPlayers: number;
  private players: Map<string, ServerPlayer> = new Map();
  private tickInterval: ReturnType<typeof setInterval>;
  private broadcastInterval: ReturnType<typeof setInterval>;
  private colorIndex = 0;
  // Cache for broadcast to avoid re-serializing identical data
  private lastBroadcastHash = "";

  get playerCount(): number {
    return this.players.size;
  }

  constructor(maxPlayers: number) {
    this.maxPlayers = maxPlayers;

    this.tickInterval = setInterval(
      () => this.tick(),
      1000 / TICK_RATE
    );
    this.broadcastInterval = setInterval(
      () => this.broadcastState(),
      1000 / BROADCAST_RATE
    );
  }

  addPlayer(ws: WebSocket): void {
    const id = crypto.randomUUID();
    const spawn = this.getRandomSpawn();
    const color = PLAYER_COLORS[this.colorIndex % PLAYER_COLORS.length];
    this.colorIndex++;

    const state: PlayerState = {
      id,
      name: `Player ${this.players.size + 1}`,
      x: spawn.x,
      y: 0,
      z: spawn.z,
      rotation: 0,
      health: MAX_HEALTH,
      maxHealth: MAX_HEALTH,
      stamina: MAX_STAMINA,
      maxStamina: MAX_STAMINA,
      action: "idle",
      attackTime: 0,
      attackIndex: 0,
      isDead: false,
      kills: 0,
      deaths: 0,
      color,
      lastSeq: 0,
    };

    const now = Date.now();
    const player: ServerPlayer = {
      ws,
      state,
      input: { forward: 0, right: 0, rotation: 0, dt: 1 / TICK_RATE },
      attackHitChecked: false,
      respawnTimer: null,
      lastInputTime: now,
      yVelocity: 0,
      lastStaminaUseTime: 0,
      comboCooldownUntil: 0,
      dodgeStartTime: 0,
      dodgeDir: { x: 0, z: 0 },
      lastDodgeTime: 0,
      inputCount: 0,
      inputCountResetTime: now,
      lastSeq: 0,
    };

    this.players.set(id, player);

    // Send welcome to new player
    this.send(ws, {
      type: "welcome",
      id,
      players: this.getAllStates(),
      arenaRadius: ARENA_RADIUS,
      tickRate: TICK_RATE,
    });

    // Notify others
    this.broadcast(
      { type: "playerJoined", player: state },
      id
    );

    this.broadcast({
      type: "chat",
      text: `${state.name} joined the arena!`,
    });

    console.log(
      `Player ${id} joined (${this.players.size}/${this.maxPlayers})`
    );

    ws.on("message", (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString());
        this.handleMessage(id, msg);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => this.removePlayer(id));
    ws.on("error", () => this.removePlayer(id));
  }

  private removePlayer(id: string): void {
    const player = this.players.get(id);
    if (!player) return;

    if (player.respawnTimer !== null) {
      clearTimeout(player.respawnTimer);
    }

    this.players.delete(id);
    this.broadcast({ type: "playerLeft", id });
    this.broadcast({
      type: "chat",
      text: `${player.state.name} left the arena.`,
    });

    console.log(
      `Player ${id} left (${this.players.size}/${this.maxPlayers})`
    );
  }

  private handleMessage(id: string, msg: ClientMessage): void {
    const player = this.players.get(id);
    if (!player) return;

    const now = Date.now();

    // Rate limiting: max MAX_INPUT_RATE messages per second
    if (now - player.inputCountResetTime >= 1000) {
      player.inputCount = 0;
      player.inputCountResetTime = now;
    }
    player.inputCount++;
    if (player.inputCount > MAX_INPUT_RATE) return;

    player.lastInputTime = now;

    switch (msg.type) {
      case "move": {
        const m = msg as MoveMessage;
        player.input.forward = Math.max(-1, Math.min(1, m.forward || 0));
        player.input.right = Math.max(-1, Math.min(1, m.right || 0));
        player.input.rotation = m.rotation || 0;
        // Clamp client dt to reasonable range (prevent speed hacks)
        player.input.dt = Math.max(0.001, Math.min(0.1, m.dt || 1 / TICK_RATE));
        player.lastSeq = m.seq || 0;
        player.state.lastSeq = player.lastSeq;

        // Process movement immediately for better responsiveness
        this.processMovement(player, now);
        break;
      }
      case "attack": {
        if (player.state.isDead) break;
        if (player.state.action === "dodging") break;

        // Check stamina
        if (player.state.stamina < ATTACK_STAMINA_COST) break;

        if (player.state.action === "idle") {
          // Check combo cooldown
          if (now < player.comboCooldownUntil) break;

          player.state.stamina -= ATTACK_STAMINA_COST;
          player.lastStaminaUseTime = now;
          player.state.action = "attacking";
          player.state.attackTime = now;
          player.state.attackIndex = 1;
          player.attackHitChecked = false;
        } else if (player.state.action === "attacking") {
          const step = player.state.attackIndex;
          if (step >= 1 && step < 3) {
            const elapsed = now - player.state.attackTime;
            const window = COMBO_CHAIN_WINDOW[step - 1];
            if (elapsed >= window.start && elapsed <= window.end) {
              // Check stamina for next combo step
              if (player.state.stamina < ATTACK_STAMINA_COST) break;
              player.state.stamina -= ATTACK_STAMINA_COST;
              player.lastStaminaUseTime = now;
              player.state.attackIndex = step + 1;
              player.state.attackTime = now;
              player.attackHitChecked = false;
            }
          }
        }
        break;
      }
      case "blockStart": {
        if (
          (player.state.action === "idle") &&
          !player.state.isDead &&
          player.state.stamina > 5
        ) {
          player.state.action = "blocking";
        }
        break;
      }
      case "blockEnd": {
        if (player.state.action === "blocking") {
          player.state.action = "idle";
        }
        break;
      }
      case "jump": {
        if (
          !player.state.isDead &&
          player.state.y <= 0.001 &&
          player.state.action !== "dodging"
        ) {
          player.yVelocity = JUMP_VELOCITY;
          player.state.y = 0.001;
        }
        break;
      }
      case "dodge": {
        if (player.state.isDead) break;
        if (player.state.action === "attacking" || player.state.action === "dodging") break;
        if (player.state.stamina < DODGE_STAMINA_COST) break;
        if (now - player.lastDodgeTime < DODGE_COOLDOWN) break;

        // Cancel blocking if needed
        player.state.action = "dodging";
        player.state.stamina -= DODGE_STAMINA_COST;
        player.lastStaminaUseTime = now;
        player.dodgeStartTime = now;
        player.lastDodgeTime = now;

        // Dodge direction based on current movement input, or backward if no input
        const { forward, right, rotation } = player.input;
        const sin = Math.sin(rotation);
        const cos = Math.cos(rotation);
        let dx = right * cos - forward * sin;
        let dz = right * sin - forward * cos;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0.1) {
          dx /= len;
          dz /= len;
        } else {
          // Dodge backward
          dx = sin;
          dz = cos;
        }
        player.dodgeDir = { x: dx, z: dz };
        break;
      }
      case "setName": {
        const m = msg as SetNameMessage;
        const name = (m.name || "").trim().slice(0, 20);
        if (name.length > 0) {
          const oldName = player.state.name;
          player.state.name = name;
          this.broadcast({
            type: "chat",
            text: `${oldName} is now known as ${name}`,
          });
        }
        break;
      }
    }
  }

  private processMovement(player: ServerPlayer, _now: number): void {
    const s = player.state;
    if (s.isDead) return;

    // Can't move while attacking (but can rotate)
    const { forward, right, rotation, dt } = player.input;
    s.rotation = rotation;

    if (s.action === "attacking") return;
    if (s.action === "dodging") return; // dodge movement handled in tick

    if (forward !== 0 || right !== 0) {
      const sin = Math.sin(rotation);
      const cos = Math.cos(rotation);

      let dx = right * cos - forward * sin;
      let dz = right * sin - forward * cos;

      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 1) {
        dx /= len;
        dz /= len;
      }

      // Blocking slows movement
      const speedMul = s.action === "blocking" ? 0.55 : 1.0;

      s.x += dx * PLAYER_SPEED * speedMul * dt;
      s.z += dz * PLAYER_SPEED * speedMul * dt;

      // Clamp to arena
      const dist = Math.sqrt(s.x * s.x + s.z * s.z);
      if (dist > ARENA_RADIUS - 1) {
        const scale = (ARENA_RADIUS - 1) / dist;
        s.x *= scale;
        s.z *= scale;
      }
    }
  }

  private tick(): void {
    const now = Date.now();
    const dt = 1 / TICK_RATE;

    for (const [, player] of this.players) {
      const s = player.state;
      if (s.isDead) continue;

      // Handle attack timing
      if (s.action === "attacking") {
        const elapsed = now - s.attackTime;
        const stepIndex = Math.max(1, Math.min(3, s.attackIndex));
        const step = COMBO_STEPS[stepIndex - 1];

        // Check hit at the right moment
        if (elapsed >= step.hitTime && !player.attackHitChecked) {
          player.attackHitChecked = true;
          this.checkAttackHits(player, step.dmg);
        }

        // End attack animation
        if (elapsed >= step.duration) {
          s.action = "idle";
          // Apply combo cooldown if this was the last step or combo finished
          if (s.attackIndex >= 3) {
            player.comboCooldownUntil = now + COMBO_COOLDOWN;
          }
          s.attackIndex = 0;
        }
      }

      // Handle dodge movement
      if (s.action === "dodging") {
        const elapsed = now - player.dodgeStartTime;
        if (elapsed < DODGE_DURATION) {
          // Apply dodge velocity with ease-out
          const progress = elapsed / DODGE_DURATION;
          const speedFactor = 1 - progress * progress; // quadratic ease-out
          s.x += player.dodgeDir.x * DODGE_SPEED * speedFactor * dt;
          s.z += player.dodgeDir.z * DODGE_SPEED * speedFactor * dt;

          // Clamp to arena
          const dist = Math.sqrt(s.x * s.x + s.z * s.z);
          if (dist > ARENA_RADIUS - 1) {
            const scale = (ARENA_RADIUS - 1) / dist;
            s.x *= scale;
            s.z *= scale;
          }
        } else {
          s.action = "idle";
        }
      }

      // Block stamina drain
      if (s.action === "blocking") {
        s.stamina -= BLOCK_STAMINA_DRAIN * dt;
        player.lastStaminaUseTime = now;
        if (s.stamina <= 0) {
          s.stamina = 0;
          s.action = "idle"; // forced to stop blocking
        }
      }

      // Stamina regeneration
      if (s.action !== "blocking" && now - player.lastStaminaUseTime >= STAMINA_REGEN_DELAY) {
        s.stamina = Math.min(MAX_STAMINA, s.stamina + STAMINA_REGEN_RATE * dt);
      }

      // Vertical motion (jump/fall)
      if (s.y > 0 || player.yVelocity > 0) {
        player.yVelocity -= GRAVITY * dt;
        s.y += player.yVelocity * dt;
        if (s.y <= 0) {
          s.y = 0;
          player.yVelocity = 0;
        }
      }
    }
  }

  private checkAttackHits(attacker: ServerPlayer, damageScale: number): void {
    const a = attacker.state;
    const attackDir = a.rotation;
    const now = Date.now();

    for (const [, target] of this.players) {
      const t = target.state;
      if (t.id === a.id || t.isDead) continue;

      // Dodge invincibility frames
      if (t.action === "dodging") {
        const dodgeElapsed = now - target.dodgeStartTime;
        if (dodgeElapsed < DODGE_IFRAME_DURATION) continue;
      }

      // Distance check
      const dx = t.x - a.x;
      const dz = t.z - a.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > ATTACK_RANGE) continue;

      // Arc check
      const angleToTarget = Math.atan2(-dx, -dz);
      let angleDiff = angleToTarget - attackDir;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

      if (Math.abs(angleDiff) > ATTACK_ARC / 2) continue;

      // Hit! Calculate damage
      let damage = Math.round(ATTACK_DAMAGE * damageScale);
      let blocked = false;

      if (t.action === "blocking") {
        const targetToAttacker = Math.atan2(
          -(a.x - t.x),
          -(a.z - t.z)
        );
        let blockAngle = targetToAttacker - t.rotation;
        while (blockAngle > Math.PI) blockAngle -= Math.PI * 2;
        while (blockAngle < -Math.PI) blockAngle += Math.PI * 2;

        if (Math.abs(blockAngle) < Math.PI / 2) {
          damage = Math.round(damage * (1 - BLOCK_DAMAGE_REDUCTION));
          blocked = true;
          // Blocking costs stamina on impact
          t.stamina -= 10;
          target.lastStaminaUseTime = now;
          if (t.stamina < 0) t.stamina = 0;
        }
      }

      t.health -= damage;

      // Knockback direction: from attacker toward target
      const kbDist = dist > 0.01 ? dist : 1;
      const kbX = dx / kbDist;
      const kbZ = dz / kbDist;
      const kbForce = blocked ? 0.3 : (0.6 + damageScale * 0.4);

      // Apply positional knockback on server
      t.x += kbX * kbForce * 0.5;
      t.z += kbZ * kbForce * 0.5;
      // Clamp to arena
      const kbDistFromCenter = Math.sqrt(t.x * t.x + t.z * t.z);
      if (kbDistFromCenter > ARENA_RADIUS - 1) {
        const kbScale = (ARENA_RADIUS - 1) / kbDistFromCenter;
        t.x *= kbScale;
        t.z *= kbScale;
      }

      this.broadcast({
        type: "hit",
        attackerId: a.id,
        targetId: t.id,
        damage,
        targetHealth: t.health,
        blocked,
        kbX,
        kbZ,
        kbForce,
      });

      if (t.health <= 0) {
        t.health = 0;
        t.isDead = true;
        t.action = "idle";
        a.kills++;
        t.deaths++;

        this.broadcast({
          type: "kill",
          killerId: a.id,
          killerName: a.name,
          targetId: t.id,
          targetName: t.name,
        });

        // Schedule respawn
        const targetPlayer = this.players.get(t.id);
        if (targetPlayer) {
          targetPlayer.respawnTimer = setTimeout(() => {
            this.respawnPlayer(t.id);
          }, RESPAWN_TIME) as unknown as number;
        }
      }
    }
  }

  private respawnPlayer(id: string): void {
    const player = this.players.get(id);
    if (!player) return;

    const spawn = this.getRandomSpawn();
    player.state.x = spawn.x;
    player.state.z = spawn.z;
    player.state.y = 0;
    player.yVelocity = 0;
    player.state.health = MAX_HEALTH;
    player.state.stamina = MAX_STAMINA;
    player.state.isDead = false;
    player.state.action = "idle";
    player.state.attackIndex = 0;
    player.respawnTimer = null;

    this.broadcast({
      type: "respawn",
      id,
      x: spawn.x,
      z: spawn.z,
    });
  }

  private getRandomSpawn(): { x: number; z: number } {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * (ARENA_RADIUS - 5) + 2;
    return {
      x: Math.cos(angle) * r,
      z: Math.sin(angle) * r,
    };
  }

  private getAllStates(): PlayerState[] {
    return Array.from(this.players.values()).map((p) => p.state);
  }

  private broadcastState(): void {
    if (this.players.size === 0) return;
    const players = this.getAllStates();
    const msg = { type: "state", players, serverTime: Date.now() };
    const data = JSON.stringify(msg);

    // Skip broadcast if nothing changed (rare but possible with idle players)
    if (data === this.lastBroadcastHash) return;
    this.lastBroadcastHash = data;

    for (const [, player] of this.players) {
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(data);
      }
    }
  }

  private broadcast(msg: object, excludeId?: string): void {
    const data = JSON.stringify(msg);
    for (const [id, player] of this.players) {
      if (id === excludeId) continue;
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(data);
      }
    }
  }

  private send(ws: WebSocket, msg: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  destroy(): void {
    clearInterval(this.tickInterval);
    clearInterval(this.broadcastInterval);
    for (const [, player] of this.players) {
      player.ws.close();
    }
  }
}
