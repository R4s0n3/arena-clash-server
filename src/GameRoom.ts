// server/src/GameRoom.ts
import { WebSocket } from "ws";
import type {
  PlayerState,
  MoveMessage,
  ClientMessage,
} from "./types.js";

const ARENA_RADIUS = 30;
const PLAYER_SPEED = 8;
const ATTACK_DAMAGE = 25;
const BLOCK_DAMAGE_REDUCTION = 0.8;
const ATTACK_RANGE = 2.8;
const ATTACK_ARC = Math.PI / 2; // 90 degrees
const COMBO_STEPS = [
  { duration: 520, hitTime: 190, dmg: 1.0 },
  { duration: 560, hitTime: 210, dmg: 1.1 },
  { duration: 680, hitTime: 260, dmg: 1.25 },
] as const;
const COMBO_CHAIN_WINDOW = [
  { start: 160, end: 420 },
  { start: 180, end: 460 },
] as const;
const RESPAWN_TIME = 3000; // ms
const TICK_RATE = 30; // server ticks per second
const BROADCAST_RATE = 20; // state broadcasts per second
const MAX_HEALTH = 100;
const GRAVITY = 16; // units/s^2
const JUMP_VELOCITY = 8.5; // units/s

const PLAYER_COLORS = [
  "#e74c3c",
  "#3498db",
  "#2ecc71",
  "#f39c12",
  "#9b59b6",
  "#1abc9c",
  "#e67e22",
  "#ecf0f1",
  "#e84393",
  "#00cec9",
  "#fdcb6e",
  "#6c5ce7",
  "#ff7675",
  "#74b9ff",
  "#55efc4",
  "#ffeaa7",
];

interface ServerPlayer {
  ws: WebSocket;
  state: PlayerState;
  input: { forward: number; right: number; rotation: number };
  attackHitChecked: boolean;
  respawnTimer: number | null;
  lastInputTime: number;
  yVelocity: number;
}

export class GameRoom {
  maxPlayers: number;
  private players: Map<string, ServerPlayer> = new Map();
  private tickInterval: ReturnType<typeof setInterval>;
  private broadcastInterval: ReturnType<typeof setInterval>;
  private colorIndex = 0;

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
      action: "idle",
      attackTime: 0,
      attackIndex: 0,
      isDead: false,
      kills: 0,
      deaths: 0,
      color,
    };

    const player: ServerPlayer = {
      ws,
      state,
      input: { forward: 0, right: 0, rotation: 0 },
      attackHitChecked: false,
      respawnTimer: null,
      lastInputTime: Date.now(),
      yVelocity: 0,
    };

    this.players.set(id, player);

    // Send welcome to new player
    this.send(ws, {
      type: "welcome",
      id,
      players: this.getAllStates(),
      arenaRadius: ARENA_RADIUS,
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

    player.lastInputTime = Date.now();

    switch (msg.type) {
      case "move": {
        const m = msg as MoveMessage;
        player.input.forward = Math.max(
          -1,
          Math.min(1, m.forward || 0)
        );
        player.input.right = Math.max(
          -1,
          Math.min(1, m.right || 0)
        );
        player.input.rotation = m.rotation || 0;
        break;
      }
      case "attack": {
        if (player.state.isDead) break;
        const now = Date.now();
        if (player.state.action === "idle") {
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
          player.state.action === "idle" &&
          !player.state.isDead
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
          player.state.y <= 0.001
        ) {
          player.yVelocity = JUMP_VELOCITY;
          player.state.y = 0.001;
        }
        break;
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
        if (
          elapsed >= step.hitTime &&
          !player.attackHitChecked
        ) {
          player.attackHitChecked = true;
          this.checkAttackHits(player, step.dmg);
        }

        // End attack animation
        if (elapsed >= step.duration) {
          s.action = "idle";
          s.attackIndex = 0;
        }
      }

      // Movement (can't move while attacking)
      if (s.action !== "attacking") {
        const { forward, right, rotation } = player.input;
        s.rotation = rotation;

        if (forward !== 0 || right !== 0) {
          // Movement is relative to player rotation
          const sin = Math.sin(rotation);
          const cos = Math.cos(rotation);

          let dx = right * cos - forward * sin;
          let dz = right * sin - forward * cos;

          // Normalize diagonal movement
          const len = Math.sqrt(dx * dx + dz * dz);
          if (len > 1) {
            dx /= len;
            dz /= len;
          }

          s.x += dx * PLAYER_SPEED * dt;
          s.z += dz * PLAYER_SPEED * dt;

          // Clamp to arena
          const dist = Math.sqrt(s.x * s.x + s.z * s.z);
          if (dist > ARENA_RADIUS - 1) {
            const scale = (ARENA_RADIUS - 1) / dist;
            s.x *= scale;
            s.z *= scale;
          }
        }
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

    for (const [, target] of this.players) {
      const t = target.state;
      if (t.id === a.id || t.isDead) continue;

      // Distance check
      const dx = t.x - a.x;
      const dz = t.z - a.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > ATTACK_RANGE) continue;

      // Arc check — angle from attacker's facing to target
      const angleToTarget = Math.atan2(-dx, -dz);
      let angleDiff = angleToTarget - attackDir;
      // Normalize to [-PI, PI]
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

      if (Math.abs(angleDiff) > ATTACK_ARC / 2) continue;

      // Hit! Calculate damage
      let damage = Math.round(ATTACK_DAMAGE * damageScale);
      if (t.action === "blocking") {
        // Check if target is facing the attacker (blocking from front)
        const targetToAttacker = Math.atan2(
          -(a.x - t.x),
          -(a.z - t.z)
        );
        let blockAngle = targetToAttacker - t.rotation;
        while (blockAngle > Math.PI) blockAngle -= Math.PI * 2;
        while (blockAngle < -Math.PI)
          blockAngle += Math.PI * 2;

        if (Math.abs(blockAngle) < Math.PI / 2) {
          damage = Math.round(
            damage * (1 - BLOCK_DAMAGE_REDUCTION)
          );
        }
      }

      t.health -= damage;
      this.broadcast({
        type: "hit",
        attackerId: a.id,
        targetId: t.id,
        damage,
        targetHealth: t.health,
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
          targetId: t.id,
        });

        this.broadcast({
          type: "chat",
          text: `⚔️ ${a.name} killed ${t.name}!`,
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
    return Array.from(this.players.values()).map(
      (p) => p.state
    );
  }

  private broadcastState(): void {
    const players = this.getAllStates();
    this.broadcast({ type: "state", players });
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
