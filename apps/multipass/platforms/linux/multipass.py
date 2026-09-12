#!/usr/bin/env python3
"""Native GTK4 frontend. The Rust engine is the only source of application state."""
import argparse
from pathlib import Path
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gio, GLib, Gtk

from engine_client import EngineClient
from pairing_dialogs import show_join, show_pairing_code


def dispatch(callback, *args):
    def invoke():
        callback(*args)
        return GLib.SOURCE_REMOVE
    GLib.idle_add(invoke)


class MultipassWindow(Gtk.ApplicationWindow):
    def __init__(self, app, engine_path):
        super().__init__(application=app, title="Multipass")
        self.set_default_size(530, 480)
        self.rendering = False
        self.available = False
        self.closing = False
        self.engine = EngineClient(engine_path, self.receive, self.failed, dispatch)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
        for setter in (box.set_margin_top, box.set_margin_bottom, box.set_margin_start, box.set_margin_end):
            setter(24)
        self.set_child(box)

        def label(text, title=False):
            widget = Gtk.Label(label=text, xalign=0, wrap=True)
            if title:
                widget.add_css_class("title-2")
            box.append(widget)
            return widget

        label("Multipass", True)
        label("Switch your keyboard. Your mouse follows.")
        slot_row = Gtk.Box(spacing=12)
        slot_label = Gtk.Label(label="Mouse Bluetooth slot for this computer", xalign=0, hexpand=True)
        slot_row.append(slot_label)
        self.slot = Gtk.DropDown.new_from_strings(["1", "2", "3"])
        slot_row.append(self.slot)
        box.append(slot_row)
        enabled_row = Gtk.Box(spacing=12)
        enabled_row.append(Gtk.Label(label="Let the mouse follow my keyboard", xalign=0, hexpand=True))
        self.enabled = Gtk.Switch(valign=Gtk.Align.CENTER)
        enabled_row.append(self.enabled)
        box.append(enabled_row)
        self.devices = label("Waiting for device status…")
        self.network = label("Starting engine…")
        self.paired = label("Not paired")
        buttons = Gtk.Box(spacing=12)
        self.create = Gtk.Button(label="Create pairing code")
        self.join = Gtk.Button(label="Join another computer")
        buttons.append(self.create)
        buttons.append(self.join)
        box.append(buttons)
        label("Latest activity", True)
        self.activity = label("")
        self.result = label("")
        self.result.add_css_class("dim-label")
        label("Keep this window open for automatic switching. Closing it quits Multipass.")
        self.slot.connect("notify::selected", self.change_slot)
        self.enabled.connect("notify::active", self.change_enabled)
        self.create.connect("clicked", lambda _: self.engine.send("create_pairing"))
        self.join.connect("clicked", lambda _: show_join(self, self.join_code))
        self.connect("close-request", self.close_requested)
        self.set_actions(False)
        self.available = self.engine.start()
        if self.available:
            self.engine.send("status")

    def set_actions(self, available):
        for widget in (self.slot, self.enabled, self.create, self.join):
            widget.set_sensitive(available)

    def change_slot(self, *_):
        if not self.rendering and self.available:
            self.engine.send("set_slot", slot=self.slot.get_selected() + 1)

    def change_enabled(self, *_):
        if not self.rendering and self.available:
            self.engine.send("set_enabled", enabled=self.enabled.get_active())

    def join_code(self, code):
        if self.available:
            self.engine.send("join_pairing", code=code)

    def failed(self, message):
        if self.closing:
            return
        self.available = False
        self.set_actions(False)
        self.network.set_text("Engine unavailable")
        self.result.remove_css_class("dim-label")
        self.result.add_css_class("error")
        self.result.set_text(message)

    @staticmethod
    def device(value):
        return "Connected" if value is True else "Disconnected" if value is False else "Unknown"

    def receive(self, event):
        if self.closing or self.engine.faulted.is_set():
            return
        try:
            if event["type"] == "state":
                state = event["state"]
                slot = state["local_slot"]
                if type(slot) is not int or slot not in (1, 2, 3):
                    raise ValueError("Invalid slot")
                if type(state["enabled"]) is not bool or type(state["paired"]) is not bool:
                    raise ValueError("Invalid state")
                self.rendering = True
                try:
                    self.slot.set_selected(slot - 1)
                    self.enabled.set_active(state["enabled"])
                    self.devices.set_text(f"Keyboard: {self.device(state['keyboard_present'])}    Mouse: {self.device(state['mouse_present'])}")
                    self.network.set_text(f"{state['node_name']} · {state['network_status']} · Peers: {state['peers']}")
                    self.paired.set_text("Paired" if state["paired"] else "Not paired — create a code or join another computer.")
                    self.activity.set_text(state["last_event"])
                    self.set_actions(self.available)
                    self.confirmed_state = state
                finally:
                    self.rendering = False
            elif event["type"] == "result":
                self.result.set_text(event["message"])
                if event["ok"]:
                    self.result.remove_css_class("error")
                else:
                    self.result.add_css_class("error")
                if event["ok"] and isinstance(event.get("pairing_code"), str):
                    show_pairing_code(self, event["pairing_code"])
        except (KeyError, TypeError, ValueError):
            self.engine.fatal("The engine response is incompatible with this app. Reinstall the complete package.")

    def close_requested(self, *_):
        self.closing = True
        self.set_actions(False)
        self.engine.close()
        return False


class MultipassApplication(Gtk.Application):
    def __init__(self, engine_path):
        super().__init__(application_id="dev.rawkode.multipass", flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.engine_path = engine_path
        self.window = None

    def do_activate(self):
        if self.window is None:
            self.window = MultipassWindow(self, self.engine_path)
        self.window.present()

    def do_shutdown(self):
        if self.window is not None:
            self.window.closing = True
            self.window.engine.close()
        Gtk.Application.do_shutdown(self)


def main():
    parser = argparse.ArgumentParser(description="Multipass native GTK4 frontend")
    parser.add_argument("--engine", type=Path, default=Path(__file__).resolve().parent / "multipass-engine")
    args = parser.parse_args()
    return MultipassApplication(args.engine.resolve()).run([sys.argv[0]])


if __name__ == "__main__":
    raise SystemExit(main())
