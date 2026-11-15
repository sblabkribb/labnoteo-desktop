fn main() {
    // The IPC round-trip test (tests/ipc.rs, an integration test) builds a mock
    // Tauri app, which needs the Common Controls v6 manifest the real app gets
    // from tauri-build; without it that test exe dies with
    // STATUS_ENTRYPOINT_NOT_FOUND.
    //
    // Scope matters: `rustc-link-arg-tests` reaches only integration-test
    // targets. Plain `rustc-link-arg` also hits the shipped bin, which already
    // embeds tauri-build's manifest (duplicate MANIFEST, CVT1100), and
    // `rustc-link-arg-lib` did not reach the lib's unit-test binary, so the
    // test lives under tests/ instead.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        println!("cargo:rerun-if-changed=test-manifest.xml");
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{dir}/test-manifest.xml");
    }
    // Any rerun-if-changed above turns off Cargo's "rerun on any change" default, so the
    // icons (embedded in the exe as its Windows resource) and the config must be named,
    // or a changed icon never reaches the next build.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    // Every app command needs an `allow-<name>` permission from a capability: the main window's default.json grants
    // all of them, the pet window's pet.json only its own. commands.txt is the one list (tests keep it equal to
    // register_commands! in lib.rs).
    println!("cargo:rerun-if-changed=commands.txt");
    let text = std::fs::read_to_string("commands.txt").expect("commands.txt");
    let names: Vec<&'static str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| &*Box::leak(l.to_string().into_boxed_str()))
        .collect();
    let commands: &'static [&'static str] = Box::leak(names.into_boxed_slice());
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("failed to run tauri-build");
}
