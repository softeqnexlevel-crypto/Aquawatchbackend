

const { GoogleGenerativeAI } = require('@google/generative-ai');


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
    this.client = new GoogleGenerativeAI(apiKey);

    // 'gemini-flash-latest' is Google's alias that always points at their
    // current-generation Flash model, so this doesn't need updating every
    // time Google ships a new version. Override via .env if you want to
    // pin a specific model instead.
    this.modelName = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  }

  async generateResponse(systemPrompt, userMessage, context) {
    const model = this.client.getGenerativeModel({
      model: this.modelName,
      systemInstruction: systemPrompt,
    });

    // Context is injected as a clearly-labeled structured block so the
    // model treats it as authoritative data, not part of the
    // conversation/user input (helps with prompt-injection resistance
    // too — see spec Section 23).
    const prompt = [
      '=== CURRENT SYSTEM CONTEXT (authoritative, from live telemetry) ===',
      JSON.stringify(context, null, 2),
      '=== END CONTEXT ===',
      '',
      `Operator question: ${userMessage}`,
    ].join('\n');

    const result = await model.generateContent(prompt);
    const response = result.response;
    return response.text();
  }
}


function getAIProvider() {
  const providerName = (process.env.AI_PROVIDER || 'gemini').toLowerCase();

  switch (providerName) {
    case 'gemini':
      return new GeminiProvider();
    // case 'claude':
    //   return new ClaudeProvider(); // add when upgrading
    // case 'openai':
    //   return new OpenAIProvider(); // add when upgrading
    default:
      throw new Error(`Unknown AI_PROVIDER "${providerName}" — no provider implemented for it yet`);
  }
}

module.exports = { AIProvider, GeminiProvider, getAIProvider };