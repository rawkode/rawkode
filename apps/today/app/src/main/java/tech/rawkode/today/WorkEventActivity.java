package tech.rawkode.today;

import android.annotation.TargetApi;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentUris;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.provider.CalendarContract;
import android.util.Log;
import android.widget.Toast;

/**
 * Opens work-profile events. Android only forwards them to this same app inside the work
 * profile, which then hands the event to the work calendar app. Shows no UI of its own.
 */
public final class WorkEventActivity extends Activity {
    private static final String TAG = "TodayWorkEvent";

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent intent = getIntent();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (CalendarContract.ACTION_VIEW_MANAGED_PROFILE_CALENDAR_EVENT.equals(intent.getAction())) {
                openInThisProfile(intent);
            } else if (intent.getData() != null) {
                openInWorkProfile(intent);
            }
        }
        finish();
    }

    // Running in the work profile, forwarded by the personal profile's widget.
    @TargetApi(Build.VERSION_CODES.Q)
    private void openInThisProfile(Intent intent) {
        long id = intent.getLongExtra(CalendarContract.EXTRA_EVENT_ID, -1);
        if (id < 0) return;
        Intent view = new Intent(Intent.ACTION_VIEW)
                .setData(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id))
                .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, intent.getLongExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, 0))
                .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, intent.getLongExtra(CalendarContract.EXTRA_EVENT_END_TIME, 0))
                .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, intent.getBooleanExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, false));
        try {
            startActivity(view);
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "No work calendar app can open the event", e);
            Toast.makeText(this, R.string.work_event_no_calendar, Toast.LENGTH_LONG).show();
        }
    }

    @TargetApi(Build.VERSION_CODES.Q)
    private void openInWorkProfile(Intent intent) {
        boolean started = false;
        try {
            started = CalendarContract.startViewCalendarEventInManagedProfile(this,
                    ContentUris.parseId(intent.getData()),
                    intent.getLongExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, 0),
                    intent.getLongExtra(CalendarContract.EXTRA_EVENT_END_TIME, 0),
                    intent.getBooleanExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, false), 0);
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not open the event in the work profile", e);
        }
        if (!started) Toast.makeText(this, R.string.work_event_unavailable, Toast.LENGTH_LONG).show();
    }
}
