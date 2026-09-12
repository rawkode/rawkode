use crate::{
    DeviceSnapshot, HardwareError, KEYBOARD_PRODUCT, KEYBOARD_VENDOR, MOUSE_PRODUCT, MOUSE_VENDOR,
};

fn result_from_ids(ids: impl IntoIterator<Item = (u16, u16)>) -> DeviceSnapshot {
    let mut result = DeviceSnapshot {
        keyboard_present: false,
        mouse_present: false,
    };
    for (vendor, product) in ids {
        result.keyboard_present |= (vendor, product) == (KEYBOARD_VENDOR, KEYBOARD_PRODUCT);
        result.mouse_present |= (vendor, product) == (MOUSE_VENDOR, MOUSE_PRODUCT);
    }
    result
}

#[cfg(target_os = "macos")]
pub(crate) fn snapshot() -> Result<DeviceSnapshot, HardwareError> {
    macos::snapshot()
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{
        ffi::{c_char, c_void},
        ptr,
    };
    type CFRef = *const c_void;
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingServices(
            port: u32,
            matching: *mut c_void,
            iterator: *mut u32,
        ) -> i32;
        fn IOIteratorNext(iterator: u32) -> u32;
        fn IOIteratorIsValid(iterator: u32) -> i32;
        fn IOObjectRelease(object: u32) -> i32;
        fn IORegistryEntryCreateCFProperty(
            entry: u32,
            key: CFRef,
            allocator: CFRef,
            options: u32,
        ) -> CFRef;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: CFRef,
            string: *const c_char,
            encoding: u32,
        ) -> CFRef;
        fn CFRelease(object: CFRef);
        fn CFGetTypeID(object: CFRef) -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFNumberGetValue(number: CFRef, number_type: isize, value: *mut c_void) -> bool;
        fn CFStringGetTypeID() -> usize;
        fn CFStringGetCString(
            string: CFRef,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> bool;
    }
    struct Object(u32);
    impl Drop for Object {
        fn drop(&mut self) {
            unsafe {
                IOObjectRelease(self.0);
            }
        }
    }
    struct Value(CFRef);
    impl Drop for Value {
        fn drop(&mut self) {
            unsafe {
                CFRelease(self.0);
            }
        }
    }
    fn property(entry: u32, name: &[u8]) -> Option<Value> {
        unsafe {
            let key = CFStringCreateWithCString(ptr::null(), name.as_ptr().cast(), 0x08000100);
            if key.is_null() {
                return None;
            }
            let key = Value(key);
            let value = IORegistryEntryCreateCFProperty(entry, key.0, ptr::null(), 0);
            if value.is_null() {
                None
            } else {
                Some(Value(value))
            }
        }
    }
    fn number(entry: u32, name: &[u8]) -> Option<u16> {
        let value = property(entry, name)?;
        let mut number: i32 = 0;
        unsafe {
            if CFGetTypeID(value.0) != CFNumberGetTypeID()
                || !CFNumberGetValue(value.0, 3, (&mut number as *mut i32).cast())
            {
                return None;
            }
        }
        u16::try_from(number).ok()
    }
    fn bluetooth(entry: u32) -> Result<bool, HardwareError> {
        let value = property(entry, b"Transport\0").ok_or_else(|| {
            HardwareError::Enumeration("HID transport metadata became unavailable".into())
        })?;
        let mut text = [0u8; 64];
        unsafe {
            if CFGetTypeID(value.0) != CFStringGetTypeID()
                || !CFStringGetCString(value.0, text.as_mut_ptr().cast(), 64, 0x08000100)
            {
                return Err(HardwareError::Enumeration(
                    "Invalid HID transport metadata".into(),
                ));
            }
            Ok(text.starts_with(b"Bluetooth\0") || text.starts_with(b"Bluetooth Low Energy\0"))
        }
    }
    pub(super) fn snapshot() -> Result<DeviceSnapshot, HardwareError> {
        // Registry enumeration needs no HID open, Input Monitoring grant, or input callback.
        unsafe {
            let matching = IOServiceMatching(c"IOHIDDevice".as_ptr());
            if matching.is_null() {
                return Err(HardwareError::Enumeration(
                    "IOServiceMatching failed".into(),
                ));
            }
            let mut iterator = 0;
            let status = IOServiceGetMatchingServices(0, matching, &mut iterator);
            if status != 0 || iterator == 0 {
                return Err(HardwareError::Enumeration(format!(
                    "IOKit status {status:#x}"
                )));
            }
            let iterator = Object(iterator);
            let mut ids = Vec::new();
            loop {
                let entry = IOIteratorNext(iterator.0);
                if entry == 0 {
                    break;
                }
                let entry = Object(entry);
                if !bluetooth(entry.0)? {
                    continue;
                }
                let vendor = number(entry.0, b"VendorID\0");
                let product = number(entry.0, b"ProductID\0");
                let (Some(vendor), Some(product)) = (vendor, product) else {
                    return Err(HardwareError::Enumeration(
                        "Bluetooth HID metadata became unavailable".into(),
                    ));
                };
                ids.push((vendor, product));
            }
            if IOIteratorIsValid(iterator.0) == 0 {
                return Err(HardwareError::Enumeration(
                    "HID registry changed during enumeration".into(),
                ));
            }
            Ok(result_from_ids(ids))
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn snapshot() -> Result<DeviceSnapshot, HardwareError> {
    // sysfs metadata is readable without opening /dev/hidraw or an evdev keyboard device.
    // Unlike hidapi's udev enumerator, filesystem errors propagate rather than becoming absence.
    let entries = std::fs::read_dir("/sys/bus/hid/devices")
        .map_err(|e| HardwareError::Enumeration(e.to_string()))?;
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| HardwareError::Enumeration(e.to_string()))?;
        let text = std::fs::read_to_string(entry.path().join("uevent"))
            .map_err(|e| HardwareError::Enumeration(e.to_string()))?;
        let id = text
            .lines()
            .find_map(|line| line.strip_prefix("HID_ID="))
            .ok_or_else(|| HardwareError::Enumeration("HID_ID missing in sysfs".into()))?;
        let parts: Vec<_> = id.split(':').collect();
        if parts.len() != 3 {
            return Err(HardwareError::Enumeration("Malformed sysfs HID_ID".into()));
        }
        let parse = |text| {
            u32::from_str_radix(text, 16)
                .map_err(|_| HardwareError::Enumeration("Malformed sysfs HID_ID".into()))
        };
        let (bus, vendor, product) = (parse(parts[0])?, parse(parts[1])?, parse(parts[2])?);
        if bus == 5 {
            ids.push((vendor as u16, product as u16));
        }
    }
    Ok(result_from_ids(ids))
}

#[cfg(target_os = "windows")]
pub(crate) fn snapshot() -> Result<DeviceSnapshot, HardwareError> {
    windows::snapshot()
}
#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }
    #[link(name = "hid")]
    extern "system" {
        fn HidD_GetHidGuid(guid: *mut Guid);
    }
    #[link(name = "cfgmgr32")]
    extern "system" {
        fn CM_Get_Device_Interface_List_SizeW(
            len: *mut u32,
            guid: *const Guid,
            device: *const u16,
            flags: u32,
        ) -> u32;
        fn CM_Get_Device_Interface_ListW(
            guid: *const Guid,
            device: *const u16,
            buffer: *mut u16,
            len: u32,
            flags: u32,
        ) -> u32;
    }
    pub(super) fn snapshot() -> Result<DeviceSnapshot, HardwareError> {
        // Enumerate present HID interface names without opening devices. Configuration Manager
        // status failures and size races are unknown state, never an empty/absent keyboard.
        unsafe {
            let mut guid = Guid {
                data1: 0,
                data2: 0,
                data3: 0,
                data4: [0; 8],
            };
            HidD_GetHidGuid(&mut guid);
            let mut len = 0;
            let status = CM_Get_Device_Interface_List_SizeW(&mut len, &guid, std::ptr::null(), 0);
            if status != 0 || len > 1_048_576 {
                return Err(HardwareError::Enumeration(format!(
                    "Configuration Manager status {status:#x}, length {len}"
                )));
            }
            let mut names = vec![0u16; len.max(1) as usize];
            let status = CM_Get_Device_Interface_ListW(
                &guid,
                std::ptr::null(),
                names.as_mut_ptr(),
                names.len() as u32,
                0,
            );
            if status != 0 {
                return Err(HardwareError::Enumeration(format!(
                    "Configuration Manager status {status:#x}"
                )));
            }
            let mut ids = Vec::new();
            for name in names.split(|c| *c == 0).filter(|name| !name.is_empty()) {
                let name = String::from_utf16(name)
                    .map_err(|e| HardwareError::Enumeration(e.to_string()))?
                    .to_ascii_lowercase();
                for (v, p) in [
                    (KEYBOARD_VENDOR, KEYBOARD_PRODUCT),
                    (MOUSE_VENDOR, MOUSE_PRODUCT),
                ] {
                    if name.contains(&format!("vid_{v:04x}&pid_{p:04x}"))
                        || name.contains(&format!("vid&0002{v:04x}_pid&{p:04x}"))
                    {
                        ids.push((v, p));
                    }
                }
            }
            Ok(result_from_ids(ids))
        }
    }
}
