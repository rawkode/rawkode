package tech.rawkode.today;

import android.net.Uri;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Only surface recognized meeting links and plain locations supplied by the calendar. */
final class EventActions {
    private static final Pattern LINK = Pattern.compile("https://[^\\s<>\\\"']+", Pattern.CASE_INSENSITIVE);
    private static final String[] MEETING_HOSTS = {
            "meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com", "webex.com", "meet.jit.si"
    };

    static Uri meetingLink(CalendarEvents.Event event) {
        Uri fromLocation = meetingLink(event.location());
        return fromLocation != null ? fromLocation : meetingLink(event.description());
    }

    private static Uri meetingLink(String text) {
        if (text == null) return null;
        Matcher matches = LINK.matcher(text.replace("&amp;", "&"));
        while (matches.find()) {
            String url = matches.group();
            while (!url.isEmpty() && ".,;)]}".indexOf(url.charAt(url.length() - 1)) >= 0) {
                url = url.substring(0, url.length() - 1);
            }
            Uri uri = Uri.parse(url);
            String host = uri.getHost();
            if (host == null || uri.getUserInfo() != null) continue;
            host = host.toLowerCase(Locale.ROOT);
            for (String allowed : MEETING_HOSTS) {
                if (host.equals(allowed) || host.endsWith("." + allowed)) return uri;
            }
        }
        return null;
    }

    static Uri mapLink(CalendarEvents.Event event) {
        String location = event.location();
        if (location == null || location.trim().isEmpty() || location.contains("://")) return null;
        return Uri.parse("geo:0,0?q=" + Uri.encode(location.trim()));
    }
}
