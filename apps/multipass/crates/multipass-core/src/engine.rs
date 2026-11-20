use crate::{
    config::{self, ConfigStore, Settings},
    ipc::{Event, Handoff, PairingStatus, Request, State},
    keyboards::{Address, Keyboards},
    policy::SETTLE,
};
use anyhow::Result;
use multipass_hardware::{HardwareError, SwitchOutcome};
use multipass_network::{keyboard_key, Lease, Network, NetworkEvent, PairingEvent};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::mpsc;

/// Device presence is re-read this often; it bounds how quickly a keyboard arrival is noticed.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

struct ArrivalClaim {
    slot: u8,
    key: [u8; 32],
    nonce: [u8; 32],
    lease: Lease,
    ready: Instant,
}

pub struct Engine {
    pub(crate) config: ConfigStore,
    pub(crate) settings: Settings,
    pub(crate) secret: Option<[u8; 32]>,
    pub(crate) state: State,
    pub(crate) network: Option<Network>,
    pub(crate) network_events: Option<mpsc::UnboundedReceiver<NetworkEvent>>,
    keyboards: Keyboards,
    permission: Arc<AtomicBool>,
    last_good_observation: Arc<Mutex<SystemTime>>,
    suspended: bool,
    switching: Option<Address>,
    pending_claims: Vec<ArrivalClaim>,
    generation: u64,
    last_poll: SystemTime,
    done_tx: mpsc::UnboundedSender<(u64, String)>,
    done_rx: mpsc::UnboundedReceiver<(u64, String)>,
}

impl Engine {
    pub async fn new() -> Result<Self> {
        let config = ConfigStore::system()?;
        let settings = config.load()?;
        config.save(&settings)?;
        let (secret, credential_error) = match config::load_secret() {
            Ok(secret) => (secret, None),
            Err(error) => (
                None,
                Some(format!(
                    "{error}. Check the credential store, then reopen Multipass."
                )),
            ),
        };
        let state = State {
            node_name: hostname::get()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "This computer".into()),
            local_slot: settings.local_slot,
            slot_confirmed: settings.slot_confirmed,
            suggested_slot: None,
            enabled: false,
            paired: secret.is_some(),
            paired_peer: secret.and(settings.paired_peer.clone()),
            keyboard_present: None,
            mouse_present: None,
            network_status: "Starting discovery".into(),
            peers: 0,
            nearby: Vec::new(),
            pairing: None,
            last_event: credential_error.clone().unwrap_or_default(),
            credential_error,
            handoff: None,
        };
        let (done_tx, done_rx) = mpsc::unbounded_channel();
        let mut engine = Self {
            config,
            settings,
            secret,
            state,
            network: None,
            network_events: None,
            keyboards: Keyboards::new(Instant::now()),
            permission: Arc::new(AtomicBool::new(false)),
            last_good_observation: Arc::new(Mutex::new(SystemTime::UNIX_EPOCH)),
            suspended: false,
            switching: None,
            pending_claims: Vec::new(),
            generation: 0,
            last_poll: SystemTime::now(),
            done_tx,
            done_rx,
        };
        engine.state.enabled =
            engine.settings.enabled && engine.settings.slot_confirmed && engine.secret.is_some();
        // Discovery runs whenever the engine does, so unpaired computers can find each other.
        if let Err(error) = engine.start_network().await {
            engine.state.network_status = error.to_string();
        }
        Ok(engine)
    }

    pub async fn run(mut self, mut commands: mpsc::Receiver<Request>, mut emit: impl FnMut(Event)) {
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        if self.state.enabled {
            self.check_mouse_access().await;
        }
        let mut last_state = None;
        loop {
            if last_state.as_ref() != Some(&self.state) {
                emit(Event::State {
                    state: Box::new(self.state.clone()),
                });
                last_state = Some(self.state.clone());
            }
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { break };
                    let stop = matches!(command.command, crate::ipc::Command::Shutdown);
                    emit(self.command(command).await);
                    emit(Event::State { state: Box::new(self.state.clone()) });
                    last_state = Some(self.state.clone());
                    if stop { break; }
                }
                _ = ticker.tick() => self.poll().await,
                event = next_network(&mut self.network_events) => {
                    match event {
                        Some(NetworkEvent::Status(message)) => self.state.network_status = message,
                        Some(NetworkEvent::Peers(nearby)) => { self.state.peers = nearby.len(); self.state.nearby = nearby; }
                        Some(NetworkEvent::Claim { sender: _, slot, key, nonce, lease }) => {
                            self.receive_claim(ArrivalClaim { slot, key, nonce, lease, ready: Instant::now() + SETTLE });
                        }
                        Some(NetworkEvent::Pairing(event)) => self.pairing_event(event),
                        None => { self.network_events = None; self.state.network_status = "Networking stopped".into(); }
                    }
                }
                Some((generation, message)) = self.done_rx.recv() => {
                    self.switching = None;
                    if generation == self.generation { self.record_handoff(message); }
                }
            }
        }
        self.reset();
        self.stop_network().await;
    }

    /// Reach the mouse over HID++ read-only so a missing OS permission shows up
    /// when switching is enabled, not silently during the first handoff. macOS
    /// keys Input Monitoring to the app's code signature, so a rebuilt ad-hoc
    /// signed app loses the grant while System Settings still shows it on.
    pub(crate) async fn check_mouse_access(&mut self) -> Option<String> {
        if !self.state.enabled && self.state.slot_confirmed {
            return None;
        }
        match tokio::task::spawn_blocking(multipass_hardware::probe).await {
            Ok(Ok(info)) if (1..=3).contains(&info.current_slot) => {
                self.state.suggested_slot = Some(info.current_slot);
                None
            }
            Ok(Err(HardwareError::Access(_))) => {
                self.state.suggested_slot = None;
                let message = mouse_access_guidance().to_owned();
                self.state.last_event = message.clone();
                Some(message)
            }
            _ => {
                self.state.suggested_slot = None;
                None
            }
        }
    }

    fn record_handoff(&mut self, message: String) {
        self.state.last_event.clone_from(&message);
        self.state.handoff = Some(Handoff {
            message,
            occurred_at: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        });
    }

    pub(crate) fn reset(&mut self) {
        self.pending_claims.clear();
        self.permission.store(false, Ordering::SeqCst);
        self.permission = Arc::new(AtomicBool::new(false));
        self.keyboards.reset(Instant::now());
        self.generation = self.generation.wrapping_add(1);
    }

    pub(crate) async fn stop_network(&mut self) {
        self.reset();
        self.network_events = None;
        if let Some(mut network) = self.network.take() {
            network.stop().await;
        }
        self.state.peers = 0;
        self.state.nearby.clear();
        self.state.pairing = None;
    }

    pub(crate) async fn start_network(&mut self) -> Result<()> {
        self.stop_network().await;
        if self.suspended {
            self.state.network_status = "Paused during sleep".into();
            return Ok(());
        }
        let (network, receiver) = Network::start(
            self.settings.node_id,
            self.state.node_name.clone(),
            self.secret,
        )
        .await?;
        self.network = Some(network);
        self.network_events = Some(receiver);
        self.state.network_status = "Discovering computers on the local network".into();
        Ok(())
    }

    fn pairing_event(&mut self, event: PairingEvent) {
        match event {
            PairingEvent::Started { peer_name } => {
                self.state.last_event = format!("Connecting to {peer_name} to pair");
                self.state.pairing = Some(PairingStatus {
                    peer_name,
                    code: None,
                    incoming: false,
                    locally_confirmed: false,
                });
            }
            PairingEvent::Code {
                peer_name,
                code,
                incoming,
            } => {
                self.state.last_event = if incoming {
                    format!("{peer_name} wants to pair; compare the code on both screens")
                } else {
                    format!("Compare the code shown on {peer_name}")
                };
                self.state.pairing = Some(PairingStatus {
                    peer_name,
                    code: Some(code),
                    incoming,
                    locally_confirmed: false,
                });
            }
            PairingEvent::Completed { peer, secret } => {
                self.state.pairing = None;
                let peer_name = peer.name.clone();
                self.state.last_event = match self.install_secret(*secret, peer) {
                    Ok(Some(warning)) => warning,
                    Ok(None) => format!("Paired with {peer_name}."),
                    Err(error) => {
                        format!("Could not save pairing with {peer_name}: {error}. Pair again on both computers.")
                    }
                };
            }
            PairingEvent::Failed { message } => {
                self.state.pairing = None;
                self.state.last_event = message;
            }
        }
    }

    async fn poll(&mut self) {
        let wall_now = SystemTime::now();
        let gap = wall_now
            .duration_since(self.last_poll)
            .unwrap_or(Duration::MAX);
        self.last_poll = wall_now;
        if gap > Duration::from_secs(3) {
            self.reset();
            if !self.suspended {
                if let Err(error) = self.start_network().await {
                    self.state.network_status = error.to_string();
                }
            }
            self.state.last_event =
                "Resumed after a clock gap; waiting for a fresh keyboard connection".into();
        }
        if self.suspended {
            return;
        }
        let snapshot = tokio::task::spawn_blocking(|| {
            let keyboards = multipass_hardware::connected_keyboard_addresses()?;
            let mouse_present = multipass_hardware::mouse_present()?;
            Ok::<_, multipass_hardware::HardwareError>((keyboards, mouse_present))
        })
        .await;
        match snapshot {
            Ok(Ok((connected, mouse_present))) => {
                if !mouse_present {
                    self.state.suggested_slot = None;
                } else if self.state.mouse_present != Some(true) && !self.state.slot_confirmed {
                    self.check_mouse_access().await;
                }
                self.state.keyboard_present = Some(!connected.is_empty());
                self.state.mouse_present = Some(mouse_present);
                *self.last_good_observation.lock().unwrap() = SystemTime::now();
                if self
                    .switching
                    .is_some_and(|keyboard| connected.contains(&keyboard))
                {
                    self.permission.store(false, Ordering::SeqCst);
                }
                let changes = self.keyboards.observe(connected, Instant::now());
                if changes.departures > 0 {
                    let message = if changes.departures == 1 {
                        "A Bluetooth keyboard disconnected from this computer.".to_owned()
                    } else {
                        format!(
                            "{} Bluetooth keyboards disconnected from this computer.",
                            changes.departures
                        )
                    };
                    self.record_handoff(message);
                }
                if self.state.enabled && self.state.peers > 0 {
                    for (keyboard, current) in changes.arrivals {
                        if let Some(network) = &self.network {
                            network
                                .announce(self.settings.local_slot, keyboard, current)
                                .await;
                            self.record_handoff(format!(
                                "Keyboard arrived here. Requesting the mouse on slot {}.",
                                self.settings.local_slot
                            ));
                        }
                    }
                }
                self.match_departure();
            }
            failure => {
                self.state.keyboard_present = None;
                self.state.mouse_present = None;
                self.state.suggested_slot = None;
                self.reset();
                self.state.last_event = match failure {
                    Ok(Err(error)) => format!("Device detection unavailable: {error}"),
                    _ => "Device detection worker stopped".into(),
                };
            }
        }
    }

    fn receive_claim(&mut self, claim: ArrivalClaim) {
        if !self.state.enabled
            || self.suspended
            || self.switching.is_some()
            || !claim.lease.is_valid()
        {
            return;
        }
        if claim.slot == self.settings.local_slot {
            self.record_handoff(format!("Both computers use mouse slot {} in Multipass. Check the mouse’s Bluetooth slot on each computer and update the one that differs.", claim.slot));
            return;
        }
        if self.pending_claims.len() >= 32 {
            self.reset();
            return;
        }
        self.pending_claims.push(claim);
    }

    fn match_departure(&mut self) {
        self.pending_claims.retain(|claim| claim.lease.is_valid());
        let Some(secret) = self.secret.as_ref() else {
            return;
        };
        if self.switching.is_some() || self.state.mouse_present != Some(true) {
            return;
        }
        let matches: Vec<_> = self
            .pending_claims
            .iter()
            .enumerate()
            .filter_map(|(index, claim)| {
                self.keyboards
                    .recent_departures()
                    .find(|address| keyboard_key(*address, &claim.nonce, secret) == claim.key)
                    .map(|address| (index, address))
            })
            .collect();
        match matches.as_slice() {
            &[(index, address)] if self.pending_claims[index].ready <= Instant::now() => {
                let claim = self.pending_claims.swap_remove(index);
                self.keyboards.consume_departure(address);
                self.start_switch(address, claim.slot, claim.lease);
            }
            [_, _, ..] => {
                for (_, address) in matches {
                    self.keyboards.consume_departure(address);
                }
                self.pending_claims.clear();
                self.record_handoff(
                    "Multiple keyboards moved. Switch one keyboard at a time to move the mouse."
                        .into(),
                );
            }
            _ => {}
        }
    }

    fn start_switch(&mut self, keyboard: Address, slot: u8, lease: Lease) {
        self.permission.store(false, Ordering::SeqCst);
        self.permission = Arc::new(AtomicBool::new(true));
        self.switching = Some(keyboard);
        let permission = self.permission.clone();
        let observed = self.last_good_observation.clone();
        let generation = self.generation;
        let done = self.done_tx.clone();
        tokio::task::spawn_blocking(move || {
            let result = multipass_hardware::switch_to_following(keyboard, slot, || {
                permission.load(Ordering::SeqCst)
                    && lease.is_valid()
                    && observed
                        .lock()
                        .ok()
                        .and_then(|last| SystemTime::now().duration_since(*last).ok())
                        .is_some_and(|age| age < Duration::from_secs(2))
            });
            let message = handoff_outcome(slot, result);
            let _ = done.send((generation, message));
        });
    }

    pub(crate) async fn suspend(&mut self) {
        self.suspended = true;
        self.stop_network().await;
        self.state.network_status = "Paused during sleep".into();
    }
    pub(crate) async fn resume(&mut self) -> Result<()> {
        self.suspended = false;
        self.last_poll = SystemTime::now();
        self.reset();
        self.start_network().await
    }
}

fn mouse_access_guidance() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Mouse access is blocked. Open Input Monitoring in System Settings, allow Multipass, then quit and reopen it."
    }
    #[cfg(target_os = "linux")]
    {
        "Mouse access is blocked. Check the MX Master 4 hidraw permissions for your desktop session, then reconnect the mouse."
    }
    #[cfg(target_os = "windows")]
    {
        "Mouse access is blocked. Reconnect the MX Master 4 in Bluetooth settings and close other apps using its controls."
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "Mouse access is blocked. Check this computer’s HID device permissions."
    }
}

fn handoff_outcome(slot: u8, result: Result<SwitchOutcome, HardwareError>) -> String {
    match result {
        Ok(SwitchOutcome::Acknowledged) =>
            format!("Mouse acknowledged slot {slot}. Check the pointer on the other computer."),
        Ok(SwitchOutcome::Departed) =>
            format!("Mouse left this computer for slot {slot}. Check the pointer on the other computer."),
        Ok(SwitchOutcome::AlreadyOnTarget) => format!("Mouse already uses slot {slot}."),
        Err(HardwareError::Access(_)) => mouse_access_guidance().to_owned(),
        Err(HardwareError::MouseUnavailable) =>
            "Couldn’t reach the MX Master 4. Connect it to this computer, then switch the keyboard again.".into(),
        Err(HardwareError::Uncertain(_)) =>
            format!("Mouse switch to slot {slot} is unconfirmed. Check which computer has the pointer."),
        Err(error) => format!("Mouse handoff stopped: {error}. Check the mouse and keyboard connections before trying again."),
    }
}

async fn next_network(
    receiver: &mut Option<mpsc::UnboundedReceiver<NetworkEvent>>,
) -> Option<NetworkEvent> {
    match receiver {
        Some(receiver) => receiver.recv().await,
        None => std::future::pending().await,
    }
}
