// Exact packed common-transition layers used after the IFS scene.
//
// Native routines:
//   FUN_004016d0  live-framebuffer crossfade
//   FUN_004032d0  persistent black layer
//   FUN_00403440  persistent white layer
//   FUN_00406de0  persistent noise layer

const WIDTH = 512;
const HEIGHT = 384;
const PIXELS = WIDTH * HEIGHT;
const TRIG_STEP = 0.000766990234375;
// The persistent generator is never reseeded.  The release run consumes 343
// additional dormant-to-dormant host passes in its earlier active intervals
// beyond the nominal 60 Hz reconstruction, so this is the seed actually
// waiting at sync_2810 in the captured run.
const NOISE_INITIAL_SEED = 0x6b820d08;
const NOISE_START = 252.675;
const FINALE_START = 254.475;
const NOISE_FADE_IN = 5;
const NOISE_FADE_OUT = 2;
const NOISE_FPS = 59;
// NOISE_INITIAL_SEED after 106 complete 512x384 native noise passes.  Released
// frames 254.500..255.000 then correlate with native passes 450..479.
const FINALE_NOISE_SEED = 0xc71d60c2;

const COS = new Int16Array(8192);
for (let index = 0; index < COS.length; index++) {
  COS[index] = Math.trunc(Math.cos(index * TRIG_STEP) * 8192);
}

function easeByte(progress) {
  const angle = Math.trunc(progress * 4096) & 8191;
  return (8192 - COS[angle]) >> 6;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function nextNoise(state) {
  const mixed = (state ^ 157) >>> 0;
  return ((((mixed << 11) | (mixed >>> 21)) >>> 0) + 157) >>> 0;
}

function packImage(image, name) {
  if (!image?.data || image.data.length !== PIXELS * 4) {
    throw new RangeError(`${name} must contain exactly 512x384 RGBA pixels`);
  }
  const packed = new Uint32Array(PIXELS);
  const source = image.data;
  for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
    packed[pixel] = (source[offset] << 16) |
      (source[offset + 1] << 8) | source[offset + 2];
  }
  return packed;
}

function advanceNoisePass(state) {
  let result = state >>> 0;
  for (let pixel = 0; pixel < PIXELS; pixel++) result = nextNoise(result);
  return result;
}

export class LateTransitionEffect {
  constructor({ x44RGBA, x46RGBA } = {}) {
    this.targets = Object.freeze({
      x44: packImage(x44RGBA, 'x44'),
      x46: packImage(x46RGBA, 'x46')
    });
    // Each entry is the generator state immediately before that pass.
    this.risingSeeds = [NOISE_INITIAL_SEED];
    this.fallingSeeds = [FINALE_NOISE_SEED];
    this.imageByContext = new WeakMap();
  }

  imageFor(context) {
    let image = this.imageByContext.get(context);
    if (!image) {
      image = context.createImageData(WIDTH, HEIGHT);
      this.imageByContext.set(context, image);
    }
    return image;
  }

  seedForPass(cache, pass) {
    let state = cache[cache.length - 1];
    while (cache.length <= pass) {
      state = advanceNoisePass(state);
      cache.push(state);
    }
    return cache[pass];
  }

  noiseState(time) {
    if (time < NOISE_START || time >= FINALE_START + NOISE_FADE_OUT) return null;
    if (time < FINALE_START) {
      const progress = clamp01((time - NOISE_START) / NOISE_FADE_IN);
      if (progress <= 0) return null;
      const pass = Math.max(0,
        Math.floor((time - NOISE_START) * NOISE_FPS + 1e-7));
      return {
        amount: progress,
        seed: this.seedForPass(this.risingSeeds, pass)
      };
    }
    const progress = clamp01(1 - (time - FINALE_START) / NOISE_FADE_OUT);
    if (progress <= 0) return null;
    const pass = Math.max(0,
      Math.floor((time - FINALE_START) * NOISE_FPS + 1e-7));
    return {
      amount: progress,
      seed: this.seedForPass(this.fallingSeeds, pass)
    };
  }

  crossfadeLive(context, targetName, time, cue, duration) {
    const state = clamp01((time - cue) / duration);
    if (state <= 0) return;
    const target = this.targets[targetName];
    if (!target) throw new RangeError(`Unknown transition target ${targetName}`);
    const source = context.getImageData(0, 0, WIDTH, HEIGHT).data;
    const output = this.imageFor(context).data;

    if (state >= 1) {
      for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
        const color = target[pixel];
        output[offset] = color >>> 16;
        output[offset + 1] = (color >>> 8) & 255;
        output[offset + 2] = color & 255;
        output[offset + 3] = 255;
      }
    } else {
      const targetWeight = easeByte(state);
      const sourceWeight = 255 - targetWeight;
      for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
        const color = target[pixel];
        output[offset] = (source[offset] * sourceWeight +
          (color >>> 16) * targetWeight) >> 8;
        output[offset + 1] = (source[offset + 1] * sourceWeight +
          ((color >>> 8) & 255) * targetWeight) >> 8;
        output[offset + 2] = (source[offset + 2] * sourceWeight +
          (color & 255) * targetWeight) >> 8;
        output[offset + 3] = 255;
      }
    }
    context.putImageData(this.imageFor(context), 0, 0);
  }

  // Applies the scheduler's persistent priority-98/99/666 layers in order.
  compositePersistent(context, {
    blackState = 1,
    whiteState = 0,
    noiseTime = null
  } = {}) {
    const frame = context.getImageData(0, 0, WIDTH, HEIGHT);
    const pixels = frame.data;
    const white = clamp01(whiteState);
    const whiteWeight = white > 0 && white < 1 ? easeByte(white) : 0;
    const noise = noiseTime === null ? null : this.noiseState(noiseTime);
    const noiseWeight = noise && noise.amount < 1 ? easeByte(noise.amount) : 255;
    const oldNoiseWeight = 255 - noiseWeight;
    let random = noise?.seed ?? 0;

    for (let offset = 0; offset < pixels.length; offset += 4) {
      let red;
      let green;
      let blue;
      if (blackState <= 0) {
        red = 0;
        green = 0;
        blue = 0;
      } else {
        // The black layer remains at its state-one endpoint throughout the
        // late scene: endpoint one is 255/256, deliberately not identity.
        red = pixels[offset] * 255 >> 8;
        green = pixels[offset + 1] * 255 >> 8;
        blue = pixels[offset + 2] * 255 >> 8;
      }

      if (white >= 1) {
        red = 255;
        green = 255;
        blue = 255;
      } else if (white > 0) {
        const inverse = 255 - whiteWeight;
        red = Math.min(255, (red * inverse >> 8) + whiteWeight);
        green = Math.min(255, (green * inverse >> 8) + whiteWeight);
        blue = Math.min(255, (blue * inverse >> 8) + whiteWeight);
      }

      if (noise) {
        random = nextNoise(random);
        const gray = random & 255;
        if (noise.amount >= 1) {
          red = gray;
          green = gray;
          blue = gray;
        } else {
          red = (red * oldNoiseWeight + gray * noiseWeight) >> 8;
          green = (green * oldNoiseWeight + gray * noiseWeight) >> 8;
          blue = (blue * oldNoiseWeight + gray * noiseWeight) >> 8;
        }
      }

      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 255;
    }
    context.putImageData(frame, 0, 0);
  }
}
