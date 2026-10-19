
import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import authRouter, {
  getChatIdentity,
  isChatSessionValid,
  setChatSessionRevoker,
} from "./auth.js";
 
const app = express();
const httpServer = createServer(app);
 
const PORT = Number(process.env.PORT ?? 3000);
const FRONTEND_URLS = [
  /^http:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):5173$/,
  ...(
    process.env.FRONTEND_URL?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? []
  ),
];
 
// Middleware
app.use(
  cors({
    origin: FRONTEND_URLS,
    credentials: true,
    // PATCH is required for changing usernames (PATCH /api/auth/username)
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
  })
);
 
app.use(express.json());
 
// Basic health check
app.get("/", (_req, res) => {
  res.json({
    message: "Orbit API is running",
  });
});
 
// Email registration, verification, login, username and logout routes
app.use("/api/auth", authRouter);
 
// Socket.IO setup
const io = new Server(httpServer, {
  cors: {
    origin: FRONTEND_URLS,
    credentials: true,
    methods: ["GET", "POST"],
  },
});

type OnlineUser = {
  username: string;
  color: string;
};

type PendingChatRequest = {
  from: string;
  to: string;
  fromUsername: string;
  toUsername: string;
};

const onlineUsers = new Map<string, OnlineUser>();
const pendingChatRequests = new Map<string, PendingChatRequest>();
const privateConversations = new Map<string, Set<string>>();
const privateConversationByPair = new Map<string, string>();
const privateConversationPairByRoom = new Map<string, string>();

function getPrivateConversationPairKey(first: string, second: string) {
  return [first.toLowerCase(), second.toLowerCase()].sort().join("\0");
}

setChatSessionRevoker((sessionTokenHashes, status) => {
  const revokedSessions = new Set(sessionTokenHashes);

  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data.chatIdentity as
      | { sessionTokenHash?: string }
      | undefined;
    if (
      identity?.sessionTokenHash &&
      revokedSessions.has(identity.sessionTokenHash)
    ) {
      socket.data.chatDisconnectStatus = status;
      socket.disconnect(true);
    }
  }
});

io.use((socket, next) => {
  const identity = getChatIdentity(socket.request.headers.cookie);

  if (!identity) {
    next(new Error("Authentication required"));
    return;
  }

  socket.data.chatIdentity = identity;
  next();
});

// Chat connections
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  const sessionIdentity = socket.data.chatIdentity as OnlineUser & {
    sessionTokenHash: string;
    expiresAt: number;
  };
  const identity: OnlineUser = {
    username: sessionIdentity.username,
    color: sessionIdentity.color,
  };
  let offlineHandled = false;
  const canAccessRoom = (roomId: string) =>
    roomId === "general"
      ? socket.rooms.has("general")
      : privateConversations.get(roomId)?.has(socket.id) === true &&
        privateConversations.get(roomId)?.size === 2 &&
        [...(privateConversations.get(roomId) ?? [])].every((member) =>
          onlineUsers.has(member)
        ) &&
        socket.rooms.has(roomId);
  const sessionExpiryTimer = setTimeout(
    () => socket.disconnect(true),
    Math.max(0, sessionIdentity.expiresAt - Date.now())
  );

  const markOffline = (status: "logged-out" | "disconnected") => {
    onlineUsers.delete(socket.id);
    io.emit("user-offline", { id: socket.id });

    for (const [requestId, request] of pendingChatRequests) {
      if (request.from === socket.id || request.to === socket.id) {
        pendingChatRequests.delete(requestId);
        const otherId = request.from === socket.id ? request.to : request.from;
        io.to(otherId).emit("chat-request-result", {
          status: "unavailable",
          targetId: socket.id,
        });
      }
    }

    for (const [roomId, members] of privateConversations) {
      if (!members.delete(socket.id)) continue;
      for (const member of members) {
        io.to(member).emit("private-chat-peer-status", {
          roomId,
          status,
          username: identity.username,
        });
      }
      socket.leave(roomId);
      if (members.size === 0) {
        privateConversations.delete(roomId);
        const pairKey = privateConversationPairByRoom.get(roomId);
        if (pairKey) privateConversationByPair.delete(pairKey);
        privateConversationPairByRoom.delete(roomId);
      }
    }

    offlineHandled = true;
  };

  onlineUsers.set(socket.id, identity);
  socket.emit(
    "online-users",
    [...onlineUsers.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([id, user]) => ({ id, ...user }))
  );
  socket.broadcast.emit("user-online", { id: socket.id, ...identity });
 
  // Join a chat room
  socket.on("join-room", (roomId: string) => {
    if (!isChatSessionValid(sessionIdentity.sessionTokenHash)) {
      socket.disconnect(true);
      return;
    }
    if (roomId !== "general") return;
 
    socket.join(roomId);
    socket.to(roomId).emit("user-joined", {
      socketId: socket.id,
    });
  });
 
  // Broadcast each message to the other users in the shared room.
  socket.on(
    "send-message",
    (data: { roomId?: string; message?: string }) => {
      if (!isChatSessionValid(sessionIdentity.sessionTokenHash)) {
        socket.disconnect(true);
        return;
      }

      if (
        typeof data?.roomId !== "string" ||
        !canAccessRoom(data.roomId) ||
        typeof data?.message !== "string" ||
        !data.message.trim() ||
        data.message.trim().length > 2000
      ) {
        return;
      }

      socket.to(data.roomId).emit("receive-message", {
        id: Date.now() + Math.random(),
        roomId: data.roomId,
        message: data.message.trim(),
        username: identity.username,
        color: identity.color,
        timestamp: new Date().toISOString(),
      });
    }
  );

  socket.on(
    "typing-status",
    (data: { roomId?: unknown; isTyping?: unknown }) => {
      if (!isChatSessionValid(sessionIdentity.sessionTokenHash)) {
        socket.disconnect(true);
        return;
      }

      if (
        typeof data?.roomId !== "string" ||
        typeof data.isTyping !== "boolean" ||
        !canAccessRoom(data.roomId)
      ) {
        return;
      }

      socket.to(data.roomId).emit("typing-status", {
        roomId: data.roomId,
        username: identity.username,
        isTyping: data.isTyping,
      });
    }
  );

  socket.on("request-chat", (targetId: unknown) => {
    if (!isChatSessionValid(sessionIdentity.sessionTokenHash)) {
      socket.disconnect(true);
      return;
    }

    if (
      typeof targetId !== "string" ||
      targetId === socket.id ||
      !onlineUsers.has(targetId)
    ) {
      socket.emit("chat-request-result", {
        status: "unavailable",
        targetId,
      });
      return;
    }

    const hasPendingRequest = [...pendingChatRequests.values()].some(
      (request) => request.from === socket.id || request.to === socket.id
    );
    if (hasPendingRequest) {
      socket.emit("chat-request-result", {
        status: "pending",
        targetId,
      });
      return;
    }

    const target = onlineUsers.get(targetId);
    if (!target) {
      socket.emit("chat-request-result", {
        status: "unavailable",
        targetId,
      });
      return;
    }

    const pairKey = getPrivateConversationPairKey(
      identity.username,
      target.username
    );
    const existingRoomId = privateConversationByPair.get(pairKey);
    const existingMembers = existingRoomId
      ? privateConversations.get(existingRoomId)
      : undefined;
    const onlineMembers = [...(existingMembers ?? [])].filter((memberId) =>
      onlineUsers.has(memberId)
    );
    if (onlineMembers.length > 1) {
      socket.emit("chat-request-result", {
        status: "already-chatting",
        targetId,
      });
      return;
    }

    const requestId = randomUUID();
    pendingChatRequests.set(requestId, {
      from: socket.id,
      to: targetId,
      fromUsername: identity.username,
      toUsername: target.username,
    });
    io.to(targetId).emit("incoming-chat-request", {
      requestId,
      fromId: socket.id,
      username: identity.username,
      color: identity.color,
    });
    socket.emit("chat-request-result", {
      status: "sent",
      targetId,
      username: target.username,
    });
  });

  socket.on(
    "respond-chat-request",
    (data: { requestId?: unknown; accept?: unknown }) => {
      if (
        !isChatSessionValid(sessionIdentity.sessionTokenHash)
      ) {
        socket.disconnect(true);
        return;
      }
      if (
        typeof data?.requestId !== "string" ||
        typeof data.accept !== "boolean"
      ) {
        return;
      }

      const request = pendingChatRequests.get(data.requestId);
      if (!request || request.to !== socket.id) return;
      pendingChatRequests.delete(data.requestId);

      const requester = io.sockets.sockets.get(request.from);
      if (!requester || !onlineUsers.has(request.from)) {
        socket.emit("chat-request-result", {
          status: "unavailable",
          targetId: request.from,
        });
        return;
      }

      if (!data.accept) {
        requester.emit("chat-request-result", {
          status: "declined",
          targetId: socket.id,
          username: identity.username,
        });
        return;
      }

      const pairKey = getPrivateConversationPairKey(
        request.fromUsername,
        request.toUsername
      );
      let roomId = privateConversationByPair.get(pairKey);
      let members = roomId ? privateConversations.get(roomId) : undefined;
      if (!roomId || !members) {
        roomId = `private-${randomUUID()}`;
        members = new Set<string>();
        privateConversations.set(roomId, members);
        privateConversationByPair.set(pairKey, roomId);
        privateConversationPairByRoom.set(roomId, pairKey);
      }

      for (const memberId of members) {
        if (memberId !== request.from && memberId !== socket.id) {
          members.delete(memberId);
          io.sockets.sockets.get(memberId)?.leave(roomId);
        }
      }
      members.add(request.from);
      members.add(socket.id);
      requester.join(roomId);
      socket.join(roomId);
      requester.emit("private-chat-started", {
        roomId,
        username: identity.username,
      });
      socket.emit("private-chat-started", {
        roomId,
        username: request.fromUsername,
      });
    }
  );

  socket.on(
    "leave-private-chat",
    (
      data: { roomId?: unknown },
      acknowledge?: (result: { ok: boolean }) => void
    ) => {
      if (
        typeof data?.roomId !== "string" ||
        !privateConversations.get(data.roomId)?.has(socket.id)
      ) {
        acknowledge?.({ ok: false });
        return;
      }

      const members = privateConversations.get(data.roomId);
      if (!members) {
        acknowledge?.({ ok: false });
        return;
      }

      members.delete(socket.id);
      socket.leave(data.roomId);
      for (const member of members) {
        io.to(member).emit("private-chat-peer-status", {
          roomId: data.roomId,
          status: "left",
          username: identity.username,
        });
      }
      if (members.size === 0) {
        privateConversations.delete(data.roomId);
        const pairKey = privateConversationPairByRoom.get(data.roomId);
        if (pairKey) privateConversationByPair.delete(pairKey);
        privateConversationPairByRoom.delete(data.roomId);
      }
      acknowledge?.({ ok: true });
    }
  );

  socket.on("logging-out", (acknowledge?: () => void) => {
    if (!offlineHandled) {
      markOffline("logged-out");
    }
    acknowledge?.();
  });

  // Handle disconnections
  socket.on("disconnect", () => {
    clearTimeout(sessionExpiryTimer);
    if (!offlineHandled) {
      const status =
        socket.data.chatDisconnectStatus === "logged-out"
          ? "logged-out"
          : "disconnected";
      markOffline(status);
    }

    console.log(`User disconnected: ${socket.id}`);
  });
});
 
// Start the server
httpServer.listen(PORT, () => {
  console.log(`Orbit API running at http://localhost:${PORT}`);
  console.log(`Allowed frontend origins: ${FRONTEND_URLS.join(", ")}`);
});