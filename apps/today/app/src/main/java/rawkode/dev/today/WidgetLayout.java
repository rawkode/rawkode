package rawkode.dev.today;

/**
 * Decides what fits in the dashboard. A launcher draws RemoteViews without telling the app what was
 * clipped, so this mirrors the heights in today_widget.xml and widget_event.xml, in dp. Keep them in sync.
 */
final class WidgetLayout {
    private static final float PADDING = 12 + 12;
    private static final float HEADER = 40;
    private static final float HERO_TOP = 8;
    private static final float TITLE_TOP = 4;
    private static final float TIME_TOP = 6;
    private static final float ICON = 18;
    private static final float LOCATION_TOP = 2;
    private static final float LOCATION = 32;
    private static final float JOIN_TOP = 12;
    private static final float JOIN = 40;
    private static final float LIST_TOP = 14 + 1 + 4; // divider and its margins
    private static final float ROW = 48;
    private static final float MORE = 36;
    // Absorbs differences between device fonts; layoutlib's Roboto measures within 1dp of these estimates.
    private static final float SLACK = 10;
    // Approximate line heights at font scale 1, about 1.35 times the text size.
    private static final float HEADER_LINE = 27; // 20sp
    private static final float LABEL_LINE = 20; // 14sp
    private static final float TITLE_LINE = 31; // 22sp
    private static final float BODY_LINE = 21; // 15sp
    private static final float ROW_LINE = 22; // 16sp

    private WidgetLayout() {}

    record Plan(int titleLines, boolean timeRow, boolean location, boolean join, int rows, boolean more) {}

    /**
     * @param titleLines lines the featured title needs at full width, 1 or 2
     * @param others     events other than the featured one, each needing a row
     */
    static Plan plan(float height, float fontScale, int titleLines, boolean timeRow,
                     boolean location, boolean join, int others) {
        float s = Math.max(1f, fontScale);
        float available = height - PADDING - Math.max(HEADER, HEADER_LINE * s) - SLACK;
        // At the smallest sizes and largest fonts, shed the title's second line and then the time rather than clip.
        int lines = Math.max(1, Math.min(2, titleLines));
        if (lines > 1 && available < hero(s, lines, timeRow)) lines = 1;
        boolean showTime = timeRow && available >= hero(s, lines, true);
        available -= hero(s, lines, showTime);

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
        if (others > 0 && available >= LIST_TOP + row) {
            float list = available - LIST_TOP;
            rows = Math.min(others, (int) (list / row));
            if (rows < others) rows = Math.max(0, (int) ((list - more) / row));
            if (rows > 0) available = list - rows * row;
        }
        return new Plan(lines, showTime, showLocation, showJoin, rows, rows < others && available >= more);
    }

    private static float hero(float s, int lines, boolean timeRow) {
        return HERO_TOP + LABEL_LINE * s + TITLE_TOP + lines * TITLE_LINE * s
                + (timeRow ? TIME_TOP + Math.max(ICON, BODY_LINE * s) : 0);
    }
}
