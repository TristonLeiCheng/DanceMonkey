function installDesktopIntegration({ app, Menu, Tray, nativeImage, platform, icon, trayIcon, showApplication, requestQuit,
  getPetEnabled = () => false, togglePet = () => {} }) {
  const actions = () => [
    { label: "显示主界面", click: showApplication },
    { label: "桌面宠物", type: "checkbox", checked: getPetEnabled(), click: togglePet },
    { type: "separator" },
    { label: "退出软件", click: requestQuit },
  ];
  function applicationMenu() { Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "DM", submenu: actions().map((item) => item.label === "退出软件" ? { ...item, accelerator: "CommandOrControl+Q" } : item) },
    { role: "editMenu" },
    { role: "windowMenu" },
  ])); }
  applicationMenu();
  if (platform === "darwin") {
    app.setActivationPolicy("regular");
    void app.dock.show();
    app.dock.setIcon(nativeImage.createFromPath(icon));
    app.dock.setMenu(Menu.buildFromTemplate([{ label: "显示主界面", click: showApplication }]));
  }

  const image = nativeImage.createFromPath(trayIcon);
  if (image.isEmpty()) throw new Error("无法加载 DM 托盘图标。");
  if (platform === "darwin") image.setTemplateImage(true);
  // A stable GUID lets Windows retain the user's notification-area placement preference.
  const tray = platform === "win32"
    ? new Tray(image, "968f82d9-baf8-4ca7-adf1-6c84396ed829")
    : new Tray(image);
  tray.setToolTip("DM · DanceMonkey");
  function refreshMenu() { applicationMenu(); tray.setContextMenu(Menu.buildFromTemplate(actions())); }
  refreshMenu();
  // macOS opens the status-item menu on click; Windows also supports direct activation.
  if (platform === "win32") tray.on("click", showApplication);
  app.on("activate", showApplication);
  return {
    tray,
    refreshMenu,
    dispose() {
      app.removeListener("activate", showApplication);
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
module.exports = { installDesktopIntegration };
