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


def fail(message):
    errors.append(message)
    app.quit()
    return GLib.SOURCE_REMOVE


def inspect():
    window = app.window
    if window is None:
        return GLib.SOURCE_CONTINUE
    if window.engine.faulted.is_set():
        return fail("Engine failed before GTK rendered confirmed state")
    state = getattr(window, "confirmed_state", None)
    if state is None:
        return GLib.SOURCE_CONTINUE
    try:
        assert window.slot.get_selected() + 1 == state["local_slot"]
        assert window.enabled.get_active() == state["enabled"]
        assert "Keyboard:" in window.devices.get_text()
        assert "Mouse:" in window.devices.get_text()
        assert window.activity.get_text() == state["last_event"]
        assert window.engine.process.poll() is None
        child = window.engine.process
        window.close()
        assert child.poll() is not None, "Closing the GTK window left engine alive"
        verified.append(True)
    except AssertionError as error:
        return fail(str(error))
    app.quit()
    return GLib.SOURCE_REMOVE


GLib.timeout_add(100, inspect)
GLib.timeout_add_seconds(15, lambda: fail("Timed out waiting for native GTK state"))
app.run([sys.argv[0]])
configuration.cleanup()
if errors or not verified:
    raise SystemExit("GTK smoke failed: " + "; ".join(errors or ["No state rendered"]))
print("GTK smoke passed: native widgets rendered confirmed engine state; close stopped child")
