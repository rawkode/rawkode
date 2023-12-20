use tracing::{instrument, info};

#[instrument]
pub(crate) fn levels() -> () {
    tracing::error!("This is an error. It's not written by AI.");
    tracing::warn!("The debug/trace joke is written by AI. I'm so sorry.");

    tracing::info!(
        "Did you know that if it looks like a duck and quacks like a duck, it's a duck?"
    );

    tracing::debug!("Why do programmers prefer using bugs for debugging?");
    tracing::trace!("Because bugs never call in sick and they're always willing to work overtime!");
}

#[instrument]
pub(crate) fn spans() -> () {
    tracing::debug!("Computational Tasks ...");
    for i in 0..20 {
        let span = tracing::span!(tracing::Level::TRACE, "loop", i);
        let _guard = span.enter();
				info!("Computational Task {}", i);
        std::thread::sleep(std::time::Duration::from_secs(i));
    }
}
