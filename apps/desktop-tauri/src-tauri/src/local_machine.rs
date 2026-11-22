use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use super::{BridgeError, Shell};

#[derive(Default)]
pub struct LocalMachine(Mutex<Option<(String, PathBuf, Child)>>);

impl LocalMachine {
    pub fn stop(&self) -> Result<(), BridgeError> {
        let mut active = self
            .0
            .lock()
            .map_err(|_| BridgeError::new("AGENTS_STATE", "État des agents indisponible."))?;
        let Some((_, _, mut child)) = active.take() else {
            return Ok(());
        };
        if matches!(child.try_wait(), Ok(None)) {
            #[cfg(unix)]
            let _ = Command::new("/bin/kill")
                .args(["-TERM", &child.id().to_string()])
                .status();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while matches!(child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(25));
            }
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
            }
        }
        let _ = child.wait();
        Ok(())
    }
}

fn executable<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, BridgeError> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("edge-setup"));
    bundled
        .into_iter()
        .chain(["/usr/local/sbin/edge-setup", "/usr/local/bin/edge-setup"].map(PathBuf::from))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            BridgeError::new(
                "EDGE_SETUP_MISSING",
                "Installez edge-setup sur cet ordinateur.",
            )
        })
}

#[tauri::command]
#[specta::specta]
pub async fn start_local_machine<R: tauri::Runtime>(
    app: AppHandle<R>,
    shell: State<'_, Shell>,
    ticket: String,
    workspace_id: String,
) -> Result<bool, BridgeError> {
    if !shell.auth.is_signed_in() || ticket.len() > 256 || ticket.contains(['\n', '\r']) {
        return Err(BridgeError::new(
            "INVALID_ENROLLMENT",
            "Appairage de la machine refusé.",
        ));
    }
    let api = &shell.config.api_origin;
    let origin = if api == crate::config::PRODUCTION_API_ORIGIN {
        "https://link.openedbot.app".to_owned()
    } else {
        api.clone()
    };
    let binary = executable(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(folder) = app
            .dialog()
            .file()
            .set_title("Dossier de travail des agents")
            .blocking_pick_folder()
        else {
            return Ok(false);
        };
        let workspace = folder.into_path().map_err(|_| {
            BridgeError::new("WORKSPACE_UNAVAILABLE", "Dossier de travail indisponible.")
        })?;
        let state = app.state::<LocalMachine>();
        let mut active = state
            .0
            .lock()
            .map_err(|_| BridgeError::new("AGENTS_STATE", "État des agents indisponible."))?;
        if let Some((current_id, current, child)) = active.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                if current_id == &workspace_id && current == &workspace {
                    return Ok(true);
                }
                return Err(BridgeError::new(
                    "AGENTS_ALREADY_RUNNING",
                    "Arrêtez les agents de cet ordinateur avant de changer d’espace ou de dossier.",
                ));
            }
        }
        let mut command = Command::new(binary);
        command
            .args([
                "connect",
                "--foreground",
                "--openedbot",
                &origin,
                "--workspace-id",
                &workspace_id,
                "--workspace",
            ])
            .arg(&workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|_| {
            BridgeError::new("EDGE_SETUP_FAILED", "Impossible de lancer edge-setup.")
        })?;
        let written = child.stdin.take().is_some_and(|mut input| {
            input
                .write_all(ticket.as_bytes())
                .and_then(|()| input.write_all(b"\n"))
                .is_ok()
        });
        let (sender, ready) = std::sync::mpsc::sync_channel(1);
        let stdout = child.stdout.take();
        std::thread::spawn(move || {
            // `connect` lists the agents it finds, pairs them, then prints
            // `ready <engine>` for each linked agent. The first one is enough;
            // the rest is drained so the pipe never blocks the agents.
            let Some(pipe) = stdout else {
                let _ = sender.send(false);
                return;
            };
            let mut reported = false;
            for line in BufReader::new(pipe).lines() {
                let Ok(line) = line else { break };
                if !reported && line.starts_with("ready local:") {
                    reported = true;
                    let _ = sender.send(true);
                }
            }
            if !reported {
                let _ = sender.send(false);
            }
        });
        if !written || ready.recv_timeout(Duration::from_secs(180)) != Ok(true) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(BridgeError::new(
                "AGENTS_NOT_READY",
                "Aucun agent n’a pu se connecter : vérifiez qu’au moins un CLI (Codex, Claude Code, Grok, Gemini, OpenCode) est installé et connecté sous votre compte.",
            ));
        }
        *active = Some((workspace_id, workspace, child));
        Ok(true)
    })
    .await
    .map_err(|_| BridgeError::new("AGENTS_STATE", "Appairage de la machine interrompu."))?
}

#[tauri::command]
#[specta::specta]
pub async fn stop_local_machine(state: State<'_, LocalMachine>) -> Result<(), BridgeError> {
    state.stop()
}
