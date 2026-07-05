const RULES = [
  {
    parameter: "ROPressure",
    test: (v) => v > Number(process.env.ALARM_RO_PRESSURE_MAX || 15),
    severity: "high",
    message: "High Pressure Alarm",
  },
  {
    parameter: "PureWaterEC",
    test: (v) => v > Number(process.env.ALARM_PURE_WATER_EC_MAX || 20),
    severity: "warning",
    message: "Conductivity Alarm",
  },
];

const activeAlarms = [];

function evaluate(parameter, value) {
  const fired = RULES
    .filter((r) => r.parameter === parameter && r.test(value))
    .map((r) => ({
      parameter, value,
      severity: r.severity,
      message: r.message,
      timestamp: new Date().toISOString(),
    }));
  if (fired.length) {
    activeAlarms.unshift(...fired);
    if (activeAlarms.length > 100) activeAlarms.length = 100;
  }
  return fired;
}

function getAlarms() { return activeAlarms; }

module.exports = { evaluate, getAlarms };
