package rawkode.dev.today;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Content-trigger jobs and alarms do not survive reboot; rebuild them if widgets exist. */
public final class WidgetBootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!WidgetRefresh.hasWidgets(context)) return;
        WidgetRefresh.start(context);
        // Give the widget receiver its own managed broadcast lifetime for the query.
        context.sendBroadcast(new Intent(context, TodayWidget.class).setAction("rawkode.dev.today.REFRESH"));
    }
}
