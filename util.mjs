// Common utilities for tw-typer-cli/rewrite.
// Centralizes the obfuscation scheme so prompt.dat and pairs.dat
// share one code path.

import fs from 'fs';
import { diffChars } from 'diff';

// Naked-eye obfuscation only. Not security against motivated readers.
// Same key used for prompt.dat and pairs.dat. Rotating it requires
// re-encoding every existing .dat file.
const KEY = process.env.KEY;
if (!KEY) {
    throw new Error('KEY not set...');
}
// XOR a buffer in place against KEY (rotating).
function xorBuf(buf) {
    for (let i = 0; i < buf.length; i++) {
        buf[i] ^= KEY.charCodeAt(i % KEY.length);
    }
    return buf;
}

// utf8 string -> XOR -> base64
export function encode(plaintext) {
    const buf = Buffer.from(plaintext, 'utf8');
    xorBuf(buf);
    return buf.toString('base64');
}

// base64 -> XOR -> utf8 string
export function decode(encoded) {
    const buf = Buffer.from(encoded, 'base64');
    xorBuf(buf);
    return buf.toString('utf8');
}

// Read and decode an entire .dat file (single base64 blob).
// Used for prompt.dat.
export function readEncodedFile(path) {
    const encoded = fs.readFileSync(path, 'utf8').trim();
    if (!encoded) return '';
    return decode(encoded);
}

// Encode and write a string to a .dat file (single base64 blob).
export function writeEncodedFile(path, plaintext) {
    fs.writeFileSync(path, encode(plaintext));
}

// Read all pairs from a line-per-pair .dat file. Each non-empty line
// is one encoded JSON object. Tolerant of partial corruption: lines
// that fail to decode/parse are skipped with a warning, not fatal.
// Used for pairs.dat.
export function readPairsFile(path) {
    if (!fs.existsSync(path)) return [];
    const raw = fs.readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter(l => l.length > 0);
    const pairs = [];
    for (const [idx, line] of lines.entries()) {
        try {
            pairs.push(JSON.parse(decode(line)));
        } catch (err) {
            console.warn(`pairs.dat line ${idx + 1} skipped: ${err.message}`);
        }
    }
    return pairs;
}

// Append one pair to the line-per-pair file. Pair shape is up to the
// caller; recommended { input, rewrite, tier, timestamp } where tier
// is one of 'keep' | 'favorite' | 'skip'.
export function appendPair(path, pair) {
    const line = encode(JSON.stringify(pair)) + '\n';
    fs.appendFileSync(path, line);
}

// Pair selection for prompt injection. Favorites first (capped),
// then recent keeps to fill remaining slots. Skips excluded.
// Default cap matches the prompt's expected example budget.
export function selectExamples(pairs, maxCount = 8) {
    const favorites = pairs.filter(p => p.tier === 'favorite');
    const keeps = pairs
        .filter(p => p.tier === 'keep')
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const selected = [];
    for (const p of favorites) {
        if (selected.length >= maxCount) break;
        selected.push(p);
    }
    for (const p of keeps) {
        if (selected.length >= maxCount) break;
        selected.push(p);
    }
    return selected;
}

// Format selected pairs into the string that replaces {{EXAMPLES}}
// in the system prompt. Favorites get a [favorite] tag per the
// prompt's instructions.
export function formatExamples(pairs) {
    if (pairs.length === 0) return '(no prior examples yet)';
    return pairs.map((p, i) => {
        const tag = p.tier === 'favorite' ? ' [favorite]' : '';
        return `Example ${i + 1}${tag}:\n\nInput:\n${p.input}\n\nRewrite:\n${p.rewrite}`;
    }).join('\n\n---\n\n');
}

// Load the system prompt with examples injected.
export function loadSystemPrompt(promptPath = 'prompt.dat', pairsPath = 'pairs.dat') {
    const template = readEncodedFile(promptPath);
    const pairs = readPairsFile(pairsPath);
    const selected = selectExamples(pairs);
    return template.replace('{{EXAMPLES}}', formatExamples(selected));
}

// Parse Claude's structured response. Tolerant of whitespace and
// missing tags. Returns { analysis, refusal, segments, rewrite } where
// any missing field is null. Caller decides how to react to nulls.
export function parseResponse(text) {
    const extract = (tag) => {
        const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
        const m = text.match(re);
        return m ? m[1].trim() : null;
    };
    return {
        analysis: extract('analysis'),
        refusal: extract('refusal'),
        segments: extract('segments'),
        rewrite: extract('rewrite'),
    };
}

// Convenience: did Claude refuse? <refusal>none</refusal> means no
// refusal; anything else (or missing rewrite) means refusal path.
export function isRefusal(parsed) {
    if (!parsed.refusal) return !parsed.rewrite;
    const r = parsed.refusal.trim().toLowerCase();
    return r !== 'none' && r !== '';
}

// Split a marker-delimited string into blocks. Markers are `///` either
// on their own line (between structural elements) or inline within
// parenthesized blocks. Both forms collapse to the same block boundaries
// for sync-view layout purposes.
export function splitByMarkers(text) {
    if (!text) return [];
    return text.split(/\s*\/\/\/\s*/);
}

// Stitch blocks back together. Loose join — the structural correctness
// comes from normalizeStructure() called on the result, not from
// preserving whitespace through the split.
export function stitchBlocks(blocks) {
    if (!blocks || blocks.length === 0) return '';
    return blocks.join(' ');
}

// Normalize the structural layout of a finished message. Identifies
// three kinds of groups:
//   - Quotation blocks: "..." (ASCII double-quotes only)
//   - Parenthesis blocks: (...) (with depth tracking)
//   - Plaintext runs: everything else, broken at paragraph gaps
//
// Between adjacent groups of any kind, exactly two linebreaks are
// inserted. Internal whitespace within each block is preserved.
// Leading and trailing whitespace is trimmed from the final output.
//
// This is the post-fix step at cut-time. Runs purely on local text;
// no Claude involvement. Discards whatever spacing the stitched blocks
// produced and rebuilds structure from scratch based on punctuation.
//
// Caveats:
// - Unmatched quotes/parens extend their block to end of input.
// - Plaintext that contains a paragraph gap (whitespace with 2+
//   newlines) is split into separate plaintext groups at the gap.
// - Korean midline ellipsis ⋯, the `......` transition line, and any
//   other non-quote-non-paren punctuation count as plaintext groups
//   when they stand alone.
export function normalizeStructure(text) {
    if (!text) return '';
    const groups = [];
    let i = 0;
    const n = text.length;

    while (i < n) {
        const ch = text[i];

        // Skip whitespace between groups.
        if (/\s/.test(ch)) {
            i++;
            continue;
        }

        if (ch === '"') {
            // Quote block: scan until matching closing quote, or EOF.
            let j = i + 1;
            while (j < n && text[j] !== '"') j++;
            const end = j < n ? j + 1 : n;
            groups.push(text.slice(i, end));
            i = end;
            continue;
        }

        if (ch === '(') {
            // Paren block with depth tracking.
            let depth = 1;
            let j = i + 1;
            while (j < n && depth > 0) {
                if (text[j] === '(') depth++;
                else if (text[j] === ')') depth--;
                if (depth > 0) j++;
            }
            const end = j < n ? j + 1 : n;
            groups.push(text.slice(i, end));
            i = end;
            continue;
        }

        // Plaintext run: scan until next quote, paren, or paragraph
        // gap (whitespace containing 2+ newlines).
        let j = i;
        while (j < n) {
            const c = text[j];
            if (c === '"' || c === '(') break;
            if (/\s/.test(c)) {
                // Look ahead to see if this is a paragraph gap.
                let k = j;
                let nlCount = 0;
                while (k < n && /\s/.test(text[k])) {
                    if (text[k] === '\n') nlCount++;
                    k++;
                }
                if (nlCount >= 2 || k === n) break;
            }
            j++;
        }
        const chunk = text.slice(i, j).replace(/\s+$/, '');
        if (chunk) groups.push(chunk);
        i = j;
    }

    return groups.join('\n\n').trim();
}

// Compute a token-level diff between two texts. Returns an array of
// { type, value } where type is 'equal' | 'removed' | 'added'.
// Tokenization preserves whitespace boundaries so reconstruction is
// straightforward.
// Compute a character-level diff between two texts. Returns an array
// of { type, value } where type is 'equal' | 'removed' | 'added'.
// Backed by the `diff` npm package which uses Myers diff — handles
// edge cases (repeated tokens, large insertions/deletions in middle
// of common prefix/suffix) that hand-rolled LCS gets wrong.
export function diffTexts(a, b) {
    const ops = diffChars(a ?? '', b ?? '');
    // Normalize from the diff package's shape ({ value, added?, removed? })
    // to ours ({ type, value }) and coalesce adjacent same-type ops.
    const normalized = [];
    for (const op of ops) {
        const type = op.removed ? 'removed' : (op.added ? 'added' : 'equal');
        const last = normalized[normalized.length - 1];
        if (last && last.type === type) last.value += op.value;
        else normalized.push({ type, value: op.value });
    }
    return normalized;
}

// Render diff ops with ANSI color codes for terminal display.
export function renderDiff(ops, {
    removedColor = '\x1b[31m',
    addedColor = '\x1b[32m',
    reset = '\x1b[0m',
} = {}) {
    let out = '';
    for (const op of ops) {
        if (op.type === 'equal') out += op.value;
        else if (op.type === 'removed') out += `${removedColor}${op.value}${reset}`;
        else if (op.type === 'added') out += `${addedColor}${op.value}${reset}`;
    }
    return out;
}

// Align original-text blocks to sanitized-text blocks given Claude's
// segments output. Returns an array of { original, sanitized, blockDiff }
// ready for the polish UI's left pane. Returns null if segments don't
// reconstruct the sanitized buffer (caller falls back).
export function alignBlocks(originalText, sanitizedText, segmentsText) {
    const sanitizedBlocks = splitByMarkers(segmentsText);
    if (sanitizedBlocks.length === 0) return null;

    // Sanity check: segments concatenated should match sanitized
    // buffer modulo whitespace tolerance.
    const reconstructed = stitchBlocks(sanitizedBlocks).replace(/\s+/g, ' ').trim();
    const reference = sanitizedText.replace(/\s+/g, ' ').trim();
    if (reconstructed !== reference) {
        return null;
    }

    const pairs = [];
    let sanitizedCursor = 0;
    const fullDiff = diffTexts(originalText, sanitizedText);

    for (const sanBlock of sanitizedBlocks) {
        const idx = sanitizedText.indexOf(sanBlock, sanitizedCursor);
        if (idx === -1) return null;
        const sanStart = idx;
        const sanEnd = idx + sanBlock.length;
        sanitizedCursor = sanEnd;

        const origRange = mapSanitizedRangeToOriginal(fullDiff, sanStart, sanEnd);
        const originalBlock = originalText.slice(origRange.start, origRange.end);

        pairs.push({
            original: originalBlock,
            sanitized: sanBlock,
            blockDiff: diffTexts(originalBlock, sanBlock),
        });
    }
    return pairs;
}

// Walk a diff between original and sanitized, returning the range in
// original text that corresponds to the given sanitized range.
// For equal ops, interpolates within the op when sanStart/sanEnd fall
// inside it. For non-equal ops, snaps to the op's boundaries.
function mapSanitizedRangeToOriginal(diffOps, sanStart, sanEnd) {
    let origPos = 0;
    let sanPos = 0;
    let origStart = null, origEnd = null;

    for (const op of diffOps) {
        const len = op.value.length;
        const opSanStart = sanPos;
        const opSanEnd = sanPos + (op.type === 'removed' ? 0 : len);
        const opOrigStart = origPos;
        const opOrigEnd = origPos + (op.type === 'added' ? 0 : len);

        // Find origStart: the first position in original corresponding
        // to sanStart. If sanStart falls inside an equal op, interpolate
        // by the offset within the op. For non-equal ops, snap to start.
        if (origStart === null && opSanEnd > sanStart) {
            if (op.type === 'equal') {
                const offsetInOp = sanStart - opSanStart;
                origStart = opOrigStart + Math.max(0, offsetInOp);
            } else {
                origStart = opOrigStart;
            }
        }

        // Find origEnd: the last position in original corresponding to
        // sanEnd. Same interpolation logic.
        if (opSanEnd >= sanEnd && origEnd === null) {
            if (op.type === 'equal') {
                const offsetInOp = sanEnd - opSanStart;
                origEnd = opOrigStart + Math.min(len, Math.max(0, offsetInOp));
            } else {
                origEnd = opOrigEnd;
            }
        }

        if (op.type === 'equal') { origPos += len; sanPos += len; }
        else if (op.type === 'removed') { origPos += len; }
        else if (op.type === 'added') { sanPos += len; }
    }
    return {
        start: origStart ?? 0,
        end: origEnd ?? origPos,
    };
}
