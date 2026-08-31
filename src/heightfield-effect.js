// Exact software port of demo.exe:FUN_0040a0e0 (the x19/x26.pcx scene).
//
// The executable adds this object at XM order 0x0e and removes it when the x9
// transition first renders at order 0x12. The 84.675/103.875 values below are
// capture/PTC scheduler cues; mixer row-zero frames are 3,732,474 and 4,578,810.
// The later 197.475 s object is a different renderer (FUN_0040ccd0, x21..x27).

const WIDTH = 512;
const HEIGHT = 384;
const MAP_SIZE = 512;
const MAP_PIXELS = MAP_SIZE * MAP_SIZE;
const LOW_WIDTH = 129;
const LOW_HEIGHT = 97;
// The effect has several deliberately frame-counted filters.  The reference
// executable capture advances them at 59 renders/second.  The released video
// is encoded at 30 fps, but fitting the camera path across 88–102 seconds
// identifies the underlying frame-counted update cadence independently.
const DEFAULT_FPS = 59;
const START_TIME = 84.675;
const END_TIME = 103.875;
const CHECKPOINT_INTERVAL = 120;

// Literal at demo.exe:00439b60.  It is close to, but not exactly, 2*pi/8192.
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

function divideSigned(value, divisor) {
  return Math.trunc((value | 0) / divisor) | 0;
}

function sourcePixels(source) {
  if (!source) throw new TypeError('A raster source is required');
  if (ArrayBuffer.isView(source)) return source;
  if (ArrayBuffer.isView(source.data)) return source.data;

  const context = source.ctx ||
    (typeof source.getContext === 'function'
      ? source.getContext('2d', { willReadFrequently: true })
      : null);
  if (!context || typeof context.getImageData !== 'function') {
    throw new TypeError('Expected raw pixels, ImageData, or a readable canvas');
  }
  const width = source.width || MAP_SIZE;
  const height = source.height || MAP_SIZE;
  return context.getImageData(0, 0, width, height).data;
}

function makeColorMap(source) {
  const pixels = sourcePixels(source);
  if (pixels instanceof Uint32Array && pixels.length === MAP_PIXELS) {
    const result = new Uint32Array(MAP_PIXELS);
    for (let index = 0; index < MAP_PIXELS; index++) {
      result[index] = pixels[index] & 0x00ffffff;
    }
    return result;
  }
  if (pixels.length !== MAP_PIXELS * 4) {
    throw new RangeError('x19 must contain exactly 512x512 RGBA pixels');
  }

  const result = new Uint32Array(MAP_PIXELS);
  for (let pixel = 0, offset = 0; pixel < MAP_PIXELS; pixel++, offset += 4) {
    result[pixel] = (pixels[offset] << 16) |
      (pixels[offset + 1] << 8) | pixels[offset + 2];
  }
  return result;
}

function makeHeightMap(source, rgbaChannel) {
  const pixels = sourcePixels(source);
  if (pixels.length === MAP_PIXELS) return Uint8Array.from(pixels);
  if (pixels.length !== MAP_PIXELS * 4) {
    throw new RangeError('x26.pcx must contain 512x512 bytes or RGBA pixels');
  }

  // FUN_00404d40 converts the PCX to packed 00RRGGBB and copies byte zero.
  // On little-endian x86 that byte is blue; Canvas RGBA therefore uses +2.
  const channel = rgbaChannel ?? 2;
  const result = new Uint8Array(MAP_PIXELS);
  for (let pixel = 0, offset = channel; pixel < MAP_PIXELS; pixel++, offset += 4) {
    result[pixel] = pixels[offset];
  }
  return result;
}

function modalHeight(heightMap) {
  const counts = new Uint32Array(256);
  for (let index = 0; index < heightMap.length; index++) counts[heightMap[index]]++;

  // The constructor scans 255 down to zero and only accepts a strict increase,
  // so equal-frequency ties retain the larger byte value.
  let bestValue = 255;
  let bestCount = 0;
  for (let value = 255; value >= 0; value--) {
    if (counts[value] > bestCount) {
      bestValue = value;
      bestCount = counts[value];
    }
  }
  return bestValue;
}

function scaleColor(color, factor) {
  const red = Math.imul((color >>> 16) & 255, factor) >> 8;
  const green = Math.imul((color >>> 8) & 255, factor) >> 8;
  const blue = Math.imul(color & 255, factor) >> 8;
  return (red << 16) | (green << 8) | blue;
}

function addSaturated(first, second) {
  const red = Math.min(255, ((first >>> 16) & 255) + ((second >>> 16) & 255));
  const green = Math.min(255, ((first >>> 8) & 255) + ((second >>> 8) & 255));
  const blue = Math.min(255, (first & 255) + (second & 255));
  return (red << 16) | (green << 8) | blue;
}

function rotateVertex(x, y, z, sinBank, cosBank, sinPitch, cosPitch,
  sinHeading, cosHeading, output, offset) {
  const bankY = ((Math.imul(y, cosBank) - Math.imul(x, sinBank)) | 0) >> 13;
  const bankX = ((Math.imul(x, cosBank) + Math.imul(y, sinBank)) | 0) >> 13;
  const rotatedY = ((Math.imul(bankY, cosPitch) + Math.imul(z, sinPitch)) | 0) >> 13;
  const pitchZ = ((Math.imul(z, cosPitch) - Math.imul(bankY, sinPitch)) | 0) >> 13;
  const rotatedX = ((Math.imul(bankX, cosHeading) + Math.imul(pitchZ, sinHeading)) | 0) >> 13;
  const rotatedZ = ((Math.imul(pitchZ, cosHeading) - Math.imul(bankX, sinHeading)) | 0) >> 13;
  output[offset] = rotatedX;
  output[offset + 1] = rotatedY;
  output[offset + 2] = rotatedZ;
}

export class HeightfieldEffect {
  constructor(options = {}) {
    const colorSource = options.colorMap ?? options.colorRGBA ?? options.x19;
    const heightSource = options.heightMap ?? options.heightRGBA ?? options.x26;
    this.colorMap = makeColorMap(colorSource);
    this.heightMap = makeHeightMap(heightSource, options.heightChannel);
    this.waterHeight = modalHeight(this.heightMap);

    this.start = options.startTime ?? START_TIME;
    this.end = options.endTime ?? END_TIME;
    this.fps = options.fps ?? DEFAULT_FPS;
    if (!(this.fps > 0)) throw new RangeError('fps must be positive');

    this.maxFrame = Math.max(0,
      Math.ceil((this.end - this.start) * this.fps - 1e-9) - 1);
    this.low = new Uint32Array(LOW_WIDTH * LOW_HEIGHT);
    this.rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    this.vertices = new Int32Array(12);
    this.checkpoints = [];
    this.contextImages = new WeakMap();
    this.reset();
  }

  reset() {
    this.pitch = -4048;
    this.heading = 0;
    this.bank = 0;
    this.cameraX = 0;
    this.altitude = 0x60000;
    this.cameraZ = 0;
    this.steerVelocity = 0;
    this.lastTime = -1;
    this.frame = -1;
    this.checkpoints.length = 0;
  }

  isActive(musicTime) {
    return musicTime >= this.start && musicTime < this.end;
  }

  frameForTime(musicTime) {
    if (!this.isActive(musicTime)) return -1;
    return Math.min(this.maxFrame,
      Math.max(0, Math.floor((musicTime - this.start) * this.fps + 1e-7)));
  }

  snapshot() {
    this.checkpoints.push({
      frame: this.frame,
      pitch: this.pitch,
      heading: this.heading,
      bank: this.bank,
      cameraX: this.cameraX,
      altitude: this.altitude,
      cameraZ: this.cameraZ,
      steerVelocity: this.steerVelocity,
      lastTime: this.lastTime
    });
  }

  restore(checkpoint) {
    if (!checkpoint) {
      const checkpoints = this.checkpoints;
      this.checkpoints = [];
      this.reset();
      this.checkpoints = checkpoints;
      return;
    }
    this.frame = checkpoint.frame;
    this.pitch = checkpoint.pitch;
    this.heading = checkpoint.heading;
    this.bank = checkpoint.bank;
    this.cameraX = checkpoint.cameraX;
    this.altitude = checkpoint.altitude;
    this.cameraZ = checkpoint.cameraZ;
    this.steerVelocity = checkpoint.steerVelocity;
    this.lastTime = checkpoint.lastTime;
  }

  simulateTo(musicTime) {
    const target = this.frameForTime(musicTime);
    if (target < 0) return false;

    if (target < this.frame) {
      let best = null;
      for (const checkpoint of this.checkpoints) {
        if (checkpoint.frame <= target && (!best || checkpoint.frame > best.frame)) {
          best = checkpoint;
        }
      }
      this.restore(best);
    }

    while (this.frame < target) {
      const nextFrame = this.frame + 1;
      const frameTime = this.start + nextFrame / this.fps;
      this.stepState(frameTime);
      this.frame = nextFrame;
      if ((nextFrame + 1) % CHECKPOINT_INTERVAL === 0 &&
          !this.checkpoints.some(checkpoint => checkpoint.frame === nextFrame)) {
        this.snapshot();
      }
    }
    return true;
  }

  stepState(time) {
    let delta = 0;
    if (this.lastTime !== -1) delta = time - this.lastTime;
    this.lastTime = time;

    // These three smoothing operations are deliberately per-frame, not dt
    // based, exactly as in the executable.
    this.pitch = Math.trunc(this.pitch * 0.97 - 6) | 0;

    const cameraIndex = (((this.cameraZ >> 9) & 511) << 9) |
      ((this.cameraX >> 9) & 511);
    const targetAltitude = (this.heightMap[cameraIndex] + 8) << 8;
    // The executable loads these as single-precision constants.  It climbs
    // rapidly toward higher terrain and eases downward more slowly.
    const altitudeRate = targetAltitude > this.altitude
      ? Math.fround(0.4)
      : Math.fround(0.08);
    this.altitude = Math.trunc(
      this.altitude + (targetAltitude - this.altitude) * altitudeRate) | 0;

    let bestHeight = 255;
    let bestOffset = 0;
    let negativeAngle = this.heading;
    let positiveAngle = this.heading;
    for (let sample = 0; sample < 8; sample++) {
      let x = (this.cameraX >> 9) + (sinQ13(negativeAngle) >> 7);
      let z = (this.cameraZ >> 9) + (cosQ13(negativeAngle) >> 7);
      let height = this.heightMap[((z & 511) << 9) | (x & 511)];
      if (height < bestHeight) {
        bestHeight = height;
        bestOffset = (negativeAngle - this.heading) | 0;
      }

      x = (this.cameraX >> 9) + (sinQ13(positiveAngle) >> 7);
      z = (this.cameraZ >> 9) + (cosQ13(positiveAngle) >> 7);
      height = this.heightMap[((z & 511) << 9) | (x & 511)];
      if (height < bestHeight) {
        bestHeight = height;
        bestOffset = (positiveAngle - this.heading) | 0;
      }
      negativeAngle = (negativeAngle - 160) | 0;
      positiveAngle = (positiveAngle + 160) | 0;
    }

    this.steerVelocity = ((Math.imul(this.steerVelocity, 210) +
      Math.imul(bestOffset, 46)) | 0) >> 8;
    const velocitySquared = Math.imul(this.steerVelocity, this.steerVelocity);
    this.heading = Math.trunc(
      this.heading + this.steerVelocity * 2 * delta) | 0;
    this.bank = Math.trunc(
      this.bank + (this.steerVelocity - this.bank) * 0.41) | 0;

    const speed = 3 - velocitySquared * 0.00001;
    this.cameraX = Math.trunc(
      this.cameraX + sinQ13(this.heading) * speed * delta) | 0;
    this.cameraZ = Math.trunc(
      this.cameraZ + cosQ13(this.heading) * speed * delta) | 0;
  }

  buildRays() {
    const sinBank = sinQ13(this.bank);
    const cosBank = cosQ13(this.bank);
    const sinPitch = sinQ13(this.pitch);
    const cosPitch = cosQ13(this.pitch);
    const sinHeading = sinQ13(this.heading);
    const cosHeading = cosQ13(this.heading);
    const vertices = this.vertices;

    rotateVertex(-0x20000, 0x18000, 0x20000,
      sinBank, cosBank, sinPitch, cosPitch, sinHeading, cosHeading, vertices, 0);
    rotateVertex(0x20000, 0x18000, 0x20000,
      sinBank, cosBank, sinPitch, cosPitch, sinHeading, cosHeading, vertices, 3);
    rotateVertex(-0x20000, -0x18000, 0x20000,
      sinBank, cosBank, sinPitch, cosPitch, sinHeading, cosHeading, vertices, 6);
    rotateVertex(0x20000, -0x18000, 0x20000,
      sinBank, cosBank, sinPitch, cosPitch, sinHeading, cosHeading, vertices, 9);
  }

  raymarch() {
    this.buildRays();
    const vertices = this.vertices;
    const heightMap = this.heightMap;
    const colorMap = this.colorMap;
    const low = this.low;

    let leftX = vertices[0];
    let leftY = vertices[1];
    let leftZ = vertices[2];
    const leftStepX = divideSigned((vertices[6] - vertices[0]) | 0, LOW_HEIGHT);
    const leftStepY = divideSigned((vertices[7] - vertices[1]) | 0, LOW_HEIGHT);
    const leftStepZ = divideSigned((vertices[8] - vertices[2]) | 0, LOW_HEIGHT);
    const rightStepX = divideSigned((vertices[9] - vertices[3]) | 0, LOW_HEIGHT);
    const rightStepY = divideSigned((vertices[10] - vertices[4]) | 0, LOW_HEIGHT);
    const rightStepZ = divideSigned((vertices[11] - vertices[5]) | 0, LOW_HEIGHT);
    let rightX = vertices[3];
    let rightY = vertices[4];
    let rightZ = vertices[5];

    let output = 0;
    for (let row = 0; row < LOW_HEIGHT; row++) {
      // Recompute these every row.  The /97 edge increments truncate
      // independently, so the two integer edges are not exact translations.
      const columnStepX = divideSigned((rightX - leftX) | 0, LOW_WIDTH);
      const columnStepY = divideSigned((rightY - leftY) | 0, LOW_WIDTH);
      const columnStepZ = divideSigned((rightZ - leftZ) | 0, LOW_WIDTH);
      let rayX = leftX;
      let rayY = leftY;
      let rayZ = leftZ;
      for (let column = 0; column < LOW_WIDTH; column++) {
        let dx = rayX >> 8;
        let dy = rayY >> 8;
        let dz = rayZ >> 8;
        let worldX = this.cameraX;
        let worldY = this.altitude;
        let worldZ = this.cameraZ;
        let level = 1;
        let remaining = 0;
        let hit = false;
        let mapIndex = 0;

        do {
          remaining = 256 >> level;
          do {
            worldX = (worldX + dx) | 0;
            worldY = (worldY + dy) | 0;
            worldZ = (worldZ + dz) | 0;
            mapIndex = (((worldZ >> 9) & 511) << 9) | ((worldX >> 9) & 511);
            hit = heightMap[mapIndex] >= (worldY >> 8);
            remaining--;
          } while (remaining > 0 && !hit);
          dx = (dx << 1) | 0;
          dy = (dy << 1) | 0;
          dz = (dz << 1) | 0;
          level++;
        } while (!hit && level < 3);

        let color = 0;
        if (hit) {
          const factor = level === 3 ? remaining << 2 : 255;
          color = scaleColor(colorMap[mapIndex], factor);
          const hitLevel = level - 1;

          if (heightMap[mapIndex] <= this.waterHeight && hitLevel < 3) {
            dx >>= 1;
            dy = -(dy >> 1);
            dz >>= 1;
            worldX = (worldX + dx * 2) | 0;
            worldY = (worldY + dy * 2) | 0;
            worldZ = (worldZ + dz * 2) | 0;
            level = hitLevel;
            let firstGroup = true;
            let reflectedHit = false;

            do {
              let reflectionRemaining = firstGroup ? remaining + 1 : 256 >> level;
              firstGroup = false;
              do {
                worldX = (worldX + dx) | 0;
                worldY = (worldY + dy) | 0;
                worldZ = (worldZ + dz) | 0;
                mapIndex = (((worldZ >> 9) & 511) << 9) | ((worldX >> 9) & 511);
                reflectedHit = heightMap[mapIndex] >= (worldY >> 8);
                reflectionRemaining--;
              } while (reflectionRemaining > 0 && !reflectedHit);
              dx = (dx << 1) | 0;
              dy = (dy << 1) | 0;
              dz = (dz << 1) | 0;
              level++;

              if (reflectedHit) {
                const reflectionFactor = level === 3
                  ? reflectionRemaining << 2
                  : 255;
                color = addSaturated(color,
                  scaleColor(colorMap[mapIndex], reflectionFactor));
                break;
              }
            } while (level < 3);
          }
        }
        low[output++] = color;
        rayX = (rayX + columnStepX) | 0;
        rayY = (rayY + columnStepY) | 0;
        rayZ = (rayZ + columnStepZ) | 0;
      }

      leftX = (leftX + leftStepX) | 0;
      leftY = (leftY + leftStepY) | 0;
      leftZ = (leftZ + leftStepZ) | 0;
      rightX = (rightX + rightStepX) | 0;
      rightY = (rightY + rightStepY) | 0;
      rightZ = (rightZ + rightStepZ) | 0;
    }

  }

  expand(output = this.rgba) {
    const target = ArrayBuffer.isView(output) ? output : output.data;
    if (!target || target.length < WIDTH * HEIGHT * 4) {
      throw new RangeError('Output must provide at least 512x384 RGBA bytes');
    }

    const low = this.low;
    for (let cellY = 0; cellY < LOW_HEIGHT - 1; cellY++) {
      const top = cellY * LOW_WIDTH;
      const bottom = top + LOW_WIDTH;
      for (let cellX = 0; cellX < LOW_WIDTH - 1; cellX++) {
        const topLeft = low[top + cellX];
        const topRight = low[top + cellX + 1];
        const bottomLeft = low[bottom + cellX];
        const bottomRight = low[bottom + cellX + 1];

        let leftRed = topLeft & 0xff0000;
        let leftGreen = topLeft & 0xff00;
        let leftBlue = (topLeft & 255) << 8;
        let rightRed = topRight & 0xff0000;
        let rightGreen = topRight & 0xff00;
        let rightBlue = (topRight & 255) << 8;
        const leftRedStep = ((bottomLeft & 0xff0000) - leftRed) >> 2;
        const leftGreenStep = ((bottomLeft & 0xff00) - leftGreen) >> 2;
        const leftBlueStep = (((bottomLeft & 255) << 8) - leftBlue) >> 2;
        const rightRedStep = ((bottomRight & 0xff0000) - rightRed) >> 2;
        const rightGreenStep = ((bottomRight & 0xff00) - rightGreen) >> 2;
        const rightBlueStep = (((bottomRight & 255) << 8) - rightBlue) >> 2;

        for (let subY = 0; subY < 4; subY++) {
          const redStep = (rightRed - leftRed) >> 2;
          const greenStep = (rightGreen - leftGreen) >> 2;
          const blueStep = (rightBlue - leftBlue) >> 2;
          let red = leftRed;
          let green = leftGreen;
          let blue = leftBlue;
          let destination = (((cellY << 2) + subY) * WIDTH + (cellX << 2)) * 4;
          for (let subX = 0; subX < 4; subX++) {
            target[destination] = (red >>> 16) & 255;
            target[destination + 1] = (green >>> 8) & 255;
            target[destination + 2] = (blue >> 8) & 255;
            target[destination + 3] = 255;
            destination += 4;
            red = (red + redStep) | 0;
            green = (green + greenStep) | 0;
            blue = (blue + blueStep) | 0;
          }
          leftRed = (leftRed + leftRedStep) | 0;
          leftGreen = (leftGreen + leftGreenStep) | 0;
          leftBlue = (leftBlue + leftBlueStep) | 0;
          rightRed = (rightRed + rightRedStep) | 0;
          rightGreen = (rightGreen + rightGreenStep) | 0;
          rightBlue = (rightBlue + rightBlueStep) | 0;
        }
      }
    }
    return target;
  }

  renderRGBA(musicTime, output = this.rgba) {
    if (!this.simulateTo(musicTime)) return null;
    this.raymarch();
    return this.expand(output);
  }

  render(context, musicTime) {
    const pixels = this.renderRGBA(musicTime);
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
