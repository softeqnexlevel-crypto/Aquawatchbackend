// services/ai/AIProvider.js
const { GoogleGenAI } = require('@google/genai');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Temporary conditions worth retrying: rate limit, server error, overloaded.
const RETRYABLE_STATUS = new Set([429, 500, 503, 504]);
const MAX_ATTEMPTS_PER_MODEL = 3; // waits 1s, then 2s between attempts

class AIProvider {
  async generateResponse(systemPrompt, userMessage, context) {
    throw new Error('generateResponse() not implemented');
  }
}

class GeminiProvider extends AIProvider {
  constructor() {
    super();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set in .env — required for GeminiProvider');
    }
    this.client = new GoogleGenAI({ apiKey });

    // Set GEMINI_MODEL in .env to a model your key can call
    // (run test-gemini.js to list them). The fallback below is only a default.
    this.modelName = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

    // Optional: a second model tried only if the main one stays overloaded
    // (503 "high demand"). Example: GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite
    this.fallbackModel = process.env.GEMINI_FALLBACK_MODEL || null;
  }

  async generateResponse(systemPrompt, userMessage, context) {
    const contents = [
      '=== CURRENT SYSTEM CONTEXT (authoritative, from live telemetry) ===',
      JSON.stringify(context, null, 2),
      '=== END CONTEXT ===',
      '',
      `Operator question: ${userMessage}`,
    ].join('\n');

    const models = [this.modelName, this.fallbackModel].filter(Boolean);
    let lastErr;

    for (const model of models) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
        try {
          const response = await this.client.models.generateContent({
            model,
            contents,
            config: { systemInstruction: systemPrompt },
          });

          const text = response && response.text;
          if (!text) {
            throw new Error('Model returned an empty response (it may have been blocked).');
          }
          return text;
        } catch (err) {
          lastErr = err;
          const status = err && err.status;

          // Not a temporary problem (bad key, bad model name, blocked, ...): stop now.
          if (!RETRYABLE_STATUS.has(status)) throw err;

          console.warn(`[ai] ${model} attempt ${attempt + 1}/${MAX_ATTEMPTS_PER_MODEL} failed (${status}); ${
            attempt < MAX_ATTEMPTS_PER_MODEL - 1 ? 'retrying' : 'giving up on this model'
          }`);
          if (attempt < MAX_ATTEMPTS_PER_MODEL - 1) await sleep(1000 * 2 ** attempt);
        }
      }
      // Retries exhausted on this model: fall through to the fallback model, if any.
    }

    throw lastErr;
  }
}

function getAIProvider() {
  const providerName = (process.env.AI_PROVIDER || 'gemini').toLowerCase();

  switch (providerName) {
    case 'gemini':
      return new GeminiProvider();
    // case 'claude':
    //   return new ClaudeProvider();
    // case 'openai':
    //   return new OpenAIProvider();
    default:
      throw new Error(`Unknown AI_PROVIDER "${providerName}" — no provider implemented for it yet`);
  }
}

module.exports = { AIProvider, GeminiProvider, getAIProvider };