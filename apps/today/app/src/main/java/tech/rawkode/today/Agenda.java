package tech.rawkode.today;

import android.provider.CalendarContract;

import java.util.List;

/** Schedule calculations use only visible, timed events that occupy time. */
final class Agenda {
    static boolean isBusy(CalendarEvents.Event event) {
        return !event.allDay() && event.availability() != CalendarContract.Events.AVAILABILITY_FREE
                && event.end() > event.start();
    }

    static boolean overlaps(CalendarEvents.Event event, List<CalendarEvents.Event> events) {
        if (!isBusy(event)) return false;
        for (CalendarEvents.Event other : events) {
            if (other != event && isBusy(other) && event.start() < other.end() && other.start() < event.end()) {
                return true;
            }
        }
        return false;
    }

}
