use structopt::StructOpt;
use tracing::Level;

mod simple;

#[derive(Debug, StructOpt)]
#[structopt(name = "example", about = "An example of StructOpt usage.")]
struct Opt {
    /// Emit tracing events formatted as JSON
    #[structopt(short, long)]
    format: Option<String>,

    /// The level of verbosity
    #[structopt(short, long, parse(from_occurrences))]
    verbose: u8,
}

fn main() {
    let options = Opt::from_args();

    let level = match options.verbose {
        0 => Level::ERROR,
        1 => Level::WARN,
        2 => Level::INFO,
        3 => Level::DEBUG,
        _ => Level::TRACE,
    };

    match options.format {
				Some(format) if format == "json" => {
						tracing_subscriber::fmt()
								.json()
								.with_thread_names(true)
								.with_max_level(level)
								.init();
				}

				Some(format) if format == "pretty" => {
						tracing_subscriber::fmt()
								.pretty()
								.with_thread_names(true)
								.with_max_level(level)
								.init();
				}

        _ => {
            tracing_subscriber::fmt()
                .with_thread_names(true)
                .with_max_level(level)
                .init();
        }
    }

    simple::levels();
    simple::spans();
}
