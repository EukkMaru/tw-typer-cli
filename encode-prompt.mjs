#!/usr/bin/env node
// Burner script: encodes prompt.txt.unencrypted -> prompt.dat
// Usage: node encode-prompt.mjs [input] [output]
//   defaults: prompt.txt.unencrypted -> prompt.dat
//
// Encoding: UTF-8 -> XOR with KEY (rotating) -> base64
// Decode is symmetric; mirror this logic in your runtime loader.
import 'dotenv/config'
import fs from 'fs';

// IMPORTANT: replace this with your actual key, and use the same key
// in your runtime decode function and in the pairs.dat encoder.
// Recommend 16+ ASCII characters. Keep it out of public commits.
const KEY = process.env.KEY;
if (!KEY) {
    throw new Error('KEY not set...');
}

const inputPath = process.argv[2] || 'prompt-rp.txt.unencrypted';
const outputPath = process.argv[3] || 'prompt-rp.dat';

if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
}

const plaintext = fs.readFileSync(inputPath, 'utf8');
const buf = Buffer.from(plaintext, 'utf8');

for (let i = 0; i < buf.length; i++) {
    buf[i] ^= KEY.charCodeAt(i % KEY.length);
}

const encoded = buf.toString('base64');
fs.writeFileSync(outputPath, encoded);

console.log(`Encoded ${buf.length} bytes -> ${encoded.length} chars`);
console.log(`Wrote ${outputPath}`);
