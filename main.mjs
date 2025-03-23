#!/usr/bin/env node

import readline from 'readline';
import clipboardy from 'clipboardy';

// Conversion table as a Map
const conversionTable = new Map([
    [/[\uAC00-\uD7AF]/g, (match) => String.fromCodePoint(0x10C80 + (match.charCodeAt(0) % (0x10CB2 - 0x10C80))) + '\u2590'],
    [/[\u3130-\u318F\u1100-\u11FF]/g, '\uFE57'],
    [/[()]/g, '{par}'],
    [/-/g, '\u2014'],
    [/\.\.\./g, '{elp}'],
    [/⋯/g, '{elpC}'],
    [/\u2661/g, '{hrt}'],
    [/\"/g, '{quo}'],
    [/,/g, '{com}'],
    [/!/g, '{exc}'],
    [/\?/g, '{que}'],
    [/\./g, '{per}']
    ]);

function replacePerm(text) {
    text = text.replace(/hh/g, '\u2661').replace(/-/g, '\u2014').replace(/\.\.\./g, '⋯');
    return text;
}

function replaceText(text) {
    text = replacePerm(text);
    return Array.from(conversionTable).reduce((acc, [regex, replacement]) => acc.replace(regex, replacement), text);
}

function calculateTotalChars(text) {
    const hangulRegex = /[\u3130-\u318F\u1100-\u11FF\uAC00-\uD7AF]/g;
    const obfuscatedHangulRegex = /[\uAC00-\uD7AF]/g;
    
    const hangulCount = ((text.match(hangulRegex) || []).length);
    const obfuscatedHangulCount = ((text.match(obfuscatedHangulRegex) || []).length);
    
    return text.length + hangulCount - obfuscatedHangulCount;
}

// Setup readline interface
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

// Original and obfuscated text storage
let originalText = '';
let obfuscatedText = '';

updateDisplay();

console.log("Start typing (press 'Ctrl+C' to quit, ':copy' / ':cut' to copy original text):");

function updateDisplay() {
    console.clear();
    console.log(`Cipher:\n${obfuscatedText}`);
    console.log(`Total Char: ${calculateTotalChars(originalText)}`);
}

process.stdin.on('keypress', (str, key) => {
    if (key.sequence === '\u0003') {
        process.exit(); // Exit on Ctrl+C
    } else if (key.name === 'return') {
        originalText += '\n';
        obfuscatedText += '\n';
    } else if (key.name === 'backspace') {
        // Handle backspace
        originalText = originalText.slice(0, -1);
        obfuscatedText = replaceText(originalText);
    } else {
        originalText += str;
        obfuscatedText = replaceText(originalText);
    }

    // Handle special commands
    if (originalText.endsWith(':copy\n')) {
        clipboardy.writeSync(replacePerm(originalText.replace(':copy\n', '')));
        originalText = originalText.replace(':copy\n', '');
        obfuscatedText = replaceText(originalText);
        console.log("Original text copied to clipboard.");
    } else if (originalText.endsWith(':cut\n')) {
        clipboardy.writeSync(replacePerm(originalText.replace(':cut\n', '')));
        originalText = '';
        obfuscatedText = '';
        console.log("Original text cut to clipboard");
    }

    const totalChars = calculateTotalChars(originalText);
    console.clear();
    console.log(`Obfuscated Text:\n${obfuscatedText}`);
    console.log(`Total Characters: ${totalChars}`);

    updateDisplay();
});

process.stdin.on('error', (err) => {
    console.error(err);
    process.exit(1);
});

