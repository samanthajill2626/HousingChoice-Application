import { formatPhoneDisplay } from './phone.js';

test('formats a NANP E.164 for display', () => {
  expect(formatPhoneDisplay('+15550160001')).toBe('(555) 016-0001');
  expect(formatPhoneDisplay('+14049824978')).toBe('(404) 982-4978');
});

test('leaves non-NANP shapes unchanged', () => {
  expect(formatPhoneDisplay('+442079460958')).toBe('+442079460958');
});

test('falsy input renders as an empty string (safe for JSX)', () => {
  expect(formatPhoneDisplay(undefined)).toBe('');
  expect(formatPhoneDisplay('')).toBe('');
});
