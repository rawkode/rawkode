#!/usr/bin/env python3
"""Native GTK4 frontend. The Rust engine is the only source of application state."""
import argparse
from pathlib import Path
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gio, GLib, Gtk

from engine_client import EngineClient
from pairing_dialogs import show_pairing


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
        self.nearby = []
        self.pairing = None
        self.pairing_dialog = None
        self.pair_buttons = []
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
        paired_row = Gtk.Box(spacing=12)
        self.paired = Gtk.Label(label="Not paired", xalign=0, hexpand=True, wrap=True)
        paired_row.append(self.paired)
        self.forget = Gtk.Button(label="Forget pairing", visible=False)
        paired_row.append(self.forget)
        box.append(paired_row)
        label("Nearby computers", True)
        self.peers = Gtk.ListBox()
        self.peers.set_selection_mode(Gtk.SelectionMode.NONE)
        self.peers.add_css_class("boxed-list")
        self.peers_placeholder = Gtk.Label(label="Looking for other computers running Multipass on this network…", xalign=0, wrap=True)
        self.peers.set_placeholder(self.peers_placeholder)
        box.append(self.peers)
        label("Latest activity", True)
        self.activity = label("")
        self.result = label("")
        self.result.add_css_class("dim-label")
        label("Keep this window open for automatic switching. Closing it quits Multipass.")
        self.slot.connect("notify::selected", self.change_slot)
        self.enabled.connect("notify::active", self.change_enabled)
        self.forget.connect("clicked", lambda _: self.engine.send("unpair"))
        self.connect("close-request", self.close_requested)
        self.set_actions(False)
        self.available = self.engine.start()
        if self.available:
            self.engine.send("status")

    def set_actions(self, available):
        for widget in (self.slot, self.enabled, self.forget, *self.pair_buttons):
            widget.set_sensitive(available)

    def change_slot(self, *_):
        if not self.rendering and self.available:
            self.engine.send("set_slot", slot=self.slot.get_selected() + 1)

    def change_enabled(self, *_):
        if not self.rendering and self.available:
            self.engine.send("set_enabled", enabled=self.enabled.get_active())

    def pair(self, peer_id):
        if self.available:
            self.engine.send("pair", peer=peer_id)

    def decide(self, accept):
        if self.available:
            self.engine.send("confirm_pairing", accept=accept)

    def render_peers(self, nearby):
        if nearby == self.nearby:
            return
        self.nearby = nearby
        while (row := self.peers.get_row_at_index(0)) is not None:
            self.peers.remove(row)
        self.pair_buttons = []
        for peer in nearby:
            row = Gtk.Box(spacing=12)
            for setter in (row.set_margin_top, row.set_margin_bottom, row.set_margin_start, row.set_margin_end):
                setter(8)
            row.append(Gtk.Label(label=peer["name"], xalign=0, hexpand=True, ellipsize=3))
            button = Gtk.Button(label="Pair…")
            button.connect("clicked", lambda _, peer_id=peer["id"]: self.pair(peer_id))
            row.append(button)
            self.pair_buttons.append(button)
            self.peers.append(row)

    def render_pairing(self, pairing):
        if pairing == self.pairing:
            return
        self.pairing = pairing
        if self.pairing_dialog is not None:
            self.pairing_dialog.settle()
            self.pairing_dialog = None
        if pairing is not None:
            self.pairing_dialog = show_pairing(self, pairing, self.decide)
            if pairing["incoming"]:
                self.present()

    def failed(self, message):
        if self.closing:
            return
        self.available = False
        self.set_actions(False)
        self.render_pairing(None)
        self.network.set_text("Engine unavailable")
        self.result.remove_css_class("dim-label")
        self.result.add_css_class("error")
        self.result.set_text(message)

    @staticmethod
    def device(value):
        return "Connected" if value is True else "Disconnected" if value is False else "Unknown"

    @staticmethod
    def validate_nearby(value):
        if not isinstance(value, list):
            raise ValueError("Invalid nearby list")
        for peer in value:
            if not isinstance(peer, dict) or not isinstance(peer.get("id"), str) or not isinstance(peer.get("name"), str):
                raise ValueError("Invalid peer")
        return [{"id": peer["id"], "name": peer["name"]} for peer in value]

    @staticmethod
    def validate_pairing(value):
        if value is None:
            return None
        if not isinstance(value, dict) or not isinstance(value.get("peer_name"), str) or type(value.get("incoming")) is not bool:
            raise ValueError("Invalid pairing state")
        code = value.get("code")
        if code is not None and (not isinstance(code, str) or not code.isdigit()):
            raise ValueError("Invalid pairing code")
        return {"peer_name": value["peer_name"], "code": code, "incoming": value["incoming"]}

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
                nearby = self.validate_nearby(state["nearby"])
                pairing = self.validate_pairing(state["pairing"])
                self.rendering = True
                try:
                    self.slot.set_selected(slot - 1)
                    self.enabled.set_active(state["enabled"])
                    self.devices.set_text(f"Keyboard: {self.device(state['keyboard_present'])}    Mouse: {self.device(state['mouse_present'])}")
                    self.network.set_text(f"{state['node_name']} · {state['network_status']} · Peers: {state['peers']}")
                    self.paired.set_text("Paired" if state["paired"] else "Not paired — choose a nearby computer to pair with.")
                    self.forget.set_visible(state["paired"])
                    self.render_peers(nearby)
                    self.render_pairing(pairing)
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
        except (KeyError, TypeError, ValueError):
            self.engine.fatal("The engine response is incompatible with this app. Reinstall the complete package.")

    def close_requested(self, *_):
        self.closing = True
        self.set_actions(False)
        self.render_pairing(None)
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
