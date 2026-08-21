
const { GoogleGenAI } = require('@google/genai');


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

  
    this.modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  }

  async generateResponse(systemPrompt, userMessage, context) {
    
    const contents = [
      '=== CURRENT SYSTEM CONTEXT (authoritative, from live telemetry) ===',
      JSON.stringify(context, null, 2),
      '=== END CONTEXT ===',
      '',
      `Operator question: ${userMessage}`,
    ].join('\n');

    const response = await this.client.models.generateContent({
      model: this.modelName,
      contents,
      config: {
        systemInstruction: systemPrompt,
      },
    });

    return response.text;
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