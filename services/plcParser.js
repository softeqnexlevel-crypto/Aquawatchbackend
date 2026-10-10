'use strict';

const fs = require('fs');

const path = require('path');

const { parameterFromTopic } = require('../mqtt/topicManager');

const { broadcast } = require('./socketService');

const { evaluate } = require('./alarmService');

const { saveMeasurement } = require('../database/postgres');

const { recordDosingState } = require('./dosingService');

const DEBUG_PARSE =

  Boolean(process.env.DEBUG_PARSE && process.env.DEBUG_PARSE !== '0');

const LOG_RAW =

  process.env.LOG_RAW === undefined

    ? true

    : process.env.LOG_RAW !== '0';

const ARCHIVE_RAW_FAILED =

  Boolean(

    process.env.ARCHIVE_RAW_FAILED &&

    process.env.ARCHIVE_RAW_FAILED !== '0'

  );

const CALIBRATION_FILE =

  process.env.CALIBRATION_FILE ||

  path.resolve(__dirname, '..', 'data', 'calibration.json');

const MIN_VALID_ABS_VALUE =

  Number(process.env.MIN_VALID_ABS_VALUE) || 1e-6;

/* ============================================================

   FEED TANK LEVEL CALIBRATION

   ============================================================

   IMPORTANT:

   RAW transmitter calibration:

       RAW 4.9  = 0%

       RAW 10.0 = 100%

   Linear conversion:

       percentage = ((raw - 4.9) / (10.0 - 4.9)) * 100

   Values below 4.9 are clamped to 0%.

   Values above 10.0 are clamped to 100%.

   This MUST match:

       components/dashboardComponents/feedTankCalibration.js

   The RAW transmitter value is also preserved separately as:

       RO5-FeedTankLevelRaw

   ============================================================ */

const FEED_TANK_RAW_MIN =

  Number(process.env.FEED_TANK_RAW_MIN) || 4.9;

const FEED_TANK_RAW_MAX =

  Number(process.env.FEED_TANK_RAW_MAX) || 10.0;

// IMPORTANT: 0, NOT 10.

const FEED_TANK_PCT_MIN =

  Number.isFinite(Number(process.env.FEED_TANK_PCT_MIN))

    ? Number(process.env.FEED_TANK_PCT_MIN)

    : 0;

const FEED_TANK_PCT_MAX =

  Number.isFinite(Number(process.env.FEED_TANK_PCT_MAX))

    ? Number(process.env.FEED_TANK_PCT_MAX)

    : 100;

function feedTankRawToPercent(raw) {

  const numericRaw =

    typeof raw === 'string'

      ? parseFloat(raw)

      : Number(raw);

  if (!Number.isFinite(numericRaw)) {

    return NaN;

  }

  if (FEED_TANK_RAW_MAX <= FEED_TANK_RAW_MIN) {

    return NaN;

  }

  const clamped = Math.min(

    FEED_TANK_RAW_MAX,

    Math.max(FEED_TANK_RAW_MIN, numericRaw)

  );

  const percent =

    FEED_TANK_PCT_MIN +

    (

      (clamped - FEED_TANK_RAW_MIN) *

      (FEED_TANK_PCT_MAX - FEED_TANK_PCT_MIN)

    ) /

    (FEED_TANK_RAW_MAX - FEED_TANK_RAW_MIN);

  return Math.min(

    FEED_TANK_PCT_MAX,

    Math.max(FEED_TANK_PCT_MIN, percent)

  );

}

/* ============================================================

   DEBUG LOGGING

   ============================================================ */

const DEBUG_LOG_FILE =

  path.resolve(__dirname, '..', 'debug.log');

function dlog(...args) {

  try {

    const line =

      `[${new Date().toISOString()}] ` +

      args

        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))

        .join(' ') +

      '\n';

    fs.appendFileSync(DEBUG_LOG_FILE, line);

  } catch (err) {

    // Never let logging crash the application.

    console.error(

      '[dlog] failed to write debug log:',

      err && err.message ? err.message : err

    );

  }

}

/* ============================================================

   LATEST DATA

   ============================================================ */

const latest = {};

let dataCount = 0;

/* ============================================================

   ALERT NOTIFICATIONS (email to users + Slack + calendar)

   ============================================================

   Runs the shared alert engine against `latest` and notifies when

   an alert turns active (e.g. the system enters BACKWASH mode).

   - `getValue(key)` lets the engine read the latest stored value of

     any tag, e.g. 'RO5-SystemOperation' or 'RO5-PrefilterBackwash'.

   - `notifyTag(record)` is called every time a fresh, valid value has

     been stored, so the engine re-evaluates immediately instead of

     waiting for a timer.

   - Never throws: if the notifier cannot start, the reason is logged

     and the rest of the backend carries on normally.

   See services/notifications/README.md.

   ============================================================ */

const { startAlertNotifier } = require('./notifications');

let alertNotifier = null;

startAlertNotifier({

  getValue: (key) => (latest[key] ? latest[key].value : undefined),

})

  .then((n) => {

    alertNotifier = n;

    console.log('[plc] alert notifier started');

  })

  .catch((err) => {

    console.error(

      '[plc] alert notifier failed to start (continuing without it):',

      err && err.message ? err.message : err

    );

  });


function notifyTag(record) {
  if (!record || record.simulated) {
    return;
  }

  if (!alertNotifier) {
    console.warn(
      '[plc] ALERT NOTIFIER IS NULL — cannot evaluate:',
      record.parameter
    );
    return;
  }

  try {
    console.log(
      '[plc] Sending sensor value to notifier:',
      record.parameter,
      record.value
    );

    alertNotifier.onTag();
  } catch (err) {
    console.error(
      '[plc] alert notifier onTag error:',
      err && err.stack ? err.stack : err
    );
  }
}
/* ============================================================

   DATABASE SAMPLING

   ============================================================ */

const DB_SAMPLE_INTERVAL_MS =

  Number(process.env.DB_SAMPLE_INTERVAL_MS) || 30000;

const lastDbWriteTime = {};

const lastDbWrittenValue = {};

function shouldWriteToDb(parameter, value, dataType) {

  const now = Date.now();

  const last = lastDbWriteTime[parameter] || 0;

  const valueChanged = lastDbWrittenValue[parameter] !== value;

  // Bits are written whenever their state changes.

  if (dataType === 'bit') {

    if (valueChanged) {

      lastDbWriteTime[parameter] = now;

      lastDbWrittenValue[parameter] = value;

      return true;

    }

  }

  // Other values are sampled periodically.

  if (now - last >= DB_SAMPLE_INTERVAL_MS) {

    lastDbWriteTime[parameter] = now;

    lastDbWrittenValue[parameter] = value;

    return true;

  }

  return false;

}

/* ============================================================

   RAW BUFFER HELPERS

   ============================================================ */

function isHexString(s) {

  return (

    typeof s === 'string' &&

    s.length > 0 &&

    s.length % 2 === 0 &&

    /^[0-9A-Fa-f]+$/.test(s)

  );

}

function bufferFromRaw(raw) {

  if (raw == null) return null;

  if (Buffer.isBuffer(raw)) {

    return raw;

  }

  if (typeof raw === 'string') {

    const trimmed = raw.trim();

    if (trimmed === '') {

      return null;

    }

    return Buffer.from(trimmed, 'utf8');

  }

  try {

    return Buffer.from(String(raw));

  } catch (_) {

    return null;

  }

}

function hexdump(buf, maxBytes = 256) {

  if (!Buffer.isBuffer(buf)) {

    return '';

  }

  const lines = [];

  for (let i = 0; i < Math.min(buf.length, maxBytes); i += 16) {

    const slice = buf.slice(i, Math.min(i + 16, buf.length));

    const hex = slice.toString('hex').match(/.{1,2}/g).join(' ');

    const ascii = slice.toString('ascii').replace(/[^\x20-\x7E]/g, '.');

    lines.push(

      `${i.toString(16).padStart(4, '0')}  ` +

      `${hex.padEnd(16 * 3 - 1)}  ` +

      `${ascii}`

    );

  }

  return lines.join('\n');

}

function peelHexLayers(initialBuf, maxLayers = 4) {

  let buf = initialBuf;

  let layersPeeled = 0;

  for (let layer = 0; layer < maxLayers; layer++) {

    if (!Buffer.isBuffer(buf) || buf.length === 0) {

      break;

    }

    const asAscii = buf.toString('ascii');

    const cleaned = asAscii.replace(/[^0-9A-Fa-f]+$/, '');

    if (cleaned.length < 8) {

      break;

    }

    if (!isHexString(cleaned)) {

      break;

    }

    try {

      const decoded = Buffer.from(cleaned, 'hex');

      buf = decoded;

      layersPeeled++;

    } catch (_) {

      break;

    }

  }

  return {

    buffer: buf,

    layersPeeled

  };

}

function isPrintableAscii(buf) {

  if (!Buffer.isBuffer(buf) || buf.length === 0) {

    return false;

  }

  const s = buf.toString('ascii');

  return /^[\x20-\x7E]+$/.test(s);

}

/* ============================================================

   FLOAT PARSING

   ============================================================ */

function readFloatBADC(buf, offset) {

  if (offset < 0 || offset + 4 > buf.length) {

    return NaN;

  }

  const b0 = buf[offset];

  const b1 = buf[offset + 1];

  const b2 = buf[offset + 2];

  const b3 = buf[offset + 3];

  return Buffer.from([b1, b0, b3, b2]).readFloatLE(0);

}

/* ============================================================

   NAMED RECORD PARSER

   ============================================================ */

function parseNamedRecords(buf) {

  if (!Buffer.isBuffer(buf) || buf.length < 20) {

    return [];

  }

  const markers = [];

  for (let i = 0; i < buf.length - 4; i++) {

    if (

      buf[i] === 0xD8 &&

      buf[i + 1] === 0x00 &&

      buf[i + 2] === 0x00 &&

      buf[i + 3] === 0x00

    ) {

      markers.push(i);

    }

  }

  if (markers.length === 0) {

    return [];

  }

  const records = [];

  for (let m = 0; m < markers.length; m++) {

    const i = markers[m];

    const nextMarker =

      markers[m + 1] !== undefined

        ? markers[m + 1]

        : buf.length;

    if (i + 18 > buf.length) {

      continue;

    }

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

        dlog('SKIPPED-UNHANDLED-LEN', {

          offset: i,

          recordIndex,

          typeByte,

          lenByte

        });

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

      if (nameLen < 1 || nameLen > 80) {

        continue;

      }

      const nameEnd = nameStartBase + nameLen;

      if (nameEnd >= nextMarker || nameEnd > buf.length) {

        continue;

      }

      const nameBuf = buf.slice(nameStartBase, nameEnd);

      if (!isPrintableAscii(nameBuf)) {

        continue;

      }

      const unitLen = buf[nameEnd];

      const unitStart = nameEnd + 1;

      const unitEnd = unitStart + unitLen;

      if (unitEnd > nextMarker || unitEnd > buf.length) {

        continue;

      }

      const unitBuf = buf.slice(unitStart, unitEnd);

      if (unitLen > 0 && !isPrintableAscii(unitBuf)) {

        continue;

      }

      parsed = {

        name: nameBuf.toString('ascii'),

        unit: unitBuf.toString('ascii')

      };

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

    dlog('RESOLVED', {

      offset: i,

      recordIndex,

      name: parsed.name,

      unit: parsed.unit,

      value,

      dataType

    });

    records.push({

      parameter: parsed.name,

      unit: parsed.unit,

      value,

      recordIndex,

      typeByte,

      dataType,

      timestamp: new Date().toISOString(),

      simulated: false,

      debug: {

        offset: i,

        recordIndex,

        dataType

      }

    });

  }

  dlog('SUMMARY', {

    markersFound: markers.length,

    recordsResolved: records.length

  });

  return records;

}

/* ============================================================

   FALLBACK FLOAT PARSER

   ============================================================ */

function tryReadFloatAt(buf, offset) {

  if (!Buffer.isBuffer(buf)) {

    return { ok: false };

  }

  if (offset < 0 || offset + 4 > buf.length) {

    return { ok: false };

  }

  try {

    const le = buf.readFloatLE(offset);

    if (Number.isFinite(le) && Math.abs(le) < 1e7) {

      return { ok: true, value: le, endian: 'LE' };

    }

  } catch (_) {}

  try {

    const be = buf.readFloatBE(offset);

    if (Number.isFinite(be) && Math.abs(be) < 1e7) {

      return { ok: true, value: be, endian: 'BE' };

    }

  } catch (_) {}

  return { ok: false };

}

function findNearestFloat(buf, asciiPos, window = 48) {

  if (!Buffer.isBuffer(buf)) {

    return null;

  }

  const start = Math.max(0, asciiPos - window);

  const end = Math.min(buf.length - 4, asciiPos + window);

  let best = null;

  for (let off = start; off <= end; off++) {

    const r = tryReadFloatAt(buf, off);

    if (!r.ok) {

      continue;

    }

    const distance = Math.abs(off - asciiPos);

    if (

      !best ||

      distance < best.distance ||

      (distance === best.distance && r.endian === 'LE')

    ) {

      best = {

        offset: off,

        value: r.value,

        distance,

        endian: r.endian

      };

    }

  }

  return best;

}

/* ============================================================

   ABOx PAYLOAD FALLBACK

   ============================================================ */

function parseAboxPayload(buf) {

  if (!Buffer.isBuffer(buf)) {

    return [];

  }

  const ascii = buf.toString('ascii');

  const dRegex = /D(\d{3,5})/g;

  const measurements = [];

  let match;

  const seenDcodes = new Set();

  while ((match = dRegex.exec(ascii)) !== null) {

    const dc = match[1];

    if (seenDcodes.has(dc)) {

      continue;

    }

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

        debug: {

          asciiIndex,

          floatOffset: floatCandidate.offset,

          endian: floatCandidate.endian,

          distance: floatCandidate.distance

        }

      });

    }

  }

  if (DEBUG_PARSE) {

    console.debug(

      '[plc] parseAboxPayload (fallback): buffer len',

      buf.length,

      'found D-codes:',

      Array.from(seenDcodes).slice(0, 200)

    );

  }

  return measurements;

}

/* ============================================================

   CALIBRATION PARSER

   ============================================================ */

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

  if (!buf || !calibration) {

    return [];

  }

  const rows = [];

  for (const [dcode, spec] of Object.entries(calibration)) {

    if (!spec || typeof spec.offset !== 'number' || !spec.method) {

      continue;

    }

    const v = readByMethod(buf, spec.offset, spec.method);

    rows.push({

      dcode,

      parameter: spec.parameter || null,

      value: Number.isFinite(v) ? v : null,

      debug: spec

    });

  }

  return rows;

}

/* ============================================================

   CALIBRATION FILE

   ============================================================ */

let calibration = null;

function loadCalibration() {

  try {

    if (fs.existsSync(CALIBRATION_FILE)) {

      const raw = fs.readFileSync(CALIBRATION_FILE, 'utf8');

      calibration = JSON.parse(raw);

      console.log(

        '[plc] loaded legacy calibration file:',

        CALIBRATION_FILE,

        'entries=',

        Object.keys(calibration).length

      );

    } else {

      calibration = null;

    }

  } catch (err) {

    calibration = null;

    console.error(

      '[plc] failed to load calibration file:',

      err && err.message ? err.message : err

    );

  }

}

loadCalibration();

/* ============================================================

   PARAMETER VALIDATION

   ============================================================ */

function isValidParameterName(name) {

  if (!name || typeof name !== 'string') {

    return false;

  }

  const trimmed = name.trim();

  if (trimmed.length === 0 || trimmed.length > 80) {

    return false;

  }

  if (/^[0-9A-Fa-f]{8,}$/.test(trimmed)) {

    return false;

  }

  return /^[\w\s\-\/\.:%]{1,80}$/.test(trimmed);

}

/* ============================================================

   RAW PAYLOAD ARCHIVING

   ============================================================ */

function archiveRawPayload(topic, rawBuf) {

  try {

    const dir = path.resolve(__dirname, '..', 'data', 'raw_payloads');

    fs.mkdirSync(dir, { recursive: true });

    const ts = Date.now();

    const hex =

      Buffer.isBuffer(rawBuf)

        ? rawBuf.toString('hex')

        : String(rawBuf);

    const fname = path.join(dir, `raw_${ts}.hex`);

    fs.writeFileSync(fname, `${topic}\n${hex}\n`, 'utf8');

    if (DEBUG_PARSE) {

      console.debug('[plcService] archived raw payload to', fname);

    }

  } catch (err) {

    console.error(

      '[plcService] archiveRawPayload error:',

      err && err.message ? err.message : err

    );

  }

}

/* ============================================================

   DATABASE RECORDING

   ============================================================ */

function recordToDB(record) {

  if (!record) {

    return Promise.resolve();

  }

  if (record.simulated) {

    return Promise.resolve();

  }

  if (record.value === null || record.value === undefined) {

    return Promise.resolve();

  }

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

/* ============================================================

   PROCESS ONE MEASUREMENT

   ============================================================ */


function notifyTag(record) {
  if (!record || record.simulated) {
    return;
  }

  if (!alertNotifier) {
    console.warn(
      '[plc] ALERT NOTIFIER IS NULL — cannot evaluate:',
      record.parameter
    );
    return;
  }

  try {
    console.log(
      '[plc] Sending sensor value to notifier:',
      record.parameter,
      record.value
    );

    alertNotifier.onTag();
  } catch (err) {
    console.error(
      '[plc] alert notifier onTag error:',
      err && err.stack ? err.stack : err
    );
  }
}
   function processMeasurement(topic, measurement, idx, rawBuf) {

  let parameter =

    measurement.parameter ||

    parameterFromTopic(topic) ||

    null;

  /* ----------------------------------------------------------

     ANTISCALANT DOSING

     ---------------------------------------------------------- */

  if (

    parameter === 'AntiscalantDoser' ||

    parameter === 'DosingActive' ||

    parameter === 'Doser' ||

    parameter === 'Dosing' ||

    parameter === 'Antiscalant'

  ) {

    dlog('ANTISCALANT-ALIAS-MATCHED', {

      originalParameter: parameter,

      topic,

      value: measurement.value

    });

    parameter = 'AntiscalantDosingActive';

  }

  /*

   * Server-side dosing totalizer.

   *

   * This runs whenever the PLC reports the dosing state.

   * It does not depend on the browser being open.

   */

  if (parameter === 'AntiscalantDosingActive') {

    try {

      recordDosingState(measurement.value, Date.now());

    } catch (err) {

      console.error(

        '[plc] dosing totalizer error:',

        err && err.message ? err.message : err

      );

    }

  }

  /* ----------------------------------------------------------

     FEED TANK

     ----------------------------------------------------------

     Accepted parameter names:

       RO5-FeedTankLevel, FeedTankLevel, FT-A, FeedTank

     IMPORTANT:

     measurement.value is the RAW transmitter value.

     We preserve that raw value as RO5-FeedTankLevelRaw, then

     calculate RO5-FeedTankLevel using 4.9 -> 0%, 10.0 -> 100%.

     ---------------------------------------------------------- */

  if (

    parameter === 'RO5-FeedTankLevel' ||

    parameter === 'FeedTankLevel' ||

    parameter === 'FT-A' ||

    parameter === 'FeedTank'

  ) {

    const rawValue =

      typeof measurement.value === 'string'

        ? parseFloat(measurement.value)

        : Number(measurement.value);

    if (!Number.isFinite(rawValue)) {

      dlog('INVALID-FEED-TANK-RAW', {

        topic,

        parameter,

        originalValue: measurement.value

      });

      return;

    }

    const scaledValue = feedTankRawToPercent(rawValue);

    if (!Number.isFinite(scaledValue)) {

      dlog('INVALID-FEED-TANK-SCALED', {

        topic,

        parameter,

        rawValue,

        rawMin: FEED_TANK_RAW_MIN,

        rawMax: FEED_TANK_RAW_MAX,

        pctMin: FEED_TANK_PCT_MIN,

        pctMax: FEED_TANK_PCT_MAX

      });

      return;

    }

    console.log(

      `[plc] 📊 Feed Tank: ` +

      `Raw=${rawValue} → ` +

      `Scaled=${scaledValue.toFixed(2)}%`

    );

    /* SCALED RECORD */

    const scaledRecord = {

      topic,

      parameter: 'RO5-FeedTankLevel',

      unit: '%',

      value: scaledValue,

      timestamp: measurement.timestamp || new Date().toISOString(),

      simulated: !!measurement.simulated,

      dataType: 'float',

      debug: {

        ...(measurement.debug || {}),

        rawValue,

        scaledValue,

        calibration: {

          rawMin: FEED_TANK_RAW_MIN,

          rawMax: FEED_TANK_RAW_MAX,

          pctMin: FEED_TANK_PCT_MIN,

          pctMax: FEED_TANK_PCT_MAX

        }

      }

    };

    /* RAW RECORD (actual transmitter reading, not a percentage) */

    const rawRecord = {

      topic,

      parameter: 'RO5-FeedTankLevelRaw',

      unit: '',

      value: rawValue,

      timestamp: measurement.timestamp || new Date().toISOString(),

      simulated: !!measurement.simulated,

      dataType: 'float',

      debug: {

        ...(measurement.debug || {}),

        sourceParameter: parameter,

        rawValue

      }

    };

    /* UPDATE LATEST SNAPSHOT */

    latest[scaledRecord.parameter] = scaledRecord;

    latest[rawRecord.parameter] = rawRecord;

    /* Alert notifier: fresh feed-tank values are now stored */

    notifyTag(scaledRecord);

    /* BROADCAST BOTH VALUES */

    broadcast('plc-data', scaledRecord);

    broadcast('plc-data', rawRecord);

    /* SAVE SCALED VALUE */

    if (shouldWriteToDb('RO5-FeedTankLevel', scaledValue, 'float')) {

      recordToDB(scaledRecord).catch((err) => {

        if (dataCount % 100 === 0) {

          console.error(

            '[db] save failed (continuing):',

            err && err.message ? err.message : err

          );

        }

      });

    }

    /* SAVE RAW VALUE */

    if (shouldWriteToDb('RO5-FeedTankLevelRaw', rawValue, 'float')) {

      recordToDB(rawRecord).catch((err) => {

        if (dataCount % 100 === 0) {

          console.error(

            '[db] save failed (continuing):',

            err && err.message ? err.message : err

          );

        }

      });

    }

    /* FEED TANK ALARMS */

    try {

      const alarms = evaluate(scaledRecord.parameter, scaledValue);

      if (alarms && alarms.length) {

        dlog('FEED-TANK-ALARM', {

          parameter: scaledRecord.parameter,

          value: scaledValue,

          alarms

        });

        broadcast('plc-alarm', {

          parameter: scaledRecord.parameter,

          value: scaledValue,

          alarms,

          simulated: scaledRecord.simulated

        });

      }

    } catch (err) {

      console.error(

        '[plc] feed tank evaluate/broadcast error:',

        err && err.message ? err.message : err

      );

    }

    return;

  }

  /* ----------------------------------------------------------

     NORMAL PLC PARAMETERS

     ---------------------------------------------------------- */

  if (!isValidParameterName(parameter)) {

    dlog('INVALID-PARAMETER-NAME', {

      original: parameter,

      topic

    });

    parameter =

      parameterFromTopic(topic) ||

      `unknown_${idx || 'x'}`;

  }

  const record = {

    topic,

    parameter,

    unit: measurement.unit || null,

    value:

      measurement.value === undefined

        ? null

        : measurement.value,

    timestamp: measurement.timestamp || new Date().toISOString(),

    simulated: !!measurement.simulated,

    dataType: measurement.dataType || 'float',

    debug: measurement.debug || {}

  };

  latest[parameter] = record;

  dataCount++;

  if (dataCount % 50 === 0) {

    console.log(

      `[plc] 📊 Processed ${dataCount} data points. ` +

      `Latest: ${parameter}=${record.value}` +

      `${record.unit ? ' ' + record.unit : ''}`

    );

  }

  /* ----------------------------------------------------------

     INVALID VALUES

     ---------------------------------------------------------- */

  if (

    record.value === null ||

    (record.dataType !== 'bit' && !Number.isFinite(record.value))

  ) {

    if (ARCHIVE_RAW_FAILED || DEBUG_PARSE) {

      archiveRawPayload(topic, rawBuf);

    }

    if (DEBUG_PARSE) {

      console.warn(

        '[plc] parsed null/invalid value, skipping DB & alarms:',

        { parameter, value: record.value }

      );

    }

    try {

      broadcast('plc-data', record);

    } catch (e) {}

    return;

  }

  /* ----------------------------------------------------------

     ALERT NOTIFIER

     A valid value (including bits such as the backwash flag and

     string modes such as SystemOperation) is now stored in

     `latest`, so wake the alert engine to re-evaluate its rules.

     ---------------------------------------------------------- */

  notifyTag(record);

  /* ----------------------------------------------------------

     DATABASE

     ---------------------------------------------------------- */

  if (shouldWriteToDb(parameter, record.value, record.dataType)) {

    recordToDB(record).catch((err) => {

      if (dataCount % 100 === 0) {

        console.error(

          '[db] save failed (continuing):',

          err && err.message ? err.message : err

        );

      }

    });

  }

  /* ----------------------------------------------------------

     ALARMS + BROADCAST

     ---------------------------------------------------------- */

  try {

    const alarms =

      record.dataType === 'bit'

        ? []

        : evaluate(parameter, record.value);

    broadcast('plc-data', record);

    if (alarms && alarms.length) {

      broadcast('plc-alarm', {

        parameter,

        value: record.value,

        alarms,

        simulated: record.simulated

      });

    }

  } catch (err) {

    console.error(

      '[plc] evaluate/broadcast error:',

      err && err.message ? err.message : err

    );

    try {

      broadcast('plc-data', record);

    } catch (e) {}

  }

}

/* ============================================================

   HANDLE INCOMING MQTT/PLC PAYLOAD

   ============================================================ */

function handleIncoming(topic, raw) {

  const rawBuf = bufferFromRaw(raw);

  if (LOG_RAW) {

    if (rawBuf) {

      console.log(`[plc][RAW] topic=${topic} bytes=${rawBuf.length}`);

      if (DEBUG_PARSE) {

        console.log(`[plc][RAW] hex=${rawBuf.toString('hex')}`);

        console.log(

          `[plc][RAW] ascii=` +

          rawBuf.toString('ascii').replace(/[^\x20-\x7E]/g, '.')

        );

      }

    } else {

      console.log(

        `[plc][RAW] topic=${topic} ` +

        `<empty/undecodable payload> ` +

        `typeof=${typeof raw}`

      );

    }

  }

  if (!rawBuf) {

    return;

  }

    // Any packet from the ABox proves the link is alive.
  if (alertNotifier) alertNotifier.onTag();

  /* RAW DEBUG LOG */

  dlog('INCOMING', {

    topic,

    bytes: rawBuf.length,

    ascii: rawBuf.toString('ascii').replace(/[^\x20-\x7E]/g, '.')

  });

  /* PEEL HEX LAYERS */

  const { buffer: decodedBuf, layersPeeled } = peelHexLayers(rawBuf);

  if (DEBUG_PARSE || LOG_RAW) {

    console.log(

      `[plc] peeled ${layersPeeled} hex layer(s), ` +

      `decoded length=${decodedBuf.length}`

    );

    if (DEBUG_PARSE) {

      console.debug(

        '[plc] decoded hexdump head:\n' + hexdump(decodedBuf, 256)

      );

    }

  }

  /* DECODED DEBUG LOG */

  dlog('DECODED', {

    topic,

    layersPeeled,

    bytes: decodedBuf.length,

    ascii: decodedBuf.toString('ascii').replace(/[^\x20-\x7E]/g, '.')

  });

  /* PARSE NAMED RECORDS */

  let parsedList = parseNamedRecords(decodedBuf);

  if (DEBUG_PARSE) {

    console.debug(

      '[plcService] named-record parser rows:',

      parsedList.length

    );

  }

  /* LEGACY CALIBRATION FALLBACK */

  if (

    (!parsedList || parsedList.length === 0) &&

    calibration &&

    Object.keys(calibration).length > 0

  ) {

    try {

      parsedList = parseWithCalibration(decodedBuf, calibration);

      if (DEBUG_PARSE) {

        console.debug(

          '[plcService] used calibrated parser, rows:',

          parsedList.length

        );

      }

    } catch (err) {

      console.error(

        '[plcService] calibrated parser error:',

        err && err.message ? err.message : err

      );

    }

  }

  /* HEURISTIC FALLBACK */

  if (!parsedList || parsedList.length === 0) {

    try {

      parsedList = parseAboxPayload(decodedBuf);

      if (DEBUG_PARSE) {

        console.debug(

          '[plcService] used heuristic parser, rows:',

          parsedList.length

        );

      }

    } catch (err) {

      console.error(

        '[plcService] heuristic parser error:',

        err && err.message ? err.message : err

      );

    }

  }

  /* NOTHING PARSED */

  if (!parsedList || parsedList.length === 0) {

    console.warn(

      '[plcService] no parse results for topic',

      topic,

      '- archiving raw for analysis'

    );

    dlog('NO-PARSE-RESULTS', { topic });

    archiveRawPayload(topic, rawBuf);

    return;

  }

  /* NORMALIZE BIT / ANTISCALANT VALUES */

  parsedList.forEach((record) => {

    const isAntiscalant =

      record.parameter === 'AntiscalantDoser' ||

      record.parameter === 'AntiscalantDosingActive' ||

      record.parameter === 'DosingActive' ||

      record.parameter === 'Doser' ||

      record.parameter === 'Dosing' ||

      record.parameter === 'Antiscalant';

    if (isAntiscalant || record.dataType === 'bit') {

      record.value = record.value === 1 ? 'ON' : 'OFF';

      record.unit = '';

      record.dataType = 'bit';

      console.log(

        `[plc] 🔄 Converted ${record.parameter} to: ${record.value}`

      );

      if (isAntiscalant) {

        dlog('ANTISCALANT-BIT-CONVERTED', {

          originalParameter: record.parameter,

          value: record.value

        });

        record.parameter = 'AntiscalantDosingActive';

      }

    }

  });

  /* PROCESS EVERY PARSED RECORD */

  parsedList.forEach((measurement, idx) => {

    try {

      processMeasurement(topic, measurement, idx, rawBuf);

    } catch (err) {

      console.error(

        '[plcService] processMeasurement error:',

        err && err.message ? err.message : err

      );

    }

  });

}

/* ============================================================

   SNAPSHOT FUNCTIONS

   ============================================================ */

function getLatestSnapshot() {

  const out = {};

  for (const [key, value] of Object.entries(latest)) {

    out[key] = value.value;

  }

  return out;

}

function getLatestFull() {

  return latest;

}

function getCalibration() {

  return calibration;

}

/* ============================================================

   EXPORTS

   ============================================================ */

module.exports = {

  handleIncoming,

  getLatestSnapshot,

  getLatestFull,

  getCalibration,

  _internal: {

    peelHexLayers,

    parseNamedRecords,

    hexdump,

    feedTankRawToPercent

  }

};