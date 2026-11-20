"""StatusNotifierItem endpoint for GTK4 desktops with a system tray."""
import gi
from gi.repository import Gio, GLib


ITEM_PATH = "/StatusNotifierItem"
MENU_PATH = "/com/canonical/dbusmenu"
ITEM_INTERFACE = "org.kde.StatusNotifierItem"
WATCHER_PATH = "/StatusNotifierWatcher"
WATCHERS = ("org.kde.StatusNotifierWatcher", "org.freedesktop.StatusNotifierWatcher")
PROPERTIES = "org.freedesktop.DBus.Properties"
HOST_PROPERTY = "IsStatusNotifierHostRegistered"

ITEM_XML = """<node>
      <interface name="org.kde.StatusNotifierItem">
        <property name="Category" type="s" access="read"/>
        <property name="Id" type="s" access="read"/>
        <property name="Title" type="s" access="read"/>
        <property name="Status" type="s" access="read"/>
        <property name="WindowId" type="i" access="read"/>
        <property name="IconName" type="s" access="read"/>
        <property name="IconPixmap" type="a(iiay)" access="read"/>
        <property name="OverlayIconName" type="s" access="read"/>
        <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
        <property name="AttentionIconName" type="s" access="read"/>
        <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
        <property name="AttentionMovieName" type="s" access="read"/>
        <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
        <property name="ItemIsMenu" type="b" access="read"/>
        <property name="Menu" type="o" access="read"/>
        <signal name="NewToolTip"/>
        <method name="Activate"><arg type="i"/><arg type="i"/></method>
        <method name="SecondaryActivate"><arg type="i"/><arg type="i"/></method>
        <method name="ContextMenu"><arg type="i"/><arg type="i"/></method>
        <method name="Scroll"><arg type="i"/><arg type="s"/></method>
      </interface>
    </node>"""
ITEM_PROTOCOLS = [
    Gio.DBusNodeInfo.new_for_xml(ITEM_XML.replace(ITEM_INTERFACE, interface))
    for interface in (ITEM_INTERFACE, "org.freedesktop.StatusNotifierItem")
]

STATIC_PROPERTIES = {
    "Category": GLib.Variant("s", "ApplicationStatus"),
    "Id": GLib.Variant("s", "dev.rawkode.multipass"),
    "Title": GLib.Variant("s", "Multipass"),
    "Status": GLib.Variant("s", "Active"),
    "WindowId": GLib.Variant("i", 0),
    "IconName": GLib.Variant("s", "input-mouse"),
    "IconPixmap": GLib.Variant("a(iiay)", []),
    "OverlayIconName": GLib.Variant("s", ""),
    "OverlayIconPixmap": GLib.Variant("a(iiay)", []),
    "AttentionIconName": GLib.Variant("s", ""),
    "AttentionIconPixmap": GLib.Variant("a(iiay)", []),
    "AttentionMovieName": GLib.Variant("s", ""),
    "ItemIsMenu": GLib.Variant("b", False),
    "Menu": GLib.Variant("o", MENU_PATH),
}


class Tray:
    """Keep the window recoverable only while a host can display the tray item."""

    def __init__(self, connection, open_window, toggle_enabled, quit_app, on_availability_changed):
        self.available = False
        self._enabled = None
        self._connection = connection
        self._open_window = open_window
        self._availability_changed = on_availability_changed
        self._menu = None
        self._item_exports = []
        self._watches = []
        self._owners = {}
        self._watcher = None
        self._subscriptions = []
        self._cancellable = None
        self._register_pending = False
        self._registered = False
        self._host_query = None

        if connection is None:
            return
        try:
            gi.require_version("Dbusmenu", "0.4")
            from gi.repository import Dbusmenu
        except (ImportError, ValueError):
            return

        root = Dbusmenu.Menuitem.new()

        def action(label, callback):
            item = Dbusmenu.Menuitem.new()
            item.property_set("label", label)
            item.connect("item-activated", lambda _item, _time: callback())
            root.child_append(item)
            return item

        action("Open Multipass", open_window)
        self._toggle = action("Resume Automatic Handoff", toggle_enabled)
        self._toggle.property_set_bool("enabled", False)
        action("Quit Multipass", quit_app)
        self._menu = Dbusmenu.Server.new(MENU_PATH)
        self._menu.set_root(root)
        try:
            for protocol in ITEM_PROTOCOLS:
                self._item_exports.append(connection.register_object(
                    ITEM_PATH, protocol.interfaces[0], self._method, self._property, None,
                ))
        except GLib.Error:
            self.close()
            return

        self._watches = [
            Gio.bus_watch_name_on_connection(
                connection, name, Gio.BusNameWatcherFlags.NONE,
                self._watcher_appeared, self._watcher_vanished,
            )
            for name in WATCHERS
        ]

    def set_enabled(self, enabled):
        if enabled == self._enabled:
            return
        self._enabled = enabled
        if not self._item_exports:
            return
        self._toggle.property_set("label", "Pause Automatic Handoff" if enabled else "Resume Automatic Handoff")
        self._toggle.property_set_bool("enabled", enabled is not None)
        for protocol in ITEM_PROTOCOLS:
            self._connection.emit_signal(
                None, ITEM_PATH, protocol.interfaces[0].name, "NewToolTip", None,
            )

    def close(self):
        for item in self._item_exports:
            self._connection.unregister_object(item)
        self._item_exports.clear()
        for watch in self._watches:
            Gio.bus_unwatch_name(watch)
        self._watches.clear()
        self._owners.clear()
        self._detach_watcher()
        if self._menu is not None:
            self._menu = None
            self._toggle = None

    def _method(self, _connection, _sender, _path, _interface, method, _parameters, invocation):
        invocation.return_value(None)
        # The host opens the exported DBusMenu itself for a context click.
        if method == "Activate":
            self._open_window()

    def _property(self, _connection, _sender, _path, _interface, prop):
        if prop == "ToolTip":
            status = {
                None: "Engine unavailable",
                False: "Automatic handoff paused",
                True: "Automatic handoff active",
            }[self._enabled]
            return GLib.Variant("(sa(iiay)ss)", ("input-mouse", [], "Multipass", status))
        return STATIC_PROPERTIES.get(prop)

    def _set_available(self, available):
        if available != self.available:
            self.available = available
            self._availability_changed(available)

    def _watcher_appeared(self, _connection, name, owner):
        if self._item_exports:
            self._owners[name] = owner
            self._select_watcher()

    def _watcher_vanished(self, _connection, name):
        self._owners.pop(name, None)
        self._select_watcher()

    def _select_watcher(self):
        watcher = next(((name, self._owners[name]) for name in WATCHERS if name in self._owners), None)
        if watcher == self._watcher:
            return
        self._detach_watcher()
        if watcher is None or not self._item_exports:
            return
        self._watcher = watcher
        name, owner = watcher
        self._cancellable = Gio.Cancellable()
        self._subscriptions = [
            self._connection.signal_subscribe(
                owner, interface, signal, WATCHER_PATH, arg,
                Gio.DBusSignalFlags.NONE, self._watcher_signal,
            )
            for interface, signal, arg in (
                (name, None, None),
                (PROPERTIES, "PropertiesChanged", name),
            )
        ]
        self._register()

    def _detach_watcher(self):
        if self._cancellable is not None:
            self._cancellable.cancel()
            self._cancellable = None
        for subscription in self._subscriptions:
            self._connection.signal_unsubscribe(subscription)
        self._subscriptions.clear()
        self._watcher = None
        self._register_pending = False
        self._registered = False
        self._host_query = None
        self._set_available(False)

    def _call_watcher(self, interface, method, args, result_type, on_reply):
        _, owner = self._watcher
        cancellable = self._cancellable

        def finish(connection, result):
            try:
                reply = connection.call_finish(result)
            except GLib.Error:
                reply = None
            if cancellable is self._cancellable:
                on_reply(reply)

        self._connection.call(
            owner, WATCHER_PATH, interface, method, args, result_type,
            Gio.DBusCallFlags.NO_AUTO_START, 2000, cancellable, finish,
        )

    def _register(self):
        if self._register_pending:
            return
        self._register_pending = True

        def registered(reply):
            self._register_pending = False
            self._registered = reply is not None
            if self._registered:
                self._refresh_host()

        self._call_watcher(
            self._watcher[0], "RegisterStatusNotifierItem",
            GLib.Variant("(s)", (ITEM_PATH,)), GLib.VariantType.new("()"), registered,
        )

    def _refresh_host(self):
        query = object()
        self._host_query = query

        def update(reply):
            if query is self._host_query:
                self._set_available(reply is not None and reply.unpack()[0] is True)

        self._call_watcher(
            PROPERTIES, "Get",
            GLib.Variant("(ss)", (self._watcher[0], HOST_PROPERTY)), GLib.VariantType.new("(v)"),
            update,
        )

    def _watcher_signal(self, _connection, sender, _path, _interface, signal, parameters):
        if self._watcher is None or sender != self._watcher[1]:
            return
        if signal == "PropertiesChanged":
            _, changed, invalidated = parameters.unpack()
            if HOST_PROPERTY not in changed and HOST_PROPERTY not in invalidated:
                return
        elif signal not in ("StatusNotifierHostRegistered", "StatusNotifierHostUnregistered"):
            return
        if self._registered:
            self._refresh_host()
        else:
            self._register()
