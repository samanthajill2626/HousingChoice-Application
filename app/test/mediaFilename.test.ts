// The download-name builder for one served media attachment. PURE - no I/O,
// no config - so these are plain unit tests over the two rules that carry the
// security weight: the extension is always ours, and nothing that reaches a
// header can carry a quote or a CRLF.
import { describe, expect, it } from 'vitest';
import {
  buildMediaFilename,
  buildMediaFilenameParts,
  contentDispositionHeader,
} from '../src/lib/mediaFilename.js';
import { resolveMediaTier } from '../src/lib/mediaTypes.js';

// Non-ASCII fixtures are BUILT, never written as literals: the repo's
// ASCII-only rule covers test files, and a unicode escape in a markdown plan
// does not survive copy-paste reliably. String.fromCharCode is unambiguous at
// every layer - the same reason Timeline.tsx:604-608 builds its glyphs.
const E_ACUTE = String.fromCharCode(0xe9);
const NON_ASCII_STEM = `bud${E_ACUTE}get`;

const MP4 = resolveMediaTier('video/mp4');
const XLSX = resolveMediaTier(
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
);
const OPAQUE = resolveMediaTier(undefined);

describe('buildMediaFilename - the extension is always ours', () => {
  it('synthesizes a ONE-based name when there is no stored filename', () => {
    // The header is 0-based today while the UI says "Attachment 1"; the
    // synthesized name matches the UI.
    expect(buildMediaFilename(undefined, 0, MP4)).toBe('attachment-1.mp4');
    expect(buildMediaFilename(undefined, 2, OPAQUE)).toBe('attachment-3.bin');
  });

  it('takes the stem from a stored filename but NEVER its extension', () => {
    // The stored name comes off a MIME part the sender controls. Honouring its
    // extension would let a sender choose what the operator's OS opens.
    expect(buildMediaFilename('invoice.exe', 0, MP4)).toBe('invoice.mp4');
    expect(buildMediaFilename('holiday.mov', 0, MP4)).toBe('holiday.mp4');
  });

  it('keeps an ACCEPTED stored extension on the opaque tier only', () => {
    // Historical inbound email: the type is unrecoverable but the real name
    // survives, so budget.xlsx must not download as budget.bin.
    expect(buildMediaFilename('budget.xlsx', 0, OPAQUE)).toBe('budget.xlsx');
    expect(buildMediaFilename('photo.jpeg', 0, OPAQUE)).toBe('photo.jpeg');
  });

  it('refuses an unaccepted stored extension on the opaque tier', () => {
    expect(buildMediaFilename('invoice.exe', 0, OPAQUE)).toBe('invoice.bin');
    expect(buildMediaFilename('run.ps1', 0, OPAQUE)).toBe('run.bin');
  });

  it('treats emailMime\'s synthesized name as absent', () => {
    // lib/emailMime.ts stores `attachment-<i>` for a nameless MIME part. It is
    // non-empty, so a naive "prefer the stored name" reproduces exactly the
    // extensionless 0-based name this feature removes.
    expect(buildMediaFilename('attachment-0', 0, XLSX)).toBe('attachment-1.xlsx');
    expect(buildMediaFilename('attachment-12', 3, MP4)).toBe('attachment-4.mp4');
  });
});

describe('buildMediaFilename - sanitizing happens BEFORE splitting', () => {
  it('splits at the LAST dot and keeps interior dots in the stem', () => {
    expect(buildMediaFilename('data.tar.csv', 0, OPAQUE)).toBe('data.tar.csv');
    expect(buildMediaFilename('data.tar.csv', 0, MP4)).toBe('data.tar.mp4');
  });

  it('treats a leading-dot-only name as having no stem', () => {
    expect(buildMediaFilename('.env', 0, MP4)).toBe('attachment-1.mp4');
  });

  it('never emits a double dot from a trailing-dot name', () => {
    expect(buildMediaFilename('report.', 0, MP4)).toBe('report.mp4');
    expect(buildMediaFilename('report...', 0, MP4)).toBe('report.mp4');
  });

  it('removes path separators and traversal BEFORE looking for the extension', () => {
    // ORDER IS LOAD-BEARING. Splitting first would find the dot at index 4 of
    // `../../etc/passwd` and hand `./etc/passwd` to the extension logic.
    expect(buildMediaFilename('../../etc/passwd', 0, MP4)).toBe('etcpasswd.mp4');
    expect(buildMediaFilename('C:\\Users\\x\\secret.txt', 0, MP4)).toBe('CUsersxsecret.mp4');
  });

  it('turns control characters into a space rather than deleting them', () => {
    // Deleting would silently join two words: `a\r\nb` must not become `ab`.
    expect(buildMediaFilename('a\r\nb', 0, MP4)).toBe('a b.mp4');
    expect(buildMediaFilename('a\tb', 0, MP4)).toBe('a b.mp4');
  });

  it('removes quotes and backslashes entirely', () => {
    expect(buildMediaFilename('he said "hi"', 0, MP4)).toBe('he said hi.mp4');
  });

  it('does not let a trailing space reach the emitted name', () => {
    expect(buildMediaFilename('report .txt', 0, MP4)).toBe('report.mp4');
  });

  it('caps the STEM, not the emitted name, so the extension survives', () => {
    // Capping the whole name would truncate .xlsx to .xls and change the file
    // type the OS sees.
    const long = 'a'.repeat(120);
    const out = buildMediaFilename(`${long}.xlsx`, 0, XLSX);
    expect(out).toBe(`${'a'.repeat(100)}.xlsx`);
    expect(out.endsWith('.xlsx')).toBe(true);
  });

  it('re-strips a trailing dot EXPOSED BY the cap', () => {
    // The stem is 110 chars with a dot at position 99, so the cap turns an
    // INTERIOR dot into a trailing one. Stripping only before the cap emits
    // `aaa...a..mp4`.
    const name = `${'a'.repeat(99)}.${'c'.repeat(10)}.txt`;
    expect(buildMediaFilename(name, 0, MP4)).toBe(`${'a'.repeat(99)}.mp4`);
  });

  it('replaces non-ASCII rather than dropping it', () => {
    // Dropping empties a wholly non-ASCII stem and yields filename=".xlsx".
    expect(buildMediaFilename(NON_ASCII_STEM, 0, XLSX)).toBe('bud_get.xlsx');
  });

  it('falls through when nothing usable survives sanitizing', () => {
    // An all-placeholder stem is not a name. Without this rule a wholly
    // non-ASCII filename downloads as `__.xlsx`.
    const allNonAscii = String.fromCharCode(0x4f60, 0x597d);
    expect(buildMediaFilename(allNonAscii, 0, XLSX)).toBe('attachment-1.xlsx');
    expect(buildMediaFilename('///', 0, MP4)).toBe('attachment-1.mp4');
    expect(buildMediaFilename('   ', 0, MP4)).toBe('attachment-1.mp4');
  });

  it('KEEPS the utf8 form even when the ASCII form fell through', () => {
    // The two decisions are independent. A wholly non-ASCII name has no usable
    // ASCII form, but `filename*` can still carry the operator's real name -
    // and that is the exact population filename* exists for, so collapsing the
    // two decisions would lose it precisely where it matters.
    const allNonAscii = String.fromCharCode(0x4f60, 0x597d);
    expect(buildMediaFilenameParts(allNonAscii, 0, XLSX)).toEqual({
      ascii: 'attachment-1.xlsx',
      utf8: `${allNonAscii}.xlsx`,
    });
  });

  it('omits filename* rather than throwing on an unpaired surrogate', () => {
    // encodeURIComponent throws URIError on a lone surrogate, and a stored
    // filename is untrusted data - this must not 500 the authed media route.
    const loneSurrogate = String.fromCharCode(0xd800);
    const parts = buildMediaFilenameParts(`x${loneSurrogate}y`, 0, MP4);
    expect(() => contentDispositionHeader('attachment', parts)).not.toThrow();
    expect(contentDispositionHeader('attachment', parts)).toBe(
      'attachment; filename="x_y.mp4"',
    );
  });
});

describe('buildMediaFilename - the RFC 5987 companion', () => {
  it('reports no utf8 form when the stem was already ASCII', () => {
    expect(buildMediaFilenameParts('budget.xlsx', 0, XLSX)).toEqual({
      ascii: 'budget.xlsx',
      utf8: undefined,
    });
  });

  it('reports both forms when the stem carried non-ASCII', () => {
    expect(buildMediaFilenameParts(NON_ASCII_STEM, 0, XLSX)).toEqual({
      ascii: 'bud_get.xlsx',
      utf8: `${NON_ASCII_STEM}.xlsx`,
    });
  });
});

describe('contentDispositionHeader', () => {
  it('emits a plain ASCII filename parameter', () => {
    expect(contentDispositionHeader('attachment', { ascii: 'budget.xlsx' })).toBe(
      'attachment; filename="budget.xlsx"',
    );
  });

  it('supports the inline kind', () => {
    expect(contentDispositionHeader('inline', { ascii: 'photo.jpg' })).toBe(
      'inline; filename="photo.jpg"',
    );
  });

  it('adds filename* only when a utf8 form differs', () => {
    expect(
      contentDispositionHeader('attachment', {
        ascii: 'bud_get.xlsx',
        utf8: `${NON_ASCII_STEM}.xlsx`,
      }),
    ).toBe("attachment; filename=\"bud_get.xlsx\"; filename*=UTF-8''bud%C3%A9get.xlsx");
  });

  it('percent-encodes the RFC 5987 characters encodeURIComponent leaves bare', () => {
    expect(
      contentDispositionHeader('attachment', { ascii: 'a_b.txt', utf8: "a'(b)*!.txt" }),
    ).toContain("filename*=UTF-8''a%27%28b%29%2A%21.txt");
  });

  it('cannot be injected into via a quote or CRLF', () => {
    // buildMediaFilename has already removed these; this is defence in depth
    // at the point the header string is actually assembled.
    const header = contentDispositionHeader('attachment', { ascii: 'a"b\r\nX-Evil: 1' });
    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header.match(/"/g)).toHaveLength(2);
  });
});
