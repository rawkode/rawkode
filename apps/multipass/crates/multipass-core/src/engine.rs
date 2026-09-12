use crate::{
    config::{self, ConfigStore, Settings},
    ipc::{Event, Request, State},
    policy::{self, AttachmentPolicy},
};
use anyhow::Result;
use multipass_network::{Lease, Network, NetworkEvent};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::mpsc;

pub struct Engine {
    pub(crate) config: ConfigStore,
    pub(crate) settings: Settings,
    pub(crate) secret: Option<[u8; 32]>,
    pub(crate) state: State,
    pub(crate) network: Option<Network>,
    pub(crate) network_events: Option<mpsc::UnboundedReceiver<NetworkEvent>>,
    policy: AttachmentPolicy,
    permission: Arc<AtomicBool>,
    last_good_observation: Arc<Mutex<SystemTime>>,
    suspended: bool,
    switching: bool,
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
        let (secret, warning) = match config::load_secret() {
            Ok(secret) => (secret, String::new()),
            Err(error) => (None, error.to_string()),
        };
        let state = State {
            node_name: hostname::get()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "This computer".into()),
            local_slot: settings.local_slot,
            enabled: false,
            paired: secret.is_some(),
            keyboard_present: None,
            mouse_present: None,
            network_status: "Pair your computers to begin".into(),
            peers: 0,
            last_event: warning,
        };
        let (done_tx, done_rx) = mpsc::unbounded_channel();
        let mut engine = Self {
            config,
            settings,
            secret,
            state,
            network: None,
            network_events: None,
            policy: AttachmentPolicy::new(Instant::now()),
            permission: Arc::new(AtomicBool::new(false)),
            last_good_observation: Arc::new(Mutex::new(SystemTime::UNIX_EPOCH)),
            suspended: false,
            switching: false,
            generation: 0,
            last_poll: SystemTime::now(),
            done_tx,
            done_rx,
        };
        if engine.settings.enabled && engine.secret.is_some() {
            engine.state.enabled = true;
            if let Err(error) = engine.start_network().await {
                engine.state.enabled = false;
                engine.state.network_status = error.to_string();
            }
        }
        Ok(engine)
    }

    pub async fn run(mut self, mut commands: mpsc::Receiver<Request>, mut emit: impl FnMut(Event)) {
        let mut ticker = tokio::time::interval(Duration::from_millis(250));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_state = None;
        loop {
            if last_state.as_ref() != Some(&self.state) {
                emit(Event::State {
                    state: self.state.clone(),
                });
                last_state = Some(self.state.clone());
            }
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { break };
                    let stop = matches!(command.command, crate::ipc::Command::Shutdown);
                    emit(self.command(command).await);
                    emit(Event::State { state: self.state.clone() });
                    last_state = Some(self.state.clone());
                    if stop { break; }
                }
                _ = ticker.tick() => self.poll().await,
                event = next_network(&mut self.network_events) => {
                    match event {
                        Some(NetworkEvent::Status(message)) => self.state.network_status = message,
                        Some(NetworkEvent::Peers(count)) => self.state.peers = count,
                        Some(NetworkEvent::Claim { sender: _, slot, lease }) => self.receive_claim(slot,lease),
                        None => { self.network_events = None; self.state.network_status = "Networking stopped".into(); }
                    }
                }
                Some((generation, message)) = self.done_rx.recv() => {
                    self.switching = false;
                    if generation == self.generation { self.state.last_event = message; }
                }
            }
        }
        self.reset();
        self.stop_network().await;
    }

    pub(crate) fn reset(&mut self) {
        self.permission.store(false, Ordering::SeqCst);
        self.permission = Arc::new(AtomicBool::new(false));
        self.policy.reset(Instant::now());
        self.generation = self.generation.wrapping_add(1);
    }

    pub(crate) async fn stop_network(&mut self) {
        self.reset();
        self.network_events = None;
        if let Some(mut network) = self.network.take() {
            network.stop().await;
        }
        self.state.peers = 0;
    }

    pub(crate) async fn start_network(&mut self) -> Result<()> {
        self.stop_network().await;
        let Some(secret) = self.secret else {
            anyhow::bail!("Pair your computers before enabling switching");
        };
        if self.suspended {
            self.state.network_status = "Paused during sleep".into();
            return Ok(());
        }
        let (network, receiver) =
            Network::start(self.settings.node_id, self.state.node_name.clone(), secret).await?;
        self.network = Some(network);
        self.network_events = Some(receiver);
        self.state.network_status = "Discovering paired computers; wait three seconds".into();
        Ok(())
    }

    async fn poll(&mut self) {
        let wall_now = SystemTime::now();
        let gap = wall_now
            .duration_since(self.last_poll)
            .unwrap_or(Duration::MAX);
        self.last_poll = wall_now;
        if gap > Duration::from_secs(3) {
            self.reset();
            if self.state.enabled && !self.suspended {
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
        let snapshot = tokio::task::spawn_blocking(multipass_hardware::snapshot).await;
        match snapshot {
            Ok(Ok(snapshot)) => {
                self.state.keyboard_present = Some(snapshot.keyboard_present);
                self.state.mouse_present = Some(snapshot.mouse_present);
                *self.last_good_observation.lock().unwrap() = SystemTime::now();
                if snapshot.keyboard_present {
                    self.permission.store(false, Ordering::SeqCst);
                }
                if let Some(current) = self
                    .policy
                    .observe(Some(snapshot.keyboard_present), Instant::now())
                {
                    if self.state.enabled {
                        if let Some(network) = &self.network {
                            if self.state.peers > 0 {
                                network.announce(self.settings.local_slot, current).await;
                                self.state.last_event = format!(
                                    "Keyboard connected; requesting mouse slot {}",
                                    self.settings.local_slot
                                );
                            } else {
                                self.state.last_event =
                                    "Keyboard connected; no peer discovered, mouse unchanged"
                                        .into();
                            }
                        }
                    }
                }
            }
            failure => {
                self.state.keyboard_present = None;
                self.state.mouse_present = None;
                self.reset();
                self.state.last_event = match failure {
                    Ok(Err(error)) => format!("Device detection unavailable: {error}"),
                    _ => "Device detection worker stopped".into(),
                };
            }
        }
    }

    fn receive_claim(&mut self, slot: u8, lease: Lease) {
        if self.switching
            || !lease.is_valid()
            || !policy::permits_switch(
                self.state.enabled,
                self.suspended,
                self.settings.local_slot,
                slot,
                self.state.keyboard_present,
                self.state.mouse_present,
            )
        {
            return;
        }
        self.permission.store(false, Ordering::SeqCst);
        self.permission = Arc::new(AtomicBool::new(true));
        self.switching = true;
        let permission = self.permission.clone();
        let observed = self.last_good_observation.clone();
        let generation = self.generation;
        let done = self.done_tx.clone();
        tokio::task::spawn_blocking(move || {
            let result = multipass_hardware::switch_to(slot, || {
                permission.load(Ordering::SeqCst)
                    && lease.is_valid()
                    && observed
                        .lock()
                        .ok()
                        .and_then(|last| SystemTime::now().duration_since(*last).ok())
                        .is_some_and(|age| age < Duration::from_secs(2))
            });
            let message = match result {
                Ok(multipass_hardware::SwitchOutcome::Acknowledged) => {
                    format!("Mouse acknowledged slot {slot}; destination unconfirmed")
                }
                Ok(multipass_hardware::SwitchOutcome::Departed) => {
                    format!("Mouse left this computer for slot {slot}")
                }
                Ok(multipass_hardware::SwitchOutcome::AlreadyOnTarget) => {
                    format!("Mouse already uses slot {slot}")
                }
                Err(error) => format!("Mouse unchanged or switch unconfirmed: {error}"),
            };
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
        if self.state.enabled {
            self.start_network().await?;
        }
        Ok(())
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
