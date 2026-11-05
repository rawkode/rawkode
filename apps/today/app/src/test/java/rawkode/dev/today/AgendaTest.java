package rawkode.dev.today;

import static org.junit.Assert.*;

import android.provider.CalendarContract;

import org.junit.Test;

import java.util.List;

public class AgendaTest {
    private static final long MINUTE = Agenda.MINUTE;
    private static final long NOW = 1_000 * MINUTE;
    private static final long MIDNIGHT = NOW + 600 * MINUTE;

    private static CalendarEvents.Event event(long start, long end, boolean allDay, int availability) {
        return new CalendarEvents.Event(start, "Event", start, end, allDay, null, null, null,
                CalendarContract.Attendees.ATTENDEE_STATUS_NONE, availability, false);
    }

    private static CalendarEvents.Event busy(long start, long end) {
        return event(start, end, false, CalendarContract.Events.AVAILABILITY_BUSY);
    }

    private static CalendarEvents.Event free(long start, long end) {
        return event(start, end, false, CalendarContract.Events.AVAILABILITY_FREE);
    }

    private static CalendarEvents.Event allDay() {
        return event(0, 1, true, CalendarContract.Events.AVAILABILITY_BUSY);
    }

    @Test public void overlappingBusyEventsAreFlaggedButTouchingEventsAreNot() {
        var first = busy(10, 20);
        var overlap = busy(19, 25);
        var adjacent = busy(20, 30);
        assertTrue(Agenda.overlaps(first, List.of(first, overlap)));
        assertFalse(Agenda.overlaps(first, List.of(first, adjacent)));
    }

    @Test public void freeAndAllDayEventsDoNotCauseConflicts() {
        var busy = busy(10, 20);
        var free = free(10, 20);
        var allDay = event(10, 20, true, CalendarContract.Events.AVAILABILITY_BUSY);
        assertFalse(Agenda.overlaps(busy, List.of(busy, free, allDay)));
    }

    @Test public void focusIsTheNextEventWhenNothingIsOngoing() {
        assertEquals(0, Agenda.focus(List.of(busy(NOW + 30 * MINUTE, NOW + 60 * MINUTE),
                busy(NOW + 90 * MINUTE, NOW + 120 * MINUTE), allDay()), NOW));
    }

    @Test public void ongoingEventKeepsFocusUntilTheNextIsAboutToStart() {
        var ongoing = busy(NOW - 30 * MINUTE, NOW + 60 * MINUTE);
        var later = busy(NOW + 16 * MINUTE, NOW + 30 * MINUTE);
        var soon = busy(NOW + 15 * MINUTE, NOW + 30 * MINUTE);
        assertEquals(0, Agenda.focus(List.of(ongoing, later), NOW));
        assertEquals(1, Agenda.focus(List.of(ongoing, soon), NOW));
    }

    @Test public void mostRecentlyStartedOngoingEventWins() {
        // A meeting inside a long focus block is more specific than the block.
        var block = busy(NOW - 120 * MINUTE, NOW + 120 * MINUTE);
        var meeting = busy(NOW - 10 * MINUTE, NOW + 20 * MINUTE);
        assertEquals(1, Agenda.focus(List.of(block, meeting), NOW));
    }

    @Test public void busyEventsWinOverFreeOnes() {
        var lunch = free(NOW - 10 * MINUTE, NOW + 50 * MINUTE);
        var meeting = busy(NOW + 120 * MINUTE, NOW + 150 * MINUTE);
        assertEquals(1, Agenda.focus(List.of(lunch, meeting), NOW));
        assertEquals(0, Agenda.focus(List.of(lunch), NOW));
    }

    @Test public void allDayEventsAreFocusedOnlyWhenNothingTimedRemains() {
        assertEquals(1, Agenda.focus(List.of(allDay(), busy(NOW + MINUTE, NOW + 2 * MINUTE)), NOW));
        assertEquals(0, Agenda.focus(List.of(allDay()), NOW));
        assertEquals(-1, Agenda.focus(List.of(), NOW));
    }

    @Test public void nextChangeIsTheEarliestLeadStartOrEnd() {
        var ongoing = busy(NOW - 10 * MINUTE, NOW + 40 * MINUTE);
        var upcoming = busy(NOW + 30 * MINUTE, NOW + 90 * MINUTE);
        // The upcoming event comes within the lead at +15 minutes, before the ongoing one ends.
        assertEquals(NOW + 15 * MINUTE, Agenda.nextChange(List.of(ongoing, upcoming), NOW, MIDNIGHT));
        assertEquals(NOW + 30 * MINUTE, Agenda.nextChange(List.of(ongoing, upcoming), NOW + 15 * MINUTE, MIDNIGHT));
        assertEquals(NOW + 40 * MINUTE, Agenda.nextChange(List.of(ongoing, upcoming), NOW + 30 * MINUTE, MIDNIGHT));
    }

    @Test public void nextChangeFallsBackToMidnight() {
        assertEquals(MIDNIGHT, Agenda.nextChange(List.of(allDay()), NOW, MIDNIGHT));
        assertEquals(MIDNIGHT, Agenda.nextChange(List.of(), NOW, MIDNIGHT));
    }

    @Test public void joinIsImminentFromTheLeadUntilTheEnd() {
        var meeting = busy(NOW + 15 * MINUTE, NOW + 45 * MINUTE);
        assertFalse(Agenda.imminent(meeting, NOW - 1));
        assertTrue(Agenda.imminent(meeting, NOW));
        assertTrue(Agenda.imminent(meeting, NOW + 44 * MINUTE));
        assertFalse(Agenda.imminent(allDay(), NOW));
    }

    @Test public void countdownRoundsUpWithinTheHour() {
        assertTrue(Agenda.counting(busy(NOW + 60 * MINUTE, NOW + 90 * MINUTE), NOW));
        assertFalse(Agenda.counting(busy(NOW + 61 * MINUTE, NOW + 90 * MINUTE), NOW));
        assertFalse(Agenda.counting(busy(NOW - MINUTE, NOW + 90 * MINUTE), NOW));
        assertEquals(16, Agenda.minutesUntil(busy(NOW + 15 * MINUTE + 1, NOW + 90 * MINUTE), NOW));
        assertEquals(1, Agenda.minutesUntil(busy(NOW + 1, NOW + 90 * MINUTE), NOW));
    }

    @Test public void countdownChangesAtNextMinuteBoundary() {
        assertEquals(NOW + MINUTE + 1, Agenda.nextCountdownChange(busy(NOW + 37 * MINUTE, NOW + 90 * MINUTE), NOW));
        assertEquals(NOW + MINUTE + 1, Agenda.nextCountdownChange(busy(NOW + 40 * MINUTE, NOW + 90 * MINUTE), NOW));
    }

    @Test public void countdownStartsAtOneHour() {
        assertEquals(NOW + 30 * MINUTE, Agenda.nextCountdownChange(busy(NOW + 90 * MINUTE, NOW + 120 * MINUTE), NOW));
        assertEquals(Long.MAX_VALUE, Agenda.nextCountdownChange(allDay(), NOW));
        assertEquals(Long.MAX_VALUE, Agenda.nextCountdownChange(busy(NOW - MINUTE, NOW + MINUTE), NOW));
    }
}
