// services/notifications/keyMap.js
// The backend stores PLC tags under their raw names (often prefixed
// "siemens200smart-"). The frontend remaps them in DataContext.jsx before the
// alert engine sees them. This is a copy of that KEY_MAPPING so the notifier
// reads exactly the same tags as the dashboard.
// KEEP IN SYNC with frontend/src/contexts/DataContext.jsx (or move the map
// into one shared file used by both).
'use strict';

const P = 'siemens200smart-';

// raw backend name -> canonical name used by the alert engine
const KEY_MAPPING = {
  [`${P}RO5-FEEDFlow`]: 'RO5-FEEDFlow',
  [`${P}RO5-Permeateflow`]: 'RO5-Permeateflow',
  [`${P}RO5-ConcetrateFlow`]: 'RO5-ConcetrateFlow',
  [`${P}RO5-ROPressure`]: 'RO5-ROPressure',
  [`${P}RO5-InterstagePress`]: 'RO5-InterstagePress',
  [`${P}RO5-ConcetratePress`]: 'RO5-ConcetratePress',
  [`${P}RO5-Stage1Delta`]: 'RO5-Stage1Delta',
  [`${P}RO5-Stage2Delta`]: 'RO5-Stage2Delta',
  [`${P}RO5-MediaFilterInPress`]: 'RO5-MediaFilterInPress',
  [`${P}RO5-MediaFilterOutPress`]: 'RO5-MediaFilterOutPress',
  [`${P}RO5-MediaFilterDeltaP`]: 'RO5-MediaFilterDeltaP',
  [`${P}RO5-SystemRecovery`]: 'RO5-SystemRecovery',
  [`${P}RO5-PureWaterEc`]: 'RO5-PureWaterEc',
  [`${P}RO5-FeedTankLevel`]: 'RO5-FeedTankLevel',
  [`${P}RO5-FeedTankLevelRaw`]: 'RO5-FeedTankLevelRaw',

  [`${P}RO5-Feedpump`]: 'RO5-Feedpump',
  [`${P}RO5-PrefilterBackwash`]: 'RO5-PrefilterBackwash',
  [`${P}RO5-PrefilterBackwashing`]: 'RO5-PrefilterBackwashing',

  [`${P}RO5-SystemOperation`]: 'RO5-SystemOperation',
  'RO5-SystemOn': 'RO5-SystemOperation',
  [`${P}RO5-SystemOn`]: 'RO5-SystemOperation',
  'SystemOperation': 'RO5-SystemOperation',

  [`${P}RO5-SystemMode`]: 'RO5-SystemMode',
  'SystemMode': 'RO5-SystemMode',

  // Antiscalant doser bit (plcService renames several aliases to "AntiscalantDosingActive")
  [`${P}RO5-AntiscalantDosingActive`]: 'RO5-AntiscalantDosingActive',
  'RO5-AntiscalantDoser': 'RO5-AntiscalantDosingActive',
  [`${P}RO5-AntiscalantDoser`]: 'RO5-AntiscalantDosingActive',
  'AntiscalantDoser': 'RO5-AntiscalantDosingActive',
  'AntiscalantDosingActive': 'RO5-AntiscalantDosingActive',
  'RO5/AntiscalantDoser': 'RO5-AntiscalantDosingActive',

  [`${P}RO5-AntiscalantDaily`]: 'RO5-AntiscalantDaily',
  'AntiscalantDaily': 'RO5-AntiscalantDaily',

  [`${P}RO5-SystemRunhrs`]: 'RO5-SystemRunhrs',
  'SystemRunhrs': 'RO5-SystemRunhrs',

  // SystemActive is its OWN tag (the master ON/OFF); it is not SystemOperation.
  [`${P}RO5-SystemActive`]: 'RO5-SystemActive',
  'SystemActive': 'RO5-SystemActive',
};

// canonical name -> every raw name it may be stored under
const inverse = {};
for (const [raw, canonical] of Object.entries(KEY_MAPPING)) {
  (inverse[canonical] = inverse[canonical] || []).push(raw);
}

const memo = {};
function rawKeysFor(canonical) {
  if (!memo[canonical]) {
    memo[canonical] = [...new Set([canonical, `${P}${canonical}`, ...(inverse[canonical] || [])])];
  }
  return memo[canonical];
}

module.exports = { KEY_MAPPING, rawKeysFor };