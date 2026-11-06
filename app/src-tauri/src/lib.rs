use tauri::Manager;

pub mod index;
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
            $crate::index::index_rebuild,
            $crate::index::index_upsert,
            $crate::index::index_remove,
            $crate::index::search,
        ])
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    register_commands!(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .manage(vault::VaultState::default())
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
            // Watches the open vault for changes made outside the app; started
            // by `vault_open` / `vault_current`, moved when the vault changes.
            app.manage(vault::watcher::WatcherState::new(vault::watcher::app_starter(app.handle().clone())));
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
}
