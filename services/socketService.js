// backend/services/socketService.js
let ioRef = null;

function initSocket(io) {
  ioRef = io;
  console.log('[socket] ✅ Socket.IO initialized');
  
  // ✅ ADD THIS - Log all connections
  io.engine.on("connection", (socket) => {
    console.log('[socket] 🔌 Engine connection from:', socket.request.headers.origin);
  });

  io.on("connection", (socket) => {
    console.log(`[socket] ✅ Client connected: ${socket.id}`);
    console.log(`[socket] 📊 Total clients: ${io.sockets.sockets.size}`);
    console.log(`[socket] 📡 Client origin:`, socket.handshake.headers.origin);
    console.log(`[socket] 📡 Client address:`, socket.handshake.address);

    // Send MQTT status
    try {
      const { getStatus } = require("../mqtt/mqttClient");
      const status = getStatus();
      socket.emit("mqtt-status", status);
      console.log('[socket] 📡 Sent MQTT status to client');
    } catch (err) {
      console.error('[socket] MQTT status error:', err.message);
    }

    // Send latest data
    try {
      // const { getLatestFull } = require("./plcService");
      const { getLatestFull } = require("./plcParser");
      const latest = getLatestFull();
      const keys = Object.keys(latest);
      console.log(`[socket] 📊 Sending ${keys.length} readings to client`);
      
      keys.forEach(key => {
        socket.emit("plc-data", latest[key]);
      });
    } catch (err) {
      console.error('[socket] Error sending latest data:', err.message);
    }

    // ✅ ADD THIS - Force send data on request
    socket.on("get-latest-data", () => {
      try {
        const { getLatestFull } = require("./plcService");
        const latest = getLatestFull();
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

  // ✅ ADD THIS - Log errors
  io.on("connect_error", (err) => {
    console.error('[socket] ❌ Connection error:', err.message);
  });
}

function broadcast(event, payload) {
  if (!ioRef) {
    console.warn('[socket] ⚠️ Cannot broadcast - ioRef is null');
    return false;
  }
  
  try {
    ioRef.emit(event, payload);
    return true;
  } catch (err) {
    console.error('[socket] Broadcast error:', err.message);
    return false;
  }
}

function broadcastMqttStatus() {
  if (!ioRef) return;
  try {
    const { getStatus } = require("../mqtt/mqttClient");
    ioRef.emit("mqtt-status", getStatus());
  } catch (err) {
    console.error('[socket] Status error:', err.message);
  }
}

// ✅ ADD THIS
function getSocketStatus() {
  return {
    hasIo: !!ioRef,
    clients: ioRef ? ioRef.sockets.sockets.size : 0
  };
}

module.exports = { initSocket, broadcast, broadcastMqttStatus, getSocketStatus };