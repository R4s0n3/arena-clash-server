import { WebSocketServer } from "ws";
import http from "http";
import { GameRoom } from "./GameRoom.js";

const rawPort = process.env.PORT;
const PORT = rawPort !== undefined ? Number(rawPort) : 3001;
const MAX_PLAYERS_PER_ROOM = 16;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Arena Clash server running");
});

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }, cb) => {
    cb(true);
  },
});

const rooms: GameRoom[] = [new GameRoom(MAX_PLAYERS_PER_ROOM)];

function findAvailableRoom(): GameRoom {
  for (const room of rooms) {
    if (room.playerCount < room.maxPlayers) {
      return room;
    }
  }
  const newRoom = new GameRoom(MAX_PLAYERS_PER_ROOM);
  rooms.push(newRoom);
  return newRoom;
}

wss.on("connection", (ws) => {
  const room = findAvailableRoom();
  room.addPlayer(ws);
});

server.listen(PORT, () => {
  console.log(
    `Arena Clash server running on port ${PORT}`
  );
});

// Graceful shutdown
function shutdown() {
  console.log("\nShutting down...");
  for (const room of rooms) {
    room.destroy();
  }
  wss.close();
  server.close(() => {
    process.exit(0);
  });
  // Force exit after 3s
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
