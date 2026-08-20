// drizzle.config.js
const { defineConfig } = require('drizzle-kit');
require('dotenv').config();

module.exports = defineConfig({
    schema: './db/schema.js',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: {
        url: process.env.DATABASE_URL,
    },
    // These options work with latest drizzle-kit
    verbose: true,
    strict: true,
});