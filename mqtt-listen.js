// mqtt-listen.js
const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://broker.hivemq.com:1883', {
  clientId: 'terminal-listener-' + Math.random().toString(16).slice(2)
});

client.on('connect', () => {
  console.log('✅ Connected to HiveMQ');
  client.subscribe('RO5/#', (err) => {
    if (!err) {
      console.log('📡 Listening to all RO5 topics...\n');
    }
  });
});

client.on('message', (topic, message) => {
  console.log(`\x1b[36m${topic}\x1b[0m → \x1b[33m${message.toString()}\x1b[0m`);
});

client.on('error', (err) => {
  console.error('Error:', err.message);
});