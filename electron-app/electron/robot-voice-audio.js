const Opus = require("opusscript");

const IN_RATE = 16000, OUT_RATE = 24000, FRAME_MS = 60, MAX_SECONDS = 20;
function opus(rate) {
  return new Opus(rate, 1, Opus.Application.VOIP);
}
function pcmWav(pcm, rate = IN_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function decodeWav(bytes, rate = OUT_RATE) {
  const invalid = () => Error("语音服务没有返回可播放的 16 位 PCM WAV。");
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw invalid();
  let fmt, pcm;
  for (let i = 12; i + 8 <= bytes.length;) {
    const tag = bytes.toString("ascii", i, i + 4), size = bytes.readUInt32LE(i + 4), start = i + 8;
    const end = tag === "data" && size === 0xffffffff ? bytes.length : start + size;
    if (end > bytes.length) throw invalid();
    if (tag === "fmt " && size >= 16) fmt = bytes.subarray(start, end);
    if (tag === "data") { pcm = bytes.subarray(start, end); break; }
    i = end + (size & 1);
  }
  if (!fmt || !pcm?.length) throw invalid();
  const channels = fmt.readUInt16LE(2), sourceRate = fmt.readUInt32LE(4);
  if (fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(14) !== 16 || ![1, 2].includes(channels) ||
      sourceRate < 8000 || sourceRate > 96000 || pcm.length % (channels * 2)) throw invalid();
  const samples = pcm.length / (channels * 2);
  if (samples > sourceRate * 60) throw Error("合成语音超过 60 秒。");
  if (channels === 1 && rate === sourceRate) return pcm;
  const result = Buffer.alloc(Math.max(1, Math.round(samples * rate / sourceRate)) * 2);
  const sample = n => channels === 1 ? pcm.readInt16LE(n * 2) :
    (pcm.readInt16LE(n * 4) + pcm.readInt16LE(n * 4 + 2)) / 2;
  for (let i = 0; i < result.length / 2; i++) {
    const pos = Math.min(samples - 1, i * sourceRate / rate), a = Math.floor(pos);
    result.writeInt16LE(Math.round(sample(a) * (1 - (pos - a)) + sample(Math.min(a + 1, samples - 1)) * (pos - a)), i * 2);
  }
  return result;
}
function unpack(packet, version) {
  const offset = version === 2 ? 16 : version === 3 ? 4 : 0;
  if (packet.length <= offset || packet.length > offset + 1275) throw Error("小智音频帧长度无效。");
  if (version === 2 && (packet.readUInt16BE(0) !== 2 || packet.readUInt16BE(2) !== 0 ||
    packet.readUInt32BE(12) !== packet.length - offset)) throw Error("小智 v2 音频帧格式无效。");
  if (version === 3 && (packet[0] !== 0 || packet.readUInt16BE(2) !== packet.length - offset)) throw Error("小智 v3 音频帧格式无效。");
  return packet.subarray(offset);
}
function pack(packet, version, timestamp) {
  if (version === 1) return packet;
  const header = Buffer.alloc(version === 2 ? 16 : 4);
  if (version === 2) {
    header.writeUInt16BE(2);
    header.writeUInt32BE(timestamp >>> 0, 8);
    header.writeUInt32BE(packet.length, 12);
  } else header.writeUInt16BE(packet.length, 2);
  return Buffer.concat([header, packet]);
}
function rms(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (pcm.length / 2)) / 32768;
}
module.exports = { IN_RATE, OUT_RATE, FRAME_MS, MAX_SECONDS, opus, pcmWav, decodeWav, pack, unpack, rms };
