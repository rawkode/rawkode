use tracing::span;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::Registry;

mod simple;

fn main() {
     let tracer = opentelemetry_jaeger::new_agent_pipeline()
        .with_service_name("cli-app")
        .install_simple().expect("Oops, ");
    let telemetry = tracing_opentelemetry::layer().with_tracer(tracer);
    let subscriber = Registry::default().with(telemetry);

    tracing::subscriber::with_default(subscriber, || {
        let root = span!(tracing::Level::TRACE, "start", work_units = 2);
        let _enter = root.enter();

        simple::levels();
        simple::spans();
    });
}
