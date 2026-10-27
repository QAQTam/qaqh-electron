import { render } from "@solidjs/web";
import App from "./app/App";
import { markPlatform } from "./lib/platform";
import "./lib/typography";

markPlatform();

render(() => <App />, document.getElementById("root")!);
