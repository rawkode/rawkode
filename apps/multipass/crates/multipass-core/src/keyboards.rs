use multipass_network::CLAIM_WINDOW;

use crate::policy::{BASELINE, SETTLE};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

pub(crate) type Address = [u8; 6];

#[derive(Default)]
pub(crate) struct KeyboardChanges {
    pub(crate) arrivals: Vec<(Address, Arc<AtomicBool>)>,
    pub(crate) departures: usize,
}

struct Arrival {
    ready: Instant,
    current: Arc<AtomicBool>,
    announced: bool,
}

pub(crate) struct Keyboards {
    observed: bool,
    ready: Instant,
    present: BTreeMap<Address, Arrival>,
    departed: BTreeMap<Address, Instant>,
}

impl Keyboards {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            observed: false,
            ready: now + BASELINE,
            present: BTreeMap::new(),
            departed: BTreeMap::new(),
        }
    }

    pub(crate) fn reset(&mut self, now: Instant) {
        self.invalidate_arrivals();
        *self = Self::new(now);
    }

    pub(crate) fn invalidate_arrivals(&mut self) {
        for arrival in self.present.values_mut() {
            arrival.current.store(false, Ordering::Release);
            arrival.announced = true;
        }
    }

    pub(crate) fn observe(&mut self, connected: Vec<Address>, now: Instant) -> KeyboardChanges {
        let connected: BTreeSet<_> = connected.into_iter().collect();
        let armed = self.observed && now >= self.ready;
        let mut changes = KeyboardChanges::default();
        self.present.retain(|address, arrival| {
            if connected.contains(address) {
                return true;
            }
            arrival.current.store(false, Ordering::Release);
            if armed && now >= arrival.ready {
                self.departed.insert(*address, now);
                changes.departures += 1;
            }
            false
        });
        self.departed.retain(|address, departed| {
            !connected.contains(address) && now.duration_since(*departed) < CLAIM_WINDOW
        });
        for address in connected {
            self.present.entry(address).or_insert_with(|| Arrival {
                ready: now + SETTLE,
                current: Arc::new(AtomicBool::new(true)),
                announced: !armed,
            });
        }
        self.observed = true;

        for (address, arrival) in &mut self.present {
            if !arrival.announced && now >= arrival.ready {
                arrival.announced = true;
                changes.arrivals.push((*address, arrival.current.clone()));
            }
        }
        changes
    }

    pub(crate) fn recent_departures(&self) -> impl Iterator<Item = Address> + '_ {
        self.departed.keys().copied()
    }

    pub(crate) fn consume_departure(&mut self, address: Address) {
        self.departed.remove(&address);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use multipass_network::keyboard_key;

    #[test]
    fn baseline_and_error_reset_do_not_synthesize_moves() {
        let start = Instant::now();
        let keyboard = [1; 6];
        let mut observed = Keyboards::new(start);
        assert!(observed.observe(vec![keyboard], start).arrivals.is_empty());
        let reset = start + BASELINE;
        assert!(observed.observe(vec![keyboard], reset).arrivals.is_empty());
        observed.reset(reset);
        assert!(observed
            .observe(vec![], reset + BASELINE)
            .arrivals
            .is_empty());
        assert!(observed.recent_departures().next().is_none());
    }

    #[test]
    fn tracks_individual_moves_and_revokes_an_arrival_after_it_leaves() {
        let start = Instant::now();
        let keyboard = [1; 6];
        let stationary = [2; 6];
        let mut observed = Keyboards::new(start);
        observed.observe(vec![keyboard, stationary], start);
        let departure = start + BASELINE;
        assert_eq!(observed.observe(vec![stationary], departure).departures, 1);
        assert_eq!(
            observed.recent_departures().collect::<Vec<_>>(),
            vec![keyboard]
        );

        let reconnect = departure + SETTLE;
        assert!(observed
            .observe(vec![keyboard, stationary], reconnect)
            .arrivals
            .is_empty());
        assert!(observed.recent_departures().next().is_none());
        let settled = reconnect + SETTLE;
        let arrivals = observed
            .observe(vec![keyboard, stationary], settled)
            .arrivals;
        assert_eq!(arrivals.len(), 1);
        assert_eq!(arrivals[0].0, keyboard);
        observed.observe(vec![stationary], settled + SETTLE);
        assert!(!arrivals[0].1.load(Ordering::Acquire));
    }

    #[test]
    fn a_transient_scan_failure_revokes_arrivals_but_preserves_the_departure_baseline() {
        let start = Instant::now();
        let mut observed = Keyboards::new(start);
        let stationary = [1; 6];
        let moving = [2; 6];
        observed.observe(vec![stationary], start);
        let attached = start + BASELINE;
        observed.observe(vec![stationary, moving], attached);
        let settled = attached + SETTLE;
        let arrivals = observed.observe(vec![stationary, moving], settled).arrivals;
        assert_eq!(arrivals.len(), 1);

        observed.invalidate_arrivals();
        assert!(!arrivals[0].1.load(Ordering::Acquire));
        let recovered = observed.observe(
            vec![stationary],
            settled + std::time::Duration::from_millis(200),
        );
        assert_eq!(recovered.departures, 1);
        assert_eq!(observed.recent_departures().next(), Some(moving));
    }

    #[test]
    fn a_departure_is_single_use_and_expires() {
        let start = Instant::now();
        let mut observed = Keyboards::new(start);
        observed.observe(vec![[1; 6], [2; 6]], start);
        let left = start + BASELINE;
        observed.observe(vec![], left);
        observed.consume_departure([1; 6]);
        assert_eq!(
            observed.recent_departures().collect::<Vec<_>>(),
            vec![[2; 6]]
        );
        observed.observe(vec![], left + CLAIM_WINDOW);
        assert!(observed.recent_departures().next().is_none());
    }

    #[test]
    fn two_hosts_correlate_only_the_keyboard_seen_on_both() {
        let start = Instant::now();
        let mut source = Keyboards::new(start);
        let mut destination = Keyboards::new(start);
        let moving = [1; 6];
        let unrelated = [2; 6];
        source.observe(vec![moving], start);
        destination.observe(vec![], start);
        let move_at = start + BASELINE;
        destination.observe(vec![moving, unrelated], move_at);
        let arrivals = destination
            .observe(vec![moving, unrelated], move_at + SETTLE)
            .arrivals;
        assert_eq!(arrivals.len(), 2);
        assert!(source.recent_departures().next().is_none());
        source.observe(vec![], move_at + SETTLE);

        let secret = [7; 32];
        let nonce = [8; 32];
        let match_count = arrivals
            .iter()
            .filter(|(address, _)| {
                let key = keyboard_key(*address, &nonce, &secret);
                source
                    .recent_departures()
                    .any(|left| keyboard_key(left, &nonce, &secret) == key)
            })
            .count();
        assert_eq!(match_count, 1);
    }
}
