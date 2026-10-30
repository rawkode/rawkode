package rawkode.dev.today;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.view.View;
import android.provider.Settings;
import android.widget.Button;
import android.widget.TextView;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int CALENDAR_REQUEST = 1;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private TextView status;
    private Button permissionButton;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);
        status = findViewById(R.id.permission_status);
        permissionButton = findViewById(R.id.permission_button);
        permissionButton.setOnClickListener(view -> {
            if (checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED) {
                TodayWidget.refresh(this);
                status.setText(R.string.refreshed);
            } else if (getPreferences(MODE_PRIVATE).getBoolean("requested", false)
                    && !shouldShowRequestPermissionRationale(Manifest.permission.READ_CALENDAR)) {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", getPackageName(), null)));
            } else {
                getPreferences(MODE_PRIVATE).edit().putBoolean("requested", true).apply();
                requestPermissions(new String[] { Manifest.permission.READ_CALENDAR }, CALENDAR_REQUEST);
            }
        });
        findViewById(R.id.precise_updates_button).setOnClickListener(view -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                        Uri.fromParts("package", getPackageName(), null)));
            }
        });
        findViewById(R.id.add_widget_button).setOnClickListener(view -> pinWidget(TodayWidget.class));
        findViewById(R.id.add_clock_button).setOnClickListener(view -> pinWidget(ClockWidget.class));
    }

    private void pinWidget(Class<?> provider) {
        AppWidgetManager manager = AppWidgetManager.getInstance(this);
        if (manager.isRequestPinAppWidgetSupported()) {
            manager.requestPinAppWidget(new ComponentName(this, provider), null, null);
        } else {
            status.setText(R.string.pin_unavailable);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        updateState();
        TodayWidget.refresh(this);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == CALENDAR_REQUEST) {
            updateState();
            TodayWidget.refresh(this);
        }
    }

    private void updateState() {
        boolean granted = checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED;
        status.setText(granted ? R.string.permission_granted : R.string.permission_needed);
        boolean settings = getPreferences(MODE_PRIVATE).getBoolean("requested", false)
                && !shouldShowRequestPermissionRationale(Manifest.permission.READ_CALENDAR);
        permissionButton.setText(granted ? R.string.refresh_widget : settings ? R.string.open_settings : R.string.allow_calendar);
        boolean needsPreciseAccess = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && !getSystemService(AlarmManager.class).canScheduleExactAlarms();
        findViewById(R.id.precise_updates_button).setVisibility(needsPreciseAccess ? View.VISIBLE : View.GONE);
        updateWorkState(granted);
    }

    private void updateWorkState(boolean granted) {
        boolean work = CalendarEvents.hasWorkProfile(this);
        findViewById(R.id.work_heading).setVisibility(work && granted ? View.VISIBLE : View.GONE);
        TextView workStatus = findViewById(R.id.work_status);
        workStatus.setVisibility(work && granted ? View.VISIBLE : View.GONE);
        if (!work || !granted) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            workStatus.setText(R.string.work_unsupported);
            return;
        }
        // A cross-profile provider query; keep it off the main thread.
        EXECUTOR.execute(() -> {
            int calendars = CalendarEvents.workCalendarCount(getApplicationContext());
            runOnUiThread(() -> workStatus.setText(calendars > 0 ? R.string.work_connected : R.string.work_unavailable));
        });
    }
}
