package io.github.v3djg6gl.hydra.tv

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Radix-2 FFT + 8 log-spaced bands for the page's a.fft feed.
 *
 * Output matches what the web side expects from the native producer
 * (fft-bus.js): 8 floats, roughly 0..1, raw magnitudes per band — the page
 * applies the a.setSmooth() smoothing itself so every producer behaves the
 * same. Bands span 40 Hz–16 kHz logarithmically; values are dB-normalized
 * with a -70 dBFS floor.
 */
class Fft(private val size: Int, private val sampleRate: Int) {
    private val window = FloatArray(size) { (0.5 - 0.5 * cos(2.0 * PI * it / (size - 1))).toFloat() }
    private val re = FloatArray(size)
    private val im = FloatArray(size)
    private val magnitudes = FloatArray(size / 2)

    // 9 edges -> 8 log-spaced bands, 40 Hz .. 16 kHz
    private val bandEdges = DoubleArray(9) { i ->
        40.0 * Math.pow(16000.0 / 40.0, i / 8.0)
    }

    fun bands8(samples: FloatArray): FloatArray {
        require(samples.size >= size)
        for (i in 0 until size) {
            re[i] = samples[i] * window[i]
            im[i] = 0f
        }
        transform()
        // magnitude spectrum, normalized so a full-scale sine reads ~1.0
        val norm = 2.0f / size
        for (i in magnitudes.indices) {
            magnitudes[i] = sqrt(re[i] * re[i] + im[i] * im[i]) * norm
        }
        val hzPerBin = sampleRate.toDouble() / size
        val out = FloatArray(8)
        for (b in 0 until 8) {
            val lo = max(1, (bandEdges[b] / hzPerBin).toInt())
            val hi = min(magnitudes.size - 1, max(lo + 1, (bandEdges[b + 1] / hzPerBin).toInt()))
            var sum = 0.0
            for (i in lo until hi) sum += magnitudes[i]
            val mean = sum / (hi - lo)
            // dB with a -70 dBFS floor, mapped to 0..1
            val db = 20.0 * log10(mean + 1e-9)
            out[b] = ((db + 70.0) / 70.0).coerceIn(0.0, 1.0).toFloat()
        }
        return out
    }

    /** Iterative in-place Cooley–Tukey, decimation in time. */
    private fun transform() {
        val n = size
        // bit reversal
        var j = 0
        for (i in 0 until n - 1) {
            if (i < j) {
                var t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
            var m = n shr 1
            while (m in 1..j) { j -= m; m = m shr 1 }
            j += m
        }
        // butterflies
        var len = 2
        while (len <= n) {
            val ang = -2.0 * PI / len
            val wr = cos(ang).toFloat()
            val wi = sin(ang).toFloat()
            var i = 0
            while (i < n) {
                var curR = 1f
                var curI = 0f
                for (k in 0 until len / 2) {
                    val aR = re[i + k]; val aI = im[i + k]
                    val bR = re[i + k + len / 2] * curR - im[i + k + len / 2] * curI
                    val bI = re[i + k + len / 2] * curI + im[i + k + len / 2] * curR
                    re[i + k] = aR + bR; im[i + k] = aI + bI
                    re[i + k + len / 2] = aR - bR; im[i + k + len / 2] = aI - bI
                    val nr = curR * wr - curI * wi
                    curI = curR * wi + curI * wr
                    curR = nr
                }
                i += len
            }
            len = len shl 1
        }
    }
}
