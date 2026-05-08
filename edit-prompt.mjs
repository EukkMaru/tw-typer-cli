// edit-prompt.mjs
import 'dotenv/config'
import { readEncodedFile, writeEncodedFile } from './util.mjs';
import { execSync } from 'child_process';
import fs from 'fs';

const path = process.argv[2] || 'prompt.dat';
const tmp = `${path}.tmp.unencrypted`;

fs.writeFileSync(tmp, readEncodedFile(path));
execSync(`${process.env.EDITOR || 'nano'} ${tmp}`, { stdio: 'inherit' });
writeEncodedFile(path, fs.readFileSync(tmp, 'utf8'));
fs.unlinkSync(tmp);
console.log(`Updated ${path}`);