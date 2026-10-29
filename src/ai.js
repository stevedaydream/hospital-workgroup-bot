import * as local from './local-ai.js';
import * as gemini from './gemini.js';

// Provider switch: try the local models (Strata, then Qwen3.6) first, fall
// back to Gemini when none of them answers. The result carries `provider` so
// the caller can tell the group when photos were sent to the cloud (decision 8·9).

async function withFallback(label, localCall, geminiCall) {
  if (local.localAiEnabled) {
    try {
      const result = await localCall();
      return { ...result, provider: local.modelLabel(result.model) };
    } catch (error) {
      // Mock output would be written to the DB and pushed to groups as if it
      // were real, so without a Gemini key a local failure stays a failure.
      if (gemini.geminiMockMode) {
        console.error(`AI Engine [LOCAL ${label} FAILED, no Gemini key for fallback]:`, error.message);
        throw new Error(`本機 AI 辨識失敗，且未設定雲端備援: ${error.message}`);
      }
      console.error(`AI Engine [LOCAL ${label} FAILED, falling back to Gemini]:`, error.message);
      return { ...(await geminiCall()), provider: 'gemini', fallbackReason: error.message };
    }
  }
  return { ...(await geminiCall()), provider: gemini.geminiMockMode ? 'mock' : 'gemini' };
}

export function analyzeCaseImage(imageBuffer) {
  return withFallback('SINGLE',
    () => local.analyzeCaseImage(imageBuffer),
    () => gemini.analyzeCaseImage(imageBuffer));
}

export function analyzeMultipleImages(imageBuffers) {
  return withFallback('MULTI',
    () => local.analyzeMultipleImages(imageBuffers),
    () => gemini.analyzeMultipleImages(imageBuffers));
}

export const primaryProviderLabel = local.localAiEnabled ? '本機 AI' : 'Gemini AI';
