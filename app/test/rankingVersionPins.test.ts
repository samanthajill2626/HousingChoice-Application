// WP1 B2a PR32 / R2F3: the bytes the model sees are tied to the versions
// every match records. Each pin hashes text EXACTLY AS SENT (no re-sorted
// serialization): the rubric, the framing strings and both schemas pin to
// RUBRIC_VERSION, the rendered worked examples to EXAMPLES_VERSION, and the
// whole rendered system text to the pair. If one of these fails, the prompt
// changed: ask Cameron to bump the named version (it marks every stored match
// out of date, spec D9), then add the new version's pin here. Never update a
// pin under an unchanged version.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXAMPLES_VERSION } from '../src/services/ranking/examples.js';
import { PROMPT_FRAMING, buildRankingSystemPrompt, renderExamplesText } from '../src/services/ranking/prompt.js';
import { RUBRIC_TEXT, RUBRIC_VERSION } from '../src/services/ranking/rubric.js';
import { rankingSchema } from '../src/services/ranking/schema.js';

const RUBRIC_PINS: Readonly<Record<string, string>> = { r1: '2fdf3c3e189b172210362180dd2a6851416fea3a11389e77207081bbdeeda538', r2: '364fb195d5fdf8ee7eba676464a14cbfbd0847584a9c00bed1cdf0bc4b0912d8', r3: 'd9c9b9c4611c7d64cbe6c6ed7754f05f68586746990feca6c051875429c7e312' };
const FRAMING_PINS: Readonly<Record<string, string>> = { r1: '1f4690fb12bfceb3f15a61b831b16325648d546b3281b33a2f7c674ee88749ef', r2: '1f4690fb12bfceb3f15a61b831b16325648d546b3281b33a2f7c674ee88749ef', r3: '1f4690fb12bfceb3f15a61b831b16325648d546b3281b33a2f7c674ee88749ef' };
const SCHEMA_PINS: Readonly<Record<string, { off: string; on: string }>> = { r1: { off: '14169f30e27245c76a3f5ee50807a73ff359999ac429b471d657694f0d5758eb', on: '587274585ffcac596cc1e1305c459ee9d4597c9f7523e9b5dca51bc5129022ba' }, r2: { off: '14169f30e27245c76a3f5ee50807a73ff359999ac429b471d657694f0d5758eb', on: '587274585ffcac596cc1e1305c459ee9d4597c9f7523e9b5dca51bc5129022ba' }, r3: { off: '14169f30e27245c76a3f5ee50807a73ff359999ac429b471d657694f0d5758eb', on: '587274585ffcac596cc1e1305c459ee9d4597c9f7523e9b5dca51bc5129022ba' } };
const EXAMPLES_PINS: Readonly<Record<string, string>> = { e1: 'c1bd64e7a42ecf1da7eb2b512d788698083b44414559fe103b389edb46be5fb8', e2: '873e39d82e5bfce78d92dbf1273256ec8d0e3a78520c7e7bf627720def368abc', e3: 'edd7985db17c7bd2550660dceabd4f207b1d3a42c71d9f794c3e89902d0dc673' };
const SYSTEM_PINS: Readonly<Record<string, string>> = { 'r1/e1': 'a4d00efd999b11ef8eded27d74225366113fd9dfaa5eebd4f7ac184ad7e1cb6a', 'r2/e2': '2f0ad5f10b2ccc3ec37fea4e58f95de2be23f76e8183815019a2220956ee3726', 'r3/e3': '392b6664a596e0eb6f1af28bdbe291ca19fc3a82438cfe90356a55aa79bcd8f9' };

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('the prompt bytes are pinned to their versions (PR32, R2F3)', () => {
  it('RUBRIC_TEXT matches its RUBRIC_VERSION pin', () => {
    expect(sha256(RUBRIC_TEXT), `RUBRIC_TEXT changed: bump RUBRIC_VERSION (now ${RUBRIC_VERSION}) and add its pin`).toBe(RUBRIC_PINS[RUBRIC_VERSION]);
  });

  it('the framing strings (direction lines, instruction, INPUT:, examples heading, EXAMPLE n:, OUTPUT:) match their RUBRIC_VERSION pin', () => {
    expect(sha256(JSON.stringify(PROMPT_FRAMING)), `the prompt framing changed: bump RUBRIC_VERSION (now ${RUBRIC_VERSION}) and add its pin`).toBe(FRAMING_PINS[RUBRIC_VERSION]);
  });

  it('the ranking schema as sent, landlord switch off and on, matches its RUBRIC_VERSION pins', () => {
    const pins = SCHEMA_PINS[RUBRIC_VERSION];
    expect(pins, `no schema pins for ${RUBRIC_VERSION}: add them beside the rubric pin`).toBeDefined();
    expect(sha256(JSON.stringify(rankingSchema({ landlordCard: false }))), `the ranking schema (switch off) changed: bump RUBRIC_VERSION (now ${RUBRIC_VERSION}) and add its pins`).toBe(pins?.off);
    expect(sha256(JSON.stringify(rankingSchema({ landlordCard: true }))), `the ranking schema (switch on) changed: bump RUBRIC_VERSION (now ${RUBRIC_VERSION}) and add its pins`).toBe(pins?.on);
  });

  it('the rendered worked examples match their EXAMPLES_VERSION pin', () => {
    expect(sha256(renderExamplesText()), `the worked examples as rendered changed: bump EXAMPLES_VERSION (now ${EXAMPLES_VERSION}) and add its pin`).toBe(EXAMPLES_PINS[EXAMPLES_VERSION]);
  });

  it('the whole rendered system text matches the pin of its version pair', () => {
    const pair = `${RUBRIC_VERSION}/${EXAMPLES_VERSION}`;
    expect(sha256(buildRankingSystemPrompt()), `the system text changed: bump RUBRIC_VERSION or EXAMPLES_VERSION (whichever part changed; now ${pair}) and add the pin`).toBe(SYSTEM_PINS[pair]);
  });
});
