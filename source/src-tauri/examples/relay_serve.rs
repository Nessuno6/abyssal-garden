// Hosts the LAN relay on this machine until killed (for testing clients against a scripted host).
fn main() {
    let ips = abyssal_garden_lib::lan::lan_host("relay-test".into()).expect("host");
    println!("relay up on {ips:?}:{}", abyssal_garden_lib::lan::PORT);
    loop { std::thread::sleep(std::time::Duration::from_secs(3600)); }
}
