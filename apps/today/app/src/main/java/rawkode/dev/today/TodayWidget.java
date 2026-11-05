package rawkode.dev.today;

import android.annotation.TargetApi;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.content.res.TypedArray;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.CalendarContract;
import android.text.TextPaint;
import android.util.ArrayMap;
import android.util.DisplayMetrics;
import android.util.SizeF;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class TodayWidget extends AppWidgetProvider {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final int MAX_ROWS = 12;
    private static final int MAX_SIZES = 16;
    // Horizontal padding in today_widget.xml.
    private static final float SIDE_PADDING = 20 + 20;
    // A transient provider failure is retried sooner than the periodic update would.
    private static final long RETRY_MILLIS = 15 * 60 * 1000L;

    /** Everything one update renders, read once and shared by every widget and size. */
    private record Snapshot(List<CalendarEvents.Event> events, int focus, int error, long now, boolean precise,
                            Typeface font) {}

    @Override public void onEnabled(Context context) {
        WidgetRefresh.start(context);
    }

    @Override public void onDisabled(Context context) {
        if (!WidgetRefresh.hasWidgets(context)) WidgetRefresh.stop(context);
    }

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        updateAsync(context, goAsync());
    }

    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager,
                                                     int id, Bundle options) {
        updateAsync(context, goAsync());
    }

    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (WidgetRefresh.REFRESH_ACTION.equals(action) || Intent.ACTION_DATE_CHANGED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action) || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_LOCALE_CHANGED.equals(action)
                || AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action)) {
            updateAsync(context, goAsync());
        } else {
            super.onReceive(context, intent);
        }
    }

    static void refresh(Context context) {
        updateAsync(context, null);
    }

    static void refresh(Context context, PendingResult pending) {
        updateAsync(context, pending);
    }

    private static void updateAsync(Context context, PendingResult pending) {
        Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            try { updateAll(app); }
            finally { if (pending != null) pending.finish(); }
        });
    }

    static synchronized void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, TodayWidget.class));
        int[] clockIds = manager.getAppWidgetIds(new ComponentName(context, ClockWidget.class));
        if (ids.length == 0 && clockIds.length == 0) return;
        List<CalendarEvents.Event> events = List.of();
        int error = 0;
        try {
            events = CalendarEvents.load(context);
        } catch (SecurityException e) {
            error = R.string.widget_permission;
        } catch (RuntimeException e) {
            error = R.string.widget_error;
        }
        long now = System.currentTimeMillis();
        boolean precise = WidgetRefresh.canScheduleExact(context);
        int focus = Agenda.focus(events, now);
        WidgetRefresh.start(context);
        long midnight = LocalDate.now().plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli();
        long change = error == R.string.widget_error ? now + RETRY_MILLIS
                : error != 0 ? 0 : Agenda.nextChange(events, now, midnight);
        long tick = precise && focus >= 0 ? Agenda.nextCountdownChange(events.get(focus), now) : Long.MAX_VALUE;
        WidgetRefresh.schedule(context, change, tick);

        Snapshot snapshot = new Snapshot(events, focus, error, now, precise, deviceFont(context));
        for (int id : ids) {
            manager.updateAppWidget(id, views(context, manager.getAppWidgetOptions(id), id, snapshot));
        }
        ClockWidget.update(context, manager, clockIds, events, focus, error, now, precise);
    }

    // Android 12+ launchers pick the layout for the size actually shown, so rotating or resizing
    // never shows rows planned for another size. Older launchers get one layout for the current orientation.
    private static RemoteViews views(Context context, Bundle options, int widgetId, Snapshot snapshot) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            List<SizeF> sizes = sizes(options);
            if (sizes != null && !sizes.isEmpty()) {
                Map<SizeF, RemoteViews> bySize = new ArrayMap<>();
                for (SizeF size : sizes) {
                    if (bySize.size() == MAX_SIZES) break;
                    if (!bySize.containsKey(size)) {
                        bySize.put(size, render(context, size.getWidth(), size.getHeight(), widgetId, snapshot));
                    }
                }
                return new RemoteViews(bySize);
            }
        }
        // Launchers report portrait as minimum width by maximum height, and landscape the other way round.
        boolean landscape = context.getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        float width = dimension(options, landscape ? AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH
                : AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250);
        float height = dimension(options, landscape ? AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT
                : AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 180);
        return render(context, width, height, widgetId, snapshot);
    }

    @TargetApi(Build.VERSION_CODES.S)
    @SuppressWarnings("deprecation")
    private static List<SizeF> sizes(Bundle options) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return options.getParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES, SizeF.class);
        }
        return options.getParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES);
    }

    private static float dimension(Bundle options, String key, float fallback) {
        int value = options.getInt(key, 0);
        return value > 0 ? value : fallback;
    }

    private static RemoteViews render(Context context, float width, float height, int widgetId, Snapshot snapshot) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.today_widget);
        Locale locale = Locale.getDefault();
        Date today = new Date(snapshot.now());
        views.setTextViewText(R.id.widget_day, format(locale, "EEEE", today));
        views.setTextViewText(R.id.widget_date, format(locale, "d MMMM", today));
        Intent refresh = new Intent(context, TodayWidget.class).setAction(WidgetRefresh.REFRESH_ACTION);
        views.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(context, 0, refresh,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        if (snapshot.error() != 0) {
            views.setTextViewText(R.id.widget_message, context.getString(snapshot.error()));
            views.setOnClickPendingIntent(R.id.widget_body, PendingIntent.getActivity(context, 0,
                    new Intent(context, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            return views;
        }
        views.setViewVisibility(R.id.widget_message, View.GONE);
        views.setOnClickPendingIntent(R.id.widget_body, calendarIntent(context, 0));
        if (snapshot.events().isEmpty()) {
            views.setViewVisibility(R.id.clear_state, View.VISIBLE);
            views.setTextViewText(R.id.clear_title, context.getString(LocalTime.now().getHour() < 12
                    ? R.string.clear_morning : R.string.clear_later));
        } else {
            showEvents(context, views, width, height, widgetId, snapshot);
        }
        return views;
    }

    private static void showEvents(Context context, RemoteViews views, float width, float height, int widgetId,
                                   Snapshot snapshot) {
        List<CalendarEvents.Event> events = snapshot.events();
        long now = snapshot.now();
        CalendarEvents.Event next = events.get(snapshot.focus());
        List<CalendarEvents.Event> others = new ArrayList<>(events);
        others.remove(snapshot.focus());

        Uri meeting = EventActions.meetingLink(next);
        Uri map = EventActions.mapLink(next);
        float titleWidth = textWidth(context, snapshot.font(), next.title(), 22, true);
        WidgetLayout.Plan plan = WidgetLayout.plan(height, context.getResources().getConfiguration().fontScale,
                titleWidth <= width - SIDE_PADDING ? 1 : 2, !next.allDay(), map != null, meeting != null, others.size());

        views.setViewVisibility(R.id.next_event, View.VISIBLE);
        views.setTextViewText(R.id.next_label, label(context, next, now, snapshot.precise()));
        EventColors.apply(context, views, R.id.next_label, next.color());
        views.setViewVisibility(R.id.next_conflict, Agenda.overlaps(next, events) ? View.VISIBLE : View.GONE);
        views.setTextViewText(R.id.next_title, next.title());
        if (plan.titleLines() == 1) views.setInt(R.id.next_title, "setMaxLines", 1);
        views.setViewVisibility(R.id.next_time, plan.timeRow() ? View.VISIBLE : View.GONE);
        views.setTextViewText(R.id.next_time, CalendarEvents.timeRange(context, next));
        views.setOnClickPendingIntent(R.id.next_event, eventIntent(context, next, widgetId, 0));
        if (plan.location()) {
            views.setViewVisibility(R.id.next_location, View.VISIBLE);
            views.setTextViewText(R.id.next_location, next.location().trim());
            views.setContentDescription(R.id.next_location, context.getString(R.string.open_location, next.location().trim()));
            views.setOnClickPendingIntent(R.id.next_location, externalIntent(context, map, widgetId * 31 + 21));
        }
        if (plan.join()) {
            views.setViewVisibility(R.id.join_meeting, View.VISIBLE);
            views.setContentDescription(R.id.join_meeting, context.getString(R.string.join_event, next.title()));
            views.setOnClickPendingIntent(R.id.join_meeting, externalIntent(context, meeting, widgetId * 31 + 20));
        }

        int shown = Math.min(Math.min(plan.rows(), others.size()), MAX_ROWS);
        float timeColumn = 0;
        String[] times = new String[shown];
        for (int i = 0; i < shown; i++) {
            times[i] = CalendarEvents.timeLabel(context, others.get(i));
            timeColumn = Math.max(timeColumn, textWidth(context, snapshot.font(), times[i], 14, true));
        }
        for (int i = 0; i < shown; i++) {
            CalendarEvents.Event event = others.get(i);
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_event);
            row.setTextViewText(R.id.event_time, times[i]);
            if (!event.allDay() && event.start() <= now) EventColors.apply(context, row, R.id.event_time, null);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Times line up in one column no wider than its longest label, whatever the clock format.
                row.setViewLayoutWidth(R.id.event_time, (float) Math.ceil(timeColumn * 1.05f + 2), TypedValue.COMPLEX_UNIT_DIP);
            }
            EventColors.applyIndicator(context, row, R.id.event_color, event.color());
            row.setTextViewText(R.id.event_title, event.title());
            // Joining a meeting hours away is never the next step, so Join waits until it is close.
            // Once it shows, it takes the overlap badge's place so the title keeps its room.
            Uri rowMeeting = Agenda.imminent(event, now) ? EventActions.meetingLink(event) : null;
            row.setViewVisibility(R.id.event_conflict,
                    rowMeeting == null && Agenda.overlaps(event, events) ? View.VISIBLE : View.GONE);
            if (rowMeeting != null) {
                row.setViewVisibility(R.id.event_join, View.VISIBLE);
                row.setContentDescription(R.id.event_join, context.getString(R.string.join_event, event.title()));
                row.setOnClickPendingIntent(R.id.event_join, externalIntent(context, rowMeeting, widgetId * 31 + 100 + i));
            }
            row.setOnClickPendingIntent(R.id.event_row, eventIntent(context, event, widgetId, i + 1));
            views.addView(R.id.later_events, row);
        }
        views.setViewVisibility(R.id.event_divider, shown > 0 ? View.VISIBLE : View.GONE);
        int hidden = others.size() - shown;
        if (hidden > 0 && plan.more()) {
            views.setViewVisibility(R.id.more_events, View.VISIBLE);
            views.setTextViewText(R.id.more_events, context.getResources().getQuantityString(R.plurals.more_events, hidden, hidden));
            views.setOnClickPendingIntent(R.id.more_events, calendarIntent(context, widgetId));
        }
    }

    private static String label(Context context, CalendarEvents.Event event, long now, boolean precise) {
        if (event.allDay()) return context.getString(R.string.all_day);
        if (event.start() <= now) return context.getString(R.string.on_now);
        if (precise && Agenda.counting(event, now)) {
            int minutes = Agenda.minutesUntil(event, now);
            return context.getResources().getQuantityString(R.plurals.starts_in_minutes, minutes, minutes);
        }
        return context.getString(R.string.next_up);
    }

    private static String format(Locale locale, String skeleton, Date date) {
        String pattern = android.text.format.DateFormat.getBestDateTimePattern(locale, skeleton);
        return new SimpleDateFormat(pattern, locale).format(date);
    }

    // The font DeviceDefault text resolves to, such as Google Sans Text on Pixel, for measuring text.
    private static Typeface deviceFont(Context context) {
        TypedArray attributes = context.obtainStyledAttributes(android.R.style.TextAppearance_DeviceDefault,
                new int[] { android.R.attr.fontFamily });
        try {
            return Typeface.create(attributes.getString(0), Typeface.NORMAL);
        } finally {
            attributes.recycle();
        }
    }

    // Width in dp of text as the launcher will draw it.
    private static float textWidth(Context context, Typeface font, String text, float sp, boolean bold) {
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        TextPaint paint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        paint.setTypeface(Typeface.create(font, bold ? Typeface.BOLD : Typeface.NORMAL));
        paint.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, metrics));
        return paint.measureText(text) / metrics.density;
    }

    static PendingIntent calendarIntent(Context context, int requestCode) {
        Uri time = ContentUris.withAppendedId(CalendarContract.CONTENT_URI.buildUpon().appendPath("time").build(),
                System.currentTimeMillis());
        return PendingIntent.getActivity(context, requestCode, new Intent(Intent.ACTION_VIEW, time),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent externalIntent(Context context, Uri uri, int requestCode) {
        return PendingIntent.getActivity(context, requestCode, new Intent(Intent.ACTION_VIEW, uri),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static PendingIntent eventIntent(Context context, CalendarEvents.Event event, int widgetId, int row) {
        // Work event IDs belong to the work profile's provider; the personal calendar app can't open them.
        Intent intent = (event.work() ? new Intent(context, WorkEventActivity.class) : new Intent(Intent.ACTION_VIEW))
                .setData(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, event.id()))
                .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, event.start())
                .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, event.end())
                .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, event.allDay());
        return PendingIntent.getActivity(context, 31 * widgetId + row, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
