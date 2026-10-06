'use strict';

const fs = require('fs');
const path = require('path');

const { parameterFromTopic, KNOWN_PARAMETERS } = require('../mqtt/topicManager');
const { broadcast } = require('./socketService');
const { evaluate } = require('./alarmService');
const { saveMeasurement } = require('../database/postgres');
const { recordDosingState } = require('./dosingService');

const DEBUG_PARSE = Boolean(process.env.DEBUG_PARSE && process.env.DEBUG_PARSE !== '0');
const LOG_RAW = process.env.LOG_RAW === undefined ? true : process.env.LOG_RAW !== '0';
const ARCHIVE_RAW_FAILED = Boolean(process.env.ARCHIVE_RAW_FAILED && process.env.ARCHIVE_RAW_FAILED !== '0');
const CALIBRATION_FILE = process.env.CALIBRATION_FILE || path.resolve(__dirname, '..', 'data', 'calibration.json');
const MIN_VALID_ABS_VALUE = Number(process.env.MIN_VALID_ABS_VALUE) || 1e-6;

// ── Feed tank level calibration ──────────────────────────────────────────
// Matches frontend/components/dashboardComponents/feedTankCalibration.js:
//   raw 4.9  -> 0%
//   raw 10.0 -> 100%
// The frontend also runs its own calibration from RO5-FeedTankLevelRaw, so
// this backend value is a fallback only. Kept here so backend and frontend
// agree when the raw tag hasn't arrived yet.
const FEED_TANK_RAW_MIN = Number(process.env.FEED_TANK_RAW_MIN) || 4.9;
const FEED_TANK_RAW_MAX = Number(process.env.FEED_TANK_RAW_MAX) || 10.0;
const FEED_TANK_PCT_MIN = Number(process.env.FEED_TANK_PCT_MIN) || 0;
const FEED_TANK_PCT_MAX = Number(process.env.FEED_TANK_PCT_MAX) || 100;

function feedTankRawToPercent(raw) {
  if (!Number.isFinite(raw)) return NaN;
  const clamped = Math.min(FEED_TANK_RAW_MAX, Math.max(FEED_TANK_RAW_MIN, raw));
  return (
    FEED_TANK_PCT_MIN +
    ((clamped - FEED_TANK_RAW_MIN) * (FEED_TANK_PCT_MAX - FEED_TANK_PCT_MIN)) /
      (FEED_TANK_RAW_MAX - FEED_TANK_RAW_MIN)
  );
}

const DEBUG_LOG_FILE = path.resolve(__dirname, '..', 'debug.log');

function dlog(...args) {
  try {
    const line = `[${new Date().toISOString()}] ${args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}\n`;
    fs.appendFileSync(DEBUG_LOG_FILE, line);
  } catch (err) {
    console.error('[dlog] failed to write debug log:', err && err.message ? err.message : err);
  }
}

const latest = {};
let dataCount = 0;

// ── Parameter alias map ─────────────────────────────────────────────────
// Translates raw PLC tag names to the RO5- prefixed keys the frontend
// expects. Add new aliases here if you see a new name in debug.log.
const PARAMETER_ALIASES = {
  // System status
  'SystemActive': 'RO5-SystemActive',
  'System_Active': 'RO5-SystemActive',
  'SysActive': 'RO5-SystemActive',
  'SysOn': 'RO5-SystemActive',
  'MasterOn': 'RO5-SystemActive',
  'RunBit': 'RO5-SystemActive',
  'RO5-SystemActive': 'RO5-SystemActive',

  'SystemOperation': 'RO5-SystemOperation',
  'System_Operation': 'RO5-SystemOperation',
  'RO5-SystemOperation': 'RO5-SystemOperation',

  'SystemMode': 'RO5-SystemMode',
  'System_Mode': 'RO5-SystemMode',
  'Mode': 'RO5-SystemMode',
  'RO5-SystemMode': 'RO5-SystemMode',

  // Antiscalant
  'AntiscalantDoser': 'RO5-AntiscalantDosingActive',
  'AntiscalantDosingActive': 'RO5-AntiscalantDosingActive',
  'DosingActive': 'RO5-AntiscalantDosingActive',
  'Doser': 'RO5-AntiscalantDosingActive',
  'Dosing': 'RO5-AntiscalantDosingActive',
  'Antiscalant': 'RO5-AntiscalantDosingActive',
  'RO5-AntiscalantDosingActive': 'RO5-AntiscalantDosingActive',

  // Feed tank
  'RO5-FeedTankLevel': 'RO5-FeedTankLevel',
  'FeedTankLevel': 'RO5-FeedTankLevel',
  'FT-A': 'RO5-FeedTankLevel',
  'FeedTank': 'RO5-FeedTankLevel',
};

// Parameters that should always be coerced to 'ON'/'OFF'.
const BIT_PARAMETERS = new Set([
  'RO5-SystemActive',
  'RO5-SystemOperation',
  'RO5-AntiscalantDosingActive',
  'RO5-Feedpump',
  'RO5-PrefilterBackwash',
  'RO5-HighPrefilterDeltaP',
]);

function normalizeParameterName(rawName) {
  if (!rawName || typeof rawName !== 'string') return rawName;
  const trimmed = rawName.trim();
  return PARAMETER_ALIASES[trimmed] || trimmed;
}

function coerceBitValue(value) {
  if (value === 1 || value === '1' || value === 1.0 || value === 'ON' ||
      value === 'on' || value === true || value === 'TRUE' || value === 'true' ||
      value === 'Running') {
    return 'ON';
  }
  if (value === 0 || value === '0' || value === 0.0 || value === 'OFF' ||
      value === 'off' || value === false || value === 'FALSE' || value === 'false' ||
      value === 'Stopped') {
    return 'OFF';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0.5 ? 'ON' : 'OFF';
  }
  return value;
}

const DB_SAMPLE_INTERVAL_MS = Number(process.env.DB_SAMPLE_INTERVAL_MS) || 30000;

const lastDbWriteTime = {};
const lastDbWrittenValue = {};

function shouldWriteToDb(parameter, value, dataType) {
  const now = Date.now();
  const last = lastDbWriteTime[parameter] || 0;
  const valueChanged = lastDbWrittenValue[parameter] !== value;

  if (dataType === 'bit') {
    if (valueChanged) {
      lastDbWriteTime[parameter] = now;
      lastDbWrittenValue[parameter] = value;
      return true;
    }
  }

  if (now - last >= DB_SAMPLE_INTERVAL_MS) {
    lastDbWriteTime[parameter] = now;
    lastDbWrittenValue[parameter] = value;
    return true;
  }
  return false;
}

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
        value = readFloatBADC(buf, i + 13);
        dataType = 'float';
      } else if (lenByte === 1) {
        value = buf[i + 13] || 0;
        dataType = 'bit';
      } else {
        dlog('SKIPPED-UNHANDLED-LEN', { offset: i, recordIndex, typeByte, lenByte });
        continue;
      }
    } catch (_) {
      continue;
    }

    const nameLenDeclared = buf[i + 13 + lenByte];
    const nameStartBase = i + 13 + lenByte + 1;

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
      const sliceStart = Math.max(0, i);
      const sliceEnd = Math.min(buf.length, nextMarker);
      const rawSlice = buf.slice(sliceStart, sliceEnd);
      dlog('DROPPED-NAME-UNRESOLVED', {
        offset: i,
        recordIndex,
        typeByte,
        lenByte,
        dataType,
        value,
        nameLenDeclared,
        hex: rawSlice.toString('hex'),
        ascii: rawSlice.toString('ascii').replace(/[^\x20-\x7E]/g, '.')
      });
      continue;
    }

    dlog('RESOLVED', { offset: i, recordIndex, name: parsed.name, unit: parsed.unit, value, dataType });

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

  dlog('SUMMARY', { markersFound: markers.length, recordsResolved: records.length });

  return records;
}

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

function processMeasurement(topic, measurement, idx, rawBuf) {
  let parameter = measurement.parameter || parameterFromTopic(topic) || null;

  // ── Step 1: normalize alias -> canonical RO5- name ──────────────────
  const beforeNormalize = parameter;
  parameter = normalizeParameterName(parameter);
  if (beforeNormalize !== parameter) {
    dlog('PARAM-NORMALIZED', { from: beforeNormalize, to: parameter, topic });
  }

  // ── Step 2: coerce bit-valued parameters to 'ON'/'OFF' ──────────────
  if (BIT_PARAMETERS.has(parameter)) {
    const coerced = coerceBitValue(measurement.value);
    if (coerced !== measurement.value) {
      dlog('BIT-COERCED', { parameter, from: measurement.value, to: coerced });
    }
    measurement.value = coerced;
    measurement.dataType = 'bit';
    measurement.unit = '';
  }

  // ── Step 3: antiscalant side-effect (dosing totalizer) ──────────────
  if (parameter === 'RO5-AntiscalantDosingActive') {
    try {
      recordDosingState(measurement.value, Date.now());
    } catch (err) {
      console.error('[plc] dosing totalizer error:', err && err.message ? err.message : err);
    }
  }

  // ── Step 4: feed tank special handling ──────────────────────────────
  if (parameter === 'RO5-FeedTankLevel') {
    const rawValue = measurement.value;
    const scaledValue = feedTankRawToPercent(rawValue);

    console.log(`[plc] 📊 Feed Tank: Raw=${rawValue} → Scaled=${scaledValue.toFixed(2)}%`);

    const scaledRecord = {
      topic,
      parameter: 'RO5-FeedTankLevel',
      unit: '%',
      value: scaledValue,
      timestamp: measurement.timestamp || new Date().toISOString(),
      simulated: !!measurement.simulated,
      dataType: 'float',
      debug: {
        ...measurement.debug,
        rawValue,
        scaledValue,
        calibration: {
          rawMin: FEED_TANK_RAW_MIN,
          rawMax: FEED_TANK_RAW_MAX,
          pctMin: FEED_TANK_PCT_MIN,
          pctMax: FEED_TANK_PCT_MAX,
        },
      },
    };

    const rawRecord = {
      topic,
      parameter: 'RO5-FeedTankLevelRaw',
      unit: '',
      value: rawValue,
      timestamp: measurement.timestamp || new Date().toISOString(),
      simulated: !!measurement.simulated,
      dataType: 'float',
      debug: measurement.debug
    };

    latest[scaledRecord.parameter] = scaledRecord;
    latest[rawRecord.parameter] = rawRecord;

    broadcast('plc-data', scaledRecord);
    broadcast('plc-data', rawRecord);

    if (shouldWriteToDb('RO5-FeedTankLevel', scaledValue, 'float')) {
      recordToDB(scaledRecord).catch((err) => {
        if (dataCount % 100 === 0) {
          console.error('[db] save failed (continuing):', err && err.message ? err.message : err);
        }
      });
    }

    if (shouldWriteToDb('RO5-FeedTankLevelRaw', rawValue, 'float')) {
      recordToDB(rawRecord).catch((err) => {
        if (dataCount % 100 === 0) {
          console.error('[db] save failed (continuing):', err && err.message ? err.message : err);
        }
      });
    }

    try {
      const alarms = evaluate(scaledRecord.parameter, scaledValue);
      if (alarms && alarms.length) {
        dlog('FEED-TANK-ALARM', { parameter: scaledRecord.parameter, value: scaledValue, alarms });
        broadcast('plc-alarm', {
          parameter: scaledRecord.parameter,
          value: scaledValue,
          alarms,
          simulated: scaledRecord.simulated
        });
      }
    } catch (err) {
      console.error('[plc] feed tank evaluate/broadcast error:', err && err.message ? err.message : err);
    }

    return;
  }

  // ── Step 5: generic parameter path ──────────────────────────────────
  if (!isValidParameterName(parameter)) {
    dlog('INVALID-PARAMETER-NAME', { original: parameter, topic });
    parameter = parameterFromTopic(topic) || `unknown_${idx || 'x'}`;
  }

  const record = {
    topic,
    parameter,
    unit: measurement.unit || null,
    value: (measurement.value === undefined) ? null : measurement.value,
    timestamp: measurement.timestamp || new Date().toISOString(),
    simulated: !!measurement.simulated,
    dataType: measurement.dataType || 'float',
    debug: measurement.debug || {}
  };

  latest[parameter] = record;
  dataCount++;

  if (dataCount % 50 === 0) {
    console.log(`[plc] 📊 Processed ${dataCount} data points. Latest: ${parameter}=${record.value}${record.unit ? ' ' + record.unit : ''}`);
  }

  if (record.value === null || (record.dataType !== 'bit' && !Number.isFinite(record.value))) {
    if (ARCHIVE_RAW_FAILED || DEBUG_PARSE) archiveRawPayload(topic, rawBuf);
    if (DEBUG_PARSE) console.warn('[plc] parsed null/invalid value, skipping DB & alarms:', { parameter, value: record.value });
    try { broadcast('plc-data', record); } catch (e) {}
    return;
  }

  if (shouldWriteToDb(parameter, record.value, record.dataType)) {
    recordToDB(record).catch((err) => {
      if (dataCount % 100 === 0) {
        console.error('[db] save failed (continuing):', err && err.message ? err.message : err);
      }
    });
  }

  try {
    const alarms = record.dataType === 'bit' ? [] : evaluate(parameter, record.value);
    broadcast('plc-data', record);
    if (alarms && alarms.length) {
      broadcast('plc-alarm', { parameter, value: record.value, alarms, simulated: record.simulated });
    }
  } catch (err) {
    console.error('[plc] evaluate/broadcast error:', err && err.message ? err.message : err);
    try { broadcast('plc-data', record); } catch (e) {}
  }
}

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

  dlog('INCOMING', {
    topic,
    bytes: rawBuf.length,
    ascii: rawBuf.toString('ascii').replace(/[^\x20-\x7E]/g, '.')
  });

  const { buffer: decodedBuf, layersPeeled } = peelHexLayers(rawBuf);
  if (DEBUG_PARSE || LOG_RAW) {
    console.log(`[plc] peeled ${layersPeeled} hex layer(s), decoded length=${decodedBuf.length}`);
    if (DEBUG_PARSE) console.debug('[plc] decoded hexdump head:\n' + hexdump(decodedBuf, 256));
  }

  dlog('DECODED', {
    topic,
    layersPeeled,
    bytes: decodedBuf.length,
    ascii: decodedBuf.toString('ascii').replace(/[^\x20-\x7E]/g, '.')
  });

  let parsedList = [];

  parsedList = parseNamedRecords(decodedBuf);
  if (DEBUG_PARSE) console.debug('[plcService] named-record parser rows:', parsedList.length);

  if ((!parsedList || parsedList.length === 0) && calibration && Object.keys(calibration).length > 0) {
    try {
      parsedList = parseWithCalibration(decodedBuf, calibration);
      if (DEBUG_PARSE) console.debug('[plcService] used calibrated parser, rows:', parsedList.length);
    } catch (err) {
      console.error('[plcService] calibrated parser error:', err && err.message ? err.message : err);
    }
  }

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
    dlog('NO-PARSE-RESULTS', { topic });
    archiveRawPayload(topic, rawBuf);
    return;
  }

  // Pre-pass: log the raw name, coerce bits, and record the alias match
  parsedList.forEach((record) => {
    const originalParam = record.parameter;
    const normalized = normalizeParameterName(originalParam);

    if (normalized !== originalParam) {
      dlog('ALIAS-MATCHED', { rawName: originalParam, normalized, value: record.value, dataType: record.dataType });
    }

    if (BIT_PARAMETERS.has(normalized) || record.dataType === 'bit') {
      const coerced = coerceBitValue(record.value);
      record.value = coerced;
      record.unit = '';
      record.dataType = 'bit';
      console.log(`[plc] 🔄 Converted ${normalized} to: ${coerced}`);
      dlog('BIT-CONVERTED', { rawName: originalParam, normalized, value: coerced });
    }
  });

  parsedList.forEach((m, idx) => {
    try {
      processMeasurement(topic, m, idx, rawBuf);
    } catch (err) {
      console.error('[plcService] processMeasurement error:', err && err.message ? err.message : err);
    }
  });
}

function getLatestSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(latest)) out[k] = v.value;
  return out;
}

function getLatestFull() { return latest; }

function getCalibration() { return calibration; }

module.exports = {
  handleIncoming,
  getLatestSnapshot,
  getLatestFull,
  getCalibration,
  _internal: {
    peelHexLayers,
    parseNamedRecords,
    hexdump,
    feedTankRawToPercent,
    normalizeParameterName,
    coerceBitValue
  }
};