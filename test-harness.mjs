#!/usr/bin/env node
// Test harness for prompt iteration. No obfuscation on input/output;
// reads the encoded prompt.dat through util.mjs so we test the real
// loading path. One-shot: type input, :submit, see response, exit.
//
// Usage: ANTHROPIC_API_KEY=sk-... node test-harness.mjs

import 'dotenv/config';
import readline from 'readline';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadSystemPrompt, parseResponse, isRefusal } from './util.mjs';

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 4096;
const RAW_RESPONSE_PATH = 'last-response.txt';

if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY environment variable not set.');
    process.exit(1);
}

const client = new Anthropic();

// Barebones editor: type characters, backspace deletes, return inserts
// newline, :submit on its own line ends input. No cursor movement, no
// obfuscation, no clipboard. Echoes input as you type so you can see it.
function readInput() {
    return new Promise((resolve) => {
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();

        let buffer = '';

        const render = () => {
            console.clear();
            console.log('--- input (type freely, ":submit" on its own line to send, Ctrl+C to exit) ---\n');
            process.stdout.write(buffer);
        };

        render();

        const onKeypress = (str, key) => {
            if (key && key.ctrl && key.name === 'c') {
                cleanup();
                process.exit(0);
            } else if (key && key.name === 'return') {
                buffer += '\n';
                if (buffer.endsWith('\n:submit\n') || buffer === ':submit\n') {
                    const text = buffer.replace(/:submit\n$/, '').replace(/\n$/, '');
                    cleanup();
                    resolve(text);
                    return;
                }
                render();
            } else if (key && key.name === 'backspace') {
                buffer = buffer.slice(0, -1);
                render();
            } else if (typeof str === 'string' && !key.ctrl) {
                buffer += str;
                render();
            }
        };

        const cleanup = () => {
            process.stdin.removeListener('keypress', onKeypress);
            process.stdin.setRawMode(false);
            process.stdin.pause();
        };

        process.stdin.on('keypress', onKeypress);
    });
}

function printSection(title, body) {
    const divider = '─'.repeat(60);
    console.log(`\n${divider}`);
    console.log(title);
    console.log(divider);
    console.log(body || '(empty)');
}

async function main() {
    let systemPrompt;
    try {
        systemPrompt = loadSystemPrompt();
    } catch (err) {
        console.error(`Failed to load system prompt: ${err.message}`);
        console.error('Make sure prompt.dat exists in the current directory.');
        process.exit(1);
    }

    const userInput = await readInput();

    if (!userInput.trim()) {
        console.log('\n(empty input, exiting)');
        process.exit(0);
    }

    console.log('\n--- sending to API... ---\n');

    let response;
    try {
        const wrappedInput = `<draft>\n${userInput}\n</draft>\n\nPolish this draft per your instructions. Output only the structured editorial response. Do not respond as a character.`;

        response = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: systemPrompt,
            messages: [{ role: 'user', content: wrappedInput }],
        });
    } catch (err) {
        console.error(`API error: ${err.message}`);
        process.exit(1);
    }

    const rawText = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');

    fs.writeFileSync(RAW_RESPONSE_PATH, rawText);
    console.log(`Raw response saved to ${RAW_RESPONSE_PATH}`);

    const parsed = parseResponse(rawText);

    printSection('ANALYSIS', parsed.analysis);
    printSection('REFUSAL', parsed.refusal);
    printSection('REWRITE', parsed.rewrite);
    printSection('SEGMENTS', parsed.segments);

    console.log('\n--- meta ---');
    console.log(`refusal path: ${isRefusal(parsed)}`);
    console.log(`input length: ${userInput.length} chars`);
    console.log(`rewrite length: ${parsed.rewrite ? parsed.rewrite.length : 0} chars`);
    if (parsed.rewrite && userInput.length > 0) {
        const ratio = (parsed.rewrite.length / userInput.length).toFixed(2);
        console.log(`expansion ratio: ${ratio}x`);
    }
    console.log(`stop reason: ${response.stop_reason}`);
    console.log(`tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
