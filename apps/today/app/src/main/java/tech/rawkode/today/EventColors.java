package tech.rawkode.today;

import android.content.Context;
import android.content.res.Configuration;
import android.os.Build;
import android.widget.RemoteViews;

/** Calendar colors adjusted to stay readable on the widget surface in light and dark themes. */
final class EventColors {
    // Approximate relative luminance of the light (tone 95) and dark (tone 10) widget surfaces.
    // Material You surfaces are low-chroma, so this holds for any wallpaper.
    private static final double LIGHT_SURFACE = 0.87;
    private static final double DARK_SURFACE = 0.012;
    private static final double MIN_CONTRAST = 4.5;

    private EventColors() {}

    // Android 12+ hosts pick the light or dark variant when they draw, so a theme switch
    // needs no widget update. Older versions use the theme at the time of the update.
    static void apply(Context context, RemoteViews views, int viewId, Integer color) {
        if (color == null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                views.setColor(viewId, "setTextColor", R.color.today_primary);
            } else {
                views.setTextColor(viewId, context.getColor(R.color.today_primary));
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            views.setColorInt(viewId, "setTextColor", forLight(color), forDark(color));
        } else {
            boolean night = (context.getResources().getConfiguration().uiMode
                    & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
            views.setTextColor(viewId, night ? forDark(color) : forLight(color));
        }
    }

    static int forLight(int color) {
        return readable(color, 0xff000000, LIGHT_SURFACE);
    }

    static int forDark(int color) {
        return readable(color, 0xffffffff, DARK_SURFACE);
    }

    // Blend toward black or white in small steps until the color meets text contrast.
    private static int readable(int color, int toward, double surface) {
        int opaque = color | 0xff000000;
        for (int step = 0; step < 10; step++) {
            int mixed = mix(opaque, toward, step / 10.0);
            if (contrast(luminance(mixed), surface) >= MIN_CONTRAST) return mixed;
        }
        return toward;
    }

    static double contrast(double a, double b) {
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }

    static double luminance(int color) {
        return 0.2126 * linear((color >> 16) & 0xff) + 0.7152 * linear((color >> 8) & 0xff)
                + 0.0722 * linear(color & 0xff);
    }

    private static double linear(int channel) {
        double c = channel / 255.0;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    private static int mix(int from, int to, double amount) {
        int r = (int) Math.round(((from >> 16) & 0xff) * (1 - amount) + ((to >> 16) & 0xff) * amount);
        int g = (int) Math.round(((from >> 8) & 0xff) * (1 - amount) + ((to >> 8) & 0xff) * amount);
        int b = (int) Math.round((from & 0xff) * (1 - amount) + (to & 0xff) * amount);
        return 0xff000000 | (r << 16) | (g << 8) | b;
    }
}
