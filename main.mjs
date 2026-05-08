#!/usr/bin/env node

import readline from 'readline';
import clipboardy from 'clipboardy';
import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';

// ============================================================
// Constants — exported for reuse in other entry points.
// ============================================================

export const TWEET_LIMIT = 280;
export const URL_WEIGHT = 23;
export const URL_REGEX = /https?:\/\/\S+/g;

export const ANSI_RESET = '\x1b[0m';
export const ANSI_DIM = '\x1b[2m';
export const ANSI_ALT = '\x1b[33m';
export const COUNTER_BAND = 260;

// inverse-video underscore — stays visible inside dim segments
export const CURSOR_MARK = '\x1b[7m_\x1b[27m';

// jamo (incomplete syllables) stays loud as red XX to surface typos at a glance
export const JAMO_HEX = '\x1b[31mXX\x1b[39m';

export const HELP_TEXT = `usage: tw-typer [flags]

  -n, --no-midline       keep '...' as-is (skip ellipsis collapse)
  -w, --warning          loud {WARNING:Quotes} on " — shoulder-surf tripwire
  -s, --save-space       with -n, render '...' as '…'
  -r, --raw              show raw text above the obfuscated view
  -d, --disguise <s>     heavy disguise; styles: hex
  -p, --profile <p>      preset bundle: mara|m, charlotte|c, lyrith|l
  -h, --help             show this and exit

keys: arrows / Home / End move cursor, Tab toggles reveal,
      :copy / :cut ship clean text to clipboard.`;

// ============================================================
// Config — replaces the old module-level flag variables.
// Pass an explicit config to every pure function below.
// ============================================================

// Build the obfuscation conversion table. The quote replacement is
// the only entry that depends on a flag (warning), so it's set last.
function buildConversionTable(warning) {
    const t = new Map([
        [/[가-힯]/g, (match) => String.fromCharCode(0x4DC0 + (match.charCodeAt(0) % (0x4DFF - 0x4DC0))) + '▐'],
        [/[㄰-㆏ᄀ-ᇿ]/g, '﹗'],
        [/[()]/g, '{par}'],
        [/-/g, '—'],
        [/\.\.\./g, '{elp}'],
        [/…/g, '{elpS}'],
        [/⋯/g, '{elpC}'],
        [/♡/g, '{hrt}'],
        [/,/g, '{com}'],
        [/!/g, '{exc}'],
        [/\?/g, '{que}'],
        [/\./g, '{per}'],
    ]);
    t.set(/"/g, warning ? '{WARNING:Quotes}' : '{quo}');
    return t;
}

// Create a frozen-ish config object. All pure functions take this as
// their last argument. Other entry points (e.g. rewrite.mjs) construct
// their own config and pass it through.
export function createConfig({
    midline = false,
    warning = false,
    saveSpace = false,
    raw = false,
    disguiseStyle = null,
} = {}) {
    return {
        midline,
        warning,
        saveSpace,
        raw,
        disguiseStyle,
        conversionTable: buildConversionTable(warning),
    };
}

// Parse CLI args into a flag dict. Throws on unknown disguise style or
// profile. Caller decides how to react (the runtime entry point below
// catches and prints to stderr).
export function parseArgs(args) {
    const flagSet = new Set(args);
    let midline = flagSet.has('--no-midline') || flagSet.has('-n');
    let warning = flagSet.has('--warning') || flagSet.has('-w');
    const saveSpace = flagSet.has('--save-space') || flagSet.has('-s');
    const raw = flagSet.has('--raw') || flagSet.has('-r');
    let disguiseStyle = null;

    if (flagSet.has('-d') || flagSet.has('--disguise')) {
        const dIndex = args.indexOf('-d');
        const longIndex = args.indexOf('--disguise');
        const index = dIndex !== -1 ? dIndex : longIndex;
        disguiseStyle = args[index + 1];
        if (disguiseStyle !== 'hex') {
            throw new Error('Unknown disguise style.');
        }
    }

    if (flagSet.has('-p') || flagSet.has('--profile')) {
        const pIndex = args.indexOf('-p');
        const longIndex = args.indexOf('--profile');
        const index = pIndex !== -1 ? pIndex : longIndex;
        const profilePreset = args[index + 1];
        switch (profilePreset) {
            case 'mara':
            case 'm':
            case 'charlotte':
            case 'c':
                midline = true;
                warning = true;
                break;
            case 'lyrith':
            case 'l':
                midline = false;
                warning = false;
                break;
            default:
                throw new Error('Unknown profile preset.');
        }
    }

    return { midline, warning, saveSpace, raw, disguiseStyle };
}

// ============================================================
// Pure transforms — exportable, no module state.
// ============================================================

// Permanent replacements that ship to the clipboard. Always applied
// regardless of obfuscation; they're the writer's voice tics.
export function replacePerm(text, config) {
    text = text.replace(/hh/g, '♡').replace(/-/g, '—');
    text = config.midline ? text : text.replace(/\.\.\./g, '⋯');
    text = (config.midline && config.saveSpace) ? text.replace(/\.\.\./g, '…') : text; // midline overrides save-space
    return text;
}

// Hex disguise: each codepoint -> 2-char XOR-fold of its bytes (256 buckets,
// fewer collisions than Yijing's 63). Same input -> same output, so repeated
// chars are still spottable. Newlines kept literal so layout survives.
export function hexEncode(text) {
    let out = '';
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp === 0x0A) { out += '\n'; continue; }
        if ((cp >= 0x1100 && cp <= 0x11FF) || (cp >= 0x3130 && cp <= 0x318F)) {
            out += JAMO_HEX;
            continue;
        }
        const folded = ((cp >> 16) & 0xFF) ^ ((cp >> 8) & 0xFF) ^ (cp & 0xFF);
        out += folded.toString(16).padStart(2, '0').toUpperCase();
    }
    return out;
}

// Full obfuscation pass: permanent replacements, then either hex or token
// substitution. Used for the on-screen rendering, not the clipboard.
export function replaceText(text, config) {
    text = replacePerm(text, config);
    if (config.disguiseStyle === 'hex') return hexEncode(text);
    return Array.from(config.conversionTable).reduce(
        (acc, [regex, replacement]) => acc.replace(regex, replacement),
        text,
    );
}

// Twitter weighted-length: most code points = 1, CJK / non-Latin / emoji = 2,
// URLs collapse to weight 23 regardless of actual length. Cap is 280.
export function codePointWeight(cp) {
    if (
        (cp >= 0x0000 && cp <= 0x10FF) ||
        (cp >= 0x2000 && cp <= 0x200D) ||
        (cp >= 0x2010 && cp <= 0x201F) ||
        (cp >= 0x2032 && cp <= 0x2037)
    ) return 1;
    return 2;
}

export function rawWeight(text) {
    let w = 0;
    for (const ch of text) w += codePointWeight(ch.codePointAt(0));
    return w;
}

// Walk original text once with replacePerm-equivalent rules applied inline,
// so the count matches what actually ships on the clipboard. Returns total
// weight + every codepoint index where weight first crosses k*TWEET_LIMIT.
// Multi-char units (URL, hh, ...) are atomic — boundary never lands inside.
export function findBoundaries(text, config) {
    URL_REGEX.lastIndex = 0;
    const urlSpans = [];
    let m;
    while ((m = URL_REGEX.exec(text)) !== null) {
        urlSpans.push([m.index, m.index + m[0].length]);
    }
    URL_REGEX.lastIndex = 0;

    const boundaries = [];
    let weight = 0;
    let i = 0;
    let urlIdx = 0;
    let nextCap = TWEET_LIMIT;

    while (i < text.length) {
        let consumed, added;
        if (urlIdx < urlSpans.length && i === urlSpans[urlIdx][0]) {
            consumed = urlSpans[urlIdx][1] - i;
            added = URL_WEIGHT;
            urlIdx++;
        } else if (text[i] === 'h' && text[i + 1] === 'h') {
            consumed = 2;
            added = 2;
        } else if (text[i] === '.' && text[i + 1] === '.' && text[i + 2] === '.') {
            consumed = 3;
            added = (config.midline && !config.saveSpace) ? 3 : 2;
        } else {
            const cp = text.codePointAt(i);
            consumed = cp > 0xFFFF ? 2 : 1;
            added = codePointWeight(cp);
        }
        while (weight + added > nextCap) {
            boundaries.push(i);
            nextCap += TWEET_LIMIT;
        }
        weight += added;
        i += consumed;
    }
    return { weight, boundaries };
}

export function tweetWeight(text, config) {
    return findBoundaries(text, config).weight;
}

// ANSI: alt band uses yellow as a calm distinct hue; overflow body uses dim
// (preserves the main text color, just attenuated — not glaring red).
export function counterLine(weight) {
    const band = Math.floor(weight / COUNTER_BAND);
    const color = band % 2 === 1 ? ANSI_ALT : '';
    return `${color}${weight}/${TWEET_LIMIT}${ANSI_RESET}`;
}

// Render the full obfuscated/revealed view with cursor mark and tweet-segment
// labels. `revealing` toggles between clipboard-equivalent (replacePerm) and
// obfuscated (replaceText) display.
export function renderObfuscated(text, cursorPos, config, revealing) {
    const transform = revealing
        ? (t) => replacePerm(t, config)
        : (t) => replaceText(t, config);
    const { boundaries } = findBoundaries(text, config);
    const segCount = boundaries.length + 1;
    const splits = [0, ...boundaries, text.length];
    let out = '';
    for (let s = 0; s < segCount; s++) {
        const segStart = splits[s];
        const segEnd = splits[s + 1];
        const seg = text.slice(segStart, segEnd);
        const inSeg =
            (cursorPos >= segStart && cursorPos < segEnd) ||
            (cursorPos === segEnd && s === segCount - 1);
        const segOut = inSeg
            ? transform(seg.slice(0, cursorPos - segStart)) + CURSOR_MARK + transform(seg.slice(cursorPos - segStart))
            : transform(seg);
        out += s === 0
            ? segOut
            : `${ANSI_DIM}[${s + 1}/${segCount}] ${segOut}${ANSI_RESET}`;
    }
    return out;
}

// ============================================================
// Runtime — the original interactive typer, now opt-in.
// Other entry points (rewrite.mjs) can either call runTyper()
// or build their own loop using the pure functions above.
// ============================================================

export function runTyper(config = createConfig()) {
    let originalText = '';
    let cursorPos = 0;
    let revealing = false;

    function updateDisplay() {
        console.clear();
        const flagBits = [];
        if (config.midline) flagBits.push('m');
        if (config.warning) flagBits.push('w');
        if (config.saveSpace) flagBits.push('s');
        if (config.raw) flagBits.push('r');
        if (config.disguiseStyle) flagBits.push('d');
        if (flagBits.length) console.log(`${ANSI_DIM}[${flagBits.join('')}]${ANSI_RESET}`);
        if (config.raw) console.log(`\n${originalText}`);
        console.log(`\n${renderObfuscated(originalText, cursorPos, config, revealing)}`);
        console.log(counterLine(tweetWeight(originalText, config)));
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    updateDisplay();

    process.stdin.on('keypress', (str, key) => {
        if (key && key.ctrl && key.name === 'c') {
            process.exit(); // Ctrl+C
        } else if (key.name === 'return') {
            originalText = originalText.slice(0, cursorPos) + '\n' + originalText.slice(cursorPos);
            cursorPos++;
        } else if (key.name === 'backspace') {
            if (cursorPos > 0) {
                originalText = originalText.slice(0, cursorPos - 1) + originalText.slice(cursorPos);
                cursorPos--;
            }
        } else if (key.name === 'left') {
            if (cursorPos > 0) cursorPos--;
        } else if (key.name === 'right') {
            if (cursorPos < originalText.length) cursorPos++;
        } else if (key.name === 'home') {
            cursorPos = 0;
        } else if (key.name === 'end') {
            cursorPos = originalText.length;
        } else if (key.name === 'up' || key.name === 'down') {
            // line navigation: not yet supported
        } else if (key.name === 'tab') {
            revealing = !revealing;
        } else if (typeof str === 'string') {
            originalText = originalText.slice(0, cursorPos) + str + originalText.slice(cursorPos);
            cursorPos += str.length;
        }

        // Tab toggles reveal: deobfuscated view shows what :copy would put on
        // the clipboard (replacePerm output). Tap Tab again to re-obfuscate.
        if (originalText.endsWith(':copy\n')) {
            clipboardy.writeSync(replacePerm(originalText.replace(':copy\n', ''), config));
            originalText = originalText.replace(':copy\n', '');
            cursorPos = Math.min(cursorPos, originalText.length);
            console.log(`${ANSI_DIM}✓${ANSI_RESET}`);
        } else if (originalText.endsWith(':cut\n')) {
            clipboardy.writeSync(replacePerm(originalText.replace(':cut\n', ''), config));
            originalText = '';
            cursorPos = 0;
            console.log(`${ANSI_DIM}✂${ANSI_RESET}`);
        }

        updateDisplay();
    });

    process.stdin.on('error', (err) => {
        console.error(err);
        process.exit(1);
    });
}

// ============================================================
// Entry point — only fires when this file is run directly,
// not when imported. Allows `import './main.mjs'` to be quiet.
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

if (isRunDirectly()) {
    const args = process.argv.slice(2);
    if (args.includes('-h') || args.includes('--help')) {
        console.log(HELP_TEXT);
        process.exit(0);
    }
    try {
        const flags = parseArgs(args);
        runTyper(createConfig(flags));
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}
