// backend/services/plcService.js - UPDATED WITH FIX

'use strict';

const fs = require('fs');
const path = require('path');

const { parameterFromTopic, KNOWN_PARAMETERS } = require('../mqtt/topicManager');
const { broadcast } = require('./socketService');
const { evaluate } = require('./alarmService');
const { saveMeasurement } = require('../database/postgres');

const DEBUG_PARSE = Boolean(process.env.DEBUG_PARSE && process.env.DEBUG_PARSE !== '0');
const LOG_RAW = process.env.LOG_RAW === undefined ? true : process.env.LOG_RAW !== '0';
const ARCHIVE_RAW_FAILED = Boolean(process.env.ARCHIVE_RAW_FAILED && process.env.ARCHIVE_RAW_FAILED !== '0');
const CALIBRATION_FILE = process.env.CALIBRATION_FILE || path.resolve(__dirname, '..', 'data', 'calibration.json');
const MIN_VALID_ABS_VALUE = Number(process.env.MIN_VALID_ABS_VALUE) || 1e-6;

const latest = {};
let dataCount = 0;

/* ------------------ buffer / hex helpers ------------------ */

function isHexString(s) {
  return typeof s === 'string' && s.length > 0 && s.length % 2 === 0 && /^[0-9A-Fa-f]+$/.test(s);
}

function bufferFromRaw(raw) {
  if (raw == null) return null;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    return Buffer.from(trimmed, 'utf8');
  }
  try { return Buffer.from(String(raw)); } catch (_) { return null; }
}

function hexdump(buf, maxBytes = 256) {
  if (!Buffer.isBuffer(buf)) return '';
  const lines = [];
  for (let i = 0; i < Math.min(buf.length, maxBytes); i += 16) {
    const slice = buf.slice(i, Math.min(i + 16, buf.length));
    const hex = slice.toString('hex').match(/.{1,2}/g).join(' ');
    const ascii = slice.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
    lines.push(`${i.toString(16).padStart(4, '0')}  ${hex.padEnd(16 * 3 - 1)}  ${ascii}`);
  }
  return lines.join('\n');
}

function peelHexLayers(initialBuf, maxLayers = 4) {
  let buf = initialBuf;
  let layersPeeled = 0;
  for (let layer = 0; layer < maxLayers; layer++) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) break;
    const asAscii = buf.toString('ascii');
    const cleaned = asAscii.replace(/[^0-9A-Fa-f]+$/, '');
    if (cleaned.length < 8) break;
    if (!isHexString(cleaned)) break;
    try {
      const decoded = Buffer.from(cleaned, 'hex');
      buf = decoded;
      layersPeeled++;
    } catch (_) {
      break;
    }
  }
  return { buffer: buf, layersPeeled };
}

/* ------------------ named-record parser (siemens200smart style) ------------------ */

function isPrintableAscii(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
  const s = buf.toString('ascii');
  return /^[\x20-\x7E]+$/.test(s);
}

function readFloatBADC(buf, offset) {
  if (offset < 0 || offset + 4 > buf.length) return NaN;
  const b0 = buf[offset], b1 = buf[offset + 1], b2 = buf[offset + 2], b3 = buf[offset + 3];
  return Buffer.from([b1, b0, b3, b2]).readFloatLE(0);
}

/**
 * Parse the level-2 binary buffer into named tag readings.
 * Now handles both float32 (4 bytes) and bit/byte (1 byte) values.
 */
function parseNamedRecords(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) return [];

  const markers = [];
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0xD8 && buf[i + 1] === 0x00 && buf[i + 2] === 0x00 && buf[i + 3] === 0x00) {
      markers.push(i);
    }
  }
  if (markers.length === 0) return [];

  const records = [];
  for (let m = 0; m < markers.length; m++) {
    const i = markers[m];
    const nextMarker = markers[m + 1] !== undefined ? markers[m + 1] : buf.length;

    if (i + 18 > buf.length) continue;

    const recordIndex = buf.readUInt32BE(i + 4);
    const typeByte = buf[i + 11];
    const lenByte = buf[i + 12];

    let value;
    let dataType = 'float';
    
    try {
      if (lenByte === 4) {
        // Float32 (4 bytes)
        value = readFloatBADC(buf, i + 13);
        dataType = 'float';
      } else if (lenByte === 1) {
        // Bit/Byte (1 byte)
        value = buf[i + 13] || 0;
        dataType = 'bit';
      } else {
        // Unknown type, skip
        continue;
      }
    } catch (_) {
      continue;
    }

    const nameLenDeclared = buf[i + 17];
    const nameStartBase = i + 18;

    let parsed = null;
    for (const delta of [0, -1, 1, -2, 2]) {
      const nameLen = nameLenDeclared + delta;
      if (nameLen < 1 || nameLen > 80) continue;
      const nameEnd = nameStartBase + nameLen;
      if (nameEnd >= nextMarker || nameEnd > buf.length) continue;

      const nameBuf = buf.slice(nameStartBase, nameEnd);
      if (!isPrintableAscii(nameBuf)) continue;

      const unitLen = buf[nameEnd];
      const unitStart = nameEnd + 1;
      const unitEnd = unitStart + unitLen;
      if (unitEnd > nextMarker || unitEnd > buf.length) continue;

      const unitBuf = buf.slice(unitStart, unitEnd);
      if (unitLen > 0 && !isPrintableAscii(unitBuf)) continue;

      parsed = { name: nameBuf.toString('ascii'), unit: unitBuf.toString('ascii') };
      break;
    }

    if (!parsed) {
      if (DEBUG_PARSE) console.warn(`[plc] record at offset ${i} (index ${recordIndex}) could not resolve name/unit; skipping`);
      continue;
    }

    records.push({
      parameter: parsed.name,
      unit: parsed.unit,
      value: value,
      recordIndex,
      typeByte,
      dataType,
      timestamp: new Date().toISOString(),
      simulated: false,
      debug: { offset: i, recordIndex, dataType }
    });
  }

  return records;
}

/* ------------------ legacy heuristic parser (fallback) ------------------ */

function tryReadFloatAt(buf, offset) {
  if (!Buffer.isBuffer(buf)) return { ok: false };
  if (offset < 0 || offset + 4 > buf.length) return { ok: false };
  try {
    const le = buf.readFloatLE(offset);
    if (Number.isFinite(le) && Math.abs(le) < 1e7) return { ok: true, value: le, endian: 'LE' };
  } catch (_) {}
  try {
    const be = buf.readFloatBE(offset);
    if (Number.isFinite(be) && Math.abs(be) < 1e7) return { ok: true, value: be, endian: 'BE' };
  } catch (_) {}
  return { ok: false };
}

function findNearestFloat(buf, asciiPos, window = 48) {
  if (!Buffer.isBuffer(buf)) return null;
  const start = Math.max(0, asciiPos - window);
  const end = Math.min(buf.length - 4, asciiPos + window);
  let best = null;
  for (let off = start; off <= end; off++) {
    const r = tryReadFloatAt(buf, off);
    if (!r.ok) continue;
    const distance = Math.abs(off - asciiPos);
    if (!best || distance < best.distance || (distance === best.distance && r.endian === 'LE')) {
      best = { offset: off, value: r.value, distance, endian: r.endian };
    }
  }
  return best;
}

function parseAboxPayload(buf) {
  if (!Buffer.isBuffer(buf)) return [];

  const ascii = buf.toString('ascii');
  const dRegex = /D(\d{3,5})/g;
  const measurements = [];
  let match;
  const seenDcodes = new Set();

  while ((match = dRegex.exec(ascii)) !== null) {
    const dc = match[1];
    if (seenDcodes.has(dc)) continue;
    seenDcodes.add(dc);

    const asciiIndex = match.index;
    const floatCandidate = findNearestFloat(buf, asciiIndex, 64);
    if (floatCandidate) {
      measurements.push({
        dcode: dc,
        parameter: null,
        value: floatCandidate.value,
        timestamp: new Date().toISOString(),
        simulated: false,
        debug: { asciiIndex, floatOffset: floatCandidate.offset, endian: floatCandidate.endian, distance: floatCandidate.distance }
      });
    }
  }

  if (DEBUG_PARSE) {
    console.debug('[plc] parseAboxPayload (fallback): buffer len', buf.length, 'found D-codes:', Array.from(seenDcodes).slice(0, 200));
  }

  return measurements;
}

/* ------------------ legacy calibration support ------------------ */

function readByMethod(buf, offset, method) {
  try {
    if (method === 'floatLE') return buf.readFloatLE(offset);
    if (method === 'floatBE') return buf.readFloatBE(offset);
    if (method === 'int32LE') return buf.readInt32LE(offset);
    if (method === 'int32BE') return buf.readInt32BE(offset);
    if (method === 'int32_scaled_1e3_LE') return buf.readInt32LE(offset) / 1000;
    if (method === 'int32_scaled_1e2_LE') return buf.readInt32LE(offset) / 100;
    if (method === 'int32_scaled_1e3_BE') return buf.readInt32BE(offset) / 1000;
    if (method === 'int32_scaled_1e2_BE') return buf.readInt32BE(offset) / 100;
    return null;
  } catch (err) {
    return null;
  }
}

function parseWithCalibration(buf, calibration) {
  if (!buf || !calibration) return [];
  const rows = [];
  for (const [dcode, spec] of Object.entries(calibration)) {
    if (!spec || typeof spec.offset !== 'number' || !spec.method) continue;
    const v = readByMethod(buf, spec.offset, spec.method);
    rows.push({ dcode, parameter: spec.parameter || null, value: Number.isFinite(v) ? v : null, debug: spec });
  }
  return rows;
}

let calibration = null;
function loadCalibration() {
  try {
    if (fs.existsSync(CALIBRATION_FILE)) {
      const raw = fs.readFileSync(CALIBRATION_FILE, 'utf8');
      calibration = JSON.parse(raw);
      console.log('[plc] loaded legacy calibration file:', CALIBRATION_FILE, 'entries=', Object.keys(calibration).length);
    } else {
      calibration = null;
    }
  } catch (err) {
    calibration = null;
    console.error('[plc] failed to load calibration file:', err && err.message ? err.message : err);
  }
}
loadCalibration();

/* ------------------ misc helpers ------------------ */

function isValidParameterName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return false;
  if (/^[0-9A-Fa-f]{8,}$/.test(trimmed)) return false;
  return /^[\w\s\-\/\.\:%]{1,80}$/.test(trimmed);
}

function archiveRawPayload(topic, rawBuf) {
  try {
    const dir = path.resolve(__dirname, '..', 'data', 'raw_payloads');
    fs.mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const hex = Buffer.isBuffer(rawBuf) ? rawBuf.toString('hex') : String(rawBuf);
    const fname = path.join(dir, `raw_${ts}.hex`);
    fs.writeFileSync(fname, `${topic}\n${hex}\n`, 'utf8');
    if (DEBUG_PARSE) console.debug('[plcService] archived raw payload to', fname);
  } catch (err) {
    console.error('[plcService] archiveRawPayload error:', err && err.message ? err.message : err);
  }
}

function recordToDB(record) {
  if (!record) return Promise.resolve();
  if (record.simulated) return Promise.resolve();
  if (record.value === null || record.value === undefined) return Promise.resolve();
  const payload = {
    topic: record.topic,
    parameter: record.parameter,
    value: record.value,
    unit: record.unit,
    timestamp: record.timestamp,
    simulated: !!record.simulated,
    debug: record.debug
  };
  return saveMeasurement(payload);
}

/* ------------------ PROCESSING PIPELINE ------------------ */

function processMeasurement(topic, measurement, idx, rawBuf) {
  let parameter = measurement.parameter || parameterFromTopic(topic) || null;
  
  // ✅ MAP AntiscalantDoser to the correct parameter name
  if (parameter === 'AntiscalantDoser' || parameter === 'DosingActive') {
    parameter = 'AntiscalantDosingActive';
  }
  
  if (!isValidParameterName(parameter)) {
    parameter = parameterFromTopic(topic) || `unknown_${idx || 'x'}`;
  }

  // ✅ FIX: Keep numeric values, don't convert to strings
  let record = {
    topic,
    parameter,
    unit: measurement.unit || null,
    value: (measurement.value === undefined) ? null : measurement.value,
    timestamp: measurement.timestamp || new Date().toISOString(),
    simulated: !!measurement.simulated,
    dataType: measurement.dataType || 'float',
    debug: measurement.debug || {}
  };

  // ✅ FIX: Keep value as number, add status as separate field if needed
  const isAntiscalant = parameter === 'AntiscalantDosingActive';
  if (isAntiscalant) {
    // Keep numeric value for calculations
    const numValue = Number(record.value);
    record.value = isNaN(numValue) ? 0 : numValue; // 0 or 1
    record.unit = '';
    record.dataType = 'bit';
    record.status = record.value === 1 ? 'ON' : 'OFF'; // Add status for display
    
    console.log(`[plc] ${parameter}: value=${record.value}, status=${record.status}`);
  }

  latest[parameter] = record;
  dataCount++;

  if (dataCount % 50 === 0) {
    console.log(`[plc] 📊 Processed ${dataCount} data points. Latest: ${parameter}=${record.value}${record.unit ? ' ' + record.unit : ''}`);
  }

  if (record.value === null || !Number.isFinite(record.value)) {
    if (ARCHIVE_RAW_FAILED || DEBUG_PARSE) archiveRawPayload(topic, rawBuf);
    if (DEBUG_PARSE) console.warn('[plc] parsed null/invalid value, skipping DB & alarms:', { parameter, value: record.value });
    try { broadcast('plc-data', record); } catch (e) {}
    return;
  }

  recordToDB(record).catch((err) => {
    if (dataCount % 100 === 0) {
      console.error('[db] save failed (continuing):', err && err.message ? err.message : err);
    }
  });

  try {
    const alarms = evaluate(parameter, record.value);
    broadcast('plc-data', record);
    if (alarms && alarms.length) {
      broadcast('plc-alarm', { parameter, value: record.value, alarms, simulated: record.simulated });
    }
  } catch (err) {
    console.error('[plc] evaluate/broadcast error:', err && err.message ? err.message : err);
    try { broadcast('plc-data', record); } catch (e) {}
  }
}

/* ------------------ MAIN HANDLER ------------------ */

function handleIncoming(topic, raw) {
  const rawBuf = bufferFromRaw(raw);

  if (LOG_RAW) {
    if (rawBuf) {
      console.log(`[plc][RAW] topic=${topic} bytes=${rawBuf.length}`);
      if (DEBUG_PARSE) {
        console.log(`[plc][RAW] hex=${rawBuf.toString('hex')}`);
        console.log(`[plc][RAW] ascii=${rawBuf.toString('ascii').replace(/[^\x20-\x7E]/g, '.')}`);
      }
    } else {
      console.log(`[plc][RAW] topic=${topic} <empty/undecodable payload> typeof=${typeof raw}`);
    }
  }

  if (!rawBuf) return;

  const { buffer: decodedBuf, layersPeeled } = peelHexLayers(rawBuf);
  if (DEBUG_PARSE || LOG_RAW) {
    console.log(`[plc] peeled ${layersPeeled} hex layer(s), decoded length=${decodedBuf.length}`);
    if (DEBUG_PARSE) console.debug('[plc] decoded hexdump head:\n' + hexdump(decodedBuf, 256));
  }

  let parsedList = [];

  // 1) Primary: named-record parser (siemens200smart tag format)
  parsedList = parseNamedRecords(decodedBuf);
  if (DEBUG_PARSE) console.debug('[plcService] named-record parser rows:', parsedList.length);

  // 2) Fallback: legacy calibration (D-code offsets)
  if ((!parsedList || parsedList.length === 0) && calibration && Object.keys(calibration).length > 0) {
    try {
      parsedList = parseWithCalibration(decodedBuf, calibration);
      if (DEBUG_PARSE) console.debug('[plcService] used calibrated parser, rows:', parsedList.length);
    } catch (err) {
      console.error('[plcService] calibrated parser error:', err && err.message ? err.message : err);
    }
  }

  // 3) Fallback: legacy heuristic D-code + nearest-float search
  if (!parsedList || parsedList.length === 0) {
    try {
      parsedList = parseAboxPayload(decodedBuf);
      if (DEBUG_PARSE) console.debug('[plcService] used heuristic parser, rows:', parsedList.length);
    } catch (err) {
      console.error('[plcService] heuristic parser error:', err && err.message ? err.message : err);
    }
  }

  if (!parsedList || parsedList.length === 0) {
    console.warn('[plcService] no parse results for topic', topic, '- archiving raw for analysis');
    archiveRawPayload(topic, rawBuf);
    return;
  }

  parsedList.forEach((m, idx) => {
    try {
      processMeasurement(topic, m, idx, rawBuf);
    } catch (err) {
      console.error('[plcService] processMeasurement error:', err && err.message ? err.message : err);
    }
  });
}

/* ------------------ SNAPSHOT GETTERS ------------------ */

function getLatestSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(latest)) out[k] = v.value;
  return out;
}

function getLatestFull() { return latest; }

function getCalibration() { return calibration; }

/* ------------------ EXPORTS ------------------ */

module.exports = {
  handleIncoming,
  getLatestSnapshot,
  getLatestFull,
  getCalibration,
  // exposed for testing/debugging
  _internal: { peelHexLayers, parseNamedRecords, hexdump }
};