// Exact software port of the persistent x3..x6 credits background.
//
// Relevant native routines:
//   FUN_004035f0  base constructor / shared warp grid
//   FUN_004036a0  33x25 control-grid renderer
//   FUN_00403b60  base packed bilinear sampler
//   FUN_00403cb0  credits constructor
//   FUN_00403e20  image-index callback
//   FUN_00403e30  per-frame blend/transform update
//   FUN_00403f90  control-point transform
//   FUN_004040f0  render followed by persistent feedback update
//   FUN_00404200  credits packed bilinear sampler

const WIDTH = 512;
const HEIGHT = 384;
const SCREEN_PIXELS = WIDTH * HEIGHT;
const TEXTURE_SIZE = 512;
const TEXTURE_PIXELS = TEXTURE_SIZE * TEXTURE_SIZE;
const TEXTURE_MASK = TEXTURE_PIXELS - 1;
const BORDER_ROWS = 64;

// The release capture advances frame-counted software effects at 59 renders/s.
const FPS = 59;
const CHECKPOINT_INTERVAL = 120;
const MAX_CHECKPOINTS = 64;

// Literal at demo.exe:00439b60, intentionally not Math.PI * 2 / 8192.
const TRIG_STEP = 0.000766990234375;
const SIN = new Int32Array(8192);
const COS = new Int32Array(8192);
for (let index = 0; index < 8192; index++) {
  const angle = index * TRIG_STEP;
  SIN[index] = Math.trunc(Math.sin(angle) * 8192);
  COS[index] = Math.trunc(Math.cos(angle) * 8192);
}

function sinQ13(angle) {
  return SIN[angle & 8191];
}

function cosQ13(angle) {
  return COS[angle & 8191];
}

function pixelsFromSource(source, name) {
  if (!source) throw new TypeError(`${name} is required`);
  if (ArrayBuffer.isView(source)) return source;
  if (ArrayBuffer.isView(source.data)) return source.data;

  const ownContext = source.ctx ||
    (typeof source.getContext === 'function'
      ? source.getContext('2d', { willReadFrequently: true })
      : null);
  if (ownContext && typeof ownContext.getImageData === 'function') {
    return ownContext.getImageData(0, 0, WIDTH, HEIGHT).data;
  }

  // ImageBitmap and HTMLImageElement are CanvasImageSource objects but are not
  // directly readable. This path also matches app.js's no-profile ImageBitmap
  // loading when those bitmaps are passed straight to the constructor.
  if (source.width === WIDTH && source.height === HEIGHT) {
    let canvas = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    } else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
    }
    const context = canvas?.getContext('2d', { willReadFrequently: true });
    if (context && typeof context.drawImage === 'function') {
      context.drawImage(source, 0, 0, WIDTH, HEIGHT);
      return context.getImageData(0, 0, WIDTH, HEIGHT).data;
    }
  }

  throw new TypeError(
    `${name} must be raw RGBA, packed 00RRGGBB, ImageData, or a readable canvas`
  );
}

function makePackedImage(source, name) {
  const pixels = pixelsFromSource(source, name);
  if (pixels instanceof Uint32Array && pixels.length === SCREEN_PIXELS) {
    const packed = new Uint32Array(SCREEN_PIXELS);
    for (let index = 0; index < SCREEN_PIXELS; index++) {
      packed[index] = pixels[index] & 0x00ffffff;
    }
    return packed;
  }
  if (pixels.length !== SCREEN_PIXELS * 4) {
    throw new RangeError(`${name} must contain exactly 512x384 pixels`);
  }

  const packed = new Uint32Array(SCREEN_PIXELS);
  for (let index = 0, offset = 0; index < SCREEN_PIXELS;
      index++, offset += 4) {
    packed[index] = (pixels[offset] << 16) |
      (pixels[offset + 1] << 8) | pixels[offset + 2];
  }
  return packed;
}

function add32(first, second) {
  return (first + second) | 0;
}

function sub32(first, second) {
  return (first - second) | 0;
}

function mulAdd32(a, aw, b, bw) {
  return add32(Math.imul(a, aw), Math.imul(b, bw));
}

// Native packed 00RRGGBB interpolation. FUN_00404200 deliberately retains
// sign extension in byte 3; PTC ignores that byte, and all later RGB math masks
// it away. Keeping it here is useful for exact state/checkpoint hashes.
function samplePacked(texture, coordinateX, coordinateY) {
  const fractionX = coordinateX & 255;
  const fractionY = coordinateY & 255;
  const inverseX = 256 - fractionX;
  const inverseY = 256 - fractionY;

  const weight00 = Math.imul(inverseX, inverseY) >> 8;
  const weight10 = Math.imul(fractionX, inverseY) >> 8;
  const weight01 = Math.imul(inverseX, fractionY) >> 8;
  const weight11 = Math.imul(fractionX, fractionY) >> 8;

  const x = (coordinateX >> 8) & 511;
  const y = (coordinateY >> 8) & 511;
  const index = x + y * TEXTURE_SIZE;
  const topLeft = texture[index];
  const topRight = texture[(index + 1) & TEXTURE_MASK];
  const bottomLeft = texture[(index + TEXTURE_SIZE) & TEXTURE_MASK];
  const bottomRight = texture[(index + TEXTURE_SIZE + 1) & TEXTURE_MASK];

  let redBlue = Math.imul(topLeft & 0x00ff00ff, weight00);
  redBlue = add32(redBlue,
    Math.imul(topRight & 0x00ff00ff, weight10));
  redBlue = add32(redBlue,
    Math.imul(bottomLeft & 0x00ff00ff, weight01));
  redBlue = add32(redBlue,
    Math.imul(bottomRight & 0x00ff00ff, weight11));

  let green = Math.imul(topLeft & 0x0000ff00, weight00);
  green = add32(green, Math.imul(topRight & 0x0000ff00, weight10));
  green = add32(green, Math.imul(bottomLeft & 0x0000ff00, weight01));
  green = add32(green, Math.imul(bottomRight & 0x0000ff00, weight11));

  // `sar ebx,8; and bh,0` at 00404311..00404317.
  redBlue = (redBlue >> 8) & 0xffff00ff;
  green = (green >> 8) & 0x0000ff00;
  return (redBlue | green) >>> 0;
}

function firstPackedBlend(feedback, image, imageWeight, inverseWeight) {
  let redBlue = mulAdd32(feedback & 0x00ff00ff, imageWeight,
    image & 0x00ff00ff, inverseWeight);
  let green = mulAdd32(feedback & 0x0000ff00, imageWeight,
    image & 0x0000ff00, inverseWeight);
  redBlue = (redBlue >>> 8) & 0x00ff00ff;
  green = (green >>> 8) & 0x0000ff00;
  return (redBlue | green) >>> 0;
}

function secondPackedBlend(first, warped, firstWeight, warpedWeight) {
  let redBlue = mulAdd32(first & 0x00ff00ff, firstWeight,
    warped & 0x00ff00ff, warpedWeight);
  let green = mulAdd32(first & 0x0000ff00, firstWeight,
    warped & 0x0000ff00, warpedWeight);
  // FUN_004040f0 has the same byte-3 sign-extension quirk as its sampler.
  redBlue = (redBlue >> 8) & 0xffff00ff;
  green = (green >> 8) & 0x0000ff00;
  return (redBlue | green) >>> 0;
}

export class CreditsBackground {
  constructor({
    x3, x4, x5, x6, startTime, callbackTimes, repeatPeriod, timerLead
  }) {
    this.images = [
      makePackedImage(x3, 'x3'),
      makePackedImage(x4, 'x4'),
      makePackedImage(x5, 'x5'),
      makePackedImage(x6, 'x6')
    ];

    this.start = startTime;
    this.callbackTimes = Float64Array.from(callbackTimes);
    this.repeatPeriod = repeatPeriod;
    this.fps = FPS;
    this.timerLead = timerLead;
    this.checkpointInterval = CHECKPOINT_INTERVAL;
    this.maxCheckpoints = MAX_CHECKPOINTS;
    if (!(this.repeatPeriod > 0)) {
      throw new RangeError('repeatPeriod must be positive');
    }
    if (!Number.isFinite(this.timerLead)) {
      throw new RangeError('timerLead must be finite');
    }
    for (let index = 0; index < this.callbackTimes.length; index++) {
      if (!Number.isFinite(this.callbackTimes[index]) ||
          (index && this.callbackTimes[index] <= this.callbackTimes[index - 1])) {
        throw new RangeError('callbackTimes must be finite and increasing');
      }
    }

    this.feedback = new Uint32Array(TEXTURE_PIXELS);
    this.screen = new Uint32Array(SCREEN_PIXELS);
    this.grid = new Int32Array(33 * 25 * 2);
    this.rgba = new Uint8ClampedArray(SCREEN_PIXELS * 4);
    this.contextImages = new WeakMap();
    this.frame = -1;
    this.checkpoints = [{ nextFrame: 0, feedback: null }];
  }

  isActive(time) {
    return time >= this.start;
  }

  frameForTime(time) {
    if (!this.isActive(time)) return -1;
    return Math.max(0,
      Math.floor((time - this.start) * this.fps + 1e-7));
  }

  imageIndexForTime(time) {
    if (time < this.start) return 0;
    let count = 0;
    while (count < this.callbackTimes.length &&
        time + 1e-9 >= this.callbackTimes[count]) count++;
    if (count === this.callbackTimes.length) {
      const last = this.callbackTimes[this.callbackTimes.length - 1];
      count += Math.floor((time - last) / this.repeatPeriod + 1e-9);
    }
    return count & 3;
  }

  saveCheckpoint(nextFrame) {
    if (this.checkpoints.some(checkpoint =>
      checkpoint.nextFrame === nextFrame)) return;
    this.checkpoints.push({
      nextFrame,
      feedback: new Uint32Array(this.feedback)
    });
    // The effect is intentionally never removed. Retain the zero-state anchor
    // plus a rolling window so an hours-long run cannot grow without bound;
    // an older seek remains exact, but replays from the anchor.
    while (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints.splice(1, 1);
    }
  }

  restoreCheckpoint(checkpoint) {
    if (checkpoint.feedback) this.feedback.set(checkpoint.feedback);
    else this.feedback.fill(0);
    this.frame = checkpoint.nextFrame - 1;
  }

  simulateTo(time) {
    const target = this.frameForTime(time);
    if (target < 0) return false;

    if (target < this.frame) {
      let best = this.checkpoints[0];
      for (const checkpoint of this.checkpoints) {
        if (checkpoint.nextFrame <= target &&
            checkpoint.nextFrame > best.nextFrame) best = checkpoint;
      }
      this.restoreCheckpoint(best);
    }

    while (this.frame < target) {
      const nextFrame = this.frame + 1;
      const visibleTime = this.start + nextFrame / this.fps;
      this.step(visibleTime, visibleTime + this.timerLead);
      this.frame = nextFrame;
      if ((nextFrame + 1) % this.checkpointInterval === 0) {
        this.saveCheckpoint(nextFrame + 1);
      }
    }
    return true;
  }

  updateParameters(visibleTime, engineTime) {
    this.imageIndex = this.imageIndexForTime(visibleTime);
    const time = engineTime;

    // Exact double literals at 004393a0..004393e8.
    const sharedPhase = Math.trunc(time * 1332);
    let first = sinQ13(Math.trunc(time * 1432));
    first = add32(first, sinQ13(Math.trunc(time * 132)));
    first = add32(first, sinQ13(Math.trunc(time * 632)));
    first = add32(first, sinQ13(sharedPhase));
    this.imageWeight = (first + 32768) >> 8;
    this.imageInverseWeight = 255 - this.imageWeight;

    let second = sinQ13(Math.trunc(time * 932));
    second = add32(second, sinQ13(Math.trunc(time * 732)));
    second = add32(second, sinQ13(Math.trunc(time * 1532)));
    second = add32(second, sinQ13(sharedPhase));
    this.feedbackWeight = (second + 32768) >> 8;
    this.warpedWeight = 255 - this.feedbackWeight;

    this.rotation = add32(
      sinQ13(Math.trunc(time * 530)) >> 5,
      sinQ13(Math.trunc(time * 140)) >> 3
    );
    this.scale = 8192 + ((-sinQ13(Math.trunc(time * 210))) >> 2);
  }

  buildGrid(time) {
    const grid = this.grid;
    let output = 0;
    let y = -49152;
    for (let row = 0; row < 25; row++, y += 4096) {
      let x = -65536;
      for (let column = 0; column < 33; column++, x += 4096) {
        const xPixel = x >> 8;
        const yPixel = y >> 8;
        const radius = add32(Math.imul(yPixel, yPixel),
          Math.imul(xPixel, xPixel)) >> 3;

        // `de e9` is FSUBP here: radius - t*1232 and x/16 - t*580.
        let radial = sinQ13(Math.trunc(radius - time * 1232)) >> 3;
        let waves = sinQ13(Math.trunc((x >> 4) - time * 580));
        waves = add32(waves,
          sinQ13(Math.trunc((x >> 3) + time * 563)));
        waves = add32(waves,
          sinQ13(Math.trunc((y >> 3) + time * 490)));
        waves = add32(waves, sinQ13((y >> 4) - 550));
        radial = add32(radial, waves >> 4);

        const amount = add32(this.scale, radial);
        const scaledX = Math.imul(amount, x) >> 13;
        const scaledY = Math.imul(amount, y) >> 13;
        const sine = sinQ13(this.rotation);
        const cosine = cosQ13(this.rotation);

        // FUN_00403f90 stores Y' first and X' second. FUN_004036a0 reads
        // those fields in the inverse order when it calls the sampler.
        grid[output++] = sub32(Math.imul(cosine, scaledY),
          Math.imul(sine, scaledX)) >> 13;
        grid[output++] = add32(Math.imul(sine, scaledY),
          Math.imul(cosine, scaledX)) >> 13;
      }
    }
  }

  warpFeedback() {
    const grid = this.grid;
    const texture = this.feedback;
    const screen = this.screen;
    let cellRowDestination = 0;
    let cellGrid = 0;

    for (let cellY = 0; cellY < 24; cellY++) {
      let cellDestination = cellRowDestination;
      let gridPoint = cellGrid;
      for (let cellX = 0; cellX < 32; cellX++) {
        let leftX = add32(grid[gridPoint + 1], 65536);
        let leftY = add32(grid[gridPoint], 65536);
        let rightX = add32(grid[gridPoint + 3], 65536);
        let rightY = add32(grid[gridPoint + 2], 65536);

        const leftStepX = sub32(grid[gridPoint + 67],
          grid[gridPoint + 1]) >> 4;
        const leftStepY = sub32(grid[gridPoint + 66],
          grid[gridPoint]) >> 4;
        const rightStepX = sub32(grid[gridPoint + 69],
          grid[gridPoint + 3]) >> 4;
        const rightStepY = sub32(grid[gridPoint + 68],
          grid[gridPoint + 2]) >> 4;

        let destination = cellDestination;
        for (let pixelY = 0; pixelY < 16; pixelY++) {
          let coordinateX = leftX;
          let coordinateY = leftY;
          const horizontalStepX = sub32(rightX, leftX) >> 4;
          const horizontalStepY = sub32(rightY, leftY) >> 4;
          for (let pixelX = 0; pixelX < 16; pixelX++) {
            screen[destination++] = samplePacked(texture,
              coordinateX, coordinateY);
            coordinateX = add32(coordinateX, horizontalStepX);
            coordinateY = add32(coordinateY, horizontalStepY);
          }
          destination += WIDTH - 16;
          leftX = add32(leftX, leftStepX);
          leftY = add32(leftY, leftStepY);
          rightX = add32(rightX, rightStepX);
          rightY = add32(rightY, rightStepY);
        }

        cellDestination += 16;
        gridPoint += 2;
      }
      cellRowDestination += WIDTH * 16;
      cellGrid += 33 * 2;
    }
  }

  updateFeedback() {
    const feedback = this.feedback;
    const image = this.images[this.imageIndex];
    const screen = this.screen;
    let feedbackIndex = BORDER_ROWS * TEXTURE_SIZE;
    for (let index = 0; index < SCREEN_PIXELS; index++, feedbackIndex++) {
      const first = firstPackedBlend(feedback[feedbackIndex], image[index],
        this.imageWeight, this.imageInverseWeight);
      feedback[feedbackIndex] = secondPackedBlend(first, screen[index],
        this.feedbackWeight, this.warpedWeight);
    }
  }

  step(visibleTime, engineTime) {
    this.updateParameters(visibleTime, engineTime);
    this.buildGrid(engineTime);
    // Render-before-update ordering is essential: screen is the warp of the
    // previous feedback state, and that displayed screen feeds the next state.
    this.warpFeedback();
    this.updateFeedback();
  }

  renderPacked(time) {
    if (!this.simulateTo(time)) return null;
    return this.screen;
  }

  renderRGBA(time, target = this.rgba) {
    const packed = this.renderPacked(time);
    if (!packed) return null;
    if (!ArrayBuffer.isView(target) || target.length !== SCREEN_PIXELS * 4) {
      throw new RangeError('RGBA target must contain exactly 512x384x4 bytes');
    }
    for (let index = 0, offset = 0; index < SCREEN_PIXELS;
        index++, offset += 4) {
      const color = packed[index];
      target[offset] = (color >>> 16) & 255;
      target[offset + 1] = (color >>> 8) & 255;
      target[offset + 2] = color & 255;
      target[offset + 3] = 255;
    }
    return target;
  }

  render(context, time) {
    const pixels = this.renderRGBA(time);
    if (!pixels) return false;
    let image = this.contextImages.get(context);
    if (!image) {
      image = context.createImageData(WIDTH, HEIGHT);
      this.contextImages.set(context, image);
    }
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
    return true;
  }
}
