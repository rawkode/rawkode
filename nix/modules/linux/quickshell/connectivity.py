#!/usr/bin/env python3
"""JSON-lines desktop connectivity bridge; credentials only travel over stdin/D-Bus."""
import json
import os
import sys

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

IWD = 'net.connman.iwd'
BLUEZ = 'org.bluez'
PROPS = 'org.freedesktop.DBus.Properties'
OBJECTS = 'org.freedesktop.DBus.ObjectManager'


class Agent(dbus.service.Object):
    def __init__(self, bridge):
        self.bridge = bridge
        super().__init__(bridge.bus, '/org/quickshell/IwdAgent')

    def authorize(self, sender):
        if sender != self.bridge.bus.get_name_owner(IWD):
            raise dbus.DBusException('Only iwd may access this agent.',
                                     name='org.freedesktop.DBus.Error.AccessDenied')

    @dbus.service.method(IWD + '.Agent', in_signature='o', out_signature='s', sender_keyword='sender')
    def RequestPassphrase(self, network, sender=None):
        self.authorize(sender)
        secret = self.bridge.secrets.get(str(network))
        if secret is None:
            raise dbus.exceptions.DBusException(
                'Enter a Wi-Fi password before connecting.',
                name=IWD + '.Agent.Error.Canceled',
            )
        return secret

    @dbus.service.method(IWD + '.Agent', in_signature='s', out_signature='', sender_keyword='sender')
    def Cancel(self, reason, sender=None):
        self.authorize(sender)
        self.bridge.secrets.clear()

    @dbus.service.method(IWD + '.Agent', in_signature='', out_signature='', sender_keyword='sender')
    def Release(self, sender=None):
        self.authorize(sender)
        self.bridge.agent_registered = False
        self.bridge.secrets.clear()


class Bridge:
    def __init__(self):
        self.bus = dbus.SystemBus()
        self.error = ''
        self.pending = set()
        self.secrets = {}
        self.agent_registered = False
        self.agent = Agent(self)
        self.input_buffer = b''
        self.refresh_source = None
        self.last_output = None
        for service in (IWD, BLUEZ):
            self.bus.add_signal_receiver(self.changed, bus_name=service)
        self.bus.add_signal_receiver(
            self.owner_changed, signal_name='NameOwnerChanged',
            dbus_interface='org.freedesktop.DBus',
        )
        os.set_blocking(sys.stdin.fileno(), False)
        GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, self.read_input)
        GLib.timeout_add_seconds(10, self.refresh)
        self.refresh()

    def objects(self, service):
        try:
            return dbus.Interface(self.bus.get_object(service, '/'), OBJECTS).GetManagedObjects(timeout=2)
        except dbus.DBusException:
            return {}

    def interface(self, service, path, interface):
        return dbus.Interface(self.bus.get_object(service, path), interface)

    def owner_changed(self, name, old, new):
        if name == IWD:
            self.agent_registered = False
            self.secrets.clear()
        if name in (IWD, BLUEZ):
            self.pending = {token for token in self.pending if token[0] != name}
            self.changed()

    def changed(self, *args, **kwargs):
        if self.refresh_source is None:
            self.refresh_source = GLib.timeout_add(150, self.scheduled_refresh)

    def scheduled_refresh(self):
        self.refresh_source = None
        self.refresh()
        return False

    def refresh(self):
        wireless = self.objects(IWD)
        bluetooth = self.objects(BLUEZ)
        state = dict(wifiAvailable=False, wifiPowered=False, wifiDevice='', wifiState='unavailable',
                     networks=[], bluetoothAvailable=False, bluetoothPowered=False,
                     bluetoothDiscovering=False, devices=[], error=self.error, busy=bool(self.pending))
        for path, interfaces in wireless.items():
            device = interfaces.get(IWD + '.Device')
            if device is None or state['wifiAvailable']:
                continue
            station = interfaces.get(IWD + '.Station', {})
            state.update(wifiAvailable=True, wifiPowered=bool(device.get('Powered', False)),
                         wifiDevice=str(path), wifiState=str(station.get('State', 'disconnected')))
            connected = str(station.get('ConnectedNetwork', ''))
            try:
                networks = self.interface(IWD, path, IWD + '.Station').GetOrderedNetworks(timeout=2)
            except dbus.DBusException:
                networks = []
            for network_path, signal in networks:
                props = wireless.get(network_path, {}).get(IWD + '.Network', {})
                state['networks'].append(dict(path=str(network_path), name=str(props.get('Name', '')),
                                             security=str(props.get('Type', '')), signal=int(signal),
                                             connected=str(network_path) == connected))
        self.bluetooth_adapter = ''
        for path, interfaces in bluetooth.items():
            adapter = interfaces.get(BLUEZ + '.Adapter1')
            if adapter is not None and not state['bluetoothAvailable']:
                state.update(bluetoothAvailable=True, bluetoothPowered=bool(adapter.get('Powered', False)),
                             bluetoothDiscovering=bool(adapter.get('Discovering', False)))
                self.bluetooth_adapter = str(path)
        for path, interfaces in bluetooth.items():
            device = interfaces.get(BLUEZ + '.Device1')
            if device is not None and str(device.get('Adapter', '')) == self.bluetooth_adapter:
                state['devices'].append(dict(path=str(path), name=str(device.get('Alias', device.get('Address', ''))),
                                             address=str(device.get('Address', '')), paired=bool(device.get('Paired', False)),
                                             connected=bool(device.get('Connected', False))))
        self.state = state
        output = json.dumps(state, ensure_ascii=False)
        if output != self.last_output:
            print(output, flush=True)
            self.last_output = output
        return True

    def fail(self, error):
        # Never echo exception messages or requests: either can contain credentials.
        name = error.get_dbus_name() if isinstance(error, dbus.DBusException) else ''
        self.error = {
            'org.freedesktop.DBus.Error.AccessDenied': 'Permission denied by the system service.',
            'net.connman.iwd.Failed': 'Wi-Fi connection failed. Check the password and try again.',
            'net.connman.iwd.NotSupported': 'This Wi-Fi authentication method is not supported here.',
            'org.bluez.Error.NotReady': 'Turn Bluetooth on first.',
            'org.bluez.Error.AuthenticationFailed': 'Bluetooth authentication failed. Pair using Bluetooth settings.',
        }.get(name, 'Connectivity request failed. Check device power, permissions, and pairing.')
        self.changed()

    def call(self, service, path, interface, method, *args):
        key = (service, path, method)
        if any(token[:3] == key for token in self.pending):
            return
        token = (*key, object())
        self.pending.add(token)
        self.changed()

        def done(*result):
            if token not in self.pending:
                return False
            self.pending.discard(token)
            if method == 'Connect' and service == IWD:
                self.secrets.pop(path, None)
                self.unregister_agent()
            self.changed()
            return True

        def failed(error):
            if done():
                self.fail(error)

        try:
            getattr(self.interface(service, path, interface), method)(
                *args, reply_handler=done, error_handler=failed, timeout=90 if method == 'Connect' else 15)
        except dbus.DBusException as error:
            failed(error)

    def unregister_agent(self):
        if not self.agent_registered:
            return
        try:
            self.interface(IWD, '/net/connman/iwd', IWD + '.AgentManager').UnregisterAgent(
                '/org/quickshell/IwdAgent', timeout=2)
            self.agent_registered = False
        except dbus.DBusException as error:
            self.fail(error)

    def command(self, request):
        action = request.get('action')
        self.error = ''
        wifi_path = self.state['wifiDevice']
        if action == 'wifi-power':
            self.call(IWD, wifi_path, PROPS, 'Set', IWD + '.Device', 'Powered', dbus.Boolean(request['enabled']))
        elif action == 'wifi-scan':
            self.call(IWD, wifi_path, IWD + '.Station', 'Scan')
        elif action == 'wifi-disconnect':
            self.call(IWD, wifi_path, IWD + '.Station', 'Disconnect')
        elif action == 'wifi-connect':
            if any(token[0] == IWD and token[2] == 'Connect' for token in self.pending):
                return
            path = request['path']
            if path not in [network['path'] for network in self.state['networks']]:
                raise ValueError('Unknown network')
            secret = request.get('passphrase')
            if secret is not None and (not isinstance(secret, str) or len(secret) > 4096):
                raise ValueError('Invalid passphrase')
            if not self.agent_registered:
                self.interface(IWD, '/net/connman/iwd', IWD + '.AgentManager').RegisterAgent('/org/quickshell/IwdAgent', timeout=2)
                self.agent_registered = True
            if secret:
                self.secrets[path] = secret
            self.call(IWD, path, IWD + '.Network', 'Connect')
        elif action == 'bluetooth-power':
            self.call(BLUEZ, self.bluetooth_adapter, PROPS, 'Set', BLUEZ + '.Adapter1', 'Powered', dbus.Boolean(request['enabled']))
        elif action == 'bluetooth-scan':
            self.call(BLUEZ, self.bluetooth_adapter, BLUEZ + '.Adapter1',
                      'StartDiscovery' if request['enabled'] else 'StopDiscovery')
        elif action in ('bluetooth-connect', 'bluetooth-disconnect'):
            path = request['path']
            if path not in [device['path'] for device in self.state['devices']]:
                raise ValueError('Unknown Bluetooth device')
            self.call(BLUEZ, path, BLUEZ + '.Device1', 'Connect' if action == 'bluetooth-connect' else 'Disconnect')
        else:
            raise ValueError('Unknown action')
        self.changed()

    def read_input(self, fd, condition):
        try:
            chunk = os.read(fd, 65536)
        except BlockingIOError:
            return True
        if not chunk:
            self.loop.quit()
            return False
        self.input_buffer += chunk
        if len(self.input_buffer) > 1048576:
            self.input_buffer = b''
            self.error = 'Connectivity request is too large.'
            self.changed()
            return True
        while b'\n' in self.input_buffer:
            line, self.input_buffer = self.input_buffer.split(b'\n', 1)
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError('Invalid request')
                self.command(request)
            except (ValueError, KeyError, TypeError, AttributeError, dbus.DBusException) as error:
                self.fail(error)
        return True

    def run(self):
        self.loop = GLib.MainLoop()
        try:
            self.loop.run()
        finally:
            self.secrets.clear()
            if self.agent_registered:
                try:
                    self.interface(IWD, '/net/connman/iwd', IWD + '.AgentManager').UnregisterAgent('/org/quickshell/IwdAgent', timeout=2)
                except dbus.DBusException:
                    pass


if __name__ == '__main__':
    DBusGMainLoop(set_as_default=True)
    Bridge().run()
