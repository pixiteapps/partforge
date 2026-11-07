// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { attachMobileTabs } from "../src/framework/mobile-tabs.js";

describe("attachMobileTabs", () => {
  let shell, stage, rail, toggle;
  beforeEach(() => {
    document.body.replaceChildren();
    shell = document.createElement("div");
    stage = document.createElement("div");
    rail = document.createElement("div");
    toggle = document.createElement("button");
    stage.append(toggle);
    shell.append(stage, rail);
    document.body.append(shell);
  });

  it("showPane sets the standalone pane and yields to a host lease", () => {
    const tabs = attachMobileTabs({ shell, stage, rail, toggle });
    expect(tabs.showPane("rail")).toBe(true);
    expect(shell.dataset.pfPane).toBe("rail");
    tabs.setHostPane("stage");
    expect(tabs.showPane("rail")).toBe(false);
    expect(shell.dataset.pfPane).toBe("stage");
  });

  it("showPane is a refusing no-op without the elements", () => {
    expect(attachMobileTabs({}).showPane("rail")).toBe(false);
  });
});
