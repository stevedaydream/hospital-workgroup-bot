import * as strata from './strata.js';
import * as gemini from './gemini.js';

// Provider switch: try Strata (home PC over Tailscale) first, fall back to
// Gemini when it is unreachable or fails. The result carries `provider` so the
// caller can tell the group when photos were sent to the cloud (decision 8·9).

async function withFallback(label, strataCall, geminiCall) {
  if (strata.strataEnabled) {
    try {
      return { ...(await strataCall()), provider: 'strata' };
    } catch (error) {
      // Mock output would be written to the DB and pushed to groups as if it
      // were real, so without a Gemini key a Strata failure stays a failure.
      if (gemini.geminiMockMode) {
        console.error(`AI Engine [STRATA ${label} FAILED, no Gemini key for fallback]:`, error.message);
        throw new Error(`本機 AI（Strata）辨識失敗，且未設定雲端備援: ${error.message}`);
      }
      console.error(`AI Engine [STRATA ${label} FAILED, falling back to Gemini]:`, error.message);
      return { ...(await geminiCall()), provider: 'gemini', fallbackReason: error.message };
    }
  }
  return { ...(await geminiCall()), provider: gemini.geminiMockMode ? 'mock' : 'gemini' };
}

export function analyzeCaseImage(imageBuffer) {
  return withFallback('SINGLE',
    () => strata.analyzeCaseImage(imageBuffer),
    () => gemini.analyzeCaseImage(imageBuffer));
}

export function analyzeMultipleImages(imageBuffers) {
  return withFallback('MULTI',
    () => strata.analyzeMultipleImages(imageBuffers),
    () => gemini.analyzeMultipleImages(imageBuffers));
}

export const primaryProviderLabel = strata.strataEnabled ? '本機 AI（Strata）' : 'Gemini AI';
