const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const nomica = (process.env.CVQ ?? "").includes("nomica");
  const win = new BrowserWindow({
    width: 1100, height: 760,
    backgroundColor: nomica ? "#f3f3f3" : "#00000000",
    ...(nomica ? {} : { backgroundMaterial: "mica" }),
  });
  win.loadURL("http://localhost:5199/cv-check.html" + (process.env.CVQ ?? ""));
});
