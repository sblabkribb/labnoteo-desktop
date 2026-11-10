use tauri::Manager;

pub mod assistant;
pub mod index;
pub mod mcp;
pub mod net;
pub mod print;
pub mod scan;
pub mod skill;
pub mod ui_prefs;
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
            $crate::vault::fs::scan_write_image,
            $crate::vault::attach::vault_open_default,
            $crate::vault::attach::vault_reveal,
            $crate::vault::attach::vault_read_bytes,
            $crate::vault::attach::vault_file_info,
            $crate::vault::attach::vault_write_attachment,
            $crate::vault::settings::settings_vault_read,
            $crate::vault::settings::settings_vault_write,
            $crate::vault::settings::settings_import_plugin,
            $crate::vault::settings::settings_plugin_llm_key,
            $crate::vault::settings::settings_import_llm_key,
            $crate::ui_prefs::ui_prefs_read,
            $crate::ui_prefs::ui_prefs_write,
            $crate::index::index_rebuild,
            $crate::index::index_upsert,
            $crate::index::index_remove,
            $crate::index::search,
            $crate::index::index_search_in,
            $crate::index::index_bodies,
            $crate::vault::journal::link_journal_read,
            $crate::vault::journal::link_journal_write_header,
            $crate::vault::journal::link_journal_write_note,
            $crate::vault::journal::link_journal_clear,
            $crate::net::secrets::secret_set,
            $crate::net::secrets::secret_clear,
            $crate::net::secrets::secret_status,
            $crate::net::import::integration_import_pick,
            $crate::net::import::integration_import_bytes,
            $crate::net::import::integration_import_delete,
            $crate::net::net_cancel,
            $crate::net::partbank::partbank_request,
            $crate::net::partbank::partbank_probe,
            $crate::net::llm::llm_chat,
            $crate::net::llm::llm_probe,
            $crate::net::stream::llm_chat_stream,
            $crate::net::bfw::bfw_request,
            $crate::net::bfw::bfw_probe,
            $crate::net::bfw::bfw_base,
            $crate::net::bfw::bfw_generate_notes,
            $crate::net::store::partbank_catalog_list,
            $crate::net::store::partbank_catalog_read,
            $crate::net::store::partbank_catalog_write,
            $crate::net::store::integration_state_read,
            $crate::net::store::integration_state_write,
            // The MCP client: RAPID and BioModel Portal presets plus custom servers.
            $crate::net::mcp_client::mcp_client_secret_set,
            $crate::net::mcp_client::mcp_client_secret_clear,
            $crate::net::mcp_client::mcp_client_secret_status,
            $crate::net::mcp_client::mcp_client_connect,
            $crate::net::mcp_client::mcp_client_call,
            $crate::net::mcp_client::mcp_client_disconnect,
            $crate::net::mcp_client::mcp_client_forget,
            $crate::net::mcp_client::mcp_client_tools_cached,
            // Built-in literature search (spec §8): PubMed now and more sources later.
            $crate::net::scholar::scholar_search,
            $crate::net::scholar::scholar_get,
            // SP7 Part A
            $crate::vault::fs::vault_created_times,
            $crate::print::print_open_in_browser,
            // SP7 Part B
            $crate::net::slack::slack_call,
            $crate::net::slack::slack_download,
            $crate::scan::scan_folder_choose,
            $crate::scan::scan_folder_clear,
            $crate::scan::scan_folder_set_mode,
            $crate::scan::scan_folder_status,
            $crate::scan::scan_folder_list,
            $crate::scan::scan_folder_prune_baseline,
            $crate::scan::scan_folder_read,
            $crate::scan::scan_folder_move,
            $crate::scan::scan_folder_watch,
            // SP7 Part C
            $crate::mcp::token::mcp_token_status,
            $crate::mcp::token::mcp_token_regenerate,
            $crate::mcp::token::mcp_token_copy,
            $crate::mcp::bridge::mcp_start,
            $crate::mcp::bridge::mcp_stop,
            $crate::mcp::bridge::mcp_status,
            $crate::mcp::bridge::mcp_claim,
            $crate::mcp::bridge::mcp_reply,
            $crate::mcp::bridge::mcp_drain,
            // SP6-B1: "Open labnoteO link" reads a link off the clipboard from Rust.
            $crate::mcp::clipboard::clipboard_labnoteo_link,
            // Steps 4 + 5: the labnoteO SKILL.md installer (explicit click only).
            $crate::skill::skill_status,
            $crate::skill::skill_install,
            $crate::skill::skill_save_as,
            // The assistant's chat history per experiment folder (app data dir).
            $crate::assistant::history::assistant_history_read,
            $crate::assistant::history::assistant_history_write,
            $crate::assistant::history::assistant_history_clear,
            $crate::assistant::history::assistant_history_clear_all,
            $crate::assistant::history::assistant_history_stats,
            // The per-PC assistant.json and SearXNG web search (assistant Task 12).
            $crate::assistant::config::assistant_config_read,
            $crate::assistant::config::assistant_config_write,
            $crate::net::web_search::web_search,
            $crate::net::web_search::web_search_probe,
            // SSRF-guarded readable page fetch (assistant Task 13).
            $crate::net::fetch_page::fetch_page,
        ])
    };
}

/// How long app exit waits for MCP client sessions to be ended.
pub const MCP_CLOSE_ON_EXIT: std::time::Duration = std::time::Duration::from_secs(2);

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
    // A test exe built with `e2e-fakes` reads its fake loopback ports once,
    // here; a release build has no such feature and never reads the variable.
    #[cfg(feature = "e2e-fakes")]
    let _ = net::fetch_page::app_policy();
    register_commands!(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(vault::VaultState::default())
        // Requests in flight (cancellable by id) and the PartBank web pacing gate.
        .manage(net::NetState::default())
        // Open MCP client sessions, by server id (ended on vault switch and exit).
        .manage(net::mcp_client::McpClients::default())
        // The scan folder's watcher (SP7 B4); started by `scan_folder_watch` / `scan_folder_choose`.
        .manage(scan::ScanFolderState::default())
        // SP7 Part C: the MCP server's state (the in-memory token copy) and
        // the clipboard the token is copied to from Rust (C5).
        .manage(mcp::McpState::default())
        .manage(mcp::ClipState(std::sync::Arc::new(mcp::ArboardClipboard)))
        // The skill installer's home folder (USERPROFILE, then HOME).
        .manage(skill::SkillPaths::from_env())
        // SP7 Part C: a page load in the main webview (reload, navigation,
        // crash recovery) stops the MCP server and fails its pending calls,
        // from Rust, because JS cannot reliably invoke during unload (C3).
        // The vault effect starts it again.
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
                mcp::page_load_started(&webview.state::<mcp::McpState>());
            }
        })
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
            // Offline PartBank catalogs and integration state, per vault and
            // never in the vault (D13).
            app.manage(net::IntegrationDirs(data.join("integrations")));
            // The assistant's chat history (and later its skins), never in a vault.
            app.manage(assistant::AssistantDirs(data.join("assistant")));
            // Integration keys: Windows Credential Manager only, never a file (D6).
            app.manage(net::secrets::Secrets::keyring());
            // Save as... for SKILL.md: Rust's own save dialog, modal to the main window.
            app.manage(skill::SkillPicker::dialog(app.handle().clone()));
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
        .build(tauri::generate_context!())
        .expect("error while building labnoteO")
        .run(|app, event| {
            // End every MCP client session, best effort and briefly.
            if let tauri::RunEvent::Exit = event {
                let clients = app.state::<net::mcp_client::McpClients>();
                tauri::async_runtime::block_on(async {
                    let _ = tokio::time::timeout(MCP_CLOSE_ON_EXIT, clients.close_all()).await;
                });
            }
        });
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
