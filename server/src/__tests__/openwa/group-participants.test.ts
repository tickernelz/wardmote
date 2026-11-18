import { describe, expect, it, vi } from "vitest";
import { openwaForgetGroupParticipants, openwaGroupParticipants } from "../../services/openwa/group-participants.js";

const GROUP = "120363000000000555@g.us";

function gatewayWith(participants: Array<{ id: string }>) {
  return { getGroup: vi.fn(async (id: string) => ({ id, name: "Dev", participants })) };
}

describe("openwaGroupParticipants", () => {
  it("reuses one read per endpoint and group until the TTL ends or the group changes", async () => {
    const gateway = gatewayWith([{ id: "628555000444@c.us" }]);
    const first = await openwaGroupParticipants("endpoint-a", gateway, GROUP, 1_000);
    expect(first?.keys.has("628555000444@c.us")).toBe(true);
    await openwaGroupParticipants("endpoint-a", gateway, GROUP, 30_999);
    expect(gateway.getGroup).toHaveBeenCalledTimes(1);
    await openwaGroupParticipants("endpoint-b", gateway, GROUP, 30_999);
    expect(gateway.getGroup).toHaveBeenCalledTimes(2);
    await openwaGroupParticipants("endpoint-a", gateway, GROUP, 31_000);
    expect(gateway.getGroup).toHaveBeenCalledTimes(3);
    openwaForgetGroupParticipants("endpoint-a", GROUP);
    await openwaGroupParticipants("endpoint-a", gateway, GROUP, 31_001);
    expect(gateway.getGroup).toHaveBeenCalledTimes(4);
  });

  it("resolves null instead of throwing when the gateway read fails", async () => {
    const gateway = { getGroup: vi.fn(async () => Promise.reject(new Error("gateway down"))) };
    await expect(openwaGroupParticipants("endpoint-c", gateway, GROUP, 1_000)).resolves.toBeNull();
  });
});
