package tech.rawkode.today;

import android.Manifest;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.UserManager;
import android.provider.CalendarContract;
import android.util.Log;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/** Reads occurrences, including expanded recurring events, from visible calendars. */
final class CalendarEvents {
    private static final String TAG = "TodayCalendarEvents";
    private static final String[] COLUMNS = { CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN, CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.STATUS,
            CalendarContract.Instances.EVENT_LOCATION, CalendarContract.Instances.DISPLAY_COLOR,
            CalendarContract.Instances.SELF_ATTENDEE_STATUS, CalendarContract.Instances.AVAILABILITY,
            CalendarContract.Instances.DESCRIPTION };
    // Cross-profile queries reject columns outside the provider's allowlist, which excludes DESCRIPTION.
    private static final String[] WORK_COLUMNS = Arrays.copyOf(COLUMNS, COLUMNS.length - 1);

    record Event(long id, String title, long start, long end, boolean allDay, String location,
                 String description, Integer color, int selfAttendeeStatus, int availability, boolean work) {}

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
        Window window = new Window(now, dayStart, dayEnd, utcStart, utcEnd);
        List<Event> events = new ArrayList<>();
        query(context, CalendarContract.Instances.CONTENT_URI, COLUMNS, false, window, events);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && hasWorkProfile(context)) {
            // Returns nothing unless the work profile's admin allows this app and the user has
            // turned on cross-profile calendar. A failure here must not hide personal events.
            try {
                query(context, CalendarContract.Instances.ENTERPRISE_CONTENT_URI, WORK_COLUMNS, true, window, events);
            } catch (RuntimeException e) {
                Log.w(TAG, "Could not read work profile calendars", e);
            }
        }
        // Timed events take precedence over all-day reminders; active events appear first.
        events.sort(Comparator.comparing(Event::allDay).thenComparingLong(Event::start));
        return events;
    }

    private record Window(long now, long dayStart, long dayEnd, long utcStart, long utcEnd) {}

    private static void query(Context context, Uri base, String[] columns, boolean work, Window window,
                              List<Event> events) {
        Uri.Builder uri = base.buildUpon();
        ContentUris.appendId(uri, Math.min(window.dayStart(), window.utcStart()));
        ContentUris.appendId(uri, Math.max(window.dayEnd(), window.utcEnd()));
        try (Cursor cursor = context.getContentResolver().query(uri.build(), columns,
                CalendarContract.Instances.VISIBLE + " = 1", null, null)) {
            if (cursor == null) throw new IllegalStateException("Calendar provider unavailable");
            while (cursor.moveToNext()) {
                long start = cursor.getLong(2);
                long end = cursor.getLong(3);
                boolean allDay = cursor.getInt(4) != 0;
                if (!cursor.isNull(5) && cursor.getInt(5) == CalendarContract.Events.STATUS_CANCELED) continue;
                int selfStatus = cursor.isNull(8) ? CalendarContract.Attendees.ATTENDEE_STATUS_NONE : cursor.getInt(8);
                if (selfStatus == CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED) continue;
                if (allDay ? start >= window.utcEnd() || end <= window.utcStart()
                        : start >= window.dayEnd() || end <= window.dayStart() || end <= window.now()) continue;
                String title = cursor.getString(1);
                events.add(new Event(cursor.getLong(0), title == null || title.trim().isEmpty()
                        ? context.getString(R.string.untitled_event) : title, start, end, allDay,
                        cursor.getString(6), work ? null : cursor.getString(10), cursor.isNull(7) ? null : cursor.getInt(7),
                        selfStatus, cursor.isNull(9) ? CalendarContract.Events.AVAILABILITY_BUSY : cursor.getInt(9), work));
            }
        }
    }

    static boolean hasWorkProfile(Context context) {
        return context.getSystemService(UserManager.class).getUserProfiles().size() > 1;
    }

    // Visible work calendars this app can read, or -1 when cross-profile access is unavailable.
    static int workCalendarCount(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !hasWorkProfile(context)
                || context.checkSelfPermission(Manifest.permission.READ_CALENDAR) != PackageManager.PERMISSION_GRANTED) {
            return -1;
        }
        try (Cursor cursor = context.getContentResolver().query(CalendarContract.Calendars.ENTERPRISE_CONTENT_URI,
                new String[] { CalendarContract.Calendars._ID }, CalendarContract.Calendars.VISIBLE + " = 1", null, null)) {
            return cursor == null ? -1 : cursor.getCount();
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not read work profile calendars", e);
            return -1;
        }
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
