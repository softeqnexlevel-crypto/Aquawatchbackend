let ioRef = null;

function initSocket(io) {
  ioRef = io;
  io.on("connection", (socket) => {
    console.log(`[socket] client connected ${socket.id}`);

    try {
      const { getStatus } = require("../mqtt/mqttClient");
      const mqttStatus = getStatus();
      socket.emit("mqtt-status", mqttStatus);
    } catch (err) {
      console.error("[socket] Error sending MQTT status:", err.message);
    }

    socket.on("disconnect", () => console.log(`[socket] client gone ${socket.id}`));

    socket.on("get-mqtt-status", () => {
      try {
        const { getStatus } = require("../mqtt/mqttClient");
        const status = getStatus();
        socket.emit("mqtt-status", status);
      } catch (err) {
        socket.emit("mqtt-status", { connected: false, error: err.message });
      }
    });
  });
}

function broadcast(event, payload) {
  if (!ioRef) return;
  ioRef.emit(event, payload);
}

function broadcastMqttStatus() {
  if (!ioRef) return;
  try {
    const { getStatus } = require("../mqtt/mqttClient");
    const status = getStatus();
    ioRef.emit("mqtt-status", status);
  } catch (err) {
    console.error("[socket] Error broadcasting MQTT status:", err.message);
  }
}

module.exports = { initSocket, broadcast, broadcastMqttStatus };