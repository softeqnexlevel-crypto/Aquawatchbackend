

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');

const { getAIProvider } = require('../services/ai/AIProvider');
const { buildSystemContext, SYSTEM_PROMPT } = require('../services/ai/contextBuilder');

const MAX_MESSAGE_LENGTH = 2000; 

router.post('/chat', authMiddleware.requireAuth, async (req, res) => {
  try {
    const { message } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A non-empty "message" string is required.' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters).` });
    }

    const context = buildSystemContext();
    const provider = getAIProvider();

    const reply = await provider.generateResponse(SYSTEM_PROMPT, message.trim(), context);

    res.json({
      reply,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    // console.error('[ai/chat] error:', detail);
   
    res.status(500).json({ error: `Aqua AI is temporarily unavailable. [debug: ${detail}]` });
  }
});

module.exports = router;