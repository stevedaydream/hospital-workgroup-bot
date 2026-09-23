/**
 * Lightweight verification for the local model (decision 18).
 *
 * Measures the two things that actually change the implementation:
 *   1. how long one photograph really takes on this hardware -- which sets the
 *      timeout, the "about N minutes" wording, and the image resolution cap;
 *   2. whether classification is stable -- the one stage with no downstream
 *      guard, because name matching only checks names and the confirmation
 *      card only shows what was extracted.
 *
 * Usage:
 *   node scripts/benchmark.mjs                # classification + timing only
 *   node scripts/benchmark.mjs --full         # also run the extraction stage
 *   node scripts/benchmark.mjs --dir path     # a different image folder
 *
 * Ground truth is optional. Create scripts/labels.json like:
 *   { "615844065263222972.jpg": "CASE_TABLE", "615850548231143544.jpg": "WARD_NOTE" }
 * and accuracy is reported against it.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { prepareForInference, toBase64 } from '../src/util/image.js';
import { analyzeImages } from '../src/ai/index.js';
import * as local from '../src/ai/local.js';
import { CLASSIFY_SCHEMA, normaliseType } from '../src/ai/schemas.js';
import { CLASSIFY_PROMPT } from '../src/ai/prompts.js';

const args = process.argv.slice(2);
const runFull = args.includes('--full');
const dirIndex = args.indexOf('--dir');
const imageDir = dirIndex >= 0 ? args[dirIndex + 1] : 'public/images';

const labelsPath = 'scripts/labels.json';
const labels = fs.existsSync(labelsPath) ? JSON.parse(fs.readFileSync(labelsPath, 'utf-8')) : {};

if (!(await local.isAvailable())) {
  console.error('llama-server is not reachable -- start it before benchmarking.');
  console.error(`  LLAMA_SERVER_URL=${process.env.LLAMA_SERVER_URL || 'http://127.0.0.1:8080'}`);
  process.exit(1);
}

// The image folder accumulates duplicates (the same table re-sent); hash to
// avoid paying for the same photograph twice.
const seenHashes = new Set();
const files = fs
  .readdirSync(imageDir)
  .filter((file) => /\.(jpe?g|png)$/i.test(file))
  .filter((file) => {
    const hash = crypto.createHash('md5').update(fs.readFileSync(path.join(imageDir, file))).digest('hex');
    if (seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    return true;
  })
  .sort();

console.log(`Benchmarking ${files.length} unique image(s) from ${imageDir}\n`);

const results = [];
let correct = 0;
let labelled = 0;

for (const file of files) {
  const raw = fs.readFileSync(path.join(imageDir, file));
  const prepared = await prepareForInference(raw);

  const classifyStart = Date.now();
  let predicted = 'ERROR';
  let classifyMs = 0;
  try {
    const { data } = await local.complete({
      prompt: CLASSIFY_PROMPT,
      images: [toBase64(prepared.buffer)],
      schema: CLASSIFY_SCHEMA
    });
    predicted = normaliseType(data);
  } catch (error) {
    predicted = `ERROR: ${error.reason || error.message}`;
  }
  classifyMs = Date.now() - classifyStart;

  const expected = labels[file];
  if (expected) {
    labelled++;
    if (expected === predicted) correct++;
  }

  let extractMs = null;
  let extracted = null;
  if (runFull && !predicted.startsWith('ERROR')) {
    const fullStart = Date.now();
    try {
      const result = await analyzeImages([raw]);
      extracted =
        result.type === 'CASE_TABLE'
          ? `${result.assignments.length} assignment(s)`
          : result.type === 'CALENDAR'
            ? `${result.events.length} event(s)`
            : `${result.notes.length} note(s)`;
    } catch (error) {
      extracted = `ERROR: ${error.message}`;
    }
    extractMs = Date.now() - fullStart;
  }

  const mark = expected ? (expected === predicted ? ' ok ' : 'MISS') : '  ? ';
  console.log(
    `[${mark}] ${file}  ${(prepared.width + 'x' + prepared.height).padEnd(10)} ` +
      `${predicted.padEnd(12)} classify ${(classifyMs / 1000).toFixed(1)}s` +
      (extractMs !== null ? `  full ${(extractMs / 1000).toFixed(1)}s  ${extracted}` : '')
  );

  results.push({ file, predicted, expected: expected || null, classifyMs, extractMs, extracted });
}

const classifyTimes = results.map((r) => r.classifyMs).sort((a, b) => a - b);
const median = classifyTimes[Math.floor(classifyTimes.length / 2)] || 0;
const slowest = classifyTimes[classifyTimes.length - 1] || 0;

console.log('\n---------------------------------------------');
console.log(`classify: median ${(median / 1000).toFixed(1)}s, slowest ${(slowest / 1000).toFixed(1)}s`);
if (runFull) {
  const fullTimes = results.filter((r) => r.extractMs).map((r) => r.extractMs).sort((a, b) => a - b);
  if (fullTimes.length) {
    console.log(
      `full run: median ${(fullTimes[Math.floor(fullTimes.length / 2)] / 1000).toFixed(1)}s, ` +
        `slowest ${(fullTimes[fullTimes.length - 1] / 1000).toFixed(1)}s`
    );
    console.log(
      `suggested LOCAL_INFERENCE_TIMEOUT_MS: ${Math.ceil((fullTimes[fullTimes.length - 1] * 1.5) / 60000) * 60000}` +
        ' (slowest x1.5, rounded up to the minute)'
    );
  }
}
if (labelled) {
  console.log(`classification accuracy: ${correct}/${labelled} (${Math.round((correct / labelled) * 100)}%)`);
} else {
  console.log(`no labels found -- create ${labelsPath} to measure accuracy`);
}

fs.writeFileSync('scripts/benchmark-results.json', JSON.stringify(results, null, 2));
console.log('detailed results written to scripts/benchmark-results.json');
