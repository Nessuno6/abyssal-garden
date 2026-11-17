// LAN multiplayer transport, shared by the Windows and Android builds.
//
// The page does all game logic; this module only moves messages:
//  * lan_host: a WebSocket relay on TCP PORT. Every text message a peer sends is forwarded to all other peers as
//    "<sender id>|<message>"; when a peer leaves the others get "<id>|bye". The hosting page connects to it over
//    127.0.0.1 like any other peer. While hosting, a UDP beacon {"g":"abyssal","n":name,"p":PORT} goes to the
//    broadcast address on BEACON once a second.
//  * lan_scan: listens for beacons for a while and returns the games found.
//  * lan_stop: stops hosting and drops every connection.
//  * lan_log: the relay's recent events (connections, handshakes, errors), shown in the Online tab.
// Everything runs on a runtime of its own (two worker threads), apart from the one Tauri uses for the window, IPC
// and the webview, so the relay keeps accepting whatever the rest of the app is doing.
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, UdpSocket};
use tokio::runtime::Runtime;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

pub const PORT: u16 = 47820;
pub const BEACON: u16 = 47821;

type Peers = Arc<Mutex<HashMap<u32, UnboundedSender<Message>>>>;
struct Running {
    tasks: Vec<JoinHandle<()>>,
    peers: Peers,
}
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
static LOG: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

fn rt() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("lan")
            .enable_all()
            .build()
            .expect("LAN runtime")
    })
}

fn log(s: String) {
    let mut l = LOG.lock().unwrap();
    if l.len() >= 12 {
        l.pop_front();
    }
    l.push_back(s);
}

fn relay(peers: &Peers, from: u32, text: String) {
    for (id, tx) in peers.lock().unwrap().iter() {
        if *id != from {
            let _ = tx.send(Message::Text(text.clone()));
        }
    }
}

// the address other machines reach this one at (the interface of the default route; connecting a UDP socket sends nothing)
fn local_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    s.connect(("10.255.255.255", 1)).ok()?;
    Some(s.local_addr().ok()?.ip().to_string())
}

fn stop() {
    if let Some(r) = RUNNING.lock().unwrap().take() {
        for t in r.tasks {
            t.abort();
        }
        for (_, tx) in r.peers.lock().unwrap().drain() {
            let _ = tx.send(Message::Close(None));
        }
        log("stopped".into());
    }
}

async fn serve(listener: TcpListener, peers: Peers) {
    let mut next = 1u32;
    loop {
        let (stream, from) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                // a failed accept (e.g. the peer reset first) must not end the relay
                log(format!("accept error: {e}"));
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let peers = peers.clone();
        let id = next;
        next += 1;
        log(format!("#{id} connecting from {}", from.ip()));
        tokio::spawn(async move {
            let ws = match tokio::time::timeout(Duration::from_secs(5), tokio_tungstenite::accept_async(stream)).await {
                Ok(Ok(ws)) => ws,
                Ok(Err(e)) => return log(format!("#{id} handshake failed: {e}")),
                Err(_) => return log(format!("#{id} handshake timed out")),
            };
            log(format!("#{id} joined"));
            let (mut sink, mut src) = ws.split();
            let (tx, mut rx) = unbounded_channel::<Message>();
            peers.lock().unwrap().insert(id, tx);
            let writer = tokio::spawn(async move {
                while let Some(m) = rx.recv().await {
                    let close = matches!(m, Message::Close(_));
                    if sink.send(m).await.is_err() || close {
                        break;
                    }
                }
            });
            while let Some(Ok(m)) = src.next().await {
                match m {
                    Message::Text(t) => relay(&peers, id, format!("{id}|{t}")),
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            peers.lock().unwrap().remove(&id);
            relay(&peers, id, format!("{id}|bye"));
            writer.abort();
            log(format!("#{id} left"));
        });
    }
}

async fn beacon(name: String) {
    let msg = json!({ "g": "abyssal", "n": name, "p": PORT }).to_string();
    let s = match UdpSocket::bind(("0.0.0.0", 0)).await {
        Ok(s) => s,
        Err(e) => return log(format!("beacon off: {e}")),
    };
    let _ = s.set_broadcast(true);
    let mut warned = false;
    loop {
        if let Err(e) = s.send_to(msg.as_bytes(), ("255.255.255.255", BEACON)).await {
            if !warned {
                log(format!("beacon: {e}"));
                warned = true;
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[tauri::command]
pub fn lan_host(name: String) -> Result<Vec<String>, String> {
    stop();
    let rt = rt();
    // bound here with std (no blocking on a runtime: commands may run on one), then handed to the relay's runtime
    let std_listener = std::net::TcpListener::bind(("0.0.0.0", PORT)).map_err(|e| format!("port {PORT}: {e}"))?;
    std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let listener = {
        let _in_rt = rt.enter();
        TcpListener::from_std(std_listener).map_err(|e| e.to_string())?
    };
    let peers: Peers = Arc::new(Mutex::new(HashMap::new()));
    let tasks = vec![rt.spawn(serve(listener, peers.clone())), rt.spawn(beacon(name))];
    *RUNNING.lock().unwrap() = Some(Running { tasks, peers });
    let ips: Vec<String> = local_ip().into_iter().collect();
    log(format!("hosting on {}:{PORT}", ips.join(", ")));
    Ok(ips)
}

#[tauri::command]
pub fn lan_stop() {
    stop();
}

#[tauri::command]
pub fn lan_log() -> Vec<String> {
    LOG.lock().unwrap().iter().cloned().collect()
}

#[tauri::command]
pub async fn lan_scan(ms: u64) -> Result<Vec<Value>, String> {
    rt().spawn_blocking(move || {
        let s = std::net::UdpSocket::bind(("0.0.0.0", BEACON)).map_err(|e| format!("port {BEACON}: {e}"))?;
        let _ = s.set_read_timeout(Some(Duration::from_millis(200)));
        let end = Instant::now() + Duration::from_millis(ms.min(10_000));
        let (mut out, mut seen, mut buf) = (Vec::new(), HashSet::new(), [0u8; 512]);
        while Instant::now() < end {
            if let Ok((n, from)) = s.recv_from(&mut buf) {
                if let Ok(v) = serde_json::from_slice::<Value>(&buf[..n]) {
                    if v["g"] == "abyssal" && seen.insert(from.ip()) {
                        out.push(json!({ "n": v["n"], "ip": from.ip().to_string(), "p": v["p"] }));
                    }
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
