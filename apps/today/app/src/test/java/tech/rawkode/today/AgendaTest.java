package tech.rawkode.today;

import static org.junit.Assert.*;

import android.provider.CalendarContract;

import org.junit.Test;

import java.util.List;

public class AgendaTest {
    private static CalendarEvents.Event event(long start, long end, boolean allDay, int availability) {
        return new CalendarEvents.Event(start, "Event", start, end, allDay, null, null, null,
                CalendarContract.Attendees.ATTENDEE_STATUS_NONE, availability, false);
    }

    @Test public void overlappingBusyEventsAreFlaggedButTouchingEventsAreNot() {
        var first = event(10, 20, false, CalendarContract.Events.AVAILABILITY_BUSY);
        var overlap = event(19, 25, false, CalendarContract.Events.AVAILABILITY_BUSY);
        var adjacent = event(20, 30, false, CalendarContract.Events.AVAILABILITY_BUSY);
        assertTrue(Agenda.overlaps(first, List.of(first, overlap)));
        assertFalse(Agenda.overlaps(first, List.of(first, adjacent)));
    }

    @Test public void freeAndAllDayEventsDoNotCauseConflicts() {
        var busy = event(10, 20, false, CalendarContract.Events.AVAILABILITY_BUSY);
        var free = event(10, 20, false, CalendarContract.Events.AVAILABILITY_FREE);
        var allDay = event(10, 20, true, CalendarContract.Events.AVAILABILITY_BUSY);
        assertFalse(Agenda.overlaps(busy, List.of(busy, free, allDay)));
    }

}
