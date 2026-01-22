use std::path::PathBuf;

use clap::{Parser, Subcommand};
use tokio::task::LocalSet;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use rawko::{
    emit_agent_text, emit_error, emit_status_agent_completed, emit_status_agent_selected,
    emit_status_cancelling, emit_status_evaluation, emit_status_task_completed,
    emit_status_task_started, AgentRegistry, DriverConfig, OrchestratorDriver, TaskOutput,
    TerminalLayer, Verbosity,
};

#[derive(Parser)]
#[command(name = "rawko")]
#[command(about = "An agentic coding robot")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Task description (for backwards compatibility)
    task: Option<String>,

    /// Config file path
    #[arg(short, long, global = true)]
    config: Option<PathBuf>,

    /// Verbose output (-v, -vv, -vvv)
    #[arg(short, long, global = true, action = clap::ArgAction::Count)]
    verbose: u8,

    /// Quiet mode - only show errors and results
    #[arg(short, long, global = true)]
    quiet: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Run a task
    Run {
        /// Task description
        task: String,
    },
    /// List and inspect agents
    Agents {
        #[command(subcommand)]
        action: Option<AgentsAction>,
    },
}

#[derive(Subcommand)]
enum AgentsAction {
    /// Show details for a specific agent
    Show {
        /// Agent name
        name: String,
    },
}

/// Initialize tracing with the terminal layer
fn init_tracing(verbose: u8, quiet: bool) {
    let verbosity = if quiet {
        Verbosity::Quiet
    } else {
        // Default is Normal (1), -v adds Verbose (2), -vv adds Debug (3)
        Verbosity::from(verbose.saturating_add(1))
    };

    let terminal_layer = TerminalLayer::new(verbosity);

    tracing_subscriber::registry()
        .with(terminal_layer)
        .init();
}

#[tokio::main]
async fn main() -> rawko::Result<()> {
    let cli = Cli::parse();

    // Initialize tracing with terminal layer
    init_tracing(cli.verbose, cli.quiet);

    // Determine what to do based on command or task
    match cli.command {
        Some(Commands::Run { task }) => {
            run_task_command(task, cli.config).await
        }
        Some(Commands::Agents { action }) => {
            handle_agents_command(action, cli.config)
        }
        None => {
            // Backwards compatibility: treat positional arg as task
            match cli.task {
                Some(task) => run_task_command(task, cli.config).await,
                None => {
                    print_help();
                    Ok(())
                }
            }
        }
    }
}

fn print_help() {
    eprintln!("rawko - An agentic coding robot");
    eprintln!();
    eprintln!("Usage: rawko <task>");
    eprintln!("       rawko run <task>");
    eprintln!("       rawko agents [show <name>]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  run <task>           Run a task");
    eprintln!("  agents               List available agents");
    eprintln!("  agents show <name>   Show details for an agent");
    eprintln!();
    eprintln!("Examples:");
    eprintln!("  rawko \"create a hello world rust program\"");
    eprintln!("  rawko \"fix the failing tests\"");
    eprintln!("  rawko -v \"refactor the authentication module\"");
    eprintln!("  rawko agents");
    eprintln!("  rawko agents show developer");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  -c, --config <PATH>  Path to config file");
    eprintln!("  -v, --verbose        Increase verbosity (-v, -vv, -vvv)");
    eprintln!("  -q, --quiet          Only show errors and results");
}

/// Handle the agents subcommand
fn handle_agents_command(
    action: Option<AgentsAction>,
    config_path: Option<PathBuf>,
) -> rawko::Result<()> {
    // Load config
    let config = match config_path {
        Some(path) => rawko::config::load_config_from_path(&path)?,
        None => rawko::config::load_config()?,
    };

    // Load agent registry with builtins
    let registry = AgentRegistry::with_builtins(&config)?;

    match action {
        None => list_agents(&registry),
        Some(AgentsAction::Show { name }) => show_agent(&registry, &name),
    }
}

/// List all available agents
fn list_agents(registry: &AgentRegistry) -> rawko::Result<()> {
    // Collect and sort agents by key
    let mut agents: Vec<_> = registry.agents().collect();
    agents.sort_by(|a, b| a.0.cmp(b.0));

    // Calculate column widths - account for display names
    let name_width = agents.iter().map(|(key, agent)| {
        let display = agent.display_name(key);
        if display == *key {
            key.len()
        } else {
            // Format: "key (display_name)"
            key.len() + 3 + display.len()
        }
    }).max().unwrap_or(10).max(4);
    let when_width = 50;

    // Print header
    println!(
        "{:<name_width$}  {:<when_width$}  COMMAND",
        "NAME", "WHEN TO USE",
        name_width = name_width,
        when_width = when_width
    );

    // Print agents
    for (key, agent) in agents {
        let display_name = agent.display_name(key);
        let name_display = if display_name == key {
            key.to_string()
        } else {
            format!("{} ({})", key, display_name)
        };
        let when_to_use = truncate_str(&agent.when_to_use, when_width);
        let command = agent.command.as_deref().unwrap_or("(builtin)");
        println!(
            "{:<name_width$}  {:<when_width$}  {}",
            name_display,
            when_to_use,
            command,
            name_width = name_width,
            when_width = when_width
        );
    }

    Ok(())
}

/// Show details for a specific agent
fn show_agent(registry: &AgentRegistry, name: &str) -> rawko::Result<()> {
    let agent = registry.get(name).ok_or_else(|| rawko::Error::Agent {
        message: format!("Unknown agent: {}", name),
    })?;

    let display_name = agent.display_name(name);
    if display_name == name {
        println!("Agent: {}", name);
    } else {
        println!("Agent: {} ({})", name, display_name);
    }
    if !agent.when_to_use.is_empty() {
        println!("When to use: {}", agent.when_to_use);
    }
    println!();

    // Command info
    let command = agent.command.as_deref().unwrap_or("(builtin)");
    if agent.args.is_empty() {
        println!("Command: {}", command);
    } else {
        println!("Command: {} {}", command, agent.args.join(" "));
    }
    println!();

    // Prompt (truncated preview)
    println!("Prompt:");
    let prompt_preview = truncate_str(&agent.prompt, 200);
    for line in prompt_preview.lines().take(5) {
        println!("  {}", line);
    }
    if agent.prompt.len() > 200 || agent.prompt.lines().count() > 5 {
        println!("  ...");
    }

    Ok(())
}

/// Truncate a string to a maximum length
fn truncate_str(s: &str, max_len: usize) -> String {
    // Get first line and truncate if needed
    let first_line = s.lines().next().unwrap_or(s);
    if first_line.len() <= max_len {
        first_line.to_string()
    } else {
        format!("{}...", &first_line[..max_len - 3])
    }
}

/// Run a task through the orchestration driver
async fn run_task_command(task: String, config_path: Option<PathBuf>) -> rawko::Result<()> {
    // Load config
    let config = match config_path {
        Some(path) => {
            tracing::debug!("Loading config from: {:?}", path);
            rawko::config::load_config_from_path(&path)?
        }
        None => {
            tracing::debug!("Loading config from default locations");
            rawko::config::load_config()?
        }
    };

    tracing::debug!("Starting task: {}", task);

    // Set up cancellation
    let cancel_token = CancellationToken::new();
    let cancel_clone = cancel_token.clone();

    // Spawn Ctrl+C handler
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            emit_status_cancelling!();
            cancel_clone.cancel();
        }
    });

    // Run with LocalSet for spawn_local support (required by ACP)
    let local = LocalSet::new();
    let result = local
        .run_until(async move { run_task(task, config, cancel_token).await })
        .await;

    result
}

/// Runs the task through the orchestration driver
async fn run_task(
    task: String,
    config: rawko::config::RawkoConfig,
    cancel_token: CancellationToken,
) -> rawko::Result<()> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let driver_config = DriverConfig::with_cwd(cwd);

    let mut driver = OrchestratorDriver::new(driver_config, &config)?;
    let (_task_id, mut output_rx) = driver.run_task(task, cancel_token).await;

    // Stream output via tracing events
    while let Some(output) = output_rx.recv().await {
        match output {
            TaskOutput::TaskStarted { task_id } => {
                emit_status_task_started!(task_id.to_string());
            }
            TaskOutput::AgentSelected {
                display_name,
                reasoning,
                ..
            } => {
                emit_status_agent_selected!(display_name, reasoning);
            }
            TaskOutput::AgentText(text) => {
                emit_agent_text!(text);
            }
            TaskOutput::AgentCompleted { display_name, .. } => {
                emit_status_agent_completed!(display_name);
            }
            TaskOutput::Evaluation { decision, reasoning } => {
                emit_status_evaluation!(decision, reasoning);
            }
            TaskOutput::TaskCompleted { task_id, success } => {
                emit_status_task_completed!(task_id.to_string(), success);
            }
            TaskOutput::Error { message } => {
                emit_error!(message);
            }
        }
    }

    driver.shutdown().await?;
    Ok(())
}
