package rawkode.dev.today;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.CalendarContract;
import android.view.View;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class TodayWidget extends AppWidgetProvider {
    private static final String REFRESH = "rawkode.dev.today.REFRESH";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

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
        if (REFRESH.equals(action) || Intent.ACTION_DATE_CHANGED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action) || Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
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
        List<CalendarEvents.Event> events = null;
        int error = 0;
        try {
            events = CalendarEvents.load(context);
        } catch (SecurityException e) {
            error = R.string.widget_permission;
        } catch (RuntimeException e) {
            error = R.string.widget_error;
        }
        WidgetRefresh.start(context);
        boolean precise = error == 0 && clockIds.length > 0 && !events.isEmpty()
                && WidgetRefresh.canScheduleExact(context) && !events.get(0).allDay()
                && events.get(0).start() > System.currentTimeMillis()
                && events.get(0).start() - System.currentTimeMillis() <= 60 * 60 * 1000L;
        WidgetRefresh.schedule(context, error == 0 ? nextBoundary(events, clockIds.length > 0
                && WidgetRefresh.canScheduleExact(context)) : 0, precise);
        for (int id : ids) {
            RemoteViews views = baseViews(context);
            if (error != 0) {
                views.setTextViewText(R.id.widget_message, context.getString(error));
            } else if (events.isEmpty()) {
                views.setViewVisibility(R.id.widget_message, View.GONE);
                views.setViewVisibility(R.id.clear_state, View.VISIBLE);
                views.setTextViewText(R.id.clear_title, context.getString(LocalTime.now().getHour() < 12
                        ? R.string.clear_morning : R.string.clear_later));
            } else {
                showEvents(context, views, events, id, manager.getAppWidgetOptions(id));
            }
            manager.updateAppWidget(id, views);
        }
        ClockWidget.update(context, manager, clockIds, events, error);
    }

    private static RemoteViews baseViews(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.today_widget);
        String pattern = android.text.format.DateFormat.getBestDateTimePattern(Locale.getDefault(), "EEE MMM d");
        views.setTextViewText(R.id.widget_date, new SimpleDateFormat(pattern, Locale.getDefault()).format(new Date()));
        Intent open = new Intent(context, MainActivity.class);
        views.setOnClickPendingIntent(R.id.widget_body, PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        views.setOnClickPendingIntent(R.id.calendar_heading, calendarIntent(context, 0));
        Intent refresh = new Intent(context, TodayWidget.class).setAction(REFRESH);
        views.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(context, 0, refresh,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return views;
    }

    private static void showEvents(Context context, RemoteViews views, List<CalendarEvents.Event> events,
                                   int widgetId, Bundle options) {
        CalendarEvents.Event next = events.get(0);
        views.setViewVisibility(R.id.widget_message, View.GONE);
        views.setViewVisibility(R.id.next_event, View.VISIBLE);
        views.setTextViewText(R.id.next_label, context.getString(next.allDay() ? R.string.all_day
                : next.start() <= System.currentTimeMillis() ? R.string.on_now : R.string.next_up));
        EventColors.apply(context, views, R.id.next_label, next.color());
        views.setViewVisibility(R.id.next_conflict, Agenda.overlaps(next, events) ? View.VISIBLE : View.GONE);
        views.setTextViewText(R.id.next_title, next.title());
        views.setTextViewText(R.id.next_time, CalendarEvents.timeRange(context, next));
        views.setOnClickPendingIntent(R.id.next_event, eventIntent(context, next, widgetId, 0));

        int height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180);
        float fontScale = Math.max(1f, context.getResources().getConfiguration().fontScale);
        Uri meeting = EventActions.meetingLink(next);
        Uri map = EventActions.mapLink(next);
        boolean showLocation = map != null && height >= 230 * fontScale;
        boolean showActions = meeting != null && height >= (showLocation ? 280 : 240) * fontScale;
        if (showLocation) {
            views.setViewVisibility(R.id.next_location, View.VISIBLE);
            views.setTextViewText(R.id.next_location_text, next.location().trim());
            views.setContentDescription(R.id.next_location, context.getString(R.string.open_location, next.location().trim()));
            views.setOnClickPendingIntent(R.id.next_location, externalIntent(context, map, widgetId * 31 + 21));
        }
        if (showActions) {
            views.setViewVisibility(R.id.event_actions, View.VISIBLE);
            views.setViewVisibility(R.id.join_meeting, View.VISIBLE);
            views.setOnClickPendingIntent(R.id.join_meeting, externalIntent(context, meeting, widgetId * 31 + 20));
        }

        long now = System.currentTimeMillis();
        int budget = Math.max(0, (int) ((height - 210 * fontScale - (showLocation ? 52 * fontScale : 0)
                - (showActions ? 46 * fontScale : 0)) / fontScale));
        // The header holds overflow; add an all-day heading only when it fits.
        views.removeAllViews(R.id.later_events);
        int used = 0;
        int displayed = 0;
        boolean allDayHeading = next.allDay();
        for (int i = 1; i < events.size() && displayed < 12; i++) {
            CalendarEvents.Event event = events.get(i);
            boolean heading = event.allDay() && !allDayHeading;
            Uri rowMeeting = EventActions.meetingLink(event);
            Uri rowMap = EventActions.mapLink(event);
            int cost = 58 + (heading ? 28 : 0);
            if (used + cost > budget) break;
            if (heading) {
                views.addView(R.id.later_events, new RemoteViews(context.getPackageName(), R.layout.widget_section));
                allDayHeading = true;
            }
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_event);
            row.setTextViewText(R.id.event_time, CalendarEvents.timeLabel(context, event));
            row.setViewVisibility(R.id.event_time, event.allDay() ? View.GONE : View.VISIBLE);
            EventColors.apply(context, row, R.id.event_time, event.color());
            row.setTextViewText(R.id.event_title, event.title());
            EventColors.apply(context, row, R.id.event_color, event.color());
            row.setViewVisibility(R.id.event_conflict, Agenda.overlaps(event, events) ? View.VISIBLE : View.GONE);
            if (rowMeeting != null) {
                row.setViewVisibility(R.id.event_join, View.VISIBLE);
                row.setContentDescription(R.id.event_join, context.getString(R.string.join_meeting));
                row.setOnClickPendingIntent(R.id.event_join, externalIntent(context, rowMeeting, widgetId * 31 + 100 + i));
            }
            if (rowMap != null && (rowMeeting == null || options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250) >= 320)) {
                row.setViewVisibility(R.id.event_map, View.VISIBLE);
                row.setContentDescription(R.id.event_map, context.getString(R.string.open_map));
                row.setOnClickPendingIntent(R.id.event_map, externalIntent(context, rowMap, widgetId * 31 + 200 + i));
            }
            row.setOnClickPendingIntent(R.id.event_row, eventIntent(context, event, widgetId, i));
            views.addView(R.id.later_events, row);
            displayed++;
            used += cost;
        }
        views.setViewVisibility(R.id.event_divider, displayed > 0 ? View.VISIBLE : View.GONE);
        int hidden = events.size() - 1 - displayed;
        if (hidden > 0) {
            views.setViewVisibility(R.id.more_events, View.VISIBLE);
            views.setTextViewText(R.id.more_events, context.getString(R.string.more_events_compact, hidden));
            views.setContentDescription(R.id.more_events, context.getResources().getQuantityString(R.plurals.more_events, hidden, hidden));
            views.setOnClickPendingIntent(R.id.more_events, calendarIntent(context, widgetId));
        }
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

    private static long nextBoundary(List<CalendarEvents.Event> events, boolean hasClock) {
        long now = System.currentTimeMillis();
        long next = LocalDate.now().plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli();
        if (hasClock && !events.isEmpty()) next = Math.min(next, ClockWidget.nextSummaryChange(events.get(0), now));
        for (CalendarEvents.Event event : events) {
            if (event.allDay()) continue;
            if (event.start() > now) next = Math.min(next, event.start());
            if (event.end() > now) next = Math.min(next, event.end());
        }
        return Math.max(System.currentTimeMillis() + 1000L, next);
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
