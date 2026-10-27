/** 本地 dev-only 视觉验收:AssistantContent 分帧/holdback/编译渲染,不连接 daemon。 */
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { AssistantContent } from "./genui/AssistantContent";
import { applyTheme } from "./lib/theme";
import "./styles/app.css";

const params = new URLSearchParams(location.search);
applyTheme(params.get("theme") === "dark" ? "dark" : "light");

const FENCE = "```qaqh-ui v=0.1 format=tsx";
/** 完整计数器配方(spec §7.2):本地状态 + 按钮 + 指标,可交互。 */
const COUNTER = [
  'ui.surface("counter", { root: "card", fallback: "计数器，初始值为 0，可增加或重置。" });',
  'const count = ui.state("count", "integer", 0);',
  'ui.node("card", <Card title="计数器" children={["value", "increment", "reset"]} />);',
  'ui.node("value", <Metric label="当前计数" value={count} />);',
  'ui.node("increment", <Button label="增加" onPress={ui.set("count", count + 1)} />);',
  'ui.node("reset", <Button label="重置" onPress={ui.reset()} />);',
  "ui.end();",
].join("\n");
/** 未知组件类型:编译失败,应回退占位卡并显示具名错误。 */
const BROKEN = [
  'ui.surface("broken", { fallback: "无法编译的源码" });',
  'ui.node("card", <Card children={["a"]} />);',
  'ui.node("a", <Widget text="hi" />);',
  "ui.end();",
].join("\n");
/** jsonl 载体 + 表单组件 + show 条件渲染(spec §7 jsonl 载体)。 */
const FORM_JSONL = [
  '{"op":"surface.open","surface":"form","root":"card","fallback":"表单演示"}',
  '{"op":"state","key":"name","type":"string","initial":""}',
  '{"op":"state","key":"dark","type":"boolean","initial":false}',
  '{"op":"state","key":"tags","type":"list","initial":["alpha"]}',
  '{"op":"node","id":"card","component":"Card","props":{"title":"表单","children":["name","on","off","badge","tags","add","del","rows"]}}',
  '{"op":"node","id":"name","component":"TextInput","props":{"label":"名称","value":{"bind":"name"},"placeholder":"输入名称","required":true,"maxLength":10}}',
  '{"op":"node","id":"on","component":"Button","props":{"label":"开启","onPress":{"set":"dark","value":{"lit":true}}}}',
  '{"op":"node","id":"off","component":"Button","props":{"label":"关闭","onPress":{"set":"dark","value":{"lit":false}}}}',
  '{"op":"node","id":"badge","component":"Badge","props":{"text":"深色已开启","show":{"state":"dark"}}}',
  '{"op":"node","id":"tags","component":"TagList","props":{"items":{"bind":"tags"}}}',
  '{"op":"node","id":"add","component":"Button","props":{"label":"加标签","onPress":{"append":"tags","value":{"lit":"beta"}}}}',
  '{"op":"node","id":"del","component":"Button","props":{"label":"移除标签","onPress":{"remove":"tags","value":{"lit":"beta"}}}}',
  '{"op":"node","id":"rows","component":"Text","props":{"text":{"op":"add","left":{"lit":"· "},"right":{"item":"item"}},"repeat":{"source":"tags","as":"item"}}}',
  '{"op":"surface.close"}',
].join("\n");
/** todo v2 + ask v2:可点击 checklist 与 followUp 提交(纯 chat 语义,无 toolcall)。 */
const ASK_TODO = [
  'ui.surface("plan", { root: "card", title: "计划与确认" });',
  'const t_frame = ui.state("t_frame", "boolean", false);',
  'const t_genui = ui.state("t_genui", "boolean", false);',
  'const confirm_note = ui.state("confirm_note", "string", "");',
  'ui.node("card", <TodoList title="执行计划" children={["t1", "t2", "summary", "ask", "send"]} />);',
  'ui.node("t1", <Todo text="分帧器" done={ui.bind("t_frame")} meta="阶段 1" />);',
  'ui.node("t2", <Todo text="生成式界面" done={ui.bind("t_genui")} />);',
  'ui.node("summary", <Text text={"进度：" + t_frame} />);',
  'ui.node("ask", <TextInput label="补充说明" value={confirm_note} required={true} />);',
  'ui.node("send", <Button label="提交确认" disabled={confirm_note == ""} onPress={ui.followUp("请按计划继续", { "说明": confirm_note })} />);',
  "ui.end();",
].join("\n");
const JSONL_FENCE = "```qaqh-ui v=0.1 format=jsonl";
/** v0.2(A2UI 消息流管线):同一计数器配方,验证版本分流/translate/registry/SurfaceView2 全链。 */
const V2_FENCE = "```qaqh-ui v=0.2 format=tsx";
const V2_COUNTER = [
  'ui.surface("v2-counter", { root: "card", fallback: "v2 计数器,可增加或重置。" });',
  'const count = ui.state("count", "integer", 0);',
  'const tags = ui.state("tags", "list", ["alpha"]);',
  'ui.node("card", <Card title="v2 计数器" children={["value", "increment", "reset"]} />);',
  'ui.node("value", <Metric label="当前计数" value={count} />);',
  'ui.node("increment", <Button label="增加" onPress={ui.set("count", count + 1)} />);',
  'ui.node("reset", <Button label="重置" onPress={ui.reset()} />);',
  'ui.node("tagcard", <Card title="标签" children={["tags", "add", "del", "rows"]} />);',
  'ui.node("tags", <TagList items={tags} />);',
  'ui.node("add", <Button label="加 beta" onPress={ui.append("tags", "beta")} />);',
  'ui.node("del", <Button label="删 beta" onPress={ui.remove("tags", "beta")} />);',
  'ui.node("rows", <Text text={"· " + item} repeat={ui.for("tags", "item")} />);',
  "ui.end();",
].join("\n");
/** 软告警:声明了 repeat 行却忘了挂进根容器 → 编译通过、界面少一块,只提示不报错。 */
const ORPHAN = [
  'ui.surface("orphan", { root: "card" });',
  'const tags = ui.state("tags", "list", ["alpha"]);',
  'ui.node("card", <Card title="标签" children={["tlist"]} />);',
  'ui.node("tlist", <TagList items={tags} />);',
  'ui.node("trow", <Row children={["trem"]} repeat={ui.for("tags", "item")} />);',
  'ui.node("trem", <Button label={"× " + item} onPress={ui.remove("tags", item)} />);',
  "ui.end();",
].join("\n");

/** 流式表格:jsonl 逐行到达,部分编译让行在围栏闭合前就开始渲染。 */
const TABLE = [
  '{"op":"surface.open","surface":"table","root":"card","title":"会议名单"}',
  '{"op":"state","key":"rows","type":"list","initial":["张三","李四"]}',
  '{"op":"node","id":"card","component":"Card","props":{"title":"名单","children":["r1","r2","r3"]}}',
  '{"op":"node","id":"r1","component":"Text","props":{"text":"张三"}}',
  '{"op":"node","id":"r2","component":"Text","props":{"text":"李四"}}',
].join("\n");
const TABLE_DONE = `${TABLE}\n{"op":"node","id":"r3","component":"Text","props":{"text":"王五"}}\n{"op":"surface.close"}`;

/** 流式分阶段:md → holdback → 开门(生成中) → 部分编译(行先渲染) → seal(转正) → 尾部 md。 */
const stages = [
  "说明文字",
  "说明文字\n```qaqh-u",
  "说明文字\n```qaqh-ui v=0.1 format=jsonl\n",
  `说明文字\n\`\`\`qaqh-ui v=0.1 format=jsonl\n${TABLE}\n`,
  `说明文字\n\`\`\`qaqh-ui v=0.1 format=jsonl\n${TABLE_DONE}\n\`\`\`\n结尾`,
];
const [stage, setStage] = createSignal(0);
const [queued, setQueued] = createSignal("队列：空");

declare global { interface Window { __genuiCheck: { step: () => void; reset: () => void } } }
window.__genuiCheck = {
  step: () => setStage((current) => Math.min(current + 1, stages.length - 1)),
  reset: () => setStage(0),
};

render(() => (
  <main style={{ "max-width": "760px", margin: "36px auto", padding: "0 20px", display: "grid", gap: "24px" }}>
    <h2 style={{ "font-size": "16px", "font-weight": "500", margin: "0" }}>genui 分帧验收</h2>
    <section id="genui-stream" data-stage={stage()}>
      <AssistantContent text={() => stages[stage()]!} revision="fixture" streaming={stage() < stages.length - 1} />
    </section>
    <section id="genui-final">
      <AssistantContent
        text={() => `历史回答\n${FENCE}\n${COUNTER}\n\`\`\`\n后续说明`}
        revision="final"
        streaming={false}
      />
    </section>
    <section id="genui-error">
      <AssistantContent text={() => `坏例子\n${FENCE}\n${BROKEN}\n\`\`\``} revision="broken" streaming={false} />
    </section>
    <section id="genui-form">
      <AssistantContent text={() => `jsonl 表单\n${JSONL_FENCE}\n${FORM_JSONL}\n\`\`\``} revision="form" streaming={false} />
    </section>
    <section id="genui-ask">
      <AssistantContent text={() => `计划\n${FENCE}\n${ASK_TODO}\n\`\`\``} revision="ask" streaming={false} onFollowUp={(queued) => setQueued(`队列:${queued}`)} />
      <div id="genui-queued">{queued()}</div>
    </section>
    <section id="genui-warn">
      <AssistantContent text={() => `孤儿节点\n${FENCE}\n${ORPHAN}\n\`\`\``} revision="orphan" streaming={false} />
    </section>
    <section id="genui-v2">
      <AssistantContent
        text={() => `v0.2(A2UI 消息流)\n${V2_FENCE}\n${V2_COUNTER}\n\`\`\`\n以上按钮应可交互:增加/重置/加删标签。`}
        revision="v2"
        streaming={false}
        onFollowUp={(queued) => setQueued(`v2 队列:${queued}`)}
      />
    </section>
  </main>
), document.getElementById("root")!);
