fn main() {
    // Bridge [env] section vars from .cargo/config.toml to option_env!() in main.rs.
    // Cargo's [env] sets vars for build scripts, but option_env!() needs
    // cargo:rustc-env to reliably receive them during compilation.
    for key in ["LOCAL_API_REMOTE_BASE", "LOCAL_API_CLOUD_ONLY", "CONVEX_URL"] {
        if let Ok(val) = std::env::var(key) {
            println!("cargo:rustc-env={key}={val}");
        }
        println!("cargo:rerun-if-env-changed={key}");
    }

    tauri_build::build()
}
