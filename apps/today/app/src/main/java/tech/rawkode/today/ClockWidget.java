package tech.rawkode.today;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.provider.AlarmClock;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** A compact, translucent clock and next-event widget. */
public final class ClockWidget extends AppWidgetProvider {
    @Override public void onEnabled(Context context) {
        WidgetRefresh.start(context);
    }

    @Override public void onDisabled(Context context) {
        if (!WidgetRefresh.hasWidgets(context)) WidgetRefresh.stop(context);
    }

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        TodayWidget.refresh(context, goAsync());
    }

    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        TodayWidget.refresh(context, goAsync());
    }

    private static String eventSummary(Context context, CalendarEvents.Event event, long now, boolean precise) {
        if (event.allDay()) return context.getString(R.string.clock_event_all_day, event.title());
        if (event.start() <= now) return context.getString(R.string.clock_event_now, event.title());
        long remaining = event.start() - now;
        if (precise && remaining <= 60 * 60 * 1000L) {
            int minutes = (int) ((remaining + 60_000L - 1) / 60_000L);
            return context.getResources().getQuantityString(R.plurals.clock_event_in_minutes, minutes, event.title(), minutes);
        }
        return context.getString(R.string.clock_event_later, event.title(), CalendarEvents.timeLabel(context, event));
    }

    static long nextSummaryChange(CalendarEvents.Event event, long now) {
        if (event.allDay() || event.start() <= now) return Long.MAX_VALUE;
        long remaining = event.start() - now;
        if (remaining > 60 * 60 * 1000L) return event.start() - 60 * 60 * 1000L;
        long bucket = 60_000L;
        long rounded = ((remaining + bucket - 1) / bucket) * bucket;
        return event.start() - (rounded - bucket) + 1;
    }

    static void update(Context context, AppWidgetManager manager, int[] ids,
                       List<CalendarEvents.Event> events, int error) {
        String pattern = android.text.format.DateFormat.getBestDateTimePattern(Locale.getDefault(), "EEEE d MMMM");
        String date = new SimpleDateFormat(pattern, Locale.getDefault()).format(new Date());
        for (int id : ids) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.clock_widget);
            views.setTextViewText(R.id.clock_date, date);
            views.setOnClickPendingIntent(R.id.clock_body, TodayWidget.calendarIntent(context, id));
            views.setOnClickPendingIntent(R.id.clock_time, PendingIntent.getActivity(context, id,
                    new Intent(AlarmClock.ACTION_SHOW_ALARMS),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            if (error != 0) {
                views.setTextViewText(R.id.clock_event, context.getString(error));
                views.setOnClickPendingIntent(R.id.clock_event, PendingIntent.getActivity(context, id,
                        new Intent(context, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            } else if (events.isEmpty()) {
                views.setTextViewText(R.id.clock_event, context.getString(R.string.clock_clear));
            } else {
                CalendarEvents.Event next = events.get(0);
                views.setTextViewText(R.id.clock_event, eventSummary(context, next, System.currentTimeMillis(),
                        WidgetRefresh.canScheduleExact(context)));
                views.setTextColor(R.id.clock_event, TodayWidget.visibleColor(next.color()));
                views.setOnClickPendingIntent(R.id.clock_event, TodayWidget.eventIntent(context, next, id, 0));
            }
            manager.updateAppWidget(id, views);
        }
    }
}
