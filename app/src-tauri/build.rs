fn main() {
    // The IPC round-trip test builds a mock Tauri app inside the lib test
    // binary, which needs the Common Controls v6 manifest the real app gets
    // from tauri-build; without it the test exe fails to start with
    // STATUS_ENTRYPOINT_NOT_FOUND.
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    println!("cargo:rerun-if-changed=test-manifest.xml");
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{dir}/test-manifest.xml");
    tauri_build::build()
}
