#!/usr/bin/env python3
"""Native GTK plus real engine startup/render/owned shutdown smoke test."""
import argparse
import os
import tempfile
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from multipass import MultipassApplication
from gi.repository import GLib

parser = argparse.ArgumentParser()
parser.add_argument("--engine", required=True, type=Path)
args = parser.parse_args()
configuration = tempfile.TemporaryDirectory(prefix="multipass-gtk-smoke-")
os.environ["MULTIPASS_CONFIG_DIR"] = configuration.name
app = MultipassApplication(args.engine.resolve())
errors = []
verified = []
child = None


def fail(message):
    errors.append(message)
    app.quit()
    return GLib.SOURCE_REMOVE


def reopen():
    try:
        assert child.poll() is None, "The engine stopped while its window was closed"
        window = app.window
        app.activate()
        assert app.window is window and window.get_visible(), "Reopening did not reuse the window"
        assert window.engine.process is child, "Reopening started a second engine"
        verified.append(True)
    except AssertionError as error:
        return fail(str(error))
    app.quit()
    return GLib.SOURCE_REMOVE


def inspect():
    global child
    window = app.window
    if window is None:
        return GLib.SOURCE_CONTINUE
    if window.engine.faulted.is_set():
        return fail("Engine failed before GTK rendered confirmed state")
    state = getattr(window, "confirmed_state", None)
    if state is None:
        return GLib.SOURCE_CONTINUE
    try:
        expected_slot = state["local_slot"] if state.get("slot_confirmed", True) else (state.get("suggested_slot") or state["local_slot"])
        assert window.slot.get_selected() + 1 == expected_slot
        assert window.enabled.get_active() == state["enabled"]
        assert "Keyboard:" in window.devices.get_text()
        assert "Mouse:" in window.devices.get_text()
        assert window.activity.get_text() == state["last_event"]
        assert window.engine.process.poll() is None
        child = window.engine.process
        window.close()
        assert not window.get_visible(), "Closing should hide the GTK window"
        assert child.poll() is None, "Closing stopped automatic switching"
        GLib.timeout_add(250, reopen)
    except AssertionError as error:
        return fail(str(error))
    return GLib.SOURCE_REMOVE


GLib.timeout_add(100, inspect)
GLib.timeout_add_seconds(15, lambda: fail("Timed out waiting for native GTK state"))
app.run([sys.argv[0]])
configuration.cleanup()
if child is not None and child.poll() is None:
    errors.append("Quitting left the engine running")
if errors or not verified:
    raise SystemExit("GTK smoke failed: " + "; ".join(errors or ["No state rendered"]))
print("GTK smoke passed: native widgets rendered confirmed engine state; close kept the engine running; quit stopped it")
