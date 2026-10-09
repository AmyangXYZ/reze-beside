// The shell does nothing but exist, and give you a way out.
//
// Every decision — what it renders, where it sits, when the
// window is dragged — is made on the page, because that is where the scene and
// the engine already are. Rust opens a window the operating system will leave
// unpainted, and puts one icon in the menu bar.
//
// The menu bar matters more here than it would for an ordinary app. A window
// with no title bar has no close button, no minimise, and nothing to right
// click; hidden, it cannot be brought back by clicking a Dock icon, because a
// this has no business keeping one. Without the tray the only way to stop it is
// to go and find the process.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindowBuilder,
};

/// How many characters stand on the desktop. One process, one window each:
/// independent to drag and to place, but sharing a tray, a runtime and a single
/// place to quit from. Separate PROCESSES would give the same independence and
/// N of everything else.
fn beside_count() -> usize {
    std::env::var("BESIDE_COUNT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5)
        .clamp(1, 12)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Tray only, no Dock icon: the character IS the window, and a second
            // place to click that does the same thing is clutter. This also
            // stops her from taking focus off whatever you are actually doing.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Small, and one per character. A window only has to be as big as
            // what stands in it — five of these cover less of the screen than
            // one full-screen transparent sheet would, and every pixel they do
            // not cover is a pixel that still takes clicks normally.
            let n = beside_count();
            for i in 0..n {
                WebviewWindowBuilder::new(app, format!("beside-{i}"), WebviewUrl::App("index.html".into()))
                    // Tell the page its slot outright. It used to ask the shell
                    // which windows existed and find itself in the list, which
                    // is both a race — windows are still being built while the
                    // first page runs — and a puzzle the label had to be parsed
                    // to solve. Rust knows both numbers here; saying them is
                    // free and cannot disagree with itself.
                    .initialization_script(&format!("window.__BESIDE__={{i:{i},n:{n}}};"))
                    .title("Reze Beside")
                    .inner_size(300.0, 460.0)
                    .transparent(true)
                    .decorations(false)
                    .always_on_top(true)
                    .shadow(false)
                    .skip_taskbar(true)
                    // Hidden until the page has put it where it belongs, so it
                    // never appears at the OS's guess and then jumps.
                    .visible(false)
                    .build()?;
            }

            let show = MenuItem::with_id(app, "show", "Show all", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide all", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show, &hide, &PredefinedMenuItem::separator(app)?, &quit],
            )?;

            // Its own icon, not the app's. The bundle icon is 512px of full
            // colour, which the menu bar scales into a smudge; this one is a
            // 44px alpha-only sparkle. `icon_as_template` hands the painting to
            // macOS, so it inverts with a dark menu bar and dims when the app is
            // inactive — a coloured icon does neither and looks foreign.
            let tray_icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;

            TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                // The icon opens the menu rather than toggling on left click:
                // "Quit" has to be reachable in one gesture, and a toggle would
                // make the only way out a right click nobody thinks to try.
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    // All of them together: they are one cast, and hiding half
                    // of it leaves you hunting the rest window by window with no
                    // title bar to close them by.
                    "show" => {
                        for (_, win) in app.webview_windows() {
                            let _ = win.show();
                        }
                    }
                    "hide" => {
                        for (_, win) in app.webview_windows() {
                            let _ = win.hide();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("reze-beside failed to start");
}
