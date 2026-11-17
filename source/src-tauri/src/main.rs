// Windows desktop entry point (Android starts from lib.rs's mobile entry point instead).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    abyssal_garden_lib::run()
}
