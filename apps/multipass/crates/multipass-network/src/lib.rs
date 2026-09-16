//! Cross-platform LAN transport. Protocol v3 replaces the copied pairing code
//! with an in-band pairing handshake: discovery is unauthenticated, pairing is
//! an X25519 agreement confirmed by a short code compared on both screens, and
//! switch claims are HMAC-authenticated with the resulting secret. Claims and
//! discovery metadata are unencrypted; pairing keys never leave the process.
use anyhow::{bail, Context as _, Result};
use hmac::{Hmac, Mac};
use mdns_sd::{ScopedIp, ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fmt,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch},
    task::{JoinHandle, JoinSet},
    time::{sleep, timeout},
};
use uuid::Uuid;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

const SERVICE: &str = "_multipass._tcp.local.";
const VERSION: u8 = 3;
const FRAME_MAX: usize = 4096;
const SESSION_LIMIT: usize = 64;
const FANOUT_LIMIT: usize = 32;
const NAME_LIMIT: usize = 64;
/// Bound for the automatic part of pairing (connect, key exchange).
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(5);
/// Bound for both people to compare the code and confirm.
const DECISION_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a verified switch claim stays valid on the receiver. The source may
/// still see the keyboard for a moment after it moved, so this leaves time for
/// its departure to register before the mouse follows.
pub const CLAIM_WINDOW: Duration = Duration::from_secs(3);

#[derive(Clone, Debug)]
pub struct Lease {
    revoked: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    deadline: Instant,
}
impl Lease {
    fn new(stopped: Arc<AtomicBool>) -> Self {
        Self {
            revoked: Arc::new(AtomicBool::new(false)),
            stopped,
            deadline: Instant::now() + CLAIM_WINDOW,
        }
    }
    pub fn is_valid(&self) -> bool {
        !self.revoked.load(Ordering::Acquire)
            && !self.stopped.load(Ordering::Acquire)
            && Instant::now() < self.deadline
    }
}
struct Revoke(Lease);
impl Drop for Revoke {
    fn drop(&mut self) {
        self.0.revoked.store(true, Ordering::Release);
    }
}

/// A computer discovered on the local network. Names are self-reported and untrusted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PeerSummary {
    pub id: Uuid,
    pub name: String,
}

pub enum PairingEvent {
    /// This computer started pairing with `peer_name`.
    Started {
        peer_name: String,
    },
    /// Both sides derived the same code; show it and ask the person to confirm.
    Code {
        peer_name: String,
        code: String,
        incoming: bool,
    },
    /// Both people confirmed; install `secret` as the pairing key.
    Completed {
        peer_name: String,
        secret: Zeroizing<[u8; 32]>,
    },
    Failed {
        message: String,
    },
}
impl fmt::Debug for PairingEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Started { peer_name } => write!(f, "Started({peer_name})"),
            Self::Code { peer_name, .. } => write!(f, "Code({peer_name})"),
            Self::Completed { peer_name, .. } => write!(f, "Completed({peer_name})"),
            Self::Failed { message } => write!(f, "Failed({message})"),
        }
    }
}

#[derive(Debug)]
pub enum NetworkEvent {
    Status(String),
    Peers(Vec<PeerSummary>),
    Claim {
        sender: Uuid,
        slot: u8,
        lease: Lease,
    },
    Pairing(PairingEvent),
}
struct Announcement {
    slot: u8,
    current: Arc<AtomicBool>,
}
enum WorkerCommand {
    Announce(Announcement),
    Pair(Uuid),
}
#[derive(Clone)]
struct Peer {
    id: Uuid,
    name: String,
    addresses: Vec<SocketAddr>,
}
type Secret = Arc<Mutex<Option<Zeroizing<[u8; 32]>>>>;
type Decision = watch::Sender<Option<bool>>;
type PairingSlot = Arc<Mutex<Option<Decision>>>;
#[derive(Clone)]
struct Context {
    id: Uuid,
    name: String,
    secret: Secret,
    pairing: PairingSlot,
    stopped: Arc<AtomicBool>,
    events: mpsc::UnboundedSender<NetworkEvent>,
}
impl Context {
    fn emit(&self, event: NetworkEvent) {
        let _ = self.events.send(event);
    }
    fn pairing_failed(&self, message: impl Into<String>) {
        self.emit(NetworkEvent::Pairing(PairingEvent::Failed {
            message: message.into(),
        }));
    }
}

pub struct Network {
    commands: mpsc::Sender<WorkerCommand>,
    shutdown: watch::Sender<bool>,
    stopped: Arc<AtomicBool>,
    secret: Secret,
    pairing: PairingSlot,
    worker: Option<JoinHandle<()>>,
    daemon: ServiceDaemon,
}
impl Network {
    /// Start discovery and the listener. Without a secret this computer is
    /// visible and can pair, but sends and accepts no switch claims.
    pub async fn start(
        node_id: Uuid,
        name: String,
        secret: Option<[u8; 32]>,
    ) -> Result<(Self, mpsc::UnboundedReceiver<NetworkEvent>)> {
        let name = sanitize_name(&name);
        let listener = bind_dual_stack()?;
        let port = listener.local_addr()?.port();
        let daemon = ServiceDaemon::new()?;
        // Shut down the daemon on any fallible setup path too.
        let setup = (|| -> Result<_> {
            let browse = daemon.browse(SERVICE)?;
            let instance = node_id.to_string();
            let hostname = format!("multipass-{node_id}.local.");
            let version = VERSION.to_string();
            let properties = [("version", version.as_str()), ("name", name.as_str())];
            let service =
                ServiceInfo::new(SERVICE, &instance, &hostname, "", port, &properties[..])?
                    .enable_addr_auto();
            daemon.register(service)?;
            Ok(browse)
        })();
        let browse = match setup {
            Ok(value) => value,
            Err(error) => {
                let _ = daemon.shutdown();
                return Err(error);
            }
        };
        let (events, receiver) = mpsc::unbounded_channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let secret: Secret = Arc::new(Mutex::new(secret.map(Zeroizing::new)));
        let pairing: PairingSlot = Arc::new(Mutex::new(None));
        let context = Context {
            id: node_id,
            name,
            secret: secret.clone(),
            pairing: pairing.clone(),
            stopped: stopped.clone(),
            events,
        };
        let (commands, mut requests) = mpsc::channel::<WorkerCommand>(8);
        let (shutdown, mut cancellation) = watch::channel(false);
        let worker = tokio::spawn(async move {
            let mut peers = HashMap::<String, Peer>::new();
            let mut sessions = JoinSet::new();
            context.emit(NetworkEvent::Status(
                "Discovering computers on the local network.".into(),
            ));
            loop {
                tokio::select! {
                    biased;
                    _ = cancellation.changed() => break,
                    Some(_) = sessions.join_next(), if !sessions.is_empty() => {},
                    connection = listener.accept() => match connection {
                        Ok((stream, _)) if sessions.len() < SESSION_LIMIT => {
                            let context = context.clone();
                            sessions.spawn(async move { let _ = handle_connection(stream, context).await; });
                        },
                        Ok(_) => {},
                        Err(error) => { context.emit(NetworkEvent::Status(format!("Listener failed: {error}"))); break; }
                    },
                    Some(command) = requests.recv() => match command {
                        WorkerCommand::Announce(request) => {
                            if request.current.load(Ordering::Acquire) {
                                for peer in peers.values().take(FANOUT_LIMIT) {
                                    if sessions.len() >= SESSION_LIMIT { break; }
                                    let peer = peer.clone(); let context = context.clone(); let current = request.current.clone();
                                    sessions.spawn(async move { let events = context.events.clone(); match timeout(CLAIM_WINDOW + Duration::from_secs(2), send_claim(peer, request.slot, current, context)).await { Ok(Ok(())) => {}, Ok(Err(error)) => { let _ = events.send(NetworkEvent::Status(format!("Peer request failed: {error}"))); }, Err(_) => { let _ = events.send(NetworkEvent::Status("Peer request timed out.".into())); } } });
                                }
                            }
                        },
                        WorkerCommand::Pair(id) => match peers.values().find(|peer| peer.id == id).cloned() {
                            Some(peer) if sessions.len() < SESSION_LIMIT => {
                                let context = context.clone();
                                sessions.spawn(async move { initiate_pairing(peer, context).await; });
                            },
                            Some(_) => context.pairing_failed("Too many connections; try again in a moment"),
                            None => context.pairing_failed("That computer is no longer visible on the network"),
                        },
                    },
                    event = browse.recv_async() => match event {
                        Ok(ServiceEvent::ServiceResolved(info)) => {
                            if info.txt_properties.get_property_val_str("version") != Some(VERSION.to_string().as_str()) { continue; }
                            let instance = info.fullname.strip_suffix(SERVICE).unwrap_or("").trim_end_matches('.');
                            if let Ok(id) = Uuid::parse_str(instance) {
                                if id != context.id && (peers.len() < 256 || peers.contains_key(&info.fullname)) {
                                    let addresses = peer_addresses(info.addresses.iter(), info.port);
                                    let name = sanitize_name(info.txt_properties.get_property_val_str("name").unwrap_or(""));
                                    if !addresses.is_empty() { peers.insert(info.fullname.clone(), Peer { id, name, addresses }); }
                                }
                            }
                            context.emit(NetworkEvent::Peers(summarize(&peers)));
                        },
                        Ok(ServiceEvent::ServiceRemoved(_, fullname)) => { peers.remove(&fullname); context.emit(NetworkEvent::Peers(summarize(&peers))); },
                        Ok(_) => {},
                        Err(_) => { context.emit(NetworkEvent::Status("Discovery stopped unexpectedly.".into())); break; }
                    }
                }
            }
            context.stopped.store(true, Ordering::Release);
            sessions.abort_all();
            while sessions.join_next().await.is_some() {}
            context.emit(NetworkEvent::Peers(Vec::new()));
        });
        Ok((
            Self {
                commands,
                shutdown,
                stopped,
                secret,
                pairing,
                worker: Some(worker),
                daemon,
            },
            receiver,
        ))
    }
    pub async fn announce(&self, slot: u8, current: Arc<AtomicBool>) {
        if (1..=3).contains(&slot)
            && !self.stopped.load(Ordering::Acquire)
            && current.load(Ordering::Acquire)
            && self.secret.lock().map(|s| s.is_some()).unwrap_or(false)
        {
            // A full queue drops the new request; stale attachment events must never wait offline.
            let _ = self
                .commands
                .try_send(WorkerCommand::Announce(Announcement { slot, current }));
        }
    }
    /// Replace the pairing key used for claims without restarting discovery.
    pub fn set_secret(&self, secret: Option<[u8; 32]>) {
        if let Ok(mut current) = self.secret.lock() {
            *current = secret.map(Zeroizing::new);
        }
    }
    /// Begin pairing with a discovered computer. Progress arrives as `PairingEvent`s.
    pub fn pair(&self, peer: Uuid) -> Result<()> {
        if self.stopped.load(Ordering::Acquire) {
            bail!("Discovery is not running");
        }
        self.commands
            .try_send(WorkerCommand::Pair(peer))
            .map_err(|_| anyhow::anyhow!("Multipass is busy; try again in a moment"))
    }
    /// Answer the code prompt for the pairing in progress. Returns false when none is waiting.
    pub fn decide(&self, accept: bool) -> bool {
        match self.pairing.lock() {
            Ok(slot) => slot
                .as_ref()
                .is_some_and(|decision| decision.send(Some(accept)).is_ok()),
            Err(_) => false,
        }
    }
    pub async fn stop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        let _ = self.shutdown.send(true);
        if let Some(worker) = self.worker.take() {
            let _ = worker.await;
        }
        if let Ok(done) = self.daemon.shutdown() {
            let _ = timeout(Duration::from_secs(2), done.recv_async()).await;
        }
    }
}
impl Drop for Network {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        let _ = self.shutdown.send(true);
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
        let _ = self.daemon.shutdown();
    }
}

fn sanitize_name(name: &str) -> String {
    let name: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(NAME_LIMIT)
        .collect();
    if name.trim().is_empty() {
        "Unnamed computer".into()
    } else {
        name.trim().to_owned()
    }
}
fn summarize(peers: &HashMap<String, Peer>) -> Vec<PeerSummary> {
    let mut summary: Vec<_> = peers
        .values()
        .map(|peer| PeerSummary {
            id: peer.id,
            name: peer.name.clone(),
        })
        .collect();
    summary.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    summary.dedup();
    summary
}

/// Listen on every interface for both IPv4 and IPv6. IPv6 is bound as a
/// dual-stack socket so a single advertised port serves both; when IPv6 is
/// unavailable on the host, an IPv4-only socket keeps discovery working.
fn bind_dual_stack() -> Result<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let dual = (|| -> std::io::Result<TcpListener> {
        let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))?;
        socket.set_only_v6(false)?;
        socket.set_nonblocking(true)?;
        socket.bind(&SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0)).into())?;
        socket.listen(SESSION_LIMIT as i32)?;
        TcpListener::from_std(socket.into())
    })();
    match dual {
        Ok(listener) => Ok(listener),
        Err(_) => {
            let std_listener = std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))?;
            std_listener.set_nonblocking(true)?;
            TcpListener::from_std(std_listener).map_err(Into::into)
        }
    }
}

/// Endpoints to try for a discovered peer, IPv4 first. IPv6 link-local
/// addresses carry the index of the interface they were heard on, which is
/// required for connecting; mDNS advertises every link-local address a host
/// has, so most of them are unreachable and are tried concurrently.
fn peer_addresses<'a>(addresses: impl Iterator<Item = &'a ScopedIp>, port: u16) -> Vec<SocketAddr> {
    let mut v4 = Vec::new();
    let mut v6 = Vec::new();
    for address in addresses {
        match address {
            ScopedIp::V4(ip) if !ip.addr().is_unspecified() && !ip.addr().is_multicast() => {
                v4.push(SocketAddr::new(IpAddr::V4(*ip.addr()), port));
            }
            ScopedIp::V6(ip) if !ip.addr().is_unspecified() && !ip.addr().is_multicast() => {
                let link_local = (ip.addr().segments()[0] & 0xffc0) == 0xfe80;
                let scope = if link_local { ip.scope_id().index } else { 0 };
                v6.push(SocketAddr::V6(SocketAddrV6::new(
                    *ip.addr(),
                    port,
                    0,
                    scope,
                )));
            }
            _ => {}
        }
    }
    v4.sort();
    v6.sort();
    v4.into_iter().chain(v6).take(16).collect()
}

/// Connect to the first endpoint that answers. Attempts run concurrently so
/// dead link-local addresses do not serialize into the session timeout.
async fn connect_any(addresses: &[SocketAddr]) -> std::io::Result<TcpStream> {
    let mut attempts = JoinSet::new();
    for address in addresses.iter().copied() {
        attempts.spawn(async move { TcpStream::connect(address).await });
    }
    let mut last = std::io::Error::new(std::io::ErrorKind::NotFound, "No addresses to connect to");
    while let Some(attempt) = attempts.join_next().await {
        match attempt {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(error)) => last = error,
            Err(error) => last = std::io::Error::other(error),
        }
    }
    Err(last)
}

// ---------------------------------------------------------------------------
// Wire frames. The listener always speaks first with a `Challenge`; the client
// answers with a `claim` or a `pair_offer`, identified by `kind`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Challenge {
    version: u8,
    receiver: Uuid,
    nonce: [u8; 32],
}
#[derive(Deserialize)]
struct Envelope {
    kind: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claim {
    kind: String,
    version: u8,
    sender: Uuid,
    receiver: Uuid,
    slot: u8,
    nonce: [u8; 32],
    signature: [u8; 32],
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PairOffer {
    kind: String,
    version: u8,
    sender: Uuid,
    receiver: Uuid,
    name: String,
    commitment: [u8; 32],
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PairAccept {
    kind: String,
    version: u8,
    name: String,
    public_key: [u8; 32],
    nonce: [u8; 32],
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PairReveal {
    kind: String,
    version: u8,
    public_key: [u8; 32],
    nonce: [u8; 32],
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PairDecision {
    kind: String,
    version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proof: Option<[u8; 32]>,
}
impl PairDecision {
    fn confirm(proof: [u8; 32]) -> Self {
        Self {
            kind: "pair_confirm".into(),
            version: VERSION,
            proof: Some(proof),
        }
    }
    fn reject() -> Self {
        Self {
            kind: "pair_reject".into(),
            version: VERSION,
            proof: None,
        }
    }
}
fn kind_of(frame: &[u8]) -> Result<String> {
    Ok(serde_json::from_slice::<Envelope>(frame)?.kind)
}
fn parse<T: for<'a> Deserialize<'a>>(frame: &[u8], kind: &str) -> Result<T> {
    if kind_of(frame)? != kind {
        bail!("Unexpected {kind} frame");
    }
    Ok(serde_json::from_slice(frame)?)
}

fn mac(claim: &Claim, secret: &[u8; 32]) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts 32 byte keys");
    mac.update(b"multipass-attachment\0");
    mac.update(&[claim.version]);
    mac.update(claim.sender.as_bytes());
    mac.update(claim.receiver.as_bytes());
    mac.update(&[claim.slot]);
    mac.update(&claim.nonce);
    mac
}
fn sign(sender: Uuid, slot: u8, challenge: &Challenge, secret: &[u8; 32]) -> Claim {
    let mut claim = Claim {
        kind: "claim".into(),
        version: VERSION,
        sender,
        receiver: challenge.receiver,
        slot,
        nonce: challenge.nonce,
        signature: [0; 32],
    };
    claim.signature = mac(&claim, secret).finalize().into_bytes().into();
    claim
}
struct Verifier {
    challenge: Challenge,
    consumed: bool,
}
impl Verifier {
    fn verify(&mut self, frame: &[u8], secret: &[u8; 32]) -> Result<Claim> {
        if self.consumed {
            bail!("Challenge already consumed");
        }
        self.consumed = true;
        if frame.is_empty() || frame.len() > FRAME_MAX {
            bail!("Invalid frame length");
        }
        let claim: Claim = serde_json::from_slice(frame)?;
        if claim.kind != "claim"
            || claim.version != VERSION
            || claim.receiver != self.challenge.receiver
            || claim.nonce != self.challenge.nonce
            || claim.sender == claim.receiver
            || !(1..=3).contains(&claim.slot)
        {
            bail!("Invalid claim");
        }
        mac(&claim, secret)
            .verify_slice(&claim.signature)
            .map_err(|_| anyhow::anyhow!("Authentication failed"))?;
        Ok(claim)
    }
}
async fn write_frame(stream: &mut TcpStream, data: &[u8]) -> Result<()> {
    if data.is_empty() || data.len() > FRAME_MAX {
        bail!("Invalid frame length");
    }
    stream.write_u32(data.len() as u32).await?;
    stream.write_all(data).await?;
    Ok(())
}
async fn write_json<T: Serialize>(stream: &mut TcpStream, value: &T) -> Result<()> {
    write_frame(stream, &serde_json::to_vec(value)?).await
}
async fn read_frame(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let length = stream.read_u32().await? as usize;
    if length == 0 || length > FRAME_MAX {
        bail!("Invalid frame length");
    }
    let mut frame = vec![0; length];
    stream.read_exact(&mut frame).await?;
    Ok(frame)
}

// ---------------------------------------------------------------------------
// Listener side.
async fn handle_connection(mut stream: TcpStream, context: Context) -> Result<()> {
    let mut nonce = [0; 32];
    rand::rngs::OsRng.try_fill_bytes(&mut nonce)?;
    let challenge = Challenge {
        version: VERSION,
        receiver: context.id,
        nonce,
    };
    let first = timeout(Duration::from_secs(3), async {
        write_json(&mut stream, &challenge).await?;
        read_frame(&mut stream).await
    })
    .await
    .context("Peer did not answer")??;
    match kind_of(&first)?.as_str() {
        "claim" => {
            timeout(
                CLAIM_WINDOW + Duration::from_secs(1),
                receive_claim(stream, first, challenge, context),
            )
            .await?
        }
        "pair_offer" => respond_pairing(stream, first, context).await,
        _ => bail!("Unknown frame"),
    }
}
async fn receive_claim(
    mut stream: TcpStream,
    frame: Vec<u8>,
    challenge: Challenge,
    context: Context,
) -> Result<()> {
    let mut verifier = Verifier {
        challenge,
        consumed: false,
    };
    let claim = {
        let guard = context
            .secret
            .lock()
            .map_err(|_| anyhow::anyhow!("Secret unavailable"))?;
        let Some(secret) = guard.as_ref() else {
            bail!("Not paired");
        };
        verifier.verify(&frame, secret)?
    };
    let lease = Lease::new(context.stopped.clone());
    let _revoke = Revoke(lease.clone());
    if !lease.is_valid() {
        return Ok(());
    }
    context.emit(NetworkEvent::Claim {
        sender: claim.sender,
        slot: claim.slot,
        lease,
    });
    let mut extra = [0; 1];
    // EOF, any extra byte, errors and timeout all revoke via the RAII guard.
    let _ = timeout(CLAIM_WINDOW, stream.read(&mut extra)).await;
    Ok(())
}
async fn send_claim(
    peer: Peer,
    slot: u8,
    current: Arc<AtomicBool>,
    context: Context,
) -> Result<()> {
    let session = async {
        // Resolve the advertised addresses within this bounded session; no retry queue.
        let mut stream = connect_any(&peer.addresses).await?;
        let challenge: Challenge = serde_json::from_slice(&read_frame(&mut stream).await?)?;
        if challenge.version != VERSION
            || challenge.receiver != peer.id
            || peer.id == context.id
            || !current.load(Ordering::Acquire)
        {
            bail!("Invalid challenge or stale attachment");
        }
        let claim = {
            let guard = context
                .secret
                .lock()
                .map_err(|_| anyhow::anyhow!("Secret unavailable"))?;
            let Some(secret) = guard.as_ref() else {
                bail!("Not paired");
            };
            sign(context.id, slot, &challenge, secret)
        };
        write_json(&mut stream, &claim).await?;
        let mut extra = [0; 1];
        let _ = stream.read(&mut extra).await;
        Ok(())
    };
    tokio::select! {
        result = session => result,
        _ = async { loop { if !current.load(Ordering::Acquire) || context.stopped.load(Ordering::Acquire) { break; } sleep(Duration::from_millis(50)).await; } } => Ok(())
    }
}

// ---------------------------------------------------------------------------
// Pairing. The initiator commits to its ephemeral key before the responder
// reveals its own, so a man in the middle cannot search for a public key that
// makes both screens show the same code. Both people compare the six digits.
struct SlotGuard(PairingSlot);
impl Drop for SlotGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = None;
        }
    }
}
fn claim_slot(context: &Context) -> Option<(SlotGuard, watch::Receiver<Option<bool>>)> {
    let mut slot = context.pairing.lock().ok()?;
    if slot.is_some() {
        return None;
    }
    let (sender, receiver) = watch::channel(None);
    *slot = Some(sender);
    Some((SlotGuard(context.pairing.clone()), receiver))
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Initiator,
    Responder,
}
struct PairingKeys {
    secret: Zeroizing<[u8; 32]>,
    code: u32,
    initiator_proof: [u8; 32],
    responder_proof: [u8; 32],
}
impl PairingKeys {
    fn derive(
        shared: &[u8; 32],
        initiator_key: &[u8; 32],
        responder_key: &[u8; 32],
        initiator_nonce: &[u8; 32],
        responder_nonce: &[u8; 32],
    ) -> Self {
        let mut extract = Hmac::<Sha256>::new_from_slice(b"multipass-pair-v3").expect("key");
        extract.update(shared);
        extract.update(initiator_key);
        extract.update(responder_key);
        extract.update(initiator_nonce);
        extract.update(responder_nonce);
        let root: Zeroizing<[u8; 32]> = Zeroizing::new(extract.finalize().into_bytes().into());
        let expand = |label: &[u8]| -> [u8; 32] {
            let mut mac = Hmac::<Sha256>::new_from_slice(root.as_ref()).expect("key");
            mac.update(label);
            mac.finalize().into_bytes().into()
        };
        let sas = expand(b"short-authentication-string");
        Self {
            secret: Zeroizing::new(expand(b"pairing-secret")),
            code: u32::from_be_bytes([sas[0], sas[1], sas[2], sas[3]]) % 1_000_000,
            initiator_proof: expand(b"confirm-initiator"),
            responder_proof: expand(b"confirm-responder"),
        }
    }
    fn code(&self) -> String {
        format!("{:06}", self.code)
    }
    fn proof(&self, role: Role) -> [u8; 32] {
        match role {
            Role::Initiator => self.initiator_proof,
            Role::Responder => self.responder_proof,
        }
    }
}
fn commitment(public_key: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"multipass-pair-commit\0");
    hash.update(public_key);
    hash.update(nonce);
    hash.finalize().into()
}
fn ephemeral() -> Result<(StaticSecret, PublicKey, [u8; 32])> {
    let mut key = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.try_fill_bytes(key.as_mut())?;
    let secret = StaticSecret::from(*key);
    let public = PublicKey::from(&secret);
    let mut nonce = [0; 32];
    rand::rngs::OsRng.try_fill_bytes(&mut nonce)?;
    Ok((secret, public, nonce))
}
fn agree(secret: &StaticSecret, peer: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>> {
    let shared = secret.diffie_hellman(&PublicKey::from(*peer));
    if !shared.was_contributory() {
        bail!("Pairing verification failed");
    }
    Ok(Zeroizing::new(*shared.as_bytes()))
}

async fn initiate_pairing(peer: Peer, context: Context) {
    let Some((_guard, decision)) = claim_slot(&context) else {
        context.pairing_failed("Finish the pairing already in progress first");
        return;
    };
    context.emit(NetworkEvent::Pairing(PairingEvent::Started {
        peer_name: peer.name.clone(),
    }));
    let peer_name = peer.name.clone();
    let result = async {
        let exchange = async {
            let mut stream = connect_any(&peer.addresses)
                .await
                .context("Cannot connect to that computer")?;
            let challenge: Challenge = serde_json::from_slice(&read_frame(&mut stream).await?)?;
            if challenge.version != VERSION
                || challenge.receiver != peer.id
                || peer.id == context.id
            {
                bail!("That computer runs an incompatible Multipass version");
            }
            let (secret, public, nonce) = ephemeral()?;
            write_json(
                &mut stream,
                &PairOffer {
                    kind: "pair_offer".into(),
                    version: VERSION,
                    sender: context.id,
                    receiver: peer.id,
                    name: context.name.clone(),
                    commitment: commitment(public.as_bytes(), &nonce),
                },
            )
            .await?;
            let frame = read_frame(&mut stream).await?;
            if kind_of(&frame)? == "pair_reject" {
                bail!("{peer_name} is busy with another pairing; try again");
            }
            let accept: PairAccept = parse(&frame, "pair_accept")?;
            if accept.version != VERSION {
                bail!("That computer runs an incompatible Multipass version");
            }
            write_json(
                &mut stream,
                &PairReveal {
                    kind: "pair_reveal".into(),
                    version: VERSION,
                    public_key: public.to_bytes(),
                    nonce,
                },
            )
            .await?;
            let shared = agree(&secret, &accept.public_key)?;
            let keys = PairingKeys::derive(
                &shared,
                public.as_bytes(),
                &accept.public_key,
                &nonce,
                &accept.nonce,
            );
            Ok::<_, anyhow::Error>((stream, keys))
        };
        let (stream, keys) = timeout(EXCHANGE_TIMEOUT, exchange)
            .await
            .context("That computer did not respond in time")??;
        context.emit(NetworkEvent::Pairing(PairingEvent::Code {
            peer_name: peer_name.clone(),
            code: keys.code(),
            incoming: false,
        }));
        timeout(
            DECISION_TIMEOUT,
            finish_pairing(
                stream,
                keys,
                Role::Initiator,
                decision,
                &peer_name,
                &context,
            ),
        )
        .await
        .context("Pairing timed out; try again")?
    }
    .await;
    if let Err(error) = result {
        context.pairing_failed(error.to_string());
    }
}

async fn respond_pairing(mut stream: TcpStream, frame: Vec<u8>, context: Context) -> Result<()> {
    let offer: PairOffer = parse(&frame, "pair_offer")?;
    if offer.version != VERSION || offer.receiver != context.id || offer.sender == context.id {
        bail!("Invalid pairing offer");
    }
    let peer_name = sanitize_name(&offer.name);
    let Some((_guard, decision)) = claim_slot(&context) else {
        // Busy: never interrupt the pairing already on screen. Not reported locally.
        let _ = write_json(&mut stream, &PairDecision::reject()).await;
        return Ok(());
    };
    let result = async {
        let exchange = async {
            let (secret, public, nonce) = ephemeral()?;
            write_json(
                &mut stream,
                &PairAccept {
                    kind: "pair_accept".into(),
                    version: VERSION,
                    name: context.name.clone(),
                    public_key: public.to_bytes(),
                    nonce,
                },
            )
            .await?;
            let reveal: PairReveal = parse(&read_frame(&mut stream).await?, "pair_reveal")?;
            let expected = commitment(&reveal.public_key, &reveal.nonce);
            if reveal.version != VERSION || !bool::from(expected.ct_eq(&offer.commitment)) {
                bail!("Pairing verification failed");
            }
            let shared = agree(&secret, &reveal.public_key)?;
            Ok::<_, anyhow::Error>(PairingKeys::derive(
                &shared,
                &reveal.public_key,
                public.as_bytes(),
                &reveal.nonce,
                &nonce,
            ))
        };
        let keys = timeout(EXCHANGE_TIMEOUT, exchange)
            .await
            .context("That computer did not respond in time")??;
        context.emit(NetworkEvent::Pairing(PairingEvent::Code {
            peer_name: peer_name.clone(),
            code: keys.code(),
            incoming: true,
        }));
        timeout(
            DECISION_TIMEOUT,
            finish_pairing(
                stream,
                keys,
                Role::Responder,
                decision,
                &peer_name,
                &context,
            ),
        )
        .await
        .context("Pairing timed out; try again")?
    }
    .await;
    if let Err(error) = &result {
        context.pairing_failed(error.to_string());
    }
    result
}

/// Wait for this person's decision while watching for the peer's. Both must
/// confirm with a proof derived from the agreed key before the secret is used.
async fn finish_pairing(
    mut stream: TcpStream,
    keys: PairingKeys,
    role: Role,
    mut decision: watch::Receiver<Option<bool>>,
    peer_name: &str,
    context: &Context,
) -> Result<()> {
    let peer_role = match role {
        Role::Initiator => Role::Responder,
        Role::Responder => Role::Initiator,
    };
    let expected = keys.proof(peer_role);
    let check = |frame: Vec<u8>| -> Result<()> {
        let received: PairDecision = serde_json::from_slice(&frame)?;
        match received.kind.as_str() {
            "pair_confirm"
                if received.version == VERSION
                    && received
                        .proof
                        .is_some_and(|proof| bool::from(proof.ct_eq(&expected))) =>
            {
                Ok(())
            }
            "pair_confirm" => bail!("Pairing verification failed"),
            "pair_reject" => bail!("{peer_name} declined the pairing"),
            _ => bail!("Unexpected pairing frame"),
        }
    };
    let mut peer_confirmed = false;
    loop {
        tokio::select! {
            changed = decision.changed() => {
                changed.map_err(|_| anyhow::anyhow!("Pairing cancelled"))?;
                let value = *decision.borrow_and_update();
                match value {
                    Some(true) => { write_json(&mut stream, &PairDecision::confirm(keys.proof(role))).await?; break; }
                    Some(false) => { let _ = write_json(&mut stream, &PairDecision::reject()).await; bail!("Pairing cancelled"); }
                    None => {}
                }
            }
            frame = read_frame(&mut stream), if !peer_confirmed => {
                check(frame.context("Connection to that computer was lost")?)?;
                peer_confirmed = true;
            }
        }
    }
    if !peer_confirmed {
        check(
            read_frame(&mut stream)
                .await
                .context("Connection to that computer was lost")?,
        )?;
    }
    context.emit(NetworkEvent::Pairing(PairingEvent::Completed {
        peer_name: peer_name.to_owned(),
        secret: keys.secret,
    }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn peer_addresses_prefer_ipv4_and_drop_unusable() {
        let scoped: Vec<ScopedIp> = [
            "fe80::1".parse::<IpAddr>().unwrap(),
            "192.168.1.9".parse().unwrap(),
            "0.0.0.0".parse().unwrap(),
            "224.0.0.251".parse().unwrap(),
            "ff02::fb".parse().unwrap(),
            "::".parse().unwrap(),
            "fd07::5".parse().unwrap(),
            "10.0.0.2".parse().unwrap(),
        ]
        .into_iter()
        .map(ScopedIp::from)
        .collect();
        let addresses = peer_addresses(scoped.iter(), 4321);
        let ips: Vec<IpAddr> = addresses.iter().map(SocketAddr::ip).collect();
        assert_eq!(
            ips,
            vec![
                "10.0.0.2".parse::<IpAddr>().unwrap(),
                "192.168.1.9".parse().unwrap(),
                "fd07::5".parse().unwrap(),
                "fe80::1".parse().unwrap(),
            ]
        );
        assert!(addresses.iter().all(|address| address.port() == 4321));
    }
    #[tokio::test]
    async fn dual_stack_listener_accepts_ipv4_and_ipv6() {
        let listener = bind_dual_stack().unwrap();
        let port = listener.local_addr().unwrap().port();
        let accept = tokio::spawn(async move {
            let mut count = 0;
            while count < 2 {
                let (_stream, from) = listener.accept().await.unwrap();
                assert!(from.ip().is_loopback() || from.ip().to_canonical().is_loopback());
                count += 1;
            }
        });
        TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        TcpStream::connect(("::1", port)).await.unwrap();
        timeout(Duration::from_secs(5), accept)
            .await
            .unwrap()
            .unwrap();
    }
    fn fixture() -> (Verifier, Claim) {
        let challenge = Challenge {
            version: VERSION,
            receiver: Uuid::new_v4(),
            nonce: [17; 32],
        };
        let claim = sign(Uuid::new_v4(), 2, &challenge, &[42; 32]);
        (
            Verifier {
                challenge,
                consumed: false,
            },
            claim,
        )
    }
    #[test]
    fn authenticated_claim_is_one_shot() {
        let (mut verifier, claim) = fixture();
        let data = serde_json::to_vec(&claim).unwrap();
        assert_eq!(verifier.verify(&data, &[42; 32]).unwrap().slot, 2);
        assert!(verifier.verify(&data, &[42; 32]).is_err());
    }
    #[test]
    fn malformed_attempt_consumes_challenge() {
        let (mut verifier, claim) = fixture();
        assert!(verifier.verify(b"{}", &[42; 32]).is_err());
        assert!(verifier
            .verify(&serde_json::to_vec(&claim).unwrap(), &[42; 32])
            .is_err());
    }
    #[test]
    fn tampering_wrong_key_replay_and_self_claim_fail() {
        for variant in 0..8 {
            let (mut verifier, mut claim) = fixture();
            match variant {
                0 => claim.slot = 3,
                1 => claim.sender = Uuid::new_v4(),
                2 => claim.receiver = Uuid::new_v4(),
                3 => claim.nonce[0] ^= 1,
                4 => claim.version = 2,
                5 => claim.sender = claim.receiver,
                7 => claim.kind = "pair_offer".into(),
                _ => {}
            }
            let key = if variant == 6 { [13; 32] } else { [42; 32] };
            assert!(verifier
                .verify(&serde_json::to_vec(&claim).unwrap(), &key)
                .is_err());
        }
        let (mut verifier, _) = fixture();
        let (_, other_claim) = fixture();
        assert!(verifier
            .verify(&serde_json::to_vec(&other_claim).unwrap(), &[42; 32])
            .is_err());
    }
    #[test]
    fn lease_checks_monotonic_deadline_and_shutdown() {
        let stopped = Arc::new(AtomicBool::new(false));
        let mut lease = Lease::new(stopped.clone());
        assert!(lease.is_valid());
        lease.deadline = Instant::now();
        assert!(!lease.is_valid());
        let lease = Lease::new(stopped.clone());
        stopped.store(true, Ordering::Release);
        assert!(!lease.is_valid());
        let lease = Lease::new(Arc::new(AtomicBool::new(false)));
        drop(Revoke(lease.clone()));
        assert!(!lease.is_valid());
    }
    #[test]
    fn names_are_bounded_and_printable() {
        assert_eq!(sanitize_name("  \u{7}Studio\n "), "Studio");
        assert_eq!(sanitize_name("\t"), "Unnamed computer");
        assert_eq!(sanitize_name(&"x".repeat(200)).len(), NAME_LIMIT);
    }
    fn context(
        id: Uuid,
        secret: Option<[u8; 32]>,
    ) -> (Context, mpsc::UnboundedReceiver<NetworkEvent>) {
        let (events, rx) = mpsc::unbounded_channel();
        (
            Context {
                id,
                name: format!("Computer {}", &id.to_string()[..4]),
                events,
                secret: Arc::new(Mutex::new(secret.map(Zeroizing::new))),
                pairing: Arc::new(Mutex::new(None)),
                stopped: Arc::new(AtomicBool::new(false)),
            },
            rx,
        )
    }
    #[tokio::test]
    async fn loopback_claim_revoked_when_keyboard_leaves() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (receiver, mut events) = context(Uuid::new_v4(), Some([42; 32]));
        let (sender, _) = context(Uuid::new_v4(), Some([42; 32]));
        let peer = Peer {
            id: receiver.id,
            name: receiver.name.clone(),
            addresses: vec![listener.local_addr().unwrap()],
        };
        let receiving = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_connection(stream, receiver).await.unwrap();
        });
        let current = Arc::new(AtomicBool::new(true));
        let current_copy = current.clone();
        let sending = tokio::spawn(async move {
            send_claim(peer, 2, current_copy, sender).await.unwrap();
        });
        let lease = match timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap()
        {
            NetworkEvent::Claim { slot: 2, lease, .. } => lease,
            _ => panic!("Expected claim"),
        };
        assert!(lease.is_valid());
        current.store(false, Ordering::Release);
        timeout(Duration::from_secs(1), sending)
            .await
            .unwrap()
            .unwrap();
        timeout(Duration::from_secs(2), receiving)
            .await
            .unwrap()
            .unwrap();
        assert!(!lease.is_valid());
    }
    #[tokio::test]
    async fn unpaired_listener_rejects_claims_without_leaking_a_lease() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (receiver, mut events) = context(Uuid::new_v4(), None);
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_connection(stream, receiver).await
        });
        let mut stream = TcpStream::connect(address).await.unwrap();
        let challenge: Challenge =
            serde_json::from_slice(&read_frame(&mut stream).await.unwrap()).unwrap();
        let claim = sign(Uuid::new_v4(), 1, &challenge, &[42; 32]);
        write_json(&mut stream, &claim).await.unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(events.try_recv().is_err());
    }
    #[tokio::test]
    async fn receiver_abort_revokes_delivered_lease() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (receiver, mut events) = context(Uuid::new_v4(), Some([42; 32]));
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_connection(stream, receiver).await.unwrap();
        });
        let mut stream = TcpStream::connect(address).await.unwrap();
        let challenge: Challenge =
            serde_json::from_slice(&read_frame(&mut stream).await.unwrap()).unwrap();
        let claim = sign(Uuid::new_v4(), 1, &challenge, &[42; 32]);
        write_json(&mut stream, &claim).await.unwrap();
        let lease = match events.recv().await.unwrap() {
            NetworkEvent::Claim { lease, .. } => lease,
            _ => panic!(),
        };
        assert!(lease.is_valid());
        task.abort();
        let _ = task.await;
        assert!(!lease.is_valid());
    }
    #[tokio::test]
    async fn oversized_and_zero_frames_fail_without_body() {
        for length in [0, 4097, u32::MAX] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let sending = tokio::spawn(async move {
                let mut stream = TcpStream::connect(address).await.unwrap();
                stream.write_u32(length).await.unwrap();
            });
            let (mut stream, _) = listener.accept().await.unwrap();
            assert!(timeout(Duration::from_secs(1), read_frame(&mut stream))
                .await
                .unwrap()
                .is_err());
            sending.await.unwrap();
        }
    }
    #[tokio::test]
    async fn lease_expires_while_sender_remains_connected() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (receiver, mut events) = context(Uuid::new_v4(), Some([42; 32]));
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_connection(stream, receiver).await.unwrap();
        });
        let mut stream = TcpStream::connect(address).await.unwrap();
        let challenge: Challenge =
            serde_json::from_slice(&read_frame(&mut stream).await.unwrap()).unwrap();
        let claim = sign(Uuid::new_v4(), 3, &challenge, &[42; 32]);
        write_json(&mut stream, &claim).await.unwrap();
        let lease = match events.recv().await.unwrap() {
            NetworkEvent::Claim { lease, .. } => lease,
            _ => panic!(),
        };
        assert!(lease.is_valid());
        timeout(CLAIM_WINDOW + Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert!(!lease.is_valid());
    }

    // -- pairing -----------------------------------------------------------
    async fn next_pairing(events: &mut mpsc::UnboundedReceiver<NetworkEvent>) -> PairingEvent {
        loop {
            match timeout(Duration::from_secs(3), events.recv())
                .await
                .unwrap()
            {
                Some(NetworkEvent::Pairing(event)) => return event,
                Some(_) => continue,
                None => panic!("events closed"),
            }
        }
    }
    fn decide(context: &Context, accept: bool) {
        let slot = context.pairing.lock().unwrap();
        slot.as_ref().unwrap().send(Some(accept)).unwrap();
    }
    /// Run one pairing over loopback. Returns (initiator events, responder events, contexts).
    async fn pair_over_loopback(
        accept_initiator: bool,
        accept_responder: bool,
    ) -> (
        Vec<PairingEvent>,
        Vec<PairingEvent>,
        Option<[u8; 32]>,
        Option<[u8; 32]>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (responder, mut responder_events) = context(Uuid::new_v4(), None);
        let (initiator, mut initiator_events) = context(Uuid::new_v4(), None);
        let peer = Peer {
            id: responder.id,
            name: responder.name.clone(),
            addresses: vec![listener.local_addr().unwrap()],
        };
        let responder_copy = responder.clone();
        let responding = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let _ = handle_connection(stream, responder_copy).await;
        });
        let initiator_copy = initiator.clone();
        let initiating = tokio::spawn(async move { initiate_pairing(peer, initiator_copy).await });
        let mut initiator_log = vec![next_pairing(&mut initiator_events).await];
        assert!(matches!(initiator_log[0], PairingEvent::Started { .. }));
        let initiator_code = match next_pairing(&mut initiator_events).await {
            PairingEvent::Code { code, incoming, .. } => {
                assert!(!incoming);
                code
            }
            other => panic!("{other:?}"),
        };
        let responder_code = match next_pairing(&mut responder_events).await {
            PairingEvent::Code { code, incoming, .. } => {
                assert!(incoming);
                code
            }
            other => panic!("{other:?}"),
        };
        assert_eq!(initiator_code, responder_code);
        assert_eq!(initiator_code.len(), 6);
        decide(&initiator, accept_initiator);
        decide(&responder, accept_responder);
        let initiator_final = next_pairing(&mut initiator_events).await;
        let responder_final = next_pairing(&mut responder_events).await;
        timeout(Duration::from_secs(3), initiating)
            .await
            .unwrap()
            .unwrap();
        timeout(Duration::from_secs(3), responding)
            .await
            .unwrap()
            .unwrap();
        let secret = |event: &PairingEvent| match event {
            PairingEvent::Completed { secret, .. } => Some(**secret),
            _ => None,
        };
        let (a, b) = (secret(&initiator_final), secret(&responder_final));
        initiator_log.push(initiator_final);
        assert!(initiator.pairing.lock().unwrap().is_none());
        assert!(responder.pairing.lock().unwrap().is_none());
        (initiator_log, vec![responder_final], a, b)
    }
    #[tokio::test]
    async fn both_confirmations_install_the_same_secret() {
        let (_, _, a, b) = pair_over_loopback(true, true).await;
        assert!(a.is_some());
        assert_eq!(a, b);
    }
    #[tokio::test]
    async fn either_decline_aborts_without_a_secret() {
        for (initiator, responder) in [(false, true), (true, false)] {
            let (initiator_log, responder_log, a, b) =
                pair_over_loopback(initiator, responder).await;
            assert!(a.is_none() && b.is_none());
            assert!(matches!(
                initiator_log.last(),
                Some(PairingEvent::Failed { .. })
            ));
            assert!(matches!(
                responder_log.last(),
                Some(PairingEvent::Failed { .. })
            ));
        }
    }
    #[tokio::test]
    async fn tampered_reveal_fails_verification() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (responder, mut responder_events) = context(Uuid::new_v4(), None);
        let address = listener.local_addr().unwrap();
        let responder_copy = responder.clone();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_connection(stream, responder_copy).await
        });
        let mut stream = TcpStream::connect(address).await.unwrap();
        let challenge: Challenge =
            serde_json::from_slice(&read_frame(&mut stream).await.unwrap()).unwrap();
        let (_, public, nonce) = ephemeral().unwrap();
        write_json(
            &mut stream,
            &PairOffer {
                kind: "pair_offer".into(),
                version: VERSION,
                sender: Uuid::new_v4(),
                receiver: challenge.receiver,
                name: "Attacker".into(),
                commitment: commitment(public.as_bytes(), &nonce),
            },
        )
        .await
        .unwrap();
        let _: PairAccept = parse(&read_frame(&mut stream).await.unwrap(), "pair_accept").unwrap();
        // Substitute a different key after committing: the responder must refuse.
        let (_, other, _) = ephemeral().unwrap();
        write_json(
            &mut stream,
            &PairReveal {
                kind: "pair_reveal".into(),
                version: VERSION,
                public_key: other.to_bytes(),
                nonce,
            },
        )
        .await
        .unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(matches!(
            next_pairing(&mut responder_events).await,
            PairingEvent::Failed { .. }
        ));
        assert!(responder.pairing.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn second_offer_is_rejected_while_one_is_pending() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (responder, _events) = context(Uuid::new_v4(), None);
        let address = listener.local_addr().unwrap();
        let (_guard, _rx) = claim_slot(&responder).unwrap();
        let responder_copy = responder.clone();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_connection(stream, responder_copy).await
        });
        let mut stream = TcpStream::connect(address).await.unwrap();
        let challenge: Challenge =
            serde_json::from_slice(&read_frame(&mut stream).await.unwrap()).unwrap();
        write_json(
            &mut stream,
            &PairOffer {
                kind: "pair_offer".into(),
                version: VERSION,
                sender: Uuid::new_v4(),
                receiver: challenge.receiver,
                name: "Second".into(),
                commitment: [0; 32],
            },
        )
        .await
        .unwrap();
        assert_eq!(
            kind_of(&read_frame(&mut stream).await.unwrap()).unwrap(),
            "pair_reject"
        );
        task.await.unwrap().unwrap();
    }
    #[test]
    fn derived_material_binds_every_input() {
        let base = PairingKeys::derive(&[1; 32], &[2; 32], &[3; 32], &[4; 32], &[5; 32]);
        let variants = [
            PairingKeys::derive(&[9; 32], &[2; 32], &[3; 32], &[4; 32], &[5; 32]),
            PairingKeys::derive(&[1; 32], &[9; 32], &[3; 32], &[4; 32], &[5; 32]),
            PairingKeys::derive(&[1; 32], &[2; 32], &[9; 32], &[4; 32], &[5; 32]),
            PairingKeys::derive(&[1; 32], &[2; 32], &[3; 32], &[9; 32], &[5; 32]),
            PairingKeys::derive(&[1; 32], &[2; 32], &[3; 32], &[4; 32], &[9; 32]),
        ];
        for variant in variants {
            assert_ne!(*variant.secret, *base.secret);
        }
        assert_ne!(base.initiator_proof, base.responder_proof);
        assert_ne!(*base.secret, base.initiator_proof);
        assert!(base.code < 1_000_000);
        assert_eq!(base.code().len(), 6);
    }

    #[tokio::test]
    #[ignore = "Requires multicast-enabled LAN; run explicitly for host qualification"]
    async fn mdns_discovery_and_authenticated_handoff() {
        let first_id = Uuid::new_v4();
        let (mut first, mut first_events) =
            Network::start(first_id, "Network test first".into(), Some([91; 32]))
                .await
                .unwrap();
        let (mut second, mut second_events) =
            Network::start(Uuid::new_v4(), "Network test second".into(), Some([91; 32]))
                .await
                .unwrap();
        // Other Multipass instances on the LAN are discovered too; wait for ours.
        timeout(Duration::from_secs(15), async {
            loop {
                if matches!(second_events.recv().await, Some(NetworkEvent::Peers(peers)) if peers.iter().any(|peer| peer.id == first_id)) {
                    break;
                }
            }
        })
        .await
        .expect("mDNS discovery did not resolve peer");
        let current = Arc::new(AtomicBool::new(true));
        second.announce(2, current).await;
        let lease = timeout(Duration::from_secs(4), async {
            loop {
                if let Some(NetworkEvent::Claim { slot: 2, lease, .. }) = first_events.recv().await
                {
                    break lease;
                }
            }
        })
        .await
        .expect("No authenticated claim received");
        assert!(lease.is_valid());
        first.stop().await;
        second.stop().await;
        assert!(!lease.is_valid());
    }
}
