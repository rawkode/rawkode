//! Cross-platform LAN transport. Protocol v2 is intentionally incompatible with
//! the original Swift v1 protocol. Claims and discovery metadata are unencrypted;
//! pairing keys never leave the process. Discovery is not authentication.
use anyhow::{bail, Result};
use hmac::{Hmac, Mac};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch},
    task::{JoinHandle, JoinSet},
    time::{sleep, timeout},
};
use uuid::Uuid;
use zeroize::Zeroizing;

const SERVICE: &str = "_multipass._tcp.local.";
const VERSION: u8 = 2;
const FRAME_MAX: usize = 4096;
const SESSION_LIMIT: usize = 64;
const FANOUT_LIMIT: usize = 32;

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
            deadline: Instant::now() + Duration::from_secs(1),
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

#[derive(Debug)]
pub enum NetworkEvent {
    Status(String),
    Peers(usize),
    Claim {
        sender: Uuid,
        slot: u8,
        lease: Lease,
    },
}
struct Announcement {
    slot: u8,
    current: Arc<AtomicBool>,
}
#[derive(Clone)]
struct Peer {
    id: Uuid,
    addresses: Vec<SocketAddr>,
}
#[derive(Clone)]
struct Context {
    id: Uuid,
    secret: Arc<Zeroizing<[u8; 32]>>,
    stopped: Arc<AtomicBool>,
    events: mpsc::UnboundedSender<NetworkEvent>,
}

pub struct Network {
    commands: mpsc::Sender<Announcement>,
    shutdown: watch::Sender<bool>,
    stopped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    daemon: ServiceDaemon,
}
impl Network {
    pub async fn start(
        node_id: Uuid,
        name: String,
        secret: [u8; 32],
    ) -> Result<(Self, mpsc::UnboundedReceiver<NetworkEvent>)> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 0)).await?;
        let port = listener.local_addr()?.port();
        let daemon = ServiceDaemon::new()?;
        // Shut down the daemon on any fallible setup path too.
        let setup = (|| -> Result<_> {
            let browse = daemon.browse(SERVICE)?;
            let instance = node_id.to_string();
            let hostname = format!("multipass-{node_id}.local.");
            let properties = [("version", "2"), ("name", name.as_str())];
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
        let context = Context {
            id: node_id,
            secret: Arc::new(Zeroizing::new(secret)),
            stopped: stopped.clone(),
            events,
        };
        let (commands, mut requests) = mpsc::channel::<Announcement>(8);
        let (shutdown, mut cancellation) = watch::channel(false);
        let worker = tokio::spawn(async move {
            let mut peers = HashMap::<String, Peer>::new();
            let mut sessions = JoinSet::new();
            let _ = context.events.send(NetworkEvent::Status(
                "Listening for paired computers on the local network.".into(),
            ));
            loop {
                tokio::select! {
                    biased;
                    _ = cancellation.changed() => break,
                    Some(_) = sessions.join_next(), if !sessions.is_empty() => {},
                    connection = listener.accept() => match connection {
                        Ok((stream, _)) if sessions.len() < SESSION_LIMIT => {
                            let context = context.clone();
                            sessions.spawn(async move { let _ = timeout(Duration::from_secs(3), receive_claim(stream, context)).await; });
                        },
                        Ok(_) => {},
                        Err(error) => { let _ = context.events.send(NetworkEvent::Status(format!("Listener failed: {error}"))); break; }
                    },
                    Some(request) = requests.recv() => {
                        if request.current.load(Ordering::Acquire) {
                            for peer in peers.values().take(FANOUT_LIMIT) {
                                if sessions.len() >= SESSION_LIMIT { break; }
                                let peer = peer.clone(); let context = context.clone(); let current = request.current.clone();
                                sessions.spawn(async move { let events = context.events.clone(); match timeout(Duration::from_secs(3), send_claim(peer, request.slot, current, context)).await { Ok(Ok(())) => {}, Ok(Err(error)) => { let _ = events.send(NetworkEvent::Status(format!("Peer request failed: {error}"))); }, Err(_) => { let _ = events.send(NetworkEvent::Status("Peer request timed out.".into())); } } });
                            }
                        }
                    },
                    event = browse.recv_async() => match event {
                        Ok(ServiceEvent::ServiceResolved(info)) => {
                            if info.get_property_val_str("version") != Some("2") { continue; }
                            let instance = info.get_fullname().strip_suffix(SERVICE).unwrap_or("").trim_end_matches('.');
                            if let Ok(id) = Uuid::parse_str(instance) {
                                if id != context.id && (peers.len() < 256 || peers.contains_key(info.get_fullname())) {
                                    // This listener is IPv4; omit IPv6 instead of advertising broken scoped endpoints.
                                    let addresses: Vec<_> = info.get_addresses().iter().filter_map(|ip| match ip { IpAddr::V4(ip) if !ip.is_unspecified() && !ip.is_multicast() => Some(SocketAddr::new(IpAddr::V4(*ip), info.get_port())), _ => None }).take(8).collect();
                                    if !addresses.is_empty() { peers.insert(info.get_fullname().into(), Peer { id, addresses }); }
                                }
                            }
                            let _ = context.events.send(NetworkEvent::Peers(peers.len()));
                        },
                        Ok(ServiceEvent::ServiceRemoved(_, fullname)) => { peers.remove(&fullname); let _ = context.events.send(NetworkEvent::Peers(peers.len())); },
                        Ok(_) => {},
                        Err(_) => { let _ = context.events.send(NetworkEvent::Status("Discovery stopped unexpectedly.".into())); break; }
                    }
                }
            }
            context.stopped.store(true, Ordering::Release);
            sessions.abort_all();
            while sessions.join_next().await.is_some() {}
            let _ = context.events.send(NetworkEvent::Peers(0));
        });
        Ok((
            Self {
                commands,
                shutdown,
                stopped,
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
        {
            // A full queue drops the new request; stale attachment events must never wait offline.
            let _ = self.commands.try_send(Announcement { slot, current });
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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Challenge {
    version: u8,
    receiver: Uuid,
    nonce: [u8; 32],
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claim {
    version: u8,
    sender: Uuid,
    receiver: Uuid,
    slot: u8,
    nonce: [u8; 32],
    signature: [u8; 32],
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
        if claim.version != VERSION
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
async fn read_frame(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let length = stream.read_u32().await? as usize;
    if length == 0 || length > FRAME_MAX {
        bail!("Invalid frame length");
    }
    let mut frame = vec![0; length];
    stream.read_exact(&mut frame).await?;
    Ok(frame)
}
async fn receive_claim(mut stream: TcpStream, context: Context) -> Result<()> {
    let mut nonce = [0; 32];
    rand::rngs::OsRng.try_fill_bytes(&mut nonce)?;
    let challenge = Challenge {
        version: VERSION,
        receiver: context.id,
        nonce,
    };
    write_frame(&mut stream, &serde_json::to_vec(&challenge)?).await?;
    let mut verifier = Verifier {
        challenge,
        consumed: false,
    };
    let claim = verifier.verify(&read_frame(&mut stream).await?, &context.secret)?;
    let lease = Lease::new(context.stopped.clone());
    let _revoke = Revoke(lease.clone());
    if !lease.is_valid() {
        return Ok(());
    }
    let _ = context.events.send(NetworkEvent::Claim {
        sender: claim.sender,
        slot: claim.slot,
        lease,
    });
    let mut extra = [0; 1];
    // EOF, any extra byte, errors and timeout all revoke via the RAII guard.
    let _ = timeout(Duration::from_secs(1), stream.read(&mut extra)).await;
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
        let mut stream = TcpStream::connect(peer.addresses.as_slice()).await?;
        let challenge: Challenge = serde_json::from_slice(&read_frame(&mut stream).await?)?;
        if challenge.version != VERSION
            || challenge.receiver != peer.id
            || peer.id == context.id
            || !current.load(Ordering::Acquire)
        {
            bail!("Invalid challenge or stale attachment");
        }
        let claim = sign(context.id, slot, &challenge, &context.secret);
        write_frame(&mut stream, &serde_json::to_vec(&claim)?).await?;
        let mut extra = [0; 1];
        let _ = stream.read(&mut extra).await;
        Ok(())
    };
    tokio::select! {
        result = session => result,
        _ = async { loop { if !current.load(Ordering::Acquire) || context.stopped.load(Ordering::Acquire) { break; } sleep(Duration::from_millis(50)).await; } } => Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        for variant in 0..7 {
            let (mut verifier, mut claim) = fixture();
            match variant {
                0 => claim.slot = 3,
                1 => claim.sender = Uuid::new_v4(),
                2 => claim.receiver = Uuid::new_v4(),
                3 => claim.nonce[0] ^= 1,
                4 => claim.version = 1,
                5 => claim.sender = claim.receiver,
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
    fn context(id: Uuid) -> (Context, mpsc::UnboundedReceiver<NetworkEvent>) {
        let (events, rx) = mpsc::unbounded_channel();
        (
            Context {
                id,
                events,
                secret: Arc::new(Zeroizing::new([42; 32])),
                stopped: Arc::new(AtomicBool::new(false)),
            },
            rx,
        )
    }
    #[tokio::test]
    async fn loopback_claim_revoked_when_keyboard_leaves() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (receiver, mut events) = context(Uuid::new_v4());
        let (sender, _) = context(Uuid::new_v4());
        let peer = Peer {
            id: receiver.id,
            addresses: vec![listener.local_addr().unwrap()],
        };
        let receiving = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            receive_claim(stream, receiver).await.unwrap();
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
        timeout(Duration::from_secs(1), receiving)
            .await
            .unwrap()
            .unwrap();
        assert!(!lease.is_valid());
    }
    #[tokio::test]
    async fn receiver_abort_revokes_delivered_lease() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (receiver, mut events) = context(Uuid::new_v4());
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            receive_claim(stream, receiver).await.unwrap();
        });
        let mut stream = TcpStream::connect(address).await.unwrap();
        let challenge: Challenge =
            serde_json::from_slice(&read_frame(&mut stream).await.unwrap()).unwrap();
        let claim = sign(Uuid::new_v4(), 1, &challenge, &[42; 32]);
        write_frame(&mut stream, &serde_json::to_vec(&claim).unwrap())
            .await
            .unwrap();
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
        let (receiver, mut events) = context(Uuid::new_v4());
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            receive_claim(stream, receiver).await.unwrap();
        });
        let mut stream = TcpStream::connect(address).await.unwrap();
        let challenge: Challenge =
            serde_json::from_slice(&read_frame(&mut stream).await.unwrap()).unwrap();
        let claim = sign(Uuid::new_v4(), 3, &challenge, &[42; 32]);
        write_frame(&mut stream, &serde_json::to_vec(&claim).unwrap())
            .await
            .unwrap();
        let lease = match events.recv().await.unwrap() {
            NetworkEvent::Claim { lease, .. } => lease,
            _ => panic!(),
        };
        assert!(lease.is_valid());
        timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert!(!lease.is_valid());
    }

    #[tokio::test]
    #[ignore = "Requires multicast-enabled LAN; run explicitly for host qualification"]
    async fn mdns_discovery_and_authenticated_handoff() {
        let (mut first, mut first_events) =
            Network::start(Uuid::new_v4(), "Network test first".into(), [91; 32])
                .await
                .unwrap();
        let (mut second, mut second_events) =
            Network::start(Uuid::new_v4(), "Network test second".into(), [91; 32])
                .await
                .unwrap();
        timeout(Duration::from_secs(15), async {
            loop {
                if matches!(second_events.recv().await, Some(NetworkEvent::Peers(n)) if n > 0) {
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
