// relay/test/rooms.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createRoom, getRoom, putOffer, putAnswer } from "../src/rooms";

// env.ROOMS is the Miniflare-simulated KV namespace from wrangler.toml.

describe("rooms", () => {
  it("createRoom returns an unguessable id and stores the offer at epoch 0", async () => {
    const id = await createRoom(env.ROOMS, "OFFER_SDP");
    expect(id).toMatch(/^[0-9a-zA-Z]{22,}$/); // ~128-bit base62
    const room = await getRoom(env.ROOMS, id);
    expect(room).toMatchObject({ offerSdp: "OFFER_SDP", offerEpoch: 0, answerSdp: null, answerEpoch: -1 });
  });

  it("getRoom returns null for an unknown id", async () => {
    expect(await getRoom(env.ROOMS, "nope")).toBeNull();
  });

  it("putAnswer records the answer with its epoch", async () => {
    const id = await createRoom(env.ROOMS, "O0");
    await putAnswer(env.ROOMS, id, "ANS", 0);
    const room = await getRoom(env.ROOMS, id);
    expect(room).toMatchObject({ answerSdp: "ANS", answerEpoch: 0 });
  });

  it("putOffer bumps the offer epoch for reconnect rounds", async () => {
    const id = await createRoom(env.ROOMS, "O0");
    await putOffer(env.ROOMS, id, "O1", 1);
    const room = await getRoom(env.ROOMS, id);
    expect(room).toMatchObject({ offerSdp: "O1", offerEpoch: 1 });
  });

  it("putAnswer on a missing room is a no-op returning false", async () => {
    expect(await putAnswer(env.ROOMS, "ghost", "ANS", 0)).toBe(false);
  });
});
