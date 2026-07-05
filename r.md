const { parameterFromTopic } = require("../mqtt/topicManager");
const { broadcast } = require("./socketService");
const { evaluate } = require("./alarmService");
const { saveMeasurement } = require("../database/postgres");

const latest = {};
let dataCount = 0;

function handleIncoming(topic, raw) {
  try {
    let hex = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw);
    hex = hex.replace(/[^0-9A-Fa-f]/g, '');
    
    if (hex.length < 30 || !/^[0-9A-Fa-f]+$/.test(hex)) {
      // Handle JSON/number payloads
      const simple = parseSimple(raw);
      if (simple) {
        const param = simple.parameter || parameterFromTopic(topic);
        if (param) processRecord(topic, param, simple.value, simple.timestamp, simple.simulated);
      }
      return;
    }

    const buffer = Buffer.from(hex, 'hex');
    let i = 0;
    let found = false;

    while (i < buffer.length - 8) {
      // Find 0x06 marker
      if (buffer[i] !== 0x06) { i++; continue; }
      
      // Read value (4 bytes after 0x06)
      if (i + 5 > buffer.length) break;
      const value = buffer.readFloatBE(i + 1);
      
      // Read name length
      const nameLen = buffer[i + 5];
      if (nameLen < 3 || nameLen > 60 || i + 6 + nameLen > buffer.length) {
        i++;
        continue;
      }
      
      // Read name
      const name = buffer.slice(i + 6, i + 6 + nameLen).toString('ascii');
      
      // Read unit
      const unitStart = i + 6 + nameLen;
      if (unitStart >= buffer.length) break;
      const unitLen = buffer[unitStart];
      let unit = '';
      if (unitLen > 0 && unitLen < 20 && unitStart + 1 + unitLen <= buffer.length) {
        unit = buffer.slice(unitStart + 1, unitStart + 1 + unitLen).toString('ascii');
      }
      
      // Extract parameter name
      let param = name;
      const dash = name.lastIndexOf('-');
      if (dash !== -1) param = name.substring(dash + 1);
      param = param.replace(/[^A-Za-z0-9]/g, '');
      
      if (param && param.length > 2 && !isNaN(value) && isFinite(value) && Math.abs(value) < 1000) {
        found = true;
        const rounded = Math.round(value * 100) / 100;
        console.log(`[plc] ✅ ${param} = ${rounded} ${unit}`);
        
        const record = {
          topic,
          parameter: param,
          value: rounded,
          timestamp: new Date().toISOString(),
          simulated: false,
          unit: unit || ''
        };
        
        latest[param] = record;
        dataCount++;
        
        saveMeasurement(record).catch(() => {});
        try {
          const alarms = evaluate(param, rounded);
          broadcast("plc-data", record);
          if (alarms && alarms.length) {
            broadcast("plc-alarm", { parameter: param, value: rounded, alarms, simulated: false });
          }
        } catch (err) {}
      }
      
      // Skip to next record (skip padding: 00 00 02 00 01 D8)
      i += 6 + nameLen + 1 + unitLen + 6;
    }
    
    if (!found && !/^[0-9A-Fa-f]{50,}$/.test(hex)) {
      console.warn(`[plc] invalid payload on ${topic}: ${String(raw).slice(0, 50)}`);
    }
    
  } catch (err) {
    console.error('[plc] Error:', err.message);
  }
}

function parseSimple(raw) {
  const str = String(raw).trim();
  if (!str) return null;
  
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj.value === 'number') {
      return { value: obj.value, timestamp: obj.timestamp || new Date().toISOString(), simulated: obj.simulated || false, parameter: obj.parameter || null };
    }
  } catch (_) {}
  
  const num = Number(str);
  if (!isNaN(num) && /^-?\d+(\.\d+)?$/.test(str)) {
    return { value: num, timestamp: new Date().toISOString(), simulated: false, parameter: null };
  }
  return null;
}

function processRecord(topic, param, value, timestamp, simulated) {
  const record = { topic, parameter: param, value, timestamp, simulated, unit: '' };
  latest[param] = record;
  dataCount++;
  console.log(`[plc] ✅ ${param} = ${value}`);
  saveMeasurement(record).catch(() => {});
  try {
    const alarms = evaluate(param, value);
    broadcast("plc-data", record);
    if (alarms && alarms.length) {
      broadcast("plc-alarm", { parameter: param, value, alarms, simulated });
    }
  } catch (err) {}
}

function getLatestSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(latest)) out[k] = v.value;
  return out;
}

function getLatestFull() { return { ...latest }; }

module.exports = { handleIncoming, getLatestSnapshot, getLatestFull };const { parameterFromTopic } = require("../mqtt/topicManager");
const { broadcast } = require("./socketService");
const { evaluate } = require("./alarmService");
const { saveMeasurement } = require("../database/postgres");

const latest = {};
let dataCount = 0;

function handleIncoming(topic, raw) {
  try {
    let hex = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw);
    hex = hex.replace(/[^0-9A-Fa-f]/g, '');
    
    if (hex.length < 30 || !/^[0-9A-Fa-f]+$/.test(hex)) {
      // Handle JSON/number payloads
      const simple = parseSimple(raw);
      if (simple) {
        const param = simple.parameter || parameterFromTopic(topic);
        if (param) processRecord(topic, param, simple.value, simple.timestamp, simple.simulated);
      }
      return;
    }

    const buffer = Buffer.from(hex, 'hex');
    let i = 0;
    let found = false;

    while (i < buffer.length - 8) {
      // Find 0x06 marker
      if (buffer[i] !== 0x06) { i++; continue; }
      
      // Read value (4 bytes after 0x06)
      if (i + 5 > buffer.length) break;
      const value = buffer.readFloatBE(i + 1);
      
      // Read name length
      const nameLen = buffer[i + 5];
      if (nameLen < 3 || nameLen > 60 || i + 6 + nameLen > buffer.length) {
        i++;
        continue;
      }
      
      // Read name
      const name = buffer.slice(i + 6, i + 6 + nameLen).toString('ascii');
      
      // Read unit
      const unitStart = i + 6 + nameLen;
      if (unitStart >= buffer.length) break;
      const unitLen = buffer[unitStart];
      let unit = '';
      if (unitLen > 0 && unitLen < 20 && unitStart + 1 + unitLen <= buffer.length) {
        unit = buffer.slice(unitStart + 1, unitStart + 1 + unitLen).toString('ascii');
      }
      
      // Extract parameter name
      let param = name;
      const dash = name.lastIndexOf('-');
      if (dash !== -1) param = name.substring(dash + 1);
      param = param.replace(/[^A-Za-z0-9]/g, '');
      
      if (param && param.length > 2 && !isNaN(value) && isFinite(value) && Math.abs(value) < 1000) {
        found = true;
        const rounded = Math.round(value * 100) / 100;
        console.log(`[plc] ✅ ${param} = ${rounded} ${unit}`);
        
        const record = {
          topic,
          parameter: param,
          value: rounded,
          timestamp: new Date().toISOString(),
          simulated: false,
          unit: unit || ''
        };
        
        latest[param] = record;
        dataCount++;
        
        saveMeasurement(record).catch(() => {});
        try {
          const alarms = evaluate(param, rounded);
          broadcast("plc-data", record);
          if (alarms && alarms.length) {
            broadcast("plc-alarm", { parameter: param, value: rounded, alarms, simulated: false });
          }
        } catch (err) {}
      }
      
      // Skip to next record (skip padding: 00 00 02 00 01 D8)
      i += 6 + nameLen + 1 + unitLen + 6;
    }
    
    if (!found && !/^[0-9A-Fa-f]{50,}$/.test(hex)) {
      console.warn(`[plc] invalid payload on ${topic}: ${String(raw).slice(0, 50)}`);
    }
    
  } catch (err) {
    console.error('[plc] Error:', err.message);
  }
}

function parseSimple(raw) {
  const str = String(raw).trim();
  if (!str) return null;
  
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj.value === 'number') {
      return { value: obj.value, timestamp: obj.timestamp || new Date().toISOString(), simulated: obj.simulated || false, parameter: obj.parameter || null };
    }
  } catch (_) {}
  
  const num = Number(str);
  if (!isNaN(num) && /^-?\d+(\.\d+)?$/.test(str)) {
    return { value: num, timestamp: new Date().toISOString(), simulated: false, parameter: null };
  }
  return null;
}

function processRecord(topic, param, value, timestamp, simulated) {
  const record = { topic, parameter: param, value, timestamp, simulated, unit: '' };
  latest[param] = record;
  dataCount++;
  console.log(`[plc] ✅ ${param} = ${value}`);
  saveMeasurement(record).catch(() => {});
  try {
    const alarms = evaluate(param, value);
    broadcast("plc-data", record);
    if (alarms && alarms.length) {
      broadcast("plc-alarm", { parameter: param, value, alarms, simulated });
    }
  } catch (err) {}
}

function getLatestSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(latest)) out[k] = v.value;
  return out;
}

function getLatestFull() { return { ...latest }; }

module.exports = { handleIncoming, getLatestSnapshot, getLatestFull };const { parameterFromTopic } = require("../mqtt/topicManager");
const { broadcast } = require("./socketService");
const { evaluate } = require("./alarmService");
const { saveMeasurement } = require("../database/postgres");

const latest = {};
let dataCount = 0;

function handleIncoming(topic, raw) {
  try {
    let hex = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw);
    hex = hex.replace(/[^0-9A-Fa-f]/g, '');
    
    if (hex.length < 30 || !/^[0-9A-Fa-f]+$/.test(hex)) {
      // Handle JSON/number payloads
      const simple = parseSimple(raw);
      if (simple) {
        const param = simple.parameter || parameterFromTopic(topic);
        if (param) processRecord(topic, param, simple.value, simple.timestamp, simple.simulated);
      }
      return;
    }

    const buffer = Buffer.from(hex, 'hex');
    let i = 0;
    let found = false;

    while (i < buffer.length - 8) {
      // Find 0x06 marker
      if (buffer[i] !== 0x06) { i++; continue; }
      
      // Read value (4 bytes after 0x06)
      if (i + 5 > buffer.length) break;
      const value = buffer.readFloatBE(i + 1);
      
      // Read name length
      const nameLen = buffer[i + 5];
      if (nameLen < 3 || nameLen > 60 || i + 6 + nameLen > buffer.length) {
        i++;
        continue;
      }
      
      // Read name
      const name = buffer.slice(i + 6, i + 6 + nameLen).toString('ascii');
      
      // Read unit
      const unitStart = i + 6 + nameLen;
      if (unitStart >= buffer.length) break;
      const unitLen = buffer[unitStart];
      let unit = '';
      if (unitLen > 0 && unitLen < 20 && unitStart + 1 + unitLen <= buffer.length) {
        unit = buffer.slice(unitStart + 1, unitStart + 1 + unitLen).toString('ascii');
      }
      
      // Extract parameter name
      let param = name;
      const dash = name.lastIndexOf('-');
      if (dash !== -1) param = name.substring(dash + 1);
      param = param.replace(/[^A-Za-z0-9]/g, '');
      
      if (param && param.length > 2 && !isNaN(value) && isFinite(value) && Math.abs(value) < 1000) {
        found = true;
        const rounded = Math.round(value * 100) / 100;
        console.log(`[plc] ✅ ${param} = ${rounded} ${unit}`);
        
        const record = {
          topic,
          parameter: param,
          value: rounded,
          timestamp: new Date().toISOString(),
          simulated: false,
          unit: unit || ''
        };
        
        latest[param] = record;
        dataCount++;
        
        saveMeasurement(record).catch(() => {});
        try {
          const alarms = evaluate(param, rounded);
          broadcast("plc-data", record);
          if (alarms && alarms.length) {
            broadcast("plc-alarm", { parameter: param, value: rounded, alarms, simulated: false });
          }
        } catch (err) {}
      }
      
      // Skip to next record (skip padding: 00 00 02 00 01 D8)
      i += 6 + nameLen + 1 + unitLen + 6;
    }
    
    if (!found && !/^[0-9A-Fa-f]{50,}$/.test(hex)) {
      console.warn(`[plc] invalid payload on ${topic}: ${String(raw).slice(0, 50)}`);
    }
    
  } catch (err) {
    console.error('[plc] Error:', err.message);
  }
}

function parseSimple(raw) {
  const str = String(raw).trim();
  if (!str) return null;
  
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj.value === 'number') {
      return { value: obj.value, timestamp: obj.timestamp || new Date().toISOString(), simulated: obj.simulated || false, parameter: obj.parameter || null };
    }
  } catch (_) {}
  
  const num = Number(str);
  if (!isNaN(num) && /^-?\d+(\.\d+)?$/.test(str)) {
    return { value: num, timestamp: new Date().toISOString(), simulated: false, parameter: null };
  }
  return null;
}

function processRecord(topic, param, value, timestamp, simulated) {
  const record = { topic, parameter: param, value, timestamp, simulated, unit: '' };
  latest[param] = record;
  dataCount++;
  console.log(`[plc] ✅ ${param} = ${value}`);
  saveMeasurement(record).catch(() => {});
  try {
    const alarms = evaluate(param, value);
    broadcast("plc-data", record);
    if (alarms && alarms.length) {
      broadcast("plc-alarm", { parameter: param, value, alarms, simulated });
    }
  } catch (err) {}
}

function getLatestSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(latest)) out[k] = v.value;
  return out;
}

function getLatestFull() { return { ...latest }; }

module.exports = { handleIncoming, getLatestSnapshot, getLatestFull };const { parameterFromTopic } = require("../mqtt/topicManager");
const { broadcast } = require("./socketService");
const { evaluate } = require("./alarmService");
const { saveMeasurement } = require("../database/postgres");

const latest = {};
let dataCount = 0;

function handleIncoming(topic, raw) {
  try {
    let hex = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw);
    hex = hex.replace(/[^0-9A-Fa-f]/g, '');
    
    if (hex.length < 30 || !/^[0-9A-Fa-f]+$/.test(hex)) {
      // Handle JSON/number payloads
      const simple = parseSimple(raw);
      if (simple) {
        const param = simple.parameter || parameterFromTopic(topic);
        if (param) processRecord(topic, param, simple.value, simple.timestamp, simple.simulated);
      }
      return;
    }

    const buffer = Buffer.from(hex, 'hex');
    let i = 0;
    let found = false;

    while (i < buffer.length - 8) {
      // Find 0x06 marker
      if (buffer[i] !== 0x06) { i++; continue; }
      
      // Read value (4 bytes after 0x06)
      if (i + 5 > buffer.length) break;
      const value = buffer.readFloatBE(i + 1);
      
      // Read name length
      const nameLen = buffer[i + 5];
      if (nameLen < 3 || nameLen > 60 || i + 6 + nameLen > buffer.length) {
        i++;
        continue;
      }
      
      // Read name
      const name = buffer.slice(i + 6, i + 6 + nameLen).toString('ascii');
      
      // Read unit
      const unitStart = i + 6 + nameLen;
      if (unitStart >= buffer.length) break;
      const unitLen = buffer[unitStart];
      let unit = '';
      if (unitLen > 0 && unitLen < 20 && unitStart + 1 + unitLen <= buffer.length) {
        unit = buffer.slice(unitStart + 1, unitStart + 1 + unitLen).toString('ascii');
      }
      
      // Extract parameter name
      let param = name;
      const dash = name.lastIndexOf('-');
      if (dash !== -1) param = name.substring(dash + 1);
      param = param.replace(/[^A-Za-z0-9]/g, '');
      
      if (param && param.length > 2 && !isNaN(value) && isFinite(value) && Math.abs(value) < 1000) {
        found = true;
        const rounded = Math.round(value * 100) / 100;
        console.log(`[plc] ✅ ${param} = ${rounded} ${unit}`);
        
        const record = {
          topic,
          parameter: param,
          value: rounded,
          timestamp: new Date().toISOString(),
          simulated: false,
          unit: unit || ''
        };
        
        latest[param] = record;
        dataCount++;
        
        saveMeasurement(record).catch(() => {});
        try {
          const alarms = evaluate(param, rounded);
          broadcast("plc-data", record);
          if (alarms && alarms.length) {
            broadcast("plc-alarm", { parameter: param, value: rounded, alarms, simulated: false });
          }
        } catch (err) {}
      }
      
      // Skip to next record (skip padding: 00 00 02 00 01 D8)
      i += 6 + nameLen + 1 + unitLen + 6;
    }
    
    if (!found && !/^[0-9A-Fa-f]{50,}$/.test(hex)) {
      console.warn(`[plc] invalid payload on ${topic}: ${String(raw).slice(0, 50)}`);
    }
    
  } catch (err) {
    console.error('[plc] Error:', err.message);
  }
}

function parseSimple(raw) {
  const str = String(raw).trim();
  if (!str) return null;
  
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj.value === 'number') {
      return { value: obj.value, timestamp: obj.timestamp || new Date().toISOString(), simulated: obj.simulated || false, parameter: obj.parameter || null };
    }
  } catch (_) {}
  
  const num = Number(str);
  if (!isNaN(num) && /^-?\d+(\.\d+)?$/.test(str)) {
    return { value: num, timestamp: new Date().toISOString(), simulated: false, parameter: null };
  }
  return null;
}

function processRecord(topic, param, value, timestamp, simulated) {
  const record = { topic, parameter: param, value, timestamp, simulated, unit: '' };
  latest[param] = record;
  dataCount++;
  console.log(`[plc] ✅ ${param} = ${value}`);
  saveMeasurement(record).catch(() => {});
  try {
    const alarms = evaluate(param, value);
    broadcast("plc-data", record);
    if (alarms && alarms.length) {
      broadcast("plc-alarm", { parameter: param, value, alarms, simulated });
    }
  } catch (err) {}
}

function getLatestSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(latest)) out[k] = v.value;
  return out;
}

function getLatestFull() { return { ...latest }; }

module.exports = { handleIncoming, getLatestSnapshot, getLatestFull };const { parameterFromTopic } = require("../mqtt/topicManager");
const { broadcast } = require("./socketService");
const { evaluate } = require("./alarmService");
const { saveMeasurement } = require("../database/postgres");

const latest = {};
let dataCount = 0;

function handleIncoming(topic, raw) {
  try {
    let hex = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw);
    hex = hex.replace(/[^0-9A-Fa-f]/g, '');
    
    if (hex.length < 30 || !/^[0-9A-Fa-f]+$/.test(hex)) {
      // Handle JSON/number payloads
      const simple = parseSimple(raw);
      if (simple) {
        const param = simple.parameter || parameterFromTopic(topic);
        if (param) processRecord(topic, param, simple.value, simple.timestamp, simple.simulated);
      }
      return;
    }

    const buffer = Buffer.from(hex, 'hex');
    let i = 0;
    let found = false;

    while (i < buffer.length - 8) {
      // Find 0x06 marker
      if (buffer[i] !== 0x06) { i++; continue; }
      
      // Read value (4 bytes after 0x06)
      if (i + 5 > buffer.length) break;
      const value = buffer.readFloatBE(i + 1);
      
      // Read name length
      const nameLen = buffer[i + 5];
      if (nameLen < 3 || nameLen > 60 || i + 6 + nameLen > buffer.length) {
        i++;
        continue;
      }
      
      // Read name
      const name = buffer.slice(i + 6, i + 6 + nameLen).toString('ascii');
      
      // Read unit
      const unitStart = i + 6 + nameLen;
      if (unitStart >= buffer.length) break;
      const unitLen = buffer[unitStart];
      let unit = '';
      if (unitLen > 0 && unitLen < 20 && unitStart + 1 + unitLen <= buffer.length) {
        unit = buffer.slice(unitStart + 1, unitStart + 1 + unitLen).toString('ascii');
      }
      
      // Extract parameter name
      let param = name;
      const dash = name.lastIndexOf('-');
      if (dash !== -1) param = name.substring(dash + 1);
      param = param.replace(/[^A-Za-z0-9]/g, '');
      
      if (param && param.length > 2 && !isNaN(value) && isFinite(value) && Math.abs(value) < 1000) {
        found = true;
        const rounded = Math.round(value * 100) / 100;
        console.log(`[plc] ✅ ${param} = ${rounded} ${unit}`);
        
        const record = {
          topic,
          parameter: param,
          value: rounded,
          timestamp: new Date().toISOString(),
          simulated: false,
          unit: unit || ''
        };
        
        latest[param] = record;
        dataCount++;
        
        saveMeasurement(record).catch(() => {});
        try {
          const alarms = evaluate(param, rounded);
          broadcast("plc-data", record);
          if (alarms && alarms.length) {
            broadcast("plc-alarm", { parameter: param, value: rounded, alarms, simulated: false });
          }
        } catch (err) {}
      }
      
      // Skip to next record (skip padding: 00 00 02 00 01 D8)
      i += 6 + nameLen + 1 + unitLen + 6;
    }
    
    if (!found && !/^[0-9A-Fa-f]{50,}$/.test(hex)) {
      console.warn(`[plc] invalid payload on ${topic}: ${String(raw).slice(0, 50)}`);
    }
    
  } catch (err) {
    console.error('[plc] Error:', err.message);
  }
}

function parseSimple(raw) {
  const str = String(raw).trim();
  if (!str) return null;
  
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj.value === 'number') {
      return { value: obj.value, timestamp: obj.timestamp || new Date().toISOString(), simulated: obj.simulated || false, parameter: obj.parameter || null };
    }
  } catch (_) {}
  
  const num = Number(str);
  if (!isNaN(num) && /^-?\d+(\.\d+)?$/.test(str)) {
    return { value: num, timestamp: new Date().toISOString(), simulated: false, parameter: null };
  }
  return null;
}

function processRecord(topic, param, value, timestamp, simulated) {
  const record = { topic, parameter: param, value, timestamp, simulated, unit: '' };
  latest[param] = record;
  dataCount++;
  console.log(`[plc] ✅ ${param} = ${value}`);
  saveMeasurement(record).catch(() => {});
  try {
    const alarms = evaluate(param, value);
    broadcast("plc-data", record);
    if (alarms && alarms.length) {
      broadcast("plc-alarm", { parameter: param, value, alarms, simulated });
    }
  } catch (err) {}
}

function getLatestSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(latest)) out[k] = v.value;
  return out;
}

function getLatestFull() { return { ...latest }; }

module.exports = { handleIncoming, getLatestSnapshot, getLatestFull };const { parameterFromTopic } = require("../mqtt/topicManager");
const { broadcast } = require("./socketService");
const { evaluate } = require("./alarmService");
const { saveMeasurement } = require("../database/postgres");

const latest = {};
let dataCount = 0;

function handleIncoming(topic, raw) {
  try {
    let hex = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw);
    hex = hex.replace(/[^0-9A-Fa-f]/g, '');
    
    if (hex.length < 30 || !/^[0-9A-Fa-f]+$/.test(hex)) {
      // Handle JSON/number payloads
      const simple = parseSimple(raw);
      if (simple) {
        const param = simple.parameter || parameterFromTopic(topic);
        if (param) processRecord(topic, param, simple.value, simple.timestamp, simple.simulated);
      }
      return;
    }

    const buffer = Buffer.from(hex, 'hex');
    let i = 0;
    let found = false;

    while (i < buffer.length - 8) {
      // Find 0x06 marker
      if (buffer[i] !== 0x06) { i++; continue; }
      
      // Read value (4 bytes after 0x06)
      if (i + 5 > buffer.length) break;
      const value = buffer.readFloatBE(i + 1);
      
      // Read name length
      const nameLen = buffer[i + 5];
      if (nameLen < 3 || nameLen > 60 || i + 6 + nameLen > buffer.length) {
        i++;
        continue;
      }
      
      // Read name
      const name = buffer.slice(i + 6, i + 6 + nameLen).toString('ascii');
      
      // Read unit
      const unitStart = i + 6 + nameLen;
      if (unitStart >= buffer.length) break;
      const unitLen = buffer[unitStart];
      let unit = '';
      if (unitLen > 0 && unitLen < 20 && unitStart + 1 + unitLen <= buffer.length) {
        unit = buffer.slice(unitStart + 1, unitStart + 1 + unitLen).toString('ascii');
      }
      
      // Extract parameter name
      let param = name;
      const dash = name.lastIndexOf('-');
      if (dash !== -1) param = name.substring(dash + 1);
      param = param.replace(/[^A-Za-z0-9]/g, '');
      
      if (param && param.length > 2 && !isNaN(value) && isFinite(value) && Math.abs(value) < 1000) {
        found = true;
        const rounded = Math.round(value * 100) / 100;
        console.log(`[plc] ✅ ${param} = ${rounded} ${unit}`);
        
        const record = {
          topic,
          parameter: param,
          value: rounded,
          timestamp: new Date().toISOString(),
          simulated: false,
          unit: unit || ''
        };
        
        latest[param] = record;
        dataCount++;
        
        saveMeasurement(record).catch(() => {});
        try {
          const alarms = evaluate(param, rounded);
          broadcast("plc-data", record);
          if (alarms && alarms.length) {
            broadcast("plc-alarm", { parameter: param, value: rounded, alarms, simulated: false });
          }
        } catch (err) {}
      }
      
      // Skip to next record (skip padding: 00 00 02 00 01 D8)
      i += 6 + nameLen + 1 + unitLen + 6;
    }
    
    if (!found && !/^[0-9A-Fa-f]{50,}$/.test(hex)) {
      console.warn(`[plc] invalid payload on ${topic}: ${String(raw).slice(0, 50)}`);
    }
    
  } catch (err) {
    console.error('[plc] Error:', err.message);
  }
}

function parseSimple(raw) {
  const str = String(raw).trim();
  if (!str) return null;
  
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj.value === 'number') {
      return { value: obj.value, timestamp: obj.timestamp || new Date().toISOString(), simulated: obj.simulated || false, parameter: obj.parameter || null };
    }
  } catch (_) {}
  
  const num = Number(str);
  if (!isNaN(num) && /^-?\d+(\.\d+)?$/.test(str)) {
    return { value: num, timestamp: new Date().toISOString(), simulated: false, parameter: null };
  }
  return null;
}

function processRecord(topic, param, value, timestamp, simulated) {
  const record = { topic, parameter: param, value, timestamp, simulated, unit: '' };
  latest[param] = record;
  dataCount++;
  console.log(`[plc] ✅ ${param} = ${value}`);
  saveMeasurement(record).catch(() => {});
  try {
    const alarms = evaluate(param, value);
    broadcast("plc-data", record);
    if (alarms && alarms.length) {
      broadcast("plc-alarm", { parameter: param, value, alarms, simulated });
    }
  } catch (err) {}
}

function getLatestSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(latest)) out[k] = v.value;
  return out;
}

function getLatestFull() { return { ...latest }; }

module.exports = { handleIncoming, getLatestSnapshot, getLatestFull };const { parameterFromTopic } = require("../mqtt/topicManager");
const { broadcast } = require("./socketService");
const { evaluate } = require("./alarmService");
const { saveMeasurement } = require("../database/postgres");

const latest = {};
let dataCount = 0;

function handleIncoming(topic, raw) {
  try {
    let hex = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw);
    hex = hex.replace(/[^0-9A-Fa-f]/g, '');
    
    if (hex.length < 30 || !/^[0-9A-Fa-f]+$/.test(hex)) {
      // Handle JSON/number payloads
      const simple = parseSimple(raw);
      if (simple) {
        const param = simple.parameter || parameterFromTopic(topic);
        if (param) processRecord(topic, param, simple.value, simple.timestamp, simple.simulated);
      }
      return;
    }

    const buffer = Buffer.from(hex, 'hex');
    let i = 0;
    let found = false;

    while (i < buffer.length - 8) {
      // Find 0x06 marker
      if (buffer[i] !== 0x06) { i++; continue; }
      
      // Read value (4 bytes after 0x06)
      if (i + 5 > buffer.length) break;
      const value = buffer.readFloatBE(i + 1);
      
      // Read name length
      const nameLen = buffer[i + 5];
      if (nameLen < 3 || nameLen > 60 || i + 6 + nameLen > buffer.length) {
        i++;
        continue;
      }
      
      // Read name
      const name = buffer.slice(i + 6, i + 6 + nameLen).toString('ascii');
      
      // Read unit
      const unitStart = i + 6 + nameLen;
      if (unitStart >= buffer.length) break;
      const unitLen = buffer[unitStart];
      let unit = '';
      if (unitLen > 0 && unitLen < 20 && unitStart + 1 + unitLen <= buffer.length) {
        unit = buffer.slice(unitStart + 1, unitStart + 1 + unitLen).toString('ascii');
      }
      
      // Extract parameter name
      let param = name;
      const dash = name.lastIndexOf('-');
      if (dash !== -1) param = name.substring(dash + 1);
      param = param.replace(/[^A-Za-z0-9]/g, '');
      
      if (param && param.length > 2 && !isNaN(value) && isFinite(value) && Math.abs(value) < 1000) {
        found = true;
        const rounded = Math.round(value * 100) / 100;
        console.log(`[plc] ✅ ${param} = ${rounded} ${unit}`);
        
        const record = {
          topic,
          parameter: param,
          value: rounded,
          timestamp: new Date().toISOString(),
          simulated: false,
          unit: unit || ''
        };
        
        latest[param] = record;
        dataCount++;
        
        saveMeasurement(record).catch(() => {});
        try {
          const alarms = evaluate(param, rounded);
          broadcast("plc-data", record);
          if (alarms && alarms.length) {
            broadcast("plc-alarm", { parameter: param, value: rounded, alarms, simulated: false });
          }
        } catch (err) {}
      }
      
      // Skip to next record (skip padding: 00 00 02 00 01 D8)
      i += 6 + nameLen + 1 + unitLen + 6;
    }
    
    if (!found && !/^[0-9A-Fa-f]{50,}$/.test(hex)) {
      console.warn(`[plc] invalid payload on ${topic}: ${String(raw).slice(0, 50)}`);
    }
    
  } catch (err) {
    console.error('[plc] Error:', err.message);
  }
}

function parseSimple(raw) {
  const str = String(raw).trim();
  if (!str) return null;
  
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj.value === 'number') {
      return { value: obj.value, timestamp: obj.timestamp || new Date().toISOString(), simulated: obj.simulated || false, parameter: obj.parameter || null };
    }
  } catch (_) {}
  
  const num = Number(str);
  if (!isNaN(num) && /^-?\d+(\.\d+)?$/.test(str)) {
    return { value: num, timestamp: new Date().toISOString(), simulated: false, parameter: null };
  }
  return null;
}

function processRecord(topic, param, value, timestamp, simulated) {
  const record = { topic, parameter: param, value, timestamp, simulated, unit: '' };
  latest[param] = record;
  dataCount++;
  console.log(`[plc] ✅ ${param} = ${value}`);
  saveMeasurement(record).catch(() => {});
  try {
    const alarms = evaluate(param, value);
    broadcast("plc-data", record);
    if (alarms && alarms.length) {
      broadcast("plc-alarm", { parameter: param, value, alarms, simulated });
    }
  } catch (err) {}
}

function getLatestSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(latest)) out[k] = v.value;
  return out;
}

function getLatestFull() { return { ...latest }; }

module.exports = { handleIncoming, getLatestSnapshot, getLatestFull };const { parameterFromTopic } = require("../mqtt/topicManager");
const { broadcast } = require("./socketService");
const { evaluate } = require("./alarmService");
const { saveMeasurement } = require("../database/postgres");

const latest = {};
let dataCount = 0;

function handleIncoming(topic, raw) {
  try {
    let hex = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw);
    hex = hex.replace(/[^0-9A-Fa-f]/g, '');
    
    if (hex.length < 30 || !/^[0-9A-Fa-f]+$/.test(hex)) {
      // Handle JSON/number payloads
      const simple = parseSimple(raw);
      if (simple) {
        const param = simple.parameter || parameterFromTopic(topic);
        if (param) processRecord(topic, param, simple.value, simple.timestamp, simple.simulated);
      }
      return;
    }

    const buffer = Buffer.from(hex, 'hex');
    let i = 0;
    let found = false;

    while (i < buffer.length - 8) {
      // Find 0x06 marker
      if (buffer[i] !== 0x06) { i++; continue; }
      
      // Read value (4 bytes after 0x06)
      if (i + 5 > buffer.length) break;
      const value = buffer.readFloatBE(i + 1);
      
      // Read name length
      const nameLen = buffer[i + 5];
      if (nameLen < 3 || nameLen > 60 || i + 6 + nameLen > buffer.length) {
        i++;
        continue;
      }
      
      // Read name
      const name = buffer.slice(i + 6, i + 6 + nameLen).toString('ascii');
      
      // Read unit
      const unitStart = i + 6 + nameLen;
      if (unitStart >= buffer.length) break;
      const unitLen = buffer[unitStart];
      let unit = '';
      if (unitLen > 0 && unitLen < 20 && unitStart + 1 + unitLen <= buffer.length) {
        unit = buffer.slice(unitStart + 1, unitStart + 1 + unitLen).toString('ascii');
      }
      
      // Extract parameter name
      let param = name;
      const dash = name.lastIndexOf('-');
      if (dash !== -1) param = name.substring(dash + 1);
      param = param.replace(/[^A-Za-z0-9]/g, '');
      
      if (param && param.length > 2 && !isNaN(value) && isFinite(value) && Math.abs(value) < 1000) {
        found = true;
        const rounded = Math.round(value * 100) / 100;
        console.log(`[plc] ✅ ${param} = ${rounded} ${unit}`);
        
        const record = {
          topic,
          parameter: param,
          value: rounded,
          timestamp: new Date().toISOString(),
          simulated: false,
          unit: unit || ''
        };
        
        latest[param] = record;
        dataCount++;
        
        saveMeasurement(record).catch(() => {});
        try {
          const alarms = evaluate(param, rounded);
          broadcast("plc-data", record);
          if (alarms && alarms.length) {
            broadcast("plc-alarm", { parameter: param, value: rounded, alarms, simulated: false });
          }
        } catch (err) {}
      }
      
      // Skip to next record (skip padding: 00 00 02 00 01 D8)
      i += 6 + nameLen + 1 + unitLen + 6;
    }
    
    if (!found && !/^[0-9A-Fa-f]{50,}$/.test(hex)) {
      console.warn(`[plc] invalid payload on ${topic}: ${String(raw).slice(0, 50)}`);
    }
    
  } catch (err) {
    console.error('[plc] Error:', err.message);
  }
}

function parseSimple(raw) {
  const str = String(raw).trim();
  if (!str) return null;
  
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj.value === 'number') {
      return { value: obj.value, timestamp: obj.timestamp || new Date().toISOString(), simulated: obj.simulated || false, parameter: obj.parameter || null };
    }
  } catch (_) {}
  
  const num = Number(str);
  if (!isNaN(num) && /^-?\d+(\.\d+)?$/.test(str)) {
    return { value: num, timestamp: new Date().toISOString(), simulated: false, parameter: null };
  }
  return null;
}

function processRecord(topic, param, value, timestamp, simulated) {
  const record = { topic, parameter: param, value, timestamp, simulated, unit: '' };
  latest[param] = record;
  dataCount++;
  console.log(`[plc] ✅ ${param} = ${value}`);
  saveMeasurement(record).catch(() => {});
  try {
    const alarms = evaluate(param, value);
    broadcast("plc-data", record);
    if (alarms && alarms.length) {
      broadcast("plc-alarm", { parameter: param, value, alarms, simulated });
    }
  } catch (err) {}
}

function getLatestSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(latest)) out[k] = v.value;
  return out;
}

function getLatestFull() { return { ...latest }; }

module.exports = { handleIncoming, getLatestSnapshot, getLatestFull };