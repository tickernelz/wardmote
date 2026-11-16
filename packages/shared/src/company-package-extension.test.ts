import { describe, expect, it } from "vitest";
import {
  findCompanyPackageExtensionPath,
} from "./company-package-extension.js";

describe("company package extension file", () => {
  it("finds a root extension before a nested one", () => {
    expect(findCompanyPackageExtensionPath(["a/.wardmote.yaml", ".wardmote.yml"])).toBe(".wardmote.yml");
  });
});
