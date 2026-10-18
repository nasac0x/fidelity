#!/usr/bin/env node
// OCR — recover UI text baked into banner images (label-free substitutes), offline-first.
// Usage: node ocr.mjs --img <path.png> [--lang por] [--newline]
// Data: @tesseract.js-data/<lang> must be installed (por = 8.1 MB); core+worker local.

import { createWorker } from 'tesseract.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const img = arg('img');
if (!img) { console.error('Usage: node ocr.mjs --img image.png [--lang por]'); process.exit(2); }
const lang = arg('lang', 'por');
const keepNewlines = process.argv.includes('--newline');

const localData = path.join(dir, 'node_modules', '@tesseract.js-data');
// locate the dir actually containing <lang>.traineddata.gz (e.g. .../<lang>/4.0.0/)
function findLangDir() {
  const candidates = [
    path.join(localData, lang, '4.0.0'),
    path.join(localData, lang),
    localData,
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, `${lang}.traineddata.gz`)) || fs.existsSync(path.join(c, `${lang}.traineddata`))) return c;
  }
  return undefined;
}
const langDir = findLangDir();

const worker = await createWorker(lang, 1, langDir ? { langPath: langDir } : {});
const { data } = await worker.recognize(path.resolve(img));
const text = keepNewlines ? data.text.trim() : data.text.replace(/\s+/g, ' ').trim();
console.log(text || '<no text recovered>');
console.error(`confidence: ${data.confidence?.toFixed?.(1) ?? 'n/a'}`);
await worker.terminate();
