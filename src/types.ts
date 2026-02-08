// server/src/types.ts
export interface PlayerState {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  action: "idle" | "attacking" | "blocking" | "dodging";
  attackTime: number;
  attackIndex: number;
  isDead: boolean;
  kills: number;
  deaths: number;
  color: string;
  lastSeq: number; // last processed input sequence number (for client prediction)
}

export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

export interface WelcomeMessage extends ServerMessage {
  type: "welcome";
  id: string;
  players: PlayerState[];
  arenaRadius: number;
  tickRate: number;
}

export interface StateMessage extends ServerMessage {
  type: "state";
  players: PlayerState[];
  serverTime: number;
}

export interface PlayerJoinedMessage extends ServerMessage {
  type: "playerJoined";
  player: PlayerState;
}

export interface PlayerLeftMessage extends ServerMessage {
  type: "playerLeft";
  id: string;
}

export interface HitMessage extends ServerMessage {
  type: "hit";
  attackerId: string;
  targetId: string;
  damage: number;
  targetHealth: number;
  blocked: boolean;
}

export interface KillMessage extends ServerMessage {
  type: "kill";
  killerId: string;
  killerName: string;
  targetId: string;
  targetName: string;
}

export interface RespawnMessage extends ServerMessage {
  type: "respawn";
  id: string;
  x: number;
  z: number;
}

export interface ChatMessage extends ServerMessage {
  type: "chat";
  text: string;
}

export interface ClientMessage {
  type: string;
  [key: string]: unknown;
}

export interface MoveMessage extends ClientMessage {
  type: "move";
  seq: number; // sequence number for client-side prediction
  forward: number;
  right: number;
  rotation: number;
  dt: number; // client delta time for this input
}

export interface ActionMessage extends ClientMessage {
  type: "attack" | "blockStart" | "blockEnd" | "jump" | "dodge";
}

export interface SetNameMessage extends ClientMessage {
  type: "setName";
  name: string;
}
