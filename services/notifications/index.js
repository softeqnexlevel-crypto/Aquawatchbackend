// services/notifications/index.js
// Entry point used by plcService.js. Never throws: if anything is
// misconfigured it logs why and returns null, so the backend keeps running.
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const config = require('./config');
const { AlertNotifier } = require('./alertNotifier');

async function startAlertNotifier({ getValue, logger = console }) {
  if (!config.enabled) {
    logger.info?.('[alert-notifier] disabled (ALERT_NOTIFIER_ENABLED=false)');
    return null;
  }

  try {
    if (!config.enginePath) throw new Error('ALERT_ENGINE_PATH is not set');

    // The engine is an ES module; a dynamic import() loads it from CommonJS.
    const abs = path.resolve(__dirname, '..', '..', config.enginePath);
    const mod = await import(pathToFileURL(abs).href);
    if (typeof mod.evaluateSensorAlerts !== 'function') {
      throw new Error(`${abs} does not export evaluateSensorAlerts`);
    }

    const notifier = new AlertNotifier({ evaluateSensorAlerts: mod.evaluateSensorAlerts, getValue, logger });
    notifier.start();
    logger.info?.(`[alert-notifier] started${config.dryRun ? ' in DRY-RUN mode' : ''} (engine: ${abs})`);
    return notifier;
  } catch (err) {
    const hint = /export|module|require/i.test(err.message)
      ? ' — if the engine file is .js outside an ESM package, copy it to a .mjs file and point ALERT_ENGINE_PATH at that'
      : '';
    logger.error?.(`[alert-notifier] NOT started: ${err.message}${hint}`);
    return null;
  }
}

module.exports = { startAlertNotifier };