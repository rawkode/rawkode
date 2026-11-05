package rawkode.dev.today;

import android.Manifest;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.provider.CalendarContract;
import android.os.Build;
import android.util.Log;

/** Schedules refreshes while at least one widget is installed. */
final class WidgetRefresh {
    private static final String TAG = "TodayWidgetRefresh";
    private static final int CONTENT_JOB_ID = 101;
    private static final int CHANGE_REQUEST = 1;
    private static final int TICK_REQUEST = 2;
    private static final long WINDOW_MILLIS = 10 * 60 * 1000L;
    static final String REFRESH_ACTION = "rawkode.dev.today.REFRESH";
    private static final Object LOCK = new Object();

    private WidgetRefresh() {}

    // Called after every widget update and on boot. Do not replace a pending/running job:
    // replacing it can discard a content change that hasn't been processed yet.
    static void start(Context context) {
        synchronized (LOCK) {
            JobScheduler scheduler = context.getSystemService(JobScheduler.class);
            if (!hasWidgets(context) || !hasCalendarPermission(context)) {
                scheduler.cancel(CONTENT_JOB_ID);
            } else if (scheduler.getPendingJob(CONTENT_JOB_ID) == null) {
                scheduleContentJob(context, scheduler);
            }
        }
    }

    /**
     * Arms the two refresh alarms, in epoch milliseconds; a time that has passed cancels its alarm.
     *
     * @param changeAt when an event starts, ends, or nears its start, or the day ends. This wakes the
     *                 device, so the widget is already correct when the screen turns on.
     * @param tickAt   when a minute countdown next changes. It does not wake the device: nobody sees a
     *                 countdown while the screen is off, and the change alarm catches up on wake.
     */
    static void schedule(Context context, long changeAt, long tickAt) {
        synchronized (LOCK) {
            AlarmManager alarms = context.getSystemService(AlarmManager.class);
            PendingIntent change = alarmIntent(context, CHANGE_REQUEST);
            PendingIntent tick = alarmIntent(context, TICK_REQUEST);
            long now = System.currentTimeMillis();
            boolean widgets = hasWidgets(context);
            boolean exact = canScheduleExact(context);
            if (!widgets || changeAt <= now || changeAt == Long.MAX_VALUE) {
                alarms.cancel(change);
            } else if (exact) {
                // Plain exact alarms wait for Doze to end; event boundaries are few enough to be allowed through.
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, changeAt, change);
            } else {
                alarms.setWindow(AlarmManager.RTC, changeAt, WINDOW_MILLIS, change);
            }
            if (!widgets || !exact || tickAt <= now || tickAt >= changeAt) {
                alarms.cancel(tick);
            } else {
                alarms.setExact(AlarmManager.RTC, tickAt, tick);
            }
        }
    }

    // USE_EXACT_ALARM grants this from Android 13; Android 12 users can revoke SCHEDULE_EXACT_ALARM.
    static boolean canScheduleExact(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || context.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    static void stop(Context context) {
        synchronized (LOCK) {
            context.getSystemService(JobScheduler.class).cancel(CONTENT_JOB_ID);
            AlarmManager alarms = context.getSystemService(AlarmManager.class);
            alarms.cancel(alarmIntent(context, CHANGE_REQUEST));
            alarms.cancel(alarmIntent(context, TICK_REQUEST));
        }
    }

    static boolean hasWidgets(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        return manager.getAppWidgetIds(new ComponentName(context, TodayWidget.class)).length > 0
                || manager.getAppWidgetIds(new ComponentName(context, ClockWidget.class)).length > 0;
    }

    // Rescheduling a running content-trigger job replaces it and transfers changes
    // made while it was running. Only call this after processing its current changes.
    static boolean rearm(Context context) {
        synchronized (LOCK) {
            JobScheduler scheduler = context.getSystemService(JobScheduler.class);
            if (hasWidgets(context) && hasCalendarPermission(context)) {
                return scheduleContentJob(context, scheduler);
            } else {
                scheduler.cancel(CONTENT_JOB_ID);
                return true;
            }
        }
    }

    private static boolean hasCalendarPermission(Context context) {
        return context.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean scheduleContentJob(Context context, JobScheduler scheduler) {
        JobInfo job = new JobInfo.Builder(CONTENT_JOB_ID, new ComponentName(context, CalendarChangeJob.class))
                .addTriggerContentUri(new JobInfo.TriggerContentUri(CalendarContract.CONTENT_URI,
                        JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
                .setTriggerContentUpdateDelay(1000)
                .setTriggerContentMaxDelay(10000)
                .build();
        try {
            if (scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS) return true;
            Log.w(TAG, "Could not schedule calendar change watcher; periodic refresh remains active");
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not schedule calendar change watcher; periodic refresh remains active", e);
        }
        return false;
    }

    // Distinct request codes keep the two alarms independent although they deliver the same broadcast.
    private static PendingIntent alarmIntent(Context context, int requestCode) {
        Intent intent = new Intent(context, TodayWidget.class).setAction(REFRESH_ACTION);
        return PendingIntent.getBroadcast(context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
