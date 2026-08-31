export interface Size {
  width: number;
  height: number;
}

const ZERO_SIZE: Size = { width: 0, height: 0 };

export function fitImageToCanvas(natural: Size, canvas: Size): Size {
  if (
    natural.width <= 0 ||
    natural.height <= 0 ||
    canvas.width <= 0 ||
    canvas.height <= 0
  ) {
    return ZERO_SIZE;
  }

  const scale = Math.min(canvas.width / natural.width, canvas.height / natural.height);
  return {
    width: natural.width * scale,
    height: natural.height * scale,
  };
}
