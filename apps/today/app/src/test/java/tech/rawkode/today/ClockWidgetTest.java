package tech.rawkode.today;

import static org.junit.Assert.assertEquals;

import android.provider.CalendarContract;

import org.junit.Test;

public class ClockWidgetTest {
    private static CalendarEvents.Event event(long start, boolean allDay) {
        return new CalendarEvents.Event(1, "Event", start, start + 3600000, allDay, null, null, null,
                CalendarContract.Attendees.ATTENDEE_STATUS_NONE, CalendarContract.Events.AVAILABILITY_BUSY, false);
    }

    @Test public void summaryChangesAtNextMinuteBoundary() {
        long now = 100000;
        long minute = 60000;
        assertEquals(now + minute + 1, ClockWidget.nextSummaryChange(event(now + 37 * minute, false), now));
        assertEquals(now + minute + 1, ClockWidget.nextSummaryChange(event(now + 40 * minute, false), now));
    }

    @Test public void summaryChangesAtOneHourThreshold() {
        long now = 100000;
        long minute = 60000;
        assertEquals(now + 30 * minute, ClockWidget.nextSummaryChange(event(now + 90 * minute, false), now));
        assertEquals(Long.MAX_VALUE, ClockWidget.nextSummaryChange(event(now + minute, true), now));
        assertEquals(Long.MAX_VALUE, ClockWidget.nextSummaryChange(event(now - minute, false), now));
    }
}
