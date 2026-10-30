package tech.rawkode.today;

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
    private static final long WINDOW_MILLIS = 10 * 60 * 1000L;
    private static final String REFRESH_ACTION = "tech.rawkode.today.REFRESH";
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

    // The next start/end or midnight in epoch milliseconds. Zero cancels the alarm.
    // RTC (not RTC_WAKEUP) avoids waking the device solely to redraw a widget.
    static void schedule(Context context, long nextBoundaryMillis, boolean precise) {
        synchronized (LOCK) {
            AlarmManager alarms = context.getSystemService(AlarmManager.class);
            PendingIntent alarm = alarmIntent(context);
            if (nextBoundaryMillis <= System.currentTimeMillis() || !hasWidgets(context)) {
                alarms.cancel(alarm);
            } else if (precise && canScheduleExact(context)) {
                alarms.setExact(AlarmManager.RTC, nextBoundaryMillis, alarm);
            } else {
                alarms.setWindow(AlarmManager.RTC, nextBoundaryMillis, WINDOW_MILLIS, alarm);
            }
        }
    }

    static boolean canScheduleExact(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || context.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    static void stop(Context context) {
        synchronized (LOCK) {
            context.getSystemService(JobScheduler.class).cancel(CONTENT_JOB_ID);
            context.getSystemService(AlarmManager.class).cancel(alarmIntent(context));
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

    private static PendingIntent alarmIntent(Context context) {
        Intent intent = new Intent(context, TodayWidget.class).setAction(REFRESH_ACTION);
        return PendingIntent.getBroadcast(context, 1, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
