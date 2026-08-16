'use strict'

// ---------------------------------------------------------------------------
//  Acoustics — tier 1 and tier 2 measurement, pure arithmetic
// ---------------------------------------------------------------------------
// Ruling: tiers 1 and 2 only, "随便意思得了 —— 先塞主流现成的算法抛砖引玉,
// 不好用再换". So every number here is a textbook formula, no model, no new
// dependency, no Python. The whole file is replaceable: nodes take their
// numbers from `measureBasic` / `measureSimilarity`, and swapping the innards
// changes no graph.
//
// Hard rule from the design: measurement ONLY produces numbers. Nothing here
// decides whether a clip is good — that is the comparison node's job, because
// the threshold is the user's taste and must not be baked into code.

// ---------------------------------------------------------------------------
//  WAV reading (PCM 16/24/32-bit and 32-bit float, mono-mixed)
// ---------------------------------------------------------------------------

function wavError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function decodeWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw wavError('FG_WAV_NOT_WAV', '这不是一个 WAV 文件，没法测')
  }
  let offset = 12
  let fmt = null
  let dataStart = null
  let dataLength = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataStart = body
      dataLength = Math.min(size, buffer.length - body)
    }
    offset = body + size + (size % 2)
  }
  if (!fmt || dataStart === null) throw wavError('FG_WAV_BROKEN', 'WAV 文件缺了必要的段，可能没写完或者被截断了')

  const { channels, bitsPerSample, sampleRate } = fmt
  const bytes = bitsPerSample / 8
  const frames = Math.floor(dataLength / (bytes * channels))
  const samples = new Float32Array(frames)
  const isFloat = fmt.format === 3

  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (let c = 0; c < channels; c += 1) {
      const at = dataStart + (i * channels + c) * bytes
      let v = 0
      if (isFloat && bytes === 4) v = buffer.readFloatLE(at)
      else if (bytes === 2) v = buffer.readInt16LE(at) / 32768
      else if (bytes === 3) {
        const raw = buffer.readUIntLE(at, 3)
        v = (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608
      } else if (bytes === 4) v = buffer.readInt32LE(at) / 2147483648
      else if (bytes === 1) v = (buffer.readUInt8(at) - 128) / 128
      else throw wavError('FG_WAV_UNSUPPORTED', `暂时读不了 ${bitsPerSample} 位的 WAV`)
      sum += v
    }
    samples[i] = sum / channels
  }
  return { samples, sampleRate, channels, bitsPerSample, duration: frames / sampleRate }
}

// ---------------------------------------------------------------------------
//  Small maths helpers
// ---------------------------------------------------------------------------

const EPS = 1e-10

function mean(values) {
  if (!values.length) return 0
  let s = 0
  for (const v of values) s += v
  return s / values.length
}

function stddev(values) {
  if (values.length < 2) return 0
  const m = mean(values)
  let s = 0
  for (const v of values) s += (v - m) * (v - m)
  return Math.sqrt(s / (values.length - 1))
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const at = (sorted.length - 1) * p
  const low = Math.floor(at)
  const high = Math.ceil(at)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low)
}

function toDb(amplitude) {
  return 20 * Math.log10(Math.max(amplitude, EPS))
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null
  const f = 10 ** digits
  return Math.round(value * f) / f
}

// ---------------------------------------------------------------------------
//  Framing, FFT, spectra, MFCC
// ---------------------------------------------------------------------------

function frameSignal(samples, frameLength, hopLength) {
  const frames = []
  if (samples.length < frameLength) {
    const padded = new Float32Array(frameLength)
    padded.set(samples)
    frames.push(padded)
    return frames
  }
  for (let start = 0; start + frameLength <= samples.length; start += hopLength) {
    frames.push(samples.subarray(start, start + frameLength))
  }
  return frames
}

function hann(n) {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

// Iterative radix-2 FFT. Sizes here are powers of two by construction.
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k += 1) {
        const ar = re[i + k]
        const ai = im[i + k]
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ar + br
        im[i + k] = ai + bi
        re[i + k + len / 2] = ar - br
        im[i + k + len / 2] = ai - bi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

function nextPow2(n) {
  let p = 1
  while (p < n) p <<= 1
  return p
}

function powerSpectrum(frame, window) {
  const n = nextPow2(frame.length)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < frame.length; i += 1) re[i] = frame[i] * window[i]
  fft(re, im)
  const bins = n / 2 + 1
  const out = new Float64Array(bins)
  for (let i = 0; i < bins; i += 1) out[i] = (re[i] * re[i] + im[i] * im[i]) / n
  return out
}

function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700) }
function melToHz(mel) { return 700 * (10 ** (mel / 2595) - 1) }

function melFilterbank(bins, sampleRate, bands = 26, fmin = 20, fmax = null) {
  const top = fmax || sampleRate / 2
  const points = []
  const lo = hzToMel(fmin)
  const hi = hzToMel(top)
  for (let i = 0; i < bands + 2; i += 1) {
    const hz = melToHz(lo + ((hi - lo) * i) / (bands + 1))
    points.push(Math.floor(((bins - 1) * 2 * hz) / sampleRate))
  }
  const filters = []
  for (let b = 1; b <= bands; b += 1) {
    const f = new Float64Array(bins)
    const [left, centre, right] = [points[b - 1], points[b], points[b + 1]]
    for (let k = left; k < centre; k += 1) if (centre > left) f[k] = (k - left) / (centre - left)
    for (let k = centre; k < right; k += 1) if (right > centre) f[k] = (right - k) / (right - centre)
    filters.push(f)
  }
  return filters
}

function dct(input, count) {
  const out = new Float64Array(count)
  const n = input.length
  for (let k = 0; k < count; k += 1) {
    let s = 0
    for (let i = 0; i < n; i += 1) s += input[i] * Math.cos((Math.PI * k * (i + 0.5)) / n)
    out[k] = s
  }
  return out
}

/** Mean MFCC vector over the whole clip — the standard cheap timbre summary. */
function mfccProfile(samples, sampleRate, { coefficients = 13, bands = 26 } = {}) {
  const frameLength = Math.max(256, nextPow2(Math.round(sampleRate * 0.025)))
  const hopLength = Math.max(1, Math.round(sampleRate * 0.010))
  const window = hann(frameLength)
  const frames = frameSignal(samples, frameLength, hopLength)
  const bins = nextPow2(frameLength) / 2 + 1
  const filters = melFilterbank(bins, sampleRate, bands)
  const accumulator = new Float64Array(coefficients)
  let counted = 0
  for (const frame of frames) {
    const spectrum = powerSpectrum(frame, window)
    const energies = new Float64Array(bands)
    for (let b = 0; b < bands; b += 1) {
      let s = 0
      const f = filters[b]
      for (let k = 0; k < bins; k += 1) s += spectrum[k] * f[k]
      energies[b] = Math.log(Math.max(s, EPS))
    }
    const coeffs = dct(energies, coefficients)
    for (let c = 0; c < coefficients; c += 1) accumulator[c] += coeffs[c]
    counted += 1
  }
  if (!counted) return new Array(coefficients).fill(0)
  return Array.from(accumulator, v => v / counted)
}

/** Long-term average spectrum, in dB, on a fixed bin grid. */
function longTermSpectrum(samples, sampleRate, bandCount = 24) {
  const frameLength = Math.max(256, nextPow2(Math.round(sampleRate * 0.025)))
  const hopLength = Math.max(1, Math.round(sampleRate * 0.010))
  const window = hann(frameLength)
  const frames = frameSignal(samples, frameLength, hopLength)
  const bins = nextPow2(frameLength) / 2 + 1
  const filters = melFilterbank(bins, sampleRate, bandCount)
  const totals = new Float64Array(bandCount)
  let counted = 0
  for (const frame of frames) {
    const spectrum = powerSpectrum(frame, window)
    for (let b = 0; b < bandCount; b += 1) {
      let s = 0
      const f = filters[b]
      for (let k = 0; k < bins; k += 1) s += spectrum[k] * f[k]
      totals[b] += s
    }
    counted += 1
  }
  if (!counted) return new Array(bandCount).fill(-120)
  return Array.from(totals, v => 10 * Math.log10(Math.max(v / counted, EPS)))
}

/**
 * Pitch track by autocorrelation — the classic cheap method. Good enough to
 * say "this one is flat / this one wobbles", which is all a threshold needs.
 */
function pitchTrack(samples, sampleRate, { fmin = 70, fmax = 400 } = {}) {
  const frameLength = Math.round(sampleRate * 0.040)
  const hopLength = Math.round(sampleRate * 0.010)
  const minLag = Math.floor(sampleRate / fmax)
  const maxLag = Math.ceil(sampleRate / fmin)
  const values = []
  for (let start = 0; start + frameLength <= samples.length; start += hopLength) {
    const frame = samples.subarray(start, start + frameLength)
    let energy = 0
    for (let i = 0; i < frame.length; i += 1) energy += frame[i] * frame[i]
    if (Math.sqrt(energy / frame.length) < 0.01) continue // unvoiced / silence
    const scores = new Float64Array(maxLag + 1)
    let bestLag = 0
    let best = 0
    for (let lag = minLag; lag <= maxLag && lag < frame.length; lag += 1) {
      let s = 0
      let ea = 0
      let eb = 0
      for (let i = 0; i < frame.length - lag; i += 1) {
        s += frame[i] * frame[i + lag]
        ea += frame[i] * frame[i]
        eb += frame[i + lag] * frame[i + lag]
      }
      // Normalised cross-correlation, so long lags are not penalised for
      // simply having fewer terms to sum.
      const norm = s / (Math.sqrt(ea * eb) + EPS)
      scores[lag] = norm
      if (norm > best) { best = norm; bestLag = lag }
    }
    if (!bestLag || best <= 0) continue
    // Octave correction: plain autocorrelation loves to answer with twice the
    // true period, which reads as "the voice dropped an octave" and would make
    // a pitch threshold nonsense. If a half/third lag is nearly as strong,
    // that shorter one is the real period.
    for (const divisor of [2, 3]) {
      const candidate = Math.round(bestLag / divisor)
      if (candidate >= minLag && scores[candidate] > best * 0.85) bestLag = candidate
    }
    values.push(sampleRate / bestLag)
  }
  return values
}

// ---------------------------------------------------------------------------
//  Tier 1 — the clip on its own
// ---------------------------------------------------------------------------

function measureBasic(buffer, { text = null, silenceDb = -45 } = {}) {
  const { samples, sampleRate, duration } = decodeWav(buffer)
  if (!samples.length) throw wavError('FG_WAV_EMPTY', '这段音频里一个采样点都没有，等于空文件')

  const frameLength = Math.max(1, Math.round(sampleRate * 0.020))
  const frameDbs = []
  for (let start = 0; start < samples.length; start += frameLength) {
    const end = Math.min(start + frameLength, samples.length)
    let s = 0
    for (let i = start; i < end; i += 1) s += samples[i] * samples[i]
    frameDbs.push(toDb(Math.sqrt(s / (end - start))))
  }

  let peak = 0
  let clipped = 0
  let sumSquares = 0
  let dcSum = 0
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]
    const a = Math.abs(v)
    if (a > peak) peak = a
    if (a >= 0.999) clipped += 1
    sumSquares += v * v
    dcSum += v
  }

  const loud = frameDbs.map((db, i) => ({ db, i })).filter(f => f.db > silenceDb)
  const silentFrames = frameDbs.length - loud.length
  let lead = 0
  while (lead < frameDbs.length && frameDbs[lead] <= silenceDb) lead += 1
  let trail = 0
  while (trail < frameDbs.length && frameDbs[frameDbs.length - 1 - trail] <= silenceDb) trail += 1

  const frameSeconds = frameLength / sampleRate
  const speechSeconds = loud.length * frameSeconds
  const characters = text ? String(text).replace(/\s/g, '').length : null

  return {
    kind: 'metrics',
    tier: 1,
    sample_rate: sampleRate,
    duration_sec: round(duration, 3),
    // 太短=没念完 / 太长=念岔了
    speech_sec: round(speechSeconds, 3),
    // 开头吞字、结尾拖一大段空
    silence_ratio: round(frameDbs.length ? silentFrames / frameDbs.length : 1, 4),
    lead_silence_sec: round(lead * frameSeconds, 3),
    trail_silence_sec: round(trail * frameSeconds, 3),
    // 声音炸了
    clipping_ratio: round(clipped / samples.length, 6),
    peak_dbfs: round(toDb(peak), 2),
    // 音量稳不稳
    rms_dbfs: round(toDb(Math.sqrt(sumSquares / samples.length)), 2),
    loudness_range_db: loud.length
      ? round(percentile(loud.map(f => f.db), 0.95) - percentile(loud.map(f => f.db), 0.05), 2)
      : 0,
    loudness_stddev_db: round(stddev(loud.map(f => f.db)), 2),
    dc_offset: round(dcSum / samples.length, 6),
    // 念太快 / 太慢
    chars: characters,
    chars_per_sec: characters && speechSeconds > 0 ? round(characters / speechSeconds, 3) : null,
    // 有噪、有嘶声：最安静那一成的能量就是底噪
    noise_floor_dbfs: round(percentile(frameDbs, 0.1), 2),
  }
}

// ---------------------------------------------------------------------------
//  Tier 2 — the clip against the reference it was cloned from
// ---------------------------------------------------------------------------

function cosineDistance(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na < EPS || nb < EPS) return 1
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function euclidean(a, b) {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) s += (a[i] - b[i]) ** 2
  return Math.sqrt(s)
}

function highFrequencyRatio(spectrumDb) {
  // Upper third of the mel bands against the whole — "糊 / 闷 / 缺齿音".
  const linear = spectrumDb.map(db => 10 ** (db / 10))
  const cut = Math.floor((linear.length * 2) / 3)
  const high = linear.slice(cut).reduce((a, b) => a + b, 0)
  const all = linear.reduce((a, b) => a + b, 0)
  return all > EPS ? high / all : 0
}

function measureSimilarity(candidateBuffer, referenceBuffer) {
  const candidate = decodeWav(candidateBuffer)
  const reference = decodeWav(referenceBuffer)

  const candidateMfcc = mfccProfile(candidate.samples, candidate.sampleRate)
  const referenceMfcc = mfccProfile(reference.samples, reference.sampleRate)
  const candidateSpectrum = longTermSpectrum(candidate.samples, candidate.sampleRate)
  const referenceSpectrum = longTermSpectrum(reference.samples, reference.sampleRate)

  const candidatePitch = pitchTrack(candidate.samples, candidate.sampleRate)
  const referencePitch = pitchTrack(reference.samples, reference.sampleRate)

  const candidateMedian = percentile(candidatePitch, 0.5)
  const referenceMedian = percentile(referencePitch, 0.5)

  // Frame-to-frame pitch wobble: "发飘 / 机械" shows up here.
  const jitter = track => {
    if (track.length < 2) return 0
    let s = 0
    for (let i = 1; i < track.length; i += 1) s += Math.abs(track[i] - track[i - 1])
    return s / (track.length - 1)
  }

  return {
    kind: 'metrics',
    tier: 2,
    // 整体像不像
    mfcc_distance: round(euclidean(candidateMfcc, referenceMfcc), 4),
    // The first coefficient is loudness, not timbre, and it is far bigger than
    // the rest — leaving it in makes the cosine hug 0 for every pair of clips,
    // whether they sound alike or not, and a threshold on it would be useless.
    // Dropping it is what makes this number actually track "像不像".
    mfcc_cosine_distance: round(cosineDistance(candidateMfcc.slice(1), referenceMfcc.slice(1)), 4),
    // 音色偏了、发闷、发尖
    spectral_distance_db: round(
      Math.sqrt(mean(candidateSpectrum.map((v, i) => (v - (referenceSpectrum[i] ?? v)) ** 2))), 3),
    // 音调对不对
    pitch_median_hz: round(candidateMedian, 2),
    reference_pitch_median_hz: round(referenceMedian, 2),
    pitch_median_ratio: referenceMedian > 0 ? round(candidateMedian / referenceMedian, 4) : null,
    pitch_range_hz: round(percentile(candidatePitch, 0.9) - percentile(candidatePitch, 0.1), 2),
    reference_pitch_range_hz: round(percentile(referencePitch, 0.9) - percentile(referencePitch, 0.1), 2),
    pitch_jitter_hz: round(jitter(candidatePitch), 3),
    reference_pitch_jitter_hz: round(jitter(referencePitch), 3),
    // 糊 / 闷 / 缺齿音
    high_freq_ratio: round(highFrequencyRatio(candidateSpectrum), 4),
    reference_high_freq_ratio: round(highFrequencyRatio(referenceSpectrum), 4),
    voiced_ratio: round(candidatePitch.length / Math.max(1, Math.round(candidate.duration * 100)), 4),
  }
}

module.exports = {
  decodeWav,
  measureBasic,
  measureSimilarity,
  mfccProfile,
  longTermSpectrum,
  pitchTrack,
  percentile,
  mean,
  stddev,
  toDb,
}
