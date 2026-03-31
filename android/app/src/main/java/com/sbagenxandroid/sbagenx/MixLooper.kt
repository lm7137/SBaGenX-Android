package com.sbagenxandroid.sbagenx

import java.io.Closeable
import java.util.concurrent.CancellationException

interface MixFrameReader : Closeable {
  fun readFrames(
      output: ShortArray,
      requestedFrames: Int,
      isCancelled: (() -> Boolean)? = null,
  ): Int
}

data class MixLooperPlan(
    val sourceStartFrame: Int,
    val sourceFrameCount: Int,
    val segmentMinFrames: Int,
    val segmentMaxFrames: Int,
    val fadeFrames: Int,
    val introFrames: Int,
    val dualChannel: Boolean,
    val swapStereo: Boolean,
)

class LooperMixDecoder(
    private val pcm: ShortArray,
    private val plan: MixLooperPlan,
) : MixFrameReader {
  private val totalFrames = pcm.size / 2
  private val streams = Array(3) { LoopStream() }
  private var rngSeed = (System.currentTimeMillis().toInt() and 0xffff)
  private var introRemaining = plan.introFrames
  private var introPosition = 0
  private var introFirstSegment = introRemaining > 0
  private val deltaAmp: Long =
      ((0xffffffffL / plan.fadeFrames.toLong()) ushr if (plan.dualChannel) 1 else 0)

  init {
    require(pcm.isNotEmpty()) { "Looper mix PCM cannot be empty." }
    require(plan.sourceFrameCount > 0) { "Looper source frame count must be positive." }
    if (introRemaining == 0) {
      schedule()
    }
  }

  override fun readFrames(
      output: ShortArray,
      requestedFrames: Int,
      isCancelled: (() -> Boolean)?,
  ): Int {
    require(requestedFrames >= 0) { "requestedFrames must not be negative." }
    require(output.size >= requestedFrames * 2) {
      "Output buffer is too small for $requestedFrames stereo frames."
    }
    if (requestedFrames == 0) {
      return 0
    }

    ensureNotCancelled(isCancelled)
    val mixed = IntArray(requestedFrames * 2)
    var outFrame = 0

    while (outFrame < requestedFrames) {
      ensureNotCancelled(isCancelled)

      if (introRemaining > 0) {
        val introFrames = minOf(requestedFrames - outFrame, introRemaining)
        for (frameOffset in 0 until introFrames) {
          val sourceFrame = introPosition + frameOffset
          if (sourceFrame !in 0 until totalFrames) {
            break
          }
          val sourceIndex = sourceFrame * 2
          val outputIndex = (outFrame + frameOffset) * 2
          mixed[outputIndex] += pcm[sourceIndex].toInt()
          mixed[outputIndex + 1] += pcm[sourceIndex + 1].toInt()
        }
        outFrame += introFrames
        introPosition += introFrames
        introRemaining -= introFrames
        if (introRemaining == 0) {
          schedule()
        }
        continue
      }

      var chunkFrames = requestedFrames - outFrame
      for (stream in streams) {
        if (stream.mode != 0 && stream.count < chunkFrames) {
          chunkFrames = stream.count
        }
      }
      if (chunkFrames <= 0) {
        schedule()
        continue
      }

      var needsReschedule = false
      for (stream in streams) {
        if (stream.mode == 0) {
          continue
        }

        if (stream.mode == 1) {
          stream.count -= chunkFrames
          if (stream.count == 0) {
            stream.mode = 2
            stream.count = plan.fadeFrames
            stream.delta = deltaAmp
          }
          continue
        }

        for (frameOffset in 0 until chunkFrames) {
          val outputIndex = (outFrame + frameOffset) * 2
          val sourceFrame = stream.source
          val (left, right) =
              if (sourceFrame in 0 until totalFrames) {
                val sourceIndex = sourceFrame * 2
                pcm[sourceIndex].toInt() to pcm[sourceIndex + 1].toInt()
              } else {
                0 to 0
              }

          val amp = currentAmpMultiplier(stream.amp)
          if (stream.channel != 0 && plan.swapStereo) {
            mixed[outputIndex] += (right * amp) shr 11
            mixed[outputIndex + 1] += (left * amp) shr 11
          } else {
            mixed[outputIndex] += (left * amp) shr 11
            mixed[outputIndex + 1] += (right * amp) shr 11
          }

          stream.amp = (stream.amp + stream.delta) and 0xffffffffL
          stream.count -= 1
          stream.source += 1
        }

        if (stream.count == 0) {
          when (stream.mode) {
            2 -> {
              stream.mode = 3
              stream.count = stream.countAll - 2 * plan.fadeFrames
              stream.delta = 0
            }
            3 -> {
              stream.mode = 4
              stream.count = plan.fadeFrames
              stream.delta = (-deltaAmp) and 0xffffffffL
            }
            4 -> {
              stream.mode = 0
              needsReschedule = true
            }
          }
        }
      }

      outFrame += chunkFrames
      if (needsReschedule) {
        schedule()
      }
    }

    for (index in 0 until requestedFrames * 2) {
      output[index] =
          mixed[index].coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
    }
    return requestedFrames
  }

  override fun close() = Unit

  private fun schedule() {
    if (plan.dualChannel) {
      scheduleDualChannel()
    } else {
      scheduleSingleChannel()
    }
  }

  private fun scheduleSingleChannel() {
    while (true) {
      var aa = streams[0]
      var bb = streams[1]
      if (aa.mode != 0 && bb.mode != 0) {
        break
      }

      if (bb.mode != 0 && aa.mode == 0) {
        val tmp = aa
        aa = bb
        bb = tmp
      }

      val active = aa.takeIf { it.mode != 0 }
      bb.offset = -1
      bb.mode = 1
      bb.count = 0
      bb.amp = 0
      bb.source = plan.sourceStartFrame

      if (active != null) {
        bb.count = countToEnd(active) - plan.fadeFrames
        if (bb.count < 0) {
          bb.count = 0
        }
      }

      val countAll = zxrand(plan.segmentMinFrames, plan.segmentMaxFrames + 1)
      bb.countAll = countAll

      if (active == null && introFirstSegment) {
        bb.offset = 0
        bb.mode = 3
        bb.count = countAll - plan.fadeFrames
        bb.amp = 0xffffffffL
        bb.delta = 0
        introFirstSegment = false
      }

      if (active != null) {
        bb.offset =
            zxrandMulti(
                -1,
                listOf(
                    RandomRange(0, active.offset - countAll),
                    RandomRange(
                        active.offset + active.countAll,
                        plan.sourceFrameCount - countAll,
                    ),
                ),
            )
      }

      if (bb.offset < 0) {
        bb.offset = zxrand(0, plan.sourceFrameCount - countAll)
      }

      bb.source = plan.sourceStartFrame + bb.offset
    }
  }

  private fun scheduleDualChannel() {
    while (true) {
      var aa = streams[0]
      var bb = streams[1]
      var cc = streams[2]
      if (aa.mode != 0 && bb.mode != 0 && cc.mode != 0) {
        break
      }

      if (aa.mode == 0 && bb.mode != 0) {
        val tmp = aa
        aa = bb
        bb = tmp
      }
      if (aa.mode == 0 && cc.mode != 0) {
        val tmp = aa
        aa = cc
        cc = tmp
      }
      if (bb.mode == 0 && cc.mode != 0) {
        val tmp = bb
        bb = cc
        cc = tmp
      }

      if (bb.mode == 0) {
        bb.channel = if (aa.mode != 0) 1 - aa.channel else 0
        bb.offset = -1
        bb.mode = 1
        bb.amp = 0
        bb.count = 0
        bb.source = plan.sourceStartFrame

        val countAll =
            if (aa.mode == 0) {
              zxrand(plan.segmentMinFrames, plan.segmentMaxFrames + 1)
            } else {
              val end = countToEnd(aa)
              zxrandMulti(
                  -1,
                  listOf(
                      RandomRange(plan.segmentMinFrames, plan.segmentMaxFrames + 1),
                      RandomRange(plan.segmentMinFrames, end - plan.fadeFrames),
                      RandomRange(end + plan.fadeFrames, plan.segmentMaxFrames + 1),
                  ),
                  outside = null,
              ).let { selected ->
                if (selected >= 0) {
                  selected
                } else {
                  bb.count = end + plan.fadeFrames - plan.segmentMaxFrames
                  plan.segmentMaxFrames
                }
              }
            }
        bb.countAll = countAll
        if (bb.count < 0) {
          bb.count = 0
        }

        if (aa.mode == 0 && introFirstSegment) {
          bb.offset = 0
          bb.mode = 3
          bb.count = countAll - plan.fadeFrames
          bb.amp = 0xffffffffL
          bb.delta = 0
          introFirstSegment = false
        }

        if (aa.mode != 0) {
          bb.offset =
              zxrandMulti(
                  -1,
                  listOf(
                      RandomRange(0, aa.offset - countAll),
                      RandomRange(
                          aa.offset + aa.countAll,
                          plan.sourceFrameCount - countAll,
                      ),
                  ),
              )
        }
        if (bb.offset < 0) {
          bb.offset = zxrand(0, plan.sourceFrameCount - countAll)
        }
        bb.source = plan.sourceStartFrame + bb.offset
        continue
      }

      check(aa.channel != bb.channel) {
        "Internal looper scheduling error: duplicate active channels."
      }

      if (countToEnd(aa) > countToEnd(bb)) {
        val tmp = aa
        aa = bb
        bb = tmp
      }

      cc.channel = aa.channel
      cc.count = countToEnd(aa) - plan.fadeFrames
      cc.offset = -1
      cc.mode = 1
      cc.amp = 0
      cc.source = plan.sourceStartFrame

      val countAll =
          run {
            var end = countToEnd(bb)
            end -= cc.count
            val selected =
                zxrandMulti(
                    -1,
                    listOf(
                        RandomRange(plan.segmentMinFrames, plan.segmentMaxFrames + 1),
                        RandomRange(plan.segmentMinFrames, end - plan.fadeFrames),
                        RandomRange(end + plan.fadeFrames, plan.segmentMaxFrames + 1),
                    ),
                )
            if (selected >= 0) {
              selected
            } else if (end - plan.fadeFrames > plan.fadeFrames * 2) {
              end - plan.fadeFrames
            } else {
              end + plan.fadeFrames
            }
          }
      cc.countAll = countAll

      run {
        var r0 = aa.offset
        var r1 = aa.offset + aa.countAll
        var r2 = bb.offset
        var r3 = bb.offset + bb.countAll
        if (r0 > r2) {
          val t0 = r0
          val t1 = r1
          r0 = r2
          r1 = r3
          r2 = t0
          r3 = t1
        }
        cc.offset =
            zxrandMulti(
                -1,
                listOf(
                    RandomRange(0, r0 - countAll),
                    RandomRange(r1, r2 - countAll),
                    RandomRange(r3, plan.sourceFrameCount - countAll),
                ),
            )
      }

      if (cc.offset < 0) {
        cc.offset = zxrand(0, plan.sourceFrameCount - countAll)
      }
      cc.source = plan.sourceStartFrame + cc.offset
    }
  }

  private fun zxrand0To65536(): Int {
    rngSeed = ((1 + rngSeed) * 75) % 65537 - 1
    return rngSeed
  }

  private fun zxrand0(mult: Int): Int {
    val product = mult.toLong() * zxrand0To65536().toLong()
    return (product shr 16).toInt()
  }

  private fun zxrand(startInclusive: Int, endExclusive: Int): Int {
    if (endExclusive <= startInclusive) {
      return startInclusive
    }
    return startInclusive + zxrand0(endExclusive - startInclusive)
  }

  private fun zxrandMulti(
      defaultValue: Int,
      ranges: List<RandomRange>,
      outside: RandomRange? = null,
  ): Int {
    var totalCount = 0
    for (range in ranges) {
      var start = range.start
      var end = range.endExclusive
      if (outside != null) {
        if (start < outside.start) {
          start = outside.start
        }
        if (end > outside.endExclusive) {
          end = outside.endExclusive
        }
      }
      if (end - start > 0) {
        totalCount += end - start
      }
    }
    if (totalCount <= 0) {
      return defaultValue
    }

    var value = zxrand0(totalCount)
    for (range in ranges) {
      var start = range.start
      var end = range.endExclusive
      if (outside != null) {
        if (start < outside.start) {
          start = outside.start
        }
        if (end > outside.endExclusive) {
          end = outside.endExclusive
        }
      }
      val count = end - start
      if (count > 0) {
        if (value < count) {
          return start + value
        }
        value -= count
      }
    }
    return defaultValue
  }

  private fun countToEnd(stream: LoopStream): Int {
    return when (stream.mode) {
      1 -> stream.countAll + stream.count
      2 -> stream.countAll - plan.fadeFrames + stream.count
      3 -> plan.fadeFrames + stream.count
      4 -> stream.count
      else -> 0
    }
  }

  private fun currentAmpMultiplier(amp: Long): Int {
    var value = ((amp xor 0xffffffffL) and 0xffffffffL) ushr 16
    value = ((value * value) xor 0xffffffffL) and 0xffffffffL
    value = value ushr 21
    value *= 16L
    return value.toInt()
  }

  private fun ensureNotCancelled(isCancelled: (() -> Boolean)?) {
    if (isCancelled?.invoke() == true) {
      throw CancellationException("Mix looper cancelled.")
    }
  }

  private data class RandomRange(val start: Int, val endExclusive: Int)

  private data class LoopStream(
      var offset: Int = 0,
      var source: Int = 0,
      var channel: Int = 0,
      var mode: Int = 0,
      var count: Int = 0,
      var countAll: Int = 0,
      var amp: Long = 0,
      var delta: Long = 0,
  )
}
