#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = crabshell_lib::run() {
        eprintln!("Crabshell failed to start: {error}");
        std::process::exit(1);
    }
}
