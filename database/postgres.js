const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    pool.on("error", (err) => console.error("[pg] pool error:", err.message));
  }
  return pool;
}

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn("[db] DATABASE_URL not set; persistence disabled");
    return;
  }
  const p = getPool();
  await p.query(`CREATE EXTENSION IF NOT EXISTS timescaledb;`).catch(() => {
    console.warn("[db] timescaledb extension not available; using plain table");
  });
  await p.query(`
    CREATE TABLE IF NOT EXISTS measurements (
      id BIGSERIAL,
      topic TEXT NOT NULL,
      parameter TEXT NOT NULL,
      value DOUBLE PRECISION NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id, timestamp)
    );
  `);
  await p.query(`SELECT create_hypertable('measurements','timestamp', if_not_exists => TRUE);`).catch(() => {});
  await p.query(`CREATE INDEX IF NOT EXISTS idx_measurements_param_time ON measurements (parameter, timestamp DESC);`);
  console.log("[db] ready");
}

async function saveMeasurement({ topic, parameter, value, timestamp }) {
  if (!process.env.DATABASE_URL) return;
  const p = getPool();
  await p.query(
    `INSERT INTO measurements (topic, parameter, value, timestamp) VALUES ($1,$2,$3,$4)`,
    [topic, parameter, value, timestamp]
  );
}

module.exports = { initDb, getPool, saveMeasurement };
