#!/usr/bin/env python3
"""Native GTK4 frontend. The Rust engine is the only source of application state."""
import argparse
from datetime import datetime
from pathlib import Path
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gio, GLib, Gtk

from engine_client import EngineClient
from pairing_dialogs import show_pairing
from tray import Tray


def dispatch(callback, *args):
    def invoke():
        callback(*args)
        return GLib.SOURCE_REMOVE
    GLib.idle_add(invoke)


class MultipassWindow(Gtk.ApplicationWindow):
    def __init__(self, app, engine_path):
        super().__init__(application=app, title="Multipass")
        self.set_default_size(550, 570)
        self.rendering = False
        self.available = False
        self.closing = False
        self.peer_rows = None
        self.paired_peer = None
        self.paired_state = False
        self.credential_error = None
        self.slot_confirmed = False
        self.slot_dirty = False
        self.slot_request = None
        self.confirmed_state = None
        self.pairing = None
        self.pairing_dialog = None
        self.pair_buttons = []
        self.engine = EngineClient(engine_path, self.receive, self.failed, dispatch)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
        for setter in (box.set_margin_top, box.set_margin_bottom, box.set_margin_start, box.set_margin_end):
            setter(24)
        scroll = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER, vexpand=True)
        scroll.set_child(box)
        layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        layout.append(scroll)
        layout.append(Gtk.Separator())
        self.set_child(layout)

        def label(text, title=False):
            widget = Gtk.Label(label=text, xalign=0, wrap=True)
            if title:
                widget.add_css_class("title-2")
            box.append(widget)
            return widget

        label("Multipass", True)
        self.setup = label("Starting Multipass…")
        self.setup.add_css_class("heading")
        slot_row = Gtk.Box(spacing=12)
        slot_label = Gtk.Label(label="Mouse Bluetooth slot for this computer", xalign=0, hexpand=True)
        slot_row.append(slot_label)
        self.slot = Gtk.DropDown.new_from_strings(["1", "2", "3"])
        self.slot.update_property([Gtk.AccessibleProperty.LABEL], [slot_label.get_label()])
        slot_row.append(self.slot)
        self.confirm_slot = Gtk.Button(label="Confirm slot")
        self.confirm_slot.connect("clicked", self.save_slot)
        slot_row.append(self.confirm_slot)
        box.append(slot_row)
        self.slot_help = label("")
        enabled_row = Gtk.Box(spacing=12)
        enabled_label = Gtk.Label(label="Automatic switching", xalign=0, hexpand=True)
        enabled_row.append(enabled_label)
        self.enabled = Gtk.Switch(valign=Gtk.Align.CENTER)
        self.enabled.update_property([Gtk.AccessibleProperty.LABEL], [enabled_label.get_label()])
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
        self.peers_placeholder = Gtk.Label(label="Open Multipass on the other computer and connect both computers to the same local network.", xalign=0, wrap=True)
        self.peers.set_placeholder(self.peers_placeholder)
        box.append(self.peers)
        label("Latest activity", True)
        self.activity = label("")
        self.handoff = label("")
        self.handoff.set_visible(False)
        self.result = label("")
        self.result.set_visible(False)
        footer = Gtk.Box(spacing=12, margin_top=12, margin_bottom=12, margin_start=24, margin_end=24)
        self.background = Gtk.Label(
            label="Closing this window keeps Multipass running. Reopen it from your app launcher.",
            xalign=0, wrap=True, hexpand=True,
        )
        footer.append(self.background)
        quit_button = Gtk.Button(label="Quit Multipass", valign=Gtk.Align.CENTER)
        quit_button.set_action_name("app.quit")
        footer.append(quit_button)
        layout.append(footer)
        self.slot.connect("notify::selected", self.change_slot)
        self.enabled.connect("notify::active", self.change_enabled)
        self.forget.connect("clicked", lambda _: self.engine.send("unpair"))
        self.connect("close-request", self.close_requested)
        self.set_actions(False)
        self.available = self.engine.start()
        if self.available:
            self.engine.send("status")

    def set_actions(self, available):
        can_toggle = available and self.paired_state and self.slot_confirmed
        self.enabled.set_sensitive(can_toggle)
        self.slot.set_sensitive(available and self.slot_request is None)
        self.confirm_slot.set_sensitive(available and self.slot_request is None)
        self.confirm_slot.set_visible(not self.slot_confirmed or self.slot_dirty)
        self.forget.set_sensitive(available and self.pairing is None)
        for widget in self.pair_buttons:
            widget.set_sensitive(available and self.pairing is None and not self.credential_error)
        app = self.get_application()
        if app.tray is not None:
            app.tray.set_enabled(self.enabled.get_active() if can_toggle else None)

    def change_slot(self, *_):
        if not self.rendering and self.available:
            self.slot_dirty = True
            self.confirm_slot.set_visible(True)

    def save_slot(self, *_):
        if self.available and self.slot_request is None:
            self.slot_request = self.engine.send("set_slot", slot=self.slot.get_selected() + 1)
            self.set_actions(self.available)

    def change_enabled(self, *_):
        if not self.rendering:
            self.set_switching(self.enabled.get_active())

    def set_switching(self, enabled):
        if self.available and self.paired_state and self.slot_confirmed:
            self.engine.send("set_enabled", enabled=enabled)

    def pair(self, peer):
        if not self.available or self.credential_error:
            return
        if not self.paired_state:
            self.engine.send("pair", peer=peer["id"])
            return
        dialog = Gtk.AlertDialog(
            message=f"Replace the pairing with {peer['name']}?",
            detail="This changes the saved pairing and pauses automatic switching.",
            buttons=["Cancel", "Replace pairing"],
            cancel_button=0,
            default_button=0,
        )

        def chosen(source, result):
            try:
                if source.choose_finish(result) == 1 and self.available:
                    self.engine.send("pair", peer=peer["id"], replace=True)
            except GLib.Error:
                pass

        dialog.choose(self, None, chosen)

    def decide(self, accept):
        if self.available:
            self.engine.send("confirm_pairing", accept=accept)

    def render_peers(self, nearby):
        rows = (nearby, self.paired_peer, self.paired_state)
        if rows == self.peer_rows:
            return
        self.peer_rows = rows
        while (row := self.peers.get_row_at_index(0)) is not None:
            self.peers.remove(row)
        self.pair_buttons = []
        for peer in nearby:
            row = Gtk.Box(spacing=12)
            for setter in (row.set_margin_top, row.set_margin_bottom, row.set_margin_start, row.set_margin_end):
                setter(8)
            row.append(Gtk.Label(label=peer["name"], xalign=0, hexpand=True, ellipsize=3))
            if self.paired_peer and self.paired_peer["id"] == peer["id"]:
                row.append(Gtk.Label(label="Paired"))
            else:
                button = Gtk.Button(label="Replace pairing…" if self.paired_state else "Pair…")
                button.connect("clicked", lambda _, candidate=peer: self.pair(candidate))
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
            self.pairing_dialog = show_pairing(self, pairing, self.decide, replacing=self.paired_state)
            if pairing["incoming"]:
                self.present()

    def failed(self, message):
        if self.closing:
            return
        self.available = False
        self.set_actions(False)
        self.render_pairing(None)
        self.network.set_text("Engine unavailable")
        self.result.add_css_class("error")
        self.result.set_visible(True)
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
        confirmed = value.get("locally_confirmed", False)
        if type(confirmed) is not bool:
            raise ValueError("Invalid pairing confirmation state")
        return {"peer_name": value["peer_name"], "code": code, "incoming": value["incoming"],
                "locally_confirmed": confirmed}

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
                paired_peer = state.get("paired_peer")
                self.paired_peer = self.validate_nearby([paired_peer])[0] if paired_peer is not None else None
                self.paired_state = state["paired"]
                self.credential_error = state.get("credential_error")
                self.slot_confirmed = state.get("slot_confirmed", True)
                suggestion = state.get("suggested_slot")
                self.rendering = True
                try:
                    if not self.slot_dirty:
                        selected_slot = suggestion if not self.slot_confirmed and suggestion in (1, 2, 3) else slot
                        self.slot.set_selected(selected_slot - 1)
                    self.enabled.set_active(state["enabled"])
                    self.devices.set_text(f"Keyboard: {self.device(state['keyboard_present'])}    Mouse: {self.device(state['mouse_present'])}")
                    self.network.set_text(f"{state['node_name']} · {state['network_status']}")
                    if self.paired_peer:
                        pairing_label = f"Paired with {self.paired_peer['name']}"
                    else:
                        pairing_label = "Paired" if self.paired_state else "Not paired"
                    self.paired.set_text(pairing_label)
                    self.render_setup(suggestion, state["enabled"])
                    self.forget.set_visible(state["paired"])
                    self.render_peers(nearby)
                    self.render_pairing(pairing)
                    handoff = state.get("handoff")
                    activity = state["last_event"]
                    self.activity.set_text(activity)
                    self.activity.set_visible(bool(activity) and (handoff is None or activity != handoff["message"]))
                    self.render_handoff(handoff)
                    self.set_actions(self.available)
                    self.confirmed_state = state
                finally:
                    self.rendering = False
            elif event["type"] == "result":
                if event["id"] == self.slot_request:
                    self.slot_request = None
                    self.slot_dirty = not event["ok"]
                    self.set_actions(self.available)
                self.result.set_visible(not event["ok"])
                if not event["ok"]:
                    self.result.add_css_class("error")
                    self.result.set_text(event["message"])
        except (KeyError, TypeError, ValueError):
            self.engine.fatal("The engine response is incompatible with this app. Reinstall the complete package.")

    def render_setup(self, suggestion, enabled):
        if self.credential_error:
            message = self.credential_error
        elif not self.paired_state:
            message = "Pair with another computer"
        elif not self.slot_confirmed:
            message = "Confirm this computer’s mouse slot"
        elif not enabled:
            message = "Turn on automatic switching on both computers"
        else:
            message = "Automatic switching is on"
        self.setup.set_text(message)
        self.slot_help.set_visible(not self.slot_confirmed)
        self.slot_help.set_text(
            f"Multipass detected the mouse on slot {suggestion}. Verify it before confirming."
            if suggestion in (1, 2, 3) else
            "Select the number shown when the mouse is connected to this computer."
        )

    def render_handoff(self, handoff):
        self.handoff.set_visible(handoff is not None)
        if handoff is not None:
            timestamp = datetime.fromtimestamp(handoff["occurred_at"]).strftime("%H:%M")
            self.handoff.set_text(f"Last handoff at {timestamp} · {handoff['message']}")

    def close_requested(self, *_):
        self.set_visible(False)
        return True


class MultipassApplication(Gtk.Application):
    def __init__(self, engine_path):
        super().__init__(application_id="dev.rawkode.multipass", flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.engine_path = engine_path
        self.window = None
        self.tray = None
        quit_action = Gio.SimpleAction.new("quit", None)
        quit_action.connect("activate", lambda *_: self.quit())
        self.add_action(quit_action)
        self.set_accels_for_action("app.quit", ["<Primary>q"])

    def do_activate(self):
        if self.window is None:
            self.window = MultipassWindow(self, self.engine_path)
            connection = self.get_dbus_connection()
            if connection is not None:
                self.tray = Tray(connection, self.activate, self.toggle_switching,
                                 self.quit, self.tray_availability_changed)
        self.window.present()

    def toggle_switching(self):
        if self.window is not None:
            self.window.set_switching(not self.window.enabled.get_active())

    def tray_availability_changed(self, available):
        self.window.background.set_text(
            "Closing this window keeps Multipass running in the system tray." if available else
            "Closing this window keeps Multipass running. Reopen it from your app launcher."
        )

    def do_shutdown(self):
        if self.tray is not None:
            self.tray.close()
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
