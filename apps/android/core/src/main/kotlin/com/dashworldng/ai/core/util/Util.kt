package com.dashworldng.ai.core.util

import java.util.UUID

fun interface Clock {
    fun now(): Long

    companion object {
        val System: Clock = Clock { java.lang.System.currentTimeMillis() }
    }
}

fun interface IdGenerator {
    fun newId(): String

    companion object {
        val Uuid: IdGenerator = IdGenerator { UUID.randomUUID().toString() }
    }
}

/** Strictly increasing timestamps so messages created in the same millisecond keep their order. */
class MonotonicClock(private val clock: Clock) {
    private var last = 0L

    @Synchronized
    fun next(): Long {
        val value = maxOf(clock.now(), last + 1)
        last = value
        return value
    }
}
