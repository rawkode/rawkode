use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

/// Only a settled false-to-true edge may announce. Unknown observations invalidate everything.
pub struct AttachmentPolicy {
    previous: Option<bool>,
    ready_after: Instant,
    pending: Option<Instant>,
    current: Arc<AtomicBool>,
}
impl AttachmentPolicy {
    pub fn new(now: Instant) -> Self {
        Self {
            previous: None,
            ready_after: now + Duration::from_secs(3),
            pending: None,
            current: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn reset(&mut self, now: Instant) {
        self.current.store(false, Ordering::SeqCst);
        *self = Self::new(now);
    }
    pub fn observe(&mut self, present: Option<bool>, now: Instant) -> Option<Arc<AtomicBool>> {
        if present.is_none() {
            self.reset(now);
            return None;
        }
        if self.previous != present {
            self.current.store(false, Ordering::SeqCst);
            self.current = Arc::new(AtomicBool::new(present == Some(true)));
            self.pending =
                if self.previous == Some(false) && present == Some(true) && now >= self.ready_after
                {
                    Some(now)
                } else {
                    None
                };
            self.previous = present;
        }
        if present == Some(true)
            && self
                .pending
                .is_some_and(|arrival| now.duration_since(arrival) >= Duration::from_millis(800))
        {
            self.pending = None;
            return Some(self.current.clone());
        }
        None
    }
}

pub fn permits_switch(
    enabled: bool,
    suspended: bool,
    local_slot: u8,
    target: u8,
    keyboard: Option<bool>,
    mouse: Option<bool>,
) -> bool {
    enabled
        && !suspended
        && (1..=3).contains(&local_slot)
        && (1..=3).contains(&target)
        && target != local_slot
        && keyboard == Some(false)
        && mouse == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_and_wake_do_not_claim_and_real_arrival_settles() {
        let now = Instant::now();
        let mut policy = AttachmentPolicy::new(now);
        assert!(policy.observe(Some(true), now).is_none());
        assert!(policy
            .observe(Some(true), now + Duration::from_secs(4))
            .is_none());
        policy.observe(Some(false), now + Duration::from_secs(5));
        assert!(policy
            .observe(Some(true), now + Duration::from_secs(6))
            .is_none());
        assert!(policy
            .observe(Some(true), now + Duration::from_millis(6799))
            .is_none());
        let token = policy
            .observe(Some(true), now + Duration::from_millis(6800))
            .unwrap();
        assert!(token.load(Ordering::SeqCst));
        assert!(policy
            .observe(Some(true), now + Duration::from_secs(7))
            .is_none());
        policy.reset(now + Duration::from_secs(8));
        assert!(!token.load(Ordering::SeqCst));
        assert!(policy
            .observe(Some(true), now + Duration::from_secs(9))
            .is_none());
    }
    #[test]
    fn departure_or_unknown_revokes_live_claim() {
        for next in [Some(false), None] {
            let now = Instant::now();
            let mut policy = AttachmentPolicy::new(now);
            policy.observe(Some(false), now);
            policy.observe(Some(true), now + Duration::from_secs(4));
            let token = policy
                .observe(Some(true), now + Duration::from_secs(5))
                .unwrap();
            policy.observe(next, now + Duration::from_secs(6));
            assert!(!token.load(Ordering::SeqCst));
        }
    }
    #[test]
    fn source_requires_valid_absence_and_target() {
        assert!(permits_switch(true, false, 1, 2, Some(false), Some(true)));
        for (enabled, suspended, slot, target, kb, mouse) in [
            (false, false, 1, 2, Some(false), Some(true)),
            (true, true, 1, 2, Some(false), Some(true)),
            (true, false, 1, 1, Some(false), Some(true)),
            (true, false, 1, 4, Some(false), Some(true)),
            (true, false, 0, 2, Some(false), Some(true)),
            (true, false, 1, 2, Some(true), Some(true)),
            (true, false, 1, 2, None, Some(true)),
            (true, false, 1, 2, Some(false), None),
        ] {
            assert!(!permits_switch(enabled, suspended, slot, target, kb, mouse));
        }
    }
}
