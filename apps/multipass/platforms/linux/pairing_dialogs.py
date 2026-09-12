"""Transient native pairing dialogs; codes are never written to settings or logs."""
from gi.repository import Gtk


def dialog(parent, title):
    window = Gtk.Window(title=title, transient_for=parent, modal=True, destroy_with_parent=True)
    window.set_default_size(460, 170)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    for setter in (box.set_margin_top, box.set_margin_bottom, box.set_margin_start, box.set_margin_end):
        setter(20)
    window.set_child(box)
    return window, box


def show_join(parent, submit):
    window, box = dialog(parent, "Join a computer")
    box.append(Gtk.Label(label="Enter the pairing code shown on your other computer.", xalign=0, wrap=True))
    entry = Gtk.PasswordEntry(show_peek_icon=True, hexpand=True)
    box.append(entry)
    button = Gtk.Button(label="Join", sensitive=False)
    box.append(button)
    entry.connect("changed", lambda widget: button.set_sensitive(bool(widget.get_text().strip())))

    def join(*_):
        code = entry.get_text().strip()
        if not code:
            return
        entry.set_text("")
        window.close()
        submit(code)

    def clear(*_):
        entry.set_text("")
        return False

    button.connect("clicked", join)
    entry.connect("activate", join)
    window.connect("close-request", clear)
    window.present()
    entry.grab_focus()


def show_pairing_code(parent, code):
    window, box = dialog(parent, "Pair another computer")
    box.append(Gtk.Label(label="On the other computer choose Join and enter this code.", xalign=0, wrap=True))
    entry = Gtk.Entry(editable=False, text=code)
    box.append(entry)
    button = Gtk.Button(label="Copy code")
    box.append(button)
    box.append(Gtk.Label(label="Keep this code private. Copying places it on your system clipboard.", xalign=0, wrap=True))

    def copy(*_):
        entry.get_clipboard().set(entry.get_text())
        button.set_label("Copied")

    def clear(*_):
        entry.set_text("")
        return False

    button.connect("clicked", copy)
    window.connect("close-request", clear)
    window.present()
