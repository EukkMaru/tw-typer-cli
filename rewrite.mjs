#!/usr/bin/env node
// AI-assisted rewrite workflow built on top of main.mjs's typer.
// State machine: drafting -> sanitizing -> awaiting -> reviewing -> polishing -> done.
//
// Usage: node rewrite.mjs [main.mjs flags] [--rp]
//   --rp    use general-RP prompt (prompt-rp.dat) instead of ERP (prompt.dat)
//
// Required env: ANTHROPIC_API_KEY (or .env file with dotenv)

import 'dotenv/config';
import readline from 'readline';
import clipboardy from 'clipboardy';
import { fileURLToPath } from 'url';
import fs, { realpathSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import stringWidth from 'string-width';

import {
    createConfig,
    parseArgs,
    replacePerm,
    renderObfuscated,
    tweetWeight,
    counterLine,
    ANSI_DIM,
    ANSI_RESET,
    ANSI_ALT,
    CURSOR_MARK,
    HELP_TEXT,
} from './main.mjs';

import {
    loadSystemPrompt,
    parseResponse,
    isRefusal,
    appendPair,
    splitByMarkers,
    stitchBlocks,
    normalizeStructure,
    alignBlocks,
    renderDiff,
    diffTexts,
} from './util.mjs';

// ============================================================
// Constants
// ============================================================

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 4096;
const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_CYAN = '\x1b[36m';

const STATES = {
    DRAFTING: 'drafting',
    SANITIZING: 'sanitizing',
    AWAITING: 'awaiting',
    REVIEWING: 'reviewing',
    POLISHING: 'polishing',
};

// ============================================================
// Argument handling
// ============================================================

function parseRewriteArgs(args) {
    const isRp = args.includes('--rp');
    const isLight = args.includes('--light');
    const filtered = args.filter(a => a !== '--rp' && a !== '--light');
    const flags = parseArgs(filtered);
    return { flags, isRp, isLight };
}

// ============================================================
// State container — holds all mutable workflow state.
// ============================================================

function createState(pairsPath = '') {
    return {
        phase: STATES.DRAFTING,
        // Buffer being typed into (drafting/sanitizing).
        buffer: '',
        cursor: 0,
        revealing: false,
        // Locked at :submit.
        original: null,
        // Locked at :send.
        sanitized: null,
        // Set after API returns.
        rewriteRaw: null,
        parsed: null,
        // Polish UI state.
        blocks: null,        // [{ original, sanitized, blockDiff, edited }]
        rewriteSeparators: [], // captured at split for accurate stitching
        activeBlock: 0,
        editingBlock: false,
        editCursor: 0,       // cursor offset within active block when editing
        statusLine: '',      // ephemeral message shown bottom of screen
        pairsPath,           // mode-specific pairs file (set at startup)
    };
}

// ============================================================
// Drawing — one function per phase.
// ============================================================

function clearScreen() {
    console.clear();
}

function drawDrafting(state, config) {
    clearScreen();
    console.log(`${ANSI_DIM}[drafting — type freely, :submit to advance]${ANSI_RESET}`);
    console.log();
    console.log(renderObfuscated(state.buffer, state.cursor, config, state.revealing));
    console.log(counterLine(tweetWeight(state.buffer, config)));
    if (state.statusLine) console.log(`${ANSI_DIM}${state.statusLine}${ANSI_RESET}`);
}

function drawSanitizing(state, config) {
    clearScreen();
    console.log(`${ANSI_DIM}[sanitizing — clean copy of original, :send to API, :abandon to reset, :back to drafting]${ANSI_RESET}`);
    console.log();
    console.log(renderObfuscated(state.buffer, state.cursor, config, state.revealing));
    console.log(counterLine(tweetWeight(state.buffer, config)));
    if (state.statusLine) console.log(`${ANSI_DIM}${state.statusLine}${ANSI_RESET}`);
}

function drawAwaiting(state) {
    clearScreen();
    console.log(`${ANSI_CYAN}[awaiting — API call in flight...]${ANSI_RESET}`);
    console.log();
    console.log(`${ANSI_DIM}sanitized input:${ANSI_RESET}`);
    console.log(state.sanitized);
}

function drawReviewing(state) {
    clearScreen();
    console.log(`${ANSI_DIM}[reviewing — k=keep+advance, f=favorite+advance, :abandon to reset]${ANSI_RESET}`);
    console.log();
    if (state.parsed.analysis) {
        console.log(`${ANSI_DIM}analysis:${ANSI_RESET} ${state.parsed.analysis}`);
        console.log();
    }
    if (isRefusal(state.parsed)) {
        console.log(`${ANSI_RED}REFUSAL:${ANSI_RESET}`);
        console.log(state.parsed.refusal);
        console.log();
        console.log(`${ANSI_DIM}revise sanitized input and resend (:abandon and rewrite the sanitization).${ANSI_RESET}`);
    } else {
        console.log(`${ANSI_DIM}rewrite:${ANSI_RESET}`);
        console.log(state.parsed.rewrite);
    }
    if (state.statusLine) console.log(`\n${ANSI_DIM}${state.statusLine}${ANSI_RESET}`);
}

function drawPolishing(state) {
    clearScreen();
    console.log(`${ANSI_DIM}[polishing — Tab=switch block, e=edit, a=abandon, c=cut+ship]${ANSI_RESET}`);
    console.log();
    if (!state.blocks || state.blocks.length === 0) {
        console.log(`${ANSI_RED}no blocks to display${ANSI_RESET}`);
        return;
    }
    // Fixed total width tuned for Korean prose: ~78 cols of monospace,
    // halved per pane minus the divider. Korean wide-chars are 2 cells
    // each so each pane fits ~17 Korean chars or ~36 ASCII.
    const TOTAL_WIDTH = 78;
    const colWidth = Math.floor((TOTAL_WIDTH - 5) / 2);
    // Iteration order: when editing, render non-active blocks first
    // and the active block last. This puts the active block at the
    // bottom of the output so the terminal's natural scroll behavior
    // keeps it visible regardless of total block count or content
    // length. When not editing, use natural document order.
    const indexOrder = state.editingBlock
        ? [
            ...state.blocks.map((_, i) => i).filter(i => i !== state.activeBlock),
            state.activeBlock,
        ]
        : state.blocks.map((_, i) => i);

    for (const i of indexOrder) {
        const block = state.blocks[i];
        const isActive = i === state.activeBlock;
        const marker = isActive ? `${ANSI_ALT}>${ANSI_RESET}` : ' ';
        const leftPane = renderDiff(block.blockDiff, { removedColor: ANSI_RED, addedColor: ANSI_GREEN, reset: ANSI_RESET });
        let rightPane;
        if (isActive && state.editingBlock) {
            // Render cursor at editCursor position within the block.
            const before = block.edited.slice(0, state.editCursor);
            const after = block.edited.slice(state.editCursor);
            rightPane = `${ANSI_CYAN}${before}${CURSOR_MARK}${ANSI_CYAN}${after}${ANSI_RESET}`;
        } else {
            rightPane = block.edited;
        }
        console.log(`${marker} block ${i + 1}/${state.blocks.length}`);
        printTwoColumn(leftPane, rightPane, colWidth);
        console.log();
    }
    if (state.editingBlock) {
        console.log(`${ANSI_DIM}editing block ${state.activeBlock + 1} — arrows/home/end navigate, Shift+Enter for newline, Esc/Enter to finish${ANSI_RESET}`);
    }
    if (state.statusLine) console.log(`${ANSI_DIM}${state.statusLine}${ANSI_RESET}`);
}

// Side-by-side rendering with line wrapping. Strips ANSI for width
// calculation but preserves it in output. Resets explicitly before
// the divider and at end of right content to prevent color bleed
// across wrap boundaries.
function printTwoColumn(left, right, colWidth) {
    const leftLines = wrapAnsi(left, colWidth);
    const rightLines = wrapAnsi(right, colWidth);
    const rows = Math.max(leftLines.length, rightLines.length);
    for (let r = 0; r < rows; r++) {
        const l = leftLines[r] || '';
        const ri = rightLines[r] || '';
        const lPad = padAnsi(l, colWidth);
        // Explicit ANSI_RESET before the divider closes any unclosed
        // color from the left pane. Same after the right content.
        console.log(`  ${lPad}${ANSI_RESET}  │  ${ri}${ANSI_RESET}`);
    }
}

function stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// Display width — Korean Hangul and other wide chars take 2 cells.
// Uses string-width which handles ANSI internally.
function visibleWidth(s) {
    return stringWidth(s);
}

// Wrap text to max display width per line. Tracks per-character display
// width so Korean text wraps at the right column. Preserves ANSI escapes
// (they have width 0) without breaking them.
function wrapAnsi(text, width) {
    if (!text) return [''];
    const lines = [];
    for (const para of text.split('\n')) {
        if (visibleWidth(stripAnsi(para)) <= width) {
            lines.push(para);
            continue;
        }
        let cur = '';
        let curWidth = 0;
        let i = 0;
        const chars = [...para]; // proper unicode iteration (handles surrogate pairs)
        while (i < chars.length) {
            const ch = chars[i];
            if (ch === '\x1b') {
                // ANSI escape: collect through 'm', no width contribution.
                let escEnd = i;
                while (escEnd < chars.length && chars[escEnd] !== 'm') escEnd++;
                cur += chars.slice(i, escEnd + 1).join('');
                i = escEnd + 1;
                continue;
            }
            const chWidth = visibleWidth(ch);
            if (curWidth + chWidth > width) {
                lines.push(cur);
                cur = '';
                curWidth = 0;
            }
            cur += ch;
            curWidth += chWidth;
            i++;
        }
        if (cur) lines.push(cur);
    }
    return lines;
}

function padAnsi(s, width) {
    const w = visibleWidth(stripAnsi(s));
    if (w >= width) return s;
    return s + ' '.repeat(width - w);
}

// ============================================================
// API call
// ============================================================

async function callClaude(client, systemPrompt, sanitized) {
    const wrapped = `<draft>\n${sanitized}\n</draft>\n\nPolish this draft per your instructions. Output only the structured editorial response. Do not respond as a character.`;
    const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: wrapped }],
    });
    const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    return { text, response };
}

// ============================================================
// State transitions
// ============================================================

function transitionToSanitizing(state) {
    state.original = state.buffer;
    state.sanitized = null;
    state.phase = STATES.SANITIZING;
    state.cursor = state.buffer.length;
    state.statusLine = 'sanitize the explicit beats; :send when ready';
}

function transitionToDrafting(state) {
    state.phase = STATES.DRAFTING;
    state.buffer = state.original ?? '';
    state.cursor = state.buffer.length;
    state.original = null;
    state.sanitized = null;
    state.rewriteRaw = null;
    state.parsed = null;
    state.blocks = null;
    state.statusLine = 'returned to drafting';
}

function abandon(state) {
    // Reset clean-copy phase but keep original buffer intact.
    state.phase = STATES.SANITIZING;
    state.buffer = state.original;
    state.cursor = state.buffer.length;
    state.sanitized = null;
    state.rewriteRaw = null;
    state.parsed = null;
    state.blocks = null;
    state.statusLine = 'abandoned; original intact, sanitization reset';
}

function transitionToReviewing(state, parsed, rawText) {
    state.phase = STATES.REVIEWING;
    state.parsed = parsed;
    state.rewriteRaw = rawText;
    state.statusLine = '';
}

function transitionToPolishing(state, tier) {
    // Save the pair before advancing.
    try {
        appendPair(state.pairsPath, {
            input: state.sanitized,
            rewrite: state.parsed.rewrite,
            tier,
            timestamp: Date.now(),
        });
    } catch (err) {
        // Non-fatal — log and continue.
        state.statusLine = `(pair save failed: ${err.message})`;
    }

    // Build polish blocks.
    const aligned = alignBlocks(state.original, state.sanitized, state.parsed.segments);
    const rewriteBlocks = splitByMarkers(state.parsed.rewrite);

    if (aligned) {
        state.blocks = aligned.map((pair, i) => ({
            original: pair.original,
            sanitized: pair.sanitized,
            blockDiff: pair.blockDiff,
            edited: rewriteBlocks[i] ?? '',
        }));
        if (rewriteBlocks.length > aligned.length) {
            for (let i = aligned.length; i < rewriteBlocks.length; i++) {
                state.blocks.push({
                    original: '',
                    sanitized: '',
                    blockDiff: [],
                    edited: rewriteBlocks[i],
                });
            }
        }
    } else {
        state.blocks = [{
            original: state.original,
            sanitized: state.sanitized,
            blockDiff: diffTexts(state.original, state.sanitized),
            edited: state.parsed.rewrite,
        }];
        state.statusLine = '(alignment fell back to whole-text)';
    }

    state.activeBlock = 0;
    state.editingBlock = false;
    state.phase = STATES.POLISHING;
}

// LLMs reach for ` — ` (space, em-dash, space) constantly; humans don't,
// so it's a strong tell. Replace with ellipsis+space, picking the
// ellipsis variant that matches the active flags the same way
// replacePerm picks one for `...` substitution.
function deAiifyEmDashes(text, config) {
    let ellipsis;
    if (!config.midline) {
        ellipsis = '⋯';
    } else if (config.saveSpace) {
        ellipsis = '…';
    } else {
        ellipsis = '...';
    }
    // Strict pattern: ASCII space (or tab), em-dash, ASCII space (or tab).
    // Newlines are excluded — a structural em-dash on its own line is
    // legitimate writing, not the LLM tic.
    return text.replace(/[ \t]—[ \t]/g, `${ellipsis} `);
}

function normalizeEllipsis(text, config) {
    let target;
    if (!config.midline) target = '⋯';
    else if (config.saveSpace) target = '…';
    else target = '...';
    // Normalize all variants to the target.
    return text
        .replace(/⋯/g, target)
        .replace(/…/g, target)
        .replace(/\.\.\./g, target);
}

function shipToClipboard(state, config) {
    // Apply substitutions (hh→♡, -→—, ...→⋯) per block, then stitch
    // and normalize. Same replacePerm rules as drafting/sanitizing.
    const blocks = state.blocks.map(b => replacePerm(b.edited, config));
    const stitched = stitchBlocks(blocks);
    // Strip the LLM em-dash tic before structural normalization, so the
    // output stops looking machine-generated at a glance.
    const desmoothed = deAiifyEmDashes(stitched, config);
    const normalized = normalizeEllipsis(normalizeStructure(desmoothed), config);
    clipboardy.writeSync(normalized);
    // Always cut+reset: ship to clipboard and return to drafting.
    // Preserve the mode-specific pairs path across the reset so the
    // next message saves to the right file.
    const pairsPath = state.pairsPath;
    Object.assign(state, createState(pairsPath));
    state.statusLine = '✂ shipped to clipboard, ready to draft';
}

// ============================================================
// Main loop
// ============================================================

function isRunDirectly() {
    if (!process.argv[1]) return false;
    try {
        const argvPath = realpathSync(process.argv[1]);
        const modulePath = realpathSync(fileURLToPath(import.meta.url));
        return argvPath === modulePath;
    } catch {
        return false;
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('-h') || args.includes('--help')) {
        console.log(HELP_TEXT);
        console.log('\nrewrite.mjs additional flags:');
        console.log('  --rp                   use general-RP prompt instead of ERP');
        console.log('  --light                edits are less aggressive');
        process.exit(0);
    }

    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('ANTHROPIC_API_KEY not set (use .env or shell env).');
        process.exit(1);
    }

    let parsedArgs;
    try {
        parsedArgs = parseRewriteArgs(args);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }

    const config = createConfig(parsedArgs.flags);
    const promptPath = (() => {
        if (parsedArgs.isRp && parsedArgs.isLight) return 'prompt-rp-light.dat';
        if (parsedArgs.isRp) return 'prompt-rp.dat';
        if (parsedArgs.isLight) return 'prompt-light.dat';
        return 'prompt.dat';
    })();
    // Pairs file is split by RP vs ERP (different writing modes have
    // different example needs). Light/heavy share the same pool within
    // a mode since the structural patterns are the same — only the
    // expansion intensity differs, which the prompt itself controls.
    const pairsPath = parsedArgs.isRp ? 'pairs-rp.dat' : 'pairs.dat';
    let systemPrompt;
    try {
        systemPrompt = loadSystemPrompt(promptPath, pairsPath);
    } catch (err) {
        console.error(`Failed to load system prompt from ${promptPath}: ${err.message}`);
        process.exit(1);
    }

    const client = new Anthropic();
    const state = createState(pairsPath);

    function redraw() {
        switch (state.phase) {
            case STATES.DRAFTING: drawDrafting(state, config); break;
            case STATES.SANITIZING: drawSanitizing(state, config); break;
            case STATES.AWAITING: drawAwaiting(state); break;
            case STATES.REVIEWING: drawReviewing(state); break;
            case STATES.POLISHING: drawPolishing(state); break;
        }
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    redraw();

    process.stdin.on('keypress', async (str, key) => {
        if (key && key.ctrl && key.name === 'c') process.exit();

        // Phase-specific input handling.
        if (state.phase === STATES.DRAFTING || state.phase === STATES.SANITIZING) {
            handleTextInput(state, str, key, config);
            checkCommands(state, config);
            // Async API call from sanitizing phase.
            if (state.phase === STATES.AWAITING) {
                redraw();
                try {
                    const { text } = await callClaude(client, systemPrompt, state.sanitized);
                    // Save raw response for debugging.
                    try {
                        fs.writeFileSync('last-response.txt', text);
                    } catch { /* non-fatal */ }
                    const parsed = parseResponse(text);
                    transitionToReviewing(state, parsed, text);
                } catch (err) {
                    state.phase = STATES.SANITIZING;
                    state.buffer = state.sanitized;
                    state.cursor = state.buffer.length;
                    state.sanitized = null;
                    state.statusLine = `API error: ${err.message}`;
                }
            }
        } else if (state.phase === STATES.REVIEWING) {
            handleReviewInput(state, str, key);
        } else if (state.phase === STATES.POLISHING) {
            handlePolishInput(state, str, key, config);
        }
        redraw();
    });

    process.stdin.on('error', err => {
        console.error(err);
        process.exit(1);
    });
}

function handleTextInput(state, str, key, config) {
    if (key.name === 'return') {
        state.buffer = state.buffer.slice(0, state.cursor) + '\n' + state.buffer.slice(state.cursor);
        state.cursor++;
    } else if (key.name === 'backspace') {
        if (state.cursor > 0) {
            state.buffer = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
            state.cursor--;
        }
    } else if (key.name === 'left' && state.cursor > 0) state.cursor--;
    else if (key.name === 'right' && state.cursor < state.buffer.length) state.cursor++;
    else if (key.name === 'home') state.cursor = 0;
    else if (key.name === 'end') state.cursor = state.buffer.length;
    else if (key.name === 'tab') state.revealing = !state.revealing;
    else if (typeof str === 'string' && !key.ctrl) {
        state.buffer = state.buffer.slice(0, state.cursor) + str + state.buffer.slice(state.cursor);
        state.cursor += str.length;
    }
}

function checkCommands(state, config) {
    const trimmedBuf = state.buffer;
    if (state.phase === STATES.DRAFTING && trimmedBuf.endsWith(':submit\n')) {
        state.buffer = trimmedBuf.replace(/:submit\n$/, '');
        state.cursor = Math.min(state.cursor, state.buffer.length);
        // Apply replacePerm before locking original (matches typer ship behavior).
        state.buffer = replacePerm(state.buffer, config);
        state.cursor = state.buffer.length;
        transitionToSanitizing(state);
    } else if (state.phase === STATES.SANITIZING && trimmedBuf.endsWith(':send\n')) {
        state.buffer = trimmedBuf.replace(/:send\n$/, '');
        state.sanitized = replacePerm(state.buffer, config);
        state.phase = STATES.AWAITING;
    } else if (state.phase === STATES.SANITIZING && trimmedBuf.endsWith(':abandon\n')) {
        state.buffer = trimmedBuf.replace(/:abandon\n$/, '');
        abandon(state);
    } else if (state.phase === STATES.SANITIZING && trimmedBuf.endsWith(':back\n')) {
        state.buffer = trimmedBuf.replace(/:back\n$/, '');
        transitionToDrafting(state);
    }
}

function handleReviewInput(state, str, key) {
    if (isRefusal(state.parsed)) {
        // Only :abandon valid here.
        if (str === 'a') {
            abandon(state);
        }
        return;
    }
    if (str === 'k') {
        transitionToPolishing(state, 'keep');
    } else if (str === 'f') {
        transitionToPolishing(state, 'favorite');
    } else if (str === 'a') {
        abandon(state);
    }
}

function handlePolishInput(state, str, key, config) {
    if (state.editingBlock) {
        // Inline editing of the active block. Cursor-aware:
        // arrows move, home/end jump, backspace deletes before cursor,
        // regular keys insert at cursor and apply replacePerm so
        // hh→♡, -→—, ...→⋯ substitutions still work in edits.
        // Shift+Enter (or Alt+Enter, or Ctrl+J as fallbacks for
        // terminals that don't forward Shift to readline) inserts a
        // newline. Plain Enter exits edit mode.
        const block = state.blocks[state.activeBlock];
        const wantsLinebreak = (key.name === 'return' && (key.shift || key.meta))
            || (key.ctrl && key.name === 'j');
        if (key.name === 'escape') {
            state.editingBlock = false;
        } else if (wantsLinebreak) {
            block.edited = block.edited.slice(0, state.editCursor)
                + '\n'
                + block.edited.slice(state.editCursor);
            state.editCursor++;
        } else if (key.name === 'return') {
            // Plain Enter — exit edit mode.
            state.editingBlock = false;
        } else if (key.name === 'left') {
            if (state.editCursor > 0) state.editCursor--;
        } else if (key.name === 'right') {
            if (state.editCursor < block.edited.length) state.editCursor++;
        } else if (key.name === 'home') {
            state.editCursor = 0;
        } else if (key.name === 'end') {
            state.editCursor = block.edited.length;
        } else if (key.name === 'backspace') {
            if (state.editCursor > 0) {
                block.edited = block.edited.slice(0, state.editCursor - 1)
                    + block.edited.slice(state.editCursor);
                state.editCursor--;
            }
        } else if (typeof str === 'string' && !key.ctrl) {
            // Insert at cursor, then apply replacePerm to the whole text
            // so substitutions take effect on the surrounding context
            // (e.g. typing the second 'h' in 'hh' triggers the ♡ swap).
            const before = block.edited.slice(0, state.editCursor);
            const after = block.edited.slice(state.editCursor);
            const inserted = before + str + after;
            const transformed = replacePerm(inserted, config);
            // Cursor: position equivalent to (before+str) under replacePerm.
            const prefixTransformed = replacePerm(before + str, config);
            block.edited = transformed;
            state.editCursor = prefixTransformed.length;
        }
        return;
    }
    if (key.name === 'tab') {
        state.activeBlock = (state.activeBlock + 1) % state.blocks.length;
    } else if (str === 'e') {
        state.editingBlock = true;
        // Initialize cursor to end of block on entry.
        state.editCursor = state.blocks[state.activeBlock].edited.length;
    } else if (str === 'a') {
        abandon(state);
    } else if (str === 'c') {
        shipToClipboard(state, config);
    }
}

if (isRunDirectly()) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
