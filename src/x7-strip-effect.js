/*
 * Native x7 stacked-strip clock (demo.exe FUN_00401000/401070/4010d0).
 *
 * The strip runs at 30 source frames/second and is scratched by instrument
 * synchronizers 19..24. Callbacks mutate the position retained by the previous
 * render; FUN_00401130 then advances it by the actual elapsed PTC timer delta.
 */

const SAMPLE_RATE = 44100;
const FRAME_COUNT = 250;
const SPEED = 30;
const SEEK_REPLAY_FPS = 60;
const FIRST_EVENT_FRAME = 2779244;

// Exact integer-floor XM replay frames.  The first value is stored above;
// these are the remaining 306 unsigned 16-bit frame deltas.
const EVENT_DELTA_BASE64_PACKED =
  'nAjgRDgRnAjgRHxNqDOcCJwInAicCJwInAicCJwI2N84EXAiOBE4EZwInAhOBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgScCDgRnAi+Jk4E1BmcCNQZnAg4ETgROBGcCKgzqDOcCJwInAicCJwInAicCJwITgROBE4ETgROBE4ETgROBE4EGrk4EXAiOBE4EZwInAhOBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgScCDgRnAjgRDgRnAjgRHxNUGecCJwInAg81zgRcCI4ETgRnAicCE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBJwIOBGcCL4mTgTUGZwI1BmcCDgROBE4EZwIUGecCJwInAicCJwInAicCJwITgROBE4ETgROBE4ETgROBE4EGrk4EXAiOBE4EZwInAhOBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBE4ETgROBJwI';

// Keep the long literal reviewable while restoring its final repeated delta
// run. (The last three base64 characters encode the terminating 1102 delta.)
const EVENT_DELTA_BASE64 = EVENT_DELTA_BASE64_PACKED.slice(0, -3) +
  'E4ETgROB' + EVENT_DELTA_BASE64_PACKED.slice(-3);

// Instrument number minus 19 for each of the 307 events.
const EVENT_CODE_BASE64 =
  'AgIBAgIBBQUFBQUFBQMDAwAAAAEAAQICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBQUFBQUFBQMDAwADAAMAAwADAAAAAAEAAQICAgICAgICAgICAgICAgICAgICAgICAgICAgIBAgIBBQUFBQQAAAABAAEEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAUFBQUFBQMDAwMDAwMDAwMDAwAAAAEAAQICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAw==';

function decodeBytes(base64) {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

function wrapFrame(value) {
  value %= FRAME_COUNT;
  return value < 0 ? value + FRAME_COUNT : value;
}

const codes = decodeBytes(EVENT_CODE_BASE64);
const deltaBytes = decodeBytes(EVENT_DELTA_BASE64);
if (codes.length !== 307 || deltaBytes.length !== (codes.length - 1) * 2) {
  throw new Error('Corrupt x7 instrument callback table');
}

const eventFrames = new Uint32Array(codes.length);
eventFrames[0] = FIRST_EVENT_FRAME;
for (let index = 1; index < eventFrames.length; index++) {
  const offset = (index - 1) * 2;
  const delta = deltaBytes[offset] | (deltaBytes[offset + 1] << 8);
  eventFrames[index] = eventFrames[index - 1] + delta;
}

// BASS playtime sync positions are expressed in the module's playback clock.
const callbackTimes = Float64Array.from(eventFrames,
  frame => frame / SAMPLE_RATE);

function applyCallback(position, code) {
  switch (code + 19) {
    case 19: position = wrapFrame(position - 3); break;
    case 20: position = 110; break;
    case 21: position = wrapFrame(position - 1); break;
    case 22: position = wrapFrame(position - 6); break;
    case 23: position = 60; break;
    // Two callbacks are registered for instrument 24. Registration order is
    // set(200), set(240), so the observable result is exactly 240.
    case 24: position = 240; break;
  }
  return position;
}

export class X7StripEffect {
  constructor({ startTime = 0 } = {}) {
    this.startTime = startTime;
    this.reset();
  }

  advance(time) {
    while (this.nextCallback < callbackTimes.length &&
        callbackTimes[this.nextCallback] <= time) {
      this.position = applyCallback(
        this.position, codes[this.nextCallback]);
      this.nextCallback++;
    }
    if (this.previousTime >= 0) {
      this.position = wrapFrame(
        this.position + (time - this.previousTime) * SPEED);
    }
    this.previousTime = time;
  }

  reset(time = 0) {
    this.position = 0;
    this.previousTime = -1;
    this.nextCallback = 0;
    if (time <= this.startTime) return;

    // Seeking is a browser-only control. Reconstruct it at the released host
    // cadence; live playback below always uses the real render deltas.
    this.advance(this.startTime);
    const fullPasses = Math.floor(
      (time - this.startTime) * SEEK_REPLAY_FPS + 1e-7);
    for (let pass = 1; pass <= fullPasses; pass++) {
      this.advance(this.startTime + pass / SEEK_REPLAY_FPS);
    }
    if (time > this.previousTime + 1e-9) this.advance(time);
  }

  frameAt(time) {
    if (this.previousTime >= 0 && time < this.previousTime) this.reset(time);
    this.advance(time);
    return this.position;
  }
}
