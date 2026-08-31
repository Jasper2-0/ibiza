/*
 * Direct port of demo.exe's native loading renderer.
 *
 * FUN_00406ba0 copies x1 to the PTC framebuffer, then draws its radial
 * randomized loading treatment with FUN_00405f90.  The latter is a fixed-Q10
 * additive antialiased line rasterizer.  Its process-wide random generator is
 * also the one used later while constructing the opening particle effect.
 */

const WIDTH = 512;
const HEIGHT = 384;
const PIXELS = WIDTH * HEIGHT;
const TRIG_STEP = 0.000766990234375;
const RANDOM_INITIAL_STATE = 0x0001fe24;
const UINT32_SCALE = 1 / 0xffffffff;
const OPENING_CONSTRUCTOR_RANDOM_CALLS = 16000;
const OPENING_CONSTRUCTOR_AFTER_SEQUENCE_INDEX = 82;

const PROGRESS_SEQUENCE = Object.freeze([
  ...Array.from({ length: 80 }, (_, index) => index / 100),
  0.83, 0.85, 0.87, 0.89, 0.91, 0.92, 0.94, 0.96, 0.97, 1.0
]);

const SIN = new Int32Array(8192);
const COS = new Int32Array(8192);
for (let index = 0; index < SIN.length; index++) {
  const angle = index * TRIG_STEP;
  SIN[index] = Math.trunc(Math.sin(angle) * 8192);
  COS[index] = Math.trunc(Math.cos(angle) * 8192);
}

function rotl32(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function packedFromImageData(source) {
  if (!source?.data || source.width !== WIDTH || source.height !== HEIGHT) {
    throw new RangeError('LoadingEffect requires the 512x384 x1 ImageData');
  }
  const packed = new Uint32Array(PIXELS);
  for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
    packed[pixel] = (source.data[offset] << 16) |
      (source.data[offset + 1] << 8) | source.data[offset + 2];
  }
  return packed;
}

export const LOADING_PROGRESS_SEQUENCE = PROGRESS_SEQUENCE;

export class LoadingEffect {
  constructor(source) {
    this.base = packedFromImageData(source);
    this.frame = new Uint32Array(PIXELS);
    this.imageByContext = new WeakMap();
    this.reset();
  }

  reset() {
    this.randomState = RANDOM_INITIAL_STATE;
    this.sequenceIndex = -1;
    this.frame.set(this.base);
  }

  random(range) {
    this.randomState = (rotl32((this.randomState + 157) >>> 0, 11) ^ 157) >>> 0;
    return Math.trunc(this.randomState * UINT32_SCALE * range);
  }

  advanceRandom(count) {
    for (let index = 0; index < count; index++) this.random(1);
  }

  plot(x, y, color, coverageQ10) {
    // FUN_00405f90 deliberately excludes row and column zero.
    if (x <= 0 || y <= 0 || x >= WIDTH || y >= HEIGHT) return;
    const amount = coverageQ10 >> 2;
    if (amount <= 0) return;
    const pixel = y * WIDTH + x;
    const old = this.frame[pixel];
    const red = Math.min(255, ((old >>> 16) & 255) +
      (Math.imul((color >>> 16) & 255, amount) >> 8));
    const green = Math.min(255, ((old >>> 8) & 255) +
      (Math.imul((color >>> 8) & 255, amount) >> 8));
    const blue = Math.min(255, (old & 255) +
      (Math.imul(color & 255, amount) >> 8));
    this.frame[pixel] = (red << 16) | (green << 8) | blue;
  }

  line(x0, y0, x1, y1, color) {
    let deltaX = (x1 - x0) | 0;
    let deltaY = (y1 - y0) | 0;

    // The native `jle` jumps to the Y-major branch on an exact tie.
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      if (x0 > x1) {
        [x0, x1] = [x1, x0];
        [y0, y1] = [y1, y0];
        deltaX = (x1 - x0) | 0;
        deltaY = (y1 - y0) | 0;
      }
      const gradient = Math.trunc(deltaY / deltaX * 1024) | 0;
      let endpoint = (x0 + 512) & ~1023;
      let intercept = (y0 + (Math.imul(endpoint - x0, gradient) >> 10)) | 0;
      const firstGap = 1023 - ((x0 - 512) & 1023);
      const firstX = endpoint >> 10;
      const firstY = intercept >> 10;
      this.plot(firstX, firstY + 1, color,
        Math.imul(intercept & 1023, firstGap) >> 10);
      this.plot(firstX, firstY, color,
        Math.imul(1023 - (intercept & 1023), firstGap) >> 10);

      let middle = (intercept + gradient) | 0;
      endpoint = (x1 + 512) & ~1023;
      intercept = (y1 + (Math.imul(endpoint - x1, gradient) >> 10)) | 0;
      const lastGap = (x1 - 512) & 1023;
      const lastX = endpoint >> 10;
      const lastY = intercept >> 10;
      for (let x = firstX + 1; x <= lastX - 1; x++) {
        const fraction = middle & 1023;
        const y = middle >> 10;
        this.plot(x, y + 1, color, fraction);
        this.plot(x, y, color, 1023 - fraction);
        middle = (middle + gradient) | 0;
      }
      this.plot(lastX, lastY + 1, color,
        Math.imul(intercept & 1023, lastGap) >> 10);
      this.plot(lastX, lastY, color,
        Math.imul(1023 - (intercept & 1023), lastGap) >> 10);
      return;
    }

    if (y0 > y1) {
      [x0, x1] = [x1, x0];
      [y0, y1] = [y1, y0];
      deltaX = (x1 - x0) | 0;
      deltaY = (y1 - y0) | 0;
    }
    const gradient = Math.trunc(deltaX / deltaY * 1024) | 0;
    let endpoint = (y0 + 512) & ~1023;
    let intercept = (x0 + (Math.imul(endpoint - y0, gradient) >> 10)) | 0;
    const firstGap = 1023 - ((y0 - 512) & 1023);
    const firstY = endpoint >> 10;
    const firstX = intercept >> 10;
    this.plot(firstX, firstY, color,
      Math.imul(1023 - (intercept & 1023), firstGap) >> 10);
    this.plot(firstX + 1, firstY, color,
      Math.imul(intercept & 1023, firstGap) >> 10);

    let middle = (intercept + gradient) | 0;
    endpoint = (y1 + 512) & ~1023;
    intercept = (x1 + (Math.imul(endpoint - y1, gradient) >> 10)) | 0;
    const lastGap = (y1 - 512) & 1023;
    const lastY = endpoint >> 10;
    const lastX = intercept >> 10;
    for (let y = firstY + 1; y <= lastY - 1; y++) {
      const fraction = middle & 1023;
      const x = middle >> 10;
      this.plot(x, y, color, 1023 - fraction);
      this.plot(x + 1, y, color, fraction);
      middle = (middle + gradient) | 0;
    }
    this.plot(lastX, lastY, color,
      Math.imul(1023 - (intercept & 1023), lastGap) >> 10);
    this.plot(lastX + 1, lastY, color,
      Math.imul(intercept & 1023, lastGap) >> 10);
  }

  drawProgress(progress) {
    this.frame.set(this.base);
    const centerX = Math.trunc(WIDTH * 3 / 4) << 10;
    const centerY = Math.trunc(HEIGHT * 3 / 8) << 10;

    for (let phase = 0; phase < progress; phase += 0.01) {
      const angle = Math.trunc(phase * 8192) & 8191;
      let x0 = centerX + SIN[angle] * 10;
      let y0 = centerY + COS[angle] * 10;
      let x1 = centerX + SIN[angle] * 12;
      let y1 = centerY + COS[angle] * 12;
      this.line(x0, y0, x1, y1, 0x007fff);

      for (let iteration = 0; iteration < 128; iteration++) {
        x0 = (x0 + this.random(2000) - 1000) | 0;
        y0 = (y0 + this.random(2000) - 1000) | 0;
        x1 = (x1 + this.random(2000) - 1000) | 0;
        y1 = (y1 + this.random(2000) - 1000) | 0;
        this.line(x0, y0, x1, y1, 0x000307);
      }
    }
  }

  write(context) {
    let image = this.imageByContext.get(context);
    if (!image) {
      image = context.createImageData(WIDTH, HEIGHT);
      this.imageByContext.set(context, image);
    }
    for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
      const color = this.frame[pixel];
      image.data[offset] = color >>> 16;
      image.data[offset + 1] = (color >>> 8) & 255;
      image.data[offset + 2] = color & 255;
      image.data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }

  renderSequenceIndex(context, sequenceIndex) {
    if (!Number.isInteger(sequenceIndex) || sequenceIndex < 0 ||
        sequenceIndex >= PROGRESS_SEQUENCE.length) {
      throw new RangeError('loading sequence index is out of range');
    }
    if (sequenceIndex < this.sequenceIndex) this.reset();
    while (this.sequenceIndex < sequenceIndex) {
      // demo.exe constructs the 8,000-element opening object after the .87
      // loading call and before .89. It consumes two values per element from
      // this same process-wide generator, so the later loading frames must
      // include that otherwise invisible interleave.
      if (this.sequenceIndex === OPENING_CONSTRUCTOR_AFTER_SEQUENCE_INDEX) {
        this.advanceRandom(OPENING_CONSTRUCTOR_RANDOM_CALLS);
      }
      this.sequenceIndex++;
      this.drawProgress(PROGRESS_SEQUENCE[this.sequenceIndex]);
    }
    this.write(context);
  }
}
