pub mod vault;

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(vault::VaultState::default())
        .invoke_handler(tauri::generate_handler![
            app_version,
            vault::fs::vault_read,
            vault::fs::vault_write,
            vault::fs::vault_modify,
            vault::fs::vault_exists,
            vault::fs::vault_mkdir,
            vault::fs::vault_list,
            vault::fs::vault_remove,
            vault::fs::vault_rmdir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running labnoteO");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_version_matches_cargo_package_version() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
    }
}
