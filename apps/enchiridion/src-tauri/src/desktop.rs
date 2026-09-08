use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

pub fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn command(app: &tauri::AppHandle, id: &str) {
    match id {
        "quit" => crate::request_quit(app),
        "open" => show(app),
        "settings" => {
            show(app);
            let _ = app.emit_to("main", "app-command", id);
        }
        _ => {
            let _ = app.emit_to("main", "app-command", id);
        }
    }
}

pub fn install(app: &tauri::App, visible: bool) -> tauri::Result<()> {
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit Enchiridion")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Enchiridion")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let undo = MenuItemBuilder::with_id("undo", "Undo")
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;
    let redo = MenuItemBuilder::with_id("redo", "Redo")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .items(&[&undo, &redo])
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let mut note = SubmenuBuilder::new(app, "Note");
    for (id, title, accelerator) in [
        ("show-commands", "Show Commands…", "CmdOrCtrl+K"),
        ("today", "Go to Today", "CmdOrCtrl+Shift+T"),
        ("previous-day", "Previous Day", "CmdOrCtrl+Alt+Left"),
        ("next-day", "Next Day", "CmdOrCtrl+Alt+Right"),
    ] {
        note = note.item(
            &MenuItemBuilder::with_id(id, title)
                .accelerator(accelerator)
                .build(app)?,
        );
    }
    let mut format = SubmenuBuilder::new(app, "Format");
    for (id, title, accelerator) in [
        ("bold", "Bold", "CmdOrCtrl+B"),
        ("italic", "Italic", "CmdOrCtrl+I"),
        ("underline", "Underline", "CmdOrCtrl+U"),
        ("strikethrough", "Strikethrough", "CmdOrCtrl+Shift+X"),
    ] {
        format = format.item(
            &MenuItemBuilder::with_id(id, title)
                .accelerator(accelerator)
                .build(app)?,
        );
    }
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &note.build()?, &format.build()?])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| command(app, event.id.as_ref()));
    let tray_menu = MenuBuilder::new(app)
        .text("open", "Open Enchiridion")
        .text("settings", "Settings…")
        .separator()
        .text("quit", "Quit Enchiridion")
        .build()?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    let tray = TrayIconBuilder::with_id("notebook")
        .icon(icon)
        .tooltip("Enchiridion")
        .menu(&tray_menu)
        .build(app)?;
    tray.set_visible(visible)?;
    Ok(())
}
