package tech.rawkode.today;

import static org.junit.Assert.*;

import org.junit.Test;

public class EventColorsTest {
    private static final double LIGHT_SURFACE = EventColors.luminance(0xffeeeeee);
    private static final double DARK_SURFACE = EventColors.luminance(0xff1c1b1f);

    @Test public void paleColorsDarkenForLightThemes() {
        int yellow = 0xffffeb3b;
        assertTrue(EventColors.contrast(EventColors.luminance(yellow), LIGHT_SURFACE) < 4.5);
        assertTrue(EventColors.contrast(EventColors.luminance(EventColors.forLight(yellow)), LIGHT_SURFACE) >= 4.5);
    }

    @Test public void deepColorsLightenForDarkThemes() {
        int navy = 0xff1a237e;
        assertTrue(EventColors.contrast(EventColors.luminance(navy), DARK_SURFACE) < 4.5);
        assertTrue(EventColors.contrast(EventColors.luminance(EventColors.forDark(navy)), DARK_SURFACE) >= 4.5);
    }

    @Test public void readableColorsAreUnchanged() {
        assertEquals(0xff3f51b5, EventColors.forLight(0xff3f51b5));
        assertEquals(0xfff6bf26, EventColors.forDark(0xfff6bf26));
    }

    @Test public void translucentProviderColorsBecomeOpaque() {
        assertEquals(0xff3f51b5, EventColors.forLight(0x003f51b5));
    }
}
