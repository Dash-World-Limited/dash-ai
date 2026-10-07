import { STARTER_PROMPTS } from "@dash-ai/contracts";
import { describe, expect, it } from "vitest";
import { PromptsModel } from "./prompts";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

describe("PromptsModel", () => {
  it("saves, edits, stars and deletes prompts with the shared validation rules", () => {
    const storage = new MemoryStorage();
    const model = new PromptsModel(storage, () => "user-1");
    expect(model.all()).toHaveLength(STARTER_PROMPTS.length);
    expect(model.save({ title: " ", body: "x", category: "business" })).toBe("Give the prompt a title.");
    expect(model.save({ title: "Pitch", body: "  Pitch [product] to [investor]  ", category: "business" }, 5)).toBeNull();
    const mine = model.state.value.custom[0]!;
    expect(mine).toMatchObject({ title: "Pitch", body: "Pitch [product] to [investor]", isCustom: true, updatedAt: 5 });
    model.save({ id: mine.id, title: "Investor pitch", body: mine.body, category: "planning" });
    expect(model.state.value.custom).toEqual([expect.objectContaining({ id: mine.id, title: "Investor pitch", category: "planning" })]);
    model.toggleFavorite(mine.id);
    model.toggleFavorite("starter-biz-swot");
    expect(model.state.value.favorites).toEqual([mine.id, "starter-biz-swot"]);
    model.remove(mine.id);
    expect(model.state.value).toEqual({ custom: [], favorites: ["starter-biz-swot"] });
    // Kept across visits.
    expect(new PromptsModel(storage, () => "user-1").state.value.favorites).toEqual(["starter-biz-swot"]);
  });

  it("another account never sees them, sign-out removes them, and damaged data is ignored", () => {
    const storage = new MemoryStorage();
    let owner = "user-1";
    const model = new PromptsModel(storage, () => owner);
    model.save({ title: "Private", body: "Only mine", category: "writing" });
    owner = "user-2";
    model.reload();
    expect(model.state.value.custom).toEqual([]);
    owner = "user-1";
    model.reload();
    expect(model.state.value.custom).toHaveLength(1);
    model.clear();
    expect(new PromptsModel(storage, () => "user-1").state.value.custom).toEqual([]);

    storage.setItem("dash.prompts.v1", "{not json");
    expect(new PromptsModel(storage, () => "user-1").state.value).toEqual({ custom: [], favorites: [] });
    storage.setItem("dash.prompts.v1", JSON.stringify({ owner: "user-1", custom: [{ id: "x", title: "", body: "b", category: "writing" }, { id: "y", title: "Ok", body: "Fine", category: "writing" }], favorites: [3, "y"] }));
    const loaded = new PromptsModel(storage, () => "user-1").state.value;
    expect(loaded.custom.map((p) => p.id)).toEqual(["y"]);
    expect(loaded.favorites).toEqual(["y"]);
  });
});
