// 入口：render 来自 @solidjs/web（spec §2）。
import { render } from "@solidjs/web";
import App from "./App";
import "../styles/app.css";
import "../styles/components.css";

// 浏览器/验收形态：无 Electron bridge → 装 mock 世界
if (!window.qaqh) {
  void import("../dev/mocks/mockWorld").then(({ initMockWorld }) => {
    initMockWorld();
    render(() => <App />, document.getElementById("root")!);
  });
} else {
  render(() => <App />, document.getElementById("root")!);
}
