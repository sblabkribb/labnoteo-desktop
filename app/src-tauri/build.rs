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
    tauri_build::build()
}
