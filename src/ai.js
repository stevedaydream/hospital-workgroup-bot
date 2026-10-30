import * as local from './local-ai.js';
import * as gemini from './gemini.js';

// Provider switch: try the local models (Strata, then Qwen3.6) first, fall
// back to Gemini when none of them answers. The result carries `provider` so
// the caller can tell the group when photos were sent to the cloud (decision 8·9).

async function withFallback(label, localCall, geminiCall, onAttempt) {
  if (local.localAiEnabled) {
    try {
      const result = await localCall(onAttempt);
      return { ...result, provider: local.modelLabel(result.model) };
    } catch (error) {
      // Mock output would be written to the DB and pushed to groups as if it
      // were real, so without a Gemini key a local failure stays a failure.
      if (gemini.geminiMockMode) {
        console.error(`AI Engine [LOCAL ${label} FAILED, no Gemini key for fallback]:`, error.message);
        throw new Error(`本機 AI 辨識失敗，且未設定雲端備援: ${error.message}`);
      }
      console.error(`AI Engine [LOCAL ${label} FAILED, falling back to Gemini]:`, error.message);
      onAttempt?.('gemini');
      return { ...(await geminiCall()), provider: 'gemini', fallbackReason: error.message };
    }
  }
  onAttempt?.('gemini');
  return { ...(await geminiCall()), provider: gemini.geminiMockMode ? 'mock' : 'gemini' };
}

/**
 * @param {Buffer} imageBuffer
 * @param {(model: string) => void} [onAttempt] - called before each model is tried ('gemini' for the cloud)
 */
export function analyzeCaseImage(imageBuffer, onAttempt) {
  return withFallback('SINGLE',
    attempt => local.analyzeCaseImage(imageBuffer, attempt),
    () => gemini.analyzeCaseImage(imageBuffer),
    onAttempt);
}

export function analyzeMultipleImages(imageBuffers, onAttempt) {
  return withFallback('MULTI',
    attempt => local.analyzeMultipleImages(imageBuffers, attempt),
    () => gemini.analyzeMultipleImages(imageBuffers),
    onAttempt);
}

export function analyzeRoster(imageBuffer, onAttempt) {
  return withFallback('ROSTER',
    attempt => local.analyzeRoster(imageBuffer, attempt),
    () => gemini.analyzeRoster(imageBuffer),
    onAttempt);
}

export const primaryProviderLabel = local.localAiEnabled ? '本機 AI' : 'Gemini AI';
export const modelLabel = model => (model === 'gemini' ? 'Gemini' : local.modelLabel(model));
export const isModelLoaded = model => (model === 'gemini' ? Promise.resolve(true) : local.isModelLoaded(model));
