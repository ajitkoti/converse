// Converts Float32 audio (at the AudioContext rate, forced to 16 kHz) into
// linear16 PCM chunks and posts them to the main thread. Channel tagging and
// transport happen there.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._target = 1600; // ~100ms at 16kHz
  }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch && ch.length) {
      for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);
      if (this._buf.length >= this._target) {
        const frame = this._buf;
        this._buf = [];
        const pcm = new Int16Array(frame.length);
        for (let i = 0; i < frame.length; i++) {
          let s = Math.max(-1, Math.min(1, frame[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("pcm", PCMProcessor);
