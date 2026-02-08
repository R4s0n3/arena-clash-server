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
  action: "idle" | "attacking" | "blocking";
  attackTime: number;
  attackIndex: number;
  isDead: boolean;
  kills: number;
  deaths: number;
  color: string;
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
}

export interface StateMessage extends ServerMessage {
  type: "state";
  players: PlayerState[];
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
}

export interface KillMessage extends ServerMessage {
  type: "kill";
  killerId: string;
  targetId: string;
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
  forward: number;
  right: number;
  rotation: number;
}

export interface ActionMessage extends ClientMessage {
  type: "attack" | "blockStart" | "blockEnd" | "jump";
}
