use tauri::Manager;

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
            $crate::vault::fs::vault_read,
            $crate::vault::fs::vault_write,
            $crate::vault::fs::vault_modify,
            $crate::vault::fs::vault_exists,
            $crate::vault::fs::vault_mkdir,
            $crate::vault::fs::vault_list,
            $crate::vault::fs::vault_remove,
            $crate::vault::fs::vault_rmdir,
        ])
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    register_commands!(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .manage(vault::VaultState::default())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(vault::SettingsFile(dir.join("settings.json")));
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
