use tauri::Manager;

pub mod index;
pub mod net;
pub mod vault;

pub mod app {
    #[tauri::command]
    pub fn app_version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

/// Registers every IPC command on a builder. A macro so the IPC round-trip
/// test registers exactly what the app does (it needs the mock runtime).
#[macro_export]
macro_rules! register_commands {
    ($builder:expr) => {
        $builder.invoke_handler(tauri::generate_handler![
            $crate::app::app_version,
            $crate::vault::vault_open,
            $crate::vault::vault_create,
            $crate::vault::vault_current,
            $crate::vault::tree::vault_tree,
            $crate::vault::fs::vault_read,
            $crate::vault::fs::vault_write,
            $crate::vault::fs::vault_modify,
            $crate::vault::fs::vault_exists,
            $crate::vault::fs::vault_mkdir,
            $crate::vault::fs::vault_list,
            $crate::vault::fs::vault_remove,
            $crate::vault::fs::vault_rmdir,
            $crate::vault::fs::vault_rename,
            $crate::vault::fs::vault_trash,
            $crate::vault::fs::vault_read_image,
            $crate::vault::fs::vault_list_images,
            $crate::vault::fs::vault_write_image,
            $crate::vault::settings::settings_vault_read,
            $crate::vault::settings::settings_vault_write,
            $crate::vault::settings::settings_import_plugin,
            $crate::index::index_rebuild,
            $crate::index::index_upsert,
            $crate::index::index_remove,
            $crate::index::search,
            $crate::index::index_bodies,
            $crate::vault::journal::link_journal_read,
            $crate::vault::journal::link_journal_write_header,
            $crate::vault::journal::link_journal_write_note,
            $crate::vault::journal::link_journal_clear,
            $crate::net::secrets::secret_set,
            $crate::net::secrets::secret_clear,
            $crate::net::secrets::secret_status,
            $crate::net::net_cancel,
            $crate::net::partbank::partbank_request,
            $crate::net::partbank::partbank_probe,
            $crate::net::llm::llm_chat,
            $crate::net::llm::llm_probe,
            $crate::net::bfw::bfw_request,
            $crate::net::bfw::bfw_probe,
            $crate::net::bfw::bfw_base,
            $crate::net::bfw::bfw_generate_notes,
        ])
    };
}

/// How long `setup` waits before showing a main window the front end never showed.
pub const SHOW_FALLBACK: std::time::Duration = std::time::Duration::from_secs(3);

/// Shows the window unless it is already visible. Errors are ignored: this is
/// a last-resort fallback and there is nothing better to do with them.
pub fn show_if_hidden<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    register_commands!(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(vault::VaultState::default())
        // Requests in flight (cancellable by id) and the PartBank web pacing gate.
        .manage(net::NetState::default())
        .setup(|app| {
            // Never abort startup over where the last vault is remembered: fall
            // back to the temp dir (the choice is then just not kept long-term).
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("kr.sblab.labnoteo"));
            app.manage(vault::SettingsFile(dir.join("settings.json")));
            // The search index is a cache and lives in the app data dir, never
            // in a vault. Same fallback as above: never abort startup over it.
            let data = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("kr.sblab.labnoteo"));
            app.manage(index::IndexState::new(data.join("index")));
            // The link-update journal (rename recovery and undo), also outside every vault.
            app.manage(vault::LinkJournalDir(data.join("link-journal")));
            // Integration keys: Windows Credential Manager only, never a file (D6).
            app.manage(net::secrets::Secrets::keyring());
            // Watches the open vault for changes made outside the app; started
            // by `vault_open` / `vault_current`, moved when the vault changes.
            app.manage(vault::watcher::WatcherState::new(vault::watcher::app_starter(app.handle().clone())));
            // The main window starts hidden (`visible: false`) and the front end
            // shows it once the first theme is applied. If the front end never
            // gets that far (a bundle or CSP error, an exception before React
            // mounts, a WebView2 load failure) the process would sit invisible,
            // so show it anyway after SHOW_FALLBACK.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(SHOW_FALLBACK);
                    show_if_hidden(&window);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running labnoteO");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_version_matches_cargo_package_version() {
        assert_eq!(app::app_version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn show_fallback_waits_longer_than_the_front_end_fallback() {
        // useTheme.ts SHOW_FALLBACK_MS is 1500: the Rust fallback must not race it.
        assert_eq!(SHOW_FALLBACK, std::time::Duration::from_secs(3));
    }
}
