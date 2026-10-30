package tech.rawkode.today;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.util.Log;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** One-shot content watcher, rearmed after handling each batch of provider changes. */
public final class CalendarChangeJob extends JobService {
    private static final String TAG = "TodayCalendarChangeJob";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile AtomicBoolean stopped;

    @Override public boolean onStartJob(JobParameters params) {
        AtomicBoolean canceled = new AtomicBoolean(false);
        stopped = canceled;
        executor.execute(() -> {
            try {
                TodayWidget.updateAll(getApplicationContext());
            } catch (RuntimeException e) {
                Log.w(TAG, "Could not refresh calendar widget", e);
            } finally {
                // schedule() with the same ID replaces the running job and preserves
                // changes received since it started. No jobFinished() is needed.
                if (!canceled.get() && !WidgetRefresh.rearm(getApplicationContext())) {
                    jobFinished(params, true);
                }
            }
        });
        return true;
    }

    @Override public boolean onStopJob(JobParameters params) {
        AtomicBoolean canceled = stopped;
        if (canceled != null) canceled.set(true);
        return WidgetRefresh.hasWidgets(this);
    }

    @Override public void onDestroy() {
        executor.shutdown();
        super.onDestroy();
    }
}
