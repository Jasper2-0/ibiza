/* Browser lifecycle wrapper for the atbia3.xm AudioWorklet replayer. */

class XMPlayer {
  constructor({ context } = {}) {
    if (!context) throw new Error('XMPlayer requires an AudioContext');

    this.context = context;
    this.node = null;
    this.loaded = false;
    this._seekSequence = 0;
    this._pauseSequence = 0;
    this._playSequence = 0;
    this._generation = 0;
    this._pendingSeeks = new Map();
    this._pendingPause = null;
    this._pendingPlay = null;
    this._nodePromise = null;
    this._readyPromise = null;
    this._resolveReady = null;
    this._rejectReady = null;
  }

  async ensureNode() {
    if (this.node) return;
    if (!this._nodePromise) {
      this._nodePromise = (async () => {
        if (!this.context.audioWorklet) throw new Error('AudioWorklet is unavailable');
        await this.context.audioWorklet.addModule(new URL('./xm-worklet.js', import.meta.url));
        if (this.node) return;
        const AudioWorkletNodeClass = globalThis.AudioWorkletNode;
        if (!AudioWorkletNodeClass) throw new Error('AudioWorkletNode is unavailable');
        this.node = new AudioWorkletNodeClass(this.context, 'xm-replayer', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        this.node.port.onmessage = event => this.handleMessage(event.data);
        this.node.onprocessorerror = () => {
          const error = new Error('XM AudioWorklet processor failed');
          this.loaded = false;
          this._generation++;
          this.rejectReady(error);
          this.rejectPendingSeeks(error);
          this.rejectPendingPause(error);
          this.cancelPendingPlay(error);
        };
        this.node.connect(this.context.destination);
      })();
    }
    try {
      await this._nodePromise;
    } finally {
      this._nodePromise = null;
    }
  }

  handleMessage(message) {
    if (message.generation !== undefined && message.generation !== this._generation) return;
    if (message.type === 'ready') {
      this.loaded = true;
      if (this._resolveReady) this._resolveReady();
      this._resolveReady = this._rejectReady = null;
      this._readyPromise = null;
      return;
    }
    if (message.type === 'error') {
      const error = new Error(message.message || 'XM player error');
      this.loaded = false;
      this.rejectReady(error);
      this.rejectPendingSeeks(error);
      this.rejectPendingPause(error);
      this.cancelPendingPlay(error);
      return;
    }
    if (message.type === 'seeked') {
      const pending = this._pendingSeeks.get(message.id);
      if (pending) {
        this._pendingSeeks.delete(message.id);
        pending.resolve();
      }
      return;
    }
    if (message.type === 'paused') {
      const pending = this._pendingPause;
      if (pending?.id === message.id) {
        this._pendingPause = null;
        pending.resolve(message.state);
      }
      return;
    }
    if (message.type === 'played') {
      const pending = this._pendingPlay;
      if (pending?.id === message.id) {
        this._pendingPlay = null;
        pending.resolve(message.state);
      }
    }
  }

  rejectReady(error) {
    if (this._rejectReady) this._rejectReady(error);
    this._resolveReady = this._rejectReady = null;
    this._readyPromise = null;
  }

  rejectPendingSeeks(error) {
    for (const pending of this._pendingSeeks.values()) pending.reject(error);
    this._pendingSeeks.clear();
  }

  rejectPendingPause(error) {
    if (this._pendingPause) this._pendingPause.reject(error);
    this._pendingPause = null;
  }

  cancelPendingPlay(error) {
    this._playSequence++;
    if (this._pendingPlay) this._pendingPlay.reject(error);
    this._pendingPlay = null;
  }

  async load(source) {
    if (!(source instanceof ArrayBuffer)) {
      throw new TypeError('XMPlayer.load expects an ArrayBuffer');
    }
    const generation = ++this._generation;
    const superseded = new Error('XM load was superseded');
    this.rejectReady(superseded);
    this.rejectPendingSeeks(superseded);
    this.rejectPendingPause(superseded);
    this.cancelPendingPlay(superseded);
    this.loaded = false;

    await this.ensureNode();
    // The worklet transfer must not detach Demo.audioBytes, which is reused if
    // the browser closes and recreates its AudioContext.
    const buffer = source.slice(0);
    if (generation !== this._generation) throw superseded;
    this._readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    this.node.port.postMessage({ type: 'load', buffer, generation }, [buffer]);
    return this._readyPromise;
  }

  async play() {
    if (!this.loaded) throw new Error('Load an XM module before playing');
    this.cancelPendingPlay(new Error('XM play was superseded'));
    const id = this._playSequence;
    const generation = this._generation;
    const node = this.node;
    if (this.context.state !== 'running') await this.context.resume();
    if (id !== this._playSequence || generation !== this._generation ||
        node !== this.node || !this.loaded) {
      throw new Error('XM play was superseded');
    }
    const pending = new Promise((resolve, reject) => {
      this._pendingPlay = { id, resolve, reject };
    });
    node.port.postMessage({ type: 'play', id, generation });
    return pending;
  }

  pause() {
    if (!this.node || !this.loaded) return Promise.resolve(null);
    this.cancelPendingPlay(new Error('XM play was paused'));
    this.rejectPendingPause(new Error('XM pause was superseded'));
    const id = ++this._pauseSequence;
    const pending = new Promise((resolve, reject) => {
      this._pendingPause = { id, resolve, reject };
    });
    this.node.port.postMessage({ type: 'pause', id, generation: this._generation });
    return pending;
  }

  stop() {
    const generation = ++this._generation;
    const error = new Error('XM playback was stopped');
    this.rejectReady(error);
    this.rejectPendingSeeks(error);
    this.rejectPendingPause(error);
    this.cancelPendingPlay(error);
    if (this.node) this.node.port.postMessage({ type: 'stop', generation });
  }

  seek(seconds) {
    if (!this.loaded) return Promise.reject(new Error('Load an XM module before seeking'));
    const numeric = Number(seconds);
    const requested = Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
    this.cancelPendingPlay(new Error('XM play was superseded by seek'));
    this.rejectPendingSeeks(new Error('XM seek was superseded'));
    const id = ++this._seekSequence;
    return new Promise((resolve, reject) => {
      this._pendingSeeks.set(id, { resolve, reject });
      this.node.port.postMessage({
        type: 'seek',
        id,
        seconds: requested,
        generation: this._generation,
      });
    });
  }

  destroy() {
    this.stop();
    if (this.node) this.node.disconnect();
    this.node = null;
    this.loaded = false;
  }
}

export default XMPlayer;
