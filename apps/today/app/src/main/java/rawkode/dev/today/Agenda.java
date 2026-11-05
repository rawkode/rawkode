package rawkode.dev.today;

import android.provider.CalendarContract;

import java.util.List;

/** Schedule decisions shared by both widgets: which event to feature, and when the agenda next changes. */
final class Agenda {
    static final long MINUTE = 60_000L;
    static final long HOUR = 60 * MINUTE;
    // An upcoming event takes over from an ongoing one, and its Join action appears, this long before it starts.
    static final long LEAD = 15 * MINUTE;

    private Agenda() {}

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

    /**
     * Index of the event to feature, or -1 when there are none. Expects events sorted as
     * {@link CalendarEvents#load} returns them. An event starting within {@link #LEAD} wins;
     * otherwise the most recently started ongoing event, then the next upcoming one. Busy events
     * are preferred over free ones, and all-day events are featured only when nothing timed remains.
     */
    static int focus(List<CalendarEvents.Event> events, long now) {
        int found = focus(events, now, true);
        if (found < 0) found = focus(events, now, false);
        if (found >= 0) return found;
        for (int i = 0; i < events.size(); i++) {
            if (events.get(i).allDay()) return i;
        }
        return -1;
    }

    private static int focus(List<CalendarEvents.Event> events, long now, boolean busyOnly) {
        int ongoing = -1;
        int upcoming = -1;
        for (int i = 0; i < events.size(); i++) {
            CalendarEvents.Event event = events.get(i);
            if (event.allDay()) continue;
            if (busyOnly && event.availability() == CalendarContract.Events.AVAILABILITY_FREE) continue;
            if (event.start() <= now) {
                if (ongoing < 0 || event.start() > events.get(ongoing).start()) ongoing = i;
            } else if (upcoming < 0 || event.start() < events.get(upcoming).start()) {
                upcoming = i;
            }
        }
        if (upcoming >= 0 && (ongoing < 0 || events.get(upcoming).start() - now <= LEAD)) return upcoming;
        return ongoing;
    }

    /** Whether a meeting is close enough to starting, or already running, for its Join action to matter. */
    static boolean imminent(CalendarEvents.Event event, long now) {
        return !event.allDay() && event.start() - LEAD <= now && event.end() > now;
    }

    /**
     * The next time the agenda changes without the calendar itself changing: an event starts or ends,
     * an event comes within {@link #LEAD} of starting, or the day ends.
     */
    static long nextChange(List<CalendarEvents.Event> events, long now, long midnight) {
        long next = midnight;
        for (CalendarEvents.Event event : events) {
            if (event.allDay()) continue;
            if (event.start() - LEAD > now) next = Math.min(next, event.start() - LEAD);
            if (event.start() > now) next = Math.min(next, event.start());
            if (event.end() > now) next = Math.min(next, event.end());
        }
        return next;
    }

    /** Whether the featured event shows a minute countdown: timed, not started, and within the hour. */
    static boolean counting(CalendarEvents.Event event, long now) {
        return !event.allDay() && event.start() > now && event.start() - now <= HOUR;
    }

    /** Whole minutes until the event starts, rounded up so a countdown never reads 0 before it begins. */
    static int minutesUntil(CalendarEvents.Event event, long now) {
        return (int) ((event.start() - now + MINUTE - 1) / MINUTE);
    }

    /** When a countdown for this event next changes, or {@link Long#MAX_VALUE} if it never will. */
    static long nextCountdownChange(CalendarEvents.Event event, long now) {
        if (event.allDay() || event.start() <= now) return Long.MAX_VALUE;
        long remaining = event.start() - now;
        if (remaining > HOUR) return event.start() - HOUR;
        long rounded = ((remaining + MINUTE - 1) / MINUTE) * MINUTE;
        return event.start() - (rounded - MINUTE) + 1;
    }
}
