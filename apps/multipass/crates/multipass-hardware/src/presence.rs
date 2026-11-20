use crate::{HardwareError, MOUSE_PRODUCT, MOUSE_VENDOR};

pub(crate) fn bluetooth_address(text: &str) -> Option<[u8; 6]> {
    let text = text.trim();
    let separated = text.len() == 17;
    if text.len() != 12 && !separated {
        return None;
    }
    let bytes = text.as_bytes();
    let separator = separated.then(|| bytes[2]);
    if separator.is_some_and(|value| !matches!(value, b':' | b'-')) {
        return None;
    }

    let mut address = [0; 6];
    for (index, byte) in address.iter_mut().enumerate() {
        let offset = index * if separated { 3 } else { 2 };
        if separated && index > 0 && Some(bytes[offset - 1]) != separator {
            return None;
        }
        let digits = std::str::from_utf8(&bytes[offset..offset + 2]).ok()?;
        if !digits.bytes().all(|digit| digit.is_ascii_hexdigit()) {
            return None;
        }
        *byte = u8::from_str_radix(digits, 16).ok()?;
    }
    (address != [0; 6] && address != [255; 6]).then_some(address)
}

fn missing_keyboard_address() -> HardwareError {
    HardwareError::Enumeration("A connected Bluetooth keyboard has no usable address".into())
}

#[cfg(target_os = "macos")]
pub(crate) use macos::mouse_present;

#[cfg(target_os = "macos")]
pub(crate) fn connected_keyboard_addresses() -> Result<Vec<[u8; 6]>, HardwareError> {
    macos::connected_keyboard_addresses()
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
        fn CFDataGetTypeID() -> usize;
        fn CFDataGetLength(data: CFRef) -> isize;
        fn CFDataGetBytePtr(data: CFRef) -> *const u8;
        fn CFArrayGetTypeID() -> usize;
        fn CFArrayGetCount(array: CFRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFRef, index: isize) -> CFRef;
        fn CFDictionaryGetTypeID() -> usize;
        fn CFDictionaryGetValue(dictionary: CFRef, key: CFRef) -> CFRef;
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
    fn key(name: &'static std::ffi::CStr) -> Option<Value> {
        let key = unsafe { CFStringCreateWithCString(ptr::null(), name.as_ptr(), 0x08000100) };
        (!key.is_null()).then(|| Value(key))
    }

    fn property(entry: u32, name: &'static std::ffi::CStr) -> Option<Value> {
        let key = key(name)?;
        let value = unsafe { IORegistryEntryCreateCFProperty(entry, key.0, ptr::null(), 0) };
        (!value.is_null()).then(|| Value(value))
    }

    fn as_number(value: CFRef) -> Option<u16> {
        let mut number: i32 = 0;
        unsafe {
            if value.is_null()
                || CFGetTypeID(value) != CFNumberGetTypeID()
                || !CFNumberGetValue(value, 3, (&mut number as *mut i32).cast())
            {
                return None;
            }
        }
        u16::try_from(number).ok()
    }

    fn number(entry: u32, name: &'static std::ffi::CStr) -> Option<u16> {
        as_number(property(entry, name)?.0)
    }

    fn bluetooth(entry: u32) -> Result<bool, HardwareError> {
        let value = property(entry, c"Transport").ok_or_else(|| {
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
            Ok(text.starts_with(b"Bluetooth\0")
                || text.starts_with(b"BluetoothLowEnergy\0")
                || text.starts_with(b"Bluetooth Low Energy\0"))
        }
    }
    struct Entry {
        keyboard: bool,
        address: Option<[u8; 6]>,
        vendor: u16,
        product: u16,
    }
    fn text(entry: u32, name: &'static std::ffi::CStr) -> Option<String> {
        let value = property(entry, name)?;
        let mut buffer = [0u8; 128];
        unsafe {
            if CFGetTypeID(value.0) != CFStringGetTypeID()
                || !CFStringGetCString(value.0, buffer.as_mut_ptr().cast(), 128, 0x08000100)
            {
                return None;
            }
        }
        let end = buffer.iter().position(|b| *b == 0)?;
        Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
    }
    fn keyboard(entry: u32) -> bool {
        // Generic Desktop page (1), Keyboard usage (6).
        if number(entry, c"PrimaryUsagePage") == Some(1)
            && number(entry, c"PrimaryUsage") == Some(6)
        {
            return true;
        }
        // Composite devices can report another collection as their primary usage.
        let (Some(usages), Some(page), Some(usage)) = (
            property(entry, c"DeviceUsagePairs"),
            key(c"DeviceUsagePage"),
            key(c"DeviceUsage"),
        ) else {
            return false;
        };
        unsafe {
            CFGetTypeID(usages.0) == CFArrayGetTypeID()
                && (0..CFArrayGetCount(usages.0)).any(|index| {
                    let pair = CFArrayGetValueAtIndex(usages.0, index);
                    !pair.is_null()
                        && CFGetTypeID(pair) == CFDictionaryGetTypeID()
                        && as_number(CFDictionaryGetValue(pair, page.0)) == Some(1)
                        && as_number(CFDictionaryGetValue(pair, usage.0)) == Some(6)
                })
        }
    }

    fn address(entry: u32) -> Option<[u8; 6]> {
        if let Some(address) =
            text(entry, c"DeviceAddress").and_then(|text| bluetooth_address(&text))
        {
            return Some(address);
        }
        if let Some(data) = property(entry, c"BD_ADDR") {
            unsafe {
                if CFGetTypeID(data.0) == CFDataGetTypeID() && CFDataGetLength(data.0) == 6 {
                    let bytes = CFDataGetBytePtr(data.0);
                    if !bytes.is_null() {
                        let mut address = [0; 6];
                        std::ptr::copy_nonoverlapping(bytes, address.as_mut_ptr(), address.len());
                        if address != [0; 6] && address != [255; 6] {
                            return Some(address);
                        }
                    }
                }
            }
        }
        text(entry, c"SerialNumber")
            .filter(|serial| serial.len() == 17)
            .and_then(|serial| bluetooth_address(&serial))
    }

    fn entries() -> Result<Vec<Entry>, HardwareError> {
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
            let mut found = Vec::new();
            loop {
                let entry = IOIteratorNext(iterator.0);
                if entry == 0 {
                    break;
                }
                let entry = Object(entry);
                if !bluetooth(entry.0)? {
                    continue;
                }
                let vendor = number(entry.0, c"VendorID");
                let product = number(entry.0, c"ProductID");
                let (Some(vendor), Some(product)) = (vendor, product) else {
                    return Err(HardwareError::Enumeration(
                        "Bluetooth HID metadata became unavailable".into(),
                    ));
                };
                let keyboard = keyboard(entry.0);
                found.push(Entry {
                    keyboard,
                    address: if keyboard { address(entry.0) } else { None },
                    vendor,
                    product,
                });
            }
            if IOIteratorIsValid(iterator.0) == 0 {
                return Err(HardwareError::Enumeration(
                    "HID registry changed during enumeration".into(),
                ));
            }
            Ok(found)
        }
    }
    pub(super) fn connected_keyboard_addresses() -> Result<Vec<[u8; 6]>, HardwareError> {
        entries()?
            .into_iter()
            .filter(|entry| entry.keyboard)
            .map(|entry| entry.address.ok_or_else(missing_keyboard_address))
            .collect()
    }

    pub(crate) fn mouse_present() -> Result<bool, HardwareError> {
        Ok(entries()?
            .into_iter()
            .any(|entry| (entry.vendor, entry.product) == (MOUSE_VENDOR, MOUSE_PRODUCT)))
    }
}

#[cfg(target_os = "linux")]
fn linux_keyboard_identifiers() -> Result<Vec<String>, HardwareError> {
    use std::{fs, io};

    let scan = || -> io::Result<Vec<_>> {
        let mut keyboards = Vec::new();
        for entry in fs::read_dir("/sys/class/input")? {
            let entry = entry?;
            if !entry.file_name().to_string_lossy().starts_with("event") {
                continue;
            }
            let path = entry.path().join("device");
            if fs::read_to_string(path.join("id/bustype"))?.trim() != "0005" {
                continue;
            }
            let keys = fs::read_to_string(path.join("capabilities/key"))?;
            // The low word contains KEY_Q through KEY_P (codes 16 through 25).
            // Require the letter row to exclude mice and media-only interfaces.
            let letter_row = 0x03ff_0000;
            let low_word = keys
                .split_whitespace()
                .last()
                .and_then(|word| u64::from_str_radix(word, 16).ok())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "Invalid input capabilities")
                })?;
            if low_word & letter_row == letter_row {
                keyboards.push(fs::read_to_string(path.join("uniq"))?);
            }
        }
        Ok(keyboards)
    };
    scan()
        .or_else(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                scan()
            } else {
                Err(error)
            }
        })
        .map_err(|error| HardwareError::Enumeration(error.to_string()))
}

#[cfg(target_os = "linux")]
pub(crate) fn connected_keyboard_addresses() -> Result<Vec<[u8; 6]>, HardwareError> {
    linux_keyboard_identifiers()?
        .into_iter()
        .map(|identity| bluetooth_address(&identity).ok_or_else(missing_keyboard_address))
        .collect()
}

#[cfg(target_os = "linux")]
pub(crate) fn mouse_present() -> Result<bool, HardwareError> {
    // Kernel names for HID devices contain bus, vendor and product, followed
    // by a per-device instance number. No device handles are opened.
    let mouse = format!("0005:{MOUSE_VENDOR:04X}:{MOUSE_PRODUCT:04X}.");
    for entry in std::fs::read_dir("/sys/bus/hid/devices")
        .map_err(|error| HardwareError::Enumeration(error.to_string()))?
    {
        let entry = entry.map_err(|error| HardwareError::Enumeration(error.to_string()))?;
        if entry.file_name().to_string_lossy().starts_with(&mouse) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "windows")]
#[path = "windows_keyboards.rs"]
mod windows_keyboards;
#[cfg(target_os = "windows")]
pub(crate) use windows_keyboards::connected_keyboard_addresses;

#[cfg(target_os = "windows")]
pub(crate) use windows::mouse_present;
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
    pub(crate) fn mouse_present() -> Result<bool, HardwareError> {
        // Enumerate present HID interface names without opening devices. Configuration Manager
        // status failures and size races are unknown state.
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
            let usb_form = format!("vid_{MOUSE_VENDOR:04x}&pid_{MOUSE_PRODUCT:04x}");
            let bluetooth_form = format!("vid&0002{MOUSE_VENDOR:04x}_pid&{MOUSE_PRODUCT:04x}");
            for name in names.split(|c| *c == 0).filter(|name| !name.is_empty()) {
                let name = String::from_utf16(name)
                    .map_err(|e| HardwareError::Enumeration(e.to_string()))?
                    .to_ascii_lowercase();
                if name.contains(&usb_form) || name.contains(&bluetooth_form) {
                    return Ok(true);
                }
            }
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::bluetooth_address;

    #[test]
    fn accepts_common_bluetooth_address_formats() {
        let expected = Some([0xaa, 0x01, 0xff, 0x02, 0xcc, 0x03]);
        assert_eq!(bluetooth_address("AA:01:ff:02:CC:03\n"), expected);
        assert_eq!(bluetooth_address("AA-01-ff-02-CC-03"), expected);
        assert_eq!(bluetooth_address("AA01ff02CC03"), expected);
    }

    #[test]
    fn rejects_missing_or_malformed_bluetooth_addresses() {
        for identity in [
            "",
            "000000000000",
            "ff:ff:ff:ff:ff:ff",
            "aa:01-ff:02:cc:03",
            "aa:01:fg:02:cc:03",
            "+1:02:03:04:05:06",
            "aa:01:ff:02:cc:é",
            "SN1234567890",
        ] {
            assert_eq!(bluetooth_address(identity), None, "{identity}");
        }
    }
}
