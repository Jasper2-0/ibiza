/*
 * Persistent priority-666 noise object (FUN_00406d50/FUN_00406de0).
 *
 * The executable constructs this object once.  Its generator is advanced by
 * the opening and comic scenes, remains dormant while the value is zero, then
 * resumes here without being seeded again.  Rendering is tied to native host
 * passes: a skipped browser frame still consumes every intervening 512x384
 * generator pass, while a repeated render of the same pass consumes none.
 */

import { COMIC_NOISE_CONTINUITY } from './comic-effect.js';
import {
  PART_A_TIMER_LEAD,
  PART_A_UPDATE_TRACE
} from './particle-effects.js';

const WIDTH = 512;
const HEIGHT = 384;
const PIXELS = WIDTH * HEIGHT;
const NOISE_START = 135.475;
const ROCK_TIMER_START = 139.275;
const ROCK_PRESENTATION_START = 139.35;
const ROCK_FPS = 60;
const FADE_IN_DURATION = 5;
const FADE_OUT_DURATION = 0.5;
const TRIG_STEP = 0.000766990234375;

const COS = new Int32Array(8192);
for (let index = 0; index < COS.length; index++) {
  COS[index] = Math.trunc(Math.cos(index * TRIG_STEP) * 8192);
}

function rotl32(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function nextNativeNoiseState(state) {
  return (rotl32((state ^ 157) >>> 0, 11) + 157) >>> 0;
}

function interpolateUpdates(trace, time) {
  if (time <= trace[0].time) return trace[0].updates;
  let upper = 1;
  while (upper < trace.length && time > trace[upper].time) upper++;
  if (upper >= trace.length) upper = trace.length - 1;
  const first = trace[upper - 1];
  const second = trace[upper];
  const amount = (time - first.time) / (second.time - first.time);
  return first.updates + (second.updates - first.updates) * amount;
}

function interpolateTime(trace, updates) {
  if (updates <= trace[0].updates) return trace[0].time;
  let upper = 1;
  while (upper < trace.length && updates > trace[upper].updates) upper++;
  if (upper >= trace.length) upper = trace.length - 1;
  const first = trace[upper - 1];
  const second = trace[upper];
  const amount = (updates - first.updates) / (second.updates - first.updates);
  return first.time + (second.time - first.time) * amount;
}

function easeByte(progress) {
  const angle = Math.trunc(progress * 4096) & 8191;
  return (8192 - COS[angle]) >> 6;
}

const PART_A_TRACE = PART_A_UPDATE_TRACE;
// The callback falls between native updates 779 and 780.  FUN_00406de0 has
// retained update 779's timer stamp while dormant, so the first rising pass
// integrates the full delta from that stamp before it draws.
const PREVIOUS_UPDATE = Math.floor(interpolateUpdates(PART_A_TRACE, NOISE_START));
const FIRST_NOISE_UPDATE = PREVIOUS_UPDATE + 1;
const ROCK_UPDATE = PART_A_TRACE[PART_A_TRACE.length - 1].updates;
const PREVIOUS_TIMER = interpolateTime(PART_A_TRACE, PREVIOUS_UPDATE) +
  PART_A_TIMER_LEAD;
const PRE_ROCK_UPDATE = ROCK_UPDATE - 1;
const PRE_ROCK_TIMER = interpolateTime(PART_A_TRACE, PRE_ROCK_UPDATE) +
  PART_A_TIMER_LEAD;
// Updates 780..1029 have a positive value and therefore consume complete RNG
// passes. Update 1030 clamps the value to zero before the pixel loop.
const FINAL_DORMANT_STATE = 0x068040a3;

function nativeUpdateForTime(time) {
  if (time < NOISE_START) return PREVIOUS_UPDATE;
  if (time < ROCK_PRESENTATION_START) {
    if (time >= ROCK_TIMER_START) return PRE_ROCK_UPDATE;
    return Math.min(ROCK_UPDATE,
      Math.floor(interpolateUpdates(PART_A_TRACE, time) + 1e-7));
  }
  return ROCK_UPDATE +
    Math.floor((time - ROCK_PRESENTATION_START) * ROCK_FPS + 1e-7);
}

function nativeTimerForUpdate(update) {
  if (update <= ROCK_UPDATE) {
    return interpolateTime(PART_A_TRACE, update) + PART_A_TIMER_LEAD;
  }
  return ROCK_TIMER_START + PART_A_TIMER_LEAD +
    (update - ROCK_UPDATE) / ROCK_FPS;
}

function amountForUpdate(update) {
  if (update < FIRST_NOISE_UPDATE) return 0;
  if (update < ROCK_UPDATE) {
    return Math.min(1,
      (nativeTimerForUpdate(update) - PREVIOUS_TIMER) / FADE_IN_DURATION);
  }
  // sync_2860 changes direction and duration before this host pass renders.
  // Therefore the 1007->1008 delta is already integrated at -2/s.
  const amountBeforeDirectionChange =
    (PRE_ROCK_TIMER - PREVIOUS_TIMER) / FADE_IN_DURATION;
  return Math.max(0, amountBeforeDirectionChange -
    (nativeTimerForUpdate(update) - PRE_ROCK_TIMER) / FADE_OUT_DURATION);
}

function advanceNoisePass(state) {
  let result = state >>> 0;
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    result = nextNativeNoiseState(result);
  }
  return result;
}

export class PartANoiseEffect {
  constructor() {
    this.initialState = COMIC_NOISE_CONTINUITY.dormantState;
    // Entry n is the generator state before active native noise pass n.
    this.passSeeds = [this.initialState];
    this.imageDataByContext = new WeakMap();
  }

  seedForPass(pass) {
    let state = this.passSeeds[this.passSeeds.length - 1];
    while (this.passSeeds.length <= pass) {
      state = advanceNoisePass(state);
      this.passSeeds.push(state);
    }
    return this.passSeeds[pass];
  }

  stateAt(time) {
    const update = nativeUpdateForTime(time);
    const amount = amountForUpdate(update);
    if (amount <= 0) {
      return {
        update,
        pass: -1,
        amount: 0,
        seed: update < FIRST_NOISE_UPDATE
          ? this.initialState
          : FINAL_DORMANT_STATE
      };
    }
    const pass = update - FIRST_NOISE_UPDATE;
    return { update, pass, amount, seed: this.seedForPass(pass) };
  }

  render(ctx, time) {
    const state = this.stateAt(time);
    if (state.amount <= 0) return;

    const source = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    let image = this.imageDataByContext.get(ctx);
    if (!image) {
      image = ctx.createImageData(WIDTH, HEIGHT);
      this.imageDataByContext.set(ctx, image);
    }
    const input = source.data;
    const output = image.data;
    let randomState = state.seed;

    // The rising layer changes direction before reaching one; its measured
    // maximum is about .75932, so every active pass takes the blend path.
    const noiseWeight = easeByte(state.amount);
    const oldWeight = 255 - noiseWeight;
    for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
      randomState = nextNativeNoiseState(randomState);
      const noise = randomState & 255;
      output[offset] = (input[offset] * oldWeight + noise * noiseWeight) >> 8;
      output[offset + 1] = (input[offset + 1] * oldWeight + noise * noiseWeight) >> 8;
      output[offset + 2] = (input[offset + 2] * oldWeight + noise * noiseWeight) >> 8;
      output[offset + 3] = 255;
    }

    // Save the post-pass state without re-running the 196,608-step chain on
    // the common next-frame path.
    if (this.passSeeds.length === state.pass + 1) {
      this.passSeeds.push(randomState);
    }
    ctx.putImageData(image, 0, 0);
  }
}
