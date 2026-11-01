import fs from 'node:fs';
import path from 'node:path';

export const REVIEW_MODELS = { 'qwen3.6': 'qwen36', local: 'strata' };
const labels = { 'qwen3.6': 'Qwen3.6', local: 'Strata' };

export async function prepareReviewModel(model, { signal, previousModel, request = controlRequest, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!Object.hasOwn(REVIEW_MODELS, model)) throw new Error('不支援的模型');
  const old = REVIEW_MODELS[previousModel] || (model === 'local' ? 'qwen36' : 'strata');
  // Never force: Port Monitor checks direct tasks, managed requests and ownership.
  let stopped = false;
  for (let i = 0; i < 15; i++) {
    signal?.throwIfAborted();
    const result = await request('/action', { type: 'stopModel', id: old, force: false }, signal);
    if (result.stopped) { stopped = true; break; }
    await pause(1000);
  }
  if (!stopped) throw new Error(`原模型仍有工作，未強制停止，也未啟動 ${labels[model]}。請稍後重試。`);
  for (let i = 0; i < 15; i++) {
    signal?.throwIfAborted();
    const snapshot = await request('/snapshot', null, signal);
    const previous = snapshot.models?.profiles?.find(item => item.profile?.id === old);
    if (!previous) throw new Error('無法確認原模型狀態，未啟動新模型。');
    if (!previous.status?.loaded && !previous.status?.busy && !previous.managed?.ready && !previous.managed?.starting && !previous.managed?.inflight) return;
    await pause(1000);
  }
  throw new Error('原模型尚未完成釋放，未啟動新模型。');
}

async function controlRequest(route, body, signal) {
  const file = process.env.PORT_MONITOR_CONTROL_SETTINGS_PATH || path.join(process.env.LOCALAPPDATA || '', 'com.stevedaydream.portmonitor', 'settings.json');
  let token;
  try { token = JSON.parse(fs.readFileSync(file, 'utf8')).token; } catch { throw new Error('無法讀取 Port Monitor 控制設定，未切換模型。'); }
  if (!token) throw new Error('Port Monitor 尚未設定控制金鑰。');
  const response = await fetch(`http://127.0.0.1:43920/api${route}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([AbortSignal.timeout(20000), ...(!body && signal ? [signal] : [])])
  });
  if (!response.ok) throw new Error(`Port Monitor 控制失敗（HTTP ${response.status}），未啟動新模型。`);
  return response.json();
}
