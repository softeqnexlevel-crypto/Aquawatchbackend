// test-mpesa-token.js
// Run with: node test-mpesa-token.js
// Isolates the OAuth token fetch from everything else — no Express,
// no db, no billing.service.js — to determine if the failure is in
// Node's fetch/TLS handling itself vs somewhere else in the app.

require('dotenv').config();

const {
    MPESA_CONSUMER_KEY,
    MPESA_CONSUMER_SECRET,
    MPESA_ENV = 'sandbox',
} = process.env;

const BASE_URL = MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

console.log('Node version:', process.version);
console.log('MPESA_ENV:', MPESA_ENV);
console.log('BASE_URL:', BASE_URL);
console.log('Consumer key length:', MPESA_CONSUMER_KEY?.length, 'starts with:', JSON.stringify(MPESA_CONSUMER_KEY?.slice(0, 5)));
console.log('Consumer secret length:', MPESA_CONSUMER_SECRET?.length, 'starts with:', JSON.stringify(MPESA_CONSUMER_SECRET?.slice(0, 5)));

// Flag hidden whitespace/newlines that a text editor or .env parser
// might have introduced — the single most common cause of this exact
// symptom (curl works, Node's fetch doesn't, same literal credentials).
const hasHiddenChars = (label, value) => {
    if (!value) return;
    if (value !== value.trim()) {
        console.warn(`⚠️  ${label} has leading/trailing whitespace!`);
    }
    if (/[\r\n\t]/.test(value)) {
        console.warn(`⚠️  ${label} contains a hidden newline/tab character!`);
    }
};
hasHiddenChars('MPESA_CONSUMER_KEY', MPESA_CONSUMER_KEY);
hasHiddenChars('MPESA_CONSUMER_SECRET', MPESA_CONSUMER_SECRET);

async function main() {
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
    const url = `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`;

    console.log('\nRequesting:', url);

    try {
        const res = await fetch(url, {
            headers: { Authorization: `Basic ${auth}` },
        });

        console.log('HTTP status:', res.status);
        console.log('Headers:', JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2));

        const text = await res.text();
        console.log('Raw body:', JSON.stringify(text));
        console.log('Body length:', text.length);

        try {
            const json = JSON.parse(text);
            console.log('\n✅ Parsed successfully:', json);
        } catch (parseErr) {
            console.log('\n❌ JSON.parse failed:', parseErr.message);
        }
    } catch (fetchErr) {
        console.log('\n❌ fetch() itself threw:', fetchErr);
    }
}

main();