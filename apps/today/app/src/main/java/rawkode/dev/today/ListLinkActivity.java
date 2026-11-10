package rawkode.dev.today;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.CalendarContract;
import android.util.Log;

/**
 * Opens whatever was tapped in the scrolling dashboard. Lines of a widget list cannot carry a
 * PendingIntent of their own: the list has one, which each tap target completes with its link, and
 * Android only lets a completable PendingIntent name a component of this app. This activity is
 * that component, and passes the link on to the app that handles it. Shows no UI of its own.
 */
public final class ListLinkActivity extends Activity {
    private static final String TAG = "TodayListLink";
    private static final String EXTRA_WORK = "rawkode.dev.today.extra.WORK";

    /** A link to a web page, a map location, or a time in the calendar. */
    static Intent link(Uri uri) {
        return new Intent().setData(uri);
    }

    /** A link to an event's details. */
    static Intent link(CalendarEvents.Event event) {
        return link(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, event.id()))
                .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, event.start())
                .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, event.end())
                .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, event.allDay())
                .putExtra(EXTRA_WORK, event.work());
    }

    /** The intent that opens a link, for tap targets that can hold a PendingIntent of their own. */
    static Intent open(Context context, Intent link) {
        // Work event IDs belong to the work profile's provider; the personal calendar app can't open them.
        Intent target = link.getBooleanExtra(EXTRA_WORK, false)
                ? new Intent(context, WorkEventActivity.class) : new Intent(Intent.ACTION_VIEW);
        target.setData(link.getData());
        for (String time : new String[] { CalendarContract.EXTRA_EVENT_BEGIN_TIME, CalendarContract.EXTRA_EVENT_END_TIME }) {
            if (link.hasExtra(time)) target.putExtra(time, link.getLongExtra(time, 0));
        }
        if (link.hasExtra(CalendarContract.EXTRA_EVENT_ALL_DAY)) {
            target.putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY,
                    link.getBooleanExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, false));
        }
        return target;
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent link = getIntent();
        if (link.getData() != null) {
            try {
                // This activity leaves no task behind for the opened app to join.
                startActivity(open(this, link).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (ActivityNotFoundException e) {
                Log.w(TAG, "No app can open " + link.getData().getScheme() + " links", e);
            }
        }
        finish();
    }
}
