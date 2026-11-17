// Relay smoke test: host the relay, connect three WebSocket peers one after another, check messages get through.
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

fn main() {
    tauri::async_runtime::block_on(async {
        let ips = abyssal_garden_lib::lan::lan_host("test".into()).expect("host");
        println!("hosting, ips {ips:?}");
        let mut peers = Vec::new();
        for i in 0..3 {
            let r = tokio::time::timeout(Duration::from_secs(3), connect_async("ws://127.0.0.1:47820")).await;
            match r {
                Ok(Ok((ws, _))) => { println!("peer {i} connected"); peers.push(ws); }
                Ok(Err(e)) => { println!("peer {i} error {e}"); return; }
                Err(_) => { println!("peer {i} TIMED OUT"); return; }
            }
        }
        peers[0].send(Message::Text("hello".into())).await.unwrap();
        for i in 1..3 {
            let m = tokio::time::timeout(Duration::from_secs(3), peers[i].next()).await;
            println!("peer {i} got {:?}", m.map(|x| x.map(|y| y.map(|z| z.to_string()))));
        }
    });
}
