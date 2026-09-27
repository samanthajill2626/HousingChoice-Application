// app/test/helpers/audioFixtures.ts
// Audio fixtures shared by the voicemail-greeting suites. A HELPER module (no
// describe/it): importing it from several test files must never re-run a suite.
// minimalMp3() already lives in app/src/lib/seed/media.ts.

/** A minimal PCM WAV: 44-byte RIFF/WAVE header + `silenceBytes` zero samples. */
export function minimalWav(silenceBytes = 64): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + silenceBytes, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24); // sample rate
  header.writeUInt32LE(16000, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(silenceBytes, 40);
  return Buffer.concat([header, Buffer.alloc(silenceBytes, 0)]);
}
