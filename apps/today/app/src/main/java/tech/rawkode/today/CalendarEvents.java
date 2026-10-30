package tech.rawkode.today;

import android.Manifest;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Reads occurrences, including expanded recurring events, from visible calendars. */
final class CalendarEvents {
    record Event(long id, String title, long start, long end, boolean allDay, String location,
                 String description, Integer color, int selfAttendeeStatus, int availability) {}

    static List<Event> load(Context context) {
        if (context.checkSelfPermission(Manifest.permission.READ_CALENDAR) != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("Calendar access is not granted");
        }
        ZoneId zone = ZoneId.systemDefault();
        LocalDate today = LocalDate.now(zone);
        long now = System.currentTimeMillis();
        long dayStart = today.atStartOfDay(zone).toInstant().toEpochMilli();
        long dayEnd = today.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli();
        // All-day dates are stored at UTC midnight, so widen the query and filter locally.
        long utcStart = today.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
        long utcEnd = today.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
        Uri.Builder uri = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(uri, Math.min(dayStart, utcStart));
        ContentUris.appendId(uri, Math.max(dayEnd, utcEnd));
        String[] columns = { CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE,
                CalendarContract.Instances.BEGIN, CalendarContract.Instances.END,
                CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.STATUS,
                CalendarContract.Instances.EVENT_LOCATION, CalendarContract.Instances.DESCRIPTION,
                CalendarContract.Instances.DISPLAY_COLOR, CalendarContract.Instances.SELF_ATTENDEE_STATUS,
                CalendarContract.Instances.AVAILABILITY };
        List<Event> events = new ArrayList<>();
        try (Cursor cursor = context.getContentResolver().query(uri.build(), columns,
                CalendarContract.Instances.VISIBLE + " = 1", null, null)) {
            if (cursor == null) throw new IllegalStateException("Calendar provider unavailable");
            while (cursor.moveToNext()) {
                long start = cursor.getLong(2);
                long end = cursor.getLong(3);
                boolean allDay = cursor.getInt(4) != 0;
                if (!cursor.isNull(5) && cursor.getInt(5) == CalendarContract.Events.STATUS_CANCELED) continue;
                int selfStatus = cursor.isNull(9) ? CalendarContract.Attendees.ATTENDEE_STATUS_NONE : cursor.getInt(9);
                if (selfStatus == CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED) continue;
                if (allDay ? start >= utcEnd || end <= utcStart
                        : start >= dayEnd || end <= dayStart || end <= now) continue;
                String title = cursor.getString(1);
                events.add(new Event(cursor.getLong(0), title == null || title.trim().isEmpty()
                        ? context.getString(R.string.untitled_event) : title, start, end, allDay,
                        cursor.getString(6), cursor.getString(7), cursor.isNull(8) ? null : cursor.getInt(8),
                        selfStatus, cursor.isNull(10) ? CalendarContract.Events.AVAILABILITY_BUSY : cursor.getInt(10)));
            }
        }
        // Timed events take precedence over all-day reminders; active events appear first.
        events.sort(Comparator.comparing(Event::allDay).thenComparingLong(Event::start));
        return events;
    }

    static String timeRange(Context context, Event event) {
        if (event.allDay()) return context.getString(R.string.all_day);
        java.text.DateFormat format = android.text.format.DateFormat.getTimeFormat(context);
        return context.getString(R.string.event_time_range, format.format(new java.util.Date(event.start())),
                format.format(new java.util.Date(event.end())));
    }

    static String timeLabel(Context context, Event event) {
        if (event.allDay()) return context.getString(R.string.all_day);
        if (event.start() <= System.currentTimeMillis()) return context.getString(R.string.happening_now);
        return android.text.format.DateFormat.getTimeFormat(context).format(java.util.Date.from(Instant.ofEpochMilli(event.start())));
    }
}
