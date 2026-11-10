package rawkode.dev.today;

import static org.junit.Assert.*;

import org.junit.Test;

public class WidgetLayoutTest {
    // Lines the featured title needs at each of WidgetLayout.TITLE_SIZES.
    private static final int[] SHORT = { 1, 1, 1 };
    private static final int[] MEDIUM = { 1, 2, 2 };
    private static final int[] LONG = { 2, 3, 4 };

    @Test public void tallWidgetShowsEveryDetailAndRow() {
        var plan = WidgetLayout.plan(540, 1f, SHORT, true, true, false, 4);
        assertTrue(plan.location());
        assertEquals(4, plan.rows());
        assertFalse(plan.more());
    }

    @Test public void overflowReservesRoomForTheMoreLink() {
        var all = WidgetLayout.plan(540, 1f, SHORT, true, true, false, 9);
        assertTrue(all.rows() < 9);
        assertTrue(all.more());
        // Without the link one more row would have fit, so the link displaced it rather than being clipped.
        var fits = WidgetLayout.plan(540, 1f, SHORT, true, true, false, all.rows());
        assertFalse(fits.more());
    }

    @Test public void minimumSizeShowsTheFeaturedEventOnly() {
        var plan = WidgetLayout.plan(180, 1f, LONG, true, true, true, 3);
        assertEquals(22, plan.titleSize());
        assertEquals(0, plan.rows());
        assertFalse(plan.join());
        assertFalse(plan.largeDate());
    }

    @Test public void smallestSizeWithLargestTextShedsTheTimeBeforeClipping() {
        var plan = WidgetLayout.plan(180, 1.5f, LONG, true, false, false, 0);
        assertEquals(1, plan.titleLines());
        assertFalse(plan.timeRow());
        assertTrue(WidgetLayout.plan(180, 1f, LONG, true, false, false, 0).timeRow());
        assertFalse(WidgetLayout.plan(540, 1f, SHORT, false, false, false, 0).timeRow());
    }

    @Test public void largerTextFitsFewerRows() {
        int normal = WidgetLayout.plan(540, 1f, LONG, true, false, true, 20).rows();
        int large = WidgetLayout.plan(540, 1.5f, LONG, true, false, true, 20).rows();
        assertTrue(large < normal);
        assertTrue(large > 0);
    }

    @Test public void featuredDetailsComeBeforeRows() {
        var plan = WidgetLayout.plan(300, 1f, SHORT, true, false, true, 5);
        assertTrue(plan.join());
    }

    @Test public void spareHeightGoesToTheTitleAndDate() {
        // A tall widget on a short day: one other event leaves most of the height unused.
        var plan = WidgetLayout.plan(540, 1f, MEDIUM, true, false, false, 1);
        assertEquals(1, plan.rows());
        assertEquals(34, plan.titleSize());
        assertEquals(2, plan.titleLines());
        assertTrue(plan.largeDate());
    }

    @Test public void rowsAreNeverTradedForALargerTitle() {
        var busy = WidgetLayout.plan(540, 1f, MEDIUM, true, false, false, 20);
        var same = WidgetLayout.plan(540, 1f, new int[] { 1 }, true, false, false, 20);
        assertEquals(same.rows(), busy.rows());
        assertTrue(busy.more());
    }

    @Test public void titleNeverGrowsIntoAThirdLine() {
        var plan = WidgetLayout.plan(540, 1f, LONG, true, false, false, 0);
        assertEquals(22, plan.titleSize());
        assertEquals(2, plan.titleLines());
    }

    @Test public void clearDayShowsTheLargeDateOnlyWhenTall() {
        assertFalse(WidgetLayout.largeDateWithoutEvents(180, 1f));
        assertTrue(WidgetLayout.largeDateWithoutEvents(400, 1f));
    }
}
