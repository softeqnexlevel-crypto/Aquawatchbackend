// backend/test-debug.js
const { V3 } = require('paseto');
const crypto = require('crypto');

async function test() {
    // Test 1: Basic encrypt/decrypt
    console.log('Test 1: Basic encrypt/decrypt');
    const key = crypto.randomBytes(32);
    const payload = { test: 'hello', type: 'access', exp: Math.floor(Date.now()/1000) + 900 };
    
    try {
        const token = await V3.encrypt(payload, key);
        console.log('Encrypted:', token.substring(0, 30) + '...');
        
        const decrypted = await V3.decrypt(token, key);
        console.log('Decrypted:', decrypted);
        
        if (decrypted.test === 'hello') {
            console.log('✅ PASETO works correctly');
        }
    } catch(e) {
        console.error('❌ PASETO failed:', e.message);
        console.error('Full error:', e);
    }
    
    // Test 2: Test with same key (simulating token reuse)
    console.log('\nTest 2: Same key different operation');
    const key2 = crypto.randomBytes(32);
    
    try {
        const token1 = await V3.encrypt({ data: 'first' }, key2);
        const result1 = await V3.decrypt(token1, key2);
        console.log('First decrypt:', result1.data);
        
        const token2 = await V3.encrypt({ data: 'second' }, key2);
        const result2 = await V3.decrypt(token2, key2);
        console.log('Second decrypt:', result2.data);
        
        console.log('✅ Same key works for multiple tokens');
    } catch(e) {
        console.error('❌ Same key test failed:', e.message);
    }
    
    // Test 3: Test with wrong key
    console.log('\nTest 3: Wrong key');
    const keyA = crypto.randomBytes(32);
    const keyB = crypto.randomBytes(32);
    
    try {
        const token = await V3.encrypt({ data: 'test' }, keyA);
        await V3.decrypt(token, keyB);
        console.log('❌ Should have failed');
    } catch(e) {
        console.log('✅ Correctly failed with wrong key');
    }
}

test();