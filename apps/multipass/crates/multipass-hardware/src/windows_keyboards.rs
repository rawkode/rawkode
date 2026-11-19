use super::{bluetooth_address, missing_keyboard_address};
use crate::HardwareError;
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};
use windows::{
    core::{Interface, HSTRING, PCWSTR},
    Devices::{
        Bluetooth::{BluetoothConnectionStatus, BluetoothDevice, BluetoothLEDevice},
        Enumeration::{DeviceInformation, DeviceInformationKind},
    },
    Foundation::IPropertyValue,
    Win32::{
        Devices::{
            DeviceAndDriverInstallation::{
                CM_Get_Device_IDW, CM_Get_Device_Interface_ListW,
                CM_Get_Device_Interface_List_SizeW, CM_Get_Device_Interface_PropertyW,
                CM_Get_Parent, CM_Locate_DevNodeW, CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
                CM_LOCATE_DEVNODE_NORMAL, CONFIGRET, CR_NO_SUCH_DEVNODE, CR_SUCCESS,
                MAX_DEVICE_ID_LEN,
            },
            HumanInterfaceDevice::GUID_DEVINTERFACE_KEYBOARD,
            Properties::{DEVPKEY_Device_InstanceId, DEVPROPTYPE, DEVPROP_TYPE_STRING},
        },
        System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    },
};
use windows_collections::IIterable;
use windows_future::AsyncStatus;

pub(crate) fn connected_keyboard_addresses() -> Result<Vec<[u8; 6]>, HardwareError> {
    // Keyboard class interfaces identify keyboard collections. Their device nodes
    // can outlive a live connection, so also require a connected Bluetooth endpoint.
    let keyboard_addresses = keyboard_addresses()?;
    if keyboard_addresses.is_empty() {
        return Ok(Vec::new());
    }
    let connected = connected_bluetooth_addresses().map_err(enumeration_error)?;
    Ok(keyboard_addresses
        .intersection(&connected)
        .copied()
        .collect())
}

fn enumeration_error(error: windows::core::Error) -> HardwareError {
    HardwareError::Enumeration(error.to_string())
}

fn check_config_manager(result: CONFIGRET) -> Result<(), HardwareError> {
    if result == CR_SUCCESS {
        Ok(())
    } else {
        Err(HardwareError::Enumeration(format!(
            "Configuration Manager status {:#x}",
            result.0
        )))
    }
}

fn keyboard_addresses() -> Result<BTreeSet<[u8; 6]>, HardwareError> {
    let mut size = 0;
    unsafe {
        check_config_manager(CM_Get_Device_Interface_List_SizeW(
            &mut size,
            &GUID_DEVINTERFACE_KEYBOARD,
            PCWSTR::null(),
            CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
        ))?;
    }
    if !(1..=1_048_576).contains(&size) {
        return Err(HardwareError::Enumeration(
            "Invalid keyboard interface list length".into(),
        ));
    }
    let mut interfaces = vec![0; size as usize];
    unsafe {
        check_config_manager(CM_Get_Device_Interface_ListW(
            &GUID_DEVINTERFACE_KEYBOARD,
            PCWSTR::null(),
            &mut interfaces,
            CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
        ))?;
    }

    let mut addresses = BTreeSet::new();
    let mut tail = interfaces.as_slice();
    while let Some(end) = tail.iter().position(|character| *character == 0) {
        if end == 0 {
            break;
        }
        if let Some(address) = keyboard_address(&tail[..=end])? {
            addresses.insert(address);
        }
        tail = &tail[end + 1..];
    }
    Ok(addresses)
}

fn keyboard_address(interface: &[u16]) -> Result<Option<[u8; 6]>, HardwareError> {
    let mut buffer = [0u16; MAX_DEVICE_ID_LEN as usize];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    let mut property_type = DEVPROPTYPE::default();
    let mut node = 0;
    unsafe {
        check_config_manager(CM_Get_Device_Interface_PropertyW(
            PCWSTR(interface.as_ptr()),
            &DEVPKEY_Device_InstanceId,
            &mut property_type,
            Some(buffer.as_mut_ptr().cast()),
            &mut size,
            0,
        ))?;
        if property_type != DEVPROP_TYPE_STRING || !buffer.contains(&0) {
            return Err(HardwareError::Enumeration(
                "Invalid keyboard device instance ID".into(),
            ));
        }
        check_config_manager(CM_Locate_DevNodeW(
            &mut node,
            PCWSTR(buffer.as_ptr()),
            CM_LOCATE_DEVNODE_NORMAL,
        ))?;
    }

    let mut bluetooth = false;
    for _ in 0..32 {
        unsafe { check_config_manager(CM_Get_Device_IDW(node, &mut buffer, 0))? };
        let end = buffer
            .iter()
            .position(|character| *character == 0)
            .ok_or_else(|| HardwareError::Enumeration("Unterminated device instance ID".into()))?;
        let id = String::from_utf16(&buffer[..end])
            .map_err(|error| HardwareError::Enumeration(error.to_string()))?;
        let id = id.to_ascii_uppercase();
        bluetooth |= ["BTHENUM\\", "BTHLE\\", "BTHLEDEVICE\\"]
            .iter()
            .any(|prefix| id.starts_with(prefix));
        if let Some(address) = id
            .strip_prefix("BTHENUM\\DEV_")
            .or_else(|| id.strip_prefix("BTHLE\\DEV_"))
            .and_then(|remainder| remainder.split_once('\\'))
            .and_then(|(address, _)| bluetooth_address(address))
        {
            return Ok(Some(address));
        }
        if id == "HTREE\\ROOT\\0" {
            return if bluetooth {
                Err(missing_keyboard_address())
            } else {
                Ok(None)
            };
        }
        let mut parent = 0;
        let result = unsafe { CM_Get_Parent(&mut parent, node, 0) };
        if result == CR_NO_SUCH_DEVNODE {
            return Err(HardwareError::Enumeration(
                "Keyboard device tree changed during enumeration".into(),
            ));
        }
        check_config_manager(result)?;
        node = parent;
    }
    Err(HardwareError::Enumeration(
        "Keyboard device tree exceeded depth limit".into(),
    ))
}

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

fn connected_bluetooth_addresses() -> windows::core::Result<BTreeSet<[u8; 6]>> {
    unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
    let _apartment = Apartment;
    let address_property = HSTRING::from("System.Devices.Aep.DeviceAddress");
    let selectors = [
        BluetoothDevice::GetDeviceSelectorFromConnectionStatus(
            BluetoothConnectionStatus::Connected,
        )?,
        BluetoothLEDevice::GetDeviceSelectorFromConnectionStatus(
            BluetoothConnectionStatus::Connected,
        )?,
    ];
    let properties = IIterable::<HSTRING>::from(vec![address_property.clone()]);
    let start = |selector: &HSTRING| {
        DeviceInformation::FindAllAsyncWithKindAqsFilterAndAdditionalProperties(
            selector,
            &properties,
            DeviceInformationKind::AssociationEndpoint,
        )
    };
    let operations = [start(&selectors[0])?, start(&selectors[1])?];
    let deadline = Instant::now() + Duration::from_millis(400);
    let mut addresses = BTreeSet::new();
    for operation in &operations {
        while operation.Status()? == AsyncStatus::Started {
            if Instant::now() >= deadline {
                for pending in &operations {
                    let _ = pending.Cancel();
                }
                return Err(windows::core::Error::new(
                    windows::core::HRESULT(0x800705b4_u32 as i32),
                    "Bluetooth connection query timed out",
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let devices = operation.GetResults()?;
        for index in 0..devices.Size()? {
            let properties = devices.GetAt(index)?.Properties()?;
            let value = properties
                .Lookup(&address_property)?
                .cast::<IPropertyValue>()?;
            let address =
                bluetooth_address(&value.GetString()?.to_string_lossy()).ok_or_else(|| {
                    windows::core::Error::new(
                        windows::core::HRESULT(0x8007000d_u32 as i32),
                        "Connected Bluetooth endpoint has no usable device address",
                    )
                })?;
            addresses.insert(address);
        }
    }
    Ok(addresses)
}
