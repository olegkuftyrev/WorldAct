/** Prove a conservative decoded size before asking Web Audio to allocate PCM.
 * Unrecognized containers remain playable through the native audio fallback. */
export function boundedAudioFrames(
  bytes: ArrayBuffer,
  maxPCMBytes: number,
  sampleRate = 8000,
): boolean {
  const b = new Uint8Array(bytes),
    v = new DataView(bytes),
    text = (at: number, len: number) =>
      String.fromCharCode(...b.subarray(at, at + len));
  if (b.length >= 44 && text(0, 4) === "RIFF" && text(8, 4) === "WAVE") {
    if (v.getUint32(4, true) + 8 !== b.length) return false;
    let format = 0,
      channels = 0,
      rate = 0,
      byteRate = 0,
      align = 0,
      bits = 0,
      data = 0,
      formats = 0,
      dataChunks = 0,
      at = 12;
    for (; at + 8 <= b.length; ) {
      const size = v.getUint32(at + 4, true),
        end = at + 8 + size;
      if (end > b.length) return false;
      if (text(at, 4) === "fmt " && (size < 16 || ++formats !== 1))
        return false;
      if (text(at, 4) === "fmt " && size >= 16) {
        format = v.getUint16(at + 8, true);
        channels = v.getUint16(at + 10, true);
        rate = v.getUint32(at + 12, true);
        byteRate = v.getUint32(at + 16, true);
        align = v.getUint16(at + 20, true);
        bits = v.getUint16(at + 22, true);
      }
      if (text(at, 4) === "data") {
        if (++dataChunks !== 1) return false;
        data += size;
      }
      at = end + (size & 1);
    }
    if (at !== b.length || formats !== 1 || dataChunks !== 1) return false;
    if (
      ![1, 3].includes(format) ||
      channels < 1 ||
      channels > 8 ||
      rate < 8000 ||
      rate > 192000 ||
      !(format === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bits) ||
      align !== (channels * bits) / 8 ||
      byteRate !== rate * align ||
      !data ||
      data % align
    )
      return false;
    return (
      Math.ceil((data / align / rate) * sampleRate + 4096) * channels * 4 <=
      maxPCMBytes
    );
  }
  let at = 0;
  if (text(0, 3) === "ID3") {
    if (
      b.length < 10 ||
      b[3] < 2 ||
      b[3] > 4 ||
      b.subarray(6, 10).some((value) => value > 127)
    )
      return false;
    const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
    at = 10 + size + (b[5] & 16 && b[3] === 4 ? 10 : 0);
    if (at > b.length) return false;
  }
  let frames = 0,
    duration = 0,
    maxChannels = 0,
    declaredFrames = 0,
    configuration = "";
  while (at + 4 <= b.length) {
    if (b.length - at === 128 && text(at, 3) === "TAG") {
      at = b.length;
      break;
    }
    const header = v.getUint32(at),
      version = (header >>> 19) & 3,
      layer = (header >>> 17) & 3,
      bitrateIndex = (header >>> 12) & 15,
      rateIndex = (header >>> 10) & 3;
    if (
      header >>> 21 !== 2047 ||
      version === 1 ||
      layer !== 1 ||
      bitrateIndex < 1 ||
      bitrateIndex > 14 ||
      rateIndex === 3
    )
      return false;
    const rate =
        [44100, 48000, 32000][rateIndex] /
        (version === 3 ? 1 : version === 2 ? 2 : 4),
      bitrate = (
        version === 3
          ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
          : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
      )[bitrateIndex],
      channels = ((header >>> 6) & 3) === 3 ? 1 : 2;
    const currentConfiguration = `${version}:${rate}:${channels}`;
    if (configuration && configuration !== currentConfiguration) return false;
    configuration = currentConfiguration;
    const length =
      Math.floor(((version === 3 ? 144000 : 72000) * bitrate) / rate) +
      ((header >>> 9) & 1);
    if (length < 4 || at + length > b.length) return false;
    if (frames === 0) {
      const xing =
        at +
        4 +
        (header & 65536 ? 0 : 2) +
        (version === 3 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17);
      if (
        xing + 12 <= at + length &&
        ["Xing", "Info"].includes(text(xing, 4)) &&
        v.getUint32(xing + 4) & 1
      )
        declaredFrames = v.getUint32(xing + 8);
      if (at + 54 <= at + length && text(at + 36, 4) === "VBRI")
        declaredFrames = Math.max(declaredFrames, v.getUint32(at + 50));
    }
    frames++;
    duration += (version === 3 ? 1152 : 576) / rate;
    maxChannels = Math.max(maxChannels, channels);
    at += length;
  }
  return (
    frames > 0 &&
    at === b.length &&
    declaredFrames <= frames + 2 &&
    Math.ceil(duration * sampleRate + 4096) * maxChannels * 4 <= maxPCMBytes
  );
}
