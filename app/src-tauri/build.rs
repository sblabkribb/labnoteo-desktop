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
    tauri_build::build()
}
