import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns/promises';
import { Worker } from 'node:worker_threads';
import ipaddr from 'ipaddr.js';
import { convert } from 'html-to-text';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_FILES = /\.(pdf|docx|xlsx|txt|csv)$/i;

export async function readLimited(response) {
  if (!response.ok) throw new Error(`下載失敗（HTTP ${response.status}），請確認檔案尚未到期且可存取`);
  if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) throw new Error('檔案超過 10 MB');
  const parts = [];
  let size = 0;
  try {
    for await (const part of response.body) {
      size += part.length;
      if (size > MAX_FILE_BYTES) throw new Error('檔案超過 10 MB');
      parts.push(Buffer.from(part));
    }
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  return Buffer.concat(parts);
}

export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

// Pin validated DNS addresses to the actual socket; validate each redirect too.
export async function publicDownload(input, redirects = 0) {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw new Error('只支援公開的 HTTP／HTTPS 連結');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('不能讀取內網或本機連結');
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      headers: { 'User-Agent': 'HospitalAnnouncementBot/1.0', Accept: '*/*' },
      lookup: (_host, options, callback) => options.all
        ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family)
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 4 || !response.headers.location) return reject(new Error('連結重新導向過多'));
        resolve(publicDownload(new URL(response.headers.location, url).href, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`連結無法讀取（HTTP ${response.statusCode}），請直接上傳檔案`)); return; }
      if (Number(response.headers['content-length']) > MAX_FILE_BYTES) { response.destroy(); reject(new Error('連結內容超過 10 MB')); return; }
      let size = 0;
      const parts = [];
      response.on('data', part => {
        size += part.length;
        if (size > MAX_FILE_BYTES) { response.destroy(new Error('連結內容超過 10 MB')); return; }
        parts.push(part);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ buffer: Buffer.concat(parts), type: response.headers['content-type'] || '', url: url.href }));
    });
    const timer = setTimeout(() => request.destroy(new Error('讀取連結逾時，請直接上傳檔案')), 20000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}

export async function extractFile(buffer, name) {
  if (buffer.length > MAX_FILE_BYTES) throw new Error('檔案超過 10 MB');
  const extension = name.match(SUPPORTED_FILES)?.[1]?.toLowerCase();
  if (!extension) throw new Error('支援 PDF、DOCX、XLSX、TXT、CSV；舊版 DOC／XLS 請另存新格式');
  if (['txt', 'csv'].includes(extension)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
    if (!text.trim() || text.includes('\0')) throw new Error('文字檔內容無效，請使用 UTF-8 編碼');
    if (text.length > 100000) throw new Error('檔案文字過長，請拆分檔案');
    return text;
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./announcement-files-worker.js', import.meta.url), {
      workerData: { buffer, extension }, resourceLimits: { maxOldGenerationSizeMb: 192 }, execArgv: []
    });
    const timer = setTimeout(() => { reject(new Error('檔案解析逾時，請拆分或改傳文字')); worker.terminate(); }, 30000);
    worker.once('message', result => { clearTimeout(timer); worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result.text); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('檔案解析失敗，檔案可能過大或損毀')); });
  });
}

export function directPublicUrl(input) {
  const url = new URL(input);
  const id = url.pathname.match(/^\/file\/d\/([\w-]+)/)?.[1];
  if (url.hostname === 'drive.google.com' && id) return `https://drive.google.com/uc?export=download&id=${id}`;
  const doc = url.pathname.match(/^\/(document|spreadsheets)\/d\/([\w-]+)/);
  if (url.hostname === 'docs.google.com' && doc) return `https://docs.google.com/${doc[1]}/d/${doc[2]}/export?format=${doc[1] === 'document' ? 'txt' : 'xlsx'}`;
  return input;
}

export async function extractLink(input, download = publicDownload) {
  const result = await download(directPublicUrl(input));
  const { buffer, type } = result;
  const url = new URL(result.url);
  if (['accounts.google.com', 'login.microsoftonline.com'].includes(url.hostname)) throw new Error('連結需要登入，請直接上傳檔案');
  const extension = /pdf/i.test(type) ? 'pdf' : /wordprocessingml/i.test(type) ? 'docx' : /spreadsheetml/i.test(type) ? 'xlsx'
    : /csv/i.test(type) ? 'csv' : /text\/plain/i.test(type) ? 'txt' : decodeURIComponent(url.pathname).match(SUPPORTED_FILES)?.[1];
  if (extension) return extractFile(buffer, `linked.${extension}`);
  if (!/text\/html/i.test(type)) throw new Error('連結不是可讀取的網頁或支援檔案，請直接上傳檔案');
  const text = convert(buffer.toString('utf8'), { wordwrap: false, selectors: [{ selector: 'script', format: 'skip' }, { selector: 'style', format: 'skip' }, { selector: 'a', options: { ignoreHref: true } }] });
  if (text.length < 40 || /登入您的帳戶|Sign in to your account|You need access|要求存取權|Request access/i.test(text)) throw new Error('連結內容不足或需要權限，請直接上傳檔案');
  if (text.length > 100000) throw new Error('網頁文字過長，請改傳需要的內容');
  return text;
}
