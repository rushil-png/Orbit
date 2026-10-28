import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import "./App.css";

type Message = {
  id: number;
  text: string;
  timestamp: string;
  sender: "me" | "other";
  username: string;
  color?: string;
  roomId: string;
};

type OnlineUser = {
  id: string;
  username: string;
  color: string;
};

type IncomingChatRequest = {
  requestId: string;
  fromId: string;
  username: string;
  color: string;
};

type PrivateChat = {
  roomId: string;
  username: string;
  status: "online" | "logged-out" | "disconnected" | "left";
};

const API_URL =
  import.meta.env.VITE_API_URL ??
  `${window.location.protocol}//${window.location.hostname}:3000`;

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const USERNAME_RULES =
  "Username must be 3–20 characters: letters, numbers, and underscores only.";
const MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export default function App() {
  const [isLogin, setIsLogin] = useState(true);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [isResetPassword, setIsResetPassword] = useState(
    () => new URLSearchParams(window.location.search).has("resetToken")
  );
  const [isGuestSession, setIsGuestSession] = useState(false);
  const [showChat, setShowChat] = useState(false);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Username editing (chat screen)
  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [isSavingUsername, setIsSavingUsername] = useState(false);

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [typingUsers, setTypingUsers] = useState<Record<string, string[]>>({});
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<
    IncomingChatRequest[]
  >([]);
  const [privateChats, setPrivateChats] = useState<PrivateChat[]>([]);
  const [requestStatuses, setRequestStatuses] = useState<
    Record<string, string>
  >({});
  const [selectedRoomId, setSelectedRoomId] = useState("general");
  const selectedRoomIdRef = useRef("general");
  const messageListRef = useRef<HTMLDivElement>(null);
  const typingRoomRef = useRef<string | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const [chatTitle, setChatTitle] = useState("General chat");
  const [chatConnected, setChatConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const isGuestSignup =
    !isLogin && !isForgotPassword && !isResetPassword && !email.trim();

  useEffect(() => {
    if (!showChat) return;

    const socket = io(API_URL, { withCredentials: true });
    socketRef.current = socket;
    const typingTimeouts = new Map<string, number>();

    const clearTypingTimeout = (roomId: string, typingUsername: string) => {
      const key = `${roomId}\0${typingUsername}`;
      const timeout = typingTimeouts.get(key);
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
        typingTimeouts.delete(key);
      }
    };

    const clearTypingUsers = () => {
      typingTimeouts.forEach((timeout) => window.clearTimeout(timeout));
      typingTimeouts.clear();
      setTypingUsers({});
    };

    socket.on("connect", () => {
      setChatConnected(true);
      socket.emit("join-room", "general");
    });
    socket.on("disconnect", () => {
      setChatConnected(false);
      setOnlineUsers([]);
      setIncomingRequests([]);
      setRequestStatuses({});
      clearTypingUsers();
      setPrivateChats((previous) =>
        previous.map((chat) => ({ ...chat, status: "disconnected" }))
      );
    });
    socket.on("connect_error", () => setChatConnected(false));
    socket.on("online-users", (users: OnlineUser[]) => {
      setOnlineUsers(users);
    });
    socket.on("user-online", (user: OnlineUser) => {
      setOnlineUsers((previous) => [
        ...previous.filter((item) => item.id !== user.id),
        user,
      ]);
    });
    socket.on("user-offline", ({ id }: { id: string }) => {
      setOnlineUsers((previous) => previous.filter((user) => user.id !== id));
      setRequestStatuses((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
    });
    socket.on(
      "incoming-chat-request",
      (request: IncomingChatRequest) => {
        setIncomingRequests((previous) => [
          ...previous.filter((item) => item.requestId !== request.requestId),
          request,
        ]);
      }
    );
    socket.on(
      "chat-request-result",
      (result: {
        status: string;
        targetId: string;
        username?: string;
      }) => {
        const labels: Record<string, string> = {
          sent: "Request sent",
          declined: "Request declined",
          unavailable: "User is no longer online",
          pending: "Finish your current request first",
          "already-chatting": "You already have a chat with this user",
        };
        setRequestStatuses((previous) => ({
          ...previous,
          [result.targetId]: labels[result.status] ?? "Request failed",
        }));
      }
    );
    socket.on(
      "private-chat-started",
      (chat: PrivateChat) => {
        setPrivateChats((previous) => [
          ...previous.filter(
            (item) =>
              item.roomId !== chat.roomId &&
              item.username.toLowerCase() !== chat.username.toLowerCase()
          ),
          { ...chat, status: "online" },
        ]);
        setIncomingRequests((previous) =>
          previous.filter((item) => item.username !== chat.username)
        );
        setRequestStatuses({});
        setSelectedRoomId(chat.roomId);
        setChatTitle(`@${chat.username}`);
      }
    );
    socket.on(
      "private-chat-peer-status",
      (update: {
        roomId: string;
        status: PrivateChat["status"];
      }) => {
        setPrivateChats((previous) =>
          previous.map((chat) =>
            chat.roomId === update.roomId
              ? { ...chat, status: update.status }
              : chat
          )
        );
      }
    );
    socket.on(
      "receive-message",
      (data: {
        id?: unknown;
        color?: unknown;
        message?: unknown;
        roomId?: unknown;
        timestamp?: unknown;
        username?: unknown;
      }) => {
        if (
          typeof data.message !== "string" ||
          typeof data.username !== "string" ||
          typeof data.color !== "string" ||
          typeof data.roomId !== "string"
        ) {
          return;
        }

        const receivedMessage = data.message;
        const receivedUsername = data.username;
        const receivedColor = data.color;
        const receivedRoomId = data.roomId;
        const receivedTimestamp =
          typeof data.timestamp === "string" &&
          Number.isFinite(Date.parse(data.timestamp))
            ? data.timestamp
            : new Date().toISOString();

        setMessages((previous) => [
          ...previous,
          {
            id: typeof data.id === "number" ? data.id : Date.now(),
            text: receivedMessage,
            timestamp: receivedTimestamp,
            username: receivedUsername,
            color: receivedColor,
            sender: "other",
            roomId: receivedRoomId,
          },
        ]);
        clearTypingTimeout(receivedRoomId, receivedUsername);
        setTypingUsers((previous) => {
          const next = { ...previous };
          next[receivedRoomId] = (next[receivedRoomId] ?? []).filter(
            (typingUsername) => typingUsername !== receivedUsername
          );
          if (next[receivedRoomId].length === 0) delete next[receivedRoomId];
          return next;
        });
      }
      );
      socket.on(
        "typing-status",
        (data: { roomId?: unknown; username?: unknown; isTyping?: unknown }) => {
          if (
            typeof data?.roomId !== "string" ||
            typeof data.username !== "string" ||
            typeof data.isTyping !== "boolean"
          ) {
            return;
          }

          const roomId = data.roomId;
          const typingUsername = data.username;
          const key = `${roomId}\0${typingUsername}`;
          clearTypingTimeout(roomId, typingUsername);

          if (data.isTyping) {
            setTypingUsers((previous) => ({
              ...previous,
              [roomId]: [
                ...new Set([...(previous[roomId] ?? []), typingUsername]),
              ],
            }));
            typingTimeouts.set(
              key,
              window.setTimeout(() => {
                setTypingUsers((previous) => {
                  const next = { ...previous };
                  next[roomId] = (next[roomId] ?? []).filter(
                    (item) => item !== typingUsername
                  );
                  if (next[roomId].length === 0) delete next[roomId];
                  return next;
                });
                typingTimeouts.delete(key);
              }, 2500)
            );
            return;
          }

          setTypingUsers((previous) => {
            const next = { ...previous };
            next[roomId] = (next[roomId] ?? []).filter(
              (item) => item !== typingUsername
            );
            if (next[roomId].length === 0) delete next[roomId];
            return next;
          });
        }
      );

      return () => {
        typingTimeouts.forEach((timeout) => window.clearTimeout(timeout));
        typingTimeouts.clear();
        if (typingTimerRef.current !== null) {
          window.clearTimeout(typingTimerRef.current);
          typingTimerRef.current = null;
        }
        typingRoomRef.current = null;
        socket.disconnect();
        socketRef.current = null;
        setChatConnected(false);
      };
  }, [showChat, username]);

  useEffect(() => {
    selectedRoomIdRef.current = selectedRoomId;
  }, [selectedRoomId]);

  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  useEffect(() => {
    let active = true;

    if (new URLSearchParams(window.location.search).has("resetToken")) {
      return () => {
        active = false;
      };
    }

    fetch(`${API_URL}/api/auth/me`, {
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((data) => {
        if (active && data?.user?.username) {
          setEmail(data.user.email ?? "");
          setUsername(data.user.username ?? "");
          setIsGuestSession(data.user.guest === true);
          setShowChat(true);
        }
      })
      .catch(() => {
        // The user is not logged in, or the server is unavailable.
      });

    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    setAuthNotice("");

    if (isForgotPassword) {
      setIsSubmitting(true);
      try {
        const response = await fetch(`${API_URL}/api/auth/forgot-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim().toLowerCase() }),
        });
        const data = await response.json();

        if (!response.ok) {
          setAuthError(data.error ?? "Couldn't request a password reset.");
          return;
        }

        setAuthNotice(data.message);
      } catch {
        setAuthError(
          "Could not connect to the server. Make sure your backend is running."
        );
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (isResetPassword) {
      if (password !== confirmPassword) {
        setAuthError("Your passwords do not match.");
        return;
      }

      setIsSubmitting(true);
      try {
        const response = await fetch(`${API_URL}/api/auth/reset-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: new URLSearchParams(window.location.search).get("resetToken"),
            password,
            confirmPassword,
          }),
        });
        const data = await response.json();

        if (!response.ok) {
          setAuthError(data.error ?? "Couldn't reset your password.");
          return;
        }

        window.history.replaceState({}, "", window.location.pathname);
        setIsResetPassword(false);
        setPassword("");
        setConfirmPassword("");
        setAuthNotice(data.message);
      } catch {
        setAuthError(
          "Could not connect to the server. Make sure your backend is running."
        );
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const trimmedUsername = username.trim();

    if (!isLogin && !USERNAME_PATTERN.test(trimmedUsername)) {
      setAuthError(USERNAME_RULES);
      return;
    }

    if (!isLogin && !isGuestSignup && password !== confirmPassword) {
      setAuthError("Your passwords do not match.");
      return;
    }

    if (!isGuestSignup && password.length < 8) {
      setAuthError("Your password must be at least 8 characters.");
      return;
    }

    setIsSubmitting(true);

    try {
      const endpoint = isLogin
        ? "login"
        : isGuestSignup
          ? "guest"
          : "register";

      const response = await fetch(`${API_URL}/api/auth/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(
          isGuestSignup
            ? { username: trimmedUsername }
            : {
                username: trimmedUsername,
                email: normalizedEmail,
                password,
                confirmPassword,
              }
        ),
      });

      const data = await response.json();

      if (!response.ok) {
        setAuthError(
          data.error ?? "Something went wrong. Please try again."
        );
        return;
      }

      if (isGuestSignup) {
        setEmail("");
        setUsername(data.user.username);
        setPassword("");
        setConfirmPassword("");
        setIsGuestSession(true);
        setShowChat(true);
        return;
      }

      if (!isLogin) {
        setEmail(normalizedEmail);
        setUsername("");
        setPassword("");
        setConfirmPassword("");
        setIsLogin(true);
        setIsGuestSession(false);
        setAuthNotice(
          data.message ??
            "Check your email for your verification link."
        );
        return;
      }

      setEmail(data.user.email);
      setUsername(data.user.username ?? "");
      setIsGuestSession(false);
      setPassword("");
      setConfirmPassword("");
      setShowChat(true);
    } catch {
      setAuthError(
        "Could not connect to the server. Make sure your backend is running."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function logout() {
    const socket = socketRef.current;
    if (socket?.connected) {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 1000);
        socket.emit("logging-out", () => {
          window.clearTimeout(timeout);
          resolve();
        });
      });
    }

    try {
      await fetch(`${API_URL}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      setAuthError("Could not contact the server to log out.");
    }

    setShowChat(false);
    setIsGuestSession(false);
    setUsername("");
    setPassword("");
    setConfirmPassword("");
    setMessage("");
    setMessages([]);
    setOnlineUsers([]);
    setIncomingRequests([]);
    setPrivateChats([]);
    setRequestStatuses({});
    setSelectedRoomId("general");
    selectedRoomIdRef.current = "general";
    setChatTitle("General chat");
    setIsEditingUsername(false);
    setUsernameError("");
    setAuthError("");
    setAuthNotice("");
  }

  function switchAuthMode() {
    setIsLogin((previous) => !previous);
    setIsForgotPassword(false);
    setIsResetPassword(false);
    setUsername("");
    setPassword("");
    setConfirmPassword("");
    setAuthError("");
    setAuthNotice("");
  }

  function startEditingUsername() {
    setNewUsername(username);
    setUsernameError("");
    setIsEditingUsername(true);
  }

  function cancelEditingUsername() {
    setIsEditingUsername(false);
    setUsernameError("");
  }

  async function saveUsername(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUsernameError("");

    const trimmed = newUsername.trim();

    if (!USERNAME_PATTERN.test(trimmed)) {
      setUsernameError(USERNAME_RULES);
      return;
    }

    if (trimmed === username) {
      setIsEditingUsername(false);
      return;
    }

    setIsSavingUsername(true);

    try {
      const response = await fetch(`${API_URL}/api/auth/username`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: trimmed }),
      });

      const data = await response.json();

      if (!response.ok) {
        setUsernameError(
          data.error ?? "Couldn't update your username."
        );
        return;
      }

      setUsername(data.user.username);
      setIsEditingUsername(false);
    } catch {
      setUsernameError("Could not connect to the server.");
    } finally {
      setIsSavingUsername(false);
    }
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = message.trim();
    if (!text || !socketRef.current?.connected) return;
    const timestamp = new Date().toISOString();

    socketRef.current.emit("send-message", {
      roomId: selectedRoomId,
      message: text,
    });
    stopTyping();
    setMessages((previous) => [
      ...previous,
      {
        id: Date.now(),
        text,
        timestamp,
        sender: "me",
        username,
        roomId: selectedRoomId,
      },
    ]);

    setMessage("");
  }

  function requestChat(targetId: string) {
    if (!socketRef.current?.connected) return;
    setRequestStatuses((previous) => ({
      ...previous,
      [targetId]: "Sending request...",
    }));
    socketRef.current.emit("request-chat", targetId);
  }

  function respondToChatRequest(requestId: string, accept: boolean) {
    socketRef.current?.emit("respond-chat-request", {
      requestId,
      accept,
    });
    if (!accept) {
      setIncomingRequests((previous) =>
        previous.filter((request) => request.requestId !== requestId)
      );
    }
  }

  function openConversation(roomId: string, title: string) {
    stopTyping();
    selectedRoomIdRef.current = roomId;
    setSelectedRoomId(roomId);
    setChatTitle(title);
  }

  function leavePrivateChat(roomId: string) {
    if (typingRoomRef.current === roomId) stopTyping();

    const removeChat = () => {
      setPrivateChats((previous) =>
        previous.filter((chat) => chat.roomId !== roomId)
      );
      setMessages((previous) =>
        previous.filter((item) => item.roomId !== roomId)
      );
      if (selectedRoomIdRef.current === roomId) {
        selectedRoomIdRef.current = "general";
        setSelectedRoomId("general");
        setChatTitle("General chat");
      }
    };

    const socket = socketRef.current;
    if (!socket?.connected) {
      removeChat();
      return;
    }

    socket.timeout(1500).emit(
      "leave-private-chat",
      { roomId },
      (error: Error | null, response: { ok: boolean }) => {
        if (!error && response?.ok) {
          removeChat();
        }
      }
    );
  }

  const activePrivateChat = privateChats.find(
    (chat) => chat.roomId === selectedRoomId
  );
  const activePrivateChatUsernames = new Set(
    privateChats
      .filter((chat) => chat.status === "online")
      .map((chat) => chat.username.toLowerCase())
  );
  const canSendMessage =
    selectedRoomId === "general" || activePrivateChat?.status === "online";

  function stopTyping() {
    if (typingTimerRef.current !== null) {
      window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }

    const roomId = typingRoomRef.current;
    if (roomId && socketRef.current?.connected) {
      socketRef.current?.emit("typing-status", { roomId, isTyping: false });
    }
    typingRoomRef.current = null;
  }

  function handleMessageChange(value: string) {
    setMessage(value);
    const socket = socketRef.current;
    const roomId = selectedRoomIdRef.current;

    if (!value.trim() || !canSendMessage || !socket?.connected) {
      stopTyping();
      return;
    }

    if (typingRoomRef.current && typingRoomRef.current !== roomId) {
      stopTyping();
    }
    typingRoomRef.current = roomId;
    socket.emit("typing-status", { roomId, isTyping: true });

    if (typingTimerRef.current !== null) {
      window.clearTimeout(typingTimerRef.current);
    }
    typingTimerRef.current = window.setTimeout(stopTyping, 1200);
  }

  if (showChat) {
    return (
      <main className="chat-page">
        <header className="chat-header">
          <div className="chat-brand">
            <div className="brand-icon">O</div>
            <span>Orbit</span>
          </div>

          <div className="chat-user">
            <span className="user-avatar">
              {(username || email).charAt(0).toUpperCase() || "U"}
            </span>

            {isEditingUsername ? (
              <form className="username-form" onSubmit={saveUsername}>
                <input
                  type="text"
                  value={newUsername}
                  onChange={(event) => setNewUsername(event.target.value)}
                  minLength={3}
                  maxLength={20}
                  pattern="[a-zA-Z0-9_]{3,20}"
                  title={USERNAME_RULES}
                  aria-label="New username"
                  autoFocus
                  required
                />
                <button type="submit" disabled={isSavingUsername}>
                  {isSavingUsername ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  className="username-cancel"
                  onClick={cancelEditingUsername}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <span className="user-identity">
                <strong className="user-name">@{username}</strong>
                <span className="user-email">
                  {email ||
                    (isGuestSession
                      ? "One-time guest · ends at logout or in 7 days"
                      : "")}
                </span>
              </span>
            )}

            {!isEditingUsername && (
              <button
                className="logout-button"
                type="button"
                onClick={startEditingUsername}
              >
                Edit username
              </button>
            )}

            {isResetPassword && (
              <button
                className="forgot-link back-link"
                type="button"
                onClick={() => {
                  window.history.replaceState({}, "", window.location.pathname);
                  setIsResetPassword(false);
                  setIsForgotPassword(true);
                  setPassword("");
                  setConfirmPassword("");
                  setAuthError("");
                  setAuthNotice("");
                }}
              >
                Request a new reset link
              </button>
            )}

            <button className="logout-button" onClick={logout}>
              Log out
            </button>
          </div>

          {usernameError && (
            <p className="auth-error username-error" role="alert">
              {usernameError}
            </p>
          )}
        </header>

        <div className="chat-layout">
          <aside className="chat-sidebar">
            <h2>Messages</h2>

            <button
              className={`conversation ${
                selectedRoomId === "general" ? "active" : ""
              }`}
              onClick={() => openConversation("general", "General chat")}
            >
              <span className="conversation-avatar">G</span>
              <span>
                <strong>General chat</strong>
                <small>Chat with everyone</small>
              </span>
            </button>

            {privateChats.length > 0 && (
              <div className="sidebar-section">
                <h3>Private chats</h3>
                {privateChats.map((chat) => (
                  <div className="private-conversation-row" key={chat.roomId}>
                    <button
                      className={`conversation private-conversation ${
                        selectedRoomId === chat.roomId ? "active" : ""
                      }`}
                      onClick={() =>
                        openConversation(chat.roomId, `@${chat.username}`)
                      }
                    >
                      <span className="conversation-avatar">↗</span>
                      <span>
                        <strong>@{chat.username}</strong>
                        <small>
                          {chat.status === "online"
                            ? "Private conversation"
                            : chat.status === "logged-out"
                              ? "They logged out"
                              : chat.status === "left"
                                ? "They left this chat"
                                : "They disconnected"}
                        </small>
                      </span>
                    </button>
                    <button
                      className="leave-chat-button"
                      type="button"
                      aria-label={`Leave chat with ${chat.username}`}
                      title="Leave chat"
                      onClick={() => leavePrivateChat(chat.roomId)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="sidebar-section online-section">
              <h3>Online now <span>{onlineUsers.length}</span></h3>
              {onlineUsers.length === 0 ? (
                <p className="sidebar-note">No one else is online yet.</p>
              ) : (
                onlineUsers.map((user) => (
                  <div className="online-user" key={user.id}>
                    <span
                      className="online-user-dot"
                      style={{ backgroundColor: user.color }}
                    />
                    <span className="online-user-name">@{user.username}</span>
                    <button
                      type="button"
                      disabled={
                        !chatConnected ||
                        activePrivateChatUsernames.has(
                          user.username.toLowerCase()
                        ) ||
                        requestStatuses[user.id] === "Request sent" ||
                        requestStatuses[user.id] === "Sending request..."
                      }
                      onClick={() => requestChat(user.id)}
                    >
                      {activePrivateChatUsernames.has(
                        user.username.toLowerCase()
                      )
                        ? "In chat"
                        : requestStatuses[user.id] === "Sending request..."
                          ? "Sending..."
                          : requestStatuses[user.id] === "Request sent"
                            ? "Sent"
                            : "Request"}
                    </button>
                    {requestStatuses[user.id] &&
                      requestStatuses[user.id] !== "Sending request..." && (
                        <small className="request-status">
                          {requestStatuses[user.id]}
                        </small>
                      )}
                  </div>
                ))
              )}
            </div>

            {incomingRequests.length > 0 && (
              <div className="sidebar-section request-section">
                <h3>Chat requests</h3>
                {incomingRequests.map((request) => (
                  <div className="incoming-request" key={request.requestId}>
                    <span>@{request.username} wants to chat.</span>
                    <div>
                      <button
                        type="button"
                        onClick={() =>
                          respondToChatRequest(request.requestId, true)
                        }
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="decline-request"
                        onClick={() =>
                          respondToChatRequest(request.requestId, false)
                        }
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {onlineUsers.length === 0 && privateChats.length === 0 && (
              <p className="sidebar-note">
                When others come online, request a private chat here.
              </p>
            )}
          </aside>

          <section className="chat-room">
            <div className="room-header">
              <div>
                <h2>{chatTitle}</h2>
                <p>
                  {activePrivateChat
                    ? activePrivateChat.status === "logged-out"
                      ? `@${activePrivateChat.username} logged out. This chat is kept here.`
                      : activePrivateChat.status === "left"
                        ? `@${activePrivateChat.username} left this chat.`
                        : activePrivateChat.status === "disconnected"
                          ? `@${activePrivateChat.username} disconnected. This chat is kept here.`
                          : `Private chat with @${activePrivateChat.username}`
                    : "Your space to connect"}
                </p>
              </div>

              <div className="room-header-actions">
                {activePrivateChat && (
                  <button
                    className="leave-chat-header-button"
                    type="button"
                    onClick={() => leavePrivateChat(activePrivateChat.roomId)}
                  >
                    Leave chat
                  </button>
                )}
                <span className="online-indicator">
                  <span
                    className={
                      chatConnected && canSendMessage ? "connected" : ""
                    }
                  />
                  {activePrivateChat && activePrivateChat.status !== "online"
                    ? "Chat unavailable"
                    : chatConnected
                      ? "Live chat"
                      : "Connecting..."}
                </span>
              </div>
            </div>

            <div className="message-list" ref={messageListRef}>
              {messages.filter((item) => item.roomId === selectedRoomId)
                .length === 0 ? (
                <div className="empty-chat">
                  <div className="empty-chat-icon">✦</div>
                  <h3>Welcome to Orbit, {username}!</h3>
                  <p>
                    {activePrivateChat && !canSendMessage
                      ? "Your conversation is kept here, but you can’t send messages while they’re away."
                      : "Send a message to get your conversation started."}
                  </p>
                </div>
              ) : (
                messages
                  .filter((item) => item.roomId === selectedRoomId)
                  .map((item) => (
                  <div
                    key={item.id}
                    className={`message-row ${
                      item.sender === "me" ? "my-message" : ""
                    }`}
                  >
                    <div className="message-content">
                      {item.sender === "other" && (
                        <span className="message-author">@{item.username}</span>
                      )}
                      <div
                        className="message-bubble"
                        style={
                          item.sender === "other" && item.color
                            ? { backgroundColor: item.color }
                            : undefined
                        }
                      >
                        {item.text}
                      </div>
                      <time
                        className="message-timestamp"
                        dateTime={item.timestamp}
                      >
                        {MESSAGE_TIME_FORMATTER.format(
                          new Date(item.timestamp)
                        )}
                      </time>
                    </div>
                  </div>
                ))
              )}
              {(typingUsers[selectedRoomId] ?? []).length > 0 && (
                <div className="typing-row" role="status" aria-live="polite">
                  <span className="typing-label">
                    {(typingUsers[selectedRoomId] ?? []).length === 1
                      ? `@${typingUsers[selectedRoomId][0]} is typing`
                      : "Several people are typing"}
                  </span>
                  <span className="typing-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              )}
            </div>

            <form className="message-form" onSubmit={sendMessage}>
              <input
                type="text"
                value={message}
                onChange={(event) => handleMessageChange(event.target.value)}
                maxLength={2000}
                aria-label="Write a message"
                disabled={!canSendMessage}
                placeholder={
                  canSendMessage
                    ? "Write a message..."
                    : "This chat is unavailable while they are away"
                }
              />

              <button
                type="submit"
                disabled={!message.trim() || !chatConnected || !canSendMessage}
              >
                Send <span>➤</span>
              </button>
            </form>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <div className="brand-icon">O</div>
          <span>Orbit</span>
        </div>

        <div className="auth-heading">
          <h1>
            {isForgotPassword
              ? "Forgot password?"
              : isResetPassword
                ? "Choose a new password"
                : isLogin
                  ? "Welcome back"
                  : "Create your account"}
          </h1>
          <p>
            {isForgotPassword
              ? "Enter your email and we'll send you a password reset link."
              : isResetPassword
                ? "Choose a new password for your Orbit account."
                : isLogin
                  ? "Log in to continue your conversations."
                  : isGuestSignup
                    ? "Leave email blank to start a one-time guest session."
                    : "Join Orbit and start connecting."}
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          {!isLogin && !isForgotPassword && !isResetPassword && (
            <>
              <label htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                placeholder="your_username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                minLength={3}
                maxLength={20}
                pattern="[a-zA-Z0-9_]{3,20}"
                title={USERNAME_RULES}
                required
              />
            </>
          )}

          {!isResetPassword && (
            <>
              <label htmlFor="email">
                Email address{!isLogin && !isForgotPassword ? " (optional)" : ""}
              </label>
              <input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                maxLength={254}
                required={!isGuestSignup && (isLogin || isForgotPassword)}
              />
            </>
          )}

          {!isForgotPassword && !isGuestSignup && (
            <>
              <label htmlFor="password">
                {isResetPassword ? "New password" : "Password"}
              </label>
              <input
                id="password"
                type="password"
                placeholder={
                  isResetPassword ? "Enter a new password" : "Enter your password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={
                  isLogin && !isResetPassword
                    ? "current-password"
                    : "new-password"
                }
                minLength={8}
                maxLength={72}
                required
              />
            </>
          )}

          {(!isLogin || isResetPassword) &&
            !isForgotPassword &&
            !isGuestSignup && (
            <>
              <label htmlFor="confirmPassword">Confirm password</label>
              <input
                id="confirmPassword"
                type="password"
                placeholder="Re-enter your password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                maxLength={72}
                required
              />
            </>
            )}

          {isGuestSignup && (
            <p className="guest-notice">
              Without an email, this is a one-time guest session. It ends when
              you log out or after 7 days, and it cannot be recovered.
            </p>
          )}

          {authError && (
            <p className="auth-error" role="alert">
              {authError}
            </p>
          )}

          {authNotice && (
            <p className="auth-notice" role="status">
              {authNotice}
            </p>
          )}

          {isLogin && !isForgotPassword && !isResetPassword && (
            <button
              className="forgot-link"
              type="button"
              onClick={() => {
                setIsForgotPassword(true);
                setAuthError("");
                setAuthNotice("");
                setPassword("");
                setConfirmPassword("");
              }}
            >
              Forgot password?
            </button>
          )}

          {isForgotPassword && (
            <button
              className="forgot-link back-link"
              type="button"
              onClick={() => {
                setIsForgotPassword(false);
                setAuthError("");
                setAuthNotice("");
              }}
            >
              Back to log in
            </button>
          )}

          <button
            className="submit-button"
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting
              ? "Please wait..."
              : isForgotPassword
                ? "Send reset link"
                : isResetPassword
                  ? "Reset password"
                    : isGuestSignup
                      ? "Continue as guest"
                      : isLogin
                        ? "Log in"
                        : "Create account"}
          </button>
        </form>

        {!isForgotPassword && !isResetPassword && (
          <div className="auth-switch">
            <span>
              {isLogin ? "Don't have an account?" : "Already have an account?"}
            </span>
            <button type="button" onClick={switchAuthMode}>
              {isLogin ? "Sign up" : "Log in"}
            </button>
          </div>
        )}

        <p className="auth-footer">Orbit · A place to connect and chat.</p>
      </section>
    </main>
  );
}
