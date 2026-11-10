package rawkode.dev.today;

import static org.junit.Assert.*;

import org.junit.Test;

import java.time.LocalDate;
import java.time.ZoneId;

public class CalendarEventsTest {
    private static final ZoneId ZONE = ZoneId.of("Europe/London");
    private static final LocalDate DATE = LocalDate.of(2026, 3, 10);
    private static final long HOUR = Agenda.HOUR;
    private static final CalendarEvents.Window DAY = CalendarEvents.Window.of(DATE, ZONE);
    private static final long NOON = DAY.dayStart() + 12 * HOUR;

    @Test public void todayListsWhatHasNotEnded() {
        assertTrue(DAY.lists(NOON + HOUR, NOON + 2 * HOUR, false, true, NOON));
        assertTrue(DAY.lists(NOON - HOUR, NOON + HOUR, false, true, NOON));
        assertFalse(DAY.lists(NOON - 2 * HOUR, NOON - HOUR, false, true, NOON));
    }

    @Test public void todayListsAnEventThatBeganYesterday() {
        assertTrue(DAY.lists(DAY.dayStart() - HOUR, NOON + HOUR, false, true, NOON));
    }

    @Test public void laterDayListsOnlyEventsStartingOnIt() {
        long now = DAY.dayStart() - 30 * HOUR;
        assertTrue(DAY.lists(NOON, NOON + HOUR, false, false, now));
        // Running in from the previous evening: listed under the day it starts.
        assertFalse(DAY.lists(DAY.dayStart() - HOUR, DAY.dayStart() + HOUR, false, false, now));
        assertFalse(DAY.lists(DAY.dayEnd(), DAY.dayEnd() + HOUR, false, false, now));
    }

    @Test public void allDayEventsAreMatchedAgainstTheUtcDate() {
        var newYork = CalendarEvents.Window.of(DATE, ZoneId.of("America/New_York"));
        long now = newYork.dayStart();
        assertTrue(newYork.lists(newYork.utcStart(), newYork.utcEnd(), true, false, now));
        // The next date's all-day event starts at UTC midnight, which is still this evening in New York.
        assertFalse(newYork.lists(newYork.utcEnd(), newYork.utcEnd() + 24 * HOUR, true, false, now));
        // A multi-day event covers each of its dates.
        assertTrue(newYork.lists(newYork.utcStart() - 24 * HOUR, newYork.utcEnd() + 24 * HOUR, true, false, now));
    }
}
