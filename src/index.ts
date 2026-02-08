import { WebSocketServer } from "ws";
import http from "http";
import { GameRoom } from "./GameRoom";

const PORT = Number(process.env.PORT) || 3001;
const MAX_PLAYERS_PER_ROOM = 16;

const server = http.createServer((_req, res) => {
  // Health check endpoint for hosting providers
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Arena Clash server running");
});

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }, cb) => {
    // Allow all origins (or restrict to your client domain)
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
    `⚔️  Arena Clash server running on port ${PORT}`
  );
});
