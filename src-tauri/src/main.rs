#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `ProxyCommand` helper started by OpenSSH (proxy.rs): no window, just the relay.
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = crabshell_lib::run_proxy_helper(&args) {
        std::process::exit(code);
    }
    if let Err(error) = crabshell_lib::run() {
        eprintln!("Crabshell failed to start: {error}");
        std::process::exit(1);
    }
}
