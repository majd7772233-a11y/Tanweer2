package com.magd.tanweer.core

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * كل حساب للتواريخ يمر من هنا، بتوقيت المدرسة `Asia/Aden` — نفس ما يفعله الخادم.
 *
 * اصطلاح الأسبوع: **0 = الأحد** (كما في الخادم)، والجمعة (5) والسبت (6) هما
 * نهاية الأسبوع، فيتخطاهما «غدًا» إلى أول يوم دراسي.
 */
object Dates {

    val SCHOOL_ZONE: ZoneId = ZoneId.of("Asia/Aden")

    private val isoFormatter: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")

    fun now(): ZonedDateTime = ZonedDateTime.now(SCHOOL_ZONE)

    fun today(): LocalDate = LocalDate.now(SCHOOL_ZONE)

    fun toIso(date: LocalDate): String = date.format(isoFormatter)

    fun parseIso(value: String): LocalDate = LocalDate.parse(value, isoFormatter)

    fun parseIsoOrNull(value: String?): LocalDate? = value?.let { runCatching { parseIso(it) }.getOrNull() }

    fun isoNow(): String = Instant.now().toString()

    /** فهرس يوم الأسبوع كما يتوقعه الخادم: الأحد = 0 … السبت = 6. */
    fun weekdayIndex(date: LocalDate): Int = date.dayOfWeek.value % 7

    fun isWeekend(date: LocalDate): Boolean = date.dayOfWeek == DayOfWeek.FRIDAY || date.dayOfWeek == DayOfWeek.SATURDAY

    /** أول يوم دراسي بعد `from`، مع تخطي الجمعة والسبت وأيام الإجازات. */
    fun nextSchoolDay(from: LocalDate, holidays: Set<String> = emptySet()): LocalDate {
        var candidate = from.plusDays(1)
        var guard = 0
        while ((isWeekend(candidate) || holidays.contains(toIso(candidate))) && guard < 60) {
            candidate = candidate.plusDays(1)
            guard++
        }
        return candidate
    }

    fun weekDates(anchor: LocalDate): List<LocalDate> {
        val start = anchor.minusDays(weekdayIndex(anchor).toLong())
        return (0L until 7L).map { start.plusDays(it) }
    }

    fun monthDates(year: Int, month: Int): List<LocalDate> {
        val first = LocalDate.of(year, month, 1)
        val start = first.minusDays(weekdayIndex(first).toLong())
        return (0L until 42L).map { start.plusDays(it) }
    }

    fun arabicDayLabel(date: LocalDate, locale: Locale = Locale("ar")): String =
        date.format(DateTimeFormatter.ofPattern("EEEE d MMMM", locale))

    fun shortLabel(date: LocalDate, locale: Locale = Locale("ar")): String =
        date.format(DateTimeFormatter.ofPattern("d MMM", locale))

    fun clockLabel(time: LocalTime): String = time.format(DateTimeFormatter.ofPattern("HH:mm"))

    fun startOfSchoolDay(period: Int): LocalTime = LocalTime.of(7, 30).plusMinutes(((period - 1) * 60).toLong())

    fun periodHasEnded(period: Int, now: LocalTime = LocalTime.now(SCHOOL_ZONE)): Boolean =
        now.isAfter(startOfSchoolDay(period).plusMinutes(45))

    fun daysUntil(target: LocalDate, from: LocalDate = today()): Long =
        java.time.temporal.ChronoUnit.DAYS.between(from, target)
}
