import { fitImageToCanvas } from './fitImage.js';

describe('fitImageToCanvas', () => {
  it.each([
    [
      'landscape',
      { width: 4000, height: 2000 },
      { width: 1000, height: 600 },
      { width: 1000, height: 500 },
    ],
    [
      'portrait',
      { width: 2000, height: 4000 },
      { width: 1000, height: 600 },
      { width: 300, height: 600 },
    ],
    [
      'square',
      { width: 2, height: 2 },
      { width: 1000, height: 600 },
      { width: 600, height: 600 },
    ],
  ])('fits a %s bitmap to the canvas without including letterbox space', (
    _label,
    natural,
    canvas,
    expected,
  ) => {
    expect(fitImageToCanvas(natural, canvas)).toEqual(expected);
  });

  it.each([
    [{ width: 0, height: 100 }, { width: 1000, height: 600 }],
    [{ width: 100, height: -1 }, { width: 1000, height: 600 }],
    [{ width: 100, height: 100 }, { width: 0, height: 600 }],
    [{ width: 100, height: 100 }, { width: 1000, height: -1 }],
  ])('returns a zero box when natural or canvas dimensions are not positive', (natural, canvas) => {
    expect(fitImageToCanvas(natural, canvas)).toEqual({ width: 0, height: 0 });
  });
});
