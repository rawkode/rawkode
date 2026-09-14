"""Transient native pairing prompt. The engine owns the pairing; this only shows the code."""
from gi.repository import Gtk


def spaced(code):
    return f"{code[:3]} {code[3:]}" if len(code) == 6 else code


def show_pairing(parent, pairing, decide):
    """Show the code for the pairing in progress. Returns the window; close it with
    ``settle()`` when the engine reports the pairing finished, so closing does not
    count as a decline."""
    name = pairing["peer_name"]
    incoming = pairing["incoming"]
    code = pairing.get("code")
    window = Gtk.Window(title="Pair with another computer", transient_for=parent, modal=True, destroy_with_parent=True)
    window.set_default_size(460, 220)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    for setter in (box.set_margin_top, box.set_margin_bottom, box.set_margin_start, box.set_margin_end):
        setter(20)
    window.set_child(box)
    buttons = Gtk.Box(spacing=12, halign=Gtk.Align.END)
    state = {"settled": False}

    def answer(accept):
        if state["settled"]:
            return
        state["settled"] = True
        window.close()
        decide(accept)

    if code is None:
        box.append(Gtk.Label(label=f"Connecting to “{name}”…", xalign=0, wrap=True))
        cancel = Gtk.Button(label="Cancel")
        cancel.connect("clicked", lambda _: answer(False))
        buttons.append(cancel)
    else:
        heading = f"“{name}” wants to pair with this computer." if incoming else f"Pairing with “{name}”."
        box.append(Gtk.Label(label=heading, xalign=0, wrap=True))
        digits = Gtk.Label(label=spaced(code), selectable=True)
        digits.add_css_class("title-1")
        box.append(digits)
        box.append(Gtk.Label(label=f"Confirm only if {name} shows the same code. Both computers must confirm.", xalign=0, wrap=True))
        decline = Gtk.Button(label="Decline" if incoming else "Cancel")
        accept = Gtk.Button(label="Accept" if incoming else "Confirm")
        accept.add_css_class("suggested-action")
        decline.connect("clicked", lambda _: answer(False))
        accept.connect("clicked", lambda _: answer(True))
        buttons.append(decline)
        buttons.append(accept)
        window.set_default_widget(accept)
    box.append(buttons)

    def closed(*_):
        # Closing the prompt with the window button declines, unless the engine already finished.
        if not state["settled"]:
            state["settled"] = True
            decide(False)
        return False

    def settle():
        state["settled"] = True
        window.close()

    window.settle = settle
    window.connect("close-request", closed)
    window.present()
    return window
