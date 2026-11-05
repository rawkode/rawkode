package rawkode.dev.today;

import static org.junit.Assert.*;

import org.junit.Test;

public class WidgetLayoutTest {
    @Test public void tallWidgetShowsEveryDetailAndRow() {
        var plan = WidgetLayout.plan(540, 1f, 1, true, true, false, 4);
        assertTrue(plan.location());
        assertEquals(4, plan.rows());
        assertFalse(plan.more());
    }

    @Test public void overflowReservesRoomForTheMoreLink() {
        var all = WidgetLayout.plan(540, 1f, 1, true, true, false, 7);
        assertTrue(all.rows() < 7);
        assertTrue(all.more());
        // Without the link one more row would have fit, so the link displaced it rather than being clipped.
        var fits = WidgetLayout.plan(540, 1f, 1, true, true, false, all.rows());
        assertFalse(fits.more());
    }

    @Test public void minimumSizeShowsTheFeaturedEventOnly() {
        var plan = WidgetLayout.plan(180, 1f, 2, true, true, true, 3);
        assertEquals(1, plan.titleLines());
        assertEquals(0, plan.rows());
        assertFalse(plan.join());
    }

    @Test public void smallestSizeWithLargestTextShedsTheTimeBeforeClipping() {
        var plan = WidgetLayout.plan(180, 1.5f, 2, true, false, false, 0);
        assertEquals(1, plan.titleLines());
        assertFalse(plan.timeRow());
        assertTrue(WidgetLayout.plan(180, 1f, 2, true, false, false, 0).timeRow());
        assertFalse(WidgetLayout.plan(540, 1f, 1, false, false, false, 0).timeRow());
    }

    @Test public void largerTextFitsFewerRows() {
        int normal = WidgetLayout.plan(540, 1f, 2, true, false, true, 20).rows();
        int large = WidgetLayout.plan(540, 1.5f, 2, true, false, true, 20).rows();
        assertTrue(large < normal);
        assertTrue(large > 0);
    }

    @Test public void featuredDetailsComeBeforeRows() {
        var plan = WidgetLayout.plan(300, 1f, 1, true, false, true, 5);
        assertTrue(plan.join());
    }
}
