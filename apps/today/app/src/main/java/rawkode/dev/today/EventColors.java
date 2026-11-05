package rawkode.dev.today;

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
    // Non-text marks such as the calendar color bar need 3:1, so pastel calendars stay closer to their own color.
    private static final double MIN_GRAPHIC_CONTRAST = 3.0;

    private EventColors() {}

    /** Text in the calendar's color, or the theme's primary color when the event has none. */
    static void apply(Context context, RemoteViews views, int viewId, Integer color) {
        tint(context, views, viewId, "setTextColor", color, MIN_CONTRAST);
    }

    /** Tints an ImageView, such as the calendar color bar, with the calendar's color. */
    static void applyIndicator(Context context, RemoteViews views, int viewId, Integer color) {
        tint(context, views, viewId, "setColorFilter", color, MIN_GRAPHIC_CONTRAST);
    }

    // Android 12+ hosts pick the light or dark variant when they draw, so a theme switch
    // needs no widget update. Older versions use the theme at the time of the update.
    private static void tint(Context context, RemoteViews views, int viewId, String method, Integer color,
                             double minContrast) {
        if (color == null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                views.setColor(viewId, method, R.color.today_primary);
            } else {
                views.setInt(viewId, method, context.getColor(R.color.today_primary));
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            views.setColorInt(viewId, method, forLight(color, minContrast), forDark(color, minContrast));
        } else {
            boolean night = (context.getResources().getConfiguration().uiMode
                    & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
            views.setInt(viewId, method, night ? forDark(color, minContrast) : forLight(color, minContrast));
        }
    }

    static int forLight(int color) {
        return forLight(color, MIN_CONTRAST);
    }

    static int forDark(int color) {
        return forDark(color, MIN_CONTRAST);
    }

    static int forLight(int color, double minContrast) {
        return readable(color, 0xff000000, LIGHT_SURFACE, minContrast);
    }

    static int forDark(int color, double minContrast) {
        return readable(color, 0xffffffff, DARK_SURFACE, minContrast);
    }

    // Blend toward black or white in small steps until the color meets the contrast target.
    private static int readable(int color, int toward, double surface, double minContrast) {
        int opaque = color | 0xff000000;
        for (int step = 0; step < 10; step++) {
            int mixed = mix(opaque, toward, step / 10.0);
            if (contrast(luminance(mixed), surface) >= minContrast) return mixed;
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
