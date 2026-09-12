//! Bluetooth EVO80 presence and MX Master 4 HID++ host switching.
//!
//! Keyboard devices are enumerated only: no keyboard input handle or report reader is opened.
//! The caller serializes blocking `switch_to` operations and supplies a short-lived cancellation
//! predicate. Successful writes are never retried, even when the response is lost during handoff.
mod presence;
mod protocol;

use hidapi::{HidApi, HidDevice};
use protocol::{Reply, Request};
use std::{
    collections::BTreeSet,
    ffi::CString,
    time::{Duration, Instant},
};
use thiserror::Error;

pub const KEYBOARD_VENDOR: u16 = 0x36b0;
pub const KEYBOARD_PRODUCT: u16 = 0x3004;
pub const MOUSE_VENDOR: u16 = 0x046d;
pub const MOUSE_PRODUCT: u16 = 0xb042;
const LEASE: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeviceSnapshot {
    pub keyboard_present: bool,
    pub mouse_present: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SwitchOutcome {
    Acknowledged,
    /// The source observed departure; destination connection is not confirmed.
    Departed,
    AlreadyOnTarget,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MouseInfo {
    pub host_count: u8,
    pub current_slot: u8,
}

#[derive(Debug, Error)]
pub enum HardwareError {
    #[error("Hardware enumeration is unavailable: {0}")]
    Enumeration(String),
    #[error("MX Master 4 is not connected")]
    MouseUnavailable,
    #[error("Cannot uniquely identify an MX Master 4 HID++ control interface")]
    AmbiguousInterface,
    #[error("Mouse HID access failed (check OS device permissions): {0}")]
    Access(String),
    #[error("HID++ query failed: {0}")]
    Query(String),
    #[error("The operation expired or was cancelled")]
    Cancelled,
    #[error("The keyboard is connected here; handoff was cancelled")]
    KeyboardPresent,
    #[error("Mouse slot must be 1–3 and within the reported host count")]
    InvalidSlot,
    #[error("Mouse rejected the request with HID++ error 0x{0:02x}")]
    Rejected(u8),
    #[error("Switch outcome is unknown; the command will not be retried: {0}")]
    Uncertain(String),
}

pub fn snapshot() -> Result<DeviceSnapshot, HardwareError> {
    presence::snapshot()
}

/// Queries ChangeHost and current host without switching the mouse. This sends HID++ query
/// reports to the mouse only, so it may require Input Monitoring / hidraw access permissions.
pub fn probe() -> Result<MouseInfo, HardwareError> {
    let deadline = Instant::now() + LEASE;
    let device = open_mouse()?;
    let (_, info) = discover(&device, deadline, &|| true)?;
    Ok(info)
}

pub fn switch_to(
    slot: u8,
    should_proceed: impl Fn() -> bool,
) -> Result<SwitchOutcome, HardwareError> {
    if !(1..=3).contains(&slot) {
        return Err(HardwareError::InvalidSlot);
    }
    let deadline = Instant::now() + LEASE;
    check_live(deadline, &should_proceed)?;
    let initial = snapshot()?;
    if initial.keyboard_present {
        return Err(HardwareError::KeyboardPresent);
    }
    if !initial.mouse_present {
        return Err(HardwareError::MouseUnavailable);
    }
    let device = open_mouse()?;
    perform_switch(&device, slot, deadline, &should_proceed, snapshot)
}

fn open_mouse() -> Result<HidDevice, HardwareError> {
    let api = HidApi::new().map_err(|e| HardwareError::Enumeration(e.to_string()))?;
    let mouse: Vec<_> = api
        .device_list()
        .filter(|d| {
            d.vendor_id() == MOUSE_VENDOR
                && d.product_id() == MOUSE_PRODUCT
                && matches!(d.bus_type(), hidapi::BusType::Bluetooth)
        })
        .collect();
    if mouse.is_empty() {
        return Err(HardwareError::MouseUnavailable);
    }
    let control: BTreeSet<CString> = mouse
        .iter()
        .filter(|d| d.usage_page() == 0xff43 && d.usage() == 0x0202)
        .map(|d| d.path().to_owned())
        .collect();
    let path = if control.len() == 1 {
        control.into_iter().next().unwrap()
    } else if control.is_empty() && !cfg!(target_os = "windows") {
        // macOS and Linux can expose one physical transport with several usages. A unique
        // physical path is safe to probe. Never guess among Windows top-level collections.
        let paths: BTreeSet<_> = mouse.iter().map(|d| d.path().to_owned()).collect();
        if paths.len() != 1 {
            return Err(HardwareError::AmbiguousInterface);
        }
        paths.into_iter().next().unwrap()
    } else {
        return Err(HardwareError::AmbiguousInterface);
    };
    api.open_path(&path)
        .map_err(|e| HardwareError::Access(e.to_string()))
}

trait ReportIo {
    fn write(&self, bytes: &[u8]) -> Result<usize, String>;
    fn read(&self, bytes: &mut [u8], timeout_ms: i32) -> Result<usize, String>;
}
impl ReportIo for HidDevice {
    fn write(&self, bytes: &[u8]) -> Result<usize, String> {
        HidDevice::write(self, bytes).map_err(|e| e.to_string())
    }
    fn read(&self, bytes: &mut [u8], timeout_ms: i32) -> Result<usize, String> {
        self.read_timeout(bytes, timeout_ms)
            .map_err(|e| e.to_string())
    }
}
fn check_live(deadline: Instant, should_proceed: &impl Fn() -> bool) -> Result<(), HardwareError> {
    if Instant::now() >= deadline || !should_proceed() {
        Err(HardwareError::Cancelled)
    } else {
        Ok(())
    }
}
fn send(io: &impl ReportIo, request: Request, parameters: &[u8]) -> Result<(), String> {
    let report = request.encode(parameters);
    match io.write(&report)? {
        20 => Ok(()),
        n => Err(format!("incomplete HID write ({n}/20 bytes)")),
    }
}
fn receive(
    io: &impl ReportIo,
    request: Request,
    deadline: Instant,
) -> Result<Option<Reply>, String> {
    let mut buffer = [0; 256];
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Ok(None);
        };
        let n = io.read(&mut buffer, remaining.as_millis().clamp(1, 50) as i32)?;
        if n > buffer.len() {
            return Err("invalid report length".into());
        }
        if let Some(reply) = request.decode(&buffer[..n]) {
            return Ok(Some(reply));
        }
    }
}
fn query(
    io: &impl ReportIo,
    request: Request,
    parameters: &[u8],
    deadline: Instant,
    should_proceed: &impl Fn() -> bool,
) -> Result<Vec<u8>, HardwareError> {
    check_live(deadline, should_proceed)?;
    send(io, request, parameters).map_err(HardwareError::Query)?;
    match receive(io, request, deadline).map_err(HardwareError::Query)? {
        Some(Reply::Data(data)) => Ok(data),
        Some(Reply::Error(code)) => Err(HardwareError::Rejected(code)),
        None => Err(HardwareError::Query("response timed out".into())),
    }
}
fn discover(
    io: &impl ReportIo,
    deadline: Instant,
    should_proceed: &impl Fn() -> bool,
) -> Result<(u8, MouseInfo), HardwareError> {
    let feature = query(
        io,
        Request::new(0, 0),
        &[0x18, 0x14],
        deadline,
        should_proceed,
    )?[0];
    if feature == 0 {
        return Err(HardwareError::Query(
            "ChangeHost (0x1814) is unavailable".into(),
        ));
    }
    let hosts = query(io, Request::new(feature, 0), &[], deadline, should_proceed)?;
    if hosts[0] == 0 || hosts[1] >= hosts[0] {
        return Err(HardwareError::Query(
            "invalid ChangeHost host information".into(),
        ));
    }
    Ok((
        feature,
        MouseInfo {
            host_count: hosts[0],
            current_slot: hosts[1] + 1,
        },
    ))
}
fn perform_switch(
    io: &impl ReportIo,
    slot: u8,
    deadline: Instant,
    should_proceed: &impl Fn() -> bool,
    snapshot: impl Fn() -> Result<DeviceSnapshot, HardwareError>,
) -> Result<SwitchOutcome, HardwareError> {
    let (feature, info) = discover(io, deadline, should_proceed)?;
    if slot == 0 || slot > 3 || slot > info.host_count {
        return Err(HardwareError::InvalidSlot);
    }
    if slot == info.current_slot {
        return Ok(SwitchOutcome::AlreadyOnTarget);
    }
    // Re-enumeration must succeed. Unknown hardware state must never authorize a write.
    let fresh = snapshot()?;
    if fresh.keyboard_present {
        return Err(HardwareError::KeyboardPresent);
    }
    if !fresh.mouse_present {
        return Err(HardwareError::MouseUnavailable);
    }
    check_live(deadline, should_proceed)?;
    let request = Request::new(feature, 1);
    send(io, request, &[slot - 1]).map_err(HardwareError::Uncertain)?;
    // From this point onward there is never a second write, regardless of timeout or I/O error.
    let response = receive(io, request, deadline);
    match response {
        Ok(Some(Reply::Data(_))) => Ok(SwitchOutcome::Acknowledged),
        Ok(Some(Reply::Error(code))) => Err(HardwareError::Rejected(code)),
        result => match snapshot() {
            Ok(state) if !state.mouse_present => Ok(SwitchOutcome::Departed),
            state => Err(HardwareError::Uncertain(format!(
                "response: {result:?}; device state: {state:?}"
            ))),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        collections::VecDeque,
    };
    struct Fake {
        writes: RefCell<Vec<Vec<u8>>>,
        replies: RefCell<VecDeque<Vec<u8>>>,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                writes: RefCell::default(),
                replies: RefCell::new(VecDeque::from([
                    vec![0x10, 0xff, 0, 0x0d, 9, 0, 0],
                    vec![0x10, 0xff, 9, 0x0d, 3, 0, 0],
                ])),
            }
        }
    }
    impl ReportIo for Fake {
        fn write(&self, data: &[u8]) -> Result<usize, String> {
            self.writes.borrow_mut().push(data.to_vec());
            Ok(data.len())
        }
        fn read(&self, data: &mut [u8], _: i32) -> Result<usize, String> {
            let reply = self
                .replies
                .borrow_mut()
                .pop_front()
                .ok_or("disconnected")?;
            data[..reply.len()].copy_from_slice(&reply);
            Ok(reply.len())
        }
    }
    fn absent() -> Result<DeviceSnapshot, HardwareError> {
        Ok(DeviceSnapshot {
            keyboard_present: false,
            mouse_present: true,
        })
    }
    #[test]
    fn cancelled_request_has_no_writes() {
        let io = Fake::new();
        assert!(matches!(
            perform_switch(&io, 2, Instant::now() + LEASE, &|| false, absent),
            Err(HardwareError::Cancelled)
        ));
        assert!(io.writes.borrow().is_empty());
    }
    #[test]
    fn reconnect_prevents_switch_write() {
        let io = Fake::new();
        let result = perform_switch(&io, 2, Instant::now() + LEASE, &|| true, || {
            Ok(DeviceSnapshot {
                keyboard_present: true,
                mouse_present: true,
            })
        });
        assert!(matches!(result, Err(HardwareError::KeyboardPresent)));
        assert_eq!(io.writes.borrow().len(), 2);
    }
    #[test]
    fn unknown_presence_prevents_switch_write() {
        let io = Fake::new();
        assert!(
            perform_switch(&io, 2, Instant::now() + LEASE, &|| true, || Err(
                HardwareError::Enumeration("denied".into())
            ))
            .is_err()
        );
        assert_eq!(io.writes.borrow().len(), 2);
    }
    #[test]
    fn cancellation_after_queries_prevents_switch_write() {
        let io = Fake::new();
        let calls = Cell::new(0);
        let live = || {
            calls.set(calls.get() + 1);
            calls.get() < 3
        };
        assert!(matches!(
            perform_switch(&io, 2, Instant::now() + LEASE, &live, absent),
            Err(HardwareError::Cancelled)
        ));
        assert_eq!(io.writes.borrow().len(), 2);
    }
    #[test]
    fn uncertain_switch_is_written_once() {
        let io = Fake::new();
        assert!(matches!(
            perform_switch(&io, 2, Instant::now() + LEASE, &|| true, absent),
            Err(HardwareError::Uncertain(_))
        ));
        assert_eq!(
            io.writes.borrow().iter().filter(|r| r[3] == 0x1d).count(),
            1
        );
    }
    #[test]
    fn departure_is_distinct_from_acknowledgment() {
        let io = Fake::new();
        let polls = Cell::new(0);
        let state = || {
            polls.set(polls.get() + 1);
            Ok(DeviceSnapshot {
                keyboard_present: false,
                mouse_present: polls.get() == 1,
            })
        };
        assert_eq!(
            perform_switch(&io, 2, Instant::now() + LEASE, &|| true, state).unwrap(),
            SwitchOutcome::Departed
        );
    }
    #[test]
    fn already_on_target_does_not_write_switch() {
        let io = Fake::new();
        assert_eq!(
            perform_switch(&io, 1, Instant::now() + LEASE, &|| true, absent).unwrap(),
            SwitchOutcome::AlreadyOnTarget
        );
        assert_eq!(io.writes.borrow().len(), 2);
    }
    #[test]
    fn expired_request_has_no_writes() {
        let io = Fake::new();
        assert!(matches!(
            perform_switch(&io, 2, Instant::now() - LEASE, &|| true, absent),
            Err(HardwareError::Cancelled)
        ));
        assert!(io.writes.borrow().is_empty());
    }
    #[test]
    fn acknowledged_switch_has_exactly_one_switch_write() {
        let io = Fake::new();
        io.replies
            .borrow_mut()
            .push_back(vec![0x10, 0xff, 9, 0x1d, 0, 0, 0]);
        assert_eq!(
            perform_switch(&io, 2, Instant::now() + LEASE, &|| true, absent).unwrap(),
            SwitchOutcome::Acknowledged
        );
        assert_eq!(io.writes.borrow().len(), 3);
        assert_eq!(&io.writes.borrow()[2][..5], &[0x11, 0xff, 9, 0x1d, 1]);
    }
    #[test]
    fn rejection_is_not_retried() {
        let io = Fake::new();
        io.replies
            .borrow_mut()
            .push_back(vec![0x10, 0xff, 0xff, 9, 0x1d, 7, 0]);
        assert!(matches!(
            perform_switch(&io, 2, Instant::now() + LEASE, &|| true, absent),
            Err(HardwareError::Rejected(7))
        ));
        assert_eq!(io.writes.borrow().len(), 3);
    }
    #[test]
    fn malformed_host_information_cannot_switch() {
        let io = Fake::new();
        io.replies.borrow_mut()[1] = vec![0x10, 0xff, 9, 0x0d, 3, 3, 0];
        assert!(matches!(
            perform_switch(&io, 2, Instant::now() + LEASE, &|| true, absent),
            Err(HardwareError::Query(_))
        ));
        assert_eq!(io.writes.borrow().len(), 2);
    }
}
