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
import android.text.StaticLayout;
import android.text.TextPaint;
import android.util.ArrayMap;
import android.util.DisplayMetrics;
import android.util.SizeF;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class TodayWidget extends AppWidgetProvider {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final int MAX_ROWS = 12;
    private static final int MAX_SIZES = 16;
    // Today and the six days after it are within reach of a swipe.
    private static final int DAYS = 7;
    // Lines of the next day shown below today's when they fit, a heading and its first event: enough
    // to show that the widget scrolls on.
    private static final int PEEK = 2;
    // An update reaches the launcher in one binder transaction carrying every size's rows, so the
    // lines below the panel are capped per size and across sizes.
    private static final int MAX_ITEMS = 60;
    private static final int ITEM_BUDGET = MAX_SIZES * MAX_ROWS;
    // Horizontal padding in today_widget.xml.
    private static final float SIDE_PADDING = 20 + 20;
    // A transient provider failure is retried sooner than the periodic update would.
    private static final long RETRY_MILLIS = 15 * 60 * 1000L;

    /**
     * Everything one update renders, read once and shared by every widget and size.
     *
     * @param upcoming the days after today that have events, for the scrolling dashboard
     * @param rewind   whether a scrolled dashboard returns to today
     */
    record Snapshot(List<CalendarEvents.Event> events, List<CalendarEvents.Day> upcoming, int focus, int error,
                    long now, boolean precise, boolean rewind, Typeface font) {}

    /** A line below the panel: an event of the given day (today when null), or the day's heading when the event is null. */
    private record Entry(CalendarEvents.Day day, CalendarEvents.Event event) {}

    @Override public void onEnabled(Context context) {
        WidgetRefresh.start(context);
    }

    @Override public void onDisabled(Context context) {
        if (!WidgetRefresh.hasWidgets(context)) WidgetRefresh.stop(context);
    }

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        updateAsync(context, goAsync(), true);
    }

    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager,
                                                     int id, Bundle options) {
        updateAsync(context, goAsync(), true);
    }

    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (WidgetRefresh.REFRESH_ACTION.equals(action) || Intent.ACTION_DATE_CHANGED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action) || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_LOCALE_CHANGED.equals(action)
                || AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action)) {
            updateAsync(context, goAsync(), true);
        } else if (WidgetRefresh.TICK_ACTION.equals(action)) {
            // Countdowns tick every minute; someone reading a later day should not be pulled back by one.
            updateAsync(context, goAsync(), false);
        } else {
            super.onReceive(context, intent);
        }
    }

    static void refresh(Context context) {
        updateAsync(context, null, true);
    }

    static void refresh(Context context, PendingResult pending) {
        updateAsync(context, pending, true);
    }

    private static void updateAsync(Context context, PendingResult pending, boolean rewind) {
        Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            try { updateAll(app, rewind); }
            finally { if (pending != null) pending.finish(); }
        });
    }

    static void updateAll(Context context) {
        updateAll(context, true);
    }

    private static synchronized void updateAll(Context context, boolean rewind) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, TodayWidget.class));
        int[] clockIds = manager.getAppWidgetIds(new ComponentName(context, ClockWidget.class));
        if (ids.length == 0 && clockIds.length == 0) return;
        List<CalendarEvents.Event> events = List.of();
        List<CalendarEvents.Day> upcoming = new ArrayList<>();
        int error = 0;
        try {
            // Only the dashboard, where it scrolls, shows more than today.
            List<CalendarEvents.Day> days = CalendarEvents.load(context, scrolls() && ids.length > 0 ? DAYS : 1);
            events = days.get(0).events();
            for (CalendarEvents.Day day : days.subList(1, days.size())) {
                if (!day.events().isEmpty()) upcoming.add(day);
            }
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

        Snapshot snapshot = new Snapshot(events, upcoming, focus, error, now, precise, rewind, deviceFont(context));
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
                int items = Math.max(MAX_ROWS, Math.min(MAX_ITEMS, ITEM_BUDGET / Math.min(sizes.size(), MAX_SIZES)));
                for (SizeF size : sizes) {
                    if (bySize.size() == MAX_SIZES) break;
                    if (!bySize.containsKey(size)) {
                        bySize.put(size, render(context, size.getWidth(), size.getHeight(), widgetId, snapshot, items));
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
        return render(context, width, height, widgetId, snapshot, MAX_ITEMS);
    }

    // RemoteViews can size a view and carry a list's lines inside an update only from Android 12.
    private static boolean scrolls() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
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

    /**
     * One complete picture of the widget. A launcher reapplies each update onto the views it inflated
     * for the last one, so anything left unset here keeps its previous value: rows pile up and hidden
     * views stay hidden. Every visibility is therefore set on every render, and the list is emptied first.
     *
     * @param itemLimit the most lines the scrolling dashboard may list below the panel
     */
    static RemoteViews render(Context context, float width, float height, int widgetId, Snapshot snapshot,
                              int itemLimit) {
        boolean failed = snapshot.error() != 0;
        boolean clear = !failed && snapshot.events().isEmpty();
        // A failed widget has nothing to scroll to, and its retry is not a link a list could carry.
        boolean scrolls = scrolls() && !failed;
        float fontScale = context.getResources().getConfiguration().fontScale;
        RemoteViews views = new RemoteViews(context.getPackageName(),
                scrolls ? R.layout.today_widget_scroll : R.layout.today_widget);
        // Where the widget scrolls, the panel is the first line of its list rather than part of the layout.
        RemoteViews panel = scrolls ? new RemoteViews(context.getPackageName(), R.layout.widget_panel_item) : views;

        show(panel, R.id.widget_message, failed);
        show(panel, R.id.clear_state, clear);
        show(panel, R.id.panel_spacer, !clear);
        show(panel, R.id.next_event, !failed && !clear);
        if (!scrolls) {
            views.removeAllViews(R.id.later_events);
            if (failed || clear) {
                show(views, R.id.later_events, false);
                show(views, R.id.more_events, false);
                show(views, R.id.list_end, false);
            }
        }

        if (failed) {
            showDate(views, snapshot.now(), false);
            views.setTextViewText(R.id.widget_message, context.getString(snapshot.error()));
            // Without calendar access the app's own screen is the way forward; any other failure is retried in place.
            views.setOnClickPendingIntent(R.id.widget_body, snapshot.error() == R.string.widget_permission
                    ? PendingIntent.getActivity(context, 0, new Intent(context, MainActivity.class),
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
                    : PendingIntent.getBroadcast(context, 0,
                            new Intent(context, TodayWidget.class).setAction(WidgetRefresh.REFRESH_ACTION),
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            return views;
        }
        tap(context, panel, scrolls ? R.id.panel_item : R.id.widget_body, scrolls,
                ListLinkActivity.link(calendarTime(System.currentTimeMillis())), 0);
        if (clear) {
            // Nothing is left today, but the coming days are still a swipe away below the illustration.
            List<Entry> entries = scrolls ? entries(List.of(), snapshot.upcoming(), itemLimit) : List.of();
            int rows = WidgetLayout.rowsWithoutEvents(height, fontScale, Math.min(entries.size(), PEEK));
            showDate(panel, snapshot.now(), WidgetLayout.largeDateWithoutEvents(height, fontScale, rows));
            panel.setTextViewText(R.id.clear_title, context.getString(LocalTime.now().getHour() < 12
                    ? R.string.clear_morning : R.string.clear_later));
            if (scrolls) showList(context, views, panel, entries, rows, height, fontScale, widgetId, snapshot);
        } else {
            showEvents(context, views, panel, width, height, fontScale, widgetId, snapshot, itemLimit);
        }
        return views;
    }

    /**
     * Makes a view open a link when tapped. Views inside the scrolling list complete the list's
     * PendingIntent with the link; elsewhere a view holds a PendingIntent of its own.
     */
    private static void tap(Context context, RemoteViews views, int viewId, boolean inList, Intent link,
                            int requestCode) {
        if (inList) {
            views.setOnClickFillInIntent(viewId, link);
        } else {
            views.setOnClickPendingIntent(viewId, PendingIntent.getActivity(context, requestCode,
                    ListLinkActivity.open(context, link), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
    }

    private static void show(RemoteViews views, int id, boolean visible) {
        views.setViewVisibility(id, visible ? View.VISIBLE : View.GONE);
    }

    // One line beside the featured event, or a large day number when the panel has height to spare.
    private static void showDate(RemoteViews views, long now, boolean large) {
        Locale locale = Locale.getDefault();
        Date today = new Date(now);
        show(views, R.id.date_compact, !large);
        show(views, R.id.date_large, large);
        views.setTextViewText(R.id.widget_day, format(locale, "EEEE", today));
        views.setTextViewText(R.id.widget_date, format(locale, "d MMMM", today));
        views.setTextViewText(R.id.date_number, format(locale, "d", today));
        views.setTextViewText(R.id.date_weekday, format(locale, "EEEE", today));
        views.setTextViewText(R.id.date_month, format(locale, "MMMM", today));
    }

    /**
     * @param views the widget, holding the list
     * @param panel what holds the featured event: the widget itself, or the panel's line where it scrolls
     */
    private static void showEvents(Context context, RemoteViews views, RemoteViews panel, float width, float height,
                                   float fontScale, int widgetId, Snapshot snapshot, int itemLimit) {
        List<CalendarEvents.Event> events = snapshot.events();
        long now = snapshot.now();
        CalendarEvents.Event next = events.get(snapshot.focus());
        List<CalendarEvents.Event> others = new ArrayList<>(events);
        others.remove(snapshot.focus());

        Uri meeting = EventActions.meetingLink(next);
        Uri map = EventActions.mapLink(next);
        int[] titleLines = new int[WidgetLayout.TITLE_SIZES.length];
        for (int i = 0; i < titleLines.length; i++) {
            titleLines[i] = lineCount(context, snapshot.font(), next.title(), WidgetLayout.TITLE_SIZES[i],
                    width - SIDE_PADDING);
        }
        boolean scrolls = panel != views;
        List<Entry> entries = scrolls ? entries(others, snapshot.upcoming(), itemLimit) : List.of();
        // Today's rows come first; the next day's first lines follow when the height allows.
        int wanted = scrolls ? Math.min(entries.size(), others.size() + PEEK) : others.size();
        WidgetLayout.Plan plan = WidgetLayout.plan(height, fontScale, titleLines, !next.allDay(), map != null,
                meeting != null, wanted, scrolls);

        showDate(panel, now, plan.largeDate());
        panel.setTextViewText(R.id.next_label, label(context, next, now, snapshot.precise()));
        EventColors.applyIndicator(context, panel, R.id.next_color, next.color());
        show(panel, R.id.next_conflict, Agenda.overlaps(next, events));
        panel.setTextViewText(R.id.next_title, next.title());
        panel.setTextViewTextSize(R.id.next_title, TypedValue.COMPLEX_UNIT_SP, plan.titleSize());
        panel.setInt(R.id.next_title, "setMaxLines", plan.titleLines());
        show(panel, R.id.next_time, plan.timeRow());
        panel.setTextViewText(R.id.next_time, CalendarEvents.timeRange(context, next));
        tap(context, panel, R.id.next_event, scrolls, ListLinkActivity.link(next), 31 * widgetId);
        show(panel, R.id.next_location, plan.location());
        if (plan.location()) {
            panel.setTextViewText(R.id.next_location, next.location().trim());
            panel.setContentDescription(R.id.next_location, context.getString(R.string.open_location, next.location().trim()));
            tap(context, panel, R.id.next_location, scrolls, ListLinkActivity.link(map), widgetId * 31 + 21);
        }
        show(panel, R.id.join_meeting, plan.join());
        if (plan.join()) {
            panel.setContentDescription(R.id.join_meeting, context.getString(R.string.join_event, next.title()));
            tap(context, panel, R.id.join_meeting, scrolls, ListLinkActivity.link(meeting), widgetId * 31 + 20);
        }
        if (scrolls) {
            showList(context, views, panel, entries, plan.rows(), height, fontScale, widgetId, snapshot);
            return;
        }

        int shown = Math.min(Math.min(plan.rows(), others.size()), MAX_ROWS);
        String[] times = new String[shown];
        float timeColumn = 0;
        for (int i = 0; i < shown; i++) {
            times[i] = CalendarEvents.timeLabel(context, others.get(i));
            timeColumn = Math.max(timeColumn, textWidth(context, snapshot.font(), times[i], 14, true));
        }
        for (int i = 0; i < shown; i++) {
            CalendarEvents.Event event = others.get(i);
            Uri join = joinLink(event, now);
            RemoteViews row = eventRow(context, event, events, times[i], timeColumn, join, now);
            if (join != null) tap(context, row, R.id.event_join, false, ListLinkActivity.link(join), widgetId * 31 + 100 + i);
            tap(context, row, R.id.event_row, false, ListLinkActivity.link(event), 31 * widgetId + i + 1);
            views.addView(R.id.later_events, row);
        }
        int hidden = others.size() - shown;
        boolean more = hidden > 0 && plan.more();
        show(views, R.id.later_events, shown > 0);
        show(views, R.id.more_events, more);
        show(views, R.id.list_end, shown > 0 || more);
        if (more) {
            views.setTextViewText(R.id.more_events, context.getResources().getQuantityString(R.plurals.more_events, hidden, hidden));
            views.setOnClickPendingIntent(R.id.more_events, calendarIntent(context, widgetId));
        }
    }

    /**
     * The lines below the panel where the widget scrolls: today's other events, then each coming day
     * under its heading. A heading is never the last line, so a day cut off by the limit is left out whole.
     */
    private static List<Entry> entries(List<CalendarEvents.Event> others, List<CalendarEvents.Day> upcoming, int limit) {
        List<Entry> entries = new ArrayList<>();
        for (CalendarEvents.Event event : others) {
            if (entries.size() == limit) return entries;
            entries.add(new Entry(null, event));
        }
        for (CalendarEvents.Day day : upcoming) {
            if (entries.size() + 2 > limit) break;
            entries.add(new Entry(day, null));
            for (CalendarEvents.Event event : day.events()) {
                if (entries.size() == limit) break;
                entries.add(new Entry(day, event));
            }
        }
        return entries;
    }

    /**
     * Fills the list that is the whole scrolling widget: the panel, then the entries. The panel is sized
     * so that it and the first rows fill the widget exactly, which is what shows before any swipe.
     * Launchers keep the scroll position across updates, so the list is sent back to the top when asked.
     *
     * @param rows entries showing below the panel before any swipe
     */
    @TargetApi(Build.VERSION_CODES.S)
    private static void showList(Context context, RemoteViews views, RemoteViews panel, List<Entry> entries, int rows,
                                 float height, float fontScale, int widgetId, Snapshot snapshot) {
        float density = context.getResources().getDisplayMetrics().density;
        int side = Math.round(SIDE_PADDING / 2 * density);
        rows = Math.min(rows, entries.size());
        panel.setViewLayoutHeight(R.id.panel, height - WidgetLayout.listHeight(rows, fontScale), TypedValue.COMPLEX_UNIT_DIP);
        panel.setViewPadding(R.id.panel_item, 0, 0, 0, rows > 0 ? Math.round(WidgetLayout.LIST_TOP * density) : 0);

        long now = snapshot.now();
        Locale locale = Locale.getDefault();
        ZoneId zone = ZoneId.systemDefault();
        LocalDate tomorrow = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().plusDays(1);
        String[] times = new String[entries.size()];
        float timeColumn = 0;
        for (int i = 0; i < times.length; i++) {
            if (entries.get(i).event() == null) continue;
            times[i] = CalendarEvents.timeLabel(context, entries.get(i).event());
            timeColumn = Math.max(timeColumn, textWidth(context, snapshot.font(), times[i], 14, true));
        }

        // Stable IDs let the launcher keep its place in the list when events come and go around it.
        RemoteViews.RemoteCollectionItems.Builder items = new RemoteViews.RemoteCollectionItems.Builder()
                .setHasStableIds(true).setViewTypeCount(3);
        Set<Long> ids = new HashSet<>();
        ids.add(Long.MIN_VALUE);
        items.addItem(Long.MIN_VALUE, panel);
        for (int i = 0; i < times.length; i++) {
            CalendarEvents.Day day = entries.get(i).day();
            CalendarEvents.Event event = entries.get(i).event();
            long epochDay = day == null ? 0 : day.date().toEpochDay();
            long id;
            RemoteViews line;
            if (event == null) {
                Date start = Date.from(day.date().atStartOfDay(zone).toInstant());
                line = new RemoteViews(context.getPackageName(), R.layout.widget_day);
                line.setTextViewText(R.id.day_name, day.date().equals(tomorrow) ? context.getString(R.string.tomorrow)
                        : format(locale, "EEEE", start));
                line.setTextViewText(R.id.day_date, format(locale, "d MMMM", start));
                line.setViewPadding(R.id.day_row, side, 0, side, Math.round(6 * density));
                line.setOnClickFillInIntent(R.id.day_row, ListLinkActivity.link(calendarTime(start.getTime())));
                id = -epochDay;
            } else {
                Uri join = joinLink(event, now);
                line = eventRow(context, event, day == null ? snapshot.events() : day.events(), times[i], timeColumn,
                        join, now);
                line.setViewPadding(R.id.event_row, side, 0, side, 0);
                if (join != null) line.setOnClickFillInIntent(R.id.event_join, ListLinkActivity.link(join));
                line.setOnClickFillInIntent(R.id.event_row, ListLinkActivity.link(event));
                // An all-day event spanning several days is listed once under each of them.
                id = 31 * (31 * (31 * event.id() + event.start()) + epochDay) + (event.work() ? 1 : 0);
            }
            while (!ids.add(id)) id++;
            items.addItem(id, line);
        }
        views.setRemoteAdapter(R.id.agenda_list, items.build());
        // A list has one PendingIntent for everything in it, which each tap target completes with its own link.
        views.setPendingIntentTemplate(R.id.agenda_list, PendingIntent.getActivity(context, widgetId,
                new Intent(context, ListLinkActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE));
        if (snapshot.rewind()) views.setScrollPosition(R.id.agenda_list, 0);
    }

    // Joining a meeting hours away is never the next step, so Join waits until it is close.
    private static Uri joinLink(CalendarEvents.Event event, long now) {
        return Agenda.imminent(event, now) ? EventActions.meetingLink(event) : null;
    }

    /**
     * One event of the list, without its tap targets. The scrolling list reuses row views for other
     * events, so everything that varies between rows is set here whichever way it goes.
     */
    private static RemoteViews eventRow(Context context, CalendarEvents.Event event, List<CalendarEvents.Event> day,
                                        String time, float timeColumn, Uri join, long now) {
        RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_event);
        row.setTextViewText(R.id.event_time, time);
        if (!event.allDay() && event.start() <= now) {
            EventColors.apply(context, row, R.id.event_time, null);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            row.setColor(R.id.event_time, "setTextColor", R.color.today_on_surface_variant);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Times line up in one column no wider than its longest label, whatever the clock format.
            row.setViewLayoutWidth(R.id.event_time, (float) Math.ceil(timeColumn * 1.05f + 2), TypedValue.COMPLEX_UNIT_DIP);
        }
        EventColors.applyIndicator(context, row, R.id.event_color, event.color());
        row.setTextViewText(R.id.event_title, event.title());
        // Once Join shows, it takes the overlap badge's place so the title keeps its room.
        row.setViewVisibility(R.id.event_conflict,
                join == null && Agenda.overlaps(event, day) ? View.VISIBLE : View.GONE);
        row.setViewVisibility(R.id.event_join, join != null ? View.VISIBLE : View.GONE);
        if (join != null) {
            row.setContentDescription(R.id.event_join, context.getString(R.string.join_event, event.title()));
        }
        return row;
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

    // Lines the bold text needs at this size in a column this many dp wide, as the launcher will wrap it.
    private static int lineCount(Context context, Typeface font, String text, float sp, float widthDp) {
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        TextPaint paint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        paint.setTypeface(Typeface.create(font, Typeface.BOLD));
        paint.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, metrics));
        int width = Math.max(1, (int) (widthDp * metrics.density));
        return StaticLayout.Builder.obtain(text, 0, text.length(), paint, width).build().getLineCount();
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
        return PendingIntent.getActivity(context, requestCode,
                new Intent(Intent.ACTION_VIEW, calendarTime(System.currentTimeMillis())),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // Opens the calendar app at this moment.
    private static Uri calendarTime(long millis) {
        return ContentUris.withAppendedId(CalendarContract.CONTENT_URI.buildUpon().appendPath("time").build(), millis);
    }

    static PendingIntent eventIntent(Context context, CalendarEvents.Event event, int widgetId, int row) {
        return PendingIntent.getActivity(context, 31 * widgetId + row,
                ListLinkActivity.open(context, ListLinkActivity.link(event)),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
