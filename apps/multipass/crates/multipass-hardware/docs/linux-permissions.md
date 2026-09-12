# Linux device permissions

Presence detection reads `/sys/bus/hid/devices/*/uevent`; it never opens a
keyboard input device. Mouse switching opens only the MX Master 4 Bluetooth
HID++ control endpoint through hidraw. An access error remains an error, rather
than being interpreted as a disconnected keyboard.

For a desktop distribution using systemd-logind, an administrator can install
this narrowly scoped rule as `/etc/udev/rules.d/70-multipass-mx4.rules`:

```udev
ACTION=="add|change", SUBSYSTEM=="hidraw", KERNELS=="0005:046D:B042.*", TAG+="uaccess"
```

`0005` is Bluetooth, `046D:B042` is the MX Master 4. This grants the active local
session access to this mouse's hidraw endpoint; it grants no EVO80 access. The
rule must precede `73-seat-late.rules` for the uaccess ACL to be applied. Reload
udev rules and reconnect the mouse after installation. Multipass does not
install this rule, invoke sudo, or run its engine as root.

On systems without logind/uaccess, the administrator must provide an equivalent
scoped device ACL or dedicated group policy. Avoid a general `MODE="0666"` rule
for all HID devices. Distribution policy and actual Linux Bluetooth device
behavior still require runtime validation.
