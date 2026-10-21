// backend/services/socketService.js
let ioRef = null;

const DEFAULT_TENANT_ID = 1;

const room = (tenantId) => `tenant:${Number(tenantId) || DEFAULT_TENANT_ID}`;

// SOCKET_REQUIRE_AUTH=true  -> connections without a valid login token are rejected.
// Leave it unset until the website sends the token (see DataContext), otherwise
// the live data would stop for everyone.
const REQUIRE_AUTH = String(process.env.SOCKET_REQUIRE_AUTH || '').toLowerCase() === 'true';

function initSocket(io) {
  ioRef = io;
  console.log('[socket] ✅ Socket.IO initialized');
  console.log(`[socket] auth required: ${REQUIRE_AUTH}`);

  // ── Login check ────────────────────────────────────────────────
  // Token is sent by the browser as io(url, { auth: { token } }).
  // A token that belongs to a paused user is always refused; an expired/invalid one is
  // refused only when SOCKET_REQUIRE_AUTH=true.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) {
      if (REQUIRE_AUTH) return next(new Error('AUTH_REQUIRED'));
      return next();
    }
    try {
      const pasetoService = require('./paseto.service');
      const authService = require('./auth.service');
      const payload = await pasetoService.verifyAccessToken(token);
      if (!payload) {
        // Expired/invalid token: refuse only when auth is enforced. Otherwise treat as
        // anonymous so a user whose token is mid-refresh does not lose live data.
        return REQUIRE_AUTH ? next(new Error('AUTH_INVALID')) : next();
      }
      const user = await authService.getUserById(payload.sub);
      if (!user) return REQUIRE_AUTH ? next(new Error('AUTH_INVALID')) : next();
      if (!user.isActive) return next(new Error('ACCOUNT_PAUSED'));
      socket.data.userId = user.id;
      // Which plant is this browser looking at? Only a tenant the user may open is accepted.
      const asked = Number(socket.handshake.auth && socket.handshake.auth.tenantId) || 0;
      try {
        const tenants = require('./tenants.service');
        const own = await tenants.defaultTenantFor(user);
        if (own === null) return next(new Error('NO_CLIENT'));
        // a client login never falls back to another client's data: if the asked-for client isn't theirs, they get their own
        socket.data.tenantId = asked && (await tenants.canAccess(user, asked)) ? asked : own;
      } catch (e) {
        return next(new Error('AUTH_FAILED'));
      }
      return next();
    } catch (err) {
      console.error('[socket] auth error:', err.message);
      return next(new Error('AUTH_FAILED'));
    }
  });

  io.engine.on("connection", (socket) => {
    console.log('[socket] 🔌 Engine connection from:', socket.request.headers.origin);
  });

  io.on("connection", (socket) => {
    console.log(`[socket] ✅ Client connected: ${socket.id}`);
    console.log(`[socket] 📊 Total clients: ${io.sockets.sockets.size}`);
    console.log(`[socket] 📡 Client origin:`, socket.handshake.headers.origin);
    console.log(`[socket] 📡 Client address:`, socket.handshake.address);

    const tenantId = (socket.data && socket.data.tenantId) || DEFAULT_TENANT_ID;
    socket.join(room(tenantId));

    // Send MQTT status
    try {
      const { getStatus } = require("../mqtt/mqttClient");
      const status = getStatus(tenantId);
      socket.emit("mqtt-status", status);
      console.log('[socket] 📡 Sent MQTT status to client');
    } catch (err) {
      console.error('[socket] MQTT status error:', err.message);
    }

    // Send latest data
    try {
      const { getLatestFull } = require("./plcParser");
      const latest = getLatestFull(tenantId);
      const keys = Object.keys(latest);
      console.log(`[socket] 📊 Sending ${keys.length} readings to client`);

      keys.forEach(key => {
        socket.emit("plc-data", latest[key]);
      });
    } catch (err) {
      console.error('[socket] Error sending latest data:', err.message);
    }

    // Force send data on request
    socket.on("get-latest-data", () => {
      try {
        const { getLatestFull } = require("./plcParser");
        const latest = getLatestFull(tenantId);
        console.log(`[socket] 📊 Sending ${Object.keys(latest).length} readings on request`);
        Object.values(latest).forEach(record => {
          socket.emit("plc-data", record);
        });
      } catch (err) {
        console.error('[socket] Error:', err.message);
      }
    });

    socket.on("disconnect", (reason) => {
      console.log(`[socket] ❌ Client disconnected: ${socket.id} (${reason})`);
      console.log(`[socket] 📊 Remaining clients: ${io.sockets.sockets.size}`);
    });
  });
}

function broadcast(event, payload, tenantId = DEFAULT_TENANT_ID) {
  if (!ioRef) {
    console.warn('[socket] ⚠️ Cannot broadcast - ioRef is null');
    return false;
  }

  try {
    ioRef.to(room(tenantId)).emit(event, payload);
    return true;
  } catch (err) {
    console.error('[socket] Broadcast error:', err.message);
    return false;
  }
}

function broadcastMqttStatus(tenantId = DEFAULT_TENANT_ID) {
  if (!ioRef) return;
  try {
    const { getStatus } = require("../mqtt/mqttClient");
    ioRef.to(room(tenantId)).emit("mqtt-status", getStatus(tenantId));
  } catch (err) {
    console.error('[socket] Status error:', err.message);
  }
}

// Cuts off every live connection that belongs to a user (used when they are paused/deleted).
function disconnectUser(userId) {
  if (!ioRef || !userId) return 0;
  let n = 0;
  for (const socket of ioRef.sockets.sockets.values()) {
    if (socket.data && socket.data.userId === userId) {
      try {
        socket.emit('account-paused');
        socket.disconnect(true);
        n++;
      } catch (err) {
        console.error('[socket] disconnectUser error:', err.message);
      }
    }
  }
  if (n) console.log(`[socket] disconnected ${n} connection(s) for user ${userId}`);
  return n;
}

function getSocketStatus() {
  return {
    hasIo: !!ioRef,
    clients: ioRef ? ioRef.sockets.sockets.size : 0
  };
}

module.exports = { initSocket, broadcast, broadcastMqttStatus, getSocketStatus, disconnectUser };