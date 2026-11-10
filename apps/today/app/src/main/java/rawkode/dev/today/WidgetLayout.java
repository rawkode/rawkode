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
    static final float LIST_TOP = 4; // above the first row
    private static final float LIST_PADDING = LIST_TOP + 8; // and below the last
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
     * @param others     rows the list would show given the room: events other than the featured one,
     *                   and in a scrolling list the start of the next day
     * @param scrolls    whether the widget scrolls. Rows that do not fit are then a swipe away, so no
     *                   room is kept for the link that would summarize them.
     */
    static Plan plan(float height, float fontScale, int[] titleLines, boolean timeRow,
                     boolean location, boolean join, int others, boolean scrolls) {
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

        float row = row(s);
        float more = Math.max(MORE, LABEL_LINE * s + 12);
        int rows = 0;
        if (others > 0 && available >= LIST_PADDING + row) {
            float list = available - LIST_PADDING;
            rows = Math.min(others, (int) (list / row));
            if (rows < others && !scrolls) rows = Math.max(0, (int) ((list - more) / row));
            if (rows > 0) available = list - rows * row;
        }
        boolean showMore = !scrolls && rows < others && available >= more;
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

    /** Height in dp of a list of this many rows with the space around it, or 0 without rows. */
    static float listHeight(int rows, float fontScale) {
        return rows > 0 ? LIST_PADDING + rows * row(Math.max(1f, fontScale)) : 0;
    }

    /** How many of the wanted list rows fit below the clear-day state, which shows no events of its own. */
    static int rowsWithoutEvents(float height, float fontScale, int wanted) {
        float s = Math.max(1f, fontScale);
        return Math.max(0, Math.min(wanted, (int) ((clearRoom(height, s) - LIST_PADDING) / row(s))));
    }

    /** Whether the large date fits the clear-day state once the list below it has taken its rows. */
    static boolean largeDateWithoutEvents(float height, float fontScale, int rows) {
        float s = Math.max(1f, fontScale);
        return largeDate(clearRoom(height, s) - (rows > 0 ? LIST_PADDING + rows * row(s) : 0), s);
    }

    // Height left once the date line and the illustration with its two lines of text are placed.
    private static float clearRoom(float height, float s) {
        return height - PANEL_PADDING - LABEL_LINE * s - SLACK - 130 * s;
    }

    private static float row(float s) {
        return Math.max(ROW, ROW_LINE * s + 16);
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
