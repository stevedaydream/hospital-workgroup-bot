import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// images.js moves public/images into data/images on import, so run it in a scratch directory.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'images-test-'));
fs.mkdirSync(path.join(dir, 'public/images'), { recursive: true });
fs.writeFileSync(path.join(dir, 'public/images/111.jpg'), 'old');
const cwd = process.cwd();
process.chdir(dir);
process.env.IMAGE_URL_SECRET = 'test-secret';
process.env.BASE_URL = 'https://relay.example';
const images = await import(pathToFileURL(path.join(cwd, 'src/images.js')).href);
process.chdir(cwd);

test('photos left in public/ move to data/images', () => {
  assert.equal(fs.existsSync(path.join(dir, 'public/images')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'data/images/111.jpg'), 'utf8'), 'old');
});

test('signed links verify until they expire, and only for their own photo', () => {
  const now = Date.UTC(2026, 10, 4);
  const url = new URL(images.signedImageUrl('639031440344613018', now));
  assert.equal(url.origin + url.pathname, 'https://relay.example/images/639031440344613018.jpg');
  const exp = url.searchParams.get('exp'), sig = url.searchParams.get('sig');
  assert.equal(images.verifyImageLink('639031440344613018', exp, sig, now), true);
  assert.equal(images.verifyImageLink('639031440344613019', exp, sig, now), false);
  assert.equal(images.verifyImageLink('639031440344613018', exp, sig, Number(exp) + 1), false);
  assert.equal(images.verifyImageLink('639031440344613018', exp, undefined, now), false);
  assert.equal(images.verifyImageLink('../x', exp, sig, now), false);
});

test('pruning drops old photos but keeps ones still queued', () => {
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  for (const id of ['1', '2', '3']) fs.writeFileSync(path.join(images.IMAGES_DIR, `${id}.jpg`), 'x');
  fs.utimesSync(path.join(images.IMAGES_DIR, '1.jpg'), old / 1000, old / 1000);
  fs.utimesSync(path.join(images.IMAGES_DIR, '2.jpg'), old / 1000, old / 1000);
  assert.equal(images.pruneImages(['2']), 1);
  assert.deepEqual(fs.readdirSync(images.IMAGES_DIR).sort(), ['111.jpg', '2.jpg', '3.jpg']);
});
