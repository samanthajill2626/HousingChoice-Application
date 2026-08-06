// csv.ts — the parser quirks that matter, each traced to a real export defect.
// Fixtures are synthetic (no founder PII); the SHAPES are copied from the real
// files.
import { describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv } from '../src/lib/import/csv.js';

describe('parseCsv', () => {
  it('parses a simple file into header + rows', () => {
    const { header, rows } = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
    expect(header).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('strips a UTF-8 BOM (every Airtable export carries one)', () => {
    const { header } = parseCsv('﻿Name,Phone\nSam,+15550100001\n');
    expect(header[0]).toBe('Name');
  });

  it('keeps embedded newlines inside quoted fields', () => {
    // 4,180 of the 22,035 physical lines in the real messages export are
    // continuations of a multi-line body.
    const { rows } = parseCsv('id,body\nAC1,"line one\nline two"\nAC2,plain\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.body).toBe('line one\nline two');
    expect(rows[1]!.body).toBe('plain');
  });

  it('unescapes doubled quotes', () => {
    const { rows } = parseCsv('id,addr\n1,"""1425 Boone Blvd, Unit 104"""\n');
    expect(rows[0]!.addr).toBe('"1425 Boone Blvd, Unit 104"');
  });

  it('treats a LONE CR as content, not a record break', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. The Quo messages export is
    // LF-terminated and holds 18 bare CRs inside unquoted bodies (trailing
    // whitespace a tenant typed). Reading a lone CR as a terminator split 15
    // real messages in half and manufactured a phantom contact from each tail.
    const { rows } = parseCsv('id,body,direction\nAC1,thanks\rmore,incoming\nAC2,ok,outgoing\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.body).toBe('thanks\rmore');
    expect(rows[0]!.direction).toBe('incoming');
  });

  it('still treats CRLF as a single record break', () => {
    const { rows } = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('pads short rows rather than throwing (Airtable emits ragged rows)', () => {
    const { rows } = parseCsv('a,b,c\n1,2\n');
    expect(rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('skips blank lines', () => {
    const { rows } = parseCsv('a,b\n1,2\n\n3,4\n');
    expect(rows).toHaveLength(2);
  });

  it('handles a trailing record with no final newline', () => {
    const { rows } = parseCsv('a,b\n1,2');
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('returns empty for empty input', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [] });
  });
});

describe('serializeCsv', () => {
  it('round-trips values needing quotes', () => {
    const rows = [{ a: 'has,comma', b: 'has"quote', c: 'has\nnewline', d: ' padded ' }];
    const text = serializeCsv(['a', 'b', 'c', 'd'], rows);
    expect(parseCsv(text).rows[0]).toEqual(rows[0]);
  });

  it('does not quote plain values', () => {
    expect(serializeCsv(['a', 'b'], [{ a: '1', b: '2' }])).toBe('a,b\r\n1,2\r\n');
  });

  it('writes empty strings for missing columns', () => {
    expect(serializeCsv(['a', 'b'], [{ a: '1' }])).toBe('a,b\r\n1,\r\n');
  });

  it('round-trips a body containing a lone CR', () => {
    const rows = [{ id: 'AC1', body: 'thanks\rmore' }];
    const text = serializeCsv(['id', 'body'], rows);
    expect(parseCsv(text).rows[0]).toEqual(rows[0]);
  });
});
