#!/usr/bin/env node

import readline from 'readline';
import clipboardy from 'clipboardy';

const args = process.argv.slice(2);
let midlineFlag = false;
let warningFlag = false;
let saveSpaceFlag = false;
let rawFlag = false;

const flags = new Set(args);

midlineFlag = flags.has('--no-midline') || flags.has('-n');
warningFlag = flags.has('--warning') || flags.has('-w');
saveSpaceFlag = flags.has('--save-space') || flags.has('-s');
rawFlag = flags.has('--raw') || flags.has('-r');

if (flags.has('-p') || flags.has('--profile')) {
    const pIndex = args.indexOf('-p');
    const longIndex = args.indexOf('--profile');

    const index = pIndex !== -1 ? pIndex : longIndex;
    let profilePreset = args[index + 1];

    switch (profilePreset) {
        case 'mara':
        case 'm':
        case 'charlotte':
        case 'c':
            midlineFlag = true;
            warningFlag = true;
            break;
        case 'lyrith':
        case 'l':
            midlineFlag = false;
            warningFlag = false;
            break;
        default:
            console.error("Unknown profile preset.");
            process.exit(1);
    }
}


// Conversion table as a Map
const conversionTable = new Map([
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
    [/\./g, '{per}']
    ]);

// Override quote replacement based on warningFlag
conversionTable.set(/"/g, warningFlag ? '{WARNING:Quotes}' : '{quo}');

function replacePerm(text) {
    text = text.replace(/hh/g, '♡').replace(/-/g, '—')
    text = midlineFlag ? text : text.replace(/\.\.\./g, '⋯');
    text = (midlineFlag && saveSpaceFlag) ? text.replace(/\.\.\./g, '…') : text; //this makes midline override save-space
    return text;
}

function replaceText(text) {
    text = replacePerm(text);
    return Array.from(conversionTable).reduce((acc, [regex, replacement]) => acc.replace(regex, replacement), text);
}

// Twitter weighted-length: most code points = 1, CJK / non-Latin / emoji = 2,
// URLs collapse to weight 23 regardless of actual length. Cap is 280.
const TWEET_LIMIT = 280;
const URL_WEIGHT = 23;
const URL_REGEX = /https?:\/\/\S+/g;

function codePointWeight(cp) {
    if (
        (cp >= 0x0000 && cp <= 0x10FF) ||
        (cp >= 0x2000 && cp <= 0x200D) ||
        (cp >= 0x2010 && cp <= 0x201F) ||
        (cp >= 0x2032 && cp <= 0x2037)
    ) return 1;
    return 2;
}

function rawWeight(text) {
    let w = 0;
    for (const ch of text) w += codePointWeight(ch.codePointAt(0));
    return w;
}

// ANSI: alt band uses yellow as a calm distinct hue; overflow body uses dim
// (preserves the main text color, just attenuated — not glaring red).
const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[2m';
const ANSI_ALT = '\x1b[33m';
const COUNTER_BAND = 260;

// Walk original text once with replacePerm-equivalent rules applied inline,
// so the count matches what actually ships on the clipboard. Returns total
// weight + every codepoint index where weight first crosses k*TWEET_LIMIT.
// Multi-char units (URL, hh, ...) are atomic — boundary never lands inside.
function findBoundaries(text) {
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
            added = (midlineFlag && !saveSpaceFlag) ? 3 : 2;
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

function tweetWeight(text) {
    return findBoundaries(text).weight;
}

function counterLine(weight) {
    const band = Math.floor(weight / COUNTER_BAND);
    const color = band % 2 === 1 ? ANSI_ALT : '';
    return `${color}${weight}/${TWEET_LIMIT}${ANSI_RESET}`;
}

const CURSOR_MARK = '\x1b[7m_\x1b[27m'; // inverse-video underscore — stays visible inside dim segments

function renderObfuscated(text, cursorPos) {
    const transform = revealing ? replacePerm : replaceText;
    const { boundaries } = findBoundaries(text);
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

// Tab toggles reveal: deobfuscated view shows what :copy would put on the
// clipboard (replacePerm output). Tap Tab again to re-obfuscate.
let revealing = false;

// Setup readline interface
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

let originalText = '';
let cursorPos = 0;

updateDisplay();

function updateDisplay() {
    console.clear();
    const flagBits = [];
    if (midlineFlag) flagBits.push('m');
    if (warningFlag) flagBits.push('w');
    if (saveSpaceFlag) flagBits.push('s');
    if (rawFlag) flagBits.push('r');
    if (flagBits.length) console.log(`${ANSI_DIM}[${flagBits.join('')}]${ANSI_RESET}`);
    if (rawFlag) console.log(`\n${originalText}`);
    console.log(`\n${renderObfuscated(originalText, cursorPos)}`);
    console.log(counterLine(tweetWeight(originalText)));
}

process.stdin.on('keypress', (str, key) => {
    if (key.sequence === '') {
        process.exit(); // Exit on Ctrl+C
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

    // Handle special commands
    if (originalText.endsWith(':copy\n')) {
        clipboardy.writeSync(replacePerm(originalText.replace(':copy\n', '')));
        originalText = originalText.replace(':copy\n', '');
        cursorPos = Math.min(cursorPos, originalText.length);
        console.log(`${ANSI_DIM}✓${ANSI_RESET}`);
    } else if (originalText.endsWith(':cut\n')) {
        clipboardy.writeSync(replacePerm(originalText.replace(':cut\n', '')));
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
