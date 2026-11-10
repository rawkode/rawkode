package rawkode.dev.today;

/**
 * Decides what fits in the dashboard. A launcher draws RemoteViews without telling the app what was
 * clipped, so this mirrors the heights in today_widget.xml and widget_event.xml, in dp. Keep them in sync.
 */
final class WidgetLayout {
    /** Sizes the featured title may take, in sp, smallest first. The smallest always fits. */
    static final int[] TITLE_SIZES = { 22, 28, 34 };

    private static final float PANEL_PADDING = 14 + 16;
    private static final float HERO_TOP = 12;
    private static final float TITLE_TOP = 2;
    private static final float TIME_TOP = 4;
    private static final float LOCATION_TOP = 2;
    private static final float LOCATION = 32;
    private static final float JOIN_TOP = 12;
    private static final float JOIN = 40;
    private static final float LIST_PADDING = 4 + 8; // above the first row and below the last
    private static final float ROW = 48;
    private static final float MORE = 36;
    // Absorbs differences between device fonts.
    private static final float SLACK = 10;
    // Approximate line heights at font scale 1, about 1.4 times the text size.
    private static final float LINE = 1.4f;
    private static final float LABEL_LINE = 20; // 14sp
    private static final float BODY_LINE = 21; // 15sp
    private static final float ROW_LINE = 22; // 16sp
    // The large date replaces the one-line date once this much height is left over, so it never crowds the event.
    private static final float LARGE_DATE = 56; // 44sp without font padding
    private static final float LARGE_DATE_ROOM = 40;

    private WidgetLayout() {}

    record Plan(int titleSize, int titleLines, boolean timeRow, boolean location, boolean join, int rows,
                boolean more, boolean largeDate) {}

    /**
     * @param titleLines lines the featured title needs at each of {@link #TITLE_SIZES}
     * @param others     events other than the featured one, each needing a row
     */
    static Plan plan(float height, float fontScale, int[] titleLines, boolean timeRow,
                     boolean location, boolean join, int others) {
        float s = Math.max(1f, fontScale);
        float available = height - PANEL_PADDING - LABEL_LINE * s - SLACK;
        // At the smallest sizes and largest fonts, shed the title's second line and then the time rather than clip.
        int lines = Math.max(1, Math.min(2, titleLines[0]));
        if (lines > 1 && available < hero(s, title(0, lines), timeRow)) lines = 1;
        boolean showTime = timeRow && available >= hero(s, title(0, lines), true);
        available -= hero(s, title(0, lines), showTime);

        // The featured event's details come before more rows: they answer "where" and "how do I join".
        float joinHeight = JOIN_TOP + Math.max(JOIN, LABEL_LINE * s + 12);
        boolean showJoin = join && available >= joinHeight;
        if (showJoin) available -= joinHeight;
        float locationHeight = LOCATION_TOP + Math.max(LOCATION, BODY_LINE * s);
        boolean showLocation = location && available >= locationHeight;
        if (showLocation) available -= locationHeight;

        float row = Math.max(ROW, ROW_LINE * s + 16);
        float more = Math.max(MORE, LABEL_LINE * s + 12);
        int rows = 0;
        if (others > 0 && available >= LIST_PADDING + row) {
            float list = available - LIST_PADDING;
            rows = Math.min(others, (int) (list / row));
            if (rows < others) rows = Math.max(0, (int) ((list - more) / row));
            if (rows > 0) available = list - rows * row;
        }
        boolean showMore = rows < others && available >= more;
        if (showMore) available -= more;

        // Whatever height the day leaves over goes to the featured event and the date, not to blank surface.
        // A size that would need a third line is skipped: a truncated title is worse than a smaller one.
        int size = 0;
        for (int i = TITLE_SIZES.length - 1; i > 0; i--) {
            if (i >= titleLines.length || titleLines[i] > 2) continue;
            float extra = (title(i, Math.max(1, titleLines[i])) - title(0, lines)) * s;
            if (available >= extra) {
                size = i;
                lines = Math.max(1, titleLines[i]);
                available -= extra;
                break;
            }
        }
        boolean largeDate = largeDate(available, s);
        return new Plan(TITLE_SIZES[size], lines, showTime, showLocation, showJoin, rows, showMore, largeDate);
    }

    /** Whether the large date fits a widget that shows no events, such as the clear-day state. */
    static boolean largeDateWithoutEvents(float height, float fontScale) {
        float s = Math.max(1f, fontScale);
        // Leaves room for the illustration and its two lines of text.
        return largeDate(height - PANEL_PADDING - LABEL_LINE * s - SLACK - 130 * s, s);
    }

    private static boolean largeDate(float available, float s) {
        return available >= (LARGE_DATE - LABEL_LINE) * s + LARGE_DATE_ROOM;
    }

    private static float title(int size, int lines) {
        return lines * TITLE_SIZES[size] * LINE;
    }

    private static float hero(float s, float title, boolean timeRow) {
        return HERO_TOP + LABEL_LINE * s + TITLE_TOP + title * s + (timeRow ? TIME_TOP + BODY_LINE * s : 0);
    }
}
