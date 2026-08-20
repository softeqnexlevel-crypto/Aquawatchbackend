// src/services/api.js
const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:4000/api';

export const api = {
  // Get current sensor readings (returns object with parameter: value)
  getCurrentReadings: async () => {
    const response = await fetch(`${API_BASE_URL}/current`);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.json();
  },

  // Get detailed status for each sensor (includes online status, timestamp)
  getStatus: async () => {
    const response = await fetch(`${API_BASE_URL}/status`);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.json();
  },

  // Get active alarms
  getAlarms: async () => {
    const response = await fetch(`${API_BASE_URL}/alarms`);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.json();
  },

  // Get MQTT connection status
  getMqttStatus: async () => {
    const response = await fetch(`${API_BASE_URL}/mqtt-status`);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.json();
  },

  // Publish test data (for debugging)
  publishTestData: async (topic, value) => {
    const response = await fetch(`${API_BASE_URL}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, value })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.json();
  }
};